import { z } from '@hono/zod-openapi';

/* -------------------------------------------------------------------------- */
/* Shared date-range query                                                     */
/* -------------------------------------------------------------------------- */

export const DateRangeQuerySchema = z.object({
  preset: z
    .string()
    .default('last30d')
    .openapi({
      example: 'last30d',
      description:
        'today | yesterday | last7d | last15d | last30d | this_month | last_month | ' +
        'last90d | this_quarter | this_year | lifetime | custom (requires from/to)',
    }),
  from: z
    .string()
    .optional()
    .openapi({ example: '2026-07-01', description: 'YYYY-MM-DD, required when preset=custom' }),
  to: z
    .string()
    .optional()
    .openapi({ example: '2026-07-08', description: 'YYYY-MM-DD, required when preset=custom' }),
});

/* -------------------------------------------------------------------------- */
/* GET /admin/overview                                                        */
/* -------------------------------------------------------------------------- */

const TimeSeriesPointSchema = z.object({
  bucketStart: z.string(),
  totalPaise: z.number(),
  count: z.number(),
});

const SpendByFeatureEntrySchema = z.object({
  reasonPrefix: z.string(),
  totalPaise: z.number(),
  count: z.number(),
});

const TopUpFunnelEntrySchema = z.object({
  status: z.string(),
  count: z.number(),
});

const LlmCostEntrySchema = z.object({
  agent: z.string(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  calls: z.number(),
  // The billed subset. Calls served by the free key tier cost ₹0 however many
  // tokens they burn, so only these convert into real money.
  paidTokensIn: z.number(),
  paidTokensOut: z.number(),
  paidCalls: z.number(),
});

/**
 * Overview query. Extends the shared date-range schema rather than adding
 * `userId` to it — the other routes using DateRangeQuerySchema have no
 * per-user dimension, and this filter narrows only the AI-cost breakdown.
 */
export const OverviewQuerySchema = DateRangeQuerySchema.extend({
  userId: z
    .string()
    .uuid()
    .optional()
    .openapi({ description: 'Narrow the LLM cost breakdown to a single user' }),
});

export const OverviewResponseSchema = z
  .object({
    range: z.object({ from: z.string(), to: z.string() }),
    cashInPaise: z.number(),
    orderCount: z.number(),
    walletSpendPaise: z.number(),
    walletLiabilityPaise: z.number(),
    payingUsers: z.number(),
    arpuPaise: z.number(),
    newUsers: z.number(),
    activeUsers: z.number(),
    timeSeries: z.array(TimeSeriesPointSchema),
    spendByFeature: z.array(SpendByFeatureEntrySchema),
    topUpFunnel: z.array(TopUpFunnelEntrySchema),
    llmCostByAgent: z.array(LlmCostEntrySchema),
  })
  .openapi('AdminOverviewResponse');

/* -------------------------------------------------------------------------- */
/* GET/PUT /admin/features                                                    */
/* -------------------------------------------------------------------------- */

export const AdminFeatureRowSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    group: z.string(),
    enabled: z.boolean(),
    pricePaise: z.number().int().nullable(),
    originalPricePaise: z.number().int().nullable(),
    model: z.string().nullable(),
    modelOptions: z.array(z.string()),
  })
  .openapi('AdminFeatureRow');

export const AdminFeaturesResponseSchema = z
  .object({ features: z.array(AdminFeatureRowSchema) })
  .openapi('AdminFeaturesResponse');

export const UpdateFeatureBodySchema = z
  .object({
    key: z.string().min(1),
    enabled: z.boolean(),
    pricePaise: z.number().int().nullable().optional(),
    originalPricePaise: z.number().int().nullable().optional(),
    /** Omitted = leave the current selection; null = clear it back to the registry default.
     * Validated against the key's own `modelOptions` in updateFeature(). */
    model: z.string().nullable().optional(),
  })
  .openapi('UpdateFeatureBody');

/* -------------------------------------------------------------------------- */
/* GET /admin/users                                                           */
/* -------------------------------------------------------------------------- */

export const AdminUsersQuerySchema = z.object({
  q: z.string().optional(),
  contactType: z.enum(['all', 'phone', 'email']).default('all'),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z
    .enum(['createdAt', 'lastActiveAt', 'walletBalancePaise', 'claimedAt', 'totalPaidPaise'])
    .default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

const AdminUserRowSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  phoneE164: z.string().nullable(),
  email: z.string().nullable(),
  referralSource: z.string().nullable(),
  walletBalancePaise: z.number(),
  createdAt: z.string(),
  lastActiveAt: z.string().nullable(),
  claimedAmountPaise: z.number().nullable(),
  claimedAt: z.string().nullable(),
  totalPaidPaise: z.number(),
  lastPaidAt: z.string().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  timeSpentTodaySec: z.number(),
  timeSpentYesterdaySec: z.number(),
  timeSpentWeekSec: z.number(),
  timeSpentMonthSec: z.number(),
  timeSpentYearSec: z.number(),
});

export const AdminUsersResponseSchema = z
  .object({
    users: z.array(AdminUserRowSchema),
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
  })
  .openapi('AdminUsersResponse');

/* -------------------------------------------------------------------------- */
/* POST /admin/users/:id/wallet                                               */
/* -------------------------------------------------------------------------- */

export const AdminUserIdParamSchema = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
});

export const AdjustWalletBodySchema = z
  .object({
    deltaPaise: z
      .number()
      .int()
      .refine((value) => value !== 0, 'deltaPaise must be non-zero'),
    note: z.string().min(1).max(500),
  })
  .openapi('AdjustWalletBody');

export const AdjustWalletResponseSchema = z
  .object({ walletBalancePaise: z.number() })
  .openapi('AdjustWalletResponse');

/* -------------------------------------------------------------------------- */
/* GET /admin/reports                                                         */
/* -------------------------------------------------------------------------- */

export const AdminReportsResponseSchema = z
  .object({
    reports: z.array(
      z.object({ reportKey: z.string(), totalPaise: z.number(), count: z.number() }),
    ),
  })
  .openapi('AdminReportsResponse');

/* -------------------------------------------------------------------------- */
/* GET/DELETE /admin/report-generations — who generated which report          */
/* -------------------------------------------------------------------------- */

export const AdminReportGenerationsQuerySchema = z.object({
  reportKey: z.string().optional().openapi({ description: 'Omit to list every report key' }),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const AdminReportGenerationRowSchema = z.object({
  id: z.string(),
  userId: z.string(),
  displayName: z.string().nullable(),
  phoneE164: z.string().nullable(),
  reportKey: z.string(),
  status: z.enum(['queued', 'generating', 'ready', 'failed']),
  periodMonth: z.string().nullable(),
  pricePaidPaise: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const AdminReportGenerationsResponseSchema = z
  .object({
    reports: z.array(AdminReportGenerationRowSchema),
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
  })
  .openapi('AdminReportGenerationsResponse');

export const AdminReportGenerationIdParamSchema = z.object({
  id: z
    .string()
    .uuid()
    .openapi({ param: { name: 'id', in: 'path' } }),
});

export const AdminReportGenerationResetResponseSchema = z
  .object({ id: z.string(), status: z.literal('failed') })
  .openapi('AdminReportGenerationResetResponse');

export const AdminReportGenerationsBulkBodySchema = z
  .object({ reportKey: z.string().min(1) })
  .openapi('AdminReportGenerationsBulkBody');

export const AdminReportGenerationsBulkResponseSchema = z
  .object({ count: z.number() })
  .openapi('AdminReportGenerationsBulkResponse');

/* -------------------------------------------------------------------------- */
/* GET /admin/report-ratings                                                  */
/* -------------------------------------------------------------------------- */

export const AdminReportRatingsQuerySchema = z.object({
  reportKey: z.string().optional().openapi({ description: 'Omit to list every report key' }),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const AdminReportRatingRowSchema = z.object({
  id: z.string(),
  userId: z.string(),
  displayName: z.string().nullable(),
  phoneE164: z.string().nullable(),
  reportKey: z.string(),
  rating: z.number(),
  comment: z.string().nullable(),
  refundedPaise: z.number().nullable(),
  createdAt: z.string(),
});

export const AdminReportRatingsResponseSchema = z
  .object({
    ratings: z.array(AdminReportRatingRowSchema),
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
  })
  .openapi('AdminReportRatingsResponse');

const AdminNextReportVoteRowSchema = z.object({
  reportKey: z.string(),
  label: z.string(),
  count: z.number(),
});

export const AdminNextReportVotesResponseSchema = z
  .object({ votes: z.array(AdminNextReportVoteRowSchema) })
  .openapi('AdminNextReportVotesResponse');

/* -------------------------------------------------------------------------- */
/* GET /admin/referrals                                                        */
/* -------------------------------------------------------------------------- */

const AdminReferredUserSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  phoneE164: z.string().nullable(),
  createdAt: z.string(),
});

const AdminReferralRowSchema = z.object({
  referrer: z.object({
    id: z.string(),
    displayName: z.string().nullable(),
    phoneE164: z.string().nullable(),
  }),
  count: z.number().int(),
  referredUsers: z.array(AdminReferredUserSchema),
});

export const AdminReferralsResponseSchema = z
  .object({ referrals: z.array(AdminReferralRowSchema) })
  .openapi('AdminReferralsResponse');

/* -------------------------------------------------------------------------- */
/* GET/POST/PATCH/DELETE /admin/deletion-requests                            */
/* -------------------------------------------------------------------------- */

const AdminDeletionRequestRowSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  phoneE164: z.string().nullable(),
  email: z.string().nullable(),
  deletionRequestedAt: z.string(),
});

export const AdminDeletionRequestsResponseSchema = z
  .object({ requests: z.array(AdminDeletionRequestRowSchema) })
  .openapi('AdminDeletionRequestsResponse');

export const AdminDeletionActionResponseSchema = z
  .object({ id: z.string(), deletionRequestedAt: z.string().nullable() })
  .openapi('AdminDeletionActionResponse');

const AdminRecurringUsersWeekSchema = z.object({
  label: z.enum(['this_week', 'last_week', 'last_week_plus_1', 'last_week_plus_2']),
  from: z.string(),
  to: z.string(),
  activeUsers: z.number().int(),
  recurringUsers: z.number().int(),
  timeSpentHours: z.number(),
});

export const AdminRecurringUsersResponseSchema = z
  .object({ weeks: z.array(AdminRecurringUsersWeekSchema) })
  .openapi('AdminRecurringUsersResponse');

/* -------------------------------------------------------------------------- */
/* GET /admin/active-users/by-location                                       */
/* -------------------------------------------------------------------------- */

export const AdminActiveUsersByLocationQuerySchema = z.object({
  preset: z.string().default('today').openapi({
    example: 'today',
    description: 'today | yesterday | last7d | this_month | this_year',
  }),
});

const AdminLocationCountRowSchema = z.object({
  country: z.string().nullable(),
  city: z.string().nullable(),
  totalUsers: z.number().int(),
});

export const AdminActiveUsersByLocationResponseSchema = z
  .object({ locations: z.array(AdminLocationCountRowSchema) })
  .openapi('AdminActiveUsersByLocationResponse');

const AdminDemographicsBucketSchema = z.object({ label: z.string(), count: z.number().int() });

export const AdminUserDemographicsResponseSchema = z
  .object({
    ageBrackets: z.array(AdminDemographicsBucketSchema),
    gender: z.array(AdminDemographicsBucketSchema),
    relationshipStatus: z.array(AdminDemographicsBucketSchema),
    incomeBrackets: z.array(AdminDemographicsBucketSchema),
    familyIncomeBrackets: z.array(AdminDemographicsBucketSchema),
  })
  .openapi('AdminUserDemographicsResponse');
