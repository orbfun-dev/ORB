/**
 * Sparse-book gates (audit CRITICAL 2): refund_entry/close_entry DELETE
 * entry accounts, so a partially-refunded cancelled round yields a book
 * with gaps that no longer starts at ticket 0. Raw `calculateWheelSlices`
 * must keep throwing on such books (it guards the I9 invariant) — but the
 * render-book sanitizer must repair them into a displayable contiguous
 * partition so the page (and its refund CTA) never crashes.
 */

import { describe, expect, it } from "vitest";
import { calculateWheelSlices, type PlayerEntryAccountData } from "@orbit-jackpot/sdk";
import {
  bookTotalOf,
  CLOSED_RANGE_PLAYER,
  CLOSED_SLICE_COLOR,
  renderBookOf,
  safeWheelSlices,
} from "../src/lib/book";

const SOL = 1_000_000_000n;

const mk = (
  index: number,
  start: bigint,
  end: bigint,
  player = `p${index}`,
): PlayerEntryAccountData => ({
  roundId: 7n,
  entryIndex: index,
  player,
  amountLamports: end - start,
  ticketStart: start,
  ticketEnd: end,
  depositTs: 0n,
  depositSlot: 0n,
  bump: 0,
});

describe("renderBookOf — sparse refund/close books", () => {
  it("a healthy telescoping book passes through with no fillers", () => {
    const entries = [mk(0, 0n, SOL), mk(1, SOL, 3n * SOL)];
    const book = renderBookOf(entries)!;
    expect(book.total).toBe(3n * SOL);
    expect(book.entries.map((e) => e.entryIndex)).toEqual([0, 1]);
    expect(book.fillerIndexes.size).toBe(0);
    expect(() => calculateWheelSlices(book.entries, book.total)).not.toThrow();
  });

  it("head gap (entry #0 refunded & closed) becomes a neutral filler at [0, start)", () => {
    // Raw math must refuse this book…
    expect(() => calculateWheelSlices([mk(1, SOL, 3n * SOL)], 3n * SOL)).toThrow(
      /do not partition/,
    );
    // …while the sanitized book partitions exactly.
    const book = renderBookOf([mk(1, SOL, 3n * SOL)])!;
    expect(book.entries.map((e) => [e.entryIndex, e.player])).toEqual([
      [-1, CLOSED_RANGE_PLAYER],
      [1, "p1"],
    ]);
    const slices = calculateWheelSlices(book.entries, book.total);
    expect(slices).toHaveLength(2);
    expect(slices[0]!.startAngleDegrees).toBe(0);
    expect(slices[0]!.endAngleDegrees).toBe(120); // 1 of 3 SOL
    expect(slices[1]!.endAngleDegrees).toBe(360);
  });

  it("interior gap and missing tail are repaired the same way", () => {
    // Entry #1 refunded: hole between #0's end and #2's start.
    const withHole = [mk(0, 0n, SOL), mk(2, 2n * SOL, 3n * SOL)];
    const book = renderBookOf(withHole)!;
    expect(book.entries.map((e) => e.ticketStart)).toEqual([0n, SOL, 2n * SOL]);
    expect(book.fillerIndexes.size).toBe(1);

    // The widest entry refunded: the book total telescopes to the new last
    // entry's end — a consistent smaller view, no trailing filler.
    const tailGone = [mk(0, 0n, SOL), mk(1, SOL, 2n * SOL)];
    expect(bookTotalOf(tailGone)).toBe(2n * SOL);
    expect(renderBookOf(tailGone)!.fillerIndexes.size).toBe(0);
  });

  it("malformed and overlapping entries are dropped, not fatal", () => {
    const messy = [mk(0, 0n, SOL), mk(1, SOL / 2n, 2n * SOL), mk(2, 2n * SOL, 2n * SOL)];
    const book = renderBookOf(messy)!;
    // Entry #1 overlaps #0 (starts before #0 ends) and #2 is empty — both
    // skipped; a trailing filler closes the book.
    expect(book.entries.map((e) => e.entryIndex)).toEqual([0, -1]);
    expect(book.entries[1]!.ticketEnd).toBe(2n * SOL);
    expect(() => calculateWheelSlices(book.entries, book.total)).not.toThrow();
  });

  it("empty or zero-total books render nothing (null, not a throw)", () => {
    expect(renderBookOf([])).toBeNull();
    expect(renderBookOf([mk(0, 0n, 0n)])).toBeNull();
    expect(safeWheelSlices([])).toBeNull();
  });
});

describe("safeWheelSlices — the UI-facing wrapper", () => {
  it("paints gap fillers neutral and keeps real arcs exact", () => {
    const wheel = safeWheelSlices([mk(1, SOL, 3n * SOL)])!;
    const [filler, real] = wheel.slices;
    expect(wheel.fillerIndexes.has(filler!.entryIndex)).toBe(true);
    expect(filler!.color).toBe(CLOSED_SLICE_COLOR);
    expect(filler!.percentage).toBe(0);
    expect(real!.color).not.toBe(CLOSED_SLICE_COLOR);
    // The survivor's arc is its true share of the round's ticket space.
    expect(real!.startAngleDegrees).toBe(120);
    expect(real!.endAngleDegrees).toBe(360);
    expect(real!.percentage).toBeCloseTo(66.66, 2);
  });

  it("never throws — a healthy 3-player book slices identically to the SDK", () => {
    const entries = [mk(0, 0n, SOL), mk(1, SOL, 2n * SOL), mk(2, 2n * SOL, 5n * SOL)];
    const wheel = safeWheelSlices(entries)!;
    const direct = calculateWheelSlices(entries, 5n * SOL);
    expect(wheel.slices.map((s) => s.color)).toEqual(direct.map((s) => s.color));
    expect(wheel.slices[2]!.endAngleDegrees).toBe(360);
  });
});
