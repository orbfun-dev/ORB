/**
 * Wheel geometry — the client mirror of the on-chain ticket math.
 *
 * Every computation on lamports, tickets, or angles is done in `BigInt`.
 * `u64` lamports exceed `Number.MAX_SAFE_INTEGER` above ~9M SOL, and a pot
 * that large silently losing precision is exactly the bug that surfaces
 * first in production (roadmap 6.2). `Number` appears only at the render
 * boundary, after the integer math has decided everything.
 *
 * The non-negotiable rule (roadmap 6.4): the winner is determined ONLY by
 * the integer range lookup in {@link findWinningEntry}. Angles drive the
 * animation and nothing else — floating-point rounding must never pick a
 * winner.
 */

/** Micro-degrees per degree; the fixed-point scale for all angles. */
export const MICROS_PER_DEGREE = 1_000_000n;

/** A full circle in micro-degrees. */
export const FULL_CIRCLE_MICROS = 360_000_000n;

/**
 * The target angle for the wheel animation, in micro-degrees, exactly as
 * the fixture and the program agree:
 * `floor(winning_ticket * 360_000_000 / total_lamports)`.
 *
 * Single division, no intermediate floats — bit-for-bit the integer the
 * Rust KAT generator committed.
 */
export function thetaMicroDegrees(
  winningTicket: bigint,
  totalLamports: bigint,
): bigint {
  if (totalLamports <= 0n) {
    throw new RangeError("totalLamports must be positive");
  }
  if (winningTicket < 0n || winningTicket >= totalLamports) {
    throw new RangeError(
      `winningTicket ${winningTicket} outside [0, ${totalLamports})`,
    );
  }
  return (winningTicket * FULL_CIRCLE_MICROS) / totalLamports;
}

/** Renders micro-degrees as a float — the ONLY float conversion. */
export function microDegreesToFloat(microDegrees: bigint): number {
  return Number(microDegrees) / 1_000_000;
}

/** Convenience: the animation angle in degrees for one outcome. */
export function thetaDegrees(
  winningTicket: bigint,
  totalLamports: bigint,
): number {
  return microDegreesToFloat(thetaMicroDegrees(winningTicket, totalLamports));
}

/** The on-chain view of one deposit, as decoded from a `PlayerEntry`. */
export interface PlayerEntryData {
  /** Base58 player pubkey — payouts, refunds, and rent route here. */
  player: string;
  entryIndex: number;
  /** The deposited amount; `> 0` by construction (I8). */
  amountLamports: bigint;
  /** Inclusive range lower bound. */
  ticketStart: bigint;
  /** Exclusive range upper bound. */
  ticketEnd: bigint;
}

/** One rendered segment of the wheel. */
export interface WheelSlice {
  player: string;
  entryIndex: number;
  /** `floor(ticketStart * 360e6 / total)` — inclusive, in micro-degrees. */
  startAngleMicro: bigint;
  /** `floor(ticketEnd * 360e6 / total)` — exclusive, in micro-degrees. */
  endAngleMicro: bigint;
  startAngleDegrees: number;
  endAngleDegrees: number;
  /** Stake share in percent, derived in integer basis points (2dp). */
  percentage: number;
  /** UI color from the fixed palette. */
  color: string;
}

/**
 * Fixed palette, assigned cyclically by entry index.
 *
 * Adjacent arcs are separated by VALUE, not by hue: the ramp strictly
 * alternates light and dark, so neighbours always read apart even for a
 * colour-blind player or on a dim phone screen. The previous palette was
 * eight fully-saturated hues at near-identical lightness — maximally
 * different in a colour picker, muddy and carnival-ish on the actual
 * wheel, and ambiguous to anyone with a red/green deficiency.
 *
 * The hues stay inside one deliberate family (brass → mint → teal →
 * steel → indigo → violet), which is the same family the app chrome uses,
 * so the wheel belongs to the product instead of floating on top of it.
 *
 * Relative luminance alternates 0.52 / 0.14 / 0.62 / 0.08 / 0.68 / 0.13 /
 * 0.56 / 0.12. The gap straddles L≈0.18 — the crossover where dark ink
 * and light ink contrast equally against a fill — in both directions by
 * enough margin that every slice clears 4.5:1 with whichever one
 * `contrastTextFor` picks for its on-slice label.
 */
export const WHEEL_COLORS: readonly string[] = [
  "#f2b544", // brass
  "#2f6f8f", // steel
  "#6fe3c4", // mint
  "#3e4c86", // indigo
  "#ffd07a", // pale brass
  "#24715f", // teal
  "#b9c6dc", // pale steel
  "#6a4fa8", // violet
] as const;

/**
 * Partitions the wheel from the SAME cumulative integer boundaries the
 * chain uses: each slice spans `[floor(start*360e6/total),
 * floor(end*360e6/total))`. Because entries partition `[0, total)` (I9),
 * boundaries telescope: the first slice starts at 0, each slice starts
 * where the previous ended, and the last ends at exactly 360,000,000 —
 * asserted, never assumed.
 */
export function calculateWheelSlices(
  entries: readonly PlayerEntryData[],
  totalLamports: bigint,
): WheelSlice[] {
  if (totalLamports <= 0n) {
    throw new RangeError("totalLamports must be positive");
  }
  if (entries.length === 0) {
    throw new RangeError("a wheel needs at least one entry");
  }

  // Entries are index-ordered by construction; verify rather than trust.
  const sorted = [...entries].sort((a, b) =>
    a.ticketStart < b.ticketStart ? -1 : a.ticketStart > b.ticketStart ? 1 : 0,
  );

  let cursor = 0n;
  const slices: WheelSlice[] = sorted.map((entry, i) => {
    if (entry.ticketStart !== cursor) {
      throw new RangeError(
        `entry ${entry.entryIndex} starts at ${entry.ticketStart}, expected ${cursor} — ranges do not partition [0, total)`,
      );
    }
    if (entry.ticketEnd <= entry.ticketStart) {
      throw new RangeError(`entry ${entry.entryIndex} has an empty range`);
    }
    const startAngleMicro = (entry.ticketStart * FULL_CIRCLE_MICROS) / totalLamports;
    const endAngleMicro = (entry.ticketEnd * FULL_CIRCLE_MICROS) / totalLamports;
    cursor = entry.ticketEnd;
    return {
      player: entry.player,
      entryIndex: entry.entryIndex,
      startAngleMicro,
      endAngleMicro,
      startAngleDegrees: microDegreesToFloat(startAngleMicro),
      endAngleDegrees: microDegreesToFloat(endAngleMicro),
      // Integer basis points, rendered at the boundary only.
      percentage:
        Number((entry.amountLamports * 10_000n) / totalLamports) / 100,
      color: WHEEL_COLORS[i % WHEEL_COLORS.length]!,
    };
  });
  if (cursor !== totalLamports) {
    throw new RangeError(
      `ranges end at ${cursor}, expected ${totalLamports} — partition broken`,
    );
  }
  // Telescoping exactness: the last boundary IS the full circle.
  if (slices[slices.length - 1]!.endAngleMicro !== FULL_CIRCLE_MICROS) {
    throw new RangeError("slice angles do not close at exactly 360°");
  }
  return slices;
}

/** Strictly half-open containment, mirroring `range_contains` on-chain. */
export function rangeContains(
  entry: Pick<PlayerEntryData, "ticketStart" | "ticketEnd">,
  ticket: bigint,
): boolean {
  return entry.ticketStart <= ticket && ticket < entry.ticketEnd;
}

/**
 * The O(log n) winning-entry lookup (roadmap 6.5): binary search on
 * `ticketStart` over index-ordered entries. This — and only this — decides
 * the displayed winner.
 */
export function findWinningEntry(
  entries: readonly PlayerEntryData[],
  winningTicket: bigint,
): PlayerEntryData | null {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = entries[mid]!;
    if (winningTicket < entry.ticketStart) {
      hi = mid - 1;
    } else if (winningTicket >= entry.ticketEnd) {
      lo = mid + 1;
    } else {
      return entry;
    }
  }
  return null;
}
