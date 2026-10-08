/**
 * Platform-fee engine (directive §5) — PURE.
 *
 * The fee is a bare `SystemProgram.transfer` bundled into the deploy
 * transaction (R9): Solana atomicity makes it land iff the deploy lands,
 * with no wrapper program. The math here is the only place a fee figure
 * may come from — components never recompute it.
 */

export type PlatformFee =
  | { kind: "flat"; lamports: bigint }
  | { kind: "bps"; bps: number; minLamports: bigint; maxLamports: bigint };

/**
 * Platform fee for a deploy.
 *
 * `totalDeployLamports` MUST be `amountPerSquare × eligibleSquareCount`
 * (R2), computed from the POST-R3-filter square set. Charging bps on the
 * per-square amount instead of the total undercharges by a factor of up
 * to 25 — the single most expensive bug available here.
 */
export function platformFeeLamports(fee: PlatformFee, totalDeployLamports: bigint): bigint {
  if (totalDeployLamports <= 0n) return 0n; // R3: nothing deployed, nothing charged
  if (fee.kind === "flat") return fee.lamports;
  const raw = (totalDeployLamports * BigInt(fee.bps)) / 10_000n;
  if (raw < fee.minLamports) return fee.minLamports;
  if (raw > fee.maxLamports) return fee.maxLamports;
  return raw;
}

/** Base transaction fee (two signatures' worth of the 5k lamport floor). */
export const BASE_NETWORK_FEE_LAMPORTS = 5_000n;

/**
 * Estimated network fee for the CU budget + priority price, in whole
 * lamports: `cuLimit × microLamports/CU ÷ 1e6` plus the base fee.
 * Integer math only — floats never decide money.
 */
export function estimateNetworkFeeLamports(cuLimit: number, cuPriceMicroLamports: number): bigint {
  const lamports = (BigInt(cuLimit) * BigInt(Math.max(0, Math.round(cuPriceMicroLamports)))) / 1_000_000n;
  return BASE_NETWORK_FEE_LAMPORTS + lamports;
}
