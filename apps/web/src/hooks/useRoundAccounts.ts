/**
 * Account reads: websocket-first with an ADAPTIVE poll (roadmap 7.2, RPC
 * diet pass).
 *
 * `accountSubscribe` on the config, mega-pot, and active-round PDAs gives
 * instant decoded updates for free — the poll is only the degradation
 * fallback and the rollover detector, so its cadence follows proven
 * websocket health instead of running flat-out:
 *
 *   websocket proven alive (a push within WS_ALIVE_MS) → every 15 s
 *   never/not recently seen a push                       → every 3 s
 *   tab hidden                                           → every 60 s
 *   consecutive fetch errors (incl. 429)                 → 3 s doubling to 30 s
 *
 * The error backoff resets on the first success. Without it a failing or
 * misconfigured endpoint (the 2026-10-07 rate-limit incident) is polled
 * at the flat 3 s floor forever — an outage that keeps paying for itself.
 *
 * and one immediate refresh fires on tab-visible. Each poll is ONE
 * batched `getMultipleAccounts` (config + mega-pot + the subscribed
 * round); a rollover costs one extra targeted `fetchRound` — the config
 * push also triggers that instantly, so round switches stay snappy.
 * Feed health reflects BOTH channels: a fresh websocket notification
 * ⇒ "live"; no notification for 10 s (or none at all) while the poll
 * succeeds ⇒ "polling" — never a stuck "connecting" on a quiet validator.
 *
 * Every ~10th visible poll the tip slot's block time is measured against
 * the local clock; the clamped offset feeds every countdown (useCountdown).
 *
 * TWO round subscriptions, never more: the active round, and the one
 * before it. The keeper opens N+1 about two seconds after locking N, and
 * N settles ~30 s later — so the round whose outcome the player is
 * waiting for is almost never the active one. Its pushes dispatch as
 * `PREVIOUS_ROUND_UPDATED`. (The old code subscribed every round it ever
 * followed and never unsubscribed, and those stale pushes dispatched as
 * the ACTIVE round — dragging the page back a round until the next poll.)
 */

import { useEffect, useRef } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  configKey,
  decodeGlobalConfig,
  decodeMegaPotVault,
  decodeRound,
  megaPotKey,
  roundKey,
  type OrbitJackpotClient,
  type RoundData,
} from "@orbit-jackpot/sdk";
import type { FeedStatus, RoundDispatch } from "../context/RoundDataProvider";
import { clampOffsetMs, computeChainOffsetMs } from "./useCountdown";

const POLL_HEALTHY_MS = 15_000;
const POLL_DEGRADED_MS = 3_000;
const POLL_HIDDEN_MS = 60_000;
/** Cap for the consecutive-error backoff ladder (3 → 6 → 12 → 24 → 30 s). */
const POLL_ERROR_CAP_MS = 30_000;
const WS_STALE_MS = 10_000;
/** Wider than the badge window: a push this recently proves the socket
 * works, so the poll may stretch (it is only the fallback). */
const WS_ALIVE_MS = 60_000;
/** Measure chain-clock offset every Nth visible poll (~150 s healthy). */
const CLOCK_SYNC_EVERY_N_POLLS = 10;

const isHidden = (): boolean => typeof document !== "undefined" && document.hidden;

interface UseRoundAccountsArgs {
  enabled: boolean;
  client: OrbitJackpotClient;
  dispatch: RoundDispatch;
}

export function useRoundAccounts({ enabled, client, dispatch }: UseRoundAccountsArgs): void {
  // Ref, not state: the effect must not re-run when the active round moves.
  const activeRoundIdRef = useRef<bigint | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let lastWsAt = 0;
    let pollCount = 0;
    let errorStreak = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const disposers: Array<() => void> = [];
    /** Round id → its subscription's disposer (active + previous only). */
    const roundSubs = new Map<bigint, () => void>();

    const onAccount = (
      pubkey: PublicKey,
      dispatchDecoded: (data: Buffer) => void,
    ): (() => void) => {
      const id = client.connection.onAccountChange(
        pubkey,
        (info) => {
          lastWsAt = Date.now();
          try {
            dispatchDecoded(info.data);
          } catch {
            // Malformed account data: the poll floor re-syncs shortly.
          }
          reportStatus();
        },
        "confirmed",
      );
      return () => void client.connection.removeAccountChangeListener(id);
    };

    // A round PDA's pushes route by WHICH round it is at push time: the
    // active one updates the live slot, anything older is `previous`.
    const subscribeRound = (roundId: bigint): void => {
      if (roundSubs.has(roundId)) return;
      roundSubs.set(
        roundId,
        onAccount(roundKey(roundId), (data) => {
          const round = decodeRound(data);
          dispatch(
            roundId === activeRoundIdRef.current
              ? { type: "ACCOUNTS_UPDATED", round }
              : { type: "PREVIOUS_ROUND_UPDATED", round },
          );
        }),
      );
    };

    const reportStatus = (): void => {
      if (!alive) return;
      // Polling health, not just websocket traffic: a healthy poll with an
      // idle websocket (quiet validator) is "polling", never a permanent
      // "connecting" — the initial "connecting" only lasts until the first
      // refresh or notification reports in.
      const status: FeedStatus =
        lastWsAt !== 0 && Date.now() - lastWsAt <= WS_STALE_MS ? "live" : "polling";
      dispatch({ type: "FEED_STATUS", status });
    };

    async function syncClock(): Promise<void> {
      try {
        const epoch = await client.connection.getEpochInfo();
        const blockTime = await client.connection.getBlockTime(epoch.absoluteSlot);
        if (alive && blockTime !== null) {
          dispatch({
            type: "CLOCK_SYNC",
            offsetMs: clampOffsetMs(computeChainOffsetMs(blockTime, Date.now())),
          });
        }
      } catch {
        // keep the previous offset — the next window retries
      }
    }

    // Follow the active round: one targeted read + the PDA subscription.
    // Called on rollover from BOTH the batched poll and the config push;
    // `prefetched` (the poll's own rollover fetch) saves a second read.
    async function followRound(roundId: bigint, prefetched?: RoundData | null): Promise<void> {
      const outgoing = activeRoundIdRef.current;
      activeRoundIdRef.current = roundId;
      if (roundId === 0n) return;
      // Rounds are sequential and N+1 only opens once N left Open, so the
      // round still drawing is always `roundId - 1`.
      const previousId = roundId > 1n ? roundId - 1n : null;
      for (const [id, dispose] of roundSubs) {
        if (id !== roundId && id !== previousId) {
          dispose();
          roundSubs.delete(id);
        }
      }
      subscribeRound(roundId);
      if (previousId !== null) subscribeRound(previousId);
      if (prefetched === undefined) {
        try {
          const round = await client.fetchRound(roundId);
          if (alive && round !== null) {
            dispatch({ type: "ACCOUNTS_UPDATED", round });
          }
        } catch {
          // the next poll re-syncs the round
        }
      }
      // On a live rollover the reducer already froze the outgoing round's
      // book. After a reload (or a tab that slept through rollovers) the
      // page never saw it — read it once so its settle can still be shown
      // and credited.
      if (previousId !== null && outgoing !== previousId) {
        try {
          const previous = await client.fetchRound(previousId);
          if (alive && previous !== null) {
            dispatch({ type: "PREVIOUS_ROUND_UPDATED", round: previous });
          }
        } catch {
          // its subscription still delivers the next change
        }
      }
    }

    async function refresh(): Promise<void> {
      try {
        // ONE batched read: config + mega-pot + the subscribed round. The
        // round key is the currently-followed id (0 before the first
        // refresh resolves); a moved config.active_round_id costs one
        // extra targeted fetchRound below — only on rollover.
        const subscribed = activeRoundIdRef.current ?? 0n;
        const infos = await client.connection.getMultipleAccountsInfo(
          [configKey(), megaPotKey(), roundKey(subscribed)],
          "confirmed",
        );
        if (!alive) return;
        const [cfgInfo, megaInfo, roundInfo] = infos;
        if (cfgInfo === null) {
          // Reachable endpoint but no config account: the wrong-cluster
          // signature — back off like an error, never poll it at the floor.
          errorStreak += 1;
          dispatch({ type: "FEED_STATUS", status: "offline" });
          return;
        }
        const config = decodeGlobalConfig(cfgInfo.data);
        const megaPot = megaInfo !== null ? decodeMegaPotVault(megaInfo.data) : null;
        let round = roundInfo !== null ? decodeRound(roundInfo.data) : null;
        if (config.activeRoundId !== subscribed) {
          const fresh = await client.fetchRound(config.activeRoundId);
          if (!alive) return;
          round = fresh;
        }
        dispatch({ type: "ACCOUNTS_UPDATED", config, round, megaPot });
        errorStreak = 0;
        reportStatus();

        // Round rollover: follow config.active_round_id to the new PDA.
        if (activeRoundIdRef.current !== config.activeRoundId) {
          await followRound(config.activeRoundId, round);
        }

        pollCount += 1;
        if (!isHidden() && pollCount % CLOCK_SYNC_EVERY_N_POLLS === 1) {
          void syncClock();
        }
      } catch (err) {
        if (alive) {
          errorStreak += 1;
          dispatch({
            type: "FEED_STATUS",
            status: "offline",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    function scheduleNext(): void {
      if (!alive) return;
      const interval = isHidden()
        ? POLL_HIDDEN_MS
        : errorStreak > 0
          ? Math.min(POLL_DEGRADED_MS * 2 ** errorStreak, POLL_ERROR_CAP_MS)
          : lastWsAt !== 0 && Date.now() - lastWsAt <= WS_ALIVE_MS
            ? POLL_HEALTHY_MS
            : POLL_DEGRADED_MS;
      timer = setTimeout(() => {
        void refresh().finally(() => scheduleNext());
      }, interval);
    }

    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      if (timer !== null) clearTimeout(timer);
      void refresh().finally(() => scheduleNext());
    };

    const disposeConfig = onAccount(configKey(), (data) => {
      try {
        const config = decodeGlobalConfig(data);
        dispatch({ type: "ACCOUNTS_UPDATED", config });
        // Instant rollover: the push itself says the active round moved.
        if (activeRoundIdRef.current !== config.activeRoundId) {
          void followRound(config.activeRoundId);
        }
      } catch {
        // Malformed account data: the poll floor re-syncs shortly.
      }
    });
    const disposeMega = onAccount(megaPotKey(), (data) =>
      dispatch({ type: "ACCOUNTS_UPDATED", megaPot: decodeMegaPotVault(data) }),
    );
    disposers.push(disposeConfig, disposeMega);
    void refresh().finally(() => scheduleNext());
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      for (const dispose of disposers) dispose();
      for (const dispose of roundSubs.values()) dispose();
      roundSubs.clear();
      // Reconnection hygiene: forgetting the last-seen round id would keep
      // the rollover check satisfied after a client/connection swap, so the
      // new connection would never subscribe the round PDA. The first
      // refresh of the next setup re-subscribes it.
      activeRoundIdRef.current = null;
    };
  }, [enabled, client, dispatch]);
}
