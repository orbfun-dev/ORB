/**
 * Action-panel gates (roadmap 7.4): win-probability integer math,
 * deposit validation boundaries (on-chain minimum, balance reserve,
 * decimal-string parsing), additive quick amounts, and the claim/refund
 * entry-matching rules — all pure, no React, no network.
 */

import { describe, expect, it } from "vitest";
import type { PlayerEntryAccountData } from "@orbit-jackpot/sdk";
import {
  DEPOSIT_RESERVE_LAMPORTS,
  sumPlayerLamports,
  validateDeposit,
} from "../src/components/deposit/DepositPanel";
import { addSolToInput } from "../src/components/deposit/QuickAmounts";
import { bpsToPercent, winProbabilityBps } from "../src/components/deposit/WinProbability";
import {
  myClaimableEntry,
  myRefundableEntries,
} from "../src/components/claim/YourRewardsCard";
import { groupDigits } from "../src/lib/format";

const SOL = 1_000_000_000n;

describe("winProbabilityBps — integer basis points only", () => {
  it("matches the directive formula exactly", () => {
    // bps = (staked + existing) × 10_000 / (pot + staked)
    expect(winProbabilityBps(SOL, 0n, SOL)).toBe(5_000n); // 1 into 1 → 50.00%
    expect(winProbabilityBps(0n, SOL, 3n * SOL)).toBe(3_333n); // existing 1/3 → 33.33%
    expect(winProbabilityBps(SOL, SOL, 3n * SOL)).toBe(5_000n); // 2 over (3+1) → 50%
    expect(winProbabilityBps(0n, 0n, 0n)).toBe(0n); // empty round
    expect(winProbabilityBps(SOL, 0n, 0n)).toBe(10_000n); // sole depositor → 100%
  });

  it("floors like the chain does and formats two decimals from bps", () => {
    expect(winProbabilityBps(1n, 0n, 3n)).toBe(2_500n); // floor(10000/4)
    expect(bpsToPercent(3_333n)).toBe("33.33%");
    expect(bpsToPercent(10_000n)).toBe("100.00%");
    expect(bpsToPercent(0n)).toBe("0.00%");
    expect(bpsToPercent(505n)).toBe("5.05%");
  });

  it("stays exact at >MAX_SAFE_INTEGER scale", () => {
    const huge = 2n ** 53n + 1n;
    expect(winProbabilityBps(huge, 0n, huge)).toBe(5_000n);
    expect(winProbabilityBps(huge, huge, huge * 2n)).toBe(6_666n); // 2huge/3huge
  });
});

describe("validateDeposit — boundaries against the on-chain minimum", () => {
  const min = 10_000_000n; // 0.01 SOL, as GlobalConfig initializes

  it("accepts exactly the minimum and clean decimals", () => {
    expect(validateDeposit("0.01", min, null)).toEqual({ ok: true, lamports: 10_000_000n });
    expect(validateDeposit("1.5", min, null)).toEqual({ ok: true, lamports: 1_500_000_000n });
    // one lamport above the minimum passes when balance allows
    expect(validateDeposit("0.010000001", min, null)).toEqual({ ok: true, lamports: 10_000_001n });
  });

  it("rejects below the FETCHED minimum with a dynamic message", () => {
    const result = validateDeposit("0.009", min, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("min");
      expect(result.message).toContain("0.01 SOL");
    }
    // A different config minimum yields a different message — no literal.
    const result2 = validateDeposit("0.02", 5n * SOL, null);
    if (!result2.ok) expect(result2.message).toContain("5 SOL");
  });

  it("rejects malformed input and empty fields by reason", () => {
    expect(validateDeposit("", min, null)).toMatchObject({ ok: false, reason: "empty" });
    expect(validateDeposit("1,5", min, null)).toMatchObject({ ok: false, reason: "parse" });
    expect(validateDeposit("-1", min, null)).toMatchObject({ ok: false, reason: "parse" });
    expect(validateDeposit("0.0000000001", min, null)).toMatchObject({ ok: false, reason: "parse" });
  });

  it("guards the live balance with the rent/fee reserve", () => {
    const balance = SOL + DEPOSIT_RESERVE_LAMPORTS; // exactly enough for 1 SOL
    expect(validateDeposit("1", min, balance)).toEqual({ ok: true, lamports: SOL });
    const over = validateDeposit("1.000000001", min, balance);
    expect(over).toMatchObject({ ok: false, reason: "balance" });
    // null balance (unconnected) skips the guard — the chain enforces it.
    expect(validateDeposit("1.000000001", min, null)).toMatchObject({ ok: true });
  });
});

describe("quick amounts — additive, exact bigint arithmetic", () => {
  it("adds presets to the current input without float drift", () => {
    expect(addSolToInput("", 100_000_000n)).toBe("0.1");
    expect(addSolToInput("0.2", 100_000_000n)).toBe("0.3");
    expect(addSolToInput("0.15", 50_000_000n)).toBe("0.2");
    expect(addSolToInput("1", 5_000_000_000n)).toBe("6");
    expect(addSolToInput("0.1", 900_000_000n)).toBe("1"); // trailing zeros trimmed
    // The classic float trap, done exactly: 0.1 + 0.2 = 0.3
    expect(addSolToInput(addSolToInput("", 100_000_000n), 200_000_000n)).toBe("0.3");
  });

  it("treats malformed current input as zero", () => {
    expect(addSolToInput("garbage", 100_000_000n)).toBe("0.1");
  });
});

describe("sumPlayerLamports — the player's stake in the book", () => {
  const mk = (player: string, amount: bigint): { player: string; amountLamports: bigint } => ({
    player,
    amountLamports: amount,
  });

  it("sums only the wallet's entries", () => {
    const entries = [mk("A", SOL), mk("B", 2n * SOL), mk("A", 500_000_000n)];
    expect(sumPlayerLamports(entries, "A")).toBe(1_500_000_000n);
    expect(sumPlayerLamports(entries, "B")).toBe(2n * SOL);
    expect(sumPlayerLamports(entries, "C")).toBe(0n);
    expect(sumPlayerLamports(entries, null)).toBe(0n);
  });
});

describe("entry matching — claim & refund eligibility", () => {
  const entry = (index: number, player: string, start: bigint, end: bigint): PlayerEntryAccountData => ({
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
  const entries = [
    entry(0, "A", 0n, SOL),
    entry(1, "B", SOL, 3n * SOL),
    entry(2, "A", 3n * SOL, 4n * SOL),
  ];

  it("myClaimableEntry: only the wallet owning the WINNING range, unclaimed", () => {
    // ticket 2 SOL lands in B's range [1, 3)
    expect(myClaimableEntry(entries, 2n * SOL, false, "B")?.entryIndex).toBe(1);
    expect(myClaimableEntry(entries, 2n * SOL, false, "A")).toBeNull();
    expect(myClaimableEntry(entries, 2n * SOL, true, "B")).toBeNull(); // already claimed
    expect(myClaimableEntry(entries, 2n * SOL, false, null)).toBeNull();
    // boundary: ticket 3 SOL is B's exclusive end / A's inclusive start
    expect(myClaimableEntry(entries, 3n * SOL, false, "A")?.entryIndex).toBe(2);
  });

  it("myRefundableEntries: every entry of the wallet in the cancelled round", () => {
    expect(myRefundableEntries(entries, "A").map((e) => e.entryIndex)).toEqual([0, 2]);
    expect(myRefundableEntries(entries, "B").map((e) => e.entryIndex)).toEqual([1]);
    expect(myRefundableEntries(entries, "Z")).toEqual([]);
    expect(myRefundableEntries(entries, null)).toEqual([]);
  });

  it("groupDigits renders >2^53 ticket ranges exactly", () => {
    const huge = 2n ** 53n + 123_456n; // 9,007,199,254,864,448 — beyond float precision
    expect(groupDigits(huge)).toBe("9,007,199,254,864,448");
    expect(groupDigits(huge)).toBe(`${huge.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`);
    expect(groupDigits(1_234n)).toBe("1,234");
  });
});
