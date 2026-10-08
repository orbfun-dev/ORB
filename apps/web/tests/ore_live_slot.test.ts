/**
 * The ORE countdown between polls. The slot is polled every 5 s (the
 * rate-limit floor) and each confirmed-slot read wobbles by ±2 slots, so
 * the display runs a fitted clock and slews toward each new fit rather
 * than jumping. The headline test replays that production wobble and
 * demands what the eye wants: every second shows for about a second, and
 * none is ever skipped or repeated.
 */

import { describe, expect, it } from "vitest";
import {
  NOMINAL_MS_PER_SLOT,
  clockSlotAt,
  countdownTargetSlot,
  fitSlotClock,
  holdMonotonic,
  msPerSlotFromSamples,
  slewDeadline,
  slewedDeadlineAt,
  slotDeadlineMs,
  type SlewedDeadline,
  type SlotAnchor,
  type SlotClock,
} from "../src/features/ore-lite/liveSlot";
import { U64_MAX, type OreBoard, type OreConfig } from "../src/features/ore-lite/codec";

const board = (endSlot: bigint): OreBoard => ({ endSlot }) as OreBoard;
const config = { intermissionSlots: 35n } as OreConfig;

describe("fitSlotClock", () => {
  it("is null with no anchors and passes through a lone anchor at the prior rate", () => {
    expect(fitSlotClock([], 267)).toBeNull();
    const c = fitSlotClock([{ slot: 1_000n, atMs: 10_000 }], 267)!;
    expect(clockSlotAt(c, 10_000)).toBeCloseTo(1_000, 9);
    expect(c.msPerSlot).toBe(267);
  });

  it("recovers rate and offset from clean polls once the window is long enough", () => {
    const anchors = Array.from({ length: 12 }, (_, i) => ({
      slot: BigInt(Math.round(5_000 + (i * 5_000) / 267)),
      atMs: i * 5_000,
    }));
    const c = fitSlotClock(anchors, NOMINAL_MS_PER_SLOT)!;
    expect(c.msPerSlot).toBeCloseTo(267, -1);
    expect(clockSlotAt(c, 55_000)).toBeCloseTo(5_000 + 55_000 / 267, 0);
  });

  it("keeps the prior rate over a short window (read noise, not signal)", () => {
    const c = fitSlotClock(
      [
        { slot: 1_000n, atMs: 0 },
        { slot: 1_030n, atMs: 5_000 },
      ],
      267,
    )!;
    expect(c.msPerSlot).toBe(267);
  });
});

describe("slewDeadline / slewedDeadlineAt", () => {
  it("starts on the first deadline exactly", () => {
    const d = slewDeadline(null, 10_000, 0);
    expect(slewedDeadlineAt(d, 0)).toBe(10_000);
    expect(slewedDeadlineAt(d, 5_000)).toBe(10_000);
  });

  it("closes a small move gradually: continuous at the switch, converged after the slew", () => {
    const d0 = slewDeadline(null, 10_000, 0);
    const d1 = slewDeadline(d0, 10_500, 1_000); // the fit moved the deadline 500 ms later
    expect(slewedDeadlineAt(d1, 1_000)).toBe(10_000);
    expect(d1.slewMs).toBe(3_000); // 500 ms × 6 ⇒ the clock runs at ~83 % for 3 s
    expect(slewedDeadlineAt(d1, 2_500)).toBe(10_250);
    expect(slewedDeadlineAt(d1, 4_000)).toBe(10_500);
  });

  it("keeps the shown time-left falling while slewing either way", () => {
    for (const target of [9_000, 11_000]) {
      const d = slewDeadline(slewDeadline(null, 10_000, 0), target, 1_000);
      let prev = Infinity;
      for (let t = 1_000; t < 8_000; t += 50) {
        const left = slewedDeadlineAt(d, t) - t;
        expect(left).toBeLessThan(prev);
        prev = left;
      }
    }
  });

  it("snaps when the move is too large to be wobble", () => {
    const d = slewDeadline(slewDeadline(null, 10_000, 0), 40_000, 1_000);
    expect(slewedDeadlineAt(d, 1_000)).toBe(40_000);
  });
});

/** Deterministic ±2-slot wobble, like a confirmed-slot read from an RPC. */
function wobble(i: number): number {
  return [0, 2, -1, -2, 1, 2, -2, 0, 1, -1, 2, -2][i % 12]!;
}

/**
 * Replays the hook and RoundTimer together: a poll every 5 s feeds a 60 s
 * window; each fit moves the countdown's deadline, which the display
 * slews toward; the shown second is read every 100 ms.
 */
function simulate(priorMsPerSlot: number, trueMsPerSlot = 267, durationMs = 120_000) {
  const endSlot = BigInt(10_000 + Math.round(durationMs / trueMsPerSlot) + 40);
  const b = board(endSlot);
  const window: SlotAnchor[] = [];
  let fit: SlotClock | null = null;
  let deadline: SlewedDeadline | null = null;
  let held: { key: string; shown: number } | null = null;
  const runs: Array<{ t: number; s: number; ms: number }> = [];
  let poll = 0;
  for (let t = 0; t <= durationMs; t += 100) {
    if (t % 5_000 === 0) {
      const truth = 10_000 + t / trueMsPerSlot;
      window.push({ slot: BigInt(Math.round(truth) + wobble(poll++)), atMs: t });
      while (window.length > 0 && t - window[0]!.atMs > 60_000) window.shift();
      fit = fitSlotClock(window, priorMsPerSlot)!;
      const slot = BigInt(Math.floor(clockSlotAt(fit, t)));
      deadline = slewDeadline(deadline, slotDeadlineMs(fit, countdownTargetSlot(b, config, slot)!), t);
    }
    held = holdMonotonic(held, "round", Math.floor((slewedDeadlineAt(deadline!, t) - t) / 1_000));
    const last = runs[runs.length - 1];
    if (last && last.s === held.shown) last.ms += 100;
    else runs.push({ t, s: held.shown, ms: 100 });
  }
  return runs;
}

describe("countdown under production read wobble", () => {
  it("shows every second for 0.8–1.25 s and never skips or repeats one", () => {
    const runs = simulate(267);
    for (let i = 1; i < runs.length; i++) expect(runs[i - 1]!.s - runs[i]!.s).toBe(1);
    for (const r of runs.slice(1, -1)) {
      expect(r.ms).toBeGreaterThanOrEqual(800);
      expect(r.ms).toBeLessThanOrEqual(1_250);
    }
  });

  it("settles from a wrong 400 ms prior: once the fit has 20 s of polls, no second is skipped", () => {
    const runs = simulate(400).filter((r) => r.t >= 25_000);
    for (let i = 1; i < runs.length; i++) expect(runs[i - 1]!.s - runs[i]!.s).toBe(1);
  });
});

describe("msPerSlotFromSamples", () => {
  it("pools the cluster's samples into one slot time", () => {
    expect(
      msPerSlotFromSamples([
        { numSlots: 223, samplePeriodSecs: 60 },
        { numSlots: 228, samplePeriodSecs: 60 },
      ]),
    ).toBeCloseTo(266.1, 1);
  });

  it("is null with nothing usable", () => {
    expect(msPerSlotFromSamples([])).toBeNull();
    expect(msPerSlotFromSamples([{ numSlots: 0, samplePeriodSecs: 60 }])).toBeNull();
  });
});

describe("countdownTargetSlot", () => {
  it("runs to the round's end slot, then to the end of the intermission", () => {
    expect(countdownTargetSlot(board(1_100n), config, 1_000n)).toBe(1_100n);
    expect(countdownTargetSlot(board(1_000n), config, 1_010n)).toBe(1_035n);
  });

  it("has no target before the first deploy", () => {
    expect(countdownTargetSlot(board(U64_MAX), config, 1_000n)).toBeNull();
  });
});

describe("holdMonotonic", () => {
  it("never shows a higher second than it already showed in the same phase", () => {
    let held = holdMonotonic(null, "r1:open", 30);
    held = holdMonotonic(held, "r1:open", 31);
    expect(held.shown).toBe(30);
    held = holdMonotonic(held, "r1:open", 29);
    expect(held.shown).toBe(29);
  });

  it("resets when the phase or round changes", () => {
    expect(holdMonotonic({ key: "r1:open", shown: 0 }, "r1:intermission", 14).shown).toBe(14);
  });
});
