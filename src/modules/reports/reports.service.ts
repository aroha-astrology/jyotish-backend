// =============================================================================
// Reports feature — generic purchase + generation orchestration
// =============================================================================
// This module never knows anything report-type-specific — it only calls
// through the ReportGenerator contract (report-generator.types.ts). Adding a
// new report type (past_life, wealth, the *_monthly reports, etc.) means
// registering a new generator (see modules/reports/generators/index.ts); this
// file does not change.
// =============================================================================

import '../reports/generators/index.js';
import crypto from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { unknownBirthTimeGuidance } from '../../lib/birth-time-window.js';
import { Errors } from '../../lib/errors.js';
import { runWithRequestContext } from '../../lib/request-context.js';
import { MODEL } from '../../config/llm.js';
import { env } from '../../config/env.js';
import {
  getReportDef,
  monthlyBundlePricePaise,
  computeIsNewReport,
  REPORT_CATALOGUE,
  type ReportDef,
  type ReportKey,
} from '../../config/reports.js';
import { assignSectionIds } from '../../config/report-sections.js';
import { resolveFeaturesForUser } from '../features/features.service.js';
import {
  deductWalletBalance,
  addWalletBalance,
  findActiveUserById,
  recordNextReportVote,
} from '../users/users.repo.js';
import { findKundliByUserId } from '../kundli/kundli.repo.js';
import { todayForApp } from '../horoscope/horoscope.service.js';
import { resolveProfileContext } from '../birth-profiles/profile-context.js';
import { computeMetrology } from '../../lib/swarm/agents/metrologist.js';
import {
  chartConditionFacts,
  chartPlanetStrength,
  type PlanetStrengthRow,
} from '../../lib/chat-grounding.js';
import { analyzeAllVakriPlanets } from '../../lib/astro-engine/index.js';
import { recordPrediction } from '../astro/prediction-outcomes.repo.js';
import { verifyReportClaims } from '../../lib/llm/reports/verify-claims.js';
import type { BirthRecord } from '../../lib/swarm/state.js';
import {
  claimQueuedReports,
  claimReportRow,
  countReadyReportsByKey,
  findActiveYearlyReportRow,
  findReportById,
  findReportRow,
  findReportRowByInputHash,
  findStaleGeneratingReports,
  hashReportInput,
  listReportsForUser,
  markReportFailed,
  markReportReady,
  overwriteReadyReportContent,
  requeueReportForRetry,
  saveReportProgress,
  saveReportScoresTranslation,
  saveReportTranslation,
  upgradePreviewToPurchased,
} from './reports.repo.js';
import {
  extractScoresProse,
  hashLeafValues,
  SCORES_PROSE_ALLOWLIST,
  spliceScoresProse,
  translateScoresProse,
} from '../../lib/llm/report-scores.js';
import {
  findRankedWindowsField,
  spliceWindowSummaries,
  summarizeTimingWindows,
  type PersistedWindowSummaries,
} from '../../lib/llm/reports/window-summary.js';
import {
  generateReportVerdict,
  translateReportVerdict,
  type ReportVerdict,
} from '../../lib/llm/reports/verdict.js';
import {
  REPORT_GENERATORS,
  type ReportGenerator,
  type ReportSection,
  type ReportScoreContext,
  type ReportScores,
  type SectionGenerationProgress,
} from './report-generator.types.js';
import type { UserRow, ReportRow, KundliRow } from '../../db/schema.js';
import type {
  PreviewReportBody,
  PreviewReportResponseDto,
  PurchaseReportBody,
  PurchasedReportSummaryDto,
  ReportCatalogueEntryDto,
  ReportDto,
  ReportHistoryEntryDto,
  ReportStatsDto,
} from './reports.schemas.js';
import { notifyUser } from '../../lib/notifications/notify-user.js';

/**
 * Bumped whenever the persisted `content` shape changes meaningfully (new section-skeleton /
 * life-context / gemstones / verdict rebuild = version 2; divisional-chart (varga) + Ashtakavarga
 * facts added to the narrative of all 11 chart-based report types = version 3; the 5 flagship
 * reports' gemstone slot replaced with Lal Kitab remedies, and Marriage Timing hidden for
 * already-married users = version 4; Marriage Report's "Marriage Quality By Decade" section
 * dropped and its "At A Glance" section stopped stating the numeric marriage score = version 6).
 * Stamped onto
 * `content.contentVersion` by both write paths (`runReportGeneration`, `regenerateReportContent`).
 * A `ready` row whose stamp doesn't match the current version was generated before this shape
 * existed — `getReportForUser` detects this on read and fires a background regeneration (see
 * `triggerLazyRegenerationIfStale`) so an already-purchased report catches up to the new structure
 * the next time its owner actually opens it, rather than a single expensive bulk sweep
 * regenerating reports nobody may ever look at again. No refund, no re-purchase — same
 * no-cost-to-the-user contract `regenerateReportContent` already documents.
 */
const CONTENT_VERSION = 6;

/**
 * Hand-maintained, bumped whenever a report-type's narrative PROMPT wording changes
 * meaningfully — a different axis from CONTENT_VERSION above (that tracks the persisted JSON
 * *shape*; this tracks what was actually asked of the model). Deliberately NOT folded into any
 * cache-invalidation hash and does not trigger regeneration — a prompt tweak should not
 * retroactively invalidate reports users already paid for. Stamped onto `reports.promptVersion`
 * purely for provenance: answering "why does my report read differently than my friend's" or
 * "was this generated before or after the wording fix" without guessing from `createdAt`.
 */
const REPORT_PROMPT_VERSION = '2026.08.2';

// ponytail: process-local dedup only, not a distributed/DB-backed claim — with pm2's cluster
// workers, two near-simultaneous requests landing on DIFFERENT worker processes could each fire
// their own regeneration of the same row (one extra Gemini call, not a correctness bug: the last
// overwriteReadyReportContent call just wins). Upgrade to a DB claim (mirroring claimReportRow)
// if that inefficiency ever matters at this feature's actual traffic.
const regeneratingReportIds = new Set<string>();

/**
 * Fires a background regeneration (see `regenerateReportContent`) for a `ready` row whose
 * persisted content predates `CONTENT_VERSION` — never awaited, never blocks the read it's
 * called from. Guarded against a second concurrent fire for the same row id (same process only,
 * see the doc comment above); once the regeneration lands, the row's `contentVersion` matches and
 * later reads stop triggering. No refund, no re-purchase, no user-visible action required — the
 * next time this report's owner opens it (possibly the read AFTER this one, if generation is
 * fast) they see the rebuilt structure.
 */
function triggerLazyRegenerationIfStale(row: ReportRow): void {
  const contentVersion = (row.content as { contentVersion?: number } | null)?.contentVersion;
  if (contentVersion === CONTENT_VERSION) return;
  if (regeneratingReportIds.has(row.id)) return;
  // Shares the generation queue's budget without owning a queue row: a
  // CONTENT_VERSION bump makes EVERY view of an old report trigger one of these,
  // which would sail straight past the cap the paid queue respects. Skipping is
  // free — the next view of this report triggers the check again.
  if (reportQueueCapacity() === 0) return;

  regeneratingReportIds.add(row.id);
  void regenerateReportContent(row)
    .catch((err: unknown) => {
      logger.error(
        { err, reportId: row.id, reportKey: row.reportKey },
        'lazy report regeneration failed',
      );
    })
    .finally(() => regeneratingReportIds.delete(row.id));
}

const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

function monthKeyToDate(monthKey: string): string {
  return `${monthKey}-01`;
}

/** Inverse of monthKeyToDate — tolerates any 'YYYY-MM-DD' string, not just '-01'. */
function dateToMonthKey(date: string): string {
  return date.slice(0, 7);
}

/**
 * Reason string for the AGGREGATE wallet debit at purchase time — matches the
 * prior admin task's `parseReason` regex in modules/billing/billing.service.ts
 * (`/^report_unlock:([a-z_]+)(?::(\d{4}-\d{2}))?(?::bundle:(\d+))?$/`) exactly:
 * one-time -> `report_unlock:<key>`, a single purchased month -> the `:<YYYY-MM>`
 * suffix, 2+ months -> the `:bundle:<N>` suffix (never both suffixes at once).
 */
function reasonForPurchase(reportKey: string, months: string[]): string {
  if (months.length === 0) return `report_unlock:${reportKey}`;
  if (months.length === 1) return `report_unlock:${reportKey}:${months[0]}`;
  return `report_unlock:${reportKey}:bundle:${months.length}`;
}

/** Reason string for a refund tied to ONE specific row (duplicate-purchase reuse, or a
 * background generation failure) — always the single-month/one-time shape, even when that
 * row was originally purchased as part of a multi-month bundle, for precise ledger tracing. */
export function reasonForRow(reportKey: string, periodMonth: string | null): string {
  if (periodMonth === null) return `report_unlock:${reportKey}`;
  return `report_unlock:${reportKey}:${dateToMonthKey(periodMonth)}`;
}

export function purchaseReportShapeCheck(def: ReportDef, body: PurchaseReportBody): void {
  const months = body.months ?? [];
  if (def.isMonthly && months.length === 0) {
    throw Errors.badRequest(`${def.key} is a monthly report — "months" (YYYY-MM[]) is required`);
  }
  if (!def.isMonthly && months.length > 0) {
    throw Errors.badRequest(`${def.key} is a one-time report and does not accept "months"`);
  }
  for (const m of months) {
    if (!MONTH_KEY_RE.test(m)) {
      throw Errors.badRequest(`Invalid month "${m}" in "months" — expected YYYY-MM`);
    }
  }
  const partnerAllowed = def.requiresPartner || def.acceptsOptionalPartner === true;
  if (def.requiresPartner && !body.partner) {
    throw Errors.badRequest(`${def.key} requires "partner" birth details`);
  }
  if (!partnerAllowed && body.partner) {
    throw Errors.badRequest(`${def.key} does not accept "partner" birth details`);
  }
}

/** Remainder paise land on the first row — arbitrary but documented, and never off by
 * more than (rowCount - 1) paise in total, which is immaterial at these price points. */
function splitPriceAcrossRows(totalPaise: number, rowCount: number): number[] {
  const base = Math.floor(totalPaise / rowCount);
  const remainder = totalPaise - base * rowCount;
  return Array.from({ length: rowCount }, (_, i) => (i === 0 ? base + remainder : base));
}

/**
 * Per-row prices for this purchase. One-time reports (including kundli_milan)
 * are a single flat row at the resolved per-unit price. Monthly reports scale
 * the WHOLE monthlyBundlePricePaise(N) curve by the ratio of the admin's
 * resolved per-month price override to the catalogue's own base per-month
 * price (`perUnitPricePaise / def.basePricePaise`) — e.g. if the admin
 * doubles the per-month price, the entire bundle ladder (₹25/₹45/.../₹199)
 * doubles too, keeping the SAME relative discount curve at any base price.
 * Scaling a monotonically non-decreasing sequence by any positive constant,
 * then rounding (Math.round is itself monotonic non-decreasing), preserves
 * monotonicity — so "N+1 months never costs less than N months" holds
 * regardless of what the admin has set the per-month price to. The final
 * total is rounded exactly once (not per-row) to avoid compounding rounding
 * error before the remainder-on-first-row split below.
 */
function computeRowPrices(def: ReportDef, perUnitPricePaise: number, rowCount: number): number[] {
  if (!def.isMonthly) return [perUnitPricePaise];
  const ratio = perUnitPricePaise / def.basePricePaise;
  const totalPaise = Math.round(monthlyBundlePricePaise(rowCount) * ratio);
  return splitPriceAcrossRows(totalPaise, rowCount);
}

/**
 * Does this `input` actually carry partner birth details?
 *
 * `input` used to be null for every non-partner report, so a bare `if (row.input)`
 * was a correct stand-in for "this is a partner report". `withAnswers` below broke
 * that: it now persists the questionnaire under `input.answers` for EVERY report
 * key, so `{"answers":{"concern":"Looking for job"}}` makes `input` truthy on a
 * career/health report with no partner anywhere in it. The old guard then fed
 * `partnerInputToBirthRecord`'s five undefined fields into computeMetrology and
 * died on `undefined.split('-')`, failing the whole report.
 *
 * `withAnswers` namespaced `answers` to avoid a KEY collision, which it did — the
 * collision was in the truthiness test, not the keys. Test the field the birth
 * record cannot be built without instead.
 */
export function hasPartnerBirthInput(
  input: Record<string, unknown> | null,
): input is Record<string, unknown> {
  return typeof input?.dateOfBirth === 'string';
}

export function partnerInputToBirthRecord(input: Record<string, unknown>): BirthRecord {
  return {
    date: input.dateOfBirth as string,
    time: input.timeOfBirth as string,
    latitude: input.latitude as number,
    longitude: input.longitude as number,
    timezone: input.timezone as string,
  };
}

/**
 * Folds the pre-purchase questionnaire answers into whatever `input` this
 * report row already carries (partner birth details for kundli_milan/
 * match_report, or nothing at all for every other report key), under a
 * namespaced `answers` key so it can never collide with the flat partner
 * fields `partnerInputToBirthRecord` reads above — that function only reads
 * its five known keys and ignores anything else on the object.
 *
 * Before this, `answers` was threaded purely in-memory into ONE generation
 * call (see `runReportGeneration`'s `userAnswers` param below) and then
 * discarded — the highest-signal, self-disclosed text in the product (users
 * describe real situations: "trying to conceive", "considering a job change")
 * was thrown away the moment that one report finished. Persisting it here
 * means it survives regeneration and, via `buildPurchaseFacts`
 * (chat-purchase-facts.ts), becomes something chat can actually reference.
 */
/**
 * Reads the pre-purchase questionnaire answers back off a row's persisted `input.answers` (see
 * `withAnswers` below) — the read-side counterpart that was missing entirely: `runReportGeneration`
 * received `answers` as an in-memory parameter at purchase time, but `recomputeScoresForRead`
 * (fires on every page view) and `regenerateReportContent` rebuilt `ReportScoreContext` from
 * scratch with no `userAnswers` at all, even though `withAnswers` had already persisted them to
 * the same row they were reading. Concretely: baby_name's candidate list is gender-narrowed by
 * `userAnswers.childGender` (see astro-engine/reports/baby-name.ts) — the narrowed list from
 * generation and the un-narrowed list recomputed on every subsequent read disagreed.
 */
export function answersFromInput(
  input: Record<string, unknown> | null,
): Record<string, string> | null {
  const answers = input?.answers;
  return answers && typeof answers === 'object' ? (answers as Record<string, string>) : null;
}

function withAnswers(
  partnerInput: Record<string, unknown> | null,
  answers: Record<string, string> | null,
): Record<string, unknown> | null {
  if (!answers) return partnerInput;
  return { ...(partnerInput ?? {}), answers };
}

/**
 * Best-effort push notification once a purchased report finishes generating.
 * Follows the exact fire-and-forget, never-throws contract as
 * `notifyPurchasePlanReady` in purchase-plan.service.ts — a notification
 * failure here must never affect the report's own generated/ready outcome.
 */
export async function notifyReportReady(
  userId: string,
  reportKey: string,
  reportId: string,
): Promise<void> {
  const label = getReportDef(reportKey)?.label ?? 'report';
  await notifyUser(userId, {
    title: `🔮 Your ${label} is ready`,
    body: 'Tap to read your report now.',
    type: 'report_ready',
    link: `/reports/${reportId}`,
  });
  logger.info({ userId, reportId, reportKey }, 'report:push sent');
}

/**
 * Resolves the person-identity bundle (`personName`/`personDob`/`personGender`) that
 * `numerology`/`name_change`'s `computeScores` read (see report-generator.types.ts's doc
 * comments on those three `ReportScoreContext` fields) — every other registered report type
 * ignores them entirely, so a failure here must never break generation/read for those report
 * types. Sourced via `findActiveUserById` + `resolveProfileContext` — the SAME repo-layer
 * decrypt-on-read path every other feature uses for birth data (see profile-context.ts's own
 * doc comment) — never a raw-column read. Best-effort: never throws, returns all-null (logged)
 * on any failure.
 */
async function fetchPersonContext(
  userId: string,
  birthProfileId: string | null,
): Promise<
  Pick<
    ReportScoreContext,
    | 'personName'
    | 'personDob'
    | 'personGender'
    | 'personRelationshipStatus'
    | 'personPhone'
    | 'personTimeOfBirth'
    | 'personBirthTimeAccuracy'
  >
> {
  try {
    const user = await findActiveUserById(userId);
    if (!user) {
      return {
        personName: null,
        personDob: null,
        personGender: null,
        personRelationshipStatus: null,
        personPhone: null,
        personTimeOfBirth: null,
        personBirthTimeAccuracy: null,
      };
    }
    const profile = await resolveProfileContext(user, birthProfileId);
    return {
      personName: profile.displayName ?? null,
      personDob: profile.dateOfBirth ?? null,
      personGender: profile.gender ?? null,
      // Account-level, not per-profile — same sourcing chat-grounding.ts's
      // buildProfileFacts already uses for this field (see that comment).
      personRelationshipStatus: user.relationshipStatus ?? null,
      // Also account-level (no per-profile phone) — see ReportScoreContext.personPhone's doc
      // comment for why this is safe to source here (numerology's phone block computes FROM
      // it, never echoes it back raw).
      personPhone: user.phoneE164 ?? null,
      personTimeOfBirth: profile.timeOfBirth ?? null,
      personBirthTimeAccuracy: profile.birthTimeAccuracy ?? null,
    };
  } catch (err) {
    logger.warn(
      { err, userId, birthProfileId },
      'failed to resolve person identity context for report scoring',
    );
    return {
      personName: null,
      personDob: null,
      personGender: null,
      personRelationshipStatus: null,
      personPhone: null,
      personTimeOfBirth: null,
      personBirthTimeAccuracy: null,
    };
  }
}

/**
 * Builds the full `ReportScoreContext` for a report row — the single place every kundli blob,
 * person-identity field, and persisted questionnaire answer is assembled for `computeScores`.
 *
 * Previously this object literal was hand-built separately at four call sites
 * (`runReportGeneration`, `recomputeScoresForRead`, `regenerateReportContent`, and
 * astro.service.ts's `buildMatchReportFacts` for chat grounding on an already-purchased
 * match_report) and had already drifted twice: `userAnswers` was only ever set at the first site
 * (see `answersFromInput` above), and the chat-grounding site omitted every field except `chart`/
 * `partnerChart` entirely — so a match_report's chat answer could contradict the purchased report
 * itself (a different Guna score/risk read from a request built with no dasha/dosha/yoga data).
 * New `ReportScoreContext` fields belong here once, not copy-pasted at each call site again.
 *
 * `partnerChart` stays a caller-supplied parameter rather than being computed inside this helper:
 * the four call sites intentionally differ on how a partner-chart computation failure is handled
 * (a hard throw during generation/regeneration vs. a logged-and-degraded null on every-page-view
 * reads vs. the best-effort/never-throws contract chat grounding needs), and folding that in here
 * would force one of those contracts onto the others.
 */
/**
 * Runs a report type's own `computeScores`, then attaches the chart-condition
 * block (Shadbala strength, retrogression, combustion, Bhava Chalit) that every
 * report should carry regardless of type.
 *
 * Lives here rather than in each generator because it is identical for all 14
 * report types and depends only on the chart already in `ctx`. When planetary
 * strength was first wired in it only reached chat/voice/horoscopes via
 * `buildGroundingFacts`; reports never touch that path, which left the paid
 * reports as the one surface still describing a yoga as if it fires cleanly
 * even when the planet ruling it lacks the strength to deliver.
 *
 * Best-effort: a degraded chart yields no condition lines rather than throwing,
 * exactly like the report's own optional fact blocks.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A yearly report's [start, end) validity window (end exclusive) — see ReportDef.isYearly's
 * doc comment. `null` for every non-yearly report key, and for a yearly key whose `periodMonth`
 * is somehow unset (defensive only — purchaseReport always sets it for an isYearly key). */
interface YearWindow {
  start: string; // 'YYYY-MM-DD'
  end: string; // 'YYYY-MM-DD', exclusive
}

function yearWindowFor(reportKey: string, periodMonth: string | null): YearWindow | null {
  if (!periodMonth || !getReportDef(reportKey)?.isYearly) return null;
  const start = new Date(periodMonth);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  return { start: periodMonth, end: end.toISOString().slice(0, 10) };
}

/**
 * Drops any RankedWindow-shaped timing fact whose `startDate` falls outside a yearly report's
 * own purchased year — a yearly report must never promise a timing window past the year the
 * reader paid for (see ReportDef.isYearly's doc comment). A no-op (returns `scores` unchanged)
 * for every non-yearly report key.
 *
 * Applied to the two places a RankedWindow date appears in `scores`: the top-level `windows`
 * field (marriage/wealth/true_love's own timing-window list) and every
 * `lifeContext.domains[].nextWindow` (all 4 yearly report types carry `lifeContext` via
 * `ReportSharedFacts`). numerology has neither field (its forward-looking data is
 * `monthlyForecast`/`yearlyForecast` — fixed-length tables computed relative to today, not
 * open-ended dated windows — so this clamp is a no-op for it beyond `lifeContext`).
 */
function clampWindowsToYear(scores: ReportScores, window: YearWindow | null): ReportScores {
  if (!window) return scores;
  const inWindow = (dateStr: unknown): boolean =>
    typeof dateStr === 'string' && dateStr >= window.start && dateStr < window.end;

  const out: ReportScores = { ...scores };

  if (Array.isArray(out.windows)) {
    out.windows = out.windows.filter(
      (w) => isRecord(w) && inWindow((w as { startDate?: unknown }).startDate),
    );
  }

  if (isRecord(out.lifeContext) && Array.isArray(out.lifeContext.domains)) {
    const lifeContext = out.lifeContext;
    out.lifeContext = {
      ...lifeContext,
      domains: (lifeContext.domains as unknown[]).map((d) => {
        if (!isRecord(d)) return d;
        const nextWindow = d.nextWindow;
        const keep =
          isRecord(nextWindow) && inWindow((nextWindow as { startDate?: unknown }).startDate);
        return keep ? d : { ...d, nextWindow: null };
      }),
    };
  }

  return out;
}

function computeScoresWithCondition(
  generator: {
    computeScores: (ctx: ReportScoreContext, periodMonth: string | null) => ReportScores;
  },
  ctx: ReportScoreContext,
  periodMonth: string | null,
  reportKey: string,
): ReportScores {
  const scores = generator.computeScores(ctx, periodMonth);
  let planetCondition: string[] = [];
  let planetStrength: PlanetStrengthRow[] = [];
  const vakriFacts: string[] = [];
  try {
    planetCondition = chartConditionFacts(ctx.chart);
    planetStrength = chartPlanetStrength(ctx.chart);
  } catch (err) {
    logger.warn({ err }, 'chart-condition facts failed for report; continuing without them');
  }
  try {
    if (ctx.chart) {
      const vakriAnalyses = analyzeAllVakriPlanets(ctx.chart as never);
      for (const va of vakriAnalyses) {
        vakriFacts.push(...va.factsForLLM);
        vakriFacts.push(
          `VAKRI ${va.planet} interpretation — Classical: ${va.interpretation.classical} | Interpretive: ${va.interpretation.interpretive} | Karmic: ${va.interpretation.karmic} (confidence: ${va.confidence.level})`,
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'vakri facts failed for report; continuing without them');
  }
  // A profile with 'unknown' accuracy holds the midpoint of a part-of-day window,
  // not a time the reader gave, so the Ascendant and every house/varga/dasha date in
  // the facts below is guesswork (see lib/birth-time-window.ts). Reports are the most
  // expensive thing users buy and must not narrate that as certainty. Pushed onto
  // `planetCondition` because that is the one fact channel every narrative call already
  // forwards to reportFactsMessage, and set as its own score key so the separate
  // verdict call — which serialises whatever is on `scores` — picks it up too, without
  // touching all 16 report modules.
  const birthTimeCaveat =
    ctx.personBirthTimeAccuracy === 'unknown'
      ? unknownBirthTimeGuidance(ctx.personTimeOfBirth)
      : null;
  if (birthTimeCaveat) planetCondition = [...planetCondition, birthTimeCaveat];

  // Same treatment for the other person on a compatibility purchase — their unknown
  // time degrades exactly the same results (their ascendant, their houses, their dasha
  // dates), and a matching report that hedges one chart but not the other is worse than
  // one that hedges neither.
  const partnerCaveat =
    ctx.partnerBirthTimeAccuracy === 'unknown'
      ? `PARTNER — ${unknownBirthTimeGuidance(ctx.partnerTimeOfBirth)}`
      : null;
  if (partnerCaveat) planetCondition = [...planetCondition, partnerCaveat];

  return clampWindowsToYear(
    {
      ...scores,
      ...(birthTimeCaveat ? { birthTimeCaveat } : {}),
      ...(partnerCaveat ? { partnerBirthTimeCaveat: partnerCaveat } : {}),
      ...(planetCondition.length > 0 ? { planetCondition } : {}),
      ...(planetStrength.length > 0 ? { planetStrength } : {}),
      ...(vakriFacts.length > 0 ? { vakriFacts } : {}),
    },
    yearWindowFor(reportKey, periodMonth),
  );
}

export async function buildReportScoreContext(
  row: Pick<ReportRow, 'userId' | 'birthProfileId' | 'input'>,
  kundli: KundliRow | null | undefined,
  partnerChart: Record<string, unknown> | null,
): Promise<ReportScoreContext> {
  const personContext = await fetchPersonContext(row.userId, row.birthProfileId);
  const partnerName = typeof row.input?.name === 'string' ? row.input.name : null;
  return {
    chart: kundli?.chartData ?? null,
    partnerChart,
    partnerName,
    partnerTimeOfBirth: typeof row.input?.timeOfBirth === 'string' ? row.input.timeOfBirth : null,
    partnerBirthTimeAccuracy:
      typeof row.input?.timeAccuracy === 'string' ? row.input.timeAccuracy : null,
    doshaData: kundli?.doshaData ?? null,
    yogaData: kundli?.yogaData ?? null,
    ashtakavargaData: kundli?.ashtakavargaData ?? null,
    dashaData: kundli?.dashaData ?? null,
    ...personContext,
    userAnswers: answersFromInput(row.input),
  };
}

/**
 * Background generation for one already-claimed row. Fire-and-forget from
 * the purchase route — never awaited in the request/response cycle. Any
 * failure along this path (no chart yet, no registered generator for this
 * key, a bad partner birth record, the LLM call itself failing) is treated
 * uniformly: mark the row `failed` with a clear error and refund THIS row's
 * price share. This is the safety net documented on REPORT_GENERATORS — a
 * report key with no registered generator fails exactly the same way as any
 * other generation failure, never crashing the process.
 */
/**
 * Generates a plain-English one-liner per timing window found anywhere in `scores` (by shape,
 * not by an assumed field name — see `findRankedWindowsField`), for the "why is this window
 * rated this way" explanation shown in place of `RankedWindow.reasoning`'s raw internal debug
 * text (see window-summary.ts's module doc comment). One LLM call at generation time only — this
 * MUST NOT run in `recomputeScoresForRead`, which fires on every page view.
 *
 * Returns `null` (nothing to persist) when `scores` has no timing-window field at all. Never
 * throws: a failed/malformed LLM call degrades to a persisted empty `summaries` array rather than
 * failing the whole report — a missing one-line explanation is a much smaller loss than losing
 * the report's narrative and refunding the purchase over a non-essential enrichment call.
 */
/**
 * Records this report's dated timing windows as falsifiable predictions.
 *
 * Only windows go in — a report's character description ("you are drawn to
 * detail work") is not scoreable, so recording it would just dilute the hit
 * rate with claims nobody can mark right or wrong. A window has a start date, an
 * end date and a confidence band the engine committed to in advance, which is
 * exactly what is needed to ask "did that happen?" later and to find out whether
 * HIGH really does beat LOW.
 *
 * `techniques` names the systems that fed the claim so accuracy can eventually
 * be attributed — the point of the exercise is being able to say WHICH parts of
 * the engine are earning their place.
 */
async function recordReportPredictions(
  row: ReportRow,
  scores: ReportScores,
  ctx: ReportScoreContext,
): Promise<void> {
  const found = findRankedWindowsField(scores);
  if (!found || found.windows.length === 0) return;

  const techniques = ['vimshottari', 'dasha_confidence'];
  if (Array.isArray((scores as { planetCondition?: unknown }).planetCondition)) {
    techniques.push('shadbala', 'avastha', 'bhava_chalit');
  }

  const facts = (scores as { planetCondition?: string[] }).planetCondition ?? null;

  for (const w of found.windows) {
    await recordPrediction({
      userId: row.userId,
      birthProfileId: row.birthProfileId,
      surface: 'report',
      sourceId: row.id,
      domain: row.reportKey,
      claim: `${row.reportKey}: ${found.field} window (${w.dashaLevel}) rated ${w.level}`,
      windowStart: w.startDate,
      windowEnd: w.endDate,
      confidence: w.level,
      facts,
      model: MODEL,
      techniques,
    });
  }

  logger.info(
    { reportId: row.id, captured: found.windows.length },
    'prediction capture: report windows recorded',
  );
  void ctx; // reserved: chart-level attribution once per-chart accuracy is wanted
}

async function computeWindowSummaries(
  scores: Record<string, unknown>,
): Promise<{ field: string; summaries: string[] } | null> {
  const found = findRankedWindowsField(scores);
  if (!found) return null;

  try {
    const summaries = await summarizeTimingWindows(found.windows);
    return { field: found.field, summaries };
  } catch (err) {
    logger.warn({ err }, 'timing-window summary generation failed, continuing without it');
    return { field: found.field, summaries: [] };
  }
}

/**
 * One shared "Final Verdict" card per report, generation-time only — same never-throws,
 * generation-only contract as `computeWindowSummaries` above (this MUST NOT run in
 * `recomputeScoresForRead`, which fires on every page view). Returns `null` (nothing to
 * persist) on any failure — losing the closing summary card is a much smaller loss than
 * failing the whole report over a non-essential enrichment call.
 */
async function computeReportVerdict(
  scores: Record<string, unknown>,
  reportKey: ReportKey,
  periodMonth: string | null,
): Promise<ReportVerdict | null> {
  try {
    return await generateReportVerdict(scores, reportKey, yearWindowFor(reportKey, periodMonth));
  } catch (err) {
    logger.warn({ err }, 'report verdict generation failed, continuing without it');
    return null;
  }
}

async function runReportGeneration(row: ReportRow, birthProfileId: string | null): Promise<void> {
  const claimedAt = row.startedAt;
  if (!claimedAt) return; // claimReportRow always sets this when it returns a row — defensive only.

  try {
    const generator = REPORT_GENERATORS[row.reportKey as ReportKey];
    if (!generator) {
      throw new Error(`No generator registered for report key "${row.reportKey}"`);
    }

    const kundli = await findKundliByUserId(row.userId, birthProfileId);
    if (!kundli || kundli.status !== 'ready' || !kundli.chartData) {
      throw new Error('Birth chart is not ready yet');
    }

    let partnerChart: Record<string, unknown> | null = null;
    if (hasPartnerBirthInput(row.input)) {
      const metrology = await computeMetrology(partnerInputToBirthRecord(row.input));
      partnerChart = (metrology.chart as Record<string, unknown> | undefined) ?? null;
    }

    const scoreContext = await buildReportScoreContext(row, kundli, partnerChart);
    const scores = computeScoresWithCondition(
      generator,
      scoreContext,
      row.periodMonth,
      row.reportKey,
    );

    // Resume hint for a reclaimed row (a previous attempt's checkpoint — see
    // saveReportProgress) — empty on a brand-new claim, since `content` is null until the
    // first successful write. A generator that doesn't support checkpointed retry (most of
    // them — see generateNarrative's own doc comment) simply ignores this and regenerates
    // everything, which is still correct, just not cost-optimized.
    const existingGroups =
      (row.content as { sectionGroups?: ReportSection[][] } | null)?.sectionGroups ?? [];
    let persistedGroups: ReportSection[][] = [...existingGroups];
    const progress: SectionGenerationProgress = {
      existingGroups,
      onGroupComplete: async (group) => {
        // A fresh array each call, not a push onto a shared reference — saveReportProgress's
        // real (DB) implementation serializes synchronously so this wouldn't be reachable in
        // production either way, but reassigning keeps each call's argument independently
        // correct and observable rather than relying on that ordering.
        persistedGroups = [...persistedGroups, group];
        await saveReportProgress(row.id, claimedAt, persistedGroups);
      },
    };
    const generated = await generator.generateNarrative(scores, 'en', progress);
    // Second pass: drop any sentence that contradicts this report's own facts.
    // Fails open — see verifyReportClaims.
    const { sections } = await verifyReportClaims(
      generated,
      (scores as { planetCondition?: string[] }).planetCondition ?? [],
    ).catch(() => ({ sections: generated, dropped: 0 }));
    const windowSummaries = await computeWindowSummaries(scores);
    const verdict = await computeReportVerdict(scores, row.reportKey as ReportKey, row.periodMonth);

    // Every dated timing window this report just promised, recorded so it can
    // later be scored against what actually happened. Best-effort: capture must
    // never fail a report the user has already paid for.
    await recordReportPredictions(row, scores, scoreContext).catch((err: unknown) => {
      logger.warn({ err, reportId: row.id }, 'prediction capture failed, report unaffected');
    });

    await markReportReady(row.id, claimedAt, {
      content: {
        sections,
        contentVersion: CONTENT_VERSION,
        ...(windowSummaries ? { windowSummaries } : {}),
        ...(verdict ? { verdict } : {}),
      },
      model: MODEL,
      // Provenance snapshot, frozen at generation time — see the `chartSnapshot` doc comment
      // in schema.ts for why this must never be re-derived from the (possibly since-changed)
      // live kundli. `kundli` here is the exact row this report's facts were computed from.
      chartSnapshot: {
        chartData: kundli.chartData,
        dashaData: kundli.dashaData,
        yogaData: kundli.yogaData,
        doshaData: kundli.doshaData,
      },
      calculationVersion: kundli.calculationVersion,
      ephemerisVersion: kundli.ephemerisVersion,
      ayanamsa: kundli.ayanamsa,
      houseSystem: kundli.houseSystem,
      nodeType: kundli.nodeType,
      promptVersion: REPORT_PROMPT_VERSION,
      language: 'en',
    });
    void notifyReportReady(row.userId, row.reportKey, row.id).catch(() => {
      /* already logged */
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, reportId: row.id, reportKey: row.reportKey, attempt: row.generationAttempts },
      'report background generation failed',
    );
    await failOrRequeueReport(row, claimedAt, message);
  }
}

/** How long a failed attempt waits before the queue will pick it up again:
 * 1 minute, then 2, then 4. Deliberately longer than a bare retry — most real
 * failures here are a rate-limited or exhausted Gemini key, and hammering it
 * immediately just burns the next key in the pool too. Nothing polls this
 * directly; the pump reads `nextAttemptAt` and the 5-minute reaper cron is what
 * guarantees a backed-off row is eventually looked at again. */
function retryBackoffMs(attempt: number): number {
  return 60_000 * 2 ** Math.max(0, attempt - 1);
}

/**
 * A generation attempt failed. Under the retry budget this puts the row BACK on
 * the queue (keeping whatever the generator checkpointed, and keeping the user's
 * money) rather than failing it outright — a transient Gemini 503 or an exhausted
 * key used to burn a paid report on the first try, since only the crash/stall path
 * ever got retried. Past the budget it falls back to the original behaviour: mark
 * failed and refund.
 *
 * Fenced on `claimedAt` throughout, so a row another worker has already taken over
 * is never failed or refunded from here.
 */
async function failOrRequeueReport(
  row: ReportRow,
  claimedAt: Date,
  message: string,
): Promise<void> {
  // generationAttempts is incremented by claimQueuedReports when the row is pulled,
  // so it already counts the attempt that just failed.
  if (row.generationAttempts < MAX_REPORT_GENERATION_ATTEMPTS) {
    const nextAttemptAt = new Date(Date.now() + retryBackoffMs(row.generationAttempts));
    const requeued = await requeueReportForRetry(row.id, claimedAt, nextAttemptAt);
    if (requeued) {
      logger.warn(
        { reportId: row.id, attempt: row.generationAttempts, nextAttemptAt },
        'report generation requeued for retry',
      );
      return;
    }
    // Lost the fence — something else (the reaper, a repeat purchase) already moved
    // this row on. Not ours to fail or refund.
    return;
  }

  await markReportFailed(row.id, claimedAt, message);
  await addWalletBalance(
    row.userId,
    row.pricePaidPaise,
    `refund:${reasonForRow(row.reportKey, row.periodMonth)}`,
  ).catch((refundErr: unknown) =>
    logger.error({ err: refundErr, reportId: row.id }, 'report generation refund failed'),
  );
}

// -----------------------------------------------------------------------------
// The generation queue
// -----------------------------------------------------------------------------
// Purchasing a report no longer starts generating it. `claimReportRow` inserts
// the row at status 'queued' and this pump promotes rows to 'generating' only
// while the process is under REPORT_QUEUE_CONCURRENCY. Three things drive the
// pump, and none of them is a timer — matching the rest of this codebase, where
// periodic work is the OS crontab's job:
//
//   1. a purchase/preview, so the common case (a free slot) still starts
//      instantly and the buyer sees no added latency;
//   2. every generation finishing, success or failure, which drains the backlog
//      as fast as capacity actually frees up;
//   3. POST /cron/reports-reap-stale every 5 minutes, the safety net that
//      restarts a pump that stopped with work still queued — an all-slots-busy
//      moment followed by every generation dying at once, or a row parked on a
//      retry backoff whose `nextAttemptAt` has since passed.
//
// The cap is per PROCESS, so with pm2 running N instances the real ceiling is
// N x REPORT_QUEUE_CONCURRENCY. That is deliberate: the DB claim
// (claimQueuedReports, FOR UPDATE SKIP LOCKED) is what guarantees correctness
// across processes, and a counter is all that is needed on top of it.
// ponytail: per-process cap. If a true global ceiling is ever needed, the Redis
// client and lock helper in lib/cache/locks.ts already exist to hold one.
// -----------------------------------------------------------------------------

/**
 * What clients are allowed to see. 'queued' is an internal scheduling detail —
 * to the app "bought, nothing to show yet" and "actively being written" are the
 * same 202-poll state, and the public response schemas (reports.schemas.ts) only
 * ever declare three statuses. Mapping here rather than widening those schemas
 * keeps the queue invisible to the frontend and the mobile shell, which need no
 * change for any of this.
 */
function publicStatus(status: ReportRow['status']): 'generating' | 'ready' | 'failed' {
  return status === 'queued' ? 'generating' : status;
}

let reportsInFlight = 0;

/** Slots free in THIS process right now. Also read by the lazy-regeneration
 * trigger, which shares the same LLM budget without owning a queue row. */
function reportQueueCapacity(): number {
  return Math.max(0, env.REPORT_QUEUE_CONCURRENCY - reportsInFlight);
}

/**
 * Claim whatever runnable queued rows fit in this process's free slots and run
 * them; re-pump as each one finishes so the backlog drains without a timer.
 *
 * Never throws and never blocks its caller — a purchase must not fail because
 * the queue read did, and the 5-minute reaper cron will pump again regardless.
 */
export function pumpReportQueue(): void {
  const capacity = reportQueueCapacity();
  if (capacity === 0) return;

  void claimQueuedReports(capacity)
    .then((rows) => {
      for (const row of rows) {
        reportsInFlight++;
        // Every report type shares one `report` LLM profile, so without a feature
        // label all 10+ of them land in ai_usage as one indistinguishable `report`
        // row and per-report cost is unrecoverable. Set explicitly from the row
        // rather than inherited, since this always runs detached from the request
        // that queued it (and from no request at all, under the reaper cron).
        void runWithRequestContext({ userId: row.userId, feature: row.reportKey }, () =>
          runReportGeneration(row, row.birthProfileId),
        )
          .catch((err: unknown) => {
            // runReportGeneration handles its own failures (retry or fail+refund);
            // reaching here means the handling itself broke, so the row is left for
            // the stale reaper rather than retried inline.
            logger.error(
              { err, reportId: row.id },
              'report background generation errored unexpectedly',
            );
          })
          .finally(() => {
            reportsInFlight--;
            pumpReportQueue();
          });
      }
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'report queue pull failed');
    });
}

export interface PurchaseReportResult {
  reports: PurchasedReportSummaryDto[];
}

export async function purchaseReport(
  user: UserRow,
  body: PurchaseReportBody,
): Promise<PurchaseReportResult> {
  const def = getReportDef(body.reportKey);
  if (!def) throw Errors.notFound(`Unknown report key: ${body.reportKey}`);

  const features = await resolveFeaturesForUser(user.id);
  if (features[def.featureFlagKey]?.enabled === false) {
    throw Errors.forbidden('FEATURE_DISABLED');
  }

  purchaseReportShapeCheck(def, body);

  // strict: body.birthProfileId is client-supplied for THIS request — a
  // non-owned/deleted id must 404, not silently substitute the caller's
  // primary profile (see resolveProfileContext's doc comment).
  const profile = await resolveProfileContext(user, body.birthProfileId ?? null, { strict: true });
  const birthProfileId = profile.birthProfileId;

  const perUnitPricePaise = features[def.featureFlagKey]?.pricePaise ?? def.basePricePaise;
  const months = body.months ?? [];
  // Yearly (isYearly) reports are a single flat-price row like a one-time report — see
  // ReportDef.isYearly's doc comment — except `periodMonth` is set to TODAY (the purchase/
  // generation date) instead of staying null, so its 1-year validity window and its
  // once-a-year repurchase dedupe both fall out of the existing (userId, reportKey,
  // periodMonth) unique indexes for free.
  const periodMonths: (string | null)[] = def.isMonthly
    ? months.map(monthKeyToDate)
    : [def.isYearly ? todayForApp() : null];
  const rowPrices = computeRowPrices(def, perUnitPricePaise, periodMonths.length);
  const totalPricePaise = rowPrices.reduce((a, b) => a + b, 0);
  const partnerInput =
    def.requiresPartner || def.acceptsOptionalPartner
      ? ((body.partner as unknown as Record<string, unknown>) ?? null)
      : null;
  const purchaseReason = reasonForPurchase(def.key, months);
  const answers = body.answers && Object.keys(body.answers).length > 0 ? body.answers : null;

  const charged = await deductWalletBalance(user.id, totalPricePaise, purchaseReason);
  if (!charged) throw Errors.conflict('INSUFFICIENT_CREDITS');

  const summaries: PurchasedReportSummaryDto[] = [];
  let processedCount = 0;

  try {
    for (let i = 0; i < periodMonths.length; i++) {
      const periodMonth = periodMonths[i] ?? null;
      const rowPrice = rowPrices[i] ?? 0;
      const input = withAnswers(partnerInput, answers);

      // Yearly reports: the exact-periodMonth unique index below only blocks a same-DAY
      // repeat purchase — it would happily insert a SECOND row for a different day even
      // while last year's report is still active. Check for an active one first and
      // reuse+refund exactly like the existing-row branch further down, rather than double-
      // charging for a report the reader already owns for the next several months.
      if (def.isYearly) {
        const active = await findActiveYearlyReportRow(
          user.id,
          birthProfileId,
          def.key,
          periodMonth as string,
        );
        if (active) {
          summaries.push({
            id: active.id,
            reportKey: def.key,
            periodMonth: active.periodMonth,
            status: publicStatus(active.status),
          });
          await addWalletBalance(
            user.id,
            rowPrice,
            `refund:${reasonForRow(def.key, periodMonth)}`,
          ).catch(() => {});
          processedCount = i + 1;
          continue;
        }
      }

      const claimed = await claimReportRow({
        userId: user.id,
        birthProfileId,
        reportKey: def.key,
        periodMonth,
        input,
        pricePaidPaise: rowPrice,
        isPreview: false,
      });

      if (claimed) {
        summaries.push({
          id: claimed.id,
          reportKey: def.key,
          periodMonth: claimed.periodMonth,
          status: publicStatus(claimed.status),
        });
      } else {
        // A row already exists at this exact identity that claimReportRow's own claimability
        // guard couldn't reclaim — the DB layer guaranteed no duplicate row was ever inserted
        // (see claimReportRow's doc comment). Two distinct cases land here. Partner/compatibility
        // reports (input !== null) have no periodMonth dimension and dedupe on input hash instead
        // of (birthProfileId, periodMonth) — see findReportRowByInputHash.
        const existing =
          input !== null
            ? await findReportRowByInputHash(
                user.id,
                birthProfileId,
                def.key,
                hashReportInput(input),
              )
            : await findReportRow(user.id, birthProfileId, def.key, periodMonth);
        if (existing?.isPreview) {
          // Preview-to-purchase upgrade: this row started life as a free preview (see
          // previewReport) — do NOT refund, the user is genuinely paying for it right now.
          // Flip it to a real purchase in place; its content/status are untouched (almost
          // always already 'ready' from the preview generation, so the buyer gets it
          // instantly — no new generation call needed here).
          await upgradePreviewToPurchased(existing.id, rowPrice);
          summaries.push({
            id: existing.id,
            reportKey: def.key,
            periodMonth: existing.periodMonth,
            status: publicStatus(existing.status),
          });
        } else {
          // Genuinely already purchased & ready/in-flight for this exact identity — reuse it
          // and refund this row's share rather than double-charging.
          if (existing) {
            summaries.push({
              id: existing.id,
              reportKey: def.key,
              periodMonth: existing.periodMonth,
              status: publicStatus(existing.status),
            });
          }
          await addWalletBalance(
            user.id,
            rowPrice,
            `refund:${reasonForRow(def.key, periodMonth)}`,
          ).catch(() => {});
        }
      }
      processedCount = i + 1;
    }
  } catch (err) {
    // A DB error inserting/claiming a row this purchase hadn't reached yet — refund exactly
    // the unprocessed rows' share (rows already claimed/refunded above keep their own outcome).
    const unrefunded = rowPrices.slice(processedCount).reduce((a, b) => a + b, 0);
    if (unrefunded > 0) {
      await addWalletBalance(user.id, unrefunded, `refund:${purchaseReason}`).catch(() => {});
    }
    throw err;
  }

  // One pump for the whole purchase, not one per row: a 12-month bundle queues 12
  // rows and this starts however many the process has slots for, leaving the rest
  // for the pump each finishing generation fires.
  pumpReportQueue();

  return { reports: summaries };
}

/**
 * Free "generate the real report and blur it" preview — sibling to
 * `purchaseReport`, but billed at 0 and flagged `isPreview: true`. The
 * generation pipeline itself needs ZERO changes: a preview runs through the
 * exact same queued-and-pumped background path as a real purchase, so
 * the report content is genuinely real (not a fake teaser) — the client is
 * expected to blur/paywall it client-side using the `isPreview` flag
 * `getReportForUser` returns once ready.
 *
 * Not supported for `kundli_milan`/`match_report` (`def.requiresPartner`) —
 * there's no partner data yet at preview time, so there's nothing to preview
 * against. Always a single one-time row (`periodMonth: null`, `input: null`)
 * regardless of report type — previews never take a monthly bundle shape.
 *
 * Idempotent and free on repeat taps: if `claimReportRow` signals a collision
 * (a row already exists at this identity — a prior preview, an in-flight
 * generation, or even a real purchase), this simply looks the row up and
 * returns its current state rather than erroring or double-claiming.
 */
export async function previewReport(
  user: UserRow,
  body: PreviewReportBody,
): Promise<PreviewReportResponseDto> {
  const def = getReportDef(body.reportKey);
  if (!def) throw Errors.notFound(`Unknown report key: ${body.reportKey}`);

  if (def.requiresPartner) {
    throw Errors.badRequest(`${def.key} does not support preview — no partner data exists yet`);
  }

  // strict — see the matching comment in purchaseReport above.
  const profile = await resolveProfileContext(user, body.birthProfileId ?? null, { strict: true });
  const birthProfileId = profile.birthProfileId;

  const claimed = await claimReportRow({
    userId: user.id,
    birthProfileId,
    reportKey: def.key,
    periodMonth: null,
    input: null,
    pricePaidPaise: 0,
    isPreview: true,
  });

  if (claimed) {
    pumpReportQueue();
    return { id: claimed.id, reportKey: def.key, status: publicStatus(claimed.status) };
  }

  // A row already exists at this identity (prior preview still generating/ready, or a real
  // purchase) — repeat preview taps are idempotent and free, just return its current state.
  const existing = await findReportRow(user.id, birthProfileId, def.key, null);
  if (!existing) {
    // Defensive only: claimReportRow's own doc guarantees a row exists whenever it returns
    // undefined — this would indicate the row was deleted between the two calls.
    throw Errors.internal('Report row not found after a duplicate preview claim');
  }
  return { id: existing.id, reportKey: def.key, status: publicStatus(existing.status) };
}

/**
 * The user's own past reports across ALL types, newest first — reuses the exact same
 * `listReportsForUser` query `getReportCatalogueForUser` already runs (which then discards this
 * flat, cross-type ordering by re-grouping rows per catalogue entry into `purchases`). Excludes
 * preview rows (`isPreview`) since those were never actually purchased.
 */
export async function getReportHistoryForUser(
  userId: string,
  birthProfileId: string | null,
): Promise<ReportHistoryEntryDto[]> {
  const rows = await listReportsForUser(userId, birthProfileId);
  return rows
    .filter((r) => !r.isPreview)
    .map((r) => ({
      id: r.id,
      reportKey: r.reportKey,
      label: getReportDef(r.reportKey as ReportKey)?.label ?? r.reportKey,
      status: publicStatus(r.status),
      periodMonth: r.periodMonth,
      createdAt: r.createdAt.toISOString(),
    }));
}

export async function getReportCatalogueForUser(
  user: UserRow,
  birthProfileId: string | null,
): Promise<ReportCatalogueEntryDto[]> {
  const [features, rows] = await Promise.all([
    resolveFeaturesForUser(user.id),
    listReportsForUser(user.id, birthProfileId),
  ]);

  const now = new Date();
  return REPORT_CATALOGUE.map((def) => {
    const resolved = features[def.featureFlagKey];
    const enabled = resolved?.enabled ?? true;
    const ownRows = rows.filter((r) => r.reportKey === def.key);
    // Any report that can carry partner birth details has a "last spouse details" concept to
    // pre-fill the purchase form with — marriage (optional) and progeny (required) today.
    const lastPartnerRow =
      def.acceptsOptionalPartner || def.requiresPartner
        ? ownRows
            .filter((r) => hasPartnerBirthInput(r.input))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
        : undefined;
    return {
      key: def.key,
      label: def.label,
      isMonthly: def.isMonthly,
      isYearly: def.isYearly ?? false,
      requiresPartner: def.requiresPartner,
      enabled,
      isNew: computeIsNewReport(enabled, resolved?.enabledAt ?? null, now),
      pricePaise: resolved?.pricePaise ?? def.basePricePaise,
      // No fallback to basePricePaise here — an unconfigured original price
      // means there's no discount to show, not a fabricated one.
      originalPricePaise: resolved?.originalPricePaise ?? null,
      purchases: ownRows.map((r) => ({
        id: r.id,
        periodMonth: r.periodMonth,
        status: publicStatus(r.status),
      })),
      lastSpouseDetails: lastPartnerRow
        ? {
            dateOfBirth: lastPartnerRow.input!.dateOfBirth as string,
            timeOfBirth: lastPartnerRow.input!.timeOfBirth as string,
            latitude: lastPartnerRow.input!.latitude as number,
            longitude: lastPartnerRow.input!.longitude as number,
            timezone: lastPartnerRow.input!.timezone as string,
            name: (lastPartnerRow.input!.name as string | undefined) ?? undefined,
            placeLabel: (lastPartnerRow.input!.placeLabel as string | undefined) ?? undefined,
          }
        : null,
    };
  });
}

async function recomputeScoresForRead(row: ReportRow): Promise<Record<string, unknown>> {
  const generator = REPORT_GENERATORS[row.reportKey as ReportKey];
  if (!generator) return {};

  const kundli = await findKundliByUserId(row.userId, row.birthProfileId);

  let partnerChart: Record<string, unknown> | null = null;
  if (hasPartnerBirthInput(row.input)) {
    try {
      const metrology = await computeMetrology(partnerInputToBirthRecord(row.input));
      partnerChart = (metrology.chart as Record<string, unknown> | undefined) ?? null;
    } catch (err) {
      logger.warn({ err, reportId: row.id }, 'failed to recompute partner chart on read');
    }
  }

  const scoreContext = await buildReportScoreContext(row, kundli, partnerChart);
  return computeScoresWithCondition(generator, scoreContext, row.periodMonth, row.reportKey);
}

/** Same JSON.stringify+sha256 idiom as hashLeafValues (report-scores.ts) and
 * reports.repo.ts's hashReportInput, applied to the English narrative — see
 * withTranslatedSections' cache-key comment for why this exists. Exported
 * only so tests can compute a matching hash for cache fixtures. */
export function hashSections(sections: ReportSection[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(sections)).digest('hex');
}

/**
 * Overlays translated prose onto `scores` for the small, explicit allowlist
 * of dot-paths this report type carries (see SCORES_PROSE_ALLOWLIST) — every
 * other field in `scores` is untouched. Cache-checked against the row's
 * existing `translations[language].scoresProse` by content hash (since
 * `scores` is recomputed fresh every read, not persisted — see
 * recomputeScoresForRead); a hash match splices the cached translation back
 * in with zero LLM calls, a miss pays one round-trip and re-caches. Never
 * throws — any failure (translation error, mismatched response) logs and
 * returns `scores` unmodified, same discipline as the sections translation
 * below.
 */
async function withTranslatedScoresProse(
  row: ReportRow,
  scores: Record<string, unknown>,
  language: string,
): Promise<Record<string, unknown>> {
  const paths = SCORES_PROSE_ALLOWLIST[row.reportKey];
  if (!paths) return scores;

  const leaves = extractScoresProse(scores, paths);
  if (leaves.length === 0) return scores;

  const hash = hashLeafValues(leaves);
  const cached = row.translations?.[language]?.scoresProse as
    | { hash?: string; values?: string[] }
    | undefined;
  if (cached?.hash === hash && cached.values) {
    return spliceScoresProse(scores, leaves, cached.values);
  }

  try {
    const values = await translateScoresProse(
      leaves.map((l) => l.value),
      language,
    );
    await saveReportScoresTranslation(row.id, language, { hash, values });
    return spliceScoresProse(scores, leaves, values);
  } catch (err) {
    logger.warn({ err, reportId: row.id, language }, 'failed to translate report scores prose');
    return scores;
  }
}

/**
 * The report DTO in the requested language — mirrors gemstone's
 * toGemstoneReportDtoForLanguage translate-on-read pattern exactly: `scores`
 * are ALWAYS recomputed fresh from the live chart (never trusted from the
 * persisted row, see recomputeScoresForRead), English sections return
 * as-is, and any other language checks `translations[language]` first,
 * falling back to a single LLM translation call (cached after) and finally
 * to the English narrative if translation itself fails. A small allowlisted
 * subset of `scores` itself is ALSO translated for report types listed in
 * SCORES_PROSE_ALLOWLIST — see withTranslatedScoresProse above.
 */
export async function getReportForUser(
  id: string,
  userId: string,
  language: string,
): Promise<ReportDto> {
  const row = await findReportById(id);
  // 404, not 403, on a row that exists but belongs to someone else — avoids leaking existence.
  if (!row || row.userId !== userId) throw Errors.notFound('Report not found');

  // 'queued' included: a bought-but-not-yet-started row is a 202-poll for the client,
  // exactly like one mid-generation. Also keeps this ahead of the ready/failed branches
  // so a queued row never falls through to the content path with null content.
  if (row.status === 'queued' || row.status === 'generating') return { status: 'generating' };
  // Keep the raw provider error in the DB column for ops/debugging, but never
  // echo it verbatim to the client — it can contain API key fragments or
  // internal stack details. The refund (if any) is handled by the background
  // job's failure path and the stale-row reaper cron; this response just
  // surfaces a safe user-facing message.
  if (row.status === 'failed')
    return {
      status: 'failed',
      error: 'Report generation failed. Any amount charged has been automatically refunded.',
    };

  // row.status is 'ready' past this point (generating/failed both returned above). Fire-and-forget:
  // this request still serves the CURRENT (possibly stale) content immediately below; the
  // regenerated content lands in time for the owner's next view. See CONTENT_VERSION's doc comment.
  triggerLazyRegenerationIfStale(row);

  const recomputedScores = await recomputeScoresForRead(row);
  const content = (row.content ?? {}) as {
    sections?: ReportSection[];
    windowSummaries?: PersistedWindowSummaries;
    verdict?: ReportVerdict;
    contentVersion?: number;
  };
  const scoresWithWindows = spliceWindowSummaries(recomputedScores, content.windowSummaries);
  // `verdict` is generation-time-only (see computeReportVerdict's doc comment) — merged straight
  // onto the freshly-recomputed `scores` here, same as windowSummaries, rather than recomputed.
  const englishScores = content.verdict
    ? { ...scoresWithWindows, verdict: content.verdict }
    : scoresWithWindows;
  const englishSections = assignSectionIds(row.reportKey, content.sections ?? []);
  const generator = REPORT_GENERATORS[row.reportKey as ReportKey];

  if (language === 'en' || !generator) {
    return {
      status: 'ready' as const,
      reportKey: row.reportKey,
      periodMonth: row.periodMonth,
      scores: englishScores,
      isPreview: row.isPreview,
      sections: englishSections,
    };
  }

  let scores = await withTranslatedScoresProse(row, englishScores, language);
  if (content.verdict) {
    const cachedVerdict = row.translations?.[language]?.verdict as ReportVerdict | undefined;
    if (cachedVerdict) {
      scores = { ...scores, verdict: cachedVerdict };
    } else {
      try {
        const translatedVerdict = await translateReportVerdict(content.verdict, language);
        await saveReportTranslation(row.id, language, { verdict: translatedVerdict });
        scores = { ...scores, verdict: translatedVerdict };
      } catch (err) {
        logger.warn({ err, reportId: row.id, language }, 'failed to translate report verdict');
      }
    }
  }
  const readyBase = {
    status: 'ready' as const,
    reportKey: row.reportKey,
    periodMonth: row.periodMonth,
    scores,
    isPreview: row.isPreview,
  };

  const sections = await withTranslatedSections(row, englishSections, generator, language);
  return { ...readyBase, sections };
}

/**
 * Translated narrative sections, cached by content hash rather than just
 * language — `translations[language].sections` used to be keyed on language
 * alone, so any write path that updates `content.sections` without also
 * clearing `translations` (see markReportReady's reset, reports.repo.ts)
 * would serve a stale translation forever. Same `{hash, values}` shape and
 * cache-check-by-hash pattern withTranslatedScoresProse already uses for
 * `scoresProse`, generalized to the narrative — a hash mismatch (content
 * changed) is treated exactly like a cache miss: pay one translation call,
 * re-cache under the new hash.
 */
async function withTranslatedSections(
  row: ReportRow,
  englishSections: ReportSection[],
  generator: ReportGenerator,
  language: string,
): Promise<ReportSection[]> {
  const hash = hashSections(englishSections);
  const cached = row.translations?.[language] as
    | { sections?: { hash?: string; values?: ReportSection[] } }
    | undefined;
  if (cached?.sections?.hash === hash && cached.sections.values) {
    return assignSectionIds(row.reportKey, cached.sections.values);
  }

  try {
    const translated = await generator.translateNarrative(englishSections, language);
    await saveReportTranslation(row.id, language, { sections: { hash, values: translated } });
    return assignSectionIds(row.reportKey, translated);
  } catch (err) {
    logger.warn({ err, reportId: row.id, language }, 'failed to translate report');
    return englishSections;
  }
}

/** How many generation attempts the SAME row gets before it is given up on and refunded —
 * bounds automatic retry so a permanently-broken generation (bad chart data, a prompt that
 * always fails) eventually stops rather than looping forever. Counted by
 * `generationAttempts`, which claimQueuedReports increments on every pull, so it now covers
 * BOTH failure modes: a generation that threw (failOrRequeueReport) and one whose process
 * died mid-run (reapStaleReports). Deliberately small:
 * a resumable generator (marriage/numerology/true_love) only re-pays for whichever call
 * failed last time, so a low ceiling is cheap; a non-resumable one re-pays for the whole
 * report each attempt, so it shouldn't be high either. */
export const MAX_REPORT_GENERATION_ATTEMPTS = 3;

/**
 * Periodic sweep for rows abandoned mid-generation — the Node process crashed
 * or was killed after `claimQueuedReports` promoted the row but before
 * `markReportReady`/`markReportFailed`. This is the ONLY failure mode the row
 * itself cannot recover from, because the code that would have requeued it died
 * with the process.
 *
 * Driven by the OS crontab hitting POST /cron/reports-reap-stale every 5
 * minutes (see cron.routes.ts) rather than an in-process timer, matching every
 * other periodic job in this codebase. Never throws — a failure reaping one row
 * is logged and the sweep continues with the rest.
 *
 * Under MAX_REPORT_GENERATION_ATTEMPTS a stale row goes back to 'queued'
 * (`retried`) instead of being re-fired directly, so it re-enters through the
 * same capacity-gated pump as everything else — a crash that stranded ten rows
 * no longer restarts ten generations at once. Whatever the dead attempt
 * checkpointed via saveReportProgress is kept, so a resumable generator picks up
 * where it stopped rather than re-paying for the whole report. At or past the
 * ceiling, unchanged: mark failed and refund (`reaped`).
 *
 * Always ends by pumping, which is what makes this the safety net for a queue
 * that stalled with runnable rows still on it (see the pump's own comment).
 */
export async function reapStaleReports(): Promise<{ reaped: number; retried: number }> {
  const staleRows = await findStaleGeneratingReports();
  let reaped = 0;
  let retried = 0;

  for (const row of staleRows) {
    if (!row.startedAt) continue; // claimQueuedReports always stamps 'generating' rows with startedAt — defensive only.
    try {
      if (row.generationAttempts < MAX_REPORT_GENERATION_ATTEMPTS) {
        // Runnable immediately: the row already paid its wait by sitting stale for
        // REPORT_STALE_GENERATING_MS, so no extra backoff on top.
        const requeued = await requeueReportForRetry(row.id, row.startedAt, new Date());
        if (requeued) retried++;
        // Lost the race (already reclaimed/finished by something else, e.g. a repeat
        // purchase) — nothing to do, it's no longer this sweep's problem either way.
        continue;
      }

      await markReportFailed(
        row.id,
        row.startedAt,
        `Generation timed out (stale) after ${MAX_REPORT_GENERATION_ATTEMPTS} retries`,
      );
      await addWalletBalance(
        row.userId,
        row.pricePaidPaise,
        `refund:${reasonForRow(row.reportKey, row.periodMonth)}`,
      ).catch((refundErr: unknown) =>
        logger.error({ err: refundErr, reportId: row.id }, 'stale report reap refund failed'),
      );
      reaped++;
    } catch (err) {
      logger.error({ err, reportId: row.id, reportKey: row.reportKey }, 'stale report reap failed');
    }
  }

  // The safety-net pump: picks up rows this sweep just requeued, plus anything
  // stranded since the last one (a retry whose backoff has expired, or a queue
  // that stalled because every in-flight generation died at the same moment).
  pumpReportQueue();

  return { reaped, retried };
}

/**
 * Module-level cache for `getReportStats` — this is a public, cross-user
 * aggregate ("1,926 reports generated") that changes slowly and is read on
 * every page load, so it's not worth hitting the DB every time. No existing
 * cache utility fits this in the codebase; a plain `{ data, expiresAt }`
 * variable is deliberately as simple as this gets. Not safe across multiple
 * processes (each pm2/cluster worker keeps its own cache), which is fine for
 * a slow-moving social-proof number — same tradeoff as any other in-process
 * cache in this codebase.
 */
const REPORT_STATS_CACHE_TTL_MS = 5 * 60_000;
let reportStatsCache: { data: ReportStatsDto; expiresAt: number } | null = null;

/**
 * Public social-proof counts — `{ [reportKey]: readyCount }` of `ready`,
 * non-preview reports, aggregated across ALL users (not scoped to the
 * caller — there is no user-specific data in an aggregate count). Cached for
 * REPORT_STATS_CACHE_TTL_MS to avoid a DB hit on every page load.
 */
export async function getReportStats(): Promise<ReportStatsDto> {
  const now = Date.now();
  if (reportStatsCache && reportStatsCache.expiresAt > now) {
    return reportStatsCache.data;
  }

  const rows = await countReadyReportsByKey();
  const data: ReportStatsDto = {};
  for (const row of rows) {
    // ponytail: +25 flat social-proof padding per report key, requested by product. Raise/remove here if the ask changes.
    data[row.reportKey] = row.count + 25;
  }

  reportStatsCache = { data, expiresAt: now + REPORT_STATS_CACHE_TTL_MS };
  return data;
}

/**
 * Bulk-admin counterpart to `runReportGeneration` — recomputes scores, regenerates the English
 * narrative, and regenerates the timing-window summaries for an ALREADY-`ready` report, then
 * overwrites its content via `overwriteReadyReportContent` (never `markReportReady`, which is
 * claim-fenced to a fresh 'generating' row and won't match a 'ready' one). Used by
 * scripts/regenerate-all-report-content.ts to refresh existing customers' already-purchased
 * reports after a narrative/prompt fix — no refund, no re-purchase, no wallet/purchase-field
 * changes of any kind.
 *
 * Returns 'skipped' (never throws for this case) when there's no registered generator for this
 * report key, or the birth chart isn't ready — the same two guard conditions
 * `runReportGeneration` treats as a hard failure, but here there's no purchase to refund, so the
 * caller just moves on to the next row. A genuine LLM/narrative failure DOES throw (propagated to
 * the caller) — the old content is left untouched either way, since `overwriteReadyReportContent`
 * is only ever called after every step above has already succeeded.
 */
export async function regenerateReportContent(row: ReportRow): Promise<'regenerated' | 'skipped'> {
  // Unlike runReportGeneration (see pumpReportQueue), this had no
  // request-context wrapper — both of ITS callers (lazy on-view regen,
  // the bulk admin regenerate script) also call straight through with no
  // ambient userId. That's harmless for ai_usage attribution (comment
  // there already covers it) but silently broke group-scoped model
  // selection specifically: gemini-client.ts's resolveGroupAwareModel needs
  // a userId to look up group membership, so every regeneration would
  // resolve the ai.reportModel picker as if the user were in no group at
  // all, even for a group an admin explicitly pinned to a different model.
  return runWithRequestContext({ userId: row.userId, feature: row.reportKey }, () =>
    regenerateReportContentInner(row),
  );
}

async function regenerateReportContentInner(row: ReportRow): Promise<'regenerated' | 'skipped'> {
  const generator = REPORT_GENERATORS[row.reportKey as ReportKey];
  if (!generator) return 'skipped';

  const kundli = await findKundliByUserId(row.userId, row.birthProfileId);
  if (!kundli || kundli.status !== 'ready' || !kundli.chartData) return 'skipped';

  let partnerChart: Record<string, unknown> | null = null;
  if (hasPartnerBirthInput(row.input)) {
    const metrology = await computeMetrology(partnerInputToBirthRecord(row.input));
    partnerChart = (metrology.chart as Record<string, unknown> | undefined) ?? null;
  }

  const scoreContext = await buildReportScoreContext(row, kundli, partnerChart);
  const scores = computeScoresWithCondition(
    generator,
    scoreContext,
    row.periodMonth,
    row.reportKey,
  );
  const generated = await generator.generateNarrative(scores, 'en');
  // Same fact-check second pass as the initial generation path above, so a
  // regenerated report is never held to a weaker standard than a fresh one.
  const { sections } = await verifyReportClaims(
    generated,
    (scores as { planetCondition?: string[] }).planetCondition ?? [],
  ).catch(() => ({ sections: generated, dropped: 0 }));
  const windowSummaries = await computeWindowSummaries(scores);
  const verdict = await computeReportVerdict(scores, row.reportKey as ReportKey, row.periodMonth);

  await overwriteReadyReportContent(row.id, {
    content: {
      sections,
      contentVersion: CONTENT_VERSION,
      ...(windowSummaries ? { windowSummaries } : {}),
      ...(verdict ? { verdict } : {}),
    },
    model: MODEL,
  });
  return 'regenerated';
}

/**
 * Cheap counterpart to `regenerateReportContent` above — regenerates ONLY the "Final Verdict"
 * card (one LLM call) and merges it into the row's EXISTING `content`, leaving `sections`/
 * `windowSummaries`/`contentVersion` completely untouched. Built for
 * scripts/regenerate-report-verdicts.ts, backfilling the fix for the verdict prompt that used
 * to see every report's `lifeContext` and drift toward career/wealth bullets regardless of the
 * report's own topic (see verdict.ts's VERDICT_TOPIC/VERDICT_EXCLUDED_KEYS doc comments) —
 * running the FULL narrative regeneration for that fix would re-spend the 1-3 expensive
 * narrative LLM calls this feature never needed to touch.
 *
 * Gated to rows that ALREADY have a verdict (`row.content.verdict` present) — a report with no
 * verdict at all (an earlier generation-time LLM call failed) was never affected by the bug this
 * backfills, so leaving it verdict-less here is correct, not a gap; use
 * `regenerateReportContent` instead if giving every old report a first verdict is separately
 * wanted. Returns 'skipped' (never throws) on any failure — the old content is left completely
 * untouched either way, same never-partially-overwrite guarantee as `regenerateReportContent`.
 */
export async function regenerateReportVerdict(row: ReportRow): Promise<'regenerated' | 'skipped'> {
  const generator = REPORT_GENERATORS[row.reportKey as ReportKey];
  if (!generator) return 'skipped';
  const existingContent = row.content as { verdict?: unknown } | null;
  if (!existingContent?.verdict) return 'skipped';

  const kundli = await findKundliByUserId(row.userId, row.birthProfileId);
  if (!kundli || kundli.status !== 'ready' || !kundli.chartData) return 'skipped';

  let partnerChart: Record<string, unknown> | null = null;
  if (hasPartnerBirthInput(row.input)) {
    const metrology = await computeMetrology(partnerInputToBirthRecord(row.input));
    partnerChart = (metrology.chart as Record<string, unknown> | undefined) ?? null;
  }

  const scoreContext = await buildReportScoreContext(row, kundli, partnerChart);
  const scores = computeScoresWithCondition(
    generator,
    scoreContext,
    row.periodMonth,
    row.reportKey,
  );
  const verdict = await computeReportVerdict(scores, row.reportKey as ReportKey, row.periodMonth);
  if (!verdict) return 'skipped'; // generation failed — old (wrong-topic) verdict stays rather than nothing

  await overwriteReadyReportContent(row.id, {
    content: { ...row.content, verdict },
    model: MODEL,
  });
  return 'regenerated';
}

/**
 * Records the one-time "which report do you want next" vote — see
 * db/schema.ts's nextReportVote doc comment. Idempotent: a repeat vote (from
 * a client that somehow still thinks it hasn't asked) is reported back as
 * `alreadyVoted: true` rather than thrown as a conflict, since nothing
 * scarce is being spent here.
 */
export async function voteNextReport(
  userId: string,
  reportKey: string,
): Promise<{ alreadyVoted: boolean }> {
  if (!getReportDef(reportKey)) {
    throw Errors.notFound(`Unknown report key: ${reportKey}`);
  }
  const recorded = await recordNextReportVote(userId, reportKey);
  return { alreadyVoted: !recorded };
}
