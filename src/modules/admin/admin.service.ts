import { FEATURE_REGISTRY, isKnownFeatureKey } from '../../config/features.js';
import { getReportDef } from '../../config/reports.js';
import { Errors } from '../../lib/errors.js';
import { resolveFeatures, invalidateFeatureCache } from '../features/features.service.js';
import { upsertFeatureOverride } from '../features/features.repo.js';
import {
  usersActiveBetween,
  usersCreatedBetween,
  sumWalletBalanceOutstanding,
  listUsersPage,
  countUsersMatching,
  listReferrals,
  listNextReportVoteCounts,
  addWalletBalance,
  deductWalletBalance,
  findActiveUserById,
  listPendingDeletionRequestsBefore,
  clearDeletionRequest,
  hardDeleteUserById,
  type UserSortBy,
  type ContactTypeFilter,
} from '../users/users.repo.js';
import { requestAccountDeletion } from '../users/users.service.js';
import { costByAgent, type AgentCostRow } from './ai-usage.repo.js';
import {
  listAllReportRows,
  adminResetReportRow,
  adminDeleteReportRow,
  adminResetReportRowsByKey,
  adminDeleteReportRowsByKey,
} from '../reports/reports.repo.js';
import { listAllReportRatings } from '../reports/report-ratings.repo.js';
import {
  sumPaidOrdersBetween,
  revenueTimeSeries,
  spendByFeature,
  spendByReportKey,
  topUpFunnel,
  payingUserCount,
  logAdminAction,
  recurringUserWeeks,
  recurringUsersForWeek,
  timeSpentHoursForWeek,
  userDemographics,
  type DateRange,
  type UserDemographics,
} from './admin.repo.js';

/**
 * Bucket-size heuristic for the overview's revenueTimeSeries — coarser
 * granularity for long windows keeps the chart readable (a year of daily
 * points is not useful) while short/medium windows stay at daily
 * resolution. Not specified beyond "day/week/month" support in the repo
 * primitive, so this is a reasonable admin-dashboard default.
 */
function bucketForPreset(preset: string): 'day' | 'week' | 'month' {
  if (preset === 'this_year' || preset === 'lifetime') return 'month';
  if (preset === 'last90d' || preset === 'this_quarter') return 'week';
  return 'day';
}

export interface OverviewDto {
  range: { from: string; to: string };
  cashInPaise: number;
  orderCount: number;
  walletSpendPaise: number;
  walletLiabilityPaise: number;
  payingUsers: number;
  arpuPaise: number;
  newUsers: number;
  activeUsers: number;
  timeSeries: { bucketStart: string; totalPaise: number; count: number }[];
  spendByFeature: { reasonPrefix: string; totalPaise: number; count: number }[];
  topUpFunnel: { status: string; count: number }[];
  llmCostByAgent: AgentCostRow[];
}

/** `arpu` = cash collected in `range` / active users in `range`, floored at 1 user to avoid a divide-by-zero on a quiet window. Computed here (service layer), not in the repo, per the task spec. */
export async function arpu(range: DateRange): Promise<number> {
  const [{ totalPaise }, activeUsers] = await Promise.all([
    sumPaidOrdersBetween(range),
    usersActiveBetween(range),
  ]);
  return Math.round(totalPaise / Math.max(1, activeUsers));
}

export async function getOverview(
  range: DateRange,
  preset: string,
  opts: { llmUserId?: string } = {},
): Promise<OverviewDto> {
  const [
    { totalPaise: cashInPaise, count: orderCount },
    timeSeries,
    spend,
    funnel,
    payingUsers,
    newUsers,
    activeUsers,
    walletLiabilityPaise,
    llmCostByAgent,
  ] = await Promise.all([
    sumPaidOrdersBetween(range),
    revenueTimeSeries(range, bucketForPreset(preset)),
    spendByFeature(range),
    topUpFunnel(range),
    payingUserCount(range),
    usersCreatedBetween(range),
    usersActiveBetween(range),
    sumWalletBalanceOutstanding(),
    // Only the AI-cost breakdown honours the user filter — the revenue and
    // funnel figures beside it are business-wide by definition, so narrowing
    // them to one user would be meaningless rather than useful.
    costByAgent(range, opts.llmUserId ? { userId: opts.llmUserId } : {}),
  ]);

  const walletSpendPaise = spend.reduce((sum, entry) => sum + entry.totalPaise, 0);
  const arpuPaise = Math.round(cashInPaise / Math.max(1, activeUsers));

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    cashInPaise,
    orderCount,
    walletSpendPaise,
    walletLiabilityPaise,
    payingUsers,
    arpuPaise,
    newUsers,
    activeUsers,
    timeSeries,
    spendByFeature: spend,
    topUpFunnel: funnel,
    llmCostByAgent,
  };
}

/* -------------------------------------------------------------------------- */
/* Feature flags                                                              */
/* -------------------------------------------------------------------------- */

export interface AdminFeatureRow {
  key: string;
  label: string;
  group: string;
  enabled: boolean;
  pricePaise: number | null;
  originalPricePaise: number | null;
  /** Currently selected model, for a key that declares `modelOptions`; null for every other
   * key (and for a model key whose toggle is off — see FeatureDef.modelOptions). */
  model: string | null;
  /** Non-empty only for model-picker keys — the dashboard renders a dropdown of these instead
   * of a price box. Sent from the registry so the options live in exactly one place. */
  modelOptions: string[];
}

/** Merges FEATURE_REGISTRY (the source of truth for what features exist) with resolveFeatures()'s admin overrides. */
export async function listFeaturesForAdmin(): Promise<AdminFeatureRow[]> {
  const resolved = await resolveFeatures();
  return FEATURE_REGISTRY.map((feature) => ({
    key: feature.key,
    label: feature.label,
    group: feature.group,
    enabled: resolved[feature.key]?.enabled ?? feature.defaultEnabled,
    pricePaise: resolved[feature.key]?.pricePaise ?? feature.defaultPricePaise ?? null,
    // No registry-level default for this one (unlike pricePaise/basePricePaise)
    // — a feature with no admin override simply has no discount to show.
    originalPricePaise: resolved[feature.key]?.originalPricePaise ?? null,
    model: resolved[feature.key]?.model ?? feature.defaultModel ?? null,
    modelOptions: [...(feature.modelOptions ?? [])],
  }));
}

/**
 * Toggles/prices a feature. `pricePaise === undefined` means "leave the
 * price as it currently resolves" (registry default or existing override) —
 * distinct from an explicit `null`, which clears it. `originalPricePaise`
 * follows the identical undefined-preserves/null-clears convention,
 * independently of `pricePaise`, and so does `model` (the AI model-picker
 * keys' selection). A `model` value outside the key's registry
 * `modelOptions` is rejected rather than stored: a typo'd model id would
 * fail every request for that feature until someone noticed. Rejects an
 * unknown key up front since
 * FEATURE_REGISTRY is the source of truth for what keys exist; writing an
 * override row for a key nothing reads would be silent dead configuration.
 */
export async function updateFeature(
  key: string,
  enabled: boolean,
  pricePaise: number | null | undefined,
  originalPricePaise: number | null | undefined,
  model: string | null | undefined,
  adminPhone: string,
): Promise<AdminFeatureRow> {
  if (!isKnownFeatureKey(key)) {
    throw Errors.badRequest(`Unknown feature key "${key}"`);
  }
  const registryEntry = FEATURE_REGISTRY.find((feature) => feature.key === key)!;

  if (model != null && !(registryEntry.modelOptions ?? []).includes(model)) {
    throw Errors.badRequest(`Model "${model}" is not an option for feature "${key}"`);
  }

  // Resolve once, unconditionally. This used to be skipped when every field was supplied
  // explicitly; with three independent undefined-preserves fields that conditional was three
  // ways to be wrong for one cached read (resolveFeatures memoizes for 30s).
  const resolved = await resolveFeatures();
  const current = resolved[key];
  const resolvedPrice =
    pricePaise === undefined
      ? (current?.pricePaise ?? registryEntry.defaultPricePaise ?? null)
      : pricePaise;
  const resolvedOriginalPrice =
    originalPricePaise === undefined ? (current?.originalPricePaise ?? null) : originalPricePaise;
  const resolvedModel =
    model === undefined ? (current?.model ?? registryEntry.defaultModel ?? null) : model;
  // Only a false->true transition resets the "New" badge clock (see schema.ts's
  // featureFlags.enabledAt doc comment) — a price/model-only save while already enabled must
  // not make an old report look freshly launched again.
  const wasEnabled = current?.enabled ?? registryEntry.defaultEnabled;
  const resolvedEnabledAt = enabled && !wasEnabled ? new Date() : (current?.enabledAt ?? null);

  const row = await upsertFeatureOverride(
    key,
    enabled,
    resolvedPrice,
    resolvedOriginalPrice,
    resolvedModel,
    adminPhone,
    resolvedEnabledAt,
  );
  invalidateFeatureCache();
  await logAdminAction(adminPhone, 'PUT /v1/admin/features', {
    key,
    enabled,
    pricePaise: resolvedPrice,
    originalPricePaise: resolvedOriginalPrice,
    model: resolvedModel,
  });

  return {
    key: row.key,
    label: registryEntry.label,
    group: registryEntry.group,
    enabled: row.enabled,
    pricePaise: row.pricePaise,
    originalPricePaise: row.originalPricePaise,
    model: row.enabled ? row.model : null,
    modelOptions: [...(registryEntry.modelOptions ?? [])],
  };
}

/* -------------------------------------------------------------------------- */
/* Users                                                                      */
/* -------------------------------------------------------------------------- */

export async function searchUsers(
  q: string | undefined,
  limit: number,
  offset: number,
  sortBy: UserSortBy = 'createdAt',
  sortDir: 'asc' | 'desc' = 'desc',
  contactType: ContactTypeFilter = 'all',
) {
  const [rows, total] = await Promise.all([
    listUsersPage(limit, offset, q, sortBy, sortDir, contactType),
    countUsersMatching(q, contactType),
  ]);
  const users = rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.lastActiveAt ? row.lastActiveAt.toISOString() : null,
  }));
  return { users, total, offset, limit };
}

/**
 * The web equivalent of the Telegram `/money` command (telegram-bot.commands.ts
 * cmdMoney) — same reasons (`admin_grant`/`admin_deduction`), same refusal
 * behavior when a deduction would exceed the balance (409, NOT a floor-at-
 * zero — deductWalletBalance's own conditional-UPDATE guard already refuses,
 * this just surfaces that as an HTTP error instead of a chat reply).
 */
export async function adjustWallet(
  userId: string,
  deltaPaise: number,
  note: string,
  adminPhone: string,
): Promise<{ walletBalancePaise: number }> {
  const user = await findActiveUserById(userId);
  if (!user) throw Errors.notFound('User not found');

  if (deltaPaise === 0) {
    throw Errors.badRequest('deltaPaise must be non-zero');
  }

  const amountPaise = Math.round(Math.abs(deltaPaise));
  if (deltaPaise > 0) {
    await addWalletBalance(userId, amountPaise, 'admin_grant');
  } else {
    const ok = await deductWalletBalance(userId, amountPaise, 'admin_deduction');
    if (!ok) {
      throw Errors.conflict(
        `Cannot deduct ${amountPaise} paise from this user — balance is only ${user.walletBalancePaise} paise`,
      );
    }
  }

  const updated = await findActiveUserById(userId);
  await logAdminAction(adminPhone, `POST /v1/admin/users/${userId}/wallet`, { deltaPaise, note });
  return { walletBalancePaise: updated?.walletBalancePaise ?? 0 };
}

/* -------------------------------------------------------------------------- */
/* Reports                                                                    */
/* -------------------------------------------------------------------------- */

export async function getReportsBreakdown(range: DateRange) {
  return spendByReportKey(range);
}

/* -------------------------------------------------------------------------- */
/* Report generations — who generated which report                            */
/* -------------------------------------------------------------------------- */

export async function getReportGenerations(
  reportKey: string | undefined,
  limit: number,
  offset: number,
) {
  const { rows, total } = await listAllReportRows(reportKey, limit, offset);
  const reportsOut = rows.map((row) => ({
    ...row,
    periodMonth: row.periodMonth,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
  return { reports: reportsOut, total, offset, limit };
}

export async function resetReportGeneration(id: string, adminPhone: string) {
  const row = await adminResetReportRow(id);
  if (!row) throw Errors.notFound('Report not found');
  await logAdminAction(adminPhone, `POST /v1/admin/report-generations/${id}/reset`, {});
  return { id: row.id, status: 'failed' as const };
}

export async function deleteReportGeneration(id: string, adminPhone: string) {
  const deleted = await adminDeleteReportRow(id);
  if (!deleted) throw Errors.notFound('Report not found');
  await logAdminAction(adminPhone, `DELETE /v1/admin/report-generations/${id}`, {});
}

export async function resetReportGenerationsBulk(reportKey: string, adminPhone: string) {
  const count = await adminResetReportRowsByKey(reportKey);
  await logAdminAction(adminPhone, 'POST /v1/admin/report-generations/reset-all', {
    reportKey,
    count,
  });
  return { count };
}

export async function deleteReportGenerationsBulk(reportKey: string, adminPhone: string) {
  const count = await adminDeleteReportRowsByKey(reportKey);
  await logAdminAction(adminPhone, 'POST /v1/admin/report-generations/delete-all', {
    reportKey,
    count,
  });
  return { count };
}

/* -------------------------------------------------------------------------- */
/* Report ratings — every rating across all users                             */
/* -------------------------------------------------------------------------- */

export async function getReportRatings(
  reportKey: string | undefined,
  limit: number,
  offset: number,
) {
  const { rows, total } = await listAllReportRatings(reportKey, limit, offset);
  const ratings = rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  return { ratings, total, offset, limit };
}

/** Vote counts for "which report should we prepare next", most-requested
 * first, with each report's display label resolved from the catalogue. */
export async function getNextReportVoteCounts() {
  const rows = await listNextReportVoteCounts();
  const votes = rows.map((r) => ({
    reportKey: r.reportKey,
    label: getReportDef(r.reportKey)?.label ?? r.reportKey,
    count: r.count,
  }));
  return { votes };
}

/* -------------------------------------------------------------------------- */
/* Recurring users                                                             */
/* -------------------------------------------------------------------------- */

const RECURRING_WEEK_LABELS = [
  'this_week',
  'last_week',
  'last_week_plus_1',
  'last_week_plus_2',
] as const;

export interface RecurringUsersWeekDto {
  label: (typeof RECURRING_WEEK_LABELS)[number];
  from: string;
  to: string;
  activeUsers: number;
  recurringUsers: number;
  timeSpentHours: number;
}

/** Fixed four-week breakdown for the admin "Recurring Users" card — see recurringUserWeeks()/recurringUsersForWeek() for what "recurring" means here. */
export async function getRecurringUsers(): Promise<RecurringUsersWeekDto[]> {
  const weeks = recurringUserWeeks();
  return Promise.all(
    weeks.map(async (range, i) => {
      const [{ activeCount, recurringCount }, timeSpentHours] = await Promise.all([
        recurringUsersForWeek(range),
        timeSpentHoursForWeek(range),
      ]);
      return {
        label: RECURRING_WEEK_LABELS[i]!,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        activeUsers: activeCount,
        recurringUsers: recurringCount,
        timeSpentHours,
      };
    }),
  );
}

/** Age-bracket, gender, and relationship-status breakdown across all (non-deleted) users, for the admin "User Demographics" card. */
export async function getUserDemographics(): Promise<UserDemographics> {
  return userDemographics();
}

/* -------------------------------------------------------------------------- */
/* Referrals                                                                   */
/* -------------------------------------------------------------------------- */

export interface ReferredUserDto {
  id: string;
  displayName: string | null;
  phoneE164: string | null;
  createdAt: string;
}

export interface ReferralRowDto {
  referrer: { id: string; displayName: string | null; phoneE164: string | null };
  count: number;
  referredUsers: ReferredUserDto[];
}

/**
 * Groups the flat rows from `listReferrals()` by referrer and returns an
 * array sorted by descending referral count (most prolific referrers first).
 */
export async function getReferrals(): Promise<ReferralRowDto[]> {
  const rows = await listReferrals();
  const byReferrer = new Map<string, ReferralRowDto>();
  for (const row of rows) {
    let entry = byReferrer.get(row.referrerId);
    if (!entry) {
      entry = {
        referrer: {
          id: row.referrerId,
          displayName: row.referrerDisplayName,
          phoneE164: row.referrerPhoneE164,
        },
        count: 0,
        referredUsers: [],
      };
      byReferrer.set(row.referrerId, entry);
    }
    entry.referredUsers.push({
      id: row.referredId,
      displayName: row.referredDisplayName,
      phoneE164: row.referredPhoneE164,
      createdAt: row.referredCreatedAt.toISOString(),
    });
    entry.count += 1;
  }
  return Array.from(byReferrer.values()).sort((a, b) => b.count - a.count);
}

/* -------------------------------------------------------------------------- */
/* Deletion requests                                                          */
/* -------------------------------------------------------------------------- */

export interface AdminDeletionRequestDto {
  id: string;
  displayName: string | null;
  phoneE164: string | null;
  email: string | null;
  deletionRequestedAt: string;
}

export interface AdminDeletionActionDto {
  id: string;
  deletionRequestedAt: string | null;
}

/**
 * Pending requests, oldest first — the admin-console counterpart to the
 * Telegram bot's `/pendingdeletes`. Reuses the reminder cron's own query with
 * `cutoff = now`, since "requested before now" is just every pending request
 * that exists so far; deliberately no pagination, matching the Referrals
 * tab's precedent for a queue this low-volume.
 */
export async function listDeletionRequests(): Promise<AdminDeletionRequestDto[]> {
  const rows = await listPendingDeletionRequestsBefore(new Date());
  return rows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    phoneE164: row.phoneE164,
    email: row.email,
    // Guaranteed non-null: the query itself filters on isNotNull(deletionRequestedAt).
    deletionRequestedAt: row.deletionRequestedAt!.toISOString(),
  }));
}

/**
 * Manual flag for someone who called in to ask for deletion instead of
 * tapping Delete Account in-app. Reuses `requestAccountDeletion` (the same
 * function `DELETE /v1/me` calls) so it's idempotent and fires the same
 * admin Telegram ping — a phone-in request should look identical downstream
 * to a self-service one.
 */
export async function flagUserForDeletion(
  userId: string,
  adminPhone: string,
): Promise<AdminDeletionActionDto> {
  const requestedAt = await requestAccountDeletion(userId);
  await logAdminAction(adminPhone, `POST /v1/admin/deletion-requests/${userId}`, {});
  return { id: userId, deletionRequestedAt: requestedAt.toISOString() };
}

/** Dismiss a pending request — the account stays exactly as it was, nothing erased. */
export async function rejectDeletionRequest(
  userId: string,
  adminPhone: string,
): Promise<AdminDeletionActionDto> {
  const user = await findActiveUserById(userId);
  if (!user) throw Errors.notFound('User not found');
  await clearDeletionRequest(userId);
  await logAdminAction(adminPhone, `PATCH /v1/admin/deletion-requests/${userId}/reject`, {});
  return { id: userId, deletionRequestedAt: null };
}

/**
 * Irreversible hard delete — the admin-console equivalent of the Telegram
 * bot's `/delete` command. Uses `hardDeleteUserById`, NOT the self-service
 * `anonymizeUserById` path: no shell row survives (see
 * users.repo.ts's doc comments on the two functions for why they differ).
 * The phone number is captured for the audit log before the row disappears.
 */
export async function deleteUserHard(userId: string, adminPhone: string): Promise<{ id: string }> {
  const user = await findActiveUserById(userId);
  if (!user) throw Errors.notFound('User not found');
  await hardDeleteUserById(userId);
  await logAdminAction(adminPhone, `DELETE /v1/admin/deletion-requests/${userId}`, {
    phoneE164: user.phoneE164,
  });
  return { id: userId };
}
