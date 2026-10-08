/**
 * Cross-language parity gates for the economics mirror (Phase 11.7): the
 * BigInt twins of `split_round_pot` / `split_mega_pot` / `entry_share`
 * must reproduce, to the lamport, the values the Rust KAT generator
 * committed to `entropy_kat.json` — the same file the Rust property
 * tests, the on-chain replay suite, and the wheel-parity gates consume.
 * If Rust and TS ever disagree by one lamport, a player-visible number is
 * wrong somewhere; this suite is where that becomes loud.
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  BpsOverflowError,
  entryShare,
  splitMegaPot,
  splitRoundPot,
  ZeroTotalError,
} from "../src/math/economics";

interface KatVector {
  sample_total_lamports: string;
  expected_admin_cut: string;
  expected_mega_cut: string;
  expected_winner_payout: string;
  expected_refund_pool: string;
  sample_mega_accrued: string;
  expected_mega_payable: string;
  expected_mega_awarded: string;
  expected_mega_field_pool: string;
  expected_mega_retained: string;
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

const VECTORS: KatVector[] = JSON.parse(
  fs.readFileSync(FIXTURE_PATH, "utf8"),
) as KatVector[];

const big = (v: string): bigint => BigInt(v);

describe("economics mirror against entropy_kat.json (Rust-generated)", () => {
  it("fixture is present and populated", () => {
    expect(VECTORS.length).to.be.greaterThan(64);
  });

  it("splitRoundPot reproduces every vector's four-way split to the lamport", () => {
    for (const [i, v] of VECTORS.entries()) {
      const total = big(v.sample_total_lamports);
      const split = splitRoundPot(total, 900, 100, 100);
      expect(split.winnerPayout.toString(), `vector ${i} winner`).to.equal(
        v.expected_winner_payout,
      );
      expect(split.adminCut.toString(), `vector ${i} admin`).to.equal(v.expected_admin_cut);
      expect(split.megaCut.toString(), `vector ${i} mega`).to.equal(v.expected_mega_cut);
      expect(split.refundPool.toString(), `vector ${i} refund`).to.equal(
        v.expected_refund_pool,
      );
      // I18 by construction: the refund residual reassembles the pot.
      expect(
        split.winnerPayout + split.refundPool + split.adminCut + split.megaCut,
        `vector ${i} I18`,
      ).to.equal(total);
    }
  });

  it("splitMegaPot reproduces every vector's capped payout split to the lamport", () => {
    for (const [i, v] of VECTORS.entries()) {
      const accrued = big(v.sample_mega_accrued);
      const total = big(v.sample_total_lamports);
      const split = splitMegaPot(accrued, total, 5_000, 4_000, 80_000);
      const payable = split.awarded + split.fieldPool;
      expect(payable.toString(), `vector ${i} payable`).to.equal(v.expected_mega_payable);
      expect(split.awarded.toString(), `vector ${i} awarded`).to.equal(v.expected_mega_awarded);
      expect(split.fieldPool.toString(), `vector ${i} field`).to.equal(
        v.expected_mega_field_pool,
      );
      expect(split.retained.toString(), `vector ${i} retained`).to.equal(
        v.expected_mega_retained,
      );
      // I19 by construction.
      expect(payable + split.retained, `vector ${i} I19`).to.equal(accrued);
    }
  });

  it("the canonical 10 × 1 SOL round: 0.9 / 8.9 / 0.1 / 0.1 and 0.89 per entry", () => {
    const SOL = 1_000_000_000n;
    const split = splitRoundPot(10n * SOL, 900, 100, 100);
    expect(split.winnerPayout).to.equal(900_000_000n, "0.9 SOL");
    expect(split.refundPool).to.equal(8_900_000_000n);
    expect(split.adminCut).to.equal(100_000_000n);
    expect(split.megaCut).to.equal(100_000_000n);
    // Every 1 SOL entry draws exactly 0.89 SOL — no dust on clean totals.
    let paid = 0n;
    for (let i = 0; i < 10; i += 1) {
      const share = entryShare(SOL, split.refundPool, 10n * SOL);
      expect(share).to.equal(890_000_000n);
      paid += share;
    }
    expect(paid).to.equal(split.refundPool);
  });

  it("R2's counterexample: the 100 × 1-lamport round cannot overdraw", () => {
    const split = splitRoundPot(100n, 900, 100, 100);
    expect(split.refundPool).to.equal(89n);
    let paid = 0n;
    for (let i = 0; i < 100; i += 1) {
      paid += entryShare(1n, split.refundPool, 100n); // floor(89/100) = 0
    }
    expect(paid).to.equal(0n);
    expect(paid <= split.refundPool).to.equal(true);
  });

  it("the cap binds on a big pot over a small round and keeps 5:4", () => {
    const SOL = 1_000_000_000n;
    // 100 SOL accrued vs a 10 SOL round: payable == cap == 80 SOL.
    const capped = splitMegaPot(100n * SOL, 10n * SOL, 5_000, 4_000, 80_000);
    expect(capped.awarded + capped.fieldPool).to.equal(80n * SOL);
    expect(capped.retained).to.equal(20n * SOL);
    // The uncapped same accrual against a 20 SOL round pays 90 SOL nominal.
    const uncapped = splitMegaPot(100n * SOL, 20n * SOL, 5_000, 4_000, 80_000);
    expect(uncapped.awarded).to.equal(50n * SOL);
    expect(uncapped.fieldPool).to.equal(40n * SOL);
    expect(uncapped.retained).to.equal(10n * SOL);
  });

  it("R6: v1 bps reproduce the v1 numbers (refund 0..2, uncapped 90/10)", () => {
    const split = splitRoundPot(10_000_000_000n, 9_800, 100, 100);
    expect(split.winnerPayout).to.equal(9_800_000_000n);
    expect(split.adminCut).to.equal(100_000_000n);
    expect(split.refundPool).to.equal(0n, "clean total: the v1 residual bit-for-bit");
    const mega = splitMegaPot(50n * 1_000_000_000n, 1n, 9_000, 0, 0);
    expect(mega.awarded).to.equal(45n * 1_000_000_000n);
    expect(mega.fieldPool).to.equal(0n);
    expect(mega.retained).to.equal(5n * 1_000_000_000n);
  });

  it("throws the typed errors, never NaN or silent wraparound", () => {
    expect(() => splitRoundPot(1n, 9_801, 100, 100)).to.throw(BpsOverflowError);
    expect(() => splitMegaPot(1n, 1n, 6_000, 5_000, 0)).to.throw(BpsOverflowError);
    expect(() => entryShare(1n, 1n, 0n)).to.throw(ZeroTotalError);
    // g == 0 pays nothing and retains everything — never a division by 0n.
    const none = splitMegaPot(123n, 456n, 0, 0, 80_000);
    expect(none.awarded).to.equal(0n);
    expect(none.fieldPool).to.equal(0n);
    expect(none.retained).to.equal(123n);
  });
});
