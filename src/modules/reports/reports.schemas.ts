import { z } from '@hono/zod-openapi';

export const LanguageQuerySchema = z.object({
  language: z
    .string()
    .optional()
    .openapi({ param: { name: 'language', in: 'query' }, example: 'hi' }),
});

export const PartnerBirthDetailsSchema = z
  .object({
    dateOfBirth: z.string(),
    timeOfBirth: z.string(),
    latitude: z.number(),
    longitude: z.number(),
    timezone: z.string(),
    /** How much the partner's `timeOfBirth` can be trusted. 'unknown' means the purchaser
     * only knew a part of the day and `timeOfBirth` holds that window's midpoint (see
     * lib/birth-time-window.ts) — the narrative must then drop to a sign-level reading for
     * the partner. Optional: absent on rows purchased before this was collected. */
    timeAccuracy: z.enum(['exact', 'approximate', 'unknown']).optional(),
    /** Optional — marriage only (kundli_milan/match_report don't collect this). Used purely for
     * narrative personalization ("your spouse, Priya") and pre-fill display, never for chart math. */
    name: z.string().optional(),
    /** Optional — marriage only. Display label for the resolved place (e.g. "Mumbai, India"),
     * used purely to pre-fill the place-autocomplete input on a later purchase; never used for
     * chart computation (latitude/longitude/timezone already carry that). */
    placeLabel: z.string().optional(),
  })
  .openapi('PartnerBirthDetails');

export const LastSpouseDetailsSchema = PartnerBirthDetailsSchema.nullable();

export const PurchaseReportBodySchema = z
  .object({
    reportKey: z.string(),
    /** 'YYYY-MM' strings — monthly reports only. */
    months: z.array(z.string().regex(/^\d{4}-\d{2}$/)).optional(),
    birthProfileId: z.string().uuid().nullable().optional(),
    /** kundli_milan only. */
    partner: PartnerBirthDetailsSchema.optional(),
    /** Optional answers to a small, skippable pre-purchase questionnaire (see frontend's
     * lib/report-questions.ts) — only meaningful for report types with a configured question
     * set; ignored by every other report type's generator. Never persisted — read once by
     * runReportGeneration and discarded. */
    answers: z.record(z.string(), z.string()).optional(),
  })
  .openapi('PurchaseReportBody');

export type PurchaseReportBody = z.infer<typeof PurchaseReportBodySchema>;

export const PreviewReportBodySchema = z
  .object({
    reportKey: z.string(),
    birthProfileId: z.string().uuid().nullable().optional(),
  })
  .openapi('PreviewReportBody');

export type PreviewReportBody = z.infer<typeof PreviewReportBodySchema>;

export const PreviewReportResponseSchema = z
  .object({
    id: z.string(),
    reportKey: z.string(),
    status: z.enum(['generating', 'ready', 'failed']),
  })
  .openapi('PreviewReportResponse');

export type PreviewReportResponseDto = z.infer<typeof PreviewReportResponseSchema>;

export const PurchasedReportSummarySchema = z
  .object({
    id: z.string(),
    reportKey: z.string(),
    periodMonth: z.string().nullable(),
    status: z.enum(['generating', 'ready', 'failed']),
  })
  .openapi('PurchasedReportSummary');

export const PurchaseReportResponseSchema = z
  .object({
    reports: z.array(PurchasedReportSummarySchema),
  })
  .openapi('PurchaseReportResponse');

export const ReportCataloguePurchaseSchema = z
  .object({
    id: z.string(),
    periodMonth: z.string().nullable(),
    status: z.enum(['generating', 'ready', 'failed']),
  })
  .openapi('ReportCataloguePurchase');

export const ReportCatalogueEntrySchema = z
  .object({
    key: z.string(),
    label: z.string(),
    isMonthly: z.boolean(),
    /** True for the 4 one-time report types that renew once a year (marriage/wealth/
     * true_love/numerology) — see backend's ReportDef.isYearly doc comment. */
    isYearly: z.boolean(),
    requiresPartner: z.boolean(),
    enabled: z.boolean(),
    /** Shows the catalogue's "New" badge — an admin enabled this report within the last
     * NEW_REPORT_WINDOW_MS (config/reports.ts's computeIsNewReport). */
    isNew: z.boolean(),
    /** Never hardcode a price client-side — always read it from here. */
    pricePaise: z.number().int(),
    /** "Strikethrough" MRP for the discount treatment. Null means no discount
     * is configured — never a fabricated value derived from pricePaise. */
    originalPricePaise: z.number().int().nullable(),
    purchases: z.array(ReportCataloguePurchaseSchema),
    /** marriage only — the most recently purchased marriage report's own stored spouse birth
     * details, for pre-filling the optional spouse-details section on a later purchase. Always
     * null for every other report key. */
    lastSpouseDetails: LastSpouseDetailsSchema,
  })
  .openapi('ReportCatalogueEntry');

export const ReportCatalogueResponseSchema = z
  .object({
    reports: z.array(ReportCatalogueEntrySchema),
  })
  .openapi('ReportCatalogueResponse');

/** Public social-proof counts — `{ [reportKey]: readyCount }`, ready & non-preview,
 * aggregated across ALL users. See GET /reports/stats. */
export const ReportStatsResponseSchema = z
  .record(z.string(), z.number().int())
  .openapi('ReportStatsResponse');

export type ReportStatsDto = z.infer<typeof ReportStatsResponseSchema>;

/** One row of the user's own cross-report-type purchase history (GET /reports/history) —
 * excludes preview rows, which aren't real purchases. */
export const ReportHistoryEntrySchema = z
  .object({
    id: z.string(),
    reportKey: z.string(),
    label: z.string(),
    status: z.enum(['generating', 'ready', 'failed']),
    periodMonth: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('ReportHistoryEntry');

export const ReportHistoryResponseSchema = z
  .object({
    reports: z.array(ReportHistoryEntrySchema),
  })
  .openapi('ReportHistoryResponse');

export type ReportHistoryEntryDto = z.infer<typeof ReportHistoryEntrySchema>;

export const ReportSectionSchema = z
  .object({
    /** Canonical section id (config/report-sections.ts) — absent for a report type not yet
     * listed there, or a section-count mismatch. Client falls back to `heading` in that case. */
    id: z.string().optional(),
    heading: z.string(),
    paragraphs: z.array(z.string()),
    uiData: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('ReportSection');

export const ReportGeneratingSchema = z
  .object({ status: z.literal('generating') })
  .openapi('ReportGenerating');

export const ReportFailedSchema = z
  .object({ status: z.literal('failed'), error: z.string().nullable() })
  .openapi('ReportFailed');

export const ReportReadySchema = z
  .object({
    status: z.literal('ready'),
    reportKey: z.string(),
    periodMonth: z.string().nullable(),
    /** Deterministic facts recomputed fresh from the live chart on every read — see
     * ReportGenerator['computeScores']. Shape differs per report type. */
    scores: z.record(z.string(), z.unknown()),
    sections: z.array(ReportSectionSchema),
    /** True for a free "generate and blur" preview row that hasn't been purchased yet — tells the
     * client to render the paywall/blur over these sections rather than the full report. */
    isPreview: z.boolean(),
  })
  .openapi('ReportReady');

export const ReportDtoSchema = z
  .union([ReportGeneratingSchema, ReportFailedSchema, ReportReadySchema])
  .openapi('ReportDto');

export type ReportDto = z.infer<typeof ReportDtoSchema>;
export type ReportCatalogueEntryDto = z.infer<typeof ReportCatalogueEntrySchema>;
export type PurchasedReportSummaryDto = z.infer<typeof PurchasedReportSummarySchema>;

export const ReportIdParamSchema = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
});

export const VoteNextReportBodySchema = z
  .object({ reportKey: z.string() })
  .openapi('VoteNextReportBody');

export const VoteNextReportResponseSchema = z
  .object({ alreadyVoted: z.boolean() })
  .openapi('VoteNextReportResponse');
