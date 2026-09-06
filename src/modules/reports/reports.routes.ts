import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { requireUser } from '../../middleware/auth.js';
import { resolveActiveProfileContext } from '../birth-profiles/profile-context.js';
import {
  LanguageQuerySchema,
  PreviewReportBodySchema,
  PreviewReportResponseSchema,
  PurchaseReportBodySchema,
  PurchaseReportResponseSchema,
  ReportCatalogueResponseSchema,
  ReportFailedSchema,
  ReportGeneratingSchema,
  ReportHistoryResponseSchema,
  ReportIdParamSchema,
  ReportReadySchema,
  ReportStatsResponseSchema,
  VoteNextReportBodySchema,
  VoteNextReportResponseSchema,
} from './reports.schemas.js';
import {
  getReportCatalogueForUser,
  getReportForUser,
  getReportHistoryForUser,
  getReportStats,
  previewReport,
  purchaseReport,
  voteNextReport,
} from './reports.service.js';
import { RateReportBodySchema, RateReportResponseSchema } from './report-ratings.schemas.js';
import { rateReport } from './report-ratings.service.js';

const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.string().optional(),
    }),
  })
  .openapi('ReportsError');

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorSchema } },
});

export const reportsRouter = new OpenAPIHono();

reportsRouter.use('*', requireUser);

const listRoute = createRoute({
  method: 'get',
  path: '/reports',
  tags: ['Reports'],
  summary: "The report catalogue merged with the current user's purchases",
  description:
    'Every catalogue entry includes its live enabled/price (resolved server-side from the admin ' +
    "feature-flag overrides — never hardcode a price client-side) plus this user's own purchases " +
    'for that key, scoped to the currently active birth profile, so the client can render ' +
    '"buy" vs. "tap to view" per report.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Catalogue merged with purchases',
      content: { 'application/json': { schema: ReportCatalogueResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
  },
});

reportsRouter.openapi(listRoute, async (c) => {
  const user = c.get('user');
  const profile = await resolveActiveProfileContext(user);
  const catalogue = await getReportCatalogueForUser(user, profile.birthProfileId);
  return c.json({ reports: catalogue }, 200);
});

const statsRoute = createRoute({
  method: 'get',
  path: '/reports/stats',
  tags: ['Reports'],
  summary: 'Public social-proof counts — ready, non-preview report counts grouped by report key',
  description:
    'An aggregate count across ALL users, not scoped to the caller (e.g. "1,926 reports ' +
    'generated") — still requires auth like the rest of this router, but leaks no user-specific ' +
    'data either way. Cached server-side for a few minutes rather than queried fresh every time.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Report key -> ready & purchased count',
      content: { 'application/json': { schema: ReportStatsResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
  },
});

reportsRouter.openapi(statsRoute, async (c) => {
  const stats = await getReportStats();
  return c.json(stats, 200);
});

const historyRoute = createRoute({
  method: 'get',
  path: '/reports/history',
  tags: ['Reports'],
  summary: "The current user's own past reports across every report type, newest first",
  description:
    'Unlike GET /reports (the catalogue, grouped per report type), this is a flat, cross-type ' +
    'list scoped to the currently active birth profile — powers the account-wide "My Reports" ' +
    'history screen. Excludes free preview rows (never actually purchased). Registered before ' +
    'GET /reports/{id} so the literal "history" path segment is never swallowed by that route\'s ' +
    '{id} param.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "The user's report history",
      content: { 'application/json': { schema: ReportHistoryResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
  },
});

reportsRouter.openapi(historyRoute, async (c) => {
  const user = c.get('user');
  const profile = await resolveActiveProfileContext(user);
  const reports = await getReportHistoryForUser(user.id, profile.birthProfileId);
  return c.json({ reports }, 200);
});

const purchaseRoute = createRoute({
  method: 'post',
  path: '/reports/purchase',
  tags: ['Reports'],
  summary:
    'Purchase a report — one-time, one/many months of a monthly report, or kundli_milan with a partner',
  description:
    'Debits the wallet server-side (price is never trusted from the client) and kicks off background ' +
    'generation per purchased row — poll GET /reports/{id} for each id returned here. A report key with ' +
    'no registered generator yet (see the reports catalogue doc) is still purchasable; it will fail and ' +
    'auto-refund shortly after, visible via GET /reports/{id}.',
  security: [{ bearerAuth: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: PurchaseReportBodySchema } } },
  },
  responses: {
    200: {
      description:
        'Purchased — one summary per row (one for one-time/kundli_milan, one per month for a bundle)',
      content: { 'application/json': { schema: PurchaseReportResponseSchema } },
    },
    400: errorResponse(
      'Validation failed — unknown key, missing/unexpected months, or missing/unexpected partner',
    ),
    401: errorResponse('Unauthorized'),
    403: errorResponse('FEATURE_DISABLED'),
    404: errorResponse('Unknown report key'),
    409: errorResponse('INSUFFICIENT_CREDITS'),
  },
});

reportsRouter.openapi(purchaseRoute, async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');
  const result = await purchaseReport(user, body);
  return c.json(result, 200);
});

const previewRoute = createRoute({
  method: 'post',
  path: '/reports/preview',
  tags: ['Reports'],
  summary:
    'Generate a free preview of a report — the real generated content, flagged for the client to blur/paywall',
  description:
    'No wallet debit — billed at 0 and flagged `isPreview: true`. Runs through the exact same ' +
    'background generation as a real purchase (see POST /reports/purchase), so GET /reports/{id} ' +
    'returns real content, just with `isPreview: true` so the client knows to blur it behind a ' +
    'paywall. Not supported for reports that require partner details (kundli_milan/match_report) ' +
    '— there is no partner data yet at preview time. Idempotent: repeat taps just return the same ' +
    "row's current state rather than generating twice.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { required: true, content: { 'application/json': { schema: PreviewReportBodySchema } } },
  },
  responses: {
    200: {
      description: 'Preview claimed or already existing — always a single row',
      content: { 'application/json': { schema: PreviewReportResponseSchema } },
    },
    400: errorResponse('Validation failed, or this report key does not support preview'),
    401: errorResponse('Unauthorized'),
    404: errorResponse('Unknown report key'),
  },
});

reportsRouter.openapi(previewRoute, async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');
  const result = await previewReport(user, body);
  return c.json(result, 200);
});

const getOneRoute = createRoute({
  method: 'get',
  path: '/reports/{id}',
  tags: ['Reports'],
  summary: 'Get a single purchased report (poll target)',
  description:
    'Deterministic `scores` are always recomputed fresh from the live chart, never trusted from the ' +
    'persisted row — so a future scoring-rule fix applies retroactively with no backfill. `sections` are ' +
    'the cached AI narrative, translated and cached on first request for a non-English `language`.',
  security: [{ bearerAuth: [] }],
  request: { params: ReportIdParamSchema, query: LanguageQuerySchema },
  responses: {
    200: {
      description: 'Ready (with sections + scores) or failed (with error)',
      content: { 'application/json': { schema: z.union([ReportReadySchema, ReportFailedSchema]) } },
    },
    202: {
      description: 'Still generating — poll again',
      content: { 'application/json': { schema: ReportGeneratingSchema } },
    },
    401: errorResponse('Unauthorized'),
    404: errorResponse('Not found (also returned for a report owned by another user)'),
  },
});

reportsRouter.openapi(getOneRoute, async (c) => {
  const user = c.get('user');
  const { id } = c.req.valid('param');
  const { language } = c.req.valid('query');
  const dto = await getReportForUser(id, user.id, language || 'en');
  if (dto.status === 'generating') return c.json(dto, 202);
  return c.json(dto, 200);
});

/* -------------------------------------------------------------------------- */
/* POST /reports/{id}/rating — rate a finished report                         */
/* -------------------------------------------------------------------------- */

const rateReportRoute = createRoute({
  method: 'post',
  path: '/reports/{id}/rating',
  tags: ['Reports'],
  summary:
    'Rate a finished report; a rating under 3 stars triggers an automatic 100% refund to the wallet',
  security: [{ bearerAuth: [] }],
  request: {
    params: ReportIdParamSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: RateReportBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Rating recorded',
      content: { 'application/json': { schema: RateReportResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    404: errorResponse(
      'Not found (also returned for a report owned by another user, or one not yet ready to rate)',
    ),
    409: errorResponse('Already rated'),
  },
});

reportsRouter.openapi(rateReportRoute, async (c) => {
  const user = c.get('user');
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const result = await rateReport({
    userId: user.id,
    reportId: id,
    rating: body.rating,
    ...(body.comment ? { comment: body.comment } : {}),
  });
  return c.json(result, 201);
});

const voteNextReportRoute = createRoute({
  method: 'post',
  path: '/reports/next-vote',
  tags: ['Reports'],
  summary: 'One-time vote for which report the user wants prepared next',
  description:
    'Idempotent — voting again after an existing vote is a harmless no-op, reported back as ' +
    '`alreadyVoted: true` rather than a conflict.',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: VoteNextReportBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Vote recorded (or already existed)',
      content: { 'application/json': { schema: VoteNextReportResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    404: errorResponse('Unknown report key'),
  },
});

reportsRouter.openapi(voteNextReportRoute, async (c) => {
  const user = c.get('user');
  const { reportKey } = c.req.valid('json');
  const result = await voteNextReport(user.id, reportKey);
  return c.json(result, 200);
});
