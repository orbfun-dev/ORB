/**
 * Feature-local formatters. Deliberately NOT imported from `src/lib/format`:
 * the isolation boundary forbids app imports, and ORE grams need 11
 * decimals where SOL needs 9. Integer math only — floats may render,
 * never decide.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const GRAMS_PER_ORE = 100_000_000_000n;

/** Exact decimal-string → lamports; `null` when not a valid SOL amount. */
export function parseSolToLamports(input: string): bigint | null {
  if (!/^\d+(\.\d{1,9})?$/.test(input)) return null;
  const [whole, fraction = ""] = input.split(".");
  const padded = (fraction + "0".repeat(9)).slice(0, 9);
  return BigInt(whole!) * LAMPORTS_PER_SOL + BigInt(padded);
}

/** Lamports → SOL string with `decimals` fractional digits. */
export function formatSol(lamports: bigint, decimals = 3): string {
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const fraction = (abs % LAMPORTS_PER_SOL).toString().padStart(9, "0").slice(0, decimals);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Grams (11 decimals) → ORE string. */
export function formatOre(grams: bigint, decimals = 4): string {
  const whole = grams / GRAMS_PER_ORE;
  const fraction = (grams % GRAMS_PER_ORE).toString().padStart(11, "0").slice(0, decimals);
  return `${whole}.${fraction}`;
}

/** Compact SOL, trailing zeros trimmed — for headlines. */
export function formatSolCompact(lamports: bigint): string {
  return formatSol(lamports, 2).replace(/\.?0+$/, "");
}

/** `mm:ss` from seconds, floored at 0. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = (s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

/** `ABCD…EFGH` — recognizable, not copyable. */
export function shortAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}
