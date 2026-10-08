/**
 * Phase 11.9 gates: the soft-jackpot player surface must state the truth —
 * the exact pro-rata refund/field shares a settled round owes each entry
 * (pure function, SDK `entryShare` arithmetic), and the first-bet cost
 * disclosure's balance validation (fee + rent held aside on top of the
 * stake). No floats anywhere.
 */

import { describe, expect, it } from "vitest";
import {
  DEPOSIT_RESERVE_LAMPORTS,
  PROFILE_RENT_ESTIMATE_LAMPORTS,
  validateDeposit,
} from "../src/components/deposit/DepositPanel";
import {
  combineRefundRows,
  mySettledPayouts,
  refundRowsOf,
} from "../src/components/claim/YourRewardsCard";
import type { RefundRound } from "../src/context/RoundDataProvider";
import { escrowAddressOf } from "../src/lib/identity";
import { PublicKey } from "@solana/web3.js";

const SOL = 1_000_000_000n;
/** A real pubkey and its REAL escrow PDA — `isMyKey` derives the second
 *  from the first, so a synthetic string would not be recognised. */
const WALLET = new PublicKey(new Uint8Array(32).fill(7)).toString();
const ESCROW = escrowAddressOf(WALLET);

/**
 * One settled round owing exactly one entry its 89%, run through the REAL
 * `refundRowsOf` so the combiner is tested over the same shape the card
 * renders. `winning: true` puts the winning ticket inside the entry's
 * range with the prize unclaimed — the on-chain refusal the row models.
 */
function row({
  roundId,
  entryIndex,
  amount,
  player = WALLET,
  winning = false,
}: {
  roundId: bigint;
  entryIndex: number;
  amount: bigint;
  player?: string;
  winning?: boolean;
}) {
  const record: RefundRound = {
    roundId,
    refundPool: (amount * 8_900n) / 10_000n,
    megaFieldPool: 0n,
    totalLamports: amount,
    winningTicket: winning ? 0n : amount, // outside the range unless winning
    prizeClaimed: false,
    settleTs: 1_700_000_000n + roundId,
    entries: [
      {
        roundId,
        entryIndex,
        player,
        amountLamports: amount,
        ticketStart: 0n,
        ticketEnd: amount,
        depositTs: 0n,
        depositSlot: 0n,
        bump: 0,
      },
    ],
  };
  return refundRowsOf([record], WALLET)[0]!;
}

describe("mySettledPayouts — the loser-payout math the rewards card states", () => {
  const entries = [
    { entryIndex: 0, player: "A".repeat(44), amountLamports: SOL },
    { entryIndex: 1, player: "B".repeat(44), amountLamports: 3n * SOL },
    { entryIndex: 2, player: "C".repeat(44), amountLamports: 6n * SOL },
  ];

  it("the canonical 10 SOL round: every 1 SOL entry is owed exactly 0.89 SOL", () => {
    const payouts = mySettledPayouts(entries, "B".repeat(44), 89n * SOL / 10n * 10n / 10n, 0n, 10n * SOL);
    // B holds 3 SOL of the 10 SOL pot: 3 × 0.89 = 2.67 SOL.
    expect(payouts).toHaveLength(1);
    expect(payouts[0]!.refund).toBe(2_670_000_000n);
    expect(payouts[0]!.megaField).toBe(0n);
  });

  it("adds the Mega field share on a triggered round (4 SOL of a 10 SOL pot field pool)", () => {
    const payouts = mySettledPayouts(entries, "C".repeat(44), 8_900_000_000n, 4_000_000_000n, 10n * SOL);
    // C: 6/10 of the refund pool + 6/10 of the field pool.
    expect(payouts[0]!.refund).toBe(5_340_000_000n);
    expect(payouts[0]!.megaField).toBe(2_400_000_000n);
  });

  it("a sole entry draws the whole pool exactly — dust 0 (the single-entry belt)", () => {
    const sole = [{ entryIndex: 0, player: "A".repeat(44), amountLamports: SOL }];
    const payouts = mySettledPayouts(sole, "A".repeat(44), 890_000_000n, 0n, SOL);
    expect(payouts[0]!.refund).toBe(890_000_000n);
  });

  it("the 100 × 1-lamport regression: shares floor to zero, never overdraw", () => {
    const lamportEntries = Array.from({ length: 100 }, (_, i) => ({
      entryIndex: i,
      player: `${i}`.repeat(44),
      amountLamports: 1n,
    }));
    const payouts = mySettledPayouts(lamportEntries, "5".repeat(44), 89n, 0n, 100n);
    expect(payouts[0]!.refund).toBe(0n);
  });
});

describe("validateDeposit — the first-bet cost disclosure's arithmetic", () => {
  const fee = 10_000_000n; // 0.01 SOL
  const firstBetExtra = fee + PROFILE_RENT_ESTIMATE_LAMPORTS;

  it("holds the one-time fee + rent aside on top of the usual reserve", () => {
    const stake = 100_000_000n;
    const justShort = stake + DEPOSIT_RESERVE_LAMPORTS + firstBetExtra - 1n;
    expect(validateDeposit("0.1", null, justShort, firstBetExtra).ok).toBe(false);
    const exactlyEnough = stake + DEPOSIT_RESERVE_LAMPORTS + firstBetExtra;
    const ok = validateDeposit("0.1", null, exactlyEnough, firstBetExtra);
    expect(ok.ok).toBe(true);
  });

  it("names the one-time costs in the failure message only when they apply", () => {
    const result = validateDeposit("0.1", null, 50_000_000n, firstBetExtra);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("balance");
      expect(result.message).to.match(/first bet/);
    }
    const repeat = validateDeposit("0.1", null, 50_000_000n, 0n);
    expect(repeat.ok).toBe(false);
    if (!repeat.ok) expect(repeat.message).to.not.match(/first bet/);
  });

  it("the rent estimate matches the (128+122)×3480×2 profile rent", () => {
    expect(PROFILE_RENT_ESTIMATE_LAMPORTS).toBe(1_740_000n);
  });
});

describe("combineRefundRows — one figure, not one card per round", () => {
  it("sums every round into a single total and flattens the closable set", () => {
    const rows = [
      row({ roundId: 267n, entryIndex: 0, amount: 10_000_000n }),
      row({ roundId: 266n, entryIndex: 0, amount: 10_000_000n }),
    ];
    const combined = combineRefundRows(rows, WALLET);
    expect(combined.roundCount).to.equal(2);
    expect(combined.entryCount).to.equal(2);
    expect(combined.total).to.equal(rows[0]!.total + rows[1]!.total);
    expect(combined.closable.map((c) => c.roundId)).to.deep.equal([267n, 266n]);
  });

  it("separates lamports still withheld behind an unresolved prize", () => {
    // The winning entry is refused on-chain until the prize resolves, so
    // its share is owed but not claimable yet.
    const locked = row({ roundId: 268n, entryIndex: 0, amount: 10_000_000n, winning: true });
    const combined = combineRefundRows([locked], WALLET);
    expect(combined.closable).to.have.length(0);
    expect(combined.lockedLamports).to.equal(locked.total);
    expect(combined.total).to.equal(locked.total);
  });

  it("flags escrow-destined payouts so the card can say where the money lands", () => {
    const mine = combineRefundRows([row({ roundId: 1n, entryIndex: 0, amount: 1_000_000n })], WALLET);
    expect(mine.anyEscrow).to.equal(false);
    const viaEscrow = combineRefundRows(
      [row({ roundId: 1n, entryIndex: 0, amount: 1_000_000n, player: ESCROW })],
      WALLET,
    );
    expect(viaEscrow.anyEscrow).to.equal(true);
  });

  it("splits the CLOSABLE lamports by destination — the claim toast's figures", () => {
    // One wallet entry and one escrow entry claimable now, plus one
    // winning entry still locked: the split must cover only what CLAIM
    // ALL pays this click.
    const walletRow = row({ roundId: 1n, entryIndex: 0, amount: 1_000_000n });
    const escrowRow = row({ roundId: 2n, entryIndex: 0, amount: 2_000_000n, player: ESCROW });
    const lockedRow = row({ roundId: 3n, entryIndex: 0, amount: 4_000_000n, player: ESCROW, winning: true });
    const combined = combineRefundRows([walletRow, escrowRow, lockedRow], WALLET);
    expect(combined.closableLamports).to.equal(walletRow.total + escrowRow.total);
    expect(combined.closableWalletLamports).to.equal(walletRow.total);
    expect(combined.closableEscrowLamports).to.equal(escrowRow.total);
    expect(combined.lockedLamports).to.equal(lockedRow.total);
    // The figures reconcile with the row totals.
    expect(
      combined.closableLamports + combined.lockedLamports,
    ).to.equal(combined.total);
  });

  it("is empty and harmless with no rows", () => {
    const combined = combineRefundRows([], WALLET);
    expect(combined.total).to.equal(0n);
    expect(combined.roundCount).to.equal(0);
    expect(combined.closable).to.have.length(0);
  });
});
