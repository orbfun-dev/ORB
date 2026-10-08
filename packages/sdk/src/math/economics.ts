/**
 * The BigInt mirror of the program's settle-time economics
 * (`math/split.rs`, `math/mega.rs`) — the UI's single source of truth for
 * "what does a bet return", so components never guess with
 * floating-point percentages.
 *
 * Cross-language parity is the contract: every function reproduces the
 * Rust floor-division bit-for-bit through BigInt intermediates, pinned
 * against the committed `entropy_kat.json` vectors (the same file the
 * Rust KAT generator and the on-chain replay suite consume). Money is
 * `bigint`, always — no `Number` for lamports anywhere (R5).
 *
 * Canonical Phase 11 economics: a settled pot splits 9% winner / 89%
 * refunds / 1% admin / 1% Mega-Pot; on a trigger the pot's payable splits
 * 50% winner / 40% field / 10% retained, capped at 8× the round's own pot.
 */

/** The denominator every basis-point figure is measured against. */
export const BPS_DENOMINATOR = 10_000n;

/**
 * Mirrors `MathError::BpsOverflow` — an illegal bps combination. The
 * message mirrors the Rust Display text so logs line up across languages.
 */
export class BpsOverflowError extends Error {
  constructor(sum: bigint, denominator: bigint = BPS_DENOMINATOR) {
    super(`basis points exceed the ${denominator} denominator (got ${sum})`);
    this.name = "BpsOverflowError";
  }
}

/** Mirrors `MathError::ZeroTotal`. */
export class ZeroTotalError extends Error {
  constructor() {
    super("total must be greater than zero");
    this.name = "ZeroTotalError";
  }
}

/** The four-way division of a settled round pot (`PotSplit` in Rust). */
export interface PotSplitMirror {
  /** floor(total × winnerBps / 10_000). */
  winnerPayout: bigint;
  /** The exact residual: total − winner − admin − mega (rounding favours the field). */
  refundPool: bigint;
  adminCut: bigint;
  megaCut: bigint;
}

/**
 * Splits a settled pot four ways. `refundBps` is deliberately NOT an
 * input — it is the complement, validated at config level by I14; the
 * refund pool is the exact residual so I18 (reassemble the pot to the
 * lamport) holds by construction.
 *
 * @throws {@link BpsOverflowError} when `winnerBps + adminBps + megaBps`
 * exceeds 10 000.
 */
export function splitRoundPot(
  totalLamports: bigint,
  winnerBps: number,
  adminBps: number,
  megaBps: number,
): PotSplitMirror {
  const sum = BigInt(winnerBps) + BigInt(adminBps) + BigInt(megaBps);
  if (sum > BPS_DENOMINATOR) throw new BpsOverflowError(sum);
  const total = BigInt(totalLamports);
  const winnerPayout = (total * BigInt(winnerBps)) / BPS_DENOMINATOR;
  const adminCut = (total * BigInt(adminBps)) / BPS_DENOMINATOR;
  const megaCut = (total * BigInt(megaBps)) / BPS_DENOMINATOR;
  const refundPool = total - winnerPayout - adminCut - megaCut;
  return { winnerPayout, refundPool, adminCut, megaCut };
}

/**
 * Economics v3 (`split_round_pot_v3` in Rust): the winner's own stake is
 * never raked. The refund pool is v2's, bit for bit (so every loser's
 * pro-rata refund is unchanged); the admin and Mega cuts are their bps of
 * the LOSERS' money only; the winner's prize is the exact residual, so
 * prize + the winner's own pro-rata refund ≥ their stake + 9% of the
 * losers' money.
 */
export function splitRoundPotV3(
  totalLamports: bigint,
  winnerStake: bigint,
  winnerBps: number,
  adminBps: number,
  megaBps: number,
): PotSplitMirror {
  const total = BigInt(totalLamports);
  const stake = BigInt(winnerStake);
  if (stake > total) throw new RangeError(`winner stake ${stake} exceeds pot ${total}`);
  const losers = total - stake;
  const { refundPool } = splitRoundPot(total, winnerBps, adminBps, megaBps);
  const adminCut = (losers * BigInt(adminBps)) / BPS_DENOMINATOR;
  const megaCut = (losers * BigInt(megaBps)) / BPS_DENOMINATOR;
  const winnerPayout = total - refundPool - adminCut - megaCut;
  return { winnerPayout, refundPool, adminCut, megaCut };
}

/**
 * What a winning entry of `stake` collects in total — prize plus its own
 * pro-rata refund — under the given economics version. The figure a UI
 * should promise "if you win".
 */
export function winnerTakeHome(
  economicsVersion: number,
  totalLamports: bigint,
  stake: bigint,
  winnerBps: number,
  adminBps: number,
  megaBps: number,
): bigint {
  const split =
    economicsVersion >= 3
      ? splitRoundPotV3(totalLamports, stake, winnerBps, adminBps, megaBps)
      : splitRoundPot(totalLamports, winnerBps, adminBps, megaBps);
  const total = BigInt(totalLamports);
  const refund = total === 0n ? 0n : (BigInt(stake) * split.refundPool) / total;
  return split.winnerPayout + refund;
}

/** The three-way division of a Mega-Pot pop (`MegaSplit` in Rust). */
export interface MegaSplitMirror {
  /** To the round winner via `claim_winnings`. */
  awarded: bigint;
  /** Pro-rata to every entry via `close_entry`. */
  fieldPool: bigint;
  /** Residual — the next cycle's seed. */
  retained: bigint;
}

/**
 * Splits a Mega-Pot trigger payout under the round-pot cap, mirroring the
 * Rust algorithm exactly: sum the payout bps, compute the nominal
 * `accrued × g / 10_000`, clamp to `totalLamports × capBps / 10_000`
 * (`capBps 0` = uncapped, the pre-Phase-11 behaviour), then divide the
 * payable preserving the winner:field bps ratio.
 *
 * @throws {@link BpsOverflowError} when `awardBps + fieldBps` exceeds
 * 10 000.
 */
export function splitMegaPot(
  accruedLamports: bigint,
  totalLamports: bigint,
  awardBps: number,
  fieldBps: number,
  payoutCapBps: number,
): MegaSplitMirror {
  const g = BigInt(awardBps) + BigInt(fieldBps);
  if (g > BPS_DENOMINATOR) throw new BpsOverflowError(g);
  const accrued = BigInt(accruedLamports);
  const nominal = (accrued * g) / BPS_DENOMINATOR;
  const payable =
    payoutCapBps === 0
      ? nominal
      : (() => {
          // A config cap large enough to overflow u64 cannot bind (the
          // nominal never exceeds the accrual); clamp like the Rust side.
          const capRaw = (BigInt(totalLamports) * BigInt(payoutCapBps)) / BPS_DENOMINATOR;
          const u64Max = (1n << 64n) - 1n;
          const cap = capRaw > u64Max ? u64Max : capRaw;
          return nominal < cap ? nominal : cap;
        })();
  const awarded = g === 0n ? 0n : (payable * BigInt(awardBps)) / g;
  const fieldPool = payable - awarded;
  const retained = accrued - payable;
  return { awarded, fieldPool, retained };
}

/**
 * One entry's pro-rata share of a settle-time pool — the ONLY sanctioned
 * per-entry formula (R2): `floor(amount × pool / total)`. Because
 * `Σ amount_i == total` exactly (I9), the sum of shares never exceeds the
 * pool; the deficit (at most `n − 1` lamports) sweeps to the Mega-Pot as
 * dust at `close_round`. Never re-derive a percentage of the stake — the
 * naive formula overdraws the vault and locks the round.
 *
 * @throws {@link ZeroTotalError} when `totalLamports` is `0n`.
 */
export function entryShare(
  amountLamports: bigint,
  poolLamports: bigint,
  totalLamports: bigint,
): bigint {
  if (totalLamports === 0n) throw new ZeroTotalError();
  return (BigInt(amountLamports) * BigInt(poolLamports)) / BigInt(totalLamports);
}
