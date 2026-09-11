import { payoutOf } from '../features/features.service.js';
import { claimCampaignBonus } from '../users/users.repo.js';
import { PERMISSION_REWARDS, type PermissionRewardKind } from '../../config/permission-rewards.js';

/**
 * Pay a one-time permission reward, the first time only.
 *
 * Exactly-once comes free from `claimCampaignBonus`: it locks the user row and
 * refuses a second ledger insert for the same `reason`, so a double tap, a
 * retry, or two devices racing all collapse to one credit and the later calls
 * return `claimed: false` with the unchanged balance.
 *
 * Granted without an `expiresAt` — unlike the daily ladder these do not decay,
 * so they never become an expiring lot that drains ahead of money the user
 * actually paid for.
 */
export async function grantPermissionReward(
  userId: string,
  kind: PermissionRewardKind,
): Promise<{ claimed: boolean; walletBalancePaise: number }> {
  const def = PERMISSION_REWARDS[kind];
  const amountPaise = await payoutOf(userId, def.featureKey, def.fallbackPaise);
  return claimCampaignBonus(userId, def.reason, amountPaise);
}
