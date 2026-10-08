/**
 * Board/Config/Treasury + slot polling. One react-query entry point
 * (`useOreSnapshot`) feeds this hook, `useOreRound` and `useOreMiner` —
 * identical query key ⇒ one network poll, three derived views.
 */

import { useMemo } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { OreClient, type OreSnapshot } from "../client";
import type { SlotAnchor } from "../liveSlot";
import { orePollInterval, oreRetry, oreRetryDelay } from "./pollPolicy";

export function useOreClient(): OreClient {
  const { connection } = useConnection();
  return useMemo(() => new OreClient(connection), [connection]);
}

/**
 * Slot polled every 5 s; the countdown interpolates between polls
 * (liveSlot.ts), re-anchored by each one. The anchor's time is the
 * request's midpoint, which takes most of the network latency out of the
 * estimate. The account snapshot rides on a 5 s poll plus explicit
 * invalidation after any confirmed send. Both carry the shared poll
 * policy (pollPolicy.ts): 429s are never retried in-cycle and the
 * interval backs off exponentially while requests keep failing.
 */
export function useOreSlot(): UseQueryResult<SlotAnchor> {
  const { connection } = useConnection();
  return useQuery({
    queryKey: ["ore-lite", "slot"],
    queryFn: async () => {
      const sentAt = Date.now();
      const slot = BigInt(await connection.getSlot("confirmed"));
      return { slot, atMs: (sentAt + Date.now()) / 2 };
    },
    refetchInterval: orePollInterval(),
    retry: oreRetry,
    retryDelay: oreRetryDelay,
    refetchOnWindowFocus: false,
  });
}

export function useOreSnapshot(): UseQueryResult<OreSnapshot> {
  const { publicKey } = useWallet();
  const client = useOreClient();
  return useQuery({
    queryKey: ["ore-lite", "snapshot", publicKey?.toBase58() ?? null],
    queryFn: () => client.fetchSnapshot(publicKey),
    refetchInterval: orePollInterval(),
    retry: oreRetry,
    retryDelay: oreRetryDelay,
    refetchOnWindowFocus: false,
    staleTime: 2_000,
  });
}

export interface OreBoardView {
  status: UseQueryResult<OreSnapshot>["status"];
  error: unknown;
  board: OreSnapshot["board"] | null;
  config: OreSnapshot["config"] | null;
  treasury: OreSnapshot["treasury"] | null;
  /** `null` while the snapshot is still loading — unknown, not "missing". */
  feeRecipientExists: boolean | null;
  slot: bigint | null;
}

export function useOreBoard(): OreBoardView {
  const query = useOreSnapshot();
  return {
    status: query.status,
    error: query.error,
    board: query.data?.board ?? null,
    config: query.data?.config ?? null,
    treasury: query.data?.treasury ?? null,
    feeRecipientExists: query.data?.feeRecipientExists ?? null,
    slot: query.data?.slot ?? null,
  };
}
