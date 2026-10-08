/**
 * Claimable-rewards math — PURE. Mirrors ore `Miner::update_rewards` and
 * `Miner::claim_ore` (api/src/state/miner.rs @ 48c203b) so the panel shows
 * exactly what a claim pays, the way the official ore-starter-app does.
 *
 * A miner holds three balances:
 *  - SOL (`rewards_sol`);
 *  - unrefined ORE (`rewards_ore`) — mined; claiming it costs a 10% refining
 *    fee, which is paid out to everyone still holding unrefined ORE;
 *  - refined ORE (`refined_ore`) — earned from other miners' refining fees,
 *    claimed fee-free. It accrues lazily through the treasury's rewards
 *    factor, so the stored figure lags until the next sync.
 * One ClaimORE takes the same bps of BOTH ORE balances.
 */

import type { OreMiner, OreTreasury } from "./codec";

export const DENOMINATOR_BPS = 10_000n;
/** I80F48 fractional bits. */
const NUMERIC_FRAC_BITS = 48n;

/** Refined ORE including what the treasury factor has accrued since the
 *  miner's last sync — `Miner::update_rewards`, floored like `to_u64`. */
export function accruedRefinedOre(
  miner: Pick<OreMiner, "refinedOre" | "rewardsOre" | "rewardsFactor">,
  treasuryFactor: bigint,
): bigint {
  if (treasuryFactor <= miner.rewardsFactor) return miner.refinedOre;
  return miner.refinedOre + (((treasuryFactor - miner.rewardsFactor) * miner.rewardsOre) >> NUMERIC_FRAC_BITS);
}

export interface ClaimOrePreview {
  claimRefined: bigint;
  claimUnrefined: bigint;
  /** Refining fee taken from the unrefined part. */
  fee: bigint;
  /** What lands in the wallet. */
  amount: bigint;
}

/**
 * `Miner::claim_ore`: the same bps of each balance; 10% (min 1 gram) of the
 * unrefined part is withheld — unless no one else would hold unrefined ORE
 * to receive it (`total_unclaimed` after this claim is zero).
 */
export function previewClaimOre(args: {
  refined: bigint;
  unrefined: bigint;
  bps: bigint;
  /** Treasury `total_unclaimed` before this claim. */
  totalUnclaimed: bigint;
}): ClaimOrePreview {
  const bps = args.bps < DENOMINATOR_BPS ? args.bps : DENOMINATOR_BPS;
  const claimRefined = (args.refined * bps) / DENOMINATOR_BPS;
  const claimUnrefined = (args.unrefined * bps) / DENOMINATOR_BPS;
  let fee = 0n;
  if (claimUnrefined > 0n && args.totalUnclaimed - claimUnrefined > 0n) {
    const tenth = claimUnrefined / 10n;
    fee = tenth > 1n ? tenth : 1n;
  }
  return { claimRefined, claimUnrefined, fee, amount: claimRefined + claimUnrefined - fee };
}

export interface OreRewards {
  /** SOL a claim puts in the wallet: `solInMiner` plus whatever the
   *  claim's Checkpoint pays out directly (auto_return). */
  sol: bigint;
  /** `rewards_sol` after that Checkpoint — what ClaimSOL itself pays. */
  solInMiner: bigint;
  unrefined: bigint;
  refined: bigint;
  /** Winnings from the miner's last round that a checkpoint will record. */
  unrecordedSol: bigint;
  unrecordedOre: bigint;
  /** Treasury `total_unclaimed` once that checkpoint has run. */
  totalUnclaimed: bigint;
}

type MinerRewardFields = Pick<
  OreMiner,
  "rewardsSol" | "rewardsOre" | "refinedOre" | "rewardsFactor" | "lifetimeRewardsSol" | "autoReturn"
>;

/**
 * The balances a claim will see. `checkpointed` is the miner as a simulated
 * Checkpoint leaves it (client.simulateCheckpointedMiner) — every claim
 * transaction runs that Checkpoint first, so its winnings are claimable
 * now; `null` when there is nothing to checkpoint or the simulation failed.
 *
 * The round's SOL is NOT always in `rewards_sol` afterwards. Checkpoint
 * credits it to `lifetime_rewards_sol` and then (checkpoint.rs) sends it to
 * the automation when one reloads; else, with `auto_return` on — ore's
 * default — straight to the wallet; only otherwise into `rewards_sol`. So
 * the lifetime delta is the round's SOL, and outside the reload case it all
 * reaches the wallet when the claim runs.
 */
export function resolveRewards(
  onchain: MinerRewardFields,
  checkpointed: MinerRewardFields | null,
  treasury: Pick<OreTreasury, "minerRewardsFactor" | "totalUnclaimed">,
  opts: { reloadsToAutomation: boolean },
): OreRewards {
  const miner = checkpointed ?? onchain;
  const roundSol =
    miner.lifetimeRewardsSol > onchain.lifetimeRewardsSol ? miner.lifetimeRewardsSol - onchain.lifetimeRewardsSol : 0n;
  const unrecordedSol = opts.reloadsToAutomation ? 0n : roundSol;
  // auto_return pays the wallet during the Checkpoint; without it the SOL
  // is already inside `rewards_sol`, so it is not added twice.
  const paidByCheckpoint = !opts.reloadsToAutomation && miner.autoReturn > 0n ? roundSol : 0n;
  const unrecordedOre = miner.rewardsOre > onchain.rewardsOre ? miner.rewardsOre - onchain.rewardsOre : 0n;
  return {
    sol: miner.rewardsSol + paidByCheckpoint,
    solInMiner: miner.rewardsSol,
    unrefined: miner.rewardsOre,
    refined: accruedRefinedOre(miner, treasury.minerRewardsFactor),
    unrecordedSol,
    unrecordedOre,
    totalUnclaimed: treasury.totalUnclaimed + unrecordedOre,
  };
}
