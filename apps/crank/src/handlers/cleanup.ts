/**
 * The cleanup chain — terminal rounds owe value or rent until fully
 * pruned, and the crank owes them a close. Under Phase 11 this loop is the
 * PLAYERS' money: every `close_entry` delivers an 89%-pool refund (+ Mega
 * field share on a trigger) plus the entry's rent to `entry.player` — the
 * wallet for direct depositors, the PlayerEscrow for auto-deposit players
 * (where `auto_reinvest` rolls it into the next round).
 *
 *   Settled (losers' entries close immediately — AUDIT C-4; only the
 *   winning entry waits for its claim):
 *     1. unclaimed prize, past `settle_ts + claim_deadline_secs` →
 *        `sweep_unclaimed_prize`. R4-isolated: exactly the winner's
 *        `winner_payout + mega_awarded` reroutes to the Mega-Pot — the
 *        refund pool stays owed to the field, forever claimable. (The
 *        `CRANK_CLAIM_FOR_WINNERS=1` alternative claims FOR the absent
 *        winner at the deadline's halfway point instead.)
 *     2. entries_closed < entry_count → `close_entry` in BATCHES of up to
 *        `CRANK_CLOSE_BATCH_MAX_PER_TX` (the SDK's packet-width-measured
 *        11/tx). The winning entry is filtered out of every batch until
 *        `prize_claimed` is set. A batch is atomic: if it fails, that
 *        round downgrades to single closes so one bad entry cannot stall
 *        the other ten — both paths carry `quarantineOnFailure: false`
 *        (routine contention must never strand a round's refunds).
 *     3. fully pruned → `close_randomness` (Phase 13: the round PDA closes
 *        its Switchboard randomness account + reward escrow; the ≈0.0046
 *        SOL lands in the round account and rides the next step home;
 *        the LUT is deactivated and reclaimed later by the LUT sweep)
 *     4. → `close_round` (dust → Mega-Pot, both rents →
 *        `round.rent_payer` — the opener, i.e. usually THIS keeper; admin
 *        fallback for pre-Phase-12 legacy rounds)
 *
 *   Cancelled (zero-deposit or sole depositor — no randomness involved):
 *     1. remaining entries → `refund_entry` (pays the player AND closes
 *        the entry in one shot — the only sanctioned cleanup here)
 *     2. fully refunded → `close_round`
 *
 * Cancelled-round refunds run immediately — players are waiting; settled
 * cleanup is deadline-driven. A settled round un-pruned past
 * `CRANK_STUCK_CLEANUP_ALERT_SECS` trips the health alert: players are
 * waiting on principal, not just rent.
 */

import type { GlobalConfigData, PlayerEntryAccountData, RoundData } from "@orbit-jackpot/sdk";
import { entropyChainKey, rentReclaimDestination } from "@orbit-jackpot/sdk";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { lutKeys } from "../randomness";
import type { CrankAction } from "../actions";
import type { HandlerCtx } from "../context";
import type { ChainClock } from "../rpc";

/** True when the entry's ticket range contains the winning ticket. */
function isWinningEntry(entry: PlayerEntryAccountData, round: RoundData): boolean {
  return round.winningTicket >= entry.ticketStart && round.winningTicket < entry.ticketEnd;
}

export async function evalCleanup(
  ctx: HandlerCtx,
  config: GlobalConfigData,
  round: RoundData,
  clock: ChainClock,
): Promise<CrankAction | null> {
  if (config.paused || !ctx.cfg.cleanupEnabled) return null;
  if (ctx.book.isQuarantined(round.roundId) !== null) return null;

  const keeper = ctx.keeper;
  const roundId = round.roundId;

  if (round.state === "cancelled") {
    if (round.entriesClosed < round.entryCount) {
      const entries = await ctx.bridge.entries(roundId, round.entryCount);
      const next = entries[0];
      if (next === undefined) {
        // All accounts gone but the counter disagrees — reconcile on chain
        // is impossible from here; close_round will fail loudly.
        ctx.logger.warn({ roundId: roundId.toString() }, "cancelled round: counter says entries remain but none exist");
        return null;
      }
      return {
        kind: "refund_entry",
        roundId,
        label: `refund_entry r${roundId} #${next.entryIndex} → ${next.player.slice(0, 8)}…`,
        build: () => ctx.client.buildRefundTx(new PublicKey(next.player), roundId, next.entryIndex, keeper.publicKey),
      };
    }
    return (await closeRandomnessAction(ctx, round, config)) ?? closeRoundAction(ctx, round, config);
  }

  if (round.state !== "settled") return null;

  if (!round.prizeClaimed) {
    const deadline = round.settleTs + config.claimDeadlineSecs;
    const grace = round.settleTs + config.claimDeadlineSecs / 2n;
    if (ctx.cfg.claimForWinners && clock.unix >= grace) {
      const entries = await ctx.bridge.entries(roundId, round.entryCount);
      const winner = entries.find((e) => isWinningEntry(e, round));
      if (winner === undefined) {
        ctx.logger.error({ roundId: roundId.toString() }, "claim-for-winner: winning entry account missing");
        return null;
      }
      return {
        kind: "claim_winnings",
        roundId,
        label: `claim_winnings r${roundId} for absent winner ${winner.player.slice(0, 8)}…`,
        build: () => ctx.client.buildClaimTx(new PublicKey(winner.player), roundId, winner.entryIndex),
      };
    }
    if (clock.unix > deadline) {
      return {
        kind: "sweep_unclaimed_prize",
        roundId,
        label: `sweep_unclaimed_prize r${roundId} (${round.winnerPayout + round.megaAwarded} prize lamports → mega-pot; refunds stay owed)`,
        build: () => ctx.client.buildSweepUnclaimedPrizeTx(roundId, keeper.publicKey),
      };
    }
    // AUDIT C-4: inside the claim window only the WINNING entry is gated
    // on chain (close_entry refuses it until the prize is claimed). Every
    // other entry's 89% refund flows now — losers (and auto-play escrows
    // waiting to reinvest) never wait on a slow winner. Fall through: the
    // close step below already filters the winning entry out.
  }

  if (round.entriesClosed < round.entryCount) {
    const entries = await ctx.bridge.entries(roundId, round.entryCount);
    // Belt over the sweep-first ordering: the winning entry's membership
    // proof is worthless once prize_claimed is set, and never before.
    const closable = entries.filter(
      (e) => round.prizeClaimed || !isWinningEntry(e, round),
    );
    if (closable.length === 0) return null;

    // A batch is atomic: one failed batch downgrades this ROUND to single
    // closes (the executor keys failures "kind:roundId", and a successful
    // batch resets the key) — one bad entry must not stall the other ten.
    const batchKey = `close_entry_batch:${roundId}`;
    if (ctx.book.failureCount(batchKey) > 0) {
      const next = closable[0]!;
      ctx.logger.warn(
        { roundId: roundId.toString(), entryIndex: next.entryIndex },
        "close_entry batch failed — downgraded to single closes for this round",
      );
      return {
        kind: "close_entry",
        roundId,
        quarantineOnFailure: false,
        label: `close_entry r${roundId} #${next.entryIndex} (refund+rent → ${next.player.slice(0, 8)}…)`,
        build: () =>
          ctx.client.buildCloseEntryTx(new PublicKey(next.player), roundId, next.entryIndex, keeper.publicKey),
      };
    }

    const width = Math.min(closable.length, ctx.cfg.closeBatchMaxPerTx);
    const batch = closable.slice(0, width).map((e) => ({
      entryIndex: e.entryIndex,
      player: new PublicKey(e.player),
    }));
    const refundsOwed = round.refundPool - round.refundsPaid;
    return {
      kind: "close_entry_batch",
      roundId,
      quarantineOnFailure: false,
      label: `close_entry_batch r${roundId} ×${batch.length} (refunds owed ${refundsOwed} lamports)`,
      build: () => ctx.client.buildCloseEntryBatchTx(roundId, batch, keeper.publicKey),
    };
  }

  return (await closeRandomnessAction(ctx, round, config)) ?? closeRoundAction(ctx, round, config);
}

/** After this many failed attempts the LUT sweep stops polling the
 *  round's table until a later close_randomness re-registers it. */
export const CLOSE_RANDOMNESS_MAX_FAILURES = 2;

/**
 * Phase 13: reclaim the round's Switchboard rent while its PDA — the
 * randomness account's only authority — still exists. Null only when the
 * round never pinned randomness (or the pin is already cleared).
 *
 * AUDIT P-4: the program refuses `close_round` until `close_randomness`
 * has cleared the pin, so there is no giving up here any more — a round
 * whose close keeps failing stays open (its rent recoverable after a fix)
 * instead of stranding the Switchboard rent for good. An account that is
 * already gone still gets the call: the program then only clears the pin
 * (rounds closed by the pre-P-4 build).
 */
async function closeRandomnessAction(
  ctx: HandlerCtx,
  round: RoundData,
  config: GlobalConfigData,
): Promise<CrankAction | null> {
  if (round.randomnessAccount === PublicKey.default.toBase58()) return null;
  const roundId = round.roundId;
  const pinned = new PublicKey(round.randomnessAccount);
  const keeperKey = ctx.keeper.publicKey;
  if (pinned.equals(entropyChainKey())) {
    // Randomness fallback: the shared chain account is never closed; the
    // program only clears the pin (the Switchboard accounts below are
    // still required by the context but untouched).
    const oracleProgram = new PublicKey(config.oracleProgramId);
    return {
      kind: "close_randomness",
      roundId,
      quarantineOnFailure: false,
      label: `close_randomness r${roundId} (entropy pin — clear only)`,
      build: async () => {
        const { lutSigner, lut } = lutKeys(oracleProgram, pinned, 0n);
        return ctx.client.buildCloseRandomnessTx(
          roundId,
          pinned,
          getAssociatedTokenAddressSync(NATIVE_MINT, pinned, true),
          await ctx.sb.programStateKey(),
          lutSigner,
          lut,
          oracleProgram,
          keeperKey,
        );
      },
    };
  }
  const view = await ctx.bridge.randomness(pinned);
  const lutSlot = view?.lutSlot ?? 0n; // gone: the program only clears the pin
  const oracleProgram = new PublicKey(config.oracleProgramId);
  const { lutSigner, lut } = lutKeys(oracleProgram, pinned, lutSlot);
  const keeper = ctx.keeper;
  return {
    kind: "close_randomness",
    roundId,
    quarantineOnFailure: false,
    label:
      view === null
        ? `close_randomness r${roundId} (account already gone — clear the pin)`
        : `close_randomness r${roundId} (Switchboard rent → round → opener)`,
    build: async () => {
      // The randomness account is the only on-chain record of lut_slot;
      // copy it out BEFORE the close deletes it, so the LUT sweep can
      // still find the table after its cooldown.
      if (lutSlot > 0n) ctx.book.rememberLut(roundId, pinned.toBase58(), lutSlot);
      return ctx.client.buildCloseRandomnessTx(
        roundId,
        pinned,
        getAssociatedTokenAddressSync(NATIVE_MINT, pinned),
        await ctx.sb.programStateKey(),
        lutSigner,
        lut,
        oracleProgram,
        keeper.publicKey,
      );
    },
  };
}

/** Phase 12: the rents follow the round's recorded opener (the SDK's
 * mirror of the on-chain resolver) — this keeper recovers its own capital
 * on rounds it opened; legacy pre-Phase-12 rounds still route to admin. */
function closeRoundAction(
  ctx: HandlerCtx,
  round: RoundData,
  config: GlobalConfigData,
): CrankAction {
  const keeper = ctx.keeper;
  const destination = rentReclaimDestination(round, config);
  return {
    kind: "close_round",
    roundId: round.roundId,
    label: `close_round r${round.roundId} (dust → mega-pot, rents → ${destination.toBase58().slice(0, 8)}…)`,
    build: () => ctx.client.buildCloseRoundTx(round.roundId, destination, keeper.publicKey),
  };
}
