/**
 * Phase 12.5 availability-matrix gates for the permissionless community
 * crank — the pure decision core `manualCrankAvailability`, tested exactly
 * as `mySettledPayouts` is in SettledRefundBanner: no provider, no wallet,
 * no chain. Chain time is an argument, so clock-skew behaviour is directly
 * exercisable.
 */

import { describe, expect, it } from "vitest";
import type { GlobalConfigData, RoundData } from "@orbit-jackpot/sdk";
import {
  MANUAL_CRANK_GRACE_SECS,
  manualCrankAvailability,
} from "../src/hooks/useManualCrank";

const NOW = 1_700_000_000n;

const config = (overrides: Partial<GlobalConfigData> = {}): GlobalConfigData => ({
  admin: "A".repeat(44),
  pendingAdmin: null,
  treasuryAuthority: "B".repeat(44),
  oracleProgramId: "C".repeat(44),
  oracleQueue: "D".repeat(44),
  feeBpsAdmin: 100,
  feeBpsMega: 100,
  winnerBps: 900,
  refundBps: 8_900,
  megaAwardBps: 5_000,
  megaFieldBps: 4_000,
  megaTriggerModulus: 625,
  megaPayoutCapBps: 80_000,
  accountOpenFeeLamports: 10_000_000n,
  economicsVersion: 2,
  maxEntriesPerRound: 500,
  roundDurationSecs: 120n,
  maxRoundDurationSecs: 600n,
  antiSnipeWindowSecs: 30n,
  antiSnipeExtensionSecs: 15n,
  claimDeadlineSecs: 3_600n,
  minDepositLamports: 10_000_000n,
  antiSnipeMinDepositLamports: 100_000_000n,
  keeperTipLamports: 1_000_000n,
  randomnessRevealDeadlineSlots: 400n,
  activeRoundId: 7n,
  nextRoundId: 8n,
  oracleProvider: "switchboard",
  paused: false,
  bump: 254,
  autoDepositWindowSecs: 20n,
  autoDepositTipLamports: 200_000n,
  autoDepositEnabled: true,
  ...overrides,
});

const round = (overrides: Partial<RoundData> = {}): RoundData => ({
  roundId: 7n,
  state: "open",
  startTs: NOW - 120n,
  endTs: NOW,
  lockTs: 0n,
  lockSlot: 0n,
  settleTs: 0n,
  totalLamports: 500_000_000n,
  entryCount: 2,
  entriesClosed: 0,
  firstDepositor: "F".repeat(44),
  rentPayer: "11111111111111111111111111111111",
  singleDepositor: false,
  randomnessAccount: "11111111111111111111111111111111",
  randomnessCommitSlot: 0n,
  randomnessSeedSlot: 0n,
  winningTicket: 0n,
  winner: "11111111111111111111111111111111",
  winnerPayout: 0n,
  adminCut: 0n,
  megaCut: 0n,
  megaAwarded: 0n,
  refundPool: 0n,
  refundsPaid: 0n,
  megaFieldPool: 0n,
  megaFieldPaid: 0n,
  vaultOwed: 0n,
  megaTriggered: false,
  prizeClaimed: false,
  vaultBump: 253,
  bump: 255,
  ...overrides,
});

describe("manual crank availability (Phase 12.5)", () => {
  it("offers nothing for an Open round inside its window", () => {
    const d = manualCrankAvailability(round(), config(), NOW - 1n);
    expect(d.action).to.equal(null);
    expect(d.because).to.equal(null);
  });

  it("offers NOTHING for an Open EMPTY expired round — the first bet revives it in place", () => {
    const empty = round({ totalLamports: 0n, entryCount: 0 });
    const d = manualCrankAvailability(empty, config(), NOW + 3_600n);
    expect(d.action).to.equal(null);
  });

  it("offers lock_round for an Open non-empty round past end + grace — and not one second before", () => {
    const cfg = config();
    const due = round();
    // end + grace − 1: still the keeper's turn.
    expect(
      manualCrankAvailability(due, cfg, NOW + MANUAL_CRANK_GRACE_SECS - 1n).action,
    ).to.equal(null);
    // end + grace: the fallback arms.
    const d = manualCrankAvailability(due, cfg, NOW + MANUAL_CRANK_GRACE_SECS);
    expect(d.action).to.deep.equal({ kind: "lock_round", roundId: 7n });
    expect(d.because).to.include("keeper has not locked");
  });

  it("offers sweep_unclaimed_prize only past settle_ts + claim_deadline + grace with the prize unclaimed", () => {
    const cfg = config();
    const settled = round({
      state: "settled",
      settleTs: NOW,
      prizeClaimed: false,
      entryCount: 2,
      entriesClosed: 0,
    });
    const deadline = NOW + cfg.claimDeadlineSecs;
    expect(
      manualCrankAvailability(settled, cfg, deadline + MANUAL_CRANK_GRACE_SECS - 1n).action,
    ).to.equal(null);
    const d = manualCrankAvailability(settled, cfg, deadline + MANUAL_CRANK_GRACE_SECS);
    expect(d.action).to.deep.equal({ kind: "sweep_unclaimed_prize", roundId: 7n });
    // Once claimed, the sweep disappears.
    const claimed = round({ ...settled, prizeClaimed: true });
    expect(manualCrankAvailability(claimed, cfg, deadline + 999n).action).to.equal(null);
  });

  it("offers close_round only when a terminal round is fully pruned", () => {
    const cfg = config();
    const pruned = round({
      state: "settled",
      settleTs: NOW,
      prizeClaimed: true,
      entryCount: 2,
      entriesClosed: 2,
    });
    const d = manualCrankAvailability(pruned, cfg, NOW + 10n);
    expect(d.action).to.deep.equal({ kind: "close_round", roundId: 7n });

    const notPruned = round({ ...pruned, entriesClosed: 1 });
    expect(manualCrankAvailability(notPruned, cfg, NOW + 10n).action).to.equal(null);

    const cancelledPruned = round({
      state: "cancelled",
      entryCount: 3,
      entriesClosed: 3,
      totalLamports: 0n,
    });
    expect(manualCrankAvailability(cancelledPruned, cfg, NOW + 10n).action).to.deep.equal({
      kind: "close_round",
      roundId: 7n,
    });
    const cancelledOwing = round({ ...cancelledPruned, entriesClosed: 2 });
    expect(manualCrankAvailability(cancelledOwing, cfg, NOW + 10n).action).to.equal(null);
  });

  it("NEVER offers anything for locked or awaitingRandomness — the settle pipeline is keeper-only (R6)", () => {
    const cfg = config();
    expect(
      manualCrankAvailability(round({ state: "locked" }), cfg, NOW + 999n).action,
    ).to.equal(null);
    expect(
      manualCrankAvailability(round({ state: "awaitingRandomness" }), cfg, NOW + 9_999n).action,
    ).to.equal(null);
  });

  it("a skewed clock flips availability exactly as the chain would (the offset is folded into chainNow)", () => {
    const cfg = config();
    const due = round(); // end = NOW
    // The player's local clock is 60 s behind the chain: even though the
    // local NOW' is before end + grace, the CHAIN is past it — the chain
    // time (which carries the offset) must arm the button.
    const localBehind = NOW - 60n;
    const chainTime = localBehind + 60n + MANUAL_CRANK_GRACE_SECS;
    expect(manualCrankAvailability(due, cfg, chainTime).action).to.deep.equal({
      kind: "lock_round",
      roundId: 7n,
    });
    // And a local clock 60 s AHEAD never arms the button early, because
    // availability reads chain time, not local.
    const localAhead = NOW + 60n;
    const chainStillEarly = localAhead - 60n + MANUAL_CRANK_GRACE_SECS - 1n;
    expect(manualCrankAvailability(due, cfg, chainStillEarly).action).to.equal(null);
  });
});

describe("empty expired round — the auto-play escrow exception", () => {
  /**
   * The original rule ("empty rounds never offer anything — the first bet
   * revives the window in place") holds for a direct bettor and FAILS for
   * an auto-play escrow owner: `crank_auto_deposit` cannot roll the
   * window, so with no bettors the escrow starves forever. For that viewer
   * the roll is exactly the cheap, permissionless, pays-nothing action the
   * community crank exists for.
   */
  const emptyExpired = round({
    state: "open",
    totalLamports: 0n,
    endTs: NOW - MANUAL_CRANK_GRACE_SECS - 1n,
  });

  it("still offers nothing to a viewer with no escrow at stake", () => {
    expect(manualCrankAvailability(emptyExpired, config(), NOW).action).to.equal(null);
  });

  it("offers the window roll to a viewer whose escrow is starving", () => {
    const got = manualCrankAvailability(emptyExpired, config(), NOW, true);
    expect(got.action).to.deep.equal({ kind: "lock_round", roundId: emptyExpired.roundId });
    expect(got.because).to.contain("window");
  });

  it("respects the keeper grace period even for a starving escrow", () => {
    const fresh = round({ state: "open", totalLamports: 0n, endTs: NOW - 1n });
    expect(manualCrankAvailability(fresh, config(), NOW, true).action).to.equal(null);
  });

  it("never offers it while the round is still inside its window", () => {
    const live = round({ state: "open", totalLamports: 0n, endTs: NOW + 60n });
    expect(manualCrankAvailability(live, config(), NOW, true).action).to.equal(null);
  });
});
