/**
 * Rewards math — mirrors ore `Miner::update_rewards` / `Miner::claim_ore`
 * (api/src/state/miner.rs @ 48c203b) so the panel's preview is exactly
 * what the claim will pay.
 */

import { describe, expect, it } from "vitest";
import {
  accruedRefinedOre,
  previewClaimOre,
  resolveRewards,
} from "../src/features/ore-lite/rewards";

const ONE = 2n ** 48n; // I80F48 1.0

describe("accruedRefinedOre (Miner::update_rewards)", () => {
  it("adds factor growth × unrefined, floored, to the stored refined balance", () => {
    // factor grew by 0.25 since the miner last synced: 1000 × 0.25 = 250.
    expect(
      accruedRefinedOre({ refinedOre: 100n, rewardsOre: 1_000n, rewardsFactor: 2n * ONE }, 2n * ONE + ONE / 4n),
    ).toBe(350n);
  });

  it("floors sub-gram accruals to zero", () => {
    expect(accruedRefinedOre({ refinedOre: 7n, rewardsOre: 1_000n, rewardsFactor: ONE }, ONE + 1n)).toBe(7n);
  });

  it("never subtracts when the treasury factor is not ahead", () => {
    expect(accruedRefinedOre({ refinedOre: 7n, rewardsOre: 1_000n, rewardsFactor: 5n * ONE }, 4n * ONE)).toBe(7n);
  });
});

describe("previewClaimOre (Miner::claim_ore)", () => {
  it("claims both balances at 100% and charges 10% on the unrefined part only", () => {
    expect(previewClaimOre({ refined: 50n, unrefined: 1_000n, bps: 10_000n, totalUnclaimed: 5_000n })).toEqual({
      claimRefined: 50n,
      claimUnrefined: 1_000n,
      fee: 100n,
      amount: 950n,
    });
  });

  it("applies the same bps to both balances, flooring each", () => {
    expect(previewClaimOre({ refined: 50n, unrefined: 1_000n, bps: 2_500n, totalUnclaimed: 5_000n })).toEqual({
      claimRefined: 12n,
      claimUnrefined: 250n,
      fee: 25n,
      amount: 237n,
    });
  });

  it("charges at least 1 gram whenever unrefined ORE is claimed", () => {
    expect(previewClaimOre({ refined: 0n, unrefined: 5n, bps: 10_000n, totalUnclaimed: 5_000n }).fee).toBe(1n);
  });

  it("charges nothing when no one else holds unrefined ORE to receive the fee", () => {
    expect(previewClaimOre({ refined: 0n, unrefined: 1_000n, bps: 10_000n, totalUnclaimed: 1_000n })).toEqual({
      claimRefined: 0n,
      claimUnrefined: 1_000n,
      fee: 0n,
      amount: 1_000n,
    });
  });

  it("charges nothing on refined-only claims and clamps bps to 100%", () => {
    expect(previewClaimOre({ refined: 80n, unrefined: 0n, bps: 20_000n, totalUnclaimed: 5_000n })).toEqual({
      claimRefined: 80n,
      claimUnrefined: 0n,
      fee: 0n,
      amount: 80n,
    });
  });
});

describe("resolveRewards", () => {
  const onchain = {
    rewardsSol: 10n,
    rewardsOre: 100n,
    refinedOre: 5n,
    rewardsFactor: ONE,
    lifetimeRewardsSol: 1_000n,
    autoReturn: 0n,
  };
  const treasury = { minerRewardsFactor: ONE, totalUnclaimed: 1_000n };

  it("reads the miner as stored when there is nothing to checkpoint", () => {
    expect(resolveRewards(onchain, null, treasury, { reloadsToAutomation: false })).toEqual({
      sol: 10n,
      solInMiner: 10n,
      unrefined: 100n,
      refined: 5n,
      unrecordedSol: 0n,
      unrecordedOre: 0n,
      totalUnclaimed: 1_000n,
    });
  });

  it("auto_return off: the checkpoint credits rewards_sol, which ClaimSOL pays", () => {
    const checkpointed = { ...onchain, rewardsSol: 40n, rewardsOre: 300n, lifetimeRewardsSol: 1_030n };
    expect(resolveRewards(onchain, checkpointed, treasury, { reloadsToAutomation: false })).toEqual({
      sol: 40n,
      solInMiner: 40n,
      unrefined: 300n,
      refined: 5n,
      unrecordedSol: 30n,
      unrecordedOre: 200n,
      // The checkpoint adds the new unrefined ORE to the treasury total too.
      totalUnclaimed: 1_200n,
    });
  });

  // ore's default. The checkpoint sends the round's SOL straight to the
  // wallet and rewards_sol never moves — the bug that hid every win
  // (mainnet 2026-10-08: 0.0089496 SOL shown on ore.com, 0 here).
  it("auto_return on: SOL the checkpoint pays to the wallet still counts as claimable", () => {
    const am = { ...onchain, autoReturn: 1n, rewardsSol: 0n };
    const checkpointed = { ...am, lifetimeRewardsSol: 1_000n + 8_949_600n };
    expect(resolveRewards(am, checkpointed, treasury, { reloadsToAutomation: false })).toMatchObject({
      sol: 8_949_600n,
      solInMiner: 0n,
      unrecordedSol: 8_949_600n,
    });
  });

  it("automation with reload: the round's SOL funds the automation, not the wallet", () => {
    const checkpointed = { ...onchain, autoReturn: 1n, lifetimeRewardsSol: 1_500n };
    expect(resolveRewards(onchain, checkpointed, treasury, { reloadsToAutomation: true })).toMatchObject({
      sol: 10n,
      solInMiner: 10n,
      unrecordedSol: 0n,
    });
  });
});
