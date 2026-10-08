/**
 * Auto-deposit evaluation (Phase 10 design §5.3–§5.4).
 *
 * `isEligible` is the pure mirror of the on-chain guards
 * (`crank_auto_deposit` steps 1–10), tested case by case against the Rust
 * suite. The keeper never uses the owner window exemption — it is a
 * permissionless caller, so it must be inside
 * `now <= start_ts + auto_deposit_window_secs` like any third party; the
 * exemption belongs to the player's own browser.
 *
 * `evalAutoDeposit` batches up to `CRANK_AUTO_DEPOSIT_MAX_PER_TX`
 * eligible escrows into one transaction with FRESH entry indices per send
 * attempt (entry-index contention with human deposits is the main failure
 * mode — the same contract as `useDeposit`). Failures are routine
 * contention, never round-breaking: `quarantineOnFailure: false`
 * (design §0.4 — `evalSettle`/`evalCleanup` both bail on quarantined
 * rounds, so a cosmetic failure must never strand a live pot), and the
 * final attempt falls back to a single escrow so one bad escrow cannot
 * block the rest.
 */

import type { GlobalConfigData, PlayerEscrowData, RoundData } from "@orbit-jackpot/sdk";
import type { CrankAction } from "../actions";
import type { EscrowCandidate, HandlerCtx } from "../context";
import type { ChainClock } from "../rpc";

export function isEligible(
  escrow: PlayerEscrowData,
  escrowLamports: bigint,
  round: RoundData,
  config: GlobalConfigData,
  clock: ChainClock,
  entryRent: bigint,
  escrowRentMin: bigint,
): boolean {
  return (
    config.autoDepositEnabled &&
    !config.paused &&
    round.state === "open" &&
    clock.unix < round.endTs &&
    clock.unix <= round.startTs + config.autoDepositWindowSecs &&
    round.roundId >= escrow.nextEligibleRoundId &&
    escrow.roundsRemaining > 0 &&
    escrow.perRoundLamports >= config.minDepositLamports &&
    (config.maxEntriesPerRound === 0 || round.entryCount < config.maxEntriesPerRound) &&
    escrowLamports - escrowRentMin >=
      escrow.perRoundLamports + entryRent + config.autoDepositTipLamports
  );
}

export async function evalAutoDeposit(
  ctx: HandlerCtx,
  config: GlobalConfigData,
  round: RoundData,
  clock: ChainClock,
): Promise<CrankAction | null> {
  // Env kill switch (deployment order step 3: ship with the feature off)
  // and the scan throttle — the window is short but scans are cheap; the
  // interval keeps retries paced without blocking other actions.
  if (!ctx.cfg.autoDepositEnabled || !config.autoDepositEnabled) return null;
  if (!ctx.escrows.autoDepositDue(ctx.cfg.autoDepositIntervalMs)) return null;

  const entryRent = await ctx.escrows.rentMinimumFor(109); // 8 + PlayerEntry::INIT_SPACE
  const escrowRentMin = await ctx.escrows.rentMinimumFor(122); // 8 + PlayerEscrow::INIT_SPACE
  const eligible = await ctx.escrows.eligible(round, config, clock, entryRent, escrowRentMin);
  if (eligible.length === 0) return null;

  const batch = eligible.slice(0, ctx.cfg.autoDepositMaxPerTx);
  let attempt = 0;
  return {
    kind: "auto_deposit",
    roundId: round.roundId,
    label: `auto_deposit ${round.roundId} ×${batch.length}`,
    sendAttempts: 3,
    // §0.4: routine contention must never quarantine a live round.
    quarantineOnFailure: false,
    // A FRESH `nextEntryIndex` read per attempt — a human deposit landing
    // between the read and the landing invalidates every entry PDA in the
    // batch, so each retry re-derives the indices (useDeposit's contract).
    build: async () => {
      attempt += 1;
      const first = await ctx.client.nextEntryIndex(round.roundId);
      // Final attempt: one escrow per transaction, so a single bad escrow
      // cannot block the rest — the others retry next tick, still inside
      // the window (§5.4's fallback).
      const chosen: EscrowCandidate[] =
        attempt >= 3 && batch.length > 1 ? batch.slice(0, 1) : batch;
      return ctx.client.buildCrankAutoDepositBatchTx(
        round.roundId,
        chosen.map((c) => c.owner),
        ctx.keeper.publicKey,
        first,
      );
    },
    after: async () => {
      ctx.escrows.noteAutoDeposit(round.roundId, batch.length);
    },
  };
}
