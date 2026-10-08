/**
 * Window close: when the CHAIN clock has passed `end_ts` and the round is
 * still `Open`, send `lock_round`. Time comparisons use the chain clock
 * snapshot — never local time (validator block time is the authority).
 *
 * Phase 12: an expired EMPTY round is no longer the keeper's business.
 * The program rolls its window in place on the first bet (the bettor's own
 * transaction pays for the revival), so a keeper-side `lock_round` would
 * burn gas to no one's benefit — while idle, the keeper's job is to send
 * ZERO transactions. The one sanctioned exception is the
 * `CRANK_IDLE_ROLL_SECS` safety net: rolling an expired empty window
 * reopens the 20-second auto-deposit window, without which a single
 * missed window freezes every auto-play escrow. Since 2026-10-08 it rolls
 * only while at least one escrow is ARMED (rounds left + balance for its
 * next round): with nobody to serve, an idle keeper sends zero
 * transactions and spends zero lamports.
 *
 * `lock_round` may auto-cancel sole-depositor rounds (zero-deposit rounds
 * never cancel anymore — they roll). The settle pipeline ignores cancelled
 * rounds; the cleanup handler drives refunds + close from there. This
 * evaluator only decides; the supervisor re-reads the round after the send
 * and routes on the new state.
 */

import type { GlobalConfigData, RoundData } from "@orbit-jackpot/sdk";
import type { CrankAction } from "../actions";
import type { ChainClock } from "../rpc";
import type { HandlerCtx } from "../context";

export async function evalLock(
  ctx: HandlerCtx,
  config: GlobalConfigData,
  round: RoundData,
  clock: ChainClock,
): Promise<CrankAction | null> {
  if (config.paused) return null;
  if (round.state !== "open") return null;
  if (clock.unix < round.endTs) return null;

  if (round.totalLamports === 0n) {
    // Empty and expired: the first bettor revives the window in place, so
    // there is nothing to lock. Only the idle-roll safety net (if armed)
    // sends one transaction — and only once the window is far enough past.
    const rollSecs = ctx.cfg.idleRollSecs;
    if (rollSecs <= 0 || clock.unix < round.endTs + BigInt(rollSecs)) {
      return null;
    }
    const entryRent = await ctx.escrows.rentMinimumFor(109); // 8 + PlayerEntry::INIT_SPACE
    const escrowRentMin = await ctx.escrows.rentMinimumFor(122); // 8 + PlayerEscrow::INIT_SPACE
    if (!(await ctx.escrows.anyArmed(config, entryRent, escrowRentMin))) {
      return null; // nobody to auto-deposit — an idle keeper spends nothing
    }
    const keeper = ctx.keeper;
    return {
      kind: "lock_round",
      roundId: round.roundId,
      label: `lock_round r${round.roundId} (idle window roll — reopens the auto-deposit window)`,
      build: () => ctx.client.buildLockRoundTx(round.roundId, keeper.publicKey),
    };
  }

  const keeper = ctx.keeper;
  return {
    kind: "lock_round",
    roundId: round.roundId,
    label: `lock_round ${round.roundId}`,
    build: () => ctx.client.buildLockRoundTx(round.roundId, keeper.publicKey),
  };
}
