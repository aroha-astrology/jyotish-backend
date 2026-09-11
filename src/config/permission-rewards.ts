/**
 * One-time rewards for granting an OS permission.
 *
 * Deliberately NOT `CLAIM_CAMPAIGNS` entries: those are date-gated promos
 * claimed through the generic `POST /v1/me/claim-bonus/{key}` route, and
 * `isOpenNow` requires today to equal their `istDate`. These are
 * action-triggered and have no window — they pay the first time the grant
 * reaches the server, whenever that is.
 *
 * `reason` doubles as the `wallet_transactions` idempotency key exactly as a
 * campaign key does, so `claimCampaignBonus` gives exactly-once semantics with
 * no extra table. It must stay prefix-safe (see admin.repo.ts's `split_part`).
 *
 * Disabling the feature key is the kill switch: `payoutOf` returns 0 for a
 * disabled key and `claimCampaignBonus` refuses a non-positive amount without
 * writing a ledger row — so a reward switched off now still pays later if it
 * is switched back on, rather than being silently burned.
 */
export interface PermissionRewardDef {
  /** Ledger `reason`, and the idempotency key. */
  reason: string;
  /** Feature-registry key resolving the payout amount; disabling it stops the payout. */
  featureKey: string;
  /** Fail-open fallback paise, used only if the registry has no override yet. */
  fallbackPaise: number;
}

export const PERMISSION_REWARDS = {
  notifications: {
    reason: 'notifications_enabled_reward',
    featureKey: 'rewards.notificationsGrant',
    fallbackPaise: 2500,
  },
  location: {
    reason: 'location_enabled_reward',
    featureKey: 'rewards.locationGrant',
    fallbackPaise: 2500,
  },
} as const satisfies Record<string, PermissionRewardDef>;

export type PermissionRewardKind = keyof typeof PERMISSION_REWARDS;

/** Reported on `/v1/me` as part of `claimedCampaigns` so the client can render claimed state. */
export const PERMISSION_REWARD_REASONS: readonly string[] = Object.values(PERMISSION_REWARDS).map(
  (r) => r.reason,
);
