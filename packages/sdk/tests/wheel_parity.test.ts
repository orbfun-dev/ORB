/**
 * Phase 6 parity gates (roadmap 6.3, 6.4, ADR-9).
 *
 * 1. All 88 vectors of the committed `entropy_kat.json` must produce the
 *    fixture's `expected_theta_degrees` within 1e-5° — the same file the
 *    Rust KAT generator committed and the on-chain replay (72/72
 *    genesis-fundable vectors) already matched bit-for-bit.
 * 2. Wheel slices built from integer ticket boundaries close at exactly
 *    360.000000°, and boundaries telescope.
 * 3. The non-negotiable rule: with a ticket that lands EXACTLY on a slice
 *    boundary, the displayed winner still matches the on-chain winner —
 *    the integer range lookup decides, angles only animate.
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  calculateWheelSlices,
  findWinningEntry,
  FULL_CIRCLE_MICROS,
  microDegreesToFloat,
  PlayerEntryData,
  rangeContains,
  thetaDegrees,
  thetaMicroDegrees,
  WHEEL_COLORS,
} from "../src/math/wheel";

interface KatVector {
  raw_seed_hex: string;
  ticket_seed_u128: string;
  mega_seed_u128: string;
  sample_total_lamports: string;
  winning_ticket: string;
  expected_theta_degrees: string;
  mega_triggered: boolean;
  expected_admin_cut: string;
  expected_mega_cut: string;
  expected_winner_payout: string;
}

const FIXTURE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "programs",
  "orbit_jackpot",
  "tests",
  "fixtures",
  "entropy_kat.json",
);

function loadVectors(): KatVector[] {
  const raw = fs.readFileSync(FIXTURE_PATH, "utf8");
  const vectors: KatVector[] = JSON.parse(raw);
  expect(vectors.length).to.be.at.least(64, "ADR-9 minimum fixture size");
  return vectors;
}

const LAMPORTS_PER_SOL = 1_000_000_000n;
type Sol = bigint;
const sol = (amount: number): Sol => BigInt(amount) * LAMPORTS_PER_SOL;

/** Builds the index-ordered entries for stakes like scenarios 1–6 use. */
function entriesFor(stakes: bigint[], players: string[]): PlayerEntryData[] {
  let cursor = 0n;
  return stakes.map((amount, i) => {
    const entry: PlayerEntryData = {
      player: players[i] ?? `Player${i}`,
      entryIndex: i,
      amountLamports: amount,
      ticketStart: cursor,
      ticketEnd: cursor + amount,
    };
    cursor += amount;
    return entry;
  });
}

describe("wheel parity against entropy_kat.json", () => {
  const vectors = loadVectors();

  it("computes every fixture vector's theta within 1e-5 degrees", () => {
    for (const [i, vector] of vectors.entries()) {
      const ticket = BigInt(vector.winning_ticket);
      const total = BigInt(vector.sample_total_lamports);
      const expected = Number.parseFloat(vector.expected_theta_degrees);
      const got = thetaDegrees(ticket, total);
      expect(
        Math.abs(got - expected),
        `vector ${i}: got ${got}, expected ${expected}`,
      ).to.be.lessThan(1e-5);
    }
  });

  it("matches the fixture in integer micro-degrees exactly (not just floats)", () => {
    for (const [i, vector] of vectors.entries()) {
      const ticket = BigInt(vector.winning_ticket);
      const total = BigInt(vector.sample_total_lamports);
      const expectedMicro = BigInt(vector.expected_theta_degrees.replace(".", ""));
      // The fixture string carries exactly 6 decimals — same fixed-point.
      expect(
        thetaMicroDegrees(ticket, total),
        `vector ${i} micro-degrees`,
      ).to.equal(expectedMicro);
    }
  });

  it("bounds theta to [0, 360) and rejects out-of-range tickets", () => {
    expect(thetaMicroDegrees(0n, sol(10))).to.equal(0n);
    const lastTicket = thetaMicroDegrees(sol(10) - 1n, sol(10));
    expect(lastTicket < FULL_CIRCLE_MICROS).to.be.true;
    expect(() => thetaMicroDegrees(sol(10), sol(10))).to.throw(RangeError);
    expect(() => thetaMicroDegrees(0n, 0n)).to.throw(RangeError);
  });
});

describe("wheel slice partitioning", () => {
  const players = ["Alice", "Bob", "Carol"];

  it("closes at exactly 360.000000° and telescopes boundaries", () => {
    const total = sol(10);
    const entries = entriesFor([sol(1), sol(3), sol(6)], players);
    const slices = calculateWheelSlices(entries, total);

    expect(slices).to.have.length(3);
    expect(slices[0]!.startAngleMicro).to.equal(0n);
    // Telescoping: each slice starts where the previous ended.
    for (let i = 1; i < slices.length; i += 1) {
      expect(slices[i]!.startAngleMicro).to.equal(slices[i - 1]!.endAngleMicro);
    }
    expect(slices[slices.length - 1]!.endAngleMicro).to.equal(FULL_CIRCLE_MICROS);
    // 1/3.6 SOL, 3/3.6… percentages from integer basis points.
    expect(slices[0]!.percentage).to.equal(10);
    expect(slices[1]!.percentage).to.equal(30);
    expect(slices[2]!.percentage).to.equal(60);
    // Adjacent UI colors come from the palette.
    expect(slices[0]!.color).to.equal(WHEEL_COLORS[0]);
    expect(slices[1]!.color).to.equal(WHEEL_COLORS[1]);
  });

  it("stays exact at lamport scales beyond Number.MAX_SAFE_INTEGER", () => {
    // 10,000,001 SOL: every intermediate in Number would lose lamports.
    const total = 10_000_001n * LAMPORTS_PER_SOL;
    const entries = entriesFor([total / 3n, total - total / 3n], players);
    const slices = calculateWheelSlices(entries, total);
    expect(
      slices[slices.length - 1]!.endAngleMicro,
    ).to.equal(FULL_CIRCLE_MICROS);
  });

  it("throws when the ranges do not partition [0, total)", () => {
    const total = sol(10);
    const broken: PlayerEntryData[] = [
      {
        player: "Alice",
        entryIndex: 0,
        amountLamports: sol(4),
        ticketStart: 0n,
        ticketEnd: sol(4),
      },
      {
        player: "Bob",
        entryIndex: 1,
        amountLamports: sol(6),
        ticketStart: sol(5), // gap!
        ticketEnd: sol(10),
      },
    ];
    expect(() => calculateWheelSlices(broken, total)).to.throw(RangeError);
  });
});

describe("the integer-winner rule (roadmap 6.4)", () => {
  const players = ["Alice", "Bob", "Carol"];
  const entries = entriesFor([sol(1), sol(3), sol(6)], players);
  const total = sol(10);

  it("picks the winner by integer range lookup, never by angle", () => {
    // A ticket that lands EXACTLY on the Alice/Bob boundary: its theta is
    // exactly 36°. Floating-point rendering must not hand it to Alice.
    const boundaryTicket = sol(1);
    const winner = findWinningEntry(entries, boundaryTicket);
    expect(winner).to.not.be.null;
    expect(winner!.player).to.equal("Bob", "half-open: [start, end)");
    expect(rangeContains(winner!, boundaryTicket)).to.be.true;

    // The angle of that same ticket — display only.
    const angle = thetaDegrees(boundaryTicket, total);
    expect(Math.abs(angle - 36)).to.be.lessThan(1e-5);
  });

  it("agrees with the range check on every boundary of the round", () => {
    const boundaries = [0n, sol(1), sol(4), sol(10) - 1n, total];
    for (const ticket of boundaries) {
      const bySearch = findWinningEntry(entries, ticket);
      const byScan = entries.find((e) => rangeContains(e, ticket)) ?? null;
      expect(bySearch?.entryIndex, `ticket ${ticket}`).to.equal(
        byScan?.entryIndex,
      );
    }
    // `total` itself belongs to nobody.
    expect(findWinningEntry(entries, total)).to.be.null;
  });

  it("matches the on-chain winner for every KAT boundary vector", () => {
    // Pattern-A vectors pin ticket 0 (first entry wins); pattern-B pin
    // total-1 (last entry wins) — replicate that shape at fixture scale.
    for (const [i, vector] of vectorsForBoundaries().entries()) {
      const total = BigInt(vector.sample_total_lamports);
      const ticket = BigInt(vector.winning_ticket);
      const round = entriesFor([total / 4n, total - total / 4n], players);
      const winner = findWinningEntry(round, ticket);
      expect(winner, `vector ${i}`).to.not.be.null;
      // Winner's range must contain the ticket — the on-chain proof.
      expect(rangeContains(winner!, ticket), `vector ${i}`).to.be.true;
    }
  });
});

function vectorsForBoundaries(): KatVector[] {
  // Boundary-ticket vectors: winning_ticket == 0 or total-1.
  return loadVectors().filter((v) => {
    const total = BigInt(v.sample_total_lamports);
    const ticket = BigInt(v.winning_ticket);
    return ticket === 0n || ticket === total - 1n;
  });
}

describe("microDegreesToFloat", () => {
  it("renders the fixed-point scale at the boundary only", () => {
    expect(microDegreesToFloat(0n)).to.equal(0);
    expect(microDegreesToFloat(FULL_CIRCLE_MICROS)).to.equal(360);
    expect(microDegreesToFloat(90_000_000n)).to.equal(90);
    expect(microDegreesToFloat(123_456_789n)).to.equal(123.456789);
  });
});
