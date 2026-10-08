/**
 * What the connected wallet can claim right now: SOL, unrefined ORE and
 * refined ORE (rewards.ts). When the miner's last round has settled but
 * was never checkpointed, its winnings are read from a simulated
 * Checkpoint — every claim transaction runs that Checkpoint first, so
 * they are claimable now, exactly as the official ore-starter-app shows.
 */

import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { type OreRewards, resolveRewards } from "../rewards";
import { useOreClient, useOreSnapshot } from "./useOreBoard";
import { oreRetry, oreRetryDelay } from "./pollPolicy";

export interface OreRewardsView {
  /** `null` with no wallet, no miner account yet, or before the first read. */
  rewards: OreRewards | null;
  /** The miner's round — the Checkpoint every claim runs first. */
  minerRoundId: bigint | null;
  /** Set when the claim will also record this round's winnings. */
  unrecordedRoundId: bigint | null;
}

export function useOreRewards(): OreRewardsView {
  const { publicKey } = useWallet();
  const client = useOreClient();
  const snapshot = useOreSnapshot();
  const miner = snapshot.data?.miner ?? null;
  const board = snapshot.data?.board ?? null;
  const treasury = snapshot.data?.treasury ?? null;
  const automation = snapshot.data?.automation ?? null;

  // Checkpoint does anything only for a finished round it has not seen.
  const needsCheckpoint =
    miner !== null && board !== null && miner.checkpointId !== miner.roundId && miner.roundId < board.roundId;

  const checkpointed = useQuery({
    // Strings, not bigints — react-query hashes keys with JSON.stringify.
    queryKey: [
      "ore-lite",
      "checkpointed-miner",
      publicKey?.toBase58() ?? null,
      miner?.roundId.toString() ?? null,
      miner?.checkpointId.toString() ?? null,
    ],
    queryFn: () => client.simulateCheckpointedMiner(publicKey!, miner!.roundId),
    enabled: publicKey !== null && needsCheckpoint,
    staleTime: 30_000,
    retry: oreRetry,
    retryDelay: oreRetryDelay,
    refetchOnWindowFocus: false,
  });

  return useMemo(() => {
    if (miner === null || treasury === null) {
      return { rewards: null, minerRoundId: null, unrecordedRoundId: null };
    }
    const rewards = resolveRewards(miner, needsCheckpoint ? (checkpointed.data ?? null) : null, treasury, {
      reloadsToAutomation: automation !== null && automation.reload > 0n,
    });
    const unrecorded = rewards.unrecordedSol > 0n || rewards.unrecordedOre > 0n;
    return { rewards, minerRoundId: miner.roundId, unrecordedRoundId: unrecorded ? miner.roundId : null };
  }, [automation, checkpointed.data, miner, needsCheckpoint, treasury]);
}
