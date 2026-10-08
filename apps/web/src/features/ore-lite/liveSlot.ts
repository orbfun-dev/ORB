/**
 * The countdown between slot polls.
 *
 * The slot is polled every 5 s (pollPolicy.ts — the rate-limit floor), and
 * a countdown that moves only when a poll lands sits frozen for seconds
 * and then jumps. Snapping to each poll instead is no better: a confirmed
 * slot read from an RPC wobbles by ±2 slots (±0.5 s at mainnet's
 * ~267 ms/slot), so every poll nudges the display and seconds get
 * skipped or doubled.
 *
 * So the display runs a clock, the way NTP disciplines one:
 *  1. fit — a least-squares line through the last minute of polls gives
 *     the slot rate and offset with the per-read wobble averaged out;
 *  2. slew — the countdown shows `deadline − now`, where the deadline is
 *     the wall-clock moment the fit says the target slot lands. When a new
 *     fit moves the deadline, the display closes the gap by running
 *     briefly faster or slower (never more than ±17 %), not by jumping.
 *     It slews the DEADLINE, not the slot: a tiny change in the fitted
 *     rate moves a deadline 300 slots out by whole seconds.
 * The chain stays the authority: every poll feeds the fit, so the
 * estimate cannot wander — which is what R5's "no Date.now() arithmetic
 * on a cached value" was guarding against.
 */

import { U64_MAX, type OreBoard, type OreConfig } from "./codec";

/**
 * Starting guess only — mainnet's slot time drifts (≈267 ms on
 * 2026-10-08, well under the 400 ms the timer once hard-coded, which
 * overstated every countdown by ~1.5×). The live figure comes from
 * `getRecentPerformanceSamples` and the fit.
 */
export const NOMINAL_MS_PER_SLOT = 400;
/** Plausible slot-time band; anything outside is a stalled tab or a bad sample. */
const MIN_MS_PER_SLOT = 150;
const MAX_MS_PER_SLOT = 650;
/** The fit trusts its own rate only over a window at least this long. */
const MIN_FIT_SPAN_MS = 20_000;
/** A slew changes the clock's speed by at most 1/SLEW_FACTOR (≈17 %). */
const SLEW_FACTOR = 6;
/** Deadline moves beyond this are not wobble (first fit, a slept tab): snap. */
const MAX_SLEW_GAP_MS = 5_000;

/** A polled slot and the wall-clock moment it was true. */
export interface SlotAnchor {
  slot: bigint;
  atMs: number;
}

/** `slot(t) = slot0 + (t − t0) / msPerSlot`. */
export interface SlotClock {
  slot0: number;
  t0: number;
  msPerSlot: number;
}

export function clockSlotAt(clock: SlotClock, nowMs: number): number {
  return clock.slot0 + (nowMs - clock.t0) / clock.msPerSlot;
}

function clampRate(msPerSlot: number): number {
  return Math.min(MAX_MS_PER_SLOT, Math.max(MIN_MS_PER_SLOT, msPerSlot));
}

/**
 * Slot time from the cluster's own performance samples (each ~60 s of
 * slots), or null when there is nothing usable.
 */
export function msPerSlotFromSamples(
  samples: ReadonlyArray<{ numSlots: number; samplePeriodSecs: number }>,
): number | null {
  let slots = 0;
  let secs = 0;
  for (const s of samples) {
    if (s.numSlots > 0 && s.samplePeriodSecs > 0) {
      slots += s.numSlots;
      secs += s.samplePeriodSecs;
    }
  }
  if (slots === 0) return null;
  return clampRate((secs * 1_000) / slots);
}

/**
 * Least-squares clock through the anchors. The rate is fitted once the
 * window spans MIN_FIT_SPAN_MS (shorter spans are mostly read noise) and
 * is `priorMsPerSlot` until then; the offset is always the mean over the
 * whole window, which is what averages the ±2-slot wobble away.
 */
export function fitSlotClock(
  anchors: readonly SlotAnchor[],
  priorMsPerSlot: number,
): SlotClock | null {
  if (anchors.length === 0) return null;
  // Centre on the newest anchor so the numbers stay small and exact.
  const ref = anchors[anchors.length - 1]!;
  const xs = anchors.map((a) => a.atMs - ref.atMs);
  const ys = anchors.map((a) => Number(a.slot - ref.slot));
  const n = anchors.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;

  let msPerSlot = clampRate(priorMsPerSlot);
  if (n >= 3 && xs[xs.length - 1]! - xs[0]! >= MIN_FIT_SPAN_MS) {
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i]! - mx) * (ys[i]! - my);
      sxx += (xs[i]! - mx) ** 2;
    }
    const slotsPerMs = sxx > 0 ? sxy / sxx : 0;
    if (slotsPerMs > 0) msPerSlot = clampRate(1 / slotsPerMs);
  }
  // The line through the centroid at that rate.
  return { slot0: Number(ref.slot) + my, t0: ref.atMs + mx, msPerSlot };
}

/** Wall-clock moment the clock reaches `slot`. */
export function slotDeadlineMs(clock: SlotClock, slot: bigint): number {
  return clock.t0 + (Number(slot) - clock.slot0) * clock.msPerSlot;
}

/**
 * A wall-clock deadline as displayed: the target plus a gap that decays
 * linearly to zero over `slewMs` from `atMs`.
 */
export interface SlewedDeadline {
  target: number;
  /** ms the display was later (+) / earlier (−) than `target` at `atMs`. */
  gap: number;
  atMs: number;
  slewMs: number;
}

export function slewedDeadlineAt(s: SlewedDeadline, nowMs: number): number {
  const left = s.slewMs <= 0 ? 0 : Math.max(0, 1 - (nowMs - s.atMs) / s.slewMs);
  return s.target + s.gap * left;
}

/**
 * Move the displayed deadline to `target` without a visible jump: keep
 * what is on screen now and close the gap at ≤ ±17 % clock speed. A gap
 * too large to be wobble (first fit, a slept tab) snaps instead.
 */
export function slewDeadline(
  current: SlewedDeadline | null,
  target: number,
  nowMs: number,
): SlewedDeadline {
  if (current === null) return { target, gap: 0, atMs: nowMs, slewMs: 0 };
  const gap = slewedDeadlineAt(current, nowMs) - target;
  if (Math.abs(gap) > MAX_SLEW_GAP_MS) return { target, gap: 0, atMs: nowMs, slewMs: 0 };
  return { target, gap, atMs: nowMs, slewMs: Math.abs(gap) * SLEW_FACTOR };
}

/**
 * The slot the countdown runs to: the round's end slot while it is open,
 * then the end of the intermission. Null before the first deploy.
 */
export function countdownTargetSlot(
  board: OreBoard,
  config: OreConfig | null,
  slot: bigint,
): bigint | null {
  if (board.endSlot === U64_MAX) return null;
  return slot < board.endSlot ? board.endSlot : board.endSlot + (config?.intermissionSlots ?? 48n);
}

/**
 * The shown whole second, held so it never ticks back UP within one phase
 * of one round (`key`). A safety net under the slew. A new key starts clean.
 */
export function holdMonotonic(
  prev: { key: string; shown: number } | null,
  key: string,
  computed: number,
): { key: string; shown: number } {
  if (prev === null || prev.key !== key) return { key, shown: computed };
  return { key, shown: Math.min(prev.shown, computed) };
}
