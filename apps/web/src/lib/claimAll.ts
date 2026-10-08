/**
 * One claim to empty the rewards card — PURE.
 *
 * Three facts about this program make a single combined claim the only
 * sane shape:
 *
 *  1. `close_entry` REFUSES the winning entry until the prize is claimed
 *     (it would destroy the refund proof). So a player who wins a round
 *     cannot touch that round's 89% until they claim the 9% first.
 *  2. Both instructions pay `entry.player`, never the signer — and for an
 *     auto-played entry `entry.player` is the ESCROW PDA, not the wallet.
 *  3. `claim_winnings` constrains `player.key() == entry.player`
 *     (claim_winnings.rs:60), so a claim built with the wallet in that
 *     slot is rejected outright for every escrow-won round.
 *
 * Together those produced the live 2026-10-07 dead end: an auto-play
 * player won most rounds, every one of their entries was the (unclaimable)
 * winning entry, the prize row never offered the claim that would unlock
 * them, and the card read "0.04 SOL CLAIMABLE REFUND" with no button.
 *
 * This planner emits the prize claims FIRST and the entry closes after, in
 * one transaction, so the chain unlocks each refund in the same signature
 * that claims its prize.
 */

import { entryShare } from "@orbit-jackpot/sdk";

/** One instruction's worth of target. `player` is the payout destination. */
export interface ClaimStep {
  roundId: bigint;
  entryIndex: number;
  /** `entry.player` — the wallet, or the escrow PDA for auto-played entries. */
  player: string;
  /** Lamports this step moves, where the client can know it exactly. */
  lamports: bigint;
}

export interface ClaimAllPlan {
  /** `claim_winnings`, one per won-and-unclaimed round. */
  prizes: ClaimStep[];
  /** `close_entry`, one per entry the chain will accept AFTER the prizes. */
  refunds: ClaimStep[];
  /** Refund + Mega-field lamports this plan credits the ESCROW, exactly. */
  escrowRefundCredit: bigint;
  /** Everything the card is claiming, prizes included (display figure). */
  total: bigint;
  /** Of `total`, the part that only exists once the prizes land. */
  unlockedByPrize: bigint;
  /**
   * Real profit on the won rounds: prize + the winning entry's own refund
   * − its stake. The "+X won" badge shows this, never the raw prize: under
   * v2 a 0.1 SOL winner against 0.01 SOL "won" a 0.0099 prize and still
   * lost 0.0011; under v3 the prize also carries the protected stake.
   */
  wonProfit: bigint;
  /** True when nothing can proceed without claiming a prize first. */
  prizeGated: boolean;
}

/** Only the fields the planner reads — keeps it free of provider types. */
export interface ClaimableRecord {
  roundId: bigint;
  refundPool: bigint;
  megaFieldPool: bigint;
  totalLamports: bigint;
  winningTicket: bigint;
  prizeClaimed: boolean;
  /** The round's still-open entries (closed ones are pruned upstream). */
  entries: readonly {
    entryIndex: number;
    player: string;
    amountLamports: bigint;
    ticketStart: bigint;
    ticketEnd: bigint;
  }[];
  /** `round.winner_payout` when known; the prize is exact on chain either way. */
  winnerPayout?: bigint;
  megaAwarded?: bigint;
}

/**
 * Plans the single combined claim. Both identities are named explicitly
 * (the dual-identity rule) because the plan has to distinguish them: a
 * wallet entry pays straight out, an ESCROW entry pays into the escrow and
 * therefore needs a sweep to reach the player's address.
 */
export function planClaimAll(
  records: Iterable<ClaimableRecord>,
  wallet: string | null,
  escrow: string | null,
): ClaimAllPlan {
  const isMine = (player: string): boolean =>
    (wallet !== null && player === wallet) || (escrow !== null && player === escrow);
  const prizes: ClaimStep[] = [];
  const refunds: ClaimStep[] = [];
  let escrowRefundCredit = 0n;
  let total = 0n;
  let unlockedByPrize = 0n;
  let wonProfit = 0n;

  for (const record of records) {
    if (record.totalLamports <= 0n) continue;
    for (const entry of record.entries) {
      if (!isMine(entry.player)) continue;
      const refund =
        entryShare(entry.amountLamports, record.refundPool, record.totalLamports) +
        entryShare(entry.amountLamports, record.megaFieldPool, record.totalLamports);
      const isWinningEntry =
        record.winningTicket >= entry.ticketStart && record.winningTicket < entry.ticketEnd;

      // The winning entry of an unclaimed round: the prize must land in
      // the SAME transaction, before the close, or the close is refused.
      if (isWinningEntry && !record.prizeClaimed) {
        const prize = (record.winnerPayout ?? 0n) + (record.megaAwarded ?? 0n);
        prizes.push({
          roundId: record.roundId,
          entryIndex: entry.entryIndex,
          player: entry.player,
          lamports: prize,
        });
        total += prize;
        unlockedByPrize += refund;
        wonProfit += prize + refund - entry.amountLamports;
      }
      refunds.push({
        roundId: record.roundId,
        entryIndex: entry.entryIndex,
        player: entry.player,
        lamports: refund,
      });
      total += refund;
      // The escrow sweep may only promise what this client computes
      // EXACTLY. `entryShare` mirrors the on-chain integer math, so refund
      // shares qualify; the prize (not always known off-chain) and the
      // reclaimed entry rent are deliberately left out as margin —
      // `withdraw_escrow` requires `spendable >= amount` and does not
      // clamp (withdraw_escrow.rs:45), so an over-ask would fail the whole
      // claim and strand the prizes with it.
      if (escrow !== null && entry.player === escrow) {
        escrowRefundCredit += refund;
      }
    }
  }

  return {
    prizes,
    refunds,
    escrowRefundCredit,
    total,
    wonProfit,
    unlockedByPrize,
    prizeGated: prizes.length > 0 && refunds.length === prizes.length,
  };
}

/**
 * Packs whole rounds into as few transactions as fit — PURE.
 *
 * `rounds` are each round's instructions (prizes first, then closes — the
 * order the chain needs); `fits` says whether a candidate instruction list
 * still fits one transaction. A round is never split across transactions:
 * its prize claim must land in the same signature as the closes it
 * unlocks. A round too large to fit even alone is reported, not sent.
 */
export function packClaimBatches<T>(
  rounds: Array<{ key: string; instructions: T[] }>,
  fits: (instructions: T[]) => boolean,
): { batches: Array<{ keys: string[]; instructions: T[] }>; oversized: string[] } {
  const batches: Array<{ keys: string[]; instructions: T[] }> = [];
  const oversized: string[] = [];
  let current: { keys: string[]; instructions: T[] } | null = null;
  for (const round of rounds) {
    if (!fits(round.instructions)) {
      oversized.push(round.key);
      continue;
    }
    if (current !== null && fits([...current.instructions, ...round.instructions])) {
      current.keys.push(round.key);
      current.instructions.push(...round.instructions);
      continue;
    }
    current = { keys: [round.key], instructions: [...round.instructions] };
    batches.push(current);
  }
  return { batches, oversized };
}
