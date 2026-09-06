import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { requireAdmin } from '../../middleware/auth.js';
import { accuracyBySurfaceAndConfidence } from '../astro/prediction-outcomes.repo.js';
import { logger } from '../../lib/logger.js';
import {
  DateRangeQuerySchema,
  OverviewQuerySchema,
  OverviewResponseSchema,
  AdminFeaturesResponseSchema,
  UpdateFeatureBodySchema,
  AdminFeatureRowSchema,
  AdminUsersQuerySchema,
  AdminUsersResponseSchema,
  AdminUserIdParamSchema,
  AdjustWalletBodySchema,
  AdjustWalletResponseSchema,
  AdminReportsResponseSchema,
  AdminReportGenerationsQuerySchema,
  AdminReportGenerationsResponseSchema,
  AdminReportGenerationIdParamSchema,
  AdminReportGenerationResetResponseSchema,
  AdminReportGenerationsBulkBodySchema,
  AdminReportGenerationsBulkResponseSchema,
  AdminReportRatingsQuerySchema,
  AdminReportRatingsResponseSchema,
  AdminNextReportVotesResponseSchema,
  AdminReferralsResponseSchema,
  AdminRecurringUsersResponseSchema,
  AdminUserDemographicsResponseSchema,
  AdminDeletionRequestsResponseSchema,
  AdminDeletionActionResponseSchema,
  AdminActiveUsersByLocationQuerySchema,
  AdminActiveUsersByLocationResponseSchema,
} from './admin.schemas.js';
import { resolveDateRangePreset, logAdminAction } from './admin.repo.js';
import { activeUsersByLocation } from '../users/users.repo.js';
import {
  getOverview,
  listFeaturesForAdmin,
  updateFeature,
  searchUsers,
  adjustWallet,
  getReportsBreakdown,
  getReportGenerations,
  resetReportGeneration,
  deleteReportGeneration,
  resetReportGenerationsBulk,
  deleteReportGenerationsBulk,
  getReportRatings,
  getNextReportVoteCounts,
  getReferrals,
  getRecurringUsers,
  getUserDemographics,
  listDeletionRequests,
  flagUserForDeletion,
  rejectDeletionRequest,
  deleteUserHard,
} from './admin.service.js';

const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.string().optional(),
    }),
  })
  .openapi('AdminError');

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorSchema } },
});

export const adminRouter = new OpenAPIHono();

/**
 * `requireAdmin` is applied per-route via each `createRoute`'s own
 * `middleware: [requireAdmin]` (matching the idiom already used elsewhere,
 * e.g. astro.routes.ts's `[requireUser, llmRateLimit, requireConsent]`) —
 * deliberately NOT a router-wide `adminRouter.use('*', requireAdmin)`.
 *
 * A router-wide wildcard `.use()` here was tried first and reproducibly
 * broke OTHER, unrelated routers (kundli/horoscope, mounted later in
 * app.ts's `createApp()`) with spurious 403s: mounting a child OpenAPIHono
 * via `app.route(base, child)` and calling `.use('*', mw)` on the CHILD
 * does not reliably scope `mw` to the child's own paths once merged into
 * the parent's route tree — it can end up running for requests matched by
 * routers registered after it. `billingRouter.use('*', requireUser)`
 * already has this same latent issue but it happens to be invisible there
 * (everywhere it leaks to already requires `requireUser` anyway, so an
 * extra harmless re-run doesn't change any response). `requireAdmin`'s
 * stricter 403 made the leak visible. Per-route middleware arrays go
 * through `.openapi()`'s own path-specific registration instead and do not
 * exhibit this problem.
 *
 * Each `createRoute` below repeats the literal `middleware: [requireAdmin]
 * as const` inline rather than referencing one shared constant — a shared
 * `const X = [requireAdmin] as const` loses the contextual typing
 * `createRoute` needs (surfaces as `c.req.valid(...)` losing its schema
 * inference, typed `never`), so this mirrors astro.routes.ts's own
 * inline-literal convention exactly rather than "simplifying" it away.
 */

/**
 * The token claim requireAdmin already validated against ADMIN_PHONE_E164 —
 * safe to treat as the admin's identity for audit logging without
 * re-checking (requireAdmin already 403'd anything that wouldn't reach here).
 */
function adminPhoneOf(c: { get: (key: 'firebaseToken') => { phone_number?: string } }): string {
  return c.get('firebaseToken').phone_number ?? 'unknown';
}

/**
 * Audit-logs a READ (the two write routes — PUT features, POST wallet —
 * already log through admin.service.ts, alongside the state change itself).
 * Awaited so the log genuinely lands before the response, but never allowed
 * to fail the request — an audit-log hiccup should not turn a working
 * dashboard read into a 500.
 */
async function auditRead(
  c: { get: (key: 'firebaseToken') => { phone_number?: string } },
  route: string,
  params: unknown,
): Promise<void> {
  await logAdminAction(adminPhoneOf(c), route, params).catch((err: unknown) =>
    logger.warn({ err, route }, 'admin_audit_log insert failed'),
  );
}

/* -------------------------------------------------------------------------- */
/* GET /admin/overview                                                        */
/* -------------------------------------------------------------------------- */

const overviewRoute = createRoute({
  method: 'get',
  path: '/admin/overview',
  tags: ['Admin'],
  summary: 'Revenue/analytics overview for a date-range preset',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  request: { query: OverviewQuerySchema },
  responses: {
    200: {
      description: 'Overview metrics',
      content: { 'application/json': { schema: OverviewResponseSchema } },
    },
    400: errorResponse('Unknown preset or malformed custom from/to'),
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(overviewRoute, async (c) => {
  const { preset, from, to, userId } = c.req.valid('query');
  const range = resolveDateRangePreset(preset, from, to);
  const overview = await getOverview(range, preset, userId ? { llmUserId: userId } : {});
  await auditRead(c, 'GET /v1/admin/overview', { preset, from, to, userId });
  return c.json(overview, 200);
});

/* -------------------------------------------------------------------------- */
/* GET /admin/features                                                        */
/* -------------------------------------------------------------------------- */

const listFeaturesRoute = createRoute({
  method: 'get',
  path: '/admin/features',
  tags: ['Admin'],
  summary: 'Every feature in FEATURE_REGISTRY merged with its admin override, if any',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  responses: {
    200: {
      description: 'Feature list',
      content: { 'application/json': { schema: AdminFeaturesResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(listFeaturesRoute, async (c) => {
  const features = await listFeaturesForAdmin();
  await auditRead(c, 'GET /v1/admin/features', {});
  return c.json({ features }, 200);
});

/* -------------------------------------------------------------------------- */
/* PUT /admin/features                                                        */
/* -------------------------------------------------------------------------- */

const updateFeatureRoute = createRoute({
  method: 'put',
  path: '/admin/features',
  tags: ['Admin'],
  summary: 'Toggle/reprice a feature (writes a feature_flags override row)',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  request: {
    body: { required: true, content: { 'application/json': { schema: UpdateFeatureBodySchema } } },
  },
  responses: {
    200: {
      description: 'Updated feature row',
      content: { 'application/json': { schema: AdminFeatureRowSchema } },
    },
    400: errorResponse('Unknown feature key'),
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(updateFeatureRoute, async (c) => {
  const { key, enabled, pricePaise, originalPricePaise, model } = c.req.valid('json');
  const row = await updateFeature(
    key,
    enabled,
    pricePaise,
    originalPricePaise,
    model,
    adminPhoneOf(c),
  );
  return c.json(row, 200);
});

/* -------------------------------------------------------------------------- */
/* GET /admin/users                                                           */
/* -------------------------------------------------------------------------- */

const listUsersRoute = createRoute({
  method: 'get',
  path: '/admin/users',
  tags: ['Admin'],
  summary:
    'Paginated user search — ILIKE on displayName/email, exact match on phone; optional contactType filters to phone-only or email-only users',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  request: { query: AdminUsersQuerySchema },
  responses: {
    200: {
      description: 'User page',
      content: { 'application/json': { schema: AdminUsersResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(listUsersRoute, async (c) => {
  const { q, contactType, offset, limit, sortBy, sortDir } = c.req.valid('query');
  const page = await searchUsers(q, limit, offset, sortBy, sortDir, contactType);
  await auditRead(c, 'GET /v1/admin/users', { q, contactType, offset, limit, sortBy, sortDir });
  return c.json(page, 200);
});

/* -------------------------------------------------------------------------- */
/* POST /admin/users/{id}/wallet                                              */
/* -------------------------------------------------------------------------- */

const adjustWalletRoute = createRoute({
  method: 'post',
  path: '/admin/users/{id}/wallet',
  tags: ['Admin'],
  summary: 'Grant or deduct wallet balance — the web equivalent of the Telegram /money command',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  request: {
    params: AdminUserIdParamSchema,
    body: { required: true, content: { 'application/json': { schema: AdjustWalletBodySchema } } },
  },
  responses: {
    200: {
      description: 'New wallet balance',
      content: { 'application/json': { schema: AdjustWalletResponseSchema } },
    },
    400: errorResponse('deltaPaise must be non-zero'),
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
    404: errorResponse('User not found'),
    409: errorResponse('Deduction would exceed the current balance'),
  },
});

adminRouter.openapi(adjustWalletRoute, async (c) => {
  const { id } = c.req.valid('param');
  const { deltaPaise, note } = c.req.valid('json');
  const result = await adjustWallet(id, deltaPaise, note, adminPhoneOf(c));
  return c.json(result, 200);
});

/* -------------------------------------------------------------------------- */
/* GET /admin/reports                                                         */
/* -------------------------------------------------------------------------- */

const reportsRoute = createRoute({
  method: 'get',
  path: '/admin/reports',
  tags: ['Admin'],
  summary: 'report_unlock spend broken down per report key, for a date-range preset',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  request: { query: DateRangeQuerySchema },
  responses: {
    200: {
      description: 'Per-report spend',
      content: { 'application/json': { schema: AdminReportsResponseSchema } },
    },
    400: errorResponse('Unknown preset or malformed custom from/to'),
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(reportsRoute, async (c) => {
  const { preset, from, to } = c.req.valid('query');
  const range = resolveDateRangePreset(preset, from, to);
  const reports = await getReportsBreakdown(range);
  await auditRead(c, 'GET /v1/admin/reports', { preset, from, to });
  return c.json({ reports }, 200);
});

/* -------------------------------------------------------------------------- */
/* GET /admin/report-generations — who generated which report                 */
/* -------------------------------------------------------------------------- */

const reportGenerationsRoute = createRoute({
  method: 'get',
  path: '/admin/report-generations',
  tags: ['Admin'],
  summary:
    'Every generated report row across all users, newest first, optionally filtered to one report key',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  request: { query: AdminReportGenerationsQuerySchema },
  responses: {
    200: {
      description: 'Report generation rows',
      content: { 'application/json': { schema: AdminReportGenerationsResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(reportGenerationsRoute, async (c) => {
  const { reportKey, offset, limit } = c.req.valid('query');
  const page = await getReportGenerations(reportKey, limit, offset);
  await auditRead(c, 'GET /v1/admin/report-generations', { reportKey, offset, limit });
  return c.json(page, 200);
});

/* -------------------------------------------------------------------------- */
/* POST /admin/report-generations/{id}/reset                                  */
/* -------------------------------------------------------------------------- */

const resetReportGenerationRoute = createRoute({
  method: 'post',
  path: '/admin/report-generations/{id}/reset',
  tags: ['Admin'],
  summary:
    "Unstick one report row (status -> 'failed') so its owner can regenerate it — content and paid record survive",
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  request: { params: AdminReportGenerationIdParamSchema },
  responses: {
    200: {
      description: 'Reset report',
      content: { 'application/json': { schema: AdminReportGenerationResetResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
    404: errorResponse('Report not found'),
  },
});

adminRouter.openapi(resetReportGenerationRoute, async (c) => {
  const { id } = c.req.valid('param');
  const result = await resetReportGeneration(id, adminPhoneOf(c));
  return c.json(result, 200);
});

/* -------------------------------------------------------------------------- */
/* DELETE /admin/report-generations/{id}                                      */
/* -------------------------------------------------------------------------- */

const deleteReportGenerationRoute = createRoute({
  method: 'delete',
  path: '/admin/report-generations/{id}',
  tags: ['Admin'],
  summary: 'Permanently delete one report row — irreversible',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  request: { params: AdminReportGenerationIdParamSchema },
  responses: {
    204: { description: 'Deleted' },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
    404: errorResponse('Report not found'),
  },
});

adminRouter.openapi(deleteReportGenerationRoute, async (c) => {
  const { id } = c.req.valid('param');
  await deleteReportGeneration(id, adminPhoneOf(c));
  return c.body(null, 204);
});

/* -------------------------------------------------------------------------- */
/* POST /admin/report-generations/reset-all                                   */
/* -------------------------------------------------------------------------- */

const resetReportGenerationsBulkRoute = createRoute({
  method: 'post',
  path: '/admin/report-generations/reset-all',
  tags: ['Admin'],
  summary: "Reset every non-failed row for one report key (status -> 'failed')",
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: AdminReportGenerationsBulkBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Rows reset',
      content: { 'application/json': { schema: AdminReportGenerationsBulkResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(resetReportGenerationsBulkRoute, async (c) => {
  const { reportKey } = c.req.valid('json');
  const result = await resetReportGenerationsBulk(reportKey, adminPhoneOf(c));
  return c.json(result, 200);
});

/* -------------------------------------------------------------------------- */
/* POST /admin/report-generations/delete-all                                  */
/* -------------------------------------------------------------------------- */

const deleteReportGenerationsBulkRoute = createRoute({
  method: 'post',
  path: '/admin/report-generations/delete-all',
  tags: ['Admin'],
  summary: 'Permanently delete every row for one report key — irreversible',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: AdminReportGenerationsBulkBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Rows deleted',
      content: { 'application/json': { schema: AdminReportGenerationsBulkResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(deleteReportGenerationsBulkRoute, async (c) => {
  const { reportKey } = c.req.valid('json');
  const result = await deleteReportGenerationsBulk(reportKey, adminPhoneOf(c));
  return c.json(result, 200);
});

/* -------------------------------------------------------------------------- */
/* GET /admin/report-ratings — every report rating, newest first              */
/* -------------------------------------------------------------------------- */

const reportRatingsRoute = createRoute({
  method: 'get',
  path: '/admin/report-ratings',
  tags: ['Admin'],
  summary:
    'Every report rating across all users, newest first, optionally filtered to one report key',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  request: { query: AdminReportRatingsQuerySchema },
  responses: {
    200: {
      description: 'Report rating rows',
      content: { 'application/json': { schema: AdminReportRatingsResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(reportRatingsRoute, async (c) => {
  const { reportKey, offset, limit } = c.req.valid('query');
  const page = await getReportRatings(reportKey, limit, offset);
  await auditRead(c, 'GET /v1/admin/report-ratings', { reportKey, offset, limit });
  return c.json(page, 200);
});

/* -------------------------------------------------------------------------- */
/* GET /admin/next-report-votes                                               */
/* -------------------------------------------------------------------------- */

const nextReportVotesRoute = createRoute({
  method: 'get',
  path: '/admin/next-report-votes',
  tags: ['Admin'],
  summary: 'Vote counts for "which report should we prepare next", most-requested first',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  responses: {
    200: {
      description: 'Vote counts',
      content: { 'application/json': { schema: AdminNextReportVotesResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(nextReportVotesRoute, async (c) => {
  const result = await getNextReportVoteCounts();
  await auditRead(c, 'GET /v1/admin/next-report-votes', {});
  return c.json(result, 200);
});

/* -------------------------------------------------------------------------- */
/* GET /admin/referrals                                                        */
/* -------------------------------------------------------------------------- */

const listReferralsRoute = createRoute({
  method: 'get',
  path: '/admin/referrals',
  tags: ['Admin'],
  summary:
    'All referral relationships — who referred whom, grouped by referrer, sorted by count desc',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  responses: {
    200: {
      description: 'Referral groups',
      content: { 'application/json': { schema: AdminReferralsResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(listReferralsRoute, async (c) => {
  const referrals = await getReferrals();
  await auditRead(c, 'GET /v1/admin/referrals', {});
  return c.json({ referrals }, 200);
});

/* -------------------------------------------------------------------------- */
/* GET /admin/recurring-users                                                  */
/* -------------------------------------------------------------------------- */

const recurringUsersRoute = createRoute({
  method: 'get',
  path: '/admin/recurring-users',
  tags: ['Admin'],
  summary:
    'Recurring-user counts and approximate time spent for this week, last week, last week+1, and last week+2, derived from existing activity history',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  responses: {
    200: {
      description: 'Weekly recurring-user breakdown',
      content: { 'application/json': { schema: AdminRecurringUsersResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(recurringUsersRoute, async (c) => {
  const weeks = await getRecurringUsers();
  await auditRead(c, 'GET /v1/admin/recurring-users', {});
  return c.json({ weeks }, 200);
});

/* -------------------------------------------------------------------------- */
/* GET /admin/active-users/by-location                                        */
/* -------------------------------------------------------------------------- */

const activeUsersByLocationRoute = createRoute({
  method: 'get',
  path: '/admin/active-users/by-location',
  tags: ['Admin'],
  summary: 'Active users in a preset window, grouped by IP-geolocated country/city',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  request: { query: AdminActiveUsersByLocationQuerySchema },
  responses: {
    200: {
      description: 'Location breakdown',
      content: { 'application/json': { schema: AdminActiveUsersByLocationResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(activeUsersByLocationRoute, async (c) => {
  const { preset } = c.req.valid('query');
  const range = resolveDateRangePreset(preset);
  const locations = await activeUsersByLocation(range);
  await auditRead(c, 'GET /v1/admin/active-users/by-location', { preset });
  return c.json({ locations }, 200);
});

/* -------------------------------------------------------------------------- */
/* GET /admin/user-demographics                                               */
/* -------------------------------------------------------------------------- */

const userDemographicsRoute = createRoute({
  method: 'get',
  path: '/admin/user-demographics',
  tags: ['Admin'],
  summary: 'Age-bracket, gender, and relationship-status breakdown across all users',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  responses: {
    200: {
      description: 'User demographics breakdown',
      content: { 'application/json': { schema: AdminUserDemographicsResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(userDemographicsRoute, async (c) => {
  const demographics = await getUserDemographics();
  await auditRead(c, 'GET /v1/admin/user-demographics', {});
  return c.json(demographics, 200);
});

/* -------------------------------------------------------------------------- */
/* GET /admin/prediction-accuracy                                             */
/*                                                                            */
/* The number the whole prediction_outcomes table exists to produce: hit rate  */
/* broken down by surface and by the confidence band the engine committed to   */
/* in ADVANCE. A calibrated system has HIGH scoring materially better than     */
/* LOW; if they come out level, dasha-confidence.ts's banding is decorative    */
/* and needs retuning — a finding that was impossible to make before this      */
/* table existed. Admin-only: it is an engineering metric, not user content.   */
/* -------------------------------------------------------------------------- */

const AdminAccuracyRowSchema = z
  .object({
    surface: z.string(),
    confidence: z.string().nullable(),
    rated: z.number(),
    correct: z.number(),
    accuracy: z.number(),
  })
  .openapi('AdminAccuracyRow');

const predictionAccuracyRoute = createRoute({
  method: 'get',
  path: '/prediction-accuracy',
  tags: ['Admin'],
  summary: 'Prediction hit rate by surface and claimed confidence band',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  responses: {
    200: {
      description: 'Accuracy rollup. Empty until users have rated closed windows.',
      content: {
        'application/json': { schema: z.object({ rows: z.array(AdminAccuracyRowSchema) }) },
      },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(predictionAccuracyRoute, async (c) => {
  const rows = await accuracyBySurfaceAndConfidence();
  await auditRead(c, 'GET /v1/admin/prediction-accuracy', {});
  return c.json({ rows }, 200);
});

/* -------------------------------------------------------------------------- */
/* GET /admin/deletion-requests                                              */
/* -------------------------------------------------------------------------- */

const listDeletionRequestsRoute = createRoute({
  method: 'get',
  path: '/admin/deletion-requests',
  tags: ['Admin'],
  summary: 'Pending account-deletion requests, oldest first',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  responses: {
    200: {
      description: 'Pending requests',
      content: { 'application/json': { schema: AdminDeletionRequestsResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
  },
});

adminRouter.openapi(listDeletionRequestsRoute, async (c) => {
  const requests = await listDeletionRequests();
  await auditRead(c, 'GET /v1/admin/deletion-requests', {});
  return c.json({ requests }, 200);
});

/* -------------------------------------------------------------------------- */
/* POST /admin/deletion-requests/{id}                                        */
/* -------------------------------------------------------------------------- */

const flagDeletionRoute = createRoute({
  method: 'post',
  path: '/admin/deletion-requests/{id}',
  tags: ['Admin'],
  summary:
    'Manually flag a user for deletion (e.g. they called in rather than tapping Delete Account)',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  request: { params: AdminUserIdParamSchema },
  responses: {
    200: {
      description: 'Request now in force',
      content: { 'application/json': { schema: AdminDeletionActionResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
    404: errorResponse('User not found'),
  },
});

adminRouter.openapi(flagDeletionRoute, async (c) => {
  const { id } = c.req.valid('param');
  const result = await flagUserForDeletion(id, adminPhoneOf(c));
  return c.json(result, 200);
});

/* -------------------------------------------------------------------------- */
/* PATCH /admin/deletion-requests/{id}/reject                                */
/* -------------------------------------------------------------------------- */

const rejectDeletionRoute = createRoute({
  method: 'patch',
  path: '/admin/deletion-requests/{id}/reject',
  tags: ['Admin'],
  summary: 'Dismiss a deletion request — account stays, nothing erased',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  request: { params: AdminUserIdParamSchema },
  responses: {
    200: {
      description: 'Cleared',
      content: { 'application/json': { schema: AdminDeletionActionResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
    404: errorResponse('User not found'),
  },
});

adminRouter.openapi(rejectDeletionRoute, async (c) => {
  const { id } = c.req.valid('param');
  const result = await rejectDeletionRequest(id, adminPhoneOf(c));
  return c.json(result, 200);
});

/* -------------------------------------------------------------------------- */
/* DELETE /admin/deletion-requests/{id}                                      */
/* -------------------------------------------------------------------------- */

const hardDeleteRoute = createRoute({
  method: 'delete',
  path: '/admin/deletion-requests/{id}',
  tags: ['Admin'],
  summary:
    'Irreversible hard delete — no shell row survives (same erasure as the Telegram /delete command)',
  security: [{ bearerAuth: [] }],
  middleware: [requireAdmin] as const,
  request: { params: AdminUserIdParamSchema },
  responses: {
    200: {
      description: 'Deleted',
      content: { 'application/json': { schema: z.object({ id: z.string() }) } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Admin access required'),
    404: errorResponse('User not found'),
  },
});

adminRouter.openapi(hardDeleteRoute, async (c) => {
  const { id } = c.req.valid('param');
  const result = await deleteUserHard(id, adminPhoneOf(c));
  return c.json(result, 200);
});
