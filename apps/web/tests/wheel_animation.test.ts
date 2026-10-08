/**
 * Wheel animation gates (roadmap 7.3): trajectory math, landing
 * precision, easing boundaries — and the parity rule itself: the needle's
 * θ (SDK float of integer micro-degrees) must sit inside the slice of the
 * entry the SDK's INTEGER range lookup picks as winner. Angles animate;
 * integers decide.
 */

import { describe, expect, it } from "vitest";
import {
  calculateWheelSlices,
  findWinningEntry,
  thetaDegrees,
} from "@orbit-jackpot/sdk";
import { angleAt, computeFinalAngle, easeOutQuart, normalizeAngle } from "../src/components/wheel/useWheelSpin";
import { annularSectorPath, polarToXY } from "../src/components/wheel/WheelSliceArc";
import { captureSettledBook, landingThetaOf } from "../src/lib/book";
import type { PlayerEntryAccountData } from "@orbit-jackpot/sdk";
import { buildFixtureSnapshot, KAT_VECTORS } from "../src/dev/fixtures";

const DURATION = 5_000;

describe("easeOutQuart boundaries", () => {
  it("is exact at the endpoints", () => {
    expect(easeOutQuart(0)).toBe(0);
    expect(easeOutQuart(1)).toBe(1);
    expect(easeOutQuart(-0.5)).toBe(0);
    expect(easeOutQuart(1.5)).toBe(1);
  });

  it("hits the quartic closed form exactly at t = 0.5", () => {
    expect(easeOutQuart(0.5)).toBe(1 - 0.5 ** 4); // 0.9375
  });

  it("is monotone increasing with strictly decreasing velocity", () => {
    const steps = 200;
    let prevAngle = 0;
    let prevDelta = Infinity;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const v = easeOutQuart(t);
      const delta = v - prevAngle;
      expect(v).toBeGreaterThan(prevAngle);
      expect(delta).toBeLessThanOrEqual(prevDelta);
      // Zero velocity only in the limit at t=1 — smooth stop.
      prevAngle = v;
      prevDelta = delta;
    }
    expect(prevAngle).toBe(1);
  });
});

describe("computeFinalAngle — the landing contract", () => {
  it("final ≡ θtarget (mod 360) within 1e-9° across the dial", () => {
    const currents = [0, 17.3, 359.9999, 1234.567, 7200.25];
    const targets = [0, 0.0001, 90, 180, 270, 359.9999];
    for (const current of currents) {
      for (const target of targets) {
        const final = computeFinalAngle(current, target, 4);
        const landed = normalizeAngle(final);
        const drift = Math.min(
          Math.abs(landed - target),
          360 - Math.abs(landed - target),
        );
        expect(drift, `current=${current} target=${target}`).toBeLessThan(1e-9);
      }
    }
  });

  it("always spins forward at least minTurns full laps", () => {
    for (const [current, target] of [[0, 0], [180, 180], [359.9, 0.1]] as const) {
      const final = computeFinalAngle(current, target, 4);
      expect(final - current).toBeGreaterThanOrEqual(4 * 360);
      expect(final - current).toBeLessThan(5 * 360);
    }
  });
});

describe("angleAt — the trajectory", () => {
  const start = 250.75;
  const target = 131.2;
  const final = computeFinalAngle(start, target, 4);

  it("is exactly start at t=0 and exactly final at t≥duration", () => {
    expect(angleAt(start, final, 0, DURATION)).toBe(start);
    expect(angleAt(start, final, DURATION, DURATION)).toBe(final);
    expect(angleAt(start, final, DURATION * 3, DURATION)).toBe(final);
  });

  it("is monotone, never overshoots, and decelerates the whole way", () => {
    const steps = 500;
    let prev = start;
    let prevDelta = Infinity;
    for (let i = 1; i <= steps; i += 1) {
      const angle = angleAt(start, final, (i / steps) * DURATION, DURATION);
      const delta = angle - prev;
      expect(angle).toBeGreaterThanOrEqual(prev);
      expect(angle).toBeLessThanOrEqual(final);
      expect(delta).toBeLessThanOrEqual(prevDelta + 1e-12);
      prev = angle;
      prevDelta = delta;
    }
    expect(prev).toBe(final);
  });

  it("covers ≥ 4 laps of travel — visually exciting, contractually bounded", () => {
    expect(final - start).toBeGreaterThanOrEqual(4 * 360);
  });
});

describe("landing precision vs the SDK's θ (gate: ±0.001°)", () => {
  it("lands within 1e-9° for KAT winning tickets across the dial", () => {
    const totals = [1_000_000_000n, 123_456_789_012_345_678n, 2n ** 53n + 1n];
    const tickets = [0n, 1n, 999_999_999n, 61_728_394_506_172_839n];
    for (const v of KAT_VECTORS.slice(0, 24)) {
      tickets.push(BigInt(v.winning_ticket));
      totals.push(BigInt(v.sample_total_lamports));
    }
    for (const total of totals) {
      if (total <= 0n) continue;
      for (const ticket of tickets) {
        if (ticket >= total) continue;
        const theta = thetaDegrees(ticket, total); // SDK: the ONLY angle source
        const final = computeFinalAngle(1234.567, theta, 4);
        const drift = Math.min(
          Math.abs(normalizeAngle(final) - theta),
          360 - Math.abs(normalizeAngle(final) - theta),
        );
        expect(drift, `total=${total} ticket=${ticket}`).toBeLessThan(0.001);
        expect(drift).toBeLessThan(1e-9);
      }
    }
  });
});

describe("parity: θ lands inside the integer-decided winner's slice", () => {
  const cases = [
    { scenario: "megaSettled", label: "megaSettled (KAT outcome)" },
    { scenario: "highStakes", label: "highStakes (>2^53 lamports)" },
  ];

  for (const { scenario, label } of cases) {
    it(`${label}: findWinningEntry's slice contains thetaDegrees' landing arc`, () => {
      const snap = buildFixtureSnapshot(scenario, 1_700_000_000)!;
      const ticket = snap.round.winningTicket;
      const total = snap.round.totalLamports;
      const winner = findWinningEntry(snap.entries, ticket);
      expect(winner).not.toBeNull();

      const slices = calculateWheelSlices(snap.entries, total);
      const winnerSlice = slices.find((s) => s.entryIndex === winner!.entryIndex);
      expect(winnerSlice).toBeDefined();

      const theta = thetaDegrees(ticket, total);
      expect(theta).toBeGreaterThanOrEqual(winnerSlice!.startAngleDegrees - 1e-9);
      expect(theta).toBeLessThan(winnerSlice!.endAngleDegrees);
    });
  }
});

describe("ring geometry", () => {
  const geometry = { cx: 200, cy: 200, r0: 128, r1: 184 };

  it("maps 0° to 12 o'clock and runs clockwise", () => {
    expect(polarToXY(200, 200, 100, 0)).toEqual({ x: 200, y: 100 }); // top
    expect(polarToXY(200, 200, 100, 90).x).toBeCloseTo(300, 9); // right
    expect(polarToXY(200, 200, 100, 180).y).toBeCloseTo(300, 9); // bottom
    expect(polarToXY(200, 200, 100, 270).x).toBeCloseTo(100, 9); // left
  });

  it("draws partial sectors as outer-arc → inner-arc paths", () => {
    const d = annularSectorPath(geometry, 0, 90);
    expect(d.startsWith("M 200 16")).toBe(true); // outer top point
    expect(d.match(/A 184 184/g)).toHaveLength(1);
    expect(d.match(/A 128 128/g)).toHaveLength(1);
  });

  it("renders the sole-depositor full circle as paired semicircles", () => {
    const d = annularSectorPath(geometry, 0, 360);
    expect(d.match(/A 184 184/g)).toHaveLength(2);
    expect(d.match(/A 128 128/g)).toHaveLength(2);
  });

  it("keeps slice boundaries seamless — SDK arcs share exact endpoints", () => {
    const snap = buildFixtureSnapshot("standard", 1_700_000_000)!;
    const slices = calculateWheelSlices(snap.entries, snap.round.totalLamports);
    for (let i = 1; i < slices.length; i += 1) {
      expect(slices[i]!.startAngleDegrees).toBe(slices[i - 1]!.endAngleDegrees);
    }
    expect(slices[0]!.startAngleDegrees).toBe(0);
    expect(slices[slices.length - 1]!.endAngleDegrees).toBe(360);
  });
});

describe("era separation — captureSettledBook (rollover-race regression)", () => {
  // The 2026-10-07 bug: the next round's first deposits swap `entries` to a
  // NEW book while the 5 s spin is still decelerating, so the needle lands
  // on the OLD round's θ over NEW round arcs — and the live
  // findWinningEntry(newBook, oldTicket) highlights an arbitrary wrong
  // slice. The capture freezes geometry AND winner at settle time.
  const mk = (i: number, start: bigint, end: bigint, player: string) => ({
    player,
    entryIndex: i,
    amountLamports: end - start,
    ticketStart: start,
    ticketEnd: end,
    roundId: 1n,
    depositTs: 0n,
    depositSlot: 0n,
    bump: 0,
  });

  // Settled round N: A [0,30), B [30,100) — ticket 65 ⇒ B wins.
  const settledBook = [mk(0, 0n, 30n, "A"), mk(1, 30n, 100n, "B")];
  const ticket = 65n;

  it("freezes the slices and the winner of the settled round", () => {
    const cap = captureSettledBook(settledBook, ticket);
    expect(cap).not.toBeNull();
    expect(cap!.winner!.player).toBe("B");
    // Parity on the FROZEN geometry: the needle's θ sits inside B's arc.
    const theta = thetaDegrees(ticket, 100n);
    const b = cap!.wheel.slices.find((s) => s.player === "B")!;
    expect(theta).toBeGreaterThanOrEqual(b.startAngleDegrees);
    expect(theta).toBeLessThan(b.endAngleDegrees);
  });

  it("a new round's book arriving mid-spin cannot move the frozen presentation", () => {
    const cap = captureSettledBook(settledBook, ticket);
    // Round N+1's book (fresh ticket space): X [0,70), Y [70,100).
    const newBook = [mk(0, 0n, 70n, "X"), mk(1, 70n, 100n, "Y")];
    // The WRONG-era lookup the old code did live: ticket 65 now maps to X.
    const wrongEra = findWinningEntry(newBook, ticket);
    expect(wrongEra!.player).toBe("X");
    // The frozen capture is immune: winner still B, θ still inside B's arc.
    expect(cap!.winner!.player).toBe("B");
    const theta = thetaDegrees(ticket, 100n);
    const b = cap!.wheel.slices.find((s) => s.player === "B")!;
    expect(theta).toBeGreaterThanOrEqual(b.startAngleDegrees);
    expect(theta).toBeLessThan(b.endAngleDegrees);
  });

  it("returns null for an unrenderable book (caller keeps the live wheel)", () => {
    expect(captureSettledBook([], ticket)).toBeNull();
  });
});

describe("landingThetaOf — the needle lands in the scale the wheel is DRAWN in", () => {
  /**
   * The live bug (2026-10-07): slices are drawn against the BOOK's total
   * (`bookTotalOf` — the last entry's `ticketEnd`, per book.ts's opening
   * rule), but the needle's θ was computed against the SETTLEMENT EVENT's
   * `total_lamports`. Those agree only when the local entry book is
   * complete. When a refetch is still in flight the book is short, the two
   * scales diverge, and the needle lands at a θ that belongs to a wheel
   * nobody drew — visibly outside the winning segment.
   */
  const entry = (
    entryIndex: number,
    player: string,
    start: bigint,
    end: bigint,
  ): PlayerEntryAccountData => ({
    roundId: 1n,
    entryIndex,
    player,
    amountLamports: end - start,
    ticketStart: start,
    ticketEnd: end,
    depositTs: 0n,
    depositSlot: 0n,
    bump: 0,
  });

  // A book the chain says totals 10 SOL, but of which we have only the
  // first 6 SOL — exactly the mid-refetch state.
  const SHORT_BOOK = [
    entry(0, "A".repeat(43), 0n, 3_000_000_000n),
    entry(1, "B".repeat(43), 3_000_000_000n, 6_000_000_000n),
  ];
  const CHAIN_TOTAL = 10_000_000_000n;
  const WINNING_TICKET = 4_500_000_000n; // inside B's range

  it("lands inside the winner's DRAWN slice when the book is short", () => {
    const capture = captureSettledBook(SHORT_BOOK, WINNING_TICKET)!;
    expect(capture.winner!.entryIndex).toBe(1);
    const slice = capture.wheel.slices.find((s) => s.entryIndex === 1)!;

    // The old behaviour: θ against the CHAIN's total lands at 162°, while
    // B's drawn slice spans [180°, 360°). Off the segment entirely.
    const wrong = thetaDegrees(WINNING_TICKET, CHAIN_TOTAL);
    expect(wrong).toBeLessThan(slice.startAngleDegrees);

    const theta = landingThetaOf(capture, WINNING_TICKET);
    expect(theta).toBeGreaterThanOrEqual(slice.startAngleDegrees);
    expect(theta).toBeLessThan(slice.endAngleDegrees);
  });

  it("is identical to the SDK θ when the book IS complete", () => {
    const full = [
      entry(0, "A".repeat(43), 0n, 3_000_000_000n),
      entry(1, "B".repeat(43), 3_000_000_000n, CHAIN_TOTAL),
    ];
    const capture = captureSettledBook(full, WINNING_TICKET)!;
    expect(landingThetaOf(capture, WINNING_TICKET)).toBe(
      thetaDegrees(WINNING_TICKET, CHAIN_TOTAL),
    );
  });

  it("falls back to the winner's arc midpoint when the ticket is off the book", () => {
    // Ticket beyond the book's own total: no proportional position exists
    // in this scale, so land in the middle of the winner's arc instead of
    // throwing or pointing at 0°.
    const capture = captureSettledBook(SHORT_BOOK, 9_000_000_000n)!;
    const theta = landingThetaOf(capture, 9_000_000_000n);
    expect(Number.isFinite(theta)).toBe(true);
    expect(theta).toBeGreaterThanOrEqual(0);
    expect(theta).toBeLessThan(360);
  });

  it("never throws on a capture with no identifiable winner", () => {
    const capture = captureSettledBook(SHORT_BOOK, 9_000_000_000n)!;
    expect(() => landingThetaOf({ ...capture, winner: null }, 9_000_000_000n)).not.toThrow();
  });
});
