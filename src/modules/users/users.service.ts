import type { NewUserRow, NewUserConsentLogRow, UserRow } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { Errors } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { requestKundliGeneration } from '../kundli/kundli.service.js';
import { deleteHouseInsightsForUser } from '../kundli/house-insight.repo.js';
import { deleteGemstoneForUser } from '../gemstone/gemstone.repo.js';
import { deleteRemedyInsightForUser } from '../astro/remedy-insight.repo.js';
import { deleteHoroscopesForProfile } from '../horoscope/horoscope.repo.js';
import { type ProfileContext } from '../birth-profiles/profile-context.js';
import { priceOf, payoutOf, type ResolvedFeature } from '../features/features.service.js';
import { formatPaise } from '../../lib/money.js';
import { CLAIM_CAMPAIGNS } from '../../config/campaigns.js';
import { istDateString } from '../../lib/astro-tools/transit-events.js';
import { findLiveSelfClaimCampaign } from '../gift-campaigns/gift-campaigns.repo.js';
import {
  unlockGemstoneForOwnedProfile,
  unlockHouseForOwnedProfile,
} from '../birth-profiles/birth-profiles.repo.js';
import type { ConsentInput, UpdateMeBody, UserDto } from './users.schemas.js';
import {
  claimBirthDetailsEdit,
  findActiveUserById,
  revokeDeviceTokensByUser,
  softDeleteBirthProfilesByOwner,
  anonymizeUserById,
  requestUserDeletion,
  updateUserById,
  updateUserWithConsentLog,
  findUserByReferralCode,
  applyReferralBonus,
  REFERRER_BONUS_FALLBACK_PAISE,
  REFEREE_BONUS_FALLBACK_PAISE,
  REFERRAL_CAP_FALLBACK_PAISE,
  getNotificationsForUser,
  markNotificationsRead as markUserNotificationsRead,
} from './users.repo.js';
import { db } from '../../config/db.js';
import { notifications, devicePushTokens } from '../../db/schema.js';
import { sendPushBatch } from '../../lib/notifications/fcm.js';
import { notifyAccountDeletionRequest } from '../../lib/notifications/telegram.js';
import { eq, isNull, and } from 'drizzle-orm';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** A consent is currently in force when granted and not subsequently revoked. */
const consentActive = (grantedAt: Date | null, revokedAt: Date | null): boolean =>
  grantedAt != null && revokedAt == null;

/**
 * Whatever self-claim campaign (static or DB-backed) is currently live AND
 * eligible for this user, or null. Mirrors the exact gates the claim-bonus
 * route itself enforces (the balance ceiling, already-claimed, signed-up-
 * today) so the frontend never offers a claim the route would refuse — same
 * intent as useClaimCampaign's old client-side gates, just computed here
 * since there's no longer one fixed key to hardcode into every client build.
 */
export async function resolveActiveClaimableCampaign(
  user: UserRow,
  claimedCampaigns: string[],
  now: Date = new Date(),
): Promise<{ key: string; title: string; amountPaise: number; validUntil: string } | null> {
  const today = istDateString(now);

  // Static campaigns: at most one is ever "today" — CLAIM_CAMPAIGNS is small, a linear scan is fine.
  const staticLive = CLAIM_CAMPAIGNS.find((c) => c.istDate === today);
  if (
    staticLive &&
    !claimedCampaigns.includes(staticLive.key) &&
    istDateString(user.createdAt) !== staticLive.istDate &&
    (staticLive.maxBalancePaise === undefined ||
      user.walletBalancePaise < staticLive.maxBalancePaise)
  ) {
    const amountPaise = await payoutOf(user.id, staticLive.featureKey, staticLive.fallbackPaise);
    if (amountPaise > 0) {
      return {
        key: staticLive.key,
        title: staticLive.key,
        amountPaise,
        validUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      };
    }
  }

  const dbLive = await findLiveSelfClaimCampaign(now);
  if (
    dbLive &&
    !claimedCampaigns.includes(dbLive.key) &&
    istDateString(user.createdAt) !== istDateString(dbLive.sentAt ?? now) &&
    (dbLive.audienceMaxBalancePaise === null ||
      user.walletBalancePaise < dbLive.audienceMaxBalancePaise)
  ) {
    return {
      key: dbLive.key,
      title: dbLive.title,
      amountPaise: dbLive.amountPaise,
      validUntil: dbLive.validUntil!.toISOString(),
    };
  }

  return null;
}

/**
 * `unlockedHouses`/`gemstoneUnlocked` are per-profile, not per-user — `profile`
 * must be resolved via {@link resolveActiveProfileContext} (or an equivalent
 * `resolveProfileContext` call) by the caller so a secondary profile's own
 * unlock state is returned instead of the primary's.
 *
 * `features` is the server-resolved, per-user, group-aware feature registry
 * (see `resolveFeaturesForUser()` in `features.service.ts`) — passed in
 * rather than resolved here so this stays a pure, synchronous mapper; every
 * call site resolves it once per request.
 *
 * `feedbackGiven` is passed in for the same reason, via `hasGivenFeedback()`.
 * `claimedCampaigns` likewise, via `getClaimedCampaignKeys()` — the campaign
 * keys (see config/campaigns.ts) this user has already claimed, of any
 * one-time claim campaign that currently exists. `activeClaimableCampaign`
 * likewise, via `resolveActiveClaimableCampaign()` above.
 */
export function toUserDto(
  row: UserRow,
  profile: ProfileContext,
  features: Record<string, ResolvedFeature>,
  feedbackGiven: boolean,
  claimedCampaigns: string[],
  activeClaimableCampaign: {
    key: string;
    title: string;
    amountPaise: number;
    validUntil: string;
  } | null,
): UserDto {
  return {
    id: row.id,
    firebaseUid: row.firebaseUid,
    phoneE164: row.phoneE164,

    displayName: row.displayName,
    gender: row.gender,
    email: row.email,
    avatarUrl: row.avatarUrl,

    dateOfBirth: row.dateOfBirth,
    timeOfBirth: row.timeOfBirth,
    placeOfBirth: row.placeOfBirth,
    birthTimeAccuracy: row.birthTimeAccuracy,
    birthTimeSource: row.birthTimeSource,
    birthTimeRectified: row.birthTimeRectified,
    birthTimeRectificationConfidence: row.birthTimeRectificationConfidence,
    birthLocationAccuracy: row.birthLocationAccuracy,
    canEditBirthDetails: row.birthDetailsEditedAt === null,
    // Separate from canEditBirthDetails on purpose: that flag still (correctly) gates
    // the date and the place. This one only says the stored time is a window midpoint
    // rather than a real answer, so the profile screen can offer a time-only upgrade
    // even to someone who has already spent their one edit.
    canSetExactBirthTime: row.birthTimeAccuracy === 'unknown',
    gotra: row.gotra,
    sankalpaName: row.sankalpaName,

    preferredSystem: row.preferredSystem,
    preferredAyanamsa: row.preferredAyanamsa,
    preferredHouseSystem: row.preferredHouseSystem,
    preferredChartStyle: row.preferredChartStyle,
    preferredDashaSystem: row.preferredDashaSystem,
    preferredDashaYearLength: row.preferredDashaYearLength,
    preferredNodeType: row.preferredNodeType,
    preferredCalendarLocale: row.preferredCalendarLocale,
    chartPreferences: row.chartPreferences,

    currentLocation: row.currentLocation,
    currentLocationUpdatedAt: iso(row.currentLocationUpdatedAt),
    currentTimezone: row.currentTimezone,
    currentCountry: row.currentCountry,

    locale: row.locale,
    contentLanguage: row.contentLanguage,

    dailyHoroscopeSendHourLocal: row.dailyHoroscopeSendHourLocal,
    interestAreas: row.interestAreas,
    relationshipStatus: row.relationshipStatus,
    partnerSeekingIntent: row.partnerSeekingIntent,
    notificationPrefs: row.notificationPrefs,
    quietHours: row.quietHours,

    onboardingStatus: row.onboardingStatus,
    onboardingStep: row.onboardingStep,
    onboardingCompletedAt: iso(row.onboardingCompletedAt),
    profileCompletedAt: iso(row.profileCompletedAt),

    // This row was erased once and the same person has signed back in — the
    // phone number is deliberately kept on the shell (see anonymizeUserById),
    // so they land on the SAME account with every detail blank rather than a
    // fresh one. `anonymizedAt` is never cleared, so this stays true forever;
    // the app uses it only to say "welcome back, we'll need your details
    // again" instead of greeting them as a brand-new user.
    previouslyDeleted: row.anonymizedAt !== null,
    deletionRequestedAt: iso(row.deletionRequestedAt),

    lastActiveAt: iso(row.lastActiveAt),
    streakCount: row.streakCount,
    streakLastDay: row.streakLastDay,
    appVersion: row.appVersion,
    platform: row.platform,
    walletBalancePaise: row.walletBalancePaise,
    nextReportVote: row.nextReportVote,
    // `profile.unlockedHouses` is already normalized to `[]` (never null) by
    // resolveProfileContext — no separate null-fallback needed here.
    unlockedHouses: profile.unlockedHouses,
    gemstoneUnlocked: profile.gemstoneUnlockedAt !== null,
    feedbackGiven,
    claimedCampaigns,
    // jsonb default '[]' — the ?? is for rows read through a connection that
    // predates migration 0060, not for normal operation.
    toursCompleted: row.toursCompleted ?? [],
    activeClaimableCampaign,

    features,

    // UI affordance only (see the field's schema doc) — the DB column is fine
    // to read here since this never gates a request, unlike requireAdmin.
    isAdmin: env.ADMIN_PHONE_E164.includes(row.phoneE164 ?? ''),

    referralSource: row.referralSource,
    referredByCode: row.referredByCode,
    referralCode: row.referralCode,

    // Consent: grant timestamp, revoke timestamp, and a derived "in force" flag
    // so a send-gate never has to reconstruct grant-vs-revoke ordering.
    marketingConsentAt: iso(row.marketingConsentAt),
    marketingConsentRevokedAt: iso(row.marketingConsentRevokedAt),
    marketingConsentActive: consentActive(row.marketingConsentAt, row.marketingConsentRevokedAt),
    whatsappOptInAt: iso(row.whatsappOptInAt),
    whatsappOptInRevokedAt: iso(row.whatsappOptInRevokedAt),
    whatsappOptInActive: consentActive(row.whatsappOptInAt, row.whatsappOptInRevokedAt),
    dataProcessingConsentAt: iso(row.dataProcessingConsentAt),
    dataProcessingConsentRevokedAt: iso(row.dataProcessingConsentRevokedAt),
    dataProcessingConsentActive: consentActive(
      row.dataProcessingConsentAt,
      row.dataProcessingConsentRevokedAt,
    ),
    voiceConsentAt: iso(row.voiceConsentAt),
    voiceConsentRevokedAt: iso(row.voiceConsentRevokedAt),
    voiceConsentActive: consentActive(row.voiceConsentAt, row.voiceConsentRevokedAt),
    termsAcceptedAt: iso(row.termsAcceptedAt),
    termsVersion: row.termsVersion,
    privacyPolicyAcceptedAt: iso(row.privacyPolicyAcceptedAt),
    privacyPolicyVersion: row.privacyPolicyVersion,

    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * A profile is complete once the chart-bearing fields are present. The birth
 * TIME requirement is satisfied by EITHER a recorded time OR an explicit
 * `birthTimeAccuracy === 'unknown'` — so a user who genuinely doesn't know
 * their birth time can still finish onboarding (they are never blocked
 * forever). `approximate` still requires a stated time; only `unknown` waives
 * it.
 */
export function isProfileComplete(row: UserRow): boolean {
  const coreFilled =
    row.displayName != null &&
    row.gender != null &&
    row.dateOfBirth != null &&
    row.placeOfBirth != null;
  const timeSatisfied = row.timeOfBirth != null || row.birthTimeAccuracy === 'unknown';
  return coreFilled && timeSatisfied;
}

/** Fields that map 1:1 from the request body onto a user row column. */
const DIRECT_FIELDS = [
  'displayName',
  'gender',
  'email',
  'avatarUrl',
  'dateOfBirth',
  'timeOfBirth',
  'placeOfBirth',
  'birthTimeAccuracy',
  'birthTimeSource',
  'birthTimeRectified',
  'birthTimeRectificationConfidence',
  'birthLocationAccuracy',
  'gotra',
  'sankalpaName',
  'preferredSystem',
  'preferredAyanamsa',
  'preferredHouseSystem',
  'preferredChartStyle',
  'preferredDashaSystem',
  'preferredDashaYearLength',
  'preferredNodeType',
  'preferredCalendarLocale',
  'chartPreferences',
  'currentLocation',
  'currentTimezone',
  'currentCountry',
  'locale',
  'contentLanguage',
  'dailyHoroscopeSendHourLocal',
  'interestAreas',
  'relationshipStatus',
  'partnerSeekingIntent',
  'notificationPrefs',
  'quietHours',
  'onboardingStatus',
  'onboardingStep',
  'appVersion',
  'platform',
  'referralSource',
  'referredByCode',
] as const satisfies readonly (keyof NewUserRow & keyof UpdateMeBody)[];

export type ConsentContext = { sourceIp?: string | null; userAgent?: string | null };

/** Translate a consent input into user-row timestamp patches + audit rows. */
function applyConsent(
  consent: ConsentInput,
  patch: Partial<NewUserRow>,
  userId: string,
  ctx: ConsentContext,
): NewUserConsentLogRow[] {
  const now = new Date();
  const logs: NewUserConsentLogRow[] = [];
  const base = {
    userId,
    occurredAt: now,
    sourceIp: ctx.sourceIp ?? null,
    userAgent: ctx.userAgent ?? null,
  };

  if (consent.terms) {
    patch.termsAcceptedAt = now;
    patch.termsVersion = consent.terms.version;
    logs.push({
      ...base,
      consentType: 'terms',
      action: 'granted',
      policyVersion: consent.terms.version,
    });
  }
  if (consent.privacy) {
    patch.privacyPolicyAcceptedAt = now;
    patch.privacyPolicyVersion = consent.privacy.version;
    logs.push({
      ...base,
      consentType: 'privacy',
      action: 'granted',
      policyVersion: consent.privacy.version,
    });
  }
  if (consent.dataProcessing !== undefined) {
    if (consent.dataProcessing) {
      patch.dataProcessingConsentAt = now;
      patch.dataProcessingConsentRevokedAt = null;
    } else {
      // Keep the original grant timestamp; record when it was withdrawn.
      patch.dataProcessingConsentRevokedAt = now;
    }
    logs.push({
      ...base,
      consentType: 'data_processing',
      action: consent.dataProcessing ? 'granted' : 'withdrawn',
    });
  }
  if (consent.voice !== undefined) {
    if (consent.voice) {
      patch.voiceConsentAt = now;
      patch.voiceConsentRevokedAt = null;
    } else {
      // Same "keep the grant, record the withdrawal" shape as dataProcessing
      // above — the audit trail needs both timestamps, not one overwritten one.
      patch.voiceConsentRevokedAt = now;
    }
    logs.push({
      ...base,
      consentType: 'voice',
      action: consent.voice ? 'granted' : 'withdrawn',
    });
  }
  if (consent.marketing !== undefined) {
    if (consent.marketing) {
      patch.marketingConsentAt = now;
      patch.marketingConsentRevokedAt = null;
    } else {
      patch.marketingConsentRevokedAt = now;
    }
    logs.push({
      ...base,
      consentType: 'marketing',
      action: consent.marketing ? 'granted' : 'withdrawn',
    });
  }
  if (consent.whatsapp !== undefined) {
    if (consent.whatsapp) {
      patch.whatsappOptInAt = now;
      patch.whatsappOptInRevokedAt = null;
    } else {
      patch.whatsappOptInRevokedAt = now;
    }
    logs.push({
      ...base,
      consentType: 'whatsapp',
      action: consent.whatsapp ? 'granted' : 'withdrawn',
    });
  }
  return logs;
}

function buildPatch(body: UpdateMeBody): Partial<NewUserRow> {
  const out: Partial<NewUserRow> = {};
  for (const key of DIRECT_FIELDS) {
    const value = body[key];
    if (value !== undefined) {
      // Names and value types are aligned 1:1 between the body and the row.
      (out as Record<string, unknown>)[key] = value;
    }
  }

  // Residence timezone is denormalized from the location for the daily-send
  // cron's hot read; keep it authoritative by always re-deriving it (ignoring
  // any conflicting body value) whenever the location changes.
  if (body.currentLocation !== undefined) {
    out.currentLocationUpdatedAt = new Date();
    out.currentTimezone = body.currentLocation.tz;
  }
  return out;
}

export async function updateMe(
  userId: string,
  body: UpdateMeBody,
  ctx: ConsentContext = {},
): Promise<UserRow> {
  const current = await findActiveUserById(userId);
  if (!current) throw Errors.notFound('User not found');

  // Editing the birth event (DOB/time/place) on an ALREADY-complete profile
  // is capped at one lifetime edit — onboarding itself (profile not yet
  // complete, possibly filled in across several steps) is exempt, since
  // that's the initial set, not a correction. Claim atomically, up front,
  // so a rejected edit never partially applies alongside other fields in
  // the same request; if the rest of the patch below fails for an unrelated
  // reason, roll the claim back so the user doesn't lose their one edit to
  // an unrelated error.
  const touchedBirthEvent =
    body.dateOfBirth !== undefined ||
    body.timeOfBirth !== undefined ||
    body.placeOfBirth !== undefined;
  // Replacing a window-derived time with a real clock time is the completion of
  // onboarding, not a correction of it: a profile whose accuracy is 'unknown' never
  // held a time the reader gave us, only the midpoint of the part-of-day window they
  // picked (see lib/birth-time-window.ts). Charging their one lifetime edit for that
  // would punish the honest answer and leave them stuck with a ~33%-accurate ascendant
  // forever. Narrow on purpose: the date and place must be untouched, so the exemption
  // can't be used to smuggle through a free DOB or birthplace change.
  const isBirthTimeUpgrade =
    current.birthTimeAccuracy === 'unknown' &&
    body.timeOfBirth != null &&
    body.birthTimeAccuracy != null &&
    body.birthTimeAccuracy !== 'unknown' &&
    body.dateOfBirth === undefined &&
    body.placeOfBirth === undefined;

  const isPostOnboardingBirthEdit =
    touchedBirthEvent && current.profileCompletedAt !== null && !isBirthTimeUpgrade;

  if (isPostOnboardingBirthEdit) {
    const claimed = await claimBirthDetailsEdit(userId);
    if (!claimed) throw Errors.conflict('Birth details can only be edited once');
  }

  const patch = buildPatch(body);

  // Tour completion is an append-if-absent against the row we just read, not a
  // client-supplied array — two devices finishing different tours must not
  // clobber each other. `resetTours` (the Settings "show me around again" row)
  // wins over an append in the same request; nothing sends both.
  if (body.resetTours) {
    patch.toursCompleted = [];
  } else if (body.tourCompleted) {
    const seen = current.toursCompleted ?? [];
    patch.toursCompleted = seen.includes(body.tourCompleted) ? seen : [...seen, body.tourCompleted];
  }

  const consentLogs = body.consent ? applyConsent(body.consent, patch, userId, ctx) : [];

  // Referral code validated up front (before the patch commits) so an unknown/self
  // code is rejected outright rather than silently saved with no bonus ever applied.
  let referrer: UserRow | undefined;
  if (patch.referredByCode && !current.referredByCode) {
    referrer = await findUserByReferralCode(patch.referredByCode);
    if (!referrer || referrer.id === current.id) {
      referrer = undefined;
      patch.referredByCode = null;
    }
  }

  // Stamp the funnel-completion time server-side the first time the client
  // reports a terminal onboarding status (the column is otherwise never set).
  if (
    (body.onboardingStatus === 'completed' || body.onboardingStatus === 'skipped') &&
    current.onboardingCompletedAt === null
  ) {
    patch.onboardingCompletedAt = new Date();
  }

  let next: UserRow | undefined;
  try {
    next =
      consentLogs.length > 0
        ? await updateUserWithConsentLog(userId, patch, consentLogs)
        : await updateUserById(userId, patch);
  } catch (err) {
    if (isPostOnboardingBirthEdit) {
      await updateUserById(userId, { birthDetailsEditedAt: null }).catch(() => {});
    }
    if (isUniqueViolation(err)) throw Errors.conflict('That email is already in use');
    throw err;
  }
  if (!next) throw Errors.notFound('User not found');

  // Referral bonus is granted only now that referredByCode is durably saved above —
  // running this before the commit risked double-crediting both parties if a client
  // retried a request whose patch commit failed for an unrelated reason.
  if (referrer) {
    try {
      // Admin-set referral economics, resolved once and used for BOTH the
      // ledger write and the notification copy below — quoting a different
      // number than was actually credited is the same shown-≠-actual defect
      // that made house unlocks bill double their advertised price.
      const [referrerPaise, refereePaise, capPaise] = await Promise.all([
        payoutOf(referrer.id, 'referral.referrerBonus', REFERRER_BONUS_FALLBACK_PAISE),
        payoutOf(current.id, 'referral.refereeBonus', REFEREE_BONUS_FALLBACK_PAISE),
        priceOf(referrer.id, 'referral.earningsCap', REFERRAL_CAP_FALLBACK_PAISE),
      ]);

      const { referrerBonus, refereeBonus } = await applyReferralBonus(referrer.id, current.id, {
        referrerPaise,
        refereePaise,
        capPaise,
      });
      const recipients: { userId: string; title: string; body: string }[] = [];
      if (referrerBonus) {
        recipients.push({
          userId: referrer.id,
          title: 'Referral Bonus!',
          body: `A friend signed up using your code. You earned ${formatPaise(referrerPaise)}!`,
        });
      }
      if (refereeBonus) {
        recipients.push({
          userId: current.id,
          title: 'Welcome Bonus!',
          body: `You earned ${formatPaise(refereePaise)} for signing up with a referral code!`,
        });
      }
      if (recipients.length > 0) {
        await db.insert(notifications).values(
          recipients.map((r) => ({
            userId: r.userId,
            title: r.title,
            body: r.body,
            type: 'referral_bonus',
          })),
        );
      }
      for (const r of recipients) {
        try {
          const tokens = await db
            .select({ token: devicePushTokens.token })
            .from(devicePushTokens)
            .where(and(eq(devicePushTokens.userId, r.userId), isNull(devicePushTokens.revokedAt)));
          if (tokens.length > 0) {
            await sendPushBatch(
              tokens.map((t) => t.token),
              r.title,
              r.body,
            );
          }
        } catch (err) {
          logger.error({ err, userId: r.userId }, 'Failed to send referral push notification');
        }
      }
    } catch (err) {
      logger.error(
        { err, userId: current.id, referrerId: referrer.id },
        'Failed to apply referral bonus',
      );
    }
  }

  // The natal chart just changed under previously-unlocked houses — their
  // cached insight text no longer matches. Wipe it so it regenerates fresh
  // (lazily, on next view) rather than silently serving stale content;
  // houses stay unlocked, no re-charge.
  if (isPostOnboardingBirthEdit) {
    // This endpoint edits the `users` row itself (the primary/self profile) —
    // always the primary (birthProfileId: null) side, never an additional
    // birth_profiles entry.
    await deleteHouseInsightsForUser(userId, null).catch((err: unknown) => {
      logger.error({ err, userId }, 'house insight invalidation after birth-detail edit failed');
    });
    // The gemstone report is derived from the same natal chart — wipe it too so
    // it regenerates against the new chart. The unlock flag stays set (no re-charge).
    await deleteGemstoneForUser(userId, null).catch((err: unknown) => {
      logger.error({ err, userId }, 'gemstone invalidation after birth-detail edit failed');
    });
    // Same reasoning for the remedies page's plain-language layer: its prose
    // names houses and placements from the OLD chart, so it must not survive.
    await deleteRemedyInsightForUser(userId, null).catch((err: unknown) => {
      logger.error({ err, userId }, 'remedy insight invalidation after birth-detail edit failed');
    });
  }

  // Reconcile the completion latch in BOTH directions so the DTO never claims
  // a profile is complete after a required field (e.g. timeOfBirth) is cleared.
  const shouldComplete = isProfileComplete(next);
  if (shouldComplete !== (next.profileCompletedAt !== null)) {
    const finalized = await updateUserById(userId, {
      profileCompletedAt: shouldComplete ? new Date() : null,
    });
    if (finalized) next = finalized;
  }

  // Start kundli generation the moment onboarding completes — or when birth
  // inputs change on an already-complete profile. Fire-and-forget so the PATCH
  // returns immediately; the generation request is idempotent (DB-deduped).
  const becameComplete = current.profileCompletedAt === null && next.profileCompletedAt !== null;
  const touchedBirth =
    body.dateOfBirth !== undefined ||
    body.timeOfBirth !== undefined ||
    body.placeOfBirth !== undefined ||
    body.birthTimeAccuracy !== undefined ||
    body.preferredAyanamsa !== undefined ||
    body.preferredHouseSystem !== undefined;
  if (next.profileCompletedAt !== null && (becameComplete || touchedBirth)) {
    // Primary profile only — see the birthProfileId: null comment above.
    void requestKundliGeneration(userId, null).catch((err: unknown) => {
      logger.error({ err, userId }, 'kundli generation trigger failed');
    });
  }

  // Users who onboard with an admittedly-unknown birth time never get a kundli
  // (missingKundliParams always flags timeOfBirth for them), so the post-kundli
  // horoscope invalidation in kundli.service.ts#runGeneration never fires for
  // this cohort — their birth-data edits would leave stale `ready` rows behind
  // with nothing to clear them. Invalidate directly here instead. Generation
  // itself is on the fly, on first view (see GET /v1/horoscope); the horoscope
  // context tolerates a missing kundli and falls back to a generic reading.
  if (
    next.profileCompletedAt !== null &&
    (becameComplete || touchedBirth) &&
    next.birthTimeAccuracy === 'unknown'
  ) {
    // Primary profile only — see the birthProfileId: null comment above.
    void deleteHoroscopesForProfile(next.id, null).catch((err: unknown) => {
      logger.error({ err, userId }, 'horoscope invalidation (unknown birth time) failed');
    });
  }

  return next;
}

/**
 * What `DELETE /v1/me` now does. Deletion is a reviewed request, not an
 * immediate erasure: this only stamps `deletionRequestedAt` and pings the
 * admin Telegram chat. Nothing is destroyed until someone runs
 * `/approvedelete` in the bot, which calls {@link deleteMe} below.
 *
 * The account keeps working meanwhile, but stops costing us anything — the
 * timestamp is what suppresses push (`device-tokens.repo.ts`) and horoscope
 * generation (`horoscope.repo.ts`) for this user.
 */
export async function requestAccountDeletion(userId: string): Promise<Date> {
  const current = await findActiveUserById(userId);
  if (!current) throw Errors.notFound('User not found');

  const requestedAt = await requestUserDeletion(userId);
  if (!requestedAt) throw Errors.notFound('User not found');

  // Only announce the first time. A repeat tap returns the original timestamp
  // unchanged (see requestUserDeletion) and must not re-ping the admin chat.
  if (current.deletionRequestedAt === null) {
    // Fire-and-forget — a Telegram outage must never fail the user's request.
    void notifyAccountDeletionRequest({
      userId,
      contact: current.phoneE164 ?? current.email,
      requestedAt,
    }).catch(() => {});
  }

  return requestedAt;
}

export async function deleteMe(userId: string): Promise<void> {
  const current = await findActiveUserById(userId);
  if (!current) throw Errors.notFound('User not found');
  // Cascade: stop processing third-party birth data and pushing to devices
  // BEFORE anonymizing — anonymizeUserById relies on tokens already being
  // revoked (it reuses their revoked-token uniqueness exemption).
  await softDeleteBirthProfilesByOwner(userId);
  await revokeDeviceTokensByUser(userId);
  await anonymizeUserById(userId);
}

/**
 * Both unlock paths resolve the admin-set price HERE, once, and pass it down to
 * whichever repo function does the debit — the repo functions charge inline in
 * SQL and must never carry a price of their own. This is the single place the
 * quoted price (the app reads `useFeature('paid.houseInsight').pricePaise`) and
 * the actual debit are kept in agreement.
 */
export async function unlockHouse(
  userId: string,
  birthProfileId: string | null,
  houseNumber: number,
): Promise<void> {
  const { HOUSE_UNLOCK_FALLBACK_PAISE } = await import('./users.repo.js');
  const pricePaise = await priceOf(userId, 'paid.houseInsight', HOUSE_UNLOCK_FALLBACK_PAISE);

  let success: boolean;
  if (birthProfileId === null) {
    const { unlockHouseForUser } = await import('./users.repo.js');
    success = await unlockHouseForUser(userId, houseNumber, pricePaise);
  } else {
    success = await unlockHouseForOwnedProfile(birthProfileId, userId, houseNumber, pricePaise);
  }
  if (!success) {
    throw Errors.conflict('Insufficient credits or house already unlocked');
  }
}

export async function unlockGemstone(
  userId: string,
  birthProfileId: string | null,
  weightKg: number | null = null,
): Promise<void> {
  const { GEMSTONE_UNLOCK_FALLBACK_PAISE } = await import('./users.repo.js');
  const pricePaise = await priceOf(userId, 'paid.gemstone', GEMSTONE_UNLOCK_FALLBACK_PAISE);

  let success: boolean;
  if (birthProfileId === null) {
    const { unlockGemstoneForUser } = await import('./users.repo.js');
    success = await unlockGemstoneForUser(userId, weightKg, pricePaise);
  } else {
    success = await unlockGemstoneForOwnedProfile(birthProfileId, userId, weightKg, pricePaise);
  }
  if (!success) {
    throw Errors.conflict('Insufficient credits or gemstone report already unlocked');
  }
}

export async function refundGemstoneUnlock(
  userId: string,
  birthProfileId: string | null,
): Promise<void> {
  let success: boolean;
  if (birthProfileId === null) {
    const { relockGemstoneForUser } = await import('./users.repo.js');
    success = await relockGemstoneForUser(userId);
  } else {
    const { relockGemstoneForOwnedProfile } =
      await import('../birth-profiles/birth-profiles.repo.js');
    success = await relockGemstoneForOwnedProfile(birthProfileId, userId);
  }
  if (!success) {
    logger.warn(
      { userId, birthProfileId },
      'Failed to relock gemstone report (maybe already locked?)',
    );
  }
}

export async function getNotifications(userId: string) {
  const rows = await getNotificationsForUser(userId);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    type: r.type,
    link: r.link ?? null,
    readAt: iso(r.readAt),
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function markNotificationsRead(userId: string) {
  await markUserNotificationsRead(userId);
}
