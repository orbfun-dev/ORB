/**
 * Deploy planner — PURE. `planDeploy()` is the ONE function that decides
 * everything: eligible squares (R3), per-square split (R2), fee, rent,
 * required balance and the blocker. No component recomputes any of it.
 */

import type { OreAutomation, OreBoard, OreMiner } from "./codec";
import { U64_MAX } from "./codec";
import { type PlatformFee, platformFeeLamports } from "./fee";

export type DeployBlocker =
  | "no-eligible-squares"
  | "round-not-open"
  | "intermission"
  | "insufficient-balance"
  | "amount-too-small"
  | "automation-active"
  | "fee-recipient-uninitialized";

export interface DeployPlan {
  /** Post-R3-filter squares that will actually receive the deploy. */
  eligibleSquares: number[];
  /** u32, bits 0..24 — the Deploy instruction argument. */
  mask: number;
  /** The Deploy `amount` argument (per square). */
  amountPerSquare: bigint;
  /** `amountPerSquare × eligibleSquares.length` — what leaves the wallet (R2). */
  totalDeploy: bigint;
  /** Requested − actually deployed; stays in the wallet, never charged. */
  remainder: bigint;
  platformFee: bigint;
  /** 10_000 lamports on the first deploy of a miner account. */
  checkpointFee: bigint;
  /** Miner rent (752 bytes) on the very first deploy ever. */
  minerRent: bigint;
  /** Caller-supplied estimate: base fee + priority fee at send time. */
  networkFee: bigint;
  /** The sum — the MAX button inverts this. */
  requiredBalance: bigint;
  blocker: DeployBlocker | null;
}

export interface PlanDeployInput {
  board: OreBoard;
  /** `null` when the miner account does not exist yet (first deploy ever). */
  miner: OreMiner | null;
  /**
   * An existing automation for the connected wallet — ANY executor value
   * (§2). Custom executors fail deploy.rs's executor assert at simulation;
   * permissionless ones go down the automation path: the on-chain amount
   * and mask overwrite the request, SOL leaves automation.balance instead
   * of the wallet, and the platform fee still lands at the planned size.
   * The planner must not branch on the executor — both are blocked.
   */
  automation?: OreAutomation | null;
  currentSlot: bigint;
  /**
   * Lite deploys the WHOLE board, so this defaults to all 25. It stays a
   * parameter because the planner is pure and the tests (and a future Pro
   * mode) need to pin a narrower set.
   */
  selectedSquares?: number[];
  /** Total lamports the user asked to deploy across the eligible set. */
  requestedTotalLamports: bigint;
  walletBalanceLamports: bigint;
  fee: PlatformFee;
  networkFeeLamports: bigint;
  /**
   * Whether PLATFORM_FEE_RECIPIENT exists on-chain. `undefined` skips the
   * check (tests pin pure math; the snapshot supplies the real value).
   * See the `fee-recipient-uninitialized` blocker below.
   */
  feeRecipientExists?: boolean;
}

/** Protocol constants (§3.5) — kept here so the planner stays pure/testable. */
export const CHECKPOINT_FEE_LAMPORTS = 10_000n;
/** Rent-exempt minimum for a 752-byte miner account at the CURRENT live
 *  rate — verified 2026-10-07 against three live mainnet miner accounts,
 *  each holding exactly 4 480 400 lamports (4 470 400 rent + the 10 000
 *  checkpoint fee held inside the account). The directive's 6 124 800 was
 *  the pre-reduction rate and would overcharge first deploys by 1.65M
 *  lamports; the chain wins (directive §8). */
export const MINER_RENT_LAMPORTS = 4_470_400n;
/** Rent-exempt minimum for a 160-byte Automation account at the CURRENT
 *  live rate (5 080 lamports per byte incl. the 128-byte overhead — same
 *  rate that yields MINER_RENT_LAMPORTS). Verified 2026-10-07 against the
 *  live automation EKB2KUcKcZVeqKfWobjDTvP1YaC4zFypNzCGgzG8MjbZ: lamports
 *  1 997 469 600 − balance field 1 996 006 560 = exactly 1 463 040. The
 *  auto-join directive's 2 004 480 was the pre-reduction (6 960/byte)
 *  figure; the chain wins. Refunded in full on stop (automate.rs:87-96). */
export const AUTOMATION_RENT_LAMPORTS = 1_463_040n;
/**
 * Rent-exempt minimum a plain wallet (0 data bytes) must RETAIN after any
 * transaction that debits it — the runtime enforces this as
 * `InsufficientFundsForRent` on the wallet account, and a plan that
 * ignores it fails at simulation with exactly that opaque error (live
 * 2026-10-07: a 0.010 SOL deploy from a wallet funded to precisely
 * "Required balance" failed on account_index 1). Derived at the same
 * live-verified rate as the other rent constants: (0 + 128) × 5 080.
 */
export const SYSTEM_ACCOUNT_RENT_LAMPORTS = 650_240n;
/** The same figure read from the debited wallet's side. */
export const WALLET_RENT_FLOOR_LAMPORTS = SYSTEM_ACCOUNT_RENT_LAMPORTS;
/** Left in the wallet after MAX so the user can always pay to claim. */
export const SAFETY_BUFFER_LAMPORTS = 2_000_000n;

const ALL_SQUARES = 25;

/** All 25 squares: (1 << 25) − 1. */
export const ALL_SQUARES_MASK = 0x01ff_ffff;
export const ALL_SQUARE_IDS: readonly number[] = Array.from({ length: ALL_SQUARES }, (_, i) => i);
/** Below this the per-square amount is dust on a 25-square board. */
export const MIN_DEPLOY_TOTAL_LAMPORTS = 1_000_000n; // 0.001 SOL

function validateSquares(selected: number[]): number[] {
  const unique = [...new Set(selected)];
  for (const sq of unique) {
    if (!Number.isInteger(sq) || sq < 0 || sq >= ALL_SQUARES) {
      throw new RangeError(`square id ${sq} out of range 0..24`);
    }
  }
  return unique;
}

export function planDeploy(input: PlanDeployInput): DeployPlan {
  const { board, miner, currentSlot, walletBalanceLamports, fee } = input;

  // §2 first, before any round arithmetic: a live automation invalidates
  // the manual path entirely (see PlanDeployInput.automation). This is the
  // one blocker where the UI must explain instead of disabling quietly.
  let blocker: DeployBlocker | null = input.automation != null ? "automation-active" : null;

  // Round gating (R5/R6/R7) — WAITING_FIRST_DEPLOY is not a blocker: the
  // first deployer starts the clock, the button renders "Start round".
  let roundBlocker: DeployBlocker | null = null;
  if (board.endSlot !== U64_MAX) {
    if (currentSlot < board.startSlot) roundBlocker = "round-not-open";
    else if (currentSlot >= board.endSlot) roundBlocker = "intermission";
  }

  // R3: filter out squares this miner already occupies — but ONLY when the
  // miner is parked on the current round. deploy.rs zeroes `miner.deployed`
  // on the round-mismatch path ("Reset miner"), so a stale miner's rows
  // describe round N−1 and must never lock squares in round N.
  const selected = validateSquares([...(input.selectedSquares ?? ALL_SQUARE_IDS)]);
  const deployedThisRound =
    miner !== null && miner.roundId === board.roundId ? miner.deployed : null;
  const eligible = selected.filter(
    (sq) => deployedThisRound === null || deployedThisRound[sq] === 0n,
  );
  blocker = blocker ?? roundBlocker ?? (eligible.length === 0 ? "no-eligible-squares" : null);

  const mask = eligible.reduce((acc, sq) => acc | (1 << sq), 0);
  const count = BigInt(eligible.length);
  const amountPerSquare = count > 0n ? input.requestedTotalLamports / count : 0n;
  const totalDeploy = amountPerSquare * count;
  const remainder = input.requestedTotalLamports - totalDeploy;

  if (blocker === null && count > 0n && amountPerSquare === 0n) blocker = "amount-too-small";
  // Product floor: below 0.001 SOL the per-square amount is dust.
  if (
    blocker === null &&
    input.requestedTotalLamports > 0n &&
    input.requestedTotalLamports < MIN_DEPLOY_TOTAL_LAMPORTS
  ) {
    blocker = "amount-too-small";
  }

  // A refused deploy is never built, so nothing can be charged for it —
  // the fee is zeroed for the same reason no-eligible-squares zeroes it.
  // automation-active zeroes it as defense in depth: the plan is blocked
  // client-side, and a zero fee means nothing could ever be billed even if
  // a future bug let the transaction through.
  const platformFee =
    blocker === "no-eligible-squares" ||
    blocker === "amount-too-small" ||
    blocker === "automation-active"
      ? 0n
      : platformFeeLamports(fee, totalDeploy);
  // deploy.rs tops up the checkpoint fee whenever `checkpoint_fee == 0` —
  // including a freshly created (zeroed) miner account, so the very first
  // deploy ever pays it too, not just existing miners.
  // A transfer to a system account that does not exist CREATES it, and
  // creation demands the transferred lamports cover rent-exemption. Our
  // floor-sized fee (100 000) is below it, so until the treasury is funded
  // once, every small deploy dies at simulation with
  // {"InsufficientFundsForRent":{"account_index":1}} — index 1 of the
  // TRANSFER, i.e. the recipient (live 2026-10-07). Fees at or above the
  // minimum create the account and are fine, which is exactly why the
  // failure looked size-dependent and erratic.
  if (
    blocker === null &&
    input.feeRecipientExists === false &&
    platformFee > 0n &&
    platformFee < SYSTEM_ACCOUNT_RENT_LAMPORTS
  ) {
    blocker = "fee-recipient-uninitialized";
  }
  const checkpointFee = miner === null || miner.checkpointFee === 0n ? CHECKPOINT_FEE_LAMPORTS : 0n;
  const minerRent = miner === null ? MINER_RENT_LAMPORTS : 0n;
  const networkFee = input.networkFeeLamports;
  // The wallet must stay rent-exempt AFTER the debits — without the floor
  // a wallet funded to exactly the sum fails the simulation with
  // InsufficientFundsForRent (see WALLET_RENT_FLOOR_LAMPORTS).
  const requiredBalance =
    totalDeploy + platformFee + checkpointFee + minerRent + networkFee + WALLET_RENT_FLOOR_LAMPORTS;

  if (blocker === null && walletBalanceLamports < requiredBalance) blocker = "insufficient-balance";

  return {
    eligibleSquares: eligible,
    mask,
    amountPerSquare,
    totalDeploy,
    remainder,
    platformFee,
    checkpointFee,
    minerRent,
    networkFee,
    requiredBalance,
    blocker,
  };
}

export interface MaxTotalInput {
  walletBalanceLamports: bigint;
  fee: PlatformFee;
  checkpointFee: bigint;
  minerRent: bigint;
  networkFeeLamports: bigint;
  safetyBufferLamports?: bigint;
}

/**
 * MAX, inverted: the largest total whose `total + fee(total) + fixed` still
 * fits the balance with the safety buffer intact. The fee is evaluated at
 * the un-reduced candidate (directive §5.3); because it is monotone and
 * capped, the result is valid by construction — the binary-search fallback
 * is a defensive guard, not an expected path.
 */
export function computeMaxTotalLamports(input: MaxTotalInput): bigint {
  const safety = input.safetyBufferLamports ?? SAFETY_BUFFER_LAMPORTS;
  // The wallet rent floor is a hard post-tx constraint, so it belongs in
  // `fixed` BEFORE the buffer — the buffer then reads as spendable SOL on
  // top of the minimum the wallet must keep.
  const fixed =
    input.checkpointFee + input.minerRent + input.networkFeeLamports + WALLET_RENT_FLOOR_LAMPORTS + safety;
  const candidate = input.walletBalanceLamports - fixed;
  if (candidate <= 0n) return 0n;

  let maxTotal = candidate - platformFeeLamports(input.fee, candidate);
  if (maxTotal <= 0n) return 0n;

  const affordable = (t: bigint): boolean =>
    t + platformFeeLamports(input.fee, t) + fixed <= input.walletBalanceLamports;
  if (!affordable(maxTotal)) {
    let lo = 0n;
    let hi = maxTotal;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      if (affordable(mid)) lo = mid;
      else hi = mid - 1n;
    }
    maxTotal = lo;
  }
  return maxTotal;
}

// ── Auto-join commitment planner (no-keeper design) ────────────────────

export type AutomationBlocker =
  | "amount-too-small"
  | "rounds-out-of-range"
  | "insufficient-balance"
  | "automation-active"
  | "fee-recipient-uninitialized";

export const MAX_ROUNDS = 500;

/**
 * The per-round executor fee written onto the automation account — paid
 * by the ORE program to whichever PUBLIC bot executes the round. 7 000
 * lamports is the observed market rate (the permissionless default,
 * consts.rs COMPOUND_FEE_PER_TRANSACTION, held by 160+ live accounts):
 * high enough that the competitive fleet bothers, low enough to be noise
 * for the user (70 000 lamports ≈ 0.007% on a 10-round × 1 SOL
 * commitment). NOT our revenue — ours is the one-time setup fee below.
 */
export const AUTOMATION_EXECUTOR_FEE_LAMPORTS = 7_000n;

export interface AutomationPlan {
  rounds: bigint;
  squareCount: bigint;
  /** The Automate wire `amount` — lamports per square per round. */
  amountPerSquare: bigint;
  /** `amountPerSquare × squareCount` — the constant per-round deploy. */
  perRoundTotal: bigint;
  /** Requested − deployed; never committed, never charged. */
  remainder: bigint;
  /** The Automate wire `fee` — flat lamports per round to the bot fleet. */
  executorFeePerRound: bigint;
  /** `rounds × (perRoundTotal + executorFeePerRound)` — the exact deposit. */
  deposit: bigint;
  /**
   * OUR revenue: the platform fee charged ONCE on the setup transaction
   * against the deposit (1% with the usual floor/ceiling). Charging once
   * on the aggregate is mathematically the same as 1% per round summed,
   * and at dust scale it dodges the per-round floor that made the keeper
   * design 8× the market at the median.
   */
  setupFee: bigint;
  automationRent: bigint;
  minerRent: bigint;
  checkpointTopUp: bigint;
  /** The rent, returned in full by the user-side stop (automate.rs:87-96). */
  refundable: bigint;
  /** The headline figure: deposit + setupFee + rents + checkpoint top-up. */
  walletDebit: bigint;
  /** The post-tx rent floor the wallet must retain on top of the debit. */
  walletRentFloor: bigint;
  /** walletDebit + walletRentFloor — what the wallet must hold to sign. */
  requiredBalance: bigint;
  blocker: AutomationBlocker | null;
}

export interface PlanAutomationInput {
  requestedTotalPerRound: bigint;
  /** Integer 1..500. */
  rounds: number;
  /** 25 in deploy-all mode. */
  squareCount?: number;
  minerExists: boolean;
  /** `miner.checkpointFee` — 0n for a miner that does not exist. */
  minerCheckpointFee?: bigint;
  /** An existing automation blocks until top-up/change exists (P3). */
  automation?: OreAutomation | null;
  /** Omit to skip the insufficient-balance check (tests pin pure math). */
  walletBalanceLamports?: bigint;
  /** See PlanDeployInput.feeRecipientExists — the setup tx pays the same
   *  treasury through the same bundled transfer. */
  feeRecipientExists?: boolean;
  fee: PlatformFee;
}

/**
 * Rounds are a BUDGET, not a field (§1.1): deposit = rounds × (perRound +
 * executor fee), and the program self-closes + refunds when the balance
 * can no longer cover one more round. `Preferred` fixes amount and mask
 * on-chain, so perRoundTotal is a constant and no bot — ours or a
 * stranger's — can change what deploys. No keeper exists in this design:
 * the PUBLIC fleet executes rounds for `executorFeePerRound`, and we
 * charge `setupFee` once on the one transaction the user signs.
 */
export function planAutomation(input: PlanAutomationInput): AutomationPlan {
  const squareCount = BigInt(input.squareCount ?? ALL_SQUARES);
  if (squareCount <= 0n || squareCount > BigInt(ALL_SQUARES)) {
    throw new RangeError(`square count out of range 1..25: ${squareCount}`);
  }
  // Rule 3: the per-square amount must survive the floor division or
  // encodeAutomateData would throw later. The 0.001 SOL total floor
  // guarantees it at 25 squares, but assert independently.
  const amountPerSquare = input.requestedTotalPerRound / squareCount;
  const perRoundTotal = amountPerSquare * squareCount;
  const remainder = input.requestedTotalPerRound - perRoundTotal;

  let blocker: AutomationBlocker | null = null;
  if (perRoundTotal < MIN_DEPLOY_TOTAL_LAMPORTS) blocker = "amount-too-small";
  else if (!Number.isInteger(input.rounds) || input.rounds < 1 || input.rounds > MAX_ROUNDS) {
    blocker = "rounds-out-of-range";
  }
  if (amountPerSquare <= 0n) {
    throw new RangeError("automation amount per square must be positive");
  }
  if (blocker === null && input.automation != null) blocker = "automation-active";

  const executorFeePerRound = AUTOMATION_EXECUTOR_FEE_LAMPORTS;
  const rounds = BigInt(Math.max(1, input.rounds));
  const deposit = rounds * (perRoundTotal + executorFeePerRound);
  // One charge on the aggregate. Note the floor can bind once on very
  // small deposits (< 0.01 SOL total) — the disclosure shows the
  // effective percentage rather than hiding it behind a blocker (the old
  // per-round A6 economics died with the keeper: we execute nothing).
  const setupFee = platformFeeLamports(input.fee, deposit);
  // Same bundled transfer as the manual path, same bootstrap rule.
  if (
    blocker === null &&
    input.feeRecipientExists === false &&
    setupFee > 0n &&
    setupFee < SYSTEM_ACCOUNT_RENT_LAMPORTS
  ) {
    blocker = "fee-recipient-uninitialized";
  }
  const automationRent = AUTOMATION_RENT_LAMPORTS;
  // automate.rs:57-77 creates the miner and zeroes checkpoint_fee, and
  // :136-140 tops up whenever checkpoint_fee == 0 — so a new miner pays
  // both rent and the 10k; an existing topped-up miner pays neither.
  const minerRent = input.minerExists ? 0n : MINER_RENT_LAMPORTS;
  const checkpointTopUp =
    !input.minerExists || (input.minerCheckpointFee ?? 0n) === 0n ? CHECKPOINT_FEE_LAMPORTS : 0n;
  const walletDebit = deposit + setupFee + automationRent + minerRent + checkpointTopUp;
  const walletRentFloor = WALLET_RENT_FLOOR_LAMPORTS;
  const requiredBalance = walletDebit + walletRentFloor;
  if (
    blocker === null &&
    input.walletBalanceLamports !== undefined &&
    input.walletBalanceLamports < requiredBalance
  ) {
    blocker = "insufficient-balance";
  }

  return {
    rounds,
    squareCount,
    amountPerSquare,
    perRoundTotal,
    remainder,
    executorFeePerRound,
    deposit,
    setupFee,
    automationRent,
    minerRent,
    checkpointTopUp,
    refundable: automationRent,
    walletDebit,
    walletRentFloor,
    requiredBalance,
    blocker,
  };
}

// ── live-automation views (auto-join §5.3) ─────────────────────────────

/** Number of set bits in an automation mask (max 25 bits are meaningful). */
export function popcount25(mask: bigint): number {
  let count = 0;
  let m = mask;
  while (m !== 0n) {
    count += Number(m & 1n);
    m >>= 1n;
  }
  return count;
}

/** The automation's constant per-round deploy: `amount` × occupied squares. */
export function automationPerRound(automation: OreAutomation): bigint {
  return automation.amount * BigInt(popcount25(automation.mask));
}

/**
 * Whole rounds the balance still covers (`balance / (perRound + fee)`),
 * floored. Reaching 0 means the next executor attempt self-closes the
 * automation and refunds the remainder (deploy.rs:349-352) — normal end
 * state, not an error (A7a).
 */
export function roundsRemaining(automation: OreAutomation): bigint {
  const perRound = automationPerRound(automation) + automation.fee;
  return perRound > 0n ? automation.balance / perRound : 0n;
}
