/**
 * Display formatting — the render boundary where BigInt finally becomes
 * strings. Money never passes through `Number` on the way in: SOL inputs
 * are parsed as decimal strings directly to lamports, and lamports format
 * back via integer division, mirroring the SDK's no-float rule (roadmap
 * 6.2): floating point may render, never decide.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Exact decimal-string → lamports. Accepts `1`, `1.5`, `0.123456789`;
 * rejects signs, separators, exponents, and >9 fractional digits by
 * returning `null` (caller drives the validation UX).
 */
export function parseSolToLamports(input: string): bigint | null {
  if (!/^\d+(\.\d{1,9})?$/.test(input)) {
    return null;
  }
  const [whole, fraction = ""] = input.split(".");
  const padded = (fraction + "0".repeat(9)).slice(0, 9);
  return BigInt(whole!) * LAMPORTS_PER_SOL + BigInt(padded);
}

/** Lamports → SOL string with `decimals` fractional digits (integer math). */
export function formatLamports(lamports: bigint, decimals = 4): string {
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const fraction = (abs % LAMPORTS_PER_SOL).toString().padStart(9, "0");
  const shown = fraction.slice(0, decimals);
  const sign = negative ? "-" : "";
  return `${sign}${whole}.${shown}`;
}

/**
 * Lamports → compact SOL, trailing zeros trimmed. Two decimals is the
 * house style, but a NON-ZERO amount must never render as "0": entry rent
 * (0.00120396), keeper tips (0.0002) and the escrow floor (0.00127) all
 * round to nothing at 2 dp, and the live card read "+ 0 entry rent · 0 SOL
 * account rent" as a result (2026-10-07). Small values widen to the first
 * precision that actually shows a digit, capped at 9 dp.
 */
export function formatSolCompact(lamports: bigint): string {
  const trim = (s: string): string => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
  const compact = trim(formatLamports(lamports, 2));
  if (lamports === 0n || compact !== "0" && compact !== "-0") return compact;
  for (const decimals of [4, 6, 9]) {
    const wider = trim(formatLamports(lamports, decimals));
    if (wider !== "0" && wider !== "-0") return wider;
  }
  // Below 1e-9 SOL and non-zero is sub-lamport — impossible, but total.
  return compact;
}

/**
 * Lamports → reward-figure SOL: at least two decimals, up to four, trailing
 * zeros beyond the second trimmed (0.0890 → "0.089", 1.5 → "1.50"). The
 * rewards card used `formatSolCompact`, which cut a 0.0891 SOL refund to
 * "0.08" — the figure you are about to claim deserves its real digits.
 * Sub-0.0001 amounts widen like `formatSolCompact` so non-zero never reads
 * as zero. Truncates, never rounds.
 */
export function formatSolReward(lamports: bigint): string {
  const shown = formatLamports(lamports, 4).replace(/(\.\d{2}\d*?)0+$/, "$1");
  if (lamports === 0n || /[1-9]/.test(shown)) return shown;
  return formatSolCompact(lamports);
}

/**
 * Share as a percentage with exactly two decimals, computed in integer
 * basis points — `basisPointsPercent(1n, 4n)` is "25.00". Zero denominator
 * yields "0.00" (an empty round has no odds to show).
 */
export function basisPointsPercent(
  numerator: bigint,
  denominator: bigint,
): string {
  if (denominator <= 0n) return "0.00";
  const bps = (numerator * 10_000n) / denominator;
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}`;
}

/** `ABCD…EFGH` — enough of a base58 key to recognize, never to copy. */
export function shortAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/**
 * Exact thousands-grouped decimal of a bigint — ticket ranges can exceed
 * 2^53 lamports, so `Number` formatting is forbidden on this path.
 */
export function groupDigits(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}
