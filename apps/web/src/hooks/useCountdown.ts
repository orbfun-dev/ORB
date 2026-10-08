import { useMemo } from "react";
import { useRoundData } from "../context/RoundDataProvider";

/**
 * Countdown to a round's `end_ts`, corrected for local-clock skew.
 *
 * The chain is the clock: `useRoundAccounts` periodically measures
 * `chainTime − localTime` (getBlockTime of the tip slot) and stores it in
 * provider state as `clockOffsetMs`; every countdown is computed in CHAIN
 * time (`nowMs + offset`). A wildly wrong local clock is clamped rather
 * than trusted (±5 min) — beyond that the user's machine is broken and
 * honoring it would freeze or skip the wheel's window invisibly.
 *
 * BigInt rule: `endTsSec` stays `bigint` through the state tree; the
 * seconds→milliseconds conversion happens here, at the display boundary —
 * unix seconds are ~3×10⁹, far below 2^53, so the conversion is exact.
 */

export interface CountdownView {
  /** Whole milliseconds until `endTs` (0 once expired). */
  remainingMs: number;
  /** Whole seconds remaining, rounded up. */
  totalSeconds: number;
  /** `MM:SS` (minutes grow past 99 naturally). */
  display: string;
  /** Inside the final `urgentSecs` window. */
  isUrgent: boolean;
  isExpired: boolean;
}

/** Sanity bound on measured chain-vs-local skew. */
const MAX_OFFSET_MS = 5 * 60 * 1000;

/** Measured skew: `blockTime` is `getBlockTime()` output (unix SECONDS). */
export function computeChainOffsetMs(blockTimeSec: number, localMs: number): number {
  return blockTimeSec * 1000 - localMs;
}

export function clampOffsetMs(offsetMs: number): number {
  return Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, offsetMs));
}

/** Pure countdown computation — the unit-tested core. */
export function computeCountdown(
  nowMs: number,
  endTsSec: bigint,
  urgentSecs: number,
): CountdownView {
  const endMs = Number(endTsSec) * 1000;
  const remainingMs = Math.max(0, endMs - nowMs);
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return {
    remainingMs,
    totalSeconds,
    display: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
    isUrgent: remainingMs > 0 && remainingMs <= urgentSecs * 1000,
    isExpired: remainingMs === 0,
  };
}

/**
 * Countdown to `endTsSec` (chain seconds). Ticks with the provider's
 * CLOCK_TICK (250 ms) — no own timer, one clock for the whole tree.
 * `isExtended` reflects the anti-snipe cue (end_ts moved while Open).
 */
export function useCountdown(
  endTsSec: bigint | null,
  urgentSecs = 30,
): (CountdownView & { isExtended: boolean }) | null {
  const { state } = useRoundData();
  return useMemo(() => {
    if (endTsSec === null) return null;
    return {
      ...computeCountdown(state.nowMs + state.clockOffsetMs, endTsSec, urgentSecs),
      isExtended: state.antiSnipe !== null,
    };
  }, [state.nowMs, state.clockOffsetMs, state.antiSnipe, endTsSec, urgentSecs]);
}
