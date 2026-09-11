import { PERMISSION_REWARD_REASONS } from './permission-rewards.js';

/**
 * One-time "claim a wallet bonus" campaigns — Independence Day today, whatever
 * festival/promo is next later. One entry here (+ a matching `referral.*` key
 * in features.ts for the admin-tunable amount) is the whole cost of a new
 * campaign; the route, ledger idempotency, and `/v1/me` DTO plumbing in
 * users.routes.ts/users.repo.ts all key off `campaign.key` and never change.
 */

export interface ClaimCampaignDef {
  /** Also used as the `wallet_transactions.reason` — must stay prefix-safe (see admin.repo.ts's `split_part` usage). */
  key: string;
  /** Feature-registry key resolving the payout amount; disabling it is this campaign's kill switch. */
  featureKey: string;
  /** Fail-open fallback paise, used only if the feature registry has no override yet. */
  fallbackPaise: number;
  /** Claimable only on this IST calendar date (YYYY-MM-DD), enforced server-side in the route. */
  istDate: string;
  /**
   * Optional eligibility ceiling: claimable only while the wallet is strictly
   * below this many paise. Re-checked server-side at claim time, so a user who
   * recharges after being notified no longer qualifies. Omit for "everyone".
   */
  maxBalancePaise?: number;
}

export const CLAIM_CAMPAIGNS: readonly ClaimCampaignDef[] = [
  {
    key: 'independence_day_2026',
    featureKey: 'referral.independenceBonus',
    fallbackPaise: 50000,
    istDate: '2026-08-15',
  },
  // Running-low top-up: ₹100 for anyone whose wallet is under ₹100, announced
  // by push and claimed from the modal the same day.
  {
    key: 'top_up_bonus_2026_08_16',
    featureKey: 'referral.topUpBonus',
    fallbackPaise: 10000,
    istDate: '2026-08-16',
    maxBalancePaise: 10000,
  },
  // Same running-low top-up, re-run a day later for wallets still under ₹100.
  {
    key: 'top_up_bonus_2026_08_17',
    featureKey: 'referral.topUpBonus',
    fallbackPaise: 10000,
    istDate: '2026-08-17',
    maxBalancePaise: 10000,
  },
  // Next event: add a new entry here + a matching referral.* key in features.ts.
];

export function findClaimCampaign(key: string): ClaimCampaignDef | undefined {
  return CLAIM_CAMPAIGNS.find((c) => c.key === key);
}

/**
 * Every ledger `reason` that `/v1/me` should report back as already claimed.
 *
 * This is only ever passed to `getClaimedCampaignKeys()`, never used to decide
 * what is claimable, so the permission rewards ride along here to light up
 * their claimed state on the client without needing their own DTO field. They
 * are not campaigns and deliberately have no date window — see
 * config/permission-rewards.ts.
 */
export const CLAIM_CAMPAIGN_KEYS: readonly string[] = [
  ...CLAIM_CAMPAIGNS.map((c) => c.key),
  ...PERMISSION_REWARD_REASONS,
];
