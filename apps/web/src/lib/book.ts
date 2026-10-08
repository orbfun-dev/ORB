/**
 * The entry book is self-contained: on-chain entries telescope
 * `[ticket_start, ticket_end)` so the last entry's end IS a valid total
 * (the chain's I9 invariant). Wheel/slice math must always run against
 * the BOOK's total, never `round.total_lamports` — the round-account
 * websocket push can land before the entry refetch, transiently showing a
 * newer total against a stale book, and `calculateWheelSlices` (correctly)
 * refuses a broken partition. Rendering the book's own snapshot keeps
 * every intermediate state consistent; the pot NUMBER may lead the arcs
 * by one refetch (~1–2 s), which is the honest ordering anyway.
 *
 * Refunded/closed books (audit fix, sparse books): `refund_entry` and
 * `close_entry` DELETE entry accounts (`close = player`), so a
 * partially-refunded cancelled round — or a cleaned-up settled round —
 * yields a book with gaps that no longer starts at ticket 0. The raw
 * partition math must keep refusing such books (it guards a real
 * invariant), but the UI must never crash on them: the winner of a
 * refunded round still needs the wheel on screen to reach the refund
 * button. `renderBookOf` rebuilds a display-only contiguous book by
 * inserting neutral synthetic entries for the missing ranges — real
 * players keep their exact on-chain arcs and the needle stays truthful.
 */

import {
  calculateWheelSlices,
  findWinningEntry,
  thetaDegrees,
  type PlayerEntryData,
  type WheelSlice,
} from "@orbit-jackpot/sdk";
import type { PlayerEntryAccountData } from "@orbit-jackpot/sdk";

export function bookTotalOf(entries: readonly PlayerEntryAccountData[]): bigint {
  return entries.length === 0 ? 0n : entries[entries.length - 1]!.ticketEnd;
}

/** Marker `player` for a synthetic gap entry — never a real pubkey. */
export const CLOSED_RANGE_PLAYER = "\0closed-range";

/** Neutral arc color for refunded/closed ranges (`--color-orbit-line`). */
export const CLOSED_SLICE_COLOR = "#27313f";

/** The sanitized, always-partitionable display book. */
export interface RenderBook {
  /** Contiguous telescoping `[0, total)` — real entries + gap fillers. */
  entries: PlayerEntryData[];
  /** The book's own total (last real entry's `ticketEnd`). */
  total: bigint;
  /** Synthetic filler indexes (negative sentinel indexes, never real u32s). */
  fillerIndexes: ReadonlySet<number>;
}

/**
 * Builds the render book: drops malformed entries, skips overlaps, and
 * fills head/interior/trailing gaps with neutral synthetic entries so the
 * result partitions `[0, total)` exactly. Real entries are NEVER rescaled
 * — a refunded player's arc shows as closed space, and live players keep
 * their true proportions. Returns `null` when nothing is renderable.
 */
export function renderBookOf(
  entries: readonly PlayerEntryAccountData[],
): RenderBook | null {
  if (entries.length === 0) return null;
  const total = bookTotalOf(entries);
  if (total <= 0n) return null;

  const sorted = [...entries].sort((a, b) =>
    a.ticketStart < b.ticketStart ? -1 : a.ticketStart > b.ticketStart ? 1 : 0,
  );

  const book: PlayerEntryData[] = [];
  const fillerIndexes = new Set<number>();
  let fillerSeq = 0;
  let cursor = 0n;

  const fillGap = (end: bigint): void => {
    if (end <= cursor) return;
    const index = --fillerSeq; // negative: cannot collide with real u32 indexes
    fillerIndexes.add(index);
    book.push({
      player: CLOSED_RANGE_PLAYER,
      entryIndex: index,
      amountLamports: end - cursor,
      ticketStart: cursor,
      ticketEnd: end,
    });
    cursor = end;
  };

  for (const entry of sorted) {
    // Malformed or overlapping-with-what-we-kept entries are skipped, not
    // fatal — the poll floor brings the authoritative book back shortly.
    if (
      entry.ticketEnd <= entry.ticketStart ||
      entry.ticketEnd > total ||
      entry.ticketStart < cursor
    ) {
      continue;
    }
    fillGap(entry.ticketStart);
    book.push({
      player: entry.player,
      entryIndex: entry.entryIndex,
      amountLamports: entry.amountLamports,
      ticketStart: entry.ticketStart,
      ticketEnd: entry.ticketEnd,
    });
    cursor = entry.ticketEnd;
  }
  if (book.length === 0) return null;
  fillGap(total); // trailing gap when the widest entry was itself skipped

  return { entries: book, total, fillerIndexes };
}

/** Safe wheel slicing: sanitized book, gap arcs painted neutral, never throws. */
export interface SafeWheelSlices {
  slices: WheelSlice[];
  total: bigint;
  fillerIndexes: ReadonlySet<number>;
}

export function safeWheelSlices(
  entries: readonly PlayerEntryAccountData[],
): SafeWheelSlices | null {
  const book = renderBookOf(entries);
  if (book === null) return null;
  try {
    const slices = calculateWheelSlices(book.entries, book.total);
    return {
      slices: slices.map((slice) =>
        book.fillerIndexes.has(slice.entryIndex)
          ? { ...slice, color: CLOSED_SLICE_COLOR, percentage: 0 }
          : slice,
      ),
      total: book.total,
      fillerIndexes: book.fillerIndexes,
    };
  } catch {
    // Belt and braces: a book shape the sanitizer somehow cannot repair
    // renders the placeholder ring — it must never break the page the
    // refund/claim banners live on.
    return null;
  }
}

/**
 * The frozen landing presentation of one settled round (the era-separation
 * fix): the slice geometry AND the winner lookup are captured from the
 * book as it stood at settle, because the live feed keeps moving under
 * the 5 s spin — the next round's first deposits swap `entries` to a new
 * book mid-flight, which otherwise lands the needle on the OLD round's θ
 * over NEW round arcs and highlights `findWinningEntry(newBook, oldTicket)`
 * — an arbitrary wrong slice. Returns null when the book is not
 * renderable (the caller keeps the live wheel in that degenerate case).
 */
export interface SettledBookCapture {
  /** Frozen slices — what the needle lands against. */
  wheel: SafeWheelSlices;
  /** The frozen book entries (labels + winner lookup). */
  bookEntries: readonly PlayerEntryData[];
  /** `findWinningEntry` over the FROZEN book — the era-correct winner. */
  winner: PlayerEntryData | null;
}

export function captureSettledBook(
  entries: readonly PlayerEntryAccountData[],
  winningTicket: bigint,
): SettledBookCapture | null {
  const book = renderBookOf(entries);
  if (book === null) return null;
  const winner = findWinningEntry(book.entries, winningTicket);
  try {
    const slices = calculateWheelSlices(book.entries, book.total);
    const wheel: SafeWheelSlices = {
      slices: slices.map((slice) =>
        book.fillerIndexes.has(slice.entryIndex)
          ? { ...slice, color: CLOSED_SLICE_COLOR, percentage: 0 }
          : slice,
      ),
      total: book.total,
      fillerIndexes: book.fillerIndexes,
    };
    return { wheel, bookEntries: book.entries, winner };
  } catch {
    return null;
  }
}

/**
 * The needle's landing angle for a captured settlement — in the scale the
 * wheel is actually DRAWN in.
 *
 * The slices above are built from `book.total` (this module's opening
 * rule: never `round.total_lamports`, because the round account's
 * websocket push can lead the entry refetch). The needle must honour the
 * same rule. Computing θ from the settlement event's `total_lamports`
 * instead — as the wheel did until 2026-10-07 — silently puts the two in
 * different scales whenever the local book is short, and the pointer stops
 * outside the winning segment: the book is smaller, so every drawn arc is
 * wider than the chain's proportion, and a θ derived from the chain's
 * larger total falls short of it.
 *
 * Because `calculateWheelSlices` floors each boundary with the SAME
 * division this uses, a ticket inside the winner's range is inside the
 * winner's drawn arc by construction — the landing is exact, not merely
 * close. When the ticket is off the book entirely (a stale capture the
 * sanitizer could not reconcile) there is no proportional position to
 * honour, so the needle takes the winner's arc midpoint: still truthful
 * about WHO won, which is the only thing the pointer communicates.
 */
export function landingThetaOf(
  capture: SettledBookCapture,
  winningTicket: bigint,
): number {
  const total = capture.wheel.total;
  if (total > 0n && winningTicket >= 0n && winningTicket < total) {
    return thetaDegrees(winningTicket, total);
  }
  const winner = capture.winner;
  if (winner === null) return 0;
  const slice = capture.wheel.slices.find((s) => s.entryIndex === winner.entryIndex);
  if (slice === undefined) return 0;
  return (slice.startAngleDegrees + slice.endAngleDegrees) / 2;
}
