/**
 * The slot as of right now, between polls: a clock fitted through the
 * last minute of slot polls (liveSlot.ts), seeded with the cluster's own
 * slot time. Re-renders only when the whole slot changes; the countdown's
 * sub-second ticking and slewing happen inside RoundTimer, not across the
 * whole miner.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { useOreSlot, useOreSnapshot } from "./useOreBoard";
import { orePollInterval, oreRetry, oreRetryDelay } from "./pollPolicy";
import {
  NOMINAL_MS_PER_SLOT,
  clockSlotAt,
  fitSlotClock,
  msPerSlotFromSamples,
  type SlotAnchor,
  type SlotClock,
} from "../liveSlot";

/** How often the whole-slot estimate is re-read. */
const SLOT_TICK_MS = 100;
/** The cluster's samples cover ~60 s each; re-reading faster learns nothing. */
const SLOT_TIME_POLL_MS = 60_000;
/** Polls the clock is fitted through: a minute of 5 s polls. */
const FIT_WINDOW_MS = 60_000;

/** Mainnet's measured slot time from its own performance samples. */
function useClusterMsPerSlot(): number | null {
  const { connection } = useConnection();
  const query = useQuery({
    queryKey: ["ore-lite", "slot-time"],
    queryFn: async () => msPerSlotFromSamples(await connection.getRecentPerformanceSamples(3)),
    refetchInterval: orePollInterval(SLOT_TIME_POLL_MS),
    retry: oreRetry,
    retryDelay: oreRetryDelay,
    refetchOnWindowFocus: false,
  });
  return query.data ?? null;
}

export interface LiveSlot {
  /** Whole slot now, estimated; null until the first poll lands. */
  slot: bigint | null;
  /** The fitted clock the estimate (and the countdown) runs on. */
  clock: SlotClock | null;
}

export function useLiveSlot(): LiveSlot {
  const polled = useOreSlot().data;
  const snapshot = useOreSnapshot();
  const clusterMsPerSlot = useClusterMsPerSlot();

  // The dedicated slot poll feeds the fit: a single cheap call, timed at
  // its midpoint. The snapshot's slot (read alongside several accounts,
  // so its timing is looser) only stands in until that first poll lands.
  const window = useRef<SlotAnchor[]>([]);
  const [anchors, setAnchors] = useState<readonly SlotAnchor[]>([]);
  useEffect(() => {
    if (polled === undefined) return;
    const kept = window.current.filter((a) => polled.atMs - a.atMs <= FIT_WINDOW_MS && a !== polled);
    window.current = [...kept, polled];
    setAnchors(window.current);
  }, [polled]);

  const fallbackSlot = snapshot.data?.slot;
  const fallbackAt = snapshot.dataUpdatedAt;
  const clock = useMemo(() => {
    const prior = clusterMsPerSlot ?? NOMINAL_MS_PER_SLOT;
    if (anchors.length > 0) return fitSlotClock(anchors, prior);
    if (fallbackSlot !== undefined) return fitSlotClock([{ slot: fallbackSlot, atMs: fallbackAt }], prior);
    return null;
  }, [anchors, clusterMsPerSlot, fallbackSlot, fallbackAt]);

  const [slot, setSlot] = useState<bigint | null>(null);
  useEffect(() => {
    if (clock === null) return;
    // Slots only move forward: a new fit landing a hair behind the old
    // one must not flip the phase back for a tick.
    const read = (): void => {
      const next = BigInt(Math.floor(clockSlotAt(clock, Date.now())));
      setSlot((prev) => (prev !== null && prev > next ? prev : next));
    };
    read();
    const id = setInterval(read, SLOT_TICK_MS);
    return () => clearInterval(id);
  }, [clock]);

  return { slot, clock };
}
