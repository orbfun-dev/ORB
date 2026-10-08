/**
 * Fixture-mode gates (roadmap 7.2): every scenario must produce a state
 * tree the live UI could have produced — the entry book partitions
 * [0, total) exactly (validated by the SDK's own `calculateWheelSlices`,
 * which asserts telescoping and exact 360° closure), settled scenarios
 * carry a winning ticket inside the ticket space and findable by the
 * integer range lookup, and the KAT vectors load from the committed Rust
 * fixture.
 */

import { describe, expect, it } from "vitest";
import {
  calculateWheelSlices,
  findWinningEntry,
  type PlayerEntryAccountData,
} from "@orbit-jackpot/sdk";
import {
  buildFixtureSnapshot,
  FIXTURE_SCENARIO_NAMES,
  HIGH_STAKES_KAT_VECTOR,
  KAT_VECTORS,
  MEGA_KAT_VECTOR,
} from "../src/dev/fixtures";

const NOW = 1_700_000_000;

const ALL_SCENARIOS = [
  "standard",
  "whale",
  "highStakes",
  "soleDepositor",
  "awaitingRandomness",
  "megaSettled",
  "cancelled",
  "escrowAutoPlay",
] as const;

describe("scenario inventory", () => {
  it("exposes exactly the eight scenarios", () => {
    expect([...FIXTURE_SCENARIO_NAMES].sort()).to.deep.equal([...ALL_SCENARIOS].sort());
  });

  it("returns null for unknown names instead of throwing", () => {
    expect(buildFixtureSnapshot("nope", NOW)).toBeNull();
  });
});

describe("every scenario builds a chain-valid state tree", () => {
  for (const name of ALL_SCENARIOS) {
    it(`${name}: entries partition [0, total) — SDK slice math accepts the book`, () => {
      const snap = buildFixtureSnapshot(name, NOW)!;
      expect(snap.config).not.toBeNull();
      expect(snap.round).not.toBeNull();
      expect(snap.megaPot).not.toBeNull();

      const entries = snap.entries as readonly PlayerEntryAccountData[];
      expect(entries.length).toBe(snap.round.entryCount);
      // Throws on any partition/telescoping/closure violation.
      const slices = calculateWheelSlices(entries, snap.round.totalLamports);
      expect(slices).toHaveLength(entries.length);
      expect(slices[slices.length - 1]!.endAngleDegrees).toBe(360);

      // Fields stay bigint end to end.
      expect(typeof snap.round.totalLamports).toBe("bigint");
      expect(typeof entries[0]!.amountLamports).toBe("bigint");
    });
  }
});

describe("settled scenarios", () => {
  it("megaSettled: winning ticket is in-range and the integer lookup decides", () => {
    const snap = buildFixtureSnapshot("megaSettled", NOW)!;
    const round = snap.round;
    expect(round.state).toBe("settled");
    expect(round.winningTicket).toBeGreaterThanOrEqual(0n);
    expect(round.winningTicket).toBeLessThan(round.totalLamports);
    const winner = findWinningEntry(snap.entries, round.winningTicket);
    expect(winner).not.toBeNull();
    // The spin target and the mega celebration ride the same snapshot.
    expect(snap.settled?.event.megaTriggered).toBe(true);
    expect(snap.settled?.mega).not.toBeNull();
    expect(snap.megaPot.accruedLamports).toBe(snap.settled!.mega!.retained);
  });

  it("highStakes: pot exceeds MAX_SAFE_INTEGER lamports (BigInt stress)", () => {
    const snap = buildFixtureSnapshot("highStakes", NOW)!;
    expect(snap.round.totalLamports).toBeGreaterThan(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
    const slices = calculateWheelSlices(snap.entries, snap.round.totalLamports);
    expect(slices[slices.length - 1]!.endAngleDegrees).toBe(360);
  });

  it("soleDepositor: one entry owns the whole ticket space", () => {
    const snap = buildFixtureSnapshot("soleDepositor", NOW)!;
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]!.ticketStart).toBe(0n);
    expect(snap.entries[0]!.ticketEnd).toBe(snap.round.totalLamports);
    expect(snap.round.singleDepositor).toBe(true);
  });
});

describe("committed KAT vectors", () => {
  it("loads all vectors from the Rust-generated fixture", () => {
    expect(KAT_VECTORS.length).toBe(88);
    expect(KAT_VECTORS.filter((v) => v.mega_triggered).length).toBeGreaterThan(0);
  });

  it("picks deterministic KAT-backed vectors", () => {
    expect(MEGA_KAT_VECTOR.mega_triggered).toBe(true);
    expect(BigInt(HIGH_STAKES_KAT_VECTOR.sample_total_lamports)).toBeGreaterThan(2n ** 53n);
    // megaSettled's round mirrors the vector's outcome exactly.
    const snap = buildFixtureSnapshot("megaSettled", NOW)!;
    expect(snap.round.winningTicket).toBe(BigInt(MEGA_KAT_VECTOR.winning_ticket));
    expect(snap.round.totalLamports).toBe(BigInt(MEGA_KAT_VECTOR.sample_total_lamports));
  });
});
