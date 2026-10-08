/**
 * Auto-play planner gates — the ORE-auto-join pattern applied to the
 * `PlayerEscrow` flow: ONE pure function owns every reason the action
 * cannot proceed, so the UI can never disable a button silently.
 *
 * Each blocker below mirrors a specific on-chain `require!`:
 *   - `init_or_deposit_escrow.rs:112-117`  paused / max_rounds / min deposit
 *   - `crank_auto_deposit.rs:99-149`       the auto-entry gate chain
 * and the cost lines mirror `auto_deposit_round_cost` plus the two charges
 * the old quote omitted entirely — `account_open_fee_lamports` and the
 * escrow rent Anchor debits the owner at `init`.
 */

import { describe, expect, it } from "vitest";
import {
  ENTRY_RENT_LAMPORTS,
  ESCROW_RENT_LAMPORTS,
  MAX_AUTO_PLAY_ROUNDS,
  WALLET_RENT_FLOOR_LAMPORTS,
  computeAutoPlayQuote,
  effectiveRoundsLeft,
  planAutoEntry,
  planAutoPlay,
  type AutoEntryRoundView,
  type PlanAutoEntryInput,
  type PlanAutoPlayInput,
} from "../src/lib/autoPlay";

/** The live devnet config at the time of writing (probe 2026-10-07). */
const CONFIG = {
  tipLamports: 200_000n,
  minDepositLamports: 10_000_000n,
  accountOpenFeeLamports: 10_000_000n,
  autoDepositEnabled: true,
  autoDepositWindowSecs: 20n,
  maxEntriesPerRound: 100,
  paused: false,
};

function fundInput(over: Partial<PlanAutoPlayInput> = {}): PlanAutoPlayInput {
  return {
    ...CONFIG,
    perRoundLamports: 100_000_000n,
    rounds: 10,
    canSign: true,
    escrowExists: false,
    currentSpendableLamports: 0n,
    walletBalanceLamports: 2_000_000_000n,
    ...over,
  };
}

describe("planAutoPlay — cost lines the old quote got wrong", () => {
  it("funds the escrow with stake + entry rent + tips, and never the rent floor twice", () => {
    const plan = planAutoPlay(fundInput());
    expect(plan.roundCost).to.equal(101_403_960n);
    expect(plan.stake).to.equal(1_000_000_000n);
    expect(plan.entryRent).to.equal(12_039_600n);
    expect(plan.tips).to.equal(2_000_000n);
    // The deposit is what the instruction transfers IN. Anchor's `init`
    // funds the rent floor separately from the same wallet, so including
    // it here (as the old quote did) double-charged it as spendable.
    expect(plan.deposit).to.equal(1_014_039_600n);
  });

  it("charges the one-time account-open fee and escrow rent on a FRESH escrow", () => {
    const plan = planAutoPlay(fundInput());
    expect(plan.accountOpenFee).to.equal(10_000_000n);
    expect(plan.escrowRent).to.equal(ESCROW_RENT_LAMPORTS);
    expect(plan.walletDebit).to.equal(1_014_039_600n + 10_000_000n + 1_270_000n);
    // The §4.7 quote claimed 1.015309600 SOL for exactly this input; the
    // wallet is really debited 1.025309600 and must HOLD more still.
    expect(plan.walletDebit - computeAutoPlayQuote(100_000_000n, 10, 200_000n).total).to.equal(
      10_000_000n,
    );
  });

  it("charges neither on an existing escrow, and tops up only the shortfall", () => {
    const plan = planAutoPlay(
      fundInput({ escrowExists: true, currentSpendableLamports: 500_000_000n }),
    );
    expect(plan.accountOpenFee).to.equal(0n);
    expect(plan.escrowRent).to.equal(0n);
    expect(plan.deposit).to.equal(1_014_039_600n - 500_000_000n);
    expect(plan.walletDebit).to.equal(plan.deposit);
  });

  it("an already-sufficient escrow is a terms-only update: zero deposit, never negative", () => {
    const plan = planAutoPlay(
      fundInput({ escrowExists: true, currentSpendableLamports: 9_000_000_000n }),
    );
    expect(plan.deposit).to.equal(0n);
    expect(plan.walletDebit).to.equal(0n);
    expect(plan.blocker).to.equal(null);
  });

  it("requires the wallet to retain Solana's post-transaction rent floor", () => {
    const plan = planAutoPlay(fundInput());
    expect(plan.walletRentFloor).to.equal(WALLET_RENT_FLOOR_LAMPORTS);
    expect(plan.requiredBalance).to.equal(
      plan.walletDebit + WALLET_RENT_FLOOR_LAMPORTS + plan.networkFee,
    );
  });

  it("reports the entry rent that comes back as each round's entries close", () => {
    expect(planAutoPlay(fundInput()).returnedToEscrow).to.equal(12_039_600n);
  });
});

describe("planAutoPlay — one blocker per on-chain require", () => {
  it("clears when everything is satisfied", () => {
    expect(planAutoPlay(fundInput()).blocker).to.equal(null);
  });

  it("blocks without a signing wallet", () => {
    expect(planAutoPlay(fundInput({ canSign: false })).blocker).to.equal("wallet-disconnected");
  });

  it("blocks an unparseable amount", () => {
    expect(planAutoPlay(fundInput({ perRoundLamports: null })).blocker).to.equal("amount-invalid");
  });

  it("blocks while the program is paused (init_or_deposit_escrow.rs:112)", () => {
    expect(planAutoPlay(fundInput({ paused: true })).blocker).to.equal("paused");
  });

  it("blocks when auto-deposit is disabled on-chain — the live 2026-10-07 trap", () => {
    // The whole incident: funding succeeded, `crank_auto_deposit` reverted
    // with AutoDepositDisabled forever, and the UI promised N rounds.
    expect(planAutoPlay(fundInput({ autoDepositEnabled: false })).blocker).to.equal(
      "auto-deposit-disabled",
    );
  });

  it("blocks a per-round stake under config.min_deposit_lamports (:114)", () => {
    expect(planAutoPlay(fundInput({ perRoundLamports: 9_999_999n })).blocker).to.equal(
      "below-min-deposit",
    );
    expect(planAutoPlay(fundInput({ perRoundLamports: 10_000_000n })).blocker).to.equal(null);
  });

  it("blocks a round count outside 1..MAX (:113 requires max_rounds > 0)", () => {
    expect(planAutoPlay(fundInput({ rounds: 0 })).blocker).to.equal("rounds-out-of-range");
    expect(planAutoPlay(fundInput({ rounds: 1.5 })).blocker).to.equal("rounds-out-of-range");
    expect(planAutoPlay(fundInput({ rounds: MAX_AUTO_PLAY_ROUNDS + 1 })).blocker).to.equal(
      "rounds-out-of-range",
    );
  });

  it("blocks when the wallet cannot cover debit + rent floor + network fee", () => {
    const plan = planAutoPlay(fundInput({ walletBalanceLamports: 1_025_309_600n }));
    expect(plan.blocker).to.equal("insufficient-balance");
    // Funded to exactly the debit and no further — the precise shape that
    // fails simulation with InsufficientFundsForRent when it is not caught.
    expect(plan.requiredBalance - 1_025_309_600n).to.equal(
      WALLET_RENT_FLOOR_LAMPORTS + plan.networkFee,
    );
  });

  it("never claims insufficient balance while the balance is still unknown", () => {
    expect(planAutoPlay(fundInput({ walletBalanceLamports: null })).blocker).to.equal(null);
  });
});

/** Round 251 as probed live: open, 120 s long, empty. */
const BASE_ROUND: AutoEntryRoundView = {
  roundId: 251n,
  state: "open",
  startTs: 1_791_377_222n,
  endTs: 1_791_377_342n,
  entryCount: 3,
  totalLamports: 1_110_000_000n,
};

function entryInput(over: Partial<PlanAutoEntryInput> = {}): PlanAutoEntryInput {
  return {
    ...CONFIG,
    canSign: true,
    escrow: {
      perRoundLamports: 100_000_000n,
      roundsRemaining: 10,
      nextEligibleRoundId: 251n,
    },
    escrowLamports: 1_270_000n + 1_014_039_600n,
    round: BASE_ROUND,
    nowSecs: 1_791_377_300n,
    ...over,
  };
}

describe("planAutoEntry — the owner escape hatch (crank_auto_deposit.rs:99-167)", () => {
  it("clears for the owner even PAST the keeper window (:121 exemption)", () => {
    const plan = planAutoEntry(entryInput());
    // 1791377300 is 78 s in — far outside the 20 s keeper window, and
    // legal only because the owner signs.
    expect(plan.pastKeeperWindow).to.equal(true);
    expect(plan.blocker).to.equal(null);
    expect(plan.roundCost).to.equal(101_403_960n);
  });

  it("blocks when auto-deposit is disabled (:100) — symptom 1 of the incident", () => {
    expect(planAutoEntry(entryInput({ autoDepositEnabled: false })).blocker).to.equal(
      "auto-deposit-disabled",
    );
  });

  it("blocks while paused (:99)", () => {
    expect(planAutoEntry(entryInput({ paused: true })).blocker).to.equal("paused");
  });

  it("blocks with no escrow at all", () => {
    expect(planAutoEntry(entryInput({ escrow: null })).blocker).to.equal("no-escrow");
  });

  it("blocks a non-open round (:103)", () => {
    const round = { ...BASE_ROUND, state: "settled" };
    expect(planAutoEntry(entryInput({ round })).blocker).to.equal("round-not-open");
  });

  it("blocks once the deposit window has closed on time (:106)", () => {
    expect(planAutoEntry(entryInput({ nowSecs: 1_791_377_342n })).blocker).to.equal(
      "deposit-window-closed",
    );
  });

  it("blocks a second entry into the same round (:129 I17 guard)", () => {
    const escrow = { ...entryInput().escrow!, nextEligibleRoundId: 252n };
    expect(planAutoEntry(entryInput({ escrow })).blocker).to.equal("already-entered-this-round");
  });

  it("blocks a depleted budget (:132)", () => {
    const escrow = { ...entryInput().escrow!, roundsRemaining: 0 };
    expect(planAutoEntry(entryInput({ escrow })).blocker).to.equal("escrow-depleted");
  });

  it("blocks terms that fell under a raised floor (:139)", () => {
    const escrow = { ...entryInput().escrow!, perRoundLamports: 1_000_000n };
    expect(planAutoEntry(entryInput({ escrow })).blocker).to.equal("below-min-deposit");
  });

  it("blocks a full round (:146)", () => {
    const round = { ...BASE_ROUND, entryCount: 100 };
    expect(planAutoEntry(entryInput({ round })).blocker).to.equal("round-full");
  });

  it("blocks when spendable cannot cover one round (:162)", () => {
    // One lamport short of the round cost, above the rent floor.
    const plan = planAutoEntry(
      entryInput({ escrowLamports: 1_270_000n + 101_403_959n }),
    );
    expect(plan.spendable).to.equal(101_403_959n);
    expect(plan.blocker).to.equal("escrow-insufficient-balance");
  });

  it("reads spendable as lamports minus the rent floor, never raw lamports", () => {
    expect(planAutoEntry(entryInput({ escrowLamports: 1_000n })).spendable).to.equal(0n);
  });

  it("blocks without a signing wallet", () => {
    expect(planAutoEntry(entryInput({ canSign: false })).blocker).to.equal("wallet-disconnected");
  });
});

describe("computeAutoPlayQuote — kept for the §4.7 disclosure lines", () => {
  it("still reports the per-round components it always did", () => {
    const quote = computeAutoPlayQuote(100_000_000n, 10, 200_000n);
    expect(quote.roundCost).to.equal(101_403_960n);
    expect(quote.entryRent).to.equal(10n * ENTRY_RENT_LAMPORTS);
  });
});

describe("planAutoEntry — the dead empty window (live 2026-10-07 freeze)", () => {
  /**
   * Phase 12 leaves an expired EMPTY round Open on purpose: `deposit`
   * revives the window in the first bettor's own transaction
   * (deposit.rs:117-129). But `crank_auto_deposit` deliberately never
   * writes `end_ts` (crank_auto_deposit.rs:18), so an auto-play escrow
   * cannot revive it — and with `CRANK_IDLE_ROLL_SECS` off by default and
   * the manual-crank button suppressed for empty rounds, nothing did. The
   * escrow starved: funded=0 across four rounds until a window roll.
   *
   * That state must read as its own blocker, because the remedy is
   * completely different from "this round stopped taking entries".
   */
  const expired = { ...BASE_ROUND, totalLamports: 0n };

  it("names the rollable dead window instead of the generic closed window", () => {
    const plan = planAutoEntry(
      entryInput({ round: expired, nowSecs: BASE_ROUND.endTs + 1_000n }),
    );
    expect(plan.blocker).to.equal("round-window-expired");
    expect(plan.windowRollable).to.equal(true);
  });

  it("a round with money in it is genuinely closed — never rollable", () => {
    const plan = planAutoEntry(
      entryInput({
        round: { ...BASE_ROUND, totalLamports: 500_000_000n },
        nowSecs: BASE_ROUND.endTs + 1_000n,
      }),
    );
    expect(plan.blocker).to.equal("deposit-window-closed");
    expect(plan.windowRollable).to.equal(false);
  });

  it("an empty round still inside its window is simply playable", () => {
    const plan = planAutoEntry(entryInput({ round: expired }));
    expect(plan.blocker).to.equal(null);
    expect(plan.windowRollable).to.equal(false);
  });
});

describe("effectiveRoundsLeft — the counter the chain will honour", () => {
  it("is zero when the escrow is drained, whatever the counter says", () => {
    // The live card: rounds_remaining=7, spendable=0, round cost 0.0114.
    expect(effectiveRoundsLeft(7, 0n, 11_403_960n)).to.equal(0);
  });

  it("is capped by the balance when the counter is optimistic", () => {
    expect(effectiveRoundsLeft(7, 3n * 11_403_960n, 11_403_960n)).to.equal(3);
  });

  it("is capped by the counter when the balance is generous", () => {
    expect(effectiveRoundsLeft(2, 99n * 11_403_960n, 11_403_960n)).to.equal(2);
  });

  it("is zero for a depleted budget or a zero round cost", () => {
    expect(effectiveRoundsLeft(0, 10_000_000_000n, 11_403_960n)).to.equal(0);
    expect(effectiveRoundsLeft(5, 10_000_000_000n, 0n)).to.equal(0);
  });
});
