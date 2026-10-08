/**
 * The independent entropy mirror — the TS twin of `entropy.rs` /
 * `math/tickets.rs`, ported from `scripts/local-demo/common.ts`. Used ONLY
 * by the post-settle verification: the chain recomputes the outcome; this
 * exists so the crank can assert chain ≡ event ≡ mirror and scream if
 * they ever diverge.
 */

/** `entropy.rs::split_entropy` — LE u128 halves of the 32-byte value. */
export function splitEntropy(value: Uint8Array): { ticket: bigint; mega: bigint } {
  const le = (bytes: Uint8Array): bigint => {
    let out = 0n;
    for (let i = bytes.length - 1; i >= 0; i -= 1) {
      out = (out << 8n) | BigInt(bytes[i]!);
    }
    return out;
  };
  return { ticket: le(value.subarray(0, 16)), mega: le(value.subarray(16, 32)) };
}

/** `math/tickets.rs::ticket_from_entropy` — entropy mod total. */
export function ticketFromEntropy(ticketEntropy: bigint, totalLamports: bigint): bigint {
  return ticketEntropy % totalLamports;
}

/** Phase 11 (decision D2): the canonical trigger odds are 1-in-625 —
 *  a pop roughly every 1.3 days at 180-second rounds. */
export const MEGA_TRIGGER_MODULUS = 625n;

export function megaTriggered(megaEntropy: bigint): boolean {
  return megaEntropy % MEGA_TRIGGER_MODULUS === 0n;
}
