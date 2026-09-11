import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  payoutOf: vi.fn(),
  claimCampaignBonus: vi.fn(),
}));

vi.mock('../src/modules/features/features.service.js', () => ({ payoutOf: state.payoutOf }));
vi.mock('../src/modules/users/users.repo.js', () => ({
  claimCampaignBonus: state.claimCampaignBonus,
}));

import { grantPermissionReward } from '../src/modules/rewards/permission-rewards.service.js';
import { PERMISSION_REWARDS, PERMISSION_REWARD_REASONS } from '../src/config/permission-rewards.js';
import { CLAIM_CAMPAIGN_KEYS } from '../src/config/campaigns.js';

beforeEach(() => {
  state.payoutOf.mockReset();
  state.claimCampaignBonus.mockReset();
  state.claimCampaignBonus.mockResolvedValue({ claimed: true, walletBalancePaise: 2500 });
});

describe('grantPermissionReward', () => {
  it('credits the notification reward under its own ledger reason', async () => {
    state.payoutOf.mockResolvedValue(2500);

    await grantPermissionReward('user-1', 'notifications');

    expect(state.payoutOf).toHaveBeenCalledWith('user-1', 'rewards.notificationsGrant', 2500);
    expect(state.claimCampaignBonus).toHaveBeenCalledWith(
      'user-1',
      'notifications_enabled_reward',
      2500,
    );
  });

  it('credits the location reward under a different reason, so the two never collide', async () => {
    state.payoutOf.mockResolvedValue(2500);

    await grantPermissionReward('user-1', 'location');

    expect(state.claimCampaignBonus).toHaveBeenCalledWith(
      'user-1',
      'location_enabled_reward',
      2500,
    );
    expect(PERMISSION_REWARDS.notifications.reason).not.toBe(PERMISSION_REWARDS.location.reason);
  });

  // The kill switch. `payoutOf` returns 0 for a disabled feature key, and
  // `claimCampaignBonus` refuses a non-positive amount WITHOUT writing a ledger
  // row — so a reward switched off now is merely deferred, not burned, and
  // still pays if an admin switches it on later.
  it('forwards a zero payout when the feature flag is disabled', async () => {
    state.payoutOf.mockResolvedValue(0);
    state.claimCampaignBonus.mockResolvedValue({ claimed: false, walletBalancePaise: 0 });

    const result = await grantPermissionReward('user-1', 'notifications');

    expect(state.claimCampaignBonus).toHaveBeenCalledWith(
      'user-1',
      'notifications_enabled_reward',
      0,
    );
    expect(result.claimed).toBe(false);
  });

  // Passing no `expiresAt` is deliberate: an expiring grant becomes a credit lot
  // that drains ahead of money the user actually paid for.
  it('grants without an expiry, so the credit never becomes a draining lot', async () => {
    state.payoutOf.mockResolvedValue(2500);

    await grantPermissionReward('user-1', 'location');

    expect(state.claimCampaignBonus.mock.calls[0]).toHaveLength(3);
  });
});

describe('permission reward wiring', () => {
  it('reports both reasons on /v1/me, so the client can render claimed state', () => {
    for (const reason of PERMISSION_REWARD_REASONS) {
      expect(CLAIM_CAMPAIGN_KEYS).toContain(reason);
    }
  });

  it('keeps reasons colon-free, matching the ledger prefix convention', () => {
    for (const reason of PERMISSION_REWARD_REASONS) {
      expect(reason).not.toContain(':');
    }
  });
});
