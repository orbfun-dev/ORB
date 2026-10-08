/**
 * The combined claim (live 2026-10-07 dead end): an auto-play player won
 * most rounds, so every entry of theirs WAS the winning entry — which
 * `close_entry` refuses until the prize is claimed. With the prize claim
 * and the entry close in separate transactions (and the prize claim built
 * with the wrong `player` account entirely), the card showed
 * "0.04 SOL CLAIMABLE REFUND" and no button at all.
 */

import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { packClaimBatches, planClaimAll, type ClaimableRecord } from "../src/lib/claimAll";
import { escrowAddressOf } from "../src/lib/identity";

const WALLET = new PublicKey(new Uint8Array(32).fill(11)).toString();
const ESCROW = escrowAddressOf(WALLET);
const STRANGER = new PublicKey(new Uint8Array(32).fill(22)).toString();

/** Round 273 as probed live: 0.02 SOL pot, two 0.01 entries, 89% pool. */
function record(over: Partial<ClaimableRecord> = {}): ClaimableRecord {
  return {
    roundId: 273n,
    totalLamports: 20_000_000n,
    refundPool: 17_800_000n,
    megaFieldPool: 0n,
    winningTicket: 15_000_000n, // inside entry #1
    prizeClaimed: false,
    winnerPayout: 1_800_000n,
    megaAwarded: 0n,
    entries: [
      {
        entryIndex: 0,
        player: STRANGER,
        amountLamports: 10_000_000n,
        ticketStart: 0n,
        ticketEnd: 10_000_000n,
      },
      {
        entryIndex: 1,
        player: ESCROW,
        amountLamports: 10_000_000n,
        ticketStart: 10_000_000n,
        ticketEnd: 20_000_000n,
      },
    ],
    ...over,
  };
}

describe("planClaimAll — prize first, in the same signature", () => {
  it("claims the prize AND closes the entry it unlocks", () => {
    const plan = planClaimAll([record()], WALLET, ESCROW);
    expect(plan.prizes).toHaveLength(1);
    expect(plan.refunds).toHaveLength(1);
    expect(plan.prizes[0]!.entryIndex).toBe(1);
    expect(plan.prizeGated).toBe(true);
  });

  it("routes both to entry.player — the ESCROW, never the wallet", () => {
    // The live failure: `claim_winnings` constrains
    // `player.key() == entry.player`, so a claim addressed to the wallet
    // is rejected for every escrow-won round.
    const plan = planClaimAll([record()], WALLET, ESCROW);
    expect(plan.prizes[0]!.player).toBe(ESCROW);
    expect(plan.refunds[0]!.player).toBe(ESCROW);
  });

  it("states the refund the prize unlocks, and the total including it", () => {
    const plan = planClaimAll([record()], WALLET, ESCROW);
    // 89% pool, half the pot: 8_900_000.
    expect(plan.refunds[0]!.lamports).toBe(8_900_000n);
    expect(plan.unlockedByPrize).toBe(8_900_000n);
    expect(plan.total).toBe(8_900_000n + 1_800_000n);
  });

  it("needs no prize claim once the round's prize is already claimed", () => {
    const plan = planClaimAll([record({ prizeClaimed: true })], WALLET, ESCROW);
    expect(plan.prizes).toHaveLength(0);
    expect(plan.refunds).toHaveLength(1);
    expect(plan.prizeGated).toBe(false);
  });

  it("needs no prize claim when someone else holds the winning entry", () => {
    const plan = planClaimAll([record({ winningTicket: 5_000_000n })], WALLET, ESCROW);
    expect(plan.prizes).toHaveLength(0);
    expect(plan.refunds).toHaveLength(1);
  });

  it("ignores rounds the wallet has no entry in", () => {
    const foreign = record({ entries: [record().entries[0]!] });
    expect(planClaimAll([foreign], WALLET, ESCROW).refunds).toHaveLength(0);
  });

  it("counts ONLY escrow-destined refunds toward the sweep, and only exactly", () => {
    // Wallet entries pay straight out, so they must not inflate the sweep;
    // the prize and the reclaimed entry rent stay out as margin because
    // withdraw_escrow does not clamp.
    const escrowSide = planClaimAll([record()], WALLET, ESCROW);
    expect(escrowSide.escrowRefundCredit).toBe(8_900_000n);

    const walletSide = planClaimAll(
      [record({ entries: [{ ...record().entries[1]!, player: WALLET }] })],
      WALLET,
      ESCROW,
    );
    expect(walletSide.refunds).toHaveLength(1);
    expect(walletSide.escrowRefundCredit).toBe(0n);
  });

  it("accumulates across every settled round the player still holds", () => {
    const plan = planClaimAll(
      [record({ roundId: 273n }), record({ roundId: 272n }), record({ roundId: 271n })],
      WALLET,
      ESCROW,
    );
    expect(plan.prizes).toHaveLength(3);
    expect(plan.refunds).toHaveLength(3);
    expect(plan.total).toBe(3n * (8_900_000n + 1_800_000n));
  });

  it("is empty and harmless with no records or no wallet", () => {
    expect(planClaimAll([], WALLET, ESCROW).total).toBe(0n);
    expect(planClaimAll([record()], null, null).refunds).toHaveLength(0);
  });
});

describe("planClaimAll — the won badge shows real profit", () => {
  it("v2 0.01 vs 0.01: prize 0.0018 + refund 0.0089 − stake 0.01 = +0.0007", () => {
    expect(planClaimAll([record()], WALLET, ESCROW).wonProfit).toBe(700_000n);
  });

  it("v2, the owner's case (0.1 vs 0.01): a 0.0099 prize is a 0.0011 LOSS — no badge", () => {
    const plan = planClaimAll(
      [
        record({
          totalLamports: 110_000_000n,
          refundPool: 97_900_000n,
          winnerPayout: 9_900_000n,
          winningTicket: 50_000_000n,
          entries: [
            { entryIndex: 0, player: ESCROW, amountLamports: 100_000_000n, ticketStart: 0n, ticketEnd: 100_000_000n },
            { entryIndex: 1, player: STRANGER, amountLamports: 10_000_000n, ticketStart: 100_000_000n, ticketEnd: 110_000_000n },
          ],
        }),
      ],
      WALLET,
      ESCROW,
    );
    expect(plan.wonProfit).toBe(-1_100_000n);
  });

  it("v3, the same round: +0.0009 (9% of the loser's 0.01)", () => {
    const plan = planClaimAll(
      [
        record({
          totalLamports: 110_000_000n,
          refundPool: 97_900_000n,
          winnerPayout: 11_900_000n, // split_round_pot_v3 residual
          winningTicket: 50_000_000n,
          entries: [
            { entryIndex: 0, player: ESCROW, amountLamports: 100_000_000n, ticketStart: 0n, ticketEnd: 100_000_000n },
            { entryIndex: 1, player: STRANGER, amountLamports: 10_000_000n, ticketStart: 100_000_000n, ticketEnd: 110_000_000n },
          ],
        }),
      ],
      WALLET,
      ESCROW,
    );
    expect(plan.wonProfit).toBe(900_000n);
  });
});

describe("packClaimBatches", () => {
  const round = (key: string, n: number) => ({ key, instructions: Array.from({ length: n }, (_, i) => `${key}:${i}`) });
  const fitsUpTo = (max: number) => (ixs: string[]) => ixs.length <= max;

  it("packs whole rounds greedily into as few transactions as fit", () => {
    const { batches, oversized } = packClaimBatches(
      [round("1", 2), round("2", 2), round("3", 2), round("4", 1)],
      fitsUpTo(4),
    );
    expect(batches.map((b) => b.keys)).toEqual([["1", "2"], ["3", "4"]]);
    expect(oversized).toEqual([]);
  });

  it("never splits a round: its prize must land with the closes it unlocks", () => {
    const { batches } = packClaimBatches([round("1", 3), round("2", 3)], fitsUpTo(4));
    expect(batches.map((b) => b.instructions)).toEqual([
      ["1:0", "1:1", "1:2"],
      ["2:0", "2:1", "2:2"],
    ]);
  });

  it("reports a round too large for any single transaction instead of sending it", () => {
    const { batches, oversized } = packClaimBatches([round("1", 9), round("2", 1)], fitsUpTo(4));
    expect(oversized).toEqual(["1"]);
    expect(batches.map((b) => b.keys)).toEqual([["2"]]);
  });

  it("returns nothing for nothing", () => {
    expect(packClaimBatches([], fitsUpTo(4))).toEqual({ batches: [], oversized: [] });
  });
});
