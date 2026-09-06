import { alias } from 'drizzle-orm/pg-core';
import {
  and,
  asc,
  eq,
  ilike,
  isNull,
  isNotNull,
  count,
  desc,
  gt,
  gte,
  lt,
  or,
  sql,
  inArray,
} from 'drizzle-orm';
import type { DateRange } from '../admin/admin.repo.js';
import crypto from 'crypto';
import { db } from '../../config/db.js';
import { CLAIM_CAMPAIGNS } from '../../config/campaigns.js';
import { istDateString } from '../../lib/astro-tools/transit-events.js';
import { resolveGeoForIp } from '../../lib/geo-lookup.js';
import {
  users,
  birthProfiles,
  devicePushTokens,
  userConsentLog,
  chatSessions,
  userFacts,
  chatFeedbackReports,
  notifications,
  walletTransactions,
  palmReadings,
  aiUsage,
  voiceSessions,
  orders,
  reports,
  userActivityDaily,
  type NewUserRow,
  type NewUserConsentLogRow,
  type UserRow,
  type PlaceOfBirth,
} from '../../db/schema.js';
import {
  encryptField,
  decryptField,
  encryptJson,
  decryptJson,
  hashForLookup,
} from '../../lib/crypto/field-encryption.js';
import { deleteAllUserFrames } from '../../lib/palm/storage.js';
import { logger } from '../../lib/logger.js';

/**
 * The `users` table encrypts phoneE164/dateOfBirth/timeOfBirth/placeOfBirth/
 * gotra/sankalpaName at rest (see src/lib/crypto/field-encryption.ts and the
 * comments on the `users` table in db/schema.ts). This repo module is the
 * ONLY place that should touch those raw columns — every function here
 * decrypts on the way out and encrypts on the way in, so every caller
 * elsewhere in the app keeps reading/writing plain values exactly as before.
 * `horoscope.repo.ts` and `scripts/regen-all.ts` also read the `users` table
 * directly (for the horoscope-generation cron/backfill) and reuse
 * `decryptUserRow` below for the same reason.
 */
export function decryptUserRow(row: UserRow): UserRow {
  return {
    ...row,
    phoneE164: decryptField(row.phoneE164),
    dateOfBirth: decryptField(row.dateOfBirth),
    timeOfBirth: decryptField(row.timeOfBirth),
    // placeOfBirth is `.$type<PlaceOfBirth>()`'d for the app-facing (decrypted)
    // shape, but the raw row straight off the wire is really an encrypted
    // string — the cast bridges that intentional type/runtime mismatch.
    placeOfBirth: decryptJson<PlaceOfBirth>(row.placeOfBirth as unknown as string | null),
    gotra: decryptField(row.gotra),
    sankalpaName: decryptField(row.sankalpaName),
  };
}

/**
 * Encrypts whichever of the encrypted columns are present in a patch, and —
 * if `phoneE164` is being set — (re)computes `phoneE164Hash` from the
 * plaintext BEFORE encrypting it, since the hash is the only thing lookups
 * can match against once the column itself holds non-deterministic
 * ciphertext.
 */
function encryptUserPatch<T extends Partial<NewUserRow>>(patch: T): T {
  const next: Partial<NewUserRow> = { ...patch };
  if ('phoneE164' in next) {
    const plain = next.phoneE164 ?? null;
    next.phoneE164Hash = plain ? hashForLookup(plain) : null;
    next.phoneE164 = encryptField(plain);
  }
  if ('dateOfBirth' in next) next.dateOfBirth = encryptField(next.dateOfBirth ?? null);
  if ('timeOfBirth' in next) next.timeOfBirth = encryptField(next.timeOfBirth ?? null);
  if ('placeOfBirth' in next) {
    next.placeOfBirth = encryptJson(next.placeOfBirth ?? null) as unknown as PlaceOfBirth | null;
  }
  if ('gotra' in next) next.gotra = encryptField(next.gotra ?? null);
  if ('sankalpaName' in next) next.sankalpaName = encryptField(next.sankalpaName ?? null);
  return next as T;
}

export async function findUserByFirebaseUid(firebaseUid: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.firebaseUid, firebaseUid)).limit(1);
  return rows[0] ? decryptUserRow(rows[0]) : undefined;
}

/** Any row (including soft-deleted) holding this phone number. */
export async function findUserByPhoneE164(phoneE164: string): Promise<UserRow | undefined> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.phoneE164Hash, hashForLookup(phoneE164)))
    .limit(1);
  return rows[0] ? decryptUserRow(rows[0]) : undefined;
}

export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0] ? decryptUserRow(rows[0]) : undefined;
}

export async function findUserByReferralCode(code: string): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.referralCode, code)).limit(1);
  return rows[0] ? decryptUserRow(rows[0]) : undefined;
}

export async function findActiveUserByFirebaseUid(
  firebaseUid: string,
): Promise<UserRow | undefined> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.firebaseUid, firebaseUid), isNull(users.deletedAt)))
    .limit(1);
  return rows[0] ? decryptUserRow(rows[0]) : undefined;
}

export async function findActiveUserById(id: string): Promise<UserRow | undefined> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1);
  return rows[0] ? decryptUserRow(rows[0]) : undefined;
}

/**
 * Records a self-reported income range (see lib/chat-income.ts for the bracket
 * table). Written from exactly one place — a tapped range option in chat — so a
 * value here always came from the user choosing it, never from inference.
 */
export async function setIncomeBracket(
  userId: string,
  field: 'incomeBracket' | 'familyIncomeBracket',
  bracket: string,
): Promise<void> {
  await db
    .update(users)
    .set(
      field === 'incomeBracket'
        ? { incomeBracket: bracket, updatedAt: sql`now()` }
        : { familyIncomeBracket: bracket, updatedAt: sql`now()` },
    )
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
}

/**
 * File a deletion request, or return the existing one untouched. Idempotent by
 * design: tapping Delete Account a second time must not push the review clock
 * forward, so the `is null` guard is in the WHERE rather than a read-then-write
 * (which would race two taps into two different timestamps).
 *
 * Returns the timestamp now in force, or undefined if there is no such active
 * user. Cleared by `clearDeletionRequest` (reject) or by `anonymizeUserById`
 * (approve — the request is fulfilled at that point).
 */
export async function requestUserDeletion(id: string): Promise<Date | undefined> {
  const [claimed] = await db
    .update(users)
    .set({ deletionRequestedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(users.id, id), isNull(users.deletedAt), isNull(users.deletionRequestedAt)))
    .returning({ deletionRequestedAt: users.deletionRequestedAt });
  if (claimed?.deletionRequestedAt) return claimed.deletionRequestedAt;

  const [existing] = await db
    .select({ deletionRequestedAt: users.deletionRequestedAt })
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1);
  return existing?.deletionRequestedAt ?? undefined;
}

/** Withdraw a pending request. Push and horoscope generation resume by themselves. */
export async function clearDeletionRequest(id: string): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ deletionRequestedAt: null, updatedAt: sql`now()` })
    .where(and(eq(users.id, id), isNotNull(users.deletionRequestedAt)))
    .returning({ id: users.id });
  return rows.length > 0;
}

/**
 * Requests still awaiting an admin decision past `cutoff`. Drives the daily
 * reminder cron — it re-fires for the same request every day until acted on,
 * because nothing here erases anything on a timer.
 */
export async function listPendingDeletionRequestsBefore(cutoff: Date): Promise<UserRow[]> {
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        isNotNull(users.deletionRequestedAt),
        lt(users.deletionRequestedAt, cutoff),
        isNull(users.anonymizedAt),
      ),
    )
    .orderBy(users.deletionRequestedAt);
  return rows.map(decryptUserRow);
}

export async function insertUser(values: NewUserRow): Promise<UserRow> {
  if (!values.referralCode) {
    values.referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  }
  const [row] = await db.insert(users).values(encryptUserPatch(values)).returning();
  if (!row) throw new Error('Failed to insert user');
  return decryptUserRow(row);
}

/**
 * Backfill a referralCode for a user row created before the referral feature
 * shipped. Called from both session-establishment and GET /me so every path
 * that can hand a user object to the frontend guarantees one is present.
 */
export async function ensureReferralCode(user: UserRow): Promise<UserRow> {
  if (user.referralCode) return user;
  const referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  const updated = await updateUserById(user.id, { referralCode });
  return updated ?? { ...user, referralCode };
}

export async function updateUserById(
  id: string,
  patch: Partial<NewUserRow>,
): Promise<UserRow | undefined> {
  const [row] = await db
    .update(users)
    .set({ ...encryptUserPatch(patch), updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning();
  return row ? decryptUserRow(row) : undefined;
}

/** The transaction handle drizzle hands a `db.transaction` callback. */
type WalletTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Spends `amountPaise` out of the user's EXPIRING credit lots, soonest expiry
 * first, by decrementing each lot's `wallet_transactions.remaining_paise`.
 *
 * Call this from every debit site, right after the balance UPDATE and inside
 * the same transaction. It does not move `users.walletBalancePaise` — that
 * debit has already happened and stays the authoritative total. All this does
 * is record WHICH credits the spend consumed, so the expiry sweep claws back
 * only the untouched remainder of a grant instead of its full face value out
 * of whatever balance happens to be sitting there (see the `remainingPaise`
 * note on the schema).
 *
 * Spending more than the lots hold is normal and fine: the surplus came from
 * non-expiring balance (a top-up, a refund, the signup grant), which has no
 * lot to drain. Nothing here can push a balance negative — it never touches
 * the balance.
 *
 * No extra locking: the caller's balance UPDATE already took the users-row
 * lock, so two concurrent spends by the same user serialise there and this
 * read-then-write can't lose an update. Don't call it before that UPDATE.
 *
 * Deliberately drains lots whose `expiresAt` is already past but which the
 * daily sweep hasn't collected yet. Those paise are still in the balance and
 * still spendable, so letting the spend claim them is both the friendlier
 * reading of a cron lag and the safe one — skipping them would leave the
 * sweep clawing back money the user already spent.
 */
export async function consumeExpiringCredits(
  tx: WalletTx,
  userId: string,
  amountPaise: number,
): Promise<void> {
  let unallocated = amountPaise;
  if (unallocated <= 0) return;

  const lots = await tx
    .select({ id: walletTransactions.id, remainingPaise: walletTransactions.remainingPaise })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.userId, userId),
        isNull(walletTransactions.expiredAt),
        gt(walletTransactions.remainingPaise, 0),
      ),
    )
    .orderBy(asc(walletTransactions.expiresAt), asc(walletTransactions.createdAt));

  for (const lot of lots) {
    if (unallocated <= 0) break;
    const take = Math.min(unallocated, lot.remainingPaise ?? 0);
    if (take <= 0) continue;
    await tx
      .update(walletTransactions)
      .set({ remainingPaise: sql`${walletTransactions.remainingPaise} - ${take}` })
      .where(eq(walletTransactions.id, lot.id));
    unallocated -= take;
  }
}

/**
 * Atomically deduct `amountPaise` from the wallet if (and only if) the user
 * has enough. Same claim-style primitive as `unlockHouseForUser` — the
 * balance check and the debit happen in one conditional UPDATE so two
 * concurrent spends can never both succeed against a balance that only
 * covers one of them.
 */
export async function deductWalletBalance(
  userId: string,
  amountPaise: number,
  reason: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [charged] = await tx
      .update(users)
      .set({ walletBalancePaise: sql`${users.walletBalancePaise} - ${amountPaise}` })
      .where(and(eq(users.id, userId), gte(users.walletBalancePaise, amountPaise)))
      .returning({ walletBalancePaise: users.walletBalancePaise });
    if (!charged) return false;

    await tx.insert(walletTransactions).values({
      userId,
      delta: -amountPaise,
      reason,
      balanceAfter: charged.walletBalancePaise,
    });
    await consumeExpiringCredits(tx, userId, amountPaise);
    return true;
  });
}

/** Add `amountPaise` back to the wallet (e.g. refunding a charge whose async job failed). */
export async function addWalletBalance(
  userId: string,
  amountPaise: number,
  reason: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({ walletBalancePaise: sql`${users.walletBalancePaise} + ${amountPaise}` })
      .where(eq(users.id, userId))
      .returning({ walletBalancePaise: users.walletBalancePaise });
    if (!updated) return;

    await tx.insert(walletTransactions).values({
      userId,
      delta: amountPaise,
      reason,
      balanceAfter: updated.walletBalancePaise,
    });
  });
}

/**
 * Which claim-campaign keys this user has already claimed — surfaced on the
 * user DTO as `claimedCampaigns` (like `feedbackGiven`) so a claim modal never
 * offers a claim the server would refuse, and so `resolveActiveClaimableCampaign`
 * can tell a claimed DB campaign apart from an unclaimed one.
 *
 * Matches both the given static `campaignKeys` (see config/campaigns.ts) AND
 * any admin-created `gift_campaigns.key` — omitting the latter used to mean
 * `resolveActiveClaimableCampaign`'s `!claimedCampaigns.includes(dbLive.key)`
 * check was always true for a DB-backed campaign (a gift_campaigns key never
 * appears in the static array passed in), so the claim modal for an
 * admin-created gift never learned it had already been claimed and kept
 * resurfacing on every launch. No financial risk (claimCampaignBonus's own
 * ledger check is what actually blocks a double credit) but a confusing loop
 * for anyone who'd already claimed.
 */
export async function getClaimedCampaignKeys(
  userId: string,
  campaignKeys: readonly string[],
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ reason: walletTransactions.reason })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.userId, userId),
        or(
          campaignKeys.length > 0
            ? inArray(walletTransactions.reason, [...campaignKeys])
            : sql`false`,
          sql`exists (select 1 from gift_campaigns gc where gc.key = wallet_transactions.reason)`,
        ),
      ),
    );
  return rows.map((r) => r.reason);
}

/**
 * Credit a one-time claim-campaign bonus, the first time only. Copies
 * `recordFeedback`'s pattern exactly (feedback.repo.ts): lock the user row,
 * then probe the ledger for a prior grant with this exact reason, all in one
 * transaction — so two concurrent claim taps cannot both see "not yet
 * claimed" and double-credit. `campaignKey` becomes the ledger `reason`
 * directly, so it must be one of `CLAIM_CAMPAIGNS[].key`. The date window is
 * enforced by the route, not here.
 */
export async function claimCampaignBonus(
  userId: string,
  campaignKey: string,
  amountPaise: number,
  expiresAt?: Date,
): Promise<{ claimed: boolean; walletBalancePaise: number }> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.execute<{ wallet_balance_paise: number }>(sql`
      SELECT wallet_balance_paise FROM users WHERE id = ${userId} FOR UPDATE;
    `);
    if (!locked) return { claimed: false, walletBalancePaise: 0 };

    const [prior] = await tx
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(and(eq(walletTransactions.userId, userId), eq(walletTransactions.reason, campaignKey)))
      .limit(1);
    if (prior) return { claimed: false, walletBalancePaise: locked.wallet_balance_paise };
    if (amountPaise <= 0)
      return { claimed: false, walletBalancePaise: locked.wallet_balance_paise };

    const [updated] = await tx
      .update(users)
      .set({ walletBalancePaise: sql`${users.walletBalancePaise} + ${amountPaise}` })
      .where(eq(users.id, userId))
      .returning({ walletBalancePaise: users.walletBalancePaise });
    if (!updated) return { claimed: false, walletBalancePaise: locked.wallet_balance_paise };

    await tx.insert(walletTransactions).values({
      userId,
      delta: amountPaise,
      reason: campaignKey,
      balanceAfter: updated.walletBalancePaise,
      expiresAt: expiresAt ?? null,
      // An expiring grant is a lot: track what's left of it so a later spend
      // drains this before the user's own money. Non-expiring grants stay NULL.
      remainingPaise: expiresAt ? amountPaise : null,
    });

    return { claimed: true, walletBalancePaise: updated.walletBalancePaise };
  });
}

/**
 * Rearms the low-balance alert for anyone who has recovered to >= threshold
 * (e.g. a recharge or referral bonus) — no matter which of the several credit
 * call sites put them there, since this reads the authoritative balance
 * column rather than hooking each one. Returns how many were rearmed.
 */
export async function rearmRecoveredLowBalanceUsers(thresholdPaise: number): Promise<number> {
  const rows = await db
    .update(users)
    .set({ lowBalanceAlertedAt: null })
    .where(and(gte(users.walletBalancePaise, thresholdPaise), isNotNull(users.lowBalanceAlertedAt)))
    .returning({ id: users.id });
  return rows.length;
}

/** Users currently below threshold who haven't been alerted since their last recovery. */
export async function findUnalertedLowBalanceUserIds(thresholdPaise: number): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(lt(users.walletBalancePaise, thresholdPaise), isNull(users.lowBalanceAlertedAt)));
  return rows.map((r) => r.id);
}

export async function markLowBalanceAlerted(userId: string): Promise<void> {
  await db.update(users).set({ lowBalanceAlertedAt: new Date() }).where(eq(users.id, userId));
}

/** Fail-open fallbacks only — the real amounts come from the admin-set `referral.*` features. */
export const REFERRER_BONUS_FALLBACK_PAISE = 10000;
export const REFEREE_BONUS_FALLBACK_PAISE = 5000;
export const REFERRAL_CAP_FALLBACK_PAISE = 200000;

/**
 * Atomically apply the referral bonus. The referee (whoever redeemed a code) always
 * gets their one-time welcome bonus for a valid, not-self code — the cap only limits how
 * much the REFERRER can earn from referring others, so a referrer hitting their cap
 * doesn't cost the new signup their welcome bonus.
 *
 * All three amounts are resolved from the admin-set `referral.*` features by the
 * caller (users.service.ts) and passed in — this function must never hold its
 * own, or the in-app copy quoting the bonus and the amount actually paid drift
 * apart. A zero bonus (feature toggled off) is skipped entirely rather than
 * written as a no-op ₹0 ledger row.
 */
export async function applyReferralBonus(
  referrerId: string,
  refereeId: string,
  amounts: { referrerPaise: number; refereePaise: number; capPaise: number },
): Promise<{ referrerBonus: boolean; refereeBonus: boolean }> {
  const { referrerPaise, refereePaise, capPaise } = amounts;

  return db.transaction(async (tx) => {
    // Lock and check referrer cap
    const [referrer] = await tx.execute<{ referral_earnings_paise: number }>(sql`
      SELECT referral_earnings_paise FROM users WHERE id = ${referrerId} FOR UPDATE;
    `);

    const referrerBonus =
      referrerPaise > 0 && !!referrer && referrer.referral_earnings_paise < capPaise;

    if (referrerBonus) {
      await tx.execute(sql`
        UPDATE users
        SET wallet_balance_paise = wallet_balance_paise + ${referrerPaise},
            referral_earnings_paise = referral_earnings_paise + ${referrerPaise}
        WHERE id = ${referrerId};
      `);
      await tx.execute(sql`
        INSERT INTO wallet_transactions (user_id, delta, reason, balance_after)
        VALUES (${referrerId}, ${referrerPaise}, 'referral_bonus', (SELECT wallet_balance_paise FROM users WHERE id = ${referrerId}));
      `);
    }

    // Referee's one-time welcome bonus for redeeming a valid code — unconditional,
    // independent of the referrer's cap.
    const refereeBonus = refereePaise > 0;
    if (refereeBonus) {
      await tx.execute(sql`
        UPDATE users
        SET wallet_balance_paise = wallet_balance_paise + ${refereePaise}
        WHERE id = ${refereeId};
      `);
      await tx.execute(sql`
        INSERT INTO wallet_transactions (user_id, delta, reason, balance_after)
        VALUES (${refereeId}, ${refereePaise}, 'referral_bonus', (SELECT wallet_balance_paise FROM users WHERE id = ${refereeId}));
      `);
    }

    return { referrerBonus, refereeBonus };
  });
}

/** Get user notifications */
export async function getNotificationsForUser(userId: string) {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt));
}

/** Mark all user notifications as read */
export async function markNotificationsRead(userId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}

export interface NewNotificationEntry {
  userId: string;
  title: string;
  body: string;
  type: string;
  link?: string | null;
}

/** Insert one Bell-inbox notification row. Repo-layer wrapper (rather than a lib module
 * touching `db` directly) so callers like notify-user.ts's notifyUser can be exercised in tests
 * by mocking this function, the same way every other notify-* call site already mocks
 * findActiveTokensForUser/sendPushBatch instead of the DB client underneath them. */
export async function insertNotification(entry: NewNotificationEntry): Promise<void> {
  await db.insert(notifications).values({
    userId: entry.userId,
    title: entry.title,
    body: entry.body,
    type: entry.type,
    link: entry.link ?? null,
  });
}

/** Bulk insert, chunked at 500 — same limit sendPushBatch's own FCM chunking already uses.
 * Matches insertTransitNotifications' (transit-alert.repo.ts) existing chunking precedent. */
export async function insertNotifications(entries: NewNotificationEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    await db.insert(notifications).values(
      entries.slice(i, i + CHUNK).map((e) => ({
        userId: e.userId,
        title: e.title,
        body: e.body,
        type: e.type,
        link: e.link ?? null,
      })),
    );
  }
}

/**
 * Atomically claim the user's one lifetime birth-detail edit. Returns the
 * updated row if THIS call won the claim, or `undefined` if it was already
 * used — same claim primitive as `claimKundliGeneration`, so two concurrent
 * edit requests can't both slip through.
 */
export async function claimBirthDetailsEdit(id: string): Promise<UserRow | undefined> {
  const [row] = await db
    .update(users)
    .set({ birthDetailsEditedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(users.id, id), isNull(users.birthDetailsEditedAt)))
    .returning();
  return row ? decryptUserRow(row) : undefined;
}

/**
 * Real erasure for `DELETE /v1/me`: scrubs every CRITICAL/identifying field
 * instead of just soft-deleting. `firebaseUid`/`phoneE164` are deliberately
 * kept (so the row stays a valid, findable shell) rather than nulled — this
 * is what makes the login-time "resurrect a soft-deleted row by phone/UID"
 * path in `auth.service.ts` safe even after a number is recycled or
 * SIM-swapped: whoever signs in next just gets an empty, freshly-onboardable
 * account, because there is nothing sensitive left on the row to hand back.
 * `anonymizedAt` is the permanent, never-cleared record that this happened.
 */
export async function anonymizeUserById(id: string): Promise<void> {
  const now = new Date();

  // Palm photographs are irreducibly biometric — there is no "scrub in place" for them the
  // way there is for a text field, so they get the same hard-delete treatment as chat
  // transcripts below (the "highest-risk content class" precedent), not a soft anonymize.
  // Storage lives outside the DB transaction; best-effort and logged, never blocks erasure.
  await deleteAllUserFrames(id).catch((err: unknown) =>
    logger.error({ err, userId: id }, 'anonymizeUserById: failed to delete palm storage objects'),
  );

  await db.transaction(async (tx) => {
    await tx.delete(palmReadings).where(eq(palmReadings.userId, id));
    await tx
      .update(users)
      .set({
        displayName: null,
        gender: null,
        email: null,
        avatarUrl: null,
        dateOfBirth: null,
        timeOfBirth: null,
        placeOfBirth: null,
        birthTimeAccuracy: null,
        birthTimeSource: null,
        birthTimeRectified: null,
        birthTimeRectificationConfidence: null,
        birthLocationAccuracy: null,
        gotra: null,
        sankalpaName: null,
        currentLocation: null,
        currentLocationUpdatedAt: null,
        currentTimezone: null,
        currentCountry: null,
        interestAreas: null,
        relationshipStatus: null,
        partnerSeekingIntent: null,
        referralSource: null,
        referredByCode: null,
        // The request that led here is now fulfilled — clear it so the daily
        // reminder cron stops nagging about it. `anonymizedAt` is the record
        // that it happened.
        deletionRequestedAt: null,
        anonymizedAt: now,
        deletedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, id));

    // Third-party data the owner entered about someone else — same erasure,
    // not just the soft-delete `softDeleteBirthProfilesByOwner` already does.
    await tx
      .update(birthProfiles)
      .set({
        displayName: null,
        dateOfBirth: null,
        timeOfBirth: null,
        placeOfBirth: null,
        gotra: null,
        notes: null,
        updatedAt: now,
      })
      .where(eq(birthProfiles.ownerUserId, id));

    // Free-text is the highest-risk content class (chat transcripts, LLM
    // memory, saved Q&A) — hard-delete rather than merely scrub, since these
    // tables aren't otherwise touched until the user row itself is dropped.
    await tx.delete(chatSessions).where(eq(chatSessions.userId, id));
    await tx.delete(userFacts).where(eq(userFacts.userId, id));
    await tx.delete(chatFeedbackReports).where(eq(chatFeedbackReports.userId, id));

    // Revoked tokens are useless for push, but the token string is still a
    // device credential — scrub it too rather than leaving it at rest.
    await tx
      .update(devicePushTokens)
      .set({ token: 'revoked', updatedAt: now })
      .where(eq(devicePushTokens.userId, id));

    // Keep the consent-log rows (ON DELETE RESTRICT exists precisely so this
    // audit trail survives) but scrub the PII columns on them — this is the
    // resolution to the RESTRICT-vs-erasure tension: the event/timestamp/
    // version skeleton stays, the IP/user-agent doesn't.
    await tx
      .update(userConsentLog)
      .set({ sourceIp: null, userAgent: null })
      .where(eq(userConsentLog.userId, id));
  });
}

export async function hardDeleteUserById(id: string): Promise<void> {
  // palm_readings rows themselves cascade away with the user row below, but the actual
  // photograph objects in Cloud Storage do not — delete them explicitly or they're orphaned.
  // Best-effort and logged, never blocks the (legally required) DB erasure.
  await deleteAllUserFrames(id).catch((err: unknown) =>
    logger.error({ err, userId: id }, 'hardDeleteUserById: failed to delete palm storage objects'),
  );

  await db.transaction(async (tx) => {
    // Delete consent logs first to bypass ON DELETE RESTRICT
    await tx.delete(userConsentLog).where(eq(userConsentLog.userId, id));
    // Hard delete user - all other tables have ON DELETE CASCADE
    await tx.delete(users).where(eq(users.id, id));
  });
}

/**
 * Apply a profile patch and append its consent-audit rows ATOMICALLY, so the
 * user's effective consent state and the append-only log can never diverge.
 */
export async function updateUserWithConsentLog(
  id: string,
  patch: Partial<NewUserRow>,
  entries: NewUserConsentLogRow[],
): Promise<UserRow | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ ...encryptUserPatch(patch), updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    if (entries.length > 0) {
      await tx.insert(userConsentLog).values(entries);
    }
    return row ? decryptUserRow(row) : undefined;
  });
}

/**
 * Cascade soft-delete to the account holder's saved charts so a third party's
 * birth data stops being processed when the owner deactivates.
 */
export async function softDeleteBirthProfilesByOwner(ownerUserId: string): Promise<void> {
  await db
    .update(birthProfiles)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(birthProfiles.ownerUserId, ownerUserId), isNull(birthProfiles.deletedAt)));
}

/** Revoke every active push token for a user (logout / account soft-delete). */
export async function revokeDeviceTokensByUser(userId: string): Promise<void> {
  await db
    .update(devicePushTokens)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(devicePushTokens.userId, userId), isNull(devicePushTokens.revokedAt)));
}

/** Bumps `lastActiveAt` on any authenticated request — called fire-and-forget from `requireUser`. */
export async function touchUserLastActive(userId: string): Promise<void> {
  await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, userId));
}

export async function countUsers(): Promise<number> {
  const [res] = await db.select({ count: count() }).from(users).where(isNull(users.deletedAt));
  return res?.count ?? 0;
}

export async function countNewUsersToday(): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [res] = await db
    .select({ count: count() })
    .from(users)
    .where(and(isNull(users.deletedAt), gte(users.createdAt, startOfDay)));
  return res?.count ?? 0;
}

export async function countNewUsersThisWeek(): Promise<number> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const [res] = await db
    .select({ count: count() })
    .from(users)
    .where(and(isNull(users.deletedAt), gte(users.createdAt, sevenDaysAgo)));
  return res?.count ?? 0;
}

/** Active in the last N minutes — the "logged in simultaneously" signal for admin-alerts.service.ts. */
export async function countUsersActiveSince(since: Date): Promise<number> {
  const [res] = await db
    .select({ count: count() })
    .from(users)
    .where(and(isNull(users.deletedAt), gte(users.lastActiveAt, since)));
  return res?.count ?? 0;
}

/** Generic version of `countNewUsersToday` — powers the new-user-burst check in admin-alerts.service.ts. */
export async function countNewUsersSince(since: Date): Promise<number> {
  const [res] = await db
    .select({ count: count() })
    .from(users)
    .where(and(isNull(users.deletedAt), gte(users.createdAt, since)));
  return res?.count ?? 0;
}

/**
 * Distinct users active in the closed [from, to) window. Powers the admin
 * dashboard's active-users tiles and the Telegram /activity command.
 *
 * Counted from an event union, NOT `users.lastActiveAt`: that column is a
 * single field overwritten on every request, so a user active yesterday AND
 * today only lands in today's bucket — past windows silently shrank as people
 * came back. Same union `recurringUsersForWeek` uses, plus lastActiveAt as a
 * tail so a user who only browsed (no AI call / chat / order / report) still
 * counts on the day they last visited.
 */
export async function usersActiveBetween(range: DateRange): Promise<number> {
  const from = range.from.toISOString();
  const to = range.to.toISOString();
  const result = await db.execute<{ activeCount: string }>(sql`
    WITH activity AS (
      SELECT user_id, created_at FROM ${aiUsage} WHERE user_id IS NOT NULL
      UNION ALL
      SELECT user_id, created_at FROM ${chatSessions}
      UNION ALL
      SELECT user_id, created_at FROM ${voiceSessions}
      UNION ALL
      SELECT user_id, created_at FROM ${orders}
      UNION ALL
      SELECT user_id, created_at FROM ${reports}
      UNION ALL
      SELECT id AS user_id, last_active_at AS created_at FROM ${users}
        WHERE last_active_at IS NOT NULL
    )
    SELECT count(DISTINCT a.user_id) AS "activeCount"
    FROM activity a
    JOIN ${users} u ON u.id = a.user_id AND u.deleted_at IS NULL
    WHERE a.created_at >= ${from} AND a.created_at < ${to}
  `);
  return Number(result[0]?.activeCount ?? 0);
}

/** Same active-user definition as `usersActiveBetween`, grouped by each user's cached geo (nulls
 * grouped together as "unresolved" rather than dropped, since sparse geo is expected — most users
 * won't have sent a heartbeat since geo tracking shipped). Sorted by count descending. */
export async function activeUsersByLocation(
  range: DateRange,
): Promise<{ country: string | null; city: string | null; totalUsers: number }[]> {
  const from = range.from.toISOString();
  const to = range.to.toISOString();
  const result = await db.execute<{
    country: string | null;
    city: string | null;
    total: string;
  }>(sql`
    WITH activity AS (
      SELECT user_id, created_at FROM ${aiUsage} WHERE user_id IS NOT NULL
      UNION ALL
      SELECT user_id, created_at FROM ${chatSessions}
      UNION ALL
      SELECT user_id, created_at FROM ${voiceSessions}
      UNION ALL
      SELECT user_id, created_at FROM ${orders}
      UNION ALL
      SELECT user_id, created_at FROM ${reports}
      UNION ALL
      SELECT id AS user_id, last_active_at AS created_at FROM ${users}
        WHERE last_active_at IS NOT NULL
    )
    SELECT u.geo_country AS "country", u.geo_city AS "city", count(DISTINCT a.user_id) AS "total"
    FROM activity a
    JOIN ${users} u ON u.id = a.user_id AND u.deleted_at IS NULL
    WHERE a.created_at >= ${from} AND a.created_at < ${to}
    GROUP BY u.geo_country, u.geo_city
    ORDER BY "total" DESC
  `);
  return result.map((row) => ({
    country: row.country,
    city: row.city,
    totalUsers: Number(row.total),
  }));
}

/** `DateRange`-bounded sibling of `countNewUsersSince` — see `usersActiveBetween`'s comment. */
export async function usersCreatedBetween(range: DateRange): Promise<number> {
  const [res] = await db
    .select({ count: count() })
    .from(users)
    .where(
      and(isNull(users.deletedAt), gte(users.createdAt, range.from), lt(users.createdAt, range.to)),
    );
  return res?.count ?? 0;
}

/** Sum of every active user's wallet balance — the platform's outstanding liability. */
export async function sumWalletBalanceOutstanding(): Promise<number> {
  const [res] = await db
    .select({ total: sql<number>`coalesce(sum(${users.walletBalancePaise}), 0)` })
    .from(users)
    .where(isNull(users.deletedAt));
  return Number(res?.total ?? 0);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `q`'s search behavior is asymmetric across columns because phoneE164 is
 * encrypted at rest (non-deterministic ciphertext — see decryptUserRow's
 * doc comment): displayName/email are plaintext columns and can be ILIKE'd
 * for a partial match, but phone can only be matched EXACTLY via its
 * deterministic lookup hash (the same primitive findUserByPhoneE164 uses),
 * never partially. `id` is matched EXACTLY too, and only attempted when `q`
 * is UUID-shaped — `users.id` is a uuid column, so feeding it a non-uuid
 * string throws at the DB level instead of just not matching.
 */
export type ContactTypeFilter = 'all' | 'phone' | 'email';

function userSearchWhere(q?: string, contactType: ContactTypeFilter = 'all') {
  const notDeleted = isNull(users.deletedAt);
  const contactClause =
    contactType === 'phone'
      ? isNotNull(users.phoneE164)
      : contactType === 'email'
        ? isNotNull(users.email)
        : undefined;
  if (!q) return contactClause ? and(notDeleted, contactClause) : notDeleted;
  const like = `%${q}%`;
  const conditions = [
    ilike(users.displayName, like),
    ilike(users.email, like),
    eq(users.phoneE164Hash, hashForLookup(q)),
  ];
  if (UUID_RE.test(q)) conditions.push(eq(users.id, q));
  const searchClause = or(...conditions);
  return contactClause
    ? and(notDeleted, contactClause, searchClause)
    : and(notDeleted, searchClause);
}

const USER_SORT_COLUMNS = {
  createdAt: users.createdAt,
  lastActiveAt: users.lastActiveAt,
  walletBalancePaise: users.walletBalancePaise,
} as const;
/** `claimedAt`/`totalPaidPaise` aren't real columns (see below), so they can't live in USER_SORT_COLUMNS — handled as separate branches in listUsersPage's orderBy. */
export type UserSortBy = keyof typeof USER_SORT_COLUMNS | 'claimedAt' | 'totalPaidPaise';

/** Whichever claim-campaign (static config or admin-created `gift_campaigns`
 * row) was launched most recently, system-wide — see config/campaigns.ts and
 * gift-campaigns.repo.ts. A fresh call per use (rather than a shared constant)
 * since it's referenced in both the select list and, when sorted on, the
 * orderBy clause.
 *
 * 2026-09-02: this used to be "this user's own most-recently-CLAIMED campaign,
 * across all campaigns ever" (ORDER BY wt.created_at DESC) — which meant a
 * user who claimed an old campaign but never touched the brand-new one just
 * launched still showed the OLD campaign's amount/date here, making a
 * freshly-sent campaign look like it had zero uptake. The admin's actual
 * question is "did this user claim the campaign I just ran", so the LATEST
 * CAMPAIGN is picked first (by istDate / sentAt, not by claim time), and each
 * user is checked against that one specific reason only — no claim of it
 * means a blank cell, even if they claimed something older.
 *
 * Deliberately hand-aliases the inner table and references the outer `users`
 * table by its literal name, rather than interpolating `walletTransactions`/
 * `users` Column objects — those render as BARE column names inside a raw sql
 * fragment (no table qualifier), so `${users.id}` here would emit unqualified
 * `"id"`, which Postgres resolves to wallet_transactions' OWN `id` primary key
 * inside the subquery's scope, not the intended outer-row correlation. That
 * silently made this always evaluate false. Explicit aliasing removes the
 * ambiguity entirely.
 */
const staticCampaignDatesList =
  CLAIM_CAMPAIGNS.length > 0
    ? sql.join(
        CLAIM_CAMPAIGNS.map((c) => sql`(${c.key}, ${c.istDate}::date)`),
        sql`, `,
      )
    : null;
const latestCampaignKeyExpr = sql`(
  select key from (
    ${staticCampaignDatesList ? sql`select * from (values ${staticCampaignDatesList}) as t(key, d)` : sql`select null::text as key, null::date as d where false`}
    union all
    select key, sent_at::date as d from gift_campaigns where status = 'sent' and sent_at is not null
  ) all_campaigns
  order by d desc
  limit 1
)`;
const claimedAmountExpr = () => sql<number | null>`(
  select wt.delta from wallet_transactions wt
  where wt.user_id = users.id
    and wt.reason = ${latestCampaignKeyExpr}
  order by wt.created_at desc
  limit 1
)`;
const claimedAtExpr = () => sql<string | null>`(
  select wt.created_at from wallet_transactions wt
  where wt.user_id = users.id
    and wt.reason = ${latestCampaignKeyExpr}
  order by wt.created_at desc
  limit 1
)`;

/** Lifetime paid-order total and most recent payment date — same hand-aliased-subquery
 * style as claimedAmountExpr above, for the same reason (bare `${orders.userId}` would
 * resolve inside the subquery's own scope, not the outer correlated row). */
const totalPaidExpr = () => sql<number>`(
  select coalesce(sum(o.final_amount_paise), 0) from orders o
  where o.user_id = users.id and o.status = 'paid'
)`;
const lastPaidAtExpr = () => sql<string | null>`(
  select max(o.paid_at) from orders o
  where o.user_id = users.id and o.status = 'paid'
)`;

/** Sum of `user_activity_daily.seconds_active` for this user over an inclusive IST date range.
 * Same hand-aliased-subquery style as claimedAmountExpr above, for the same reason: interpolating
 * the `userActivityDaily` column objects directly would render unqualified inside the subquery. */
const activitySecondsExpr = (fromDateInclusive: string, toDateInclusive: string) => sql<number>`(
  select coalesce(sum(uad.seconds_active), 0) from user_activity_daily uad
  where uad.user_id = users.id
    and uad.activity_date >= ${fromDateInclusive}
    and uad.activity_date <= ${toDateInclusive}
)`;

/** IST-anchored date strings for the Users table's 5 time-spent windows, all inclusive-inclusive. */
function timeSpentWindows(now = new Date()) {
  const today = istDateString(now);
  const yesterday = istDateString(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const weekStart = istDateString(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
  const [year, month] = today.split('-');
  const monthStart = `${year}-${month}-01`;
  const yearStart = `${year}-01-01`;
  return { today, yesterday, weekStart, monthStart, yearStart };
}

/** Powers both the Telegram `/users` command (no `q`) and the admin dashboard's `GET /v1/admin/users?q=` search. */
export async function listUsersPage(
  limit: number,
  offset: number,
  q?: string,
  sortBy: UserSortBy = 'createdAt',
  sortDir: 'asc' | 'desc' = 'desc',
  contactType: ContactTypeFilter = 'all',
) {
  const orderExpr =
    sortBy === 'claimedAt'
      ? claimedAtExpr()
      : sortBy === 'totalPaidPaise'
        ? totalPaidExpr()
        : USER_SORT_COLUMNS[sortBy];
  const w = timeSpentWindows();
  const rows = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      phoneE164: users.phoneE164,
      email: users.email,
      referralSource: users.referralSource,
      walletBalancePaise: users.walletBalancePaise,
      createdAt: users.createdAt,
      lastActiveAt: users.lastActiveAt,
      claimedAmountPaise: claimedAmountExpr(),
      claimedAt: claimedAtExpr(),
      totalPaidPaise: totalPaidExpr(),
      lastPaidAt: lastPaidAtExpr(),
      country: users.geoCountry,
      city: users.geoCity,
      timeSpentTodaySec: activitySecondsExpr(w.today, w.today),
      timeSpentYesterdaySec: activitySecondsExpr(w.yesterday, w.yesterday),
      timeSpentWeekSec: activitySecondsExpr(w.weekStart, w.today),
      timeSpentMonthSec: activitySecondsExpr(w.monthStart, w.today),
      timeSpentYearSec: activitySecondsExpr(w.yearStart, w.today),
    })
    .from(users)
    .where(userSearchWhere(q, contactType))
    .orderBy(sortDir === 'asc' ? asc(orderExpr) : desc(orderExpr))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => ({ ...row, phoneE164: decryptField(row.phoneE164) }));
}

/**
 * Upserts today's (IST) active-seconds counter for `userId` by `secondsIncrement`, and — only
 * when the IP differs from what's cached — best-effort re-resolves geo via ip-api.com. The geo
 * call is awaited (not fire-and-forget): it only runs on an IP change, which is rare after the
 * first heartbeat, so the extra latency is not part of every ping.
 */
export async function recordActivityHeartbeat(
  userId: string,
  ip: string | null,
  secondsIncrement: number,
): Promise<void> {
  const today = istDateString(new Date());
  await db
    .insert(userActivityDaily)
    .values({ userId, activityDate: today, secondsActive: secondsIncrement })
    .onConflictDoUpdate({
      target: [userActivityDaily.userId, userActivityDaily.activityDate],
      set: { secondsActive: sql`${userActivityDaily.secondsActive} + ${secondsIncrement}` },
    });

  if (!ip) return;
  const [current] = await db
    .select({ lastIp: users.lastIp })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (current?.lastIp === ip) return;

  const geo = await resolveGeoForIp(ip);
  await db
    .update(users)
    .set({
      lastIp: ip,
      ...(geo ? { geoCountry: geo.country, geoCity: geo.city, geoResolvedAt: new Date() } : {}),
    })
    .where(eq(users.id, userId))
    .catch((err) => {
      logger.warn({ err, userId }, 'recordActivityHeartbeat: failed to persist geo update');
    });
}

/**
 * Every wallet refund in a window, newest first, with the affected user.
 *
 * A `refund:*` ledger row is the app's OWN record that a user paid for
 * something and got nothing back — chat, vastu, reports and gemstone all write
 * one on their failure path before surfacing the error. That makes this table,
 * rather than a multi-hundred-MB pm2 log, the cheapest reliable answer to "did
 * anything go wrong for a user today": it is per-user, already indexed, and
 * only records failures that actually cost somebody something.
 *
 * Note what it therefore does NOT cover, by design: failures that cost the user
 * nothing to retry (a degraded translation falling back to English) never write
 * a row and never appear here.
 */
export async function listRefundsBetween(range: DateRange) {
  const rows = await db
    .select({
      createdAt: walletTransactions.createdAt,
      delta: walletTransactions.delta,
      reason: walletTransactions.reason,
      userId: users.id,
      displayName: users.displayName,
      phoneE164: users.phoneE164,
    })
    .from(walletTransactions)
    .innerJoin(users, eq(walletTransactions.userId, users.id))
    .where(
      and(
        gte(walletTransactions.createdAt, range.from),
        lt(walletTransactions.createdAt, range.to),
        ilike(walletTransactions.reason, 'refund:%'),
      ),
    )
    .orderBy(desc(walletTransactions.createdAt));
  return rows.map((row) => ({ ...row, phoneE164: decryptField(row.phoneE164) }));
}

/** Total matching `listUsersPage`'s own search predicate — powers the admin dashboard's pagination total. */
export async function countUsersMatching(
  q?: string,
  contactType: ContactTypeFilter = 'all',
): Promise<number> {
  const [res] = await db
    .select({ count: count() })
    .from(users)
    .where(userSearchWhere(q, contactType));
  return res?.count ?? 0;
}

/**
 * Fail-open fallback only, for when `paid.houseInsight` resolves no price at
 * all. NOT the price — that comes from the admin panel via `priceOf()` and is
 * passed in as `pricePaise`. Reused by `unlockHouseForOwnedProfile`
 * (birth-profiles.repo.ts) for the additional-profile case.
 */
export const HOUSE_UNLOCK_FALLBACK_PAISE = 5000;

/**
 * Flat referral rows for the admin referrals panel. Self-joins `users`
 * (referred) to `users` aliased as `referrer` on
 * `referred.referredByCode = referrer.referralCode` (inner join, so a
 * referrer whose row was hard-deleted simply drops their referred users from
 * the list — acceptable edge case for an admin-only report). Only non-deleted
 * referred users with a non-null referredByCode are included. Ordered by
 * referred `createdAt` desc (newest sign-ups first).
 */
export async function listReferrals() {
  const referrer = alias(users, 'referrer');
  const rows = await db
    .select({
      referrerId: referrer.id,
      referrerDisplayName: referrer.displayName,
      referrerPhoneE164: referrer.phoneE164,
      referredId: users.id,
      referredDisplayName: users.displayName,
      referredPhoneE164: users.phoneE164,
      referredCreatedAt: users.createdAt,
    })
    .from(users)
    .innerJoin(referrer, eq(users.referredByCode, referrer.referralCode))
    .where(and(isNull(users.deletedAt), isNotNull(users.referredByCode)))
    .orderBy(desc(users.createdAt));
  return rows.map((row) => ({
    ...row,
    referrerPhoneE164: decryptField(row.referrerPhoneE164),
    referredPhoneE164: decryptField(row.referredPhoneE164),
  }));
}

/** Vote counts grouped by report key, most-requested first — active
 * (non-deleted) users only. Powers the admin "Next Report Requests" card. */
export async function listNextReportVoteCounts(): Promise<{ reportKey: string; count: number }[]> {
  const rows = await db
    .select({ reportKey: users.nextReportVote, count: count() })
    .from(users)
    .where(and(isNotNull(users.nextReportVote), isNull(users.deletedAt)))
    .groupBy(users.nextReportVote)
    .orderBy(desc(count()));
  return rows as { reportKey: string; count: number }[];
}

/**
 * `pricePaise` is resolved by the caller (users.service.ts `unlockHouse`) from
 * the admin-set feature price — this function must never invent its own, or the
 * UI's quoted price and the actual debit drift apart.
 */
export async function unlockHouseForUser(
  userId: string,
  houseNumber: number,
  pricePaise: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [unlocked] = await tx
      .update(users)
      .set({
        walletBalancePaise: sql`${users.walletBalancePaise} - ${pricePaise}`,
        unlockedHouses: sql`array_append(${users.unlockedHouses}, ${houseNumber})`,
      })
      .where(
        and(
          eq(users.id, userId),
          gte(users.walletBalancePaise, pricePaise),
          sql`NOT (${houseNumber} = ANY(${users.unlockedHouses}))`,
        ),
      )
      .returning({ walletBalancePaise: users.walletBalancePaise });
    if (!unlocked) return false;

    await tx.insert(walletTransactions).values({
      userId,
      delta: -pricePaise,
      reason: `house_unlock:${houseNumber}`,
      balanceAfter: unlocked.walletBalancePaise,
    });
    await consumeExpiringCredits(tx, userId, pricePaise);
    return true;
  });
}

/** Fail-open fallback only for `paid.gemstone` — see HOUSE_UNLOCK_FALLBACK_PAISE. */
export const GEMSTONE_UNLOCK_FALLBACK_PAISE = 10000;

/**
 * Atomically spend wallet balance to unlock the gemstone report — same
 * combined deduct-and-guard primitive as `unlockHouseForUser`. Returns false
 * if the user has too little balance OR the report is already unlocked, so a
 * second click can never double-charge.
 *
 * `pricePaise` is the admin-resolved price, passed in by the caller — the
 * relock/refund path below must be given the SAME value that was charged.
 */
export async function unlockGemstoneForUser(
  userId: string,
  weightKg: number | null,
  pricePaise: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [unlocked] = await tx
      .update(users)
      .set({
        walletBalancePaise: sql`${users.walletBalancePaise} - ${pricePaise}`,
        gemstoneUnlockedAt: new Date(),
        ...(weightKg !== null ? { gemstoneWeightKg: weightKg } : {}),
      })
      .where(
        and(
          eq(users.id, userId),
          gte(users.walletBalancePaise, pricePaise),
          isNull(users.gemstoneUnlockedAt),
        ),
      )
      .returning({ walletBalancePaise: users.walletBalancePaise });
    if (!unlocked) return false;

    await tx.insert(walletTransactions).values({
      userId,
      delta: -pricePaise,
      reason: 'gemstone_unlock',
      balanceAfter: unlocked.walletBalancePaise,
    });
    await consumeExpiringCredits(tx, userId, pricePaise);
    return true;
  });
}

/** Atomically records the vote iff the user hasn't voted before. Returns
 * false (not an error) when a vote already exists — the caller treats a
 * repeat submission as a harmless no-op, not a conflict, since nothing
 * scarce is being spent here (unlike unlockGemstoneForUser). */
export async function recordNextReportVote(userId: string, reportKey: string): Promise<boolean> {
  const [row] = await db
    .update(users)
    .set({ nextReportVote: reportKey, nextReportVotedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.nextReportVote)))
    .returning({ id: users.id });
  return !!row;
}

/**
 * Reverts an unlock when background generation fails.
 * Refunds the balance and sets gemstoneUnlockedAt back to null.
 *
 * The refund amount is read back from the user's own `gemstone_unlock` ledger
 * row rather than recomputed, so it always returns exactly what was taken —
 * even if an admin repriced `paid.gemstone` between the charge and the failure.
 * Falls back to the resolved-at-call-time price only when no ledger row exists
 * (a charge that predates the ledger).
 */
export async function relockGemstoneForUser(
  userId: string,
  fallbackPaise: number = GEMSTONE_UNLOCK_FALLBACK_PAISE,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [charge] = await tx
      .select({ delta: walletTransactions.delta })
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.userId, userId),
          eq(walletTransactions.reason, 'gemstone_unlock'),
        ),
      )
      .orderBy(desc(walletTransactions.createdAt))
      .limit(1);
    const refundPaise = charge ? Math.abs(charge.delta) : fallbackPaise;

    const [relocked] = await tx
      .update(users)
      .set({
        walletBalancePaise: sql`${users.walletBalancePaise} + ${refundPaise}`,
        gemstoneUnlockedAt: null,
      })
      .where(and(eq(users.id, userId), isNotNull(users.gemstoneUnlockedAt)))
      .returning({ walletBalancePaise: users.walletBalancePaise });
    if (!relocked) return false;

    await tx.insert(walletTransactions).values({
      userId,
      delta: refundPaise,
      reason: 'refund:gemstone_report',
      balanceAfter: relocked.walletBalancePaise,
    });
    return true;
  });
}

/**
 * Everything the account holds on one user, decrypted, for the DSAR export at
 * GET /v1/me/export (DPDP Act §11 access; GDPR Arts. 15 and 20).
 *
 * Reads go through this module rather than being assembled at the route,
 * because these tables are encrypted at rest and the decryption belongs at the
 * DB boundary — see the note on `decryptUserRow` above.
 *
 * Two deliberate omissions, both of which would make the export less safe
 * rather than more complete:
 *  - device push tokens: still-live device credentials, not information about
 *    the user. A leaked export must not let anyone push to their phone.
 *  - palm photographs: only the reading metadata is listed, never the image
 *    bytes. The frames stay behind the authenticated, ownership-checked route
 *    they already live behind (see palm.service.ts).
 */
export async function collectUserExport(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;

  const [profiles, sessions, facts, transactions, consents, notifs, palms] = await Promise.all([
    db.select().from(birthProfiles).where(eq(birthProfiles.ownerUserId, userId)),
    db.select().from(chatSessions).where(eq(chatSessions.userId, userId)),
    db.select().from(userFacts).where(eq(userFacts.userId, userId)),
    db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.userId, userId))
      .orderBy(desc(walletTransactions.createdAt)),
    db
      .select()
      .from(userConsentLog)
      .where(eq(userConsentLog.userId, userId))
      .orderBy(desc(userConsentLog.occurredAt)),
    db.select().from(notifications).where(eq(notifications.userId, userId)),
    db
      .select({
        id: palmReadings.id,
        status: palmReadings.status,
        primaryHand: palmReadings.primaryHand,
        createdAt: palmReadings.createdAt,
      })
      .from(palmReadings)
      .where(eq(palmReadings.userId, userId)),
  ]);

  const decrypted = decryptUserRow(user);
  return {
    exportedAt: new Date().toISOString(),
    account: {
      ...decrypted,
      // Blind-index lookup hashes are internal plumbing, not the user's data,
      // and publishing them would weaken the lookup they exist to protect.
      phoneHash: undefined,
      emailHash: undefined,
    },
    birthProfiles: profiles.map((p) => ({
      ...p,
      dateOfBirth: decryptField(p.dateOfBirth),
      timeOfBirth: decryptField(p.timeOfBirth),
      placeOfBirth: decryptJson<PlaceOfBirth>(p.placeOfBirth as unknown as string | null),
      gotra: decryptField(p.gotra),
    })),
    chatSessions: sessions.map((s) => ({
      ...s,
      history: JSON.parse(decryptField(s.history) ?? '[]') as unknown,
      summary: decryptField(s.summary),
    })),
    rememberedFacts: facts.map((f) => ({
      ...f,
      fact: decryptField(f.fact),
      followUpQuestion: decryptField(f.followUpQuestion),
    })),
    walletTransactions: transactions,
    consentHistory: consents,
    notifications: notifs,
    palmReadings: palms,
  };
}
