/**
 * Auto-play planner — PURE. The `PlayerEscrow` counterpart of ORE Lite's
 * `planAutomation` (features/ore-lite/planner.ts), and it exists for the
 * same reason: ONE function decides every number and every reason the
 * action cannot proceed, so no component recomputes economics and no
 * button is ever disabled without saying why.
 *
 * Two plans, because the flow has two signatures:
 *
 *   `planAutoPlay`  — fund / re-declare terms (`init_or_deposit_escrow`)
 *   `planAutoEntry` — the owner's own entry for THIS round
 *                     (`crank_auto_deposit`, owner-exempt from the window)
 *
 * Every blocker mirrors a specific on-chain `require!`, cited at its site.
 * The costs mirror `auto_deposit_round_cost` plus the two charges the
 * original §4.7 quote omitted: `account_open_fee_lamports` (0.01 SOL to
 * the Mega-Pot, fresh escrow only) and the escrow rent Anchor debits the
 * owner at `init` — which the old quote instead folded into the transfer,
 * double-counting the floor as spendable.
 */

/**
 * Rent for a `PlayerEntry` (8 + 101 = 109 bytes) — paid by the crank,
 * reimbursed by the escrow in the same instruction, and returned to the
 * escrow when the round's entries close. `(109 + 128) × 5 080` at the
 * live cluster rate.
 */
export const ENTRY_RENT_LAMPORTS = 1_203_960n;

/**
 * Rent-exempt minimum for the escrow itself (8 + 114 = 122 bytes).
 * Permanently locked while the escrow exists — there is no
 * `close_escrow` in this release, and `withdraw_escrow` drains to this
 * floor.
 */
export const ESCROW_RENT_LAMPORTS = 1_270_000n;

/**
 * What a plain wallet must RETAIN after any transaction that debits it.
 * The runtime enforces it as `InsufficientFundsForRent` on the wallet
 * account, so a plan that ignores it fails at send with an opaque error —
 * the same trap ORE Lite hit live on 2026-10-07 (see
 * `features/ore-lite/planner.ts` WALLET_RENT_FLOOR_LAMPORTS).
 */
export const WALLET_RENT_FLOOR_LAMPORTS = 650_240n;

/** Base signature fee; the real figure is set by the adapter at send. */
export const DEFAULT_NETWORK_FEE_LAMPORTS = 5_000n;

/** UI cap on the committed round count (`max_rounds` is a u32 on-chain). */
export const MAX_AUTO_PLAY_ROUNDS = 500;

// ── fund / re-declare terms ────────────────────────────────────────────

export type AutoPlayBlocker =
  | "wallet-disconnected"
  | "amount-invalid"
  | "paused"
  | "auto-deposit-disabled"
  | "rounds-out-of-range"
  | "below-min-deposit"
  | "insufficient-balance";

export interface AutoPlayPlan {
  rounds: number;
  perRound: bigint;
  /** Per auto-deposited round: stake + entry rent + tip. */
  roundCost: bigint;
  /** Stake component across all rounds. */
  stake: bigint;
  /** Entry-rent component — funded up front, returned at `close_entry`. */
  entryRent: bigint;
  /** Keeper-tip component — never returned. */
  tips: bigint;
  /** What this transaction transfers INTO the escrow. */
  deposit: bigint;
  /** One-time `account_open_fee_lamports` → the Mega-Pot (fresh only). */
  accountOpenFee: bigint;
  /** Escrow rent Anchor debits the owner at `init` (fresh only). */
  escrowRent: bigint;
  /** Everything that leaves the wallet now. */
  walletDebit: bigint;
  /** Post-transaction rent floor the wallet must keep on top of the debit. */
  walletRentFloor: bigint;
  networkFee: bigint;
  /** `walletDebit + walletRentFloor + networkFee`. */
  requiredBalance: bigint;
  /** Entry rent that flows back into the escrow as rounds close. */
  returnedToEscrow: bigint;
  blocker: AutoPlayBlocker | null;
}

export interface PlanAutoPlayInput {
  /** `null` when the typed amount does not parse. */
  perRoundLamports: bigint | null;
  rounds: number;
  /** `config.auto_deposit_tip_lamports`. */
  tipLamports: bigint;
  /** `config.min_deposit_lamports`. */
  minDepositLamports: bigint;
  /** `config.account_open_fee_lamports`. */
  accountOpenFeeLamports: bigint;
  /** `config.auto_deposit_enabled` — funding is pointless without it. */
  autoDepositEnabled: boolean;
  paused: boolean;
  /** Whether the escrow PDA already exists (no open fee, no rent). */
  escrowExists: boolean;
  /** `max(0, escrowLamports − rent floor)` — offsets the needed top-up. */
  currentSpendableLamports: bigint;
  /** `null` while the balance is unknown — never a blocker on its own. */
  walletBalanceLamports: bigint | null;
  canSign: boolean;
  networkFeeLamports?: bigint;
}

/** The §4.7 per-round components, kept for the disclosure lines. */
export interface AutoPlayQuote {
  roundCost: bigint;
  stake: bigint;
  entryRent: bigint;
  tips: bigint;
  /** The one-time escrow rent floor. */
  floor: bigint;
  /** The original §4.7 headline — superseded by `AutoPlayPlan.walletDebit`. */
  total: bigint;
}

/** The §4.7 worked example, generalized — pure, integer, test-pinned. */
export function computeAutoPlayQuote(
  perRoundLamports: bigint,
  rounds: number,
  tipLamports: bigint,
): AutoPlayQuote {
  const n = BigInt(Math.max(0, rounds));
  const roundCost = perRoundLamports + ENTRY_RENT_LAMPORTS + tipLamports;
  const stake = perRoundLamports * n;
  const entryRent = ENTRY_RENT_LAMPORTS * n;
  const tips = tipLamports * n;
  return {
    roundCost,
    stake,
    entryRent,
    tips,
    floor: ESCROW_RENT_LAMPORTS,
    total: stake + entryRent + tips + ESCROW_RENT_LAMPORTS,
  };
}

export function planAutoPlay(input: PlanAutoPlayInput): AutoPlayPlan {
  const perRound = input.perRoundLamports ?? 0n;
  const roundsValid =
    Number.isInteger(input.rounds) && input.rounds >= 1 && input.rounds <= MAX_AUTO_PLAY_ROUNDS;
  const n = BigInt(roundsValid ? input.rounds : 0);

  const roundCost = perRound + ENTRY_RENT_LAMPORTS + input.tipLamports;
  const stake = perRound * n;
  const entryRent = ENTRY_RENT_LAMPORTS * n;
  const tips = input.tipLamports * n;
  // What the escrow must hold as SPENDABLE to run the whole commitment.
  const needed = stake + entryRent + tips;
  // A re-fund tops up only the shortfall: `rounds_remaining` is re-declared
  // as `max_rounds` on every call (init_or_deposit_escrow.rs:159), so terms
  // promising N rounds against a balance covering two is the silent-stall
  // bug. Never negative — an over-funded escrow is a terms-only update.
  const deposit =
    needed > input.currentSpendableLamports ? needed - input.currentSpendableLamports : 0n;

  const accountOpenFee = input.escrowExists ? 0n : input.accountOpenFeeLamports;
  const escrowRent = input.escrowExists ? 0n : ESCROW_RENT_LAMPORTS;
  const walletDebit = deposit + accountOpenFee + escrowRent;
  const networkFee = input.networkFeeLamports ?? DEFAULT_NETWORK_FEE_LAMPORTS;
  const requiredBalance = walletDebit + WALLET_RENT_FLOOR_LAMPORTS + networkFee;

  // Order matters: the conditions that make the whole feature pointless
  // come before the ones the user can fix by typing.
  let blocker: AutoPlayBlocker | null = null;
  if (!input.canSign) blocker = "wallet-disconnected";
  else if (input.perRoundLamports === null) blocker = "amount-invalid";
  // init_or_deposit_escrow.rs:112 — a money-in path, gated like `deposit`.
  else if (input.paused) blocker = "paused";
  // crank_auto_deposit.rs:100 would revert forever: funding would succeed
  // and nothing could ever enter a round. The live 2026-10-07 trap.
  else if (!input.autoDepositEnabled) blocker = "auto-deposit-disabled";
  // init_or_deposit_escrow.rs:113 — `max_rounds > 0`.
  else if (!roundsValid) blocker = "rounds-out-of-range";
  // init_or_deposit_escrow.rs:114 — and crank_auto_deposit.rs:139 re-checks
  // it every round, so terms under the floor stall silently afterwards.
  else if (perRound < input.minDepositLamports) blocker = "below-min-deposit";
  else if (
    input.walletBalanceLamports !== null &&
    input.walletBalanceLamports < requiredBalance
  ) {
    blocker = "insufficient-balance";
  }

  return {
    rounds: roundsValid ? input.rounds : 0,
    perRound,
    roundCost,
    stake,
    entryRent,
    tips,
    deposit,
    accountOpenFee,
    escrowRent,
    walletDebit,
    walletRentFloor: WALLET_RENT_FLOOR_LAMPORTS,
    networkFee,
    requiredBalance,
    returnedToEscrow: entryRent,
    blocker,
  };
}

// ── the owner's own entry for this round ───────────────────────────────

export type AutoEntryBlocker =
  | "wallet-disconnected"
  | "paused"
  | "auto-deposit-disabled"
  | "no-escrow"
  | "round-not-open"
  | "deposit-window-closed"
  | "round-window-expired"
  | "already-entered-this-round"
  | "escrow-depleted"
  | "below-min-deposit"
  | "round-full"
  | "escrow-insufficient-balance";

/** Only the fields the gate chain reads — keeps the planner decoupled. */
export interface AutoEntryEscrowView {
  perRoundLamports: bigint;
  roundsRemaining: number;
  nextEligibleRoundId: bigint;
}

export interface AutoEntryRoundView {
  roundId: bigint;
  state: string;
  startTs: bigint;
  endTs: bigint;
  entryCount: number;
  /** `0` ⇒ the window may be rolled in place (Round::may_roll_window). */
  totalLamports: bigint;
}

export interface AutoEntryPlan {
  /** `per_round + entry_rent + tip` — `auto_deposit_round_cost`. */
  roundCost: bigint;
  /** `max(0, escrowLamports − rent floor)` — the ONLY way escrow reads. */
  spendable: bigint;
  /**
   * True when `now > start_ts + auto_deposit_window_secs`: no third-party
   * keeper may still act, so this round can only be entered by the owner
   * signing for themselves (crank_auto_deposit.rs:121).
   */
  pastKeeperWindow: boolean;
  /**
   * The round is Open, EMPTY and past `end_ts`, so its window can be
   * rolled in place by anyone (`Round::may_roll_window`, exercised by
   * `deposit.rs:117-129` and `lock_round.rs:61`). This is the state that
   * starves an auto-play escrow: `crank_auto_deposit` deliberately never
   * writes `end_ts` (crank_auto_deposit.rs:18), so the escrow cannot
   * revive the window itself and needs a bet or a roll first.
   */
  windowRollable: boolean;
  blocker: AutoEntryBlocker | null;
}

export interface PlanAutoEntryInput {
  canSign: boolean;
  paused: boolean;
  autoDepositEnabled: boolean;
  tipLamports: bigint;
  minDepositLamports: bigint;
  autoDepositWindowSecs: bigint;
  /** `0` disables the cap (crank_auto_deposit.rs:144). */
  maxEntriesPerRound: number;
  escrow: AutoEntryEscrowView | null;
  escrowLamports: bigint;
  round: AutoEntryRoundView | null;
  nowSecs: bigint;
}

/**
 * The owner-signed escape hatch, planned. The owner is exempt from the
 * anti-selection window (crank_auto_deposit.rs:121) — "an owner timing
 * their own spend is not griefing" — so this path stays available for the
 * whole round even when no keeper is cranking, which is what keeps the
 * feature usable without trusting anyone's uptime.
 */
export function planAutoEntry(input: PlanAutoEntryInput): AutoEntryPlan {
  const escrow = input.escrow;
  const round = input.round;
  const perRound = escrow?.perRoundLamports ?? 0n;
  const roundCost = perRound + ENTRY_RENT_LAMPORTS + input.tipLamports;
  const spendable =
    input.escrowLamports > ESCROW_RENT_LAMPORTS
      ? input.escrowLamports - ESCROW_RENT_LAMPORTS
      : 0n;
  const pastKeeperWindow =
    round !== null && input.nowSecs > round.startTs + input.autoDepositWindowSecs;
  const windowRollable =
    round !== null &&
    round.state === "open" &&
    round.totalLamports === 0n &&
    input.nowSecs >= round.endTs;

  let blocker: AutoEntryBlocker | null = null;
  if (!input.canSign) blocker = "wallet-disconnected";
  else if (input.paused) blocker = "paused"; // :99
  else if (!input.autoDepositEnabled) blocker = "auto-deposit-disabled"; // :100
  else if (escrow === null) blocker = "no-escrow";
  else if (round === null || round.state !== "open") blocker = "round-not-open"; // :103
  // :106 — the TIME gate closes the window, not the state gate. An empty
  // expired round is a DIFFERENT condition with a different remedy: the
  // window is dead but rollable, and until someone rolls it this escrow
  // can never play again. Naming it separately is the whole point.
  else if (input.nowSecs >= round.endTs) {
    blocker = windowRollable ? "round-window-expired" : "deposit-window-closed";
  }
  // :129 — round ids are monotonic, so this is both the same-round and the
  // replay-into-older-rounds guard (I17).
  else if (round.roundId < escrow.nextEligibleRoundId) blocker = "already-entered-this-round";
  else if (escrow.roundsRemaining <= 0) blocker = "escrow-depleted"; // :132
  else if (perRound < input.minDepositLamports) blocker = "below-min-deposit"; // :139
  else if (input.maxEntriesPerRound > 0 && round.entryCount >= input.maxEntriesPerRound) {
    blocker = "round-full"; // :146
  } else if (spendable < roundCost) blocker = "escrow-insufficient-balance"; // :162

  return { roundCost, spendable, pastKeeperWindow, windowRollable, blocker };
}

/**
 * Rounds the escrow will ACTUALLY play from here, as opposed to the
 * `rounds_remaining` counter it carries.
 *
 * The chain writes `rounds_remaining` at the end of each auto-deposit from
 * the balance it saw at that moment (crank_auto_deposit.rs:245-250), and
 * under `auto_reinvest` it is a forecast that assumes the round's entry
 * rent and refund will come back. When they have not come back yet — or
 * the escrow simply ran dry — the counter keeps claiming rounds the
 * balance can no longer buy. The live card read "7 ROUNDS LEFT" over a
 * spendable balance of ZERO (2026-10-07).
 *
 * `crank_auto_deposit.rs:162` is the gate that actually decides: the
 * escrow plays only while `spendable >= round_cost`. So the truthful
 * figure is the smaller of the two.
 */
export function effectiveRoundsLeft(
  roundsRemaining: number,
  spendableLamports: bigint,
  roundCostLamports: bigint,
): number {
  if (roundsRemaining <= 0 || roundCostLamports <= 0n) return 0;
  const affordable = spendableLamports / roundCostLamports;
  return affordable < BigInt(roundsRemaining) ? Number(affordable) : roundsRemaining;
}
