/**
 * Miner account for the connected wallet + wallet SOL balance. Both feed
 * the planner (R3 filter needs `miner.deployed`; blockers need balance).
 */

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import type { OreAutomation, OreMiner } from "../codec";
import { useOreSnapshot } from "./useOreBoard";
import { orePollInterval, oreRetry, oreRetryDelay } from "./pollPolicy";

export interface OreMinerView {
  status: "loading" | "error" | "ready";
  miner: OreMiner | null;
  /** Non-null ⇒ manual deploys are blocked (planner "automation-active"). */
  automation: OreAutomation | null;
  balanceLamports: bigint;
  balanceReady: boolean;
}

export function useOreMiner(): OreMinerView {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const snapshot = useOreSnapshot();

  const balance = useQuery({
    queryKey: ["ore-lite", "balance", publicKey?.toBase58() ?? null],
    queryFn: async () =>
      publicKey !== null ? await connection.getBalance(publicKey, "confirmed") : 0,
    enabled: publicKey !== null,
    refetchInterval: orePollInterval(),
    retry: oreRetry,
    retryDelay: oreRetryDelay,
    refetchOnWindowFocus: false,
  });

  return {
    status: snapshot.status === "success" ? "ready" : snapshot.status === "error" ? "error" : "loading",
    miner: snapshot.data?.miner ?? null,
    automation: snapshot.data?.automation ?? null,
    balanceLamports: publicKey !== null ? BigInt(balance.data ?? 0) : 0n,
    balanceReady: publicKey === null || balance.isSuccess,
  };
}
