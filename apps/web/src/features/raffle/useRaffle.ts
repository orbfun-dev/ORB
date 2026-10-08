/**
 * The raffle page's data: epoch status, polled.
 *
 * There is no claim queue. ORE entries are awarded by the server's
 * fee-wallet indexer, so the only thing the page does is read: a
 * deploy made on the ORE tab turns into entries here on a later poll.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchRaffleStatus, type RaffleStatus } from "./api";

const STATUS_POLL_MS = 20_000;

export interface RaffleStatusState {
  status: RaffleStatus | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export function useRaffleStatus(wallet: string | null): RaffleStatusState {
  const [status, setStatus] = useState<RaffleStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const next = await fetchRaffleStatus(wallet);
        if (cancelled) return;
        setStatus(next);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        // Keep the last good status on screen. A blank page on one
        // failed poll is worse than a figure that is 20 seconds stale.
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const id = window.setInterval(() => {
      // A background tab polling a promotion forever is rude to both
      // the function budget and the battery.
      if (document.visibilityState === "visible") void load();
    }, STATUS_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [wallet, tick]);

  return { status, error, loading, refresh };
}
