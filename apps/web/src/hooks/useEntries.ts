/**
 * Entry book loading — incremental by trigger, wholesale by fetch.
 *
 * `fetchEntries` (getProgramAccounts, dataSize 109 + memcmp on round_id)
 * returns the full index-ordered book; the hook refetches ONLY when a
 * trigger moves: the round's `entry_count` grew (account view) or
 * `entriesVersion` bumped (a Deposited event, round rollover, or fixture
 * load). The reducer replaces the whole array — optimistic event entries
 * are discarded in favor of authoritative account bytes. A short debounce
 * collapses a burst of deposits into ONE fetch (the RPC diet pass).
 */

import { useEffect } from "react";
import type { OrbitJackpotClient, RoundData } from "@orbit-jackpot/sdk";
import type { PreviousRound, RoundDispatch } from "../context/RoundDataProvider";

/** Collapses deposit bursts (N deposits ⇒ one authoritative refetch). */
const REFETCH_DEBOUNCE_MS = 500;

interface UseEntriesArgs {
  enabled: boolean;
  client: OrbitJackpotClient;
  round: RoundData | null;
  entriesVersion: number;
  dispatch: RoundDispatch;
}

export function useEntries({ enabled, client, round, entriesVersion, dispatch }: UseEntriesArgs): void {
  const roundId = round?.roundId ?? null;
  const entryCount = round?.entryCount ?? 0;

  useEffect(() => {
    if (!enabled || roundId === null || entryCount === 0) return;
    let alive = true;
    const timer = setTimeout(() => {
      client
        .fetchEntries(roundId)
        .then((entries) => {
          if (alive) dispatch({ type: "ACCOUNTS_UPDATED", entries });
        })
        .catch((err: unknown) => {
          if (alive) {
            dispatch({
              type: "FEED_STATUS",
              status: "polling",
              error: `entries fetch: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        });
    }, REFETCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [enabled, client, roundId, entryCount, entriesVersion, dispatch]);
}


/** Retry pacing for the previous round's one-off book read. */
const PREVIOUS_RETRY_MS = 3_000;
const PREVIOUS_MAX_ATTEMPTS = 3;

interface UsePreviousEntriesArgs {
  enabled: boolean;
  client: OrbitJackpotClient;
  previous: PreviousRound | null;
  dispatch: RoundDispatch;
}

/**
 * The superseded round's book, read ONCE when the page never saw it live —
 * a reload mid-draw, or a tab that slept through the rollover. A live
 * rollover freezes the book in the reducer and never reaches this. Only
 * still-open entries come back, which is exactly the set the chain still
 * owes refunds on.
 */
export function usePreviousEntries({
  enabled,
  client,
  previous,
  dispatch,
}: UsePreviousEntriesArgs): void {
  const roundId = previous?.round.roundId ?? null;
  const needsBook =
    previous !== null &&
    previous.entries.length === 0 &&
    previous.round.entryCount > previous.round.entriesClosed;

  useEffect(() => {
    if (!enabled || roundId === null || !needsBook) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = (n: number): void => {
      client
        .fetchEntries(roundId)
        .then((entries) => {
          if (alive && entries.length > 0) dispatch({ type: "PREVIOUS_ROUND_UPDATED", entries });
        })
        .catch(() => {
          if (alive && n < PREVIOUS_MAX_ATTEMPTS) {
            timer = setTimeout(() => attempt(n + 1), PREVIOUS_RETRY_MS);
          }
        });
    };
    attempt(1);
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [enabled, client, roundId, needsBook, dispatch]);
}
