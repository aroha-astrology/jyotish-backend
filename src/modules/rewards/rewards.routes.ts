import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { requireUser } from '../../middleware/auth.js';
import { requireFeature } from '../../middleware/feature.js';
import { getDailyRewardState, claimDailyReward } from './rewards.service.js';
import { grantPermissionReward } from './permission-rewards.service.js';
import { DailyRewardStateSchema, ClaimDailyRewardResponseSchema } from './rewards.schemas.js';

const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.string().optional(),
    }),
  })
  .openapi('RewardsError');

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorSchema } },
});

export const rewardsRouter = new OpenAPIHono();

const getDailyRewardRoute = createRoute({
  method: 'get',
  path: '/rewards/daily',
  tags: ['Rewards'],
  summary: "The authenticated user's daily login streak state",
  description:
    'Day 1 pays the admin-configured base amount (rewards.dailyBase), each day after ' +
    'adds a fixed step, and day 7 adds the streak bonus (rewards.streakBonus) on top. ' +
    'Missing a day, or completing day 7, folds the streak back to day 1.',
  security: [{ bearerAuth: [] }],
  middleware: [requireUser, requireFeature('nav.rewards')] as const,
  responses: {
    200: {
      description: 'Current streak state and the 7-day ladder',
      content: { 'application/json': { schema: DailyRewardStateSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Feature disabled for this user'),
  },
});

rewardsRouter.openapi(getDailyRewardRoute, async (c) => {
  const user = c.get('user');
  const state = await getDailyRewardState(user.id);
  return c.json(state, 200);
});

const claimDailyRewardRoute = createRoute({
  method: 'post',
  path: '/rewards/daily/claim',
  tags: ['Rewards'],
  summary: "Claim today's daily login reward",
  description:
    'Idempotent per IST calendar day — a repeat call the same day returns `claimed: false` ' +
    'with the unchanged balance rather than crediting twice.',
  security: [{ bearerAuth: [] }],
  middleware: [requireUser, requireFeature('nav.rewards')] as const,
  responses: {
    200: {
      description: 'Claim result',
      content: { 'application/json': { schema: ClaimDailyRewardResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
    403: errorResponse('Feature disabled for this user'),
  },
});

rewardsRouter.openapi(claimDailyRewardRoute, async (c) => {
  const user = c.get('user');
  const result = await claimDailyReward(user.id);
  return c.json(result, 200);
});

const locationGrantedRoute = createRoute({
  method: 'post',
  path: '/rewards/location-granted',
  tags: ['Rewards'],
  summary: 'Claim the one-time reward for granting location permission',
  description:
    'Idempotent — a repeat call returns `claimed: false` with the unchanged balance. ' +
    'Pays nothing while `rewards.locationGrant` is disabled, and stays claimable for ' +
    'later if it is switched on. Deliberately NOT behind `nav.rewards`: that flag hides ' +
    'the rewards page, while this reward is also reachable from the launch prompt. ' +
    'Trusts the caller, because storing no coordinates leaves nothing to verify against ' +
    '— bounded to one wallet credit per user.',
  security: [{ bearerAuth: [] }],
  middleware: [requireUser] as const,
  responses: {
    200: {
      description: 'Claim result',
      content: { 'application/json': { schema: ClaimDailyRewardResponseSchema } },
    },
    401: errorResponse('Unauthorized'),
  },
});

rewardsRouter.openapi(locationGrantedRoute, async (c) => {
  const user = c.get('user');
  const result = await grantPermissionReward(user.id, 'location');
  return c.json(result, 200);
});
