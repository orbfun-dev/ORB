/**
 * Self-hosted randomness (randomness fallback, design §2.2): the keeper is
 * the seed holder of the on-chain `EntropyChain`.
 *
 * Chain: `x_0` is a secret 32-byte value generated offline; `x_{i+1} =
 * sha256(x_i)`; `x_N` is committed on chain with `remaining = N`. While the
 * chain shows `commit = x_r` and `remaining = r`, the next seed to reveal
 * is `x_{r-1}`. Only `x_0` and `N` are stored (seed file, mode 600, never
 * in git); checkpoints every 1024 links keep each lookup under 1024 hashes.
 *
 * The slot-hash lookup and value derivation below mirror
 * `programs/orbit_jackpot/src/oracle/entropy.rs` exactly, so the crank can
 * compute the winning entry BEFORE sending a combined reveal+settle.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const CHECKPOINT_EVERY = 1024;
export const ENTROPY_VALUE_DOMAIN = Buffer.from("orb-entropy-v1");
/** Mirrors `ENTROPY_TARGET_DELAY_SLOTS` / `ENTROPY_REVEAL_DEADLINE_SLOTS`. */
export const ENTROPY_REVEAL_DEADLINE_SLOTS = 216_000n;

export function sha256(...parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

export class EntropySeeds {
  private readonly checkpoints: Buffer[] = [];

  constructor(
    x0: Buffer,
    readonly length: number,
  ) {
    if (x0.length !== 32) throw new RangeError("entropy x0 must be 32 bytes");
    if (!Number.isInteger(length) || length < 1) throw new RangeError("entropy length must be ≥ 1");
    let x = x0;
    for (let i = 0; i <= length; i += 1) {
      if (i % CHECKPOINT_EVERY === 0) this.checkpoints.push(x);
      if (i < length) x = sha256(x);
    }
  }

  /** Reads `{ "x0": "<64 hex>", "length": N }`. */
  static fromFile(path: string): EntropySeeds {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { x0?: unknown; length?: unknown };
    if (typeof raw.x0 !== "string" || !/^[0-9a-f]{64}$/.test(raw.x0) || typeof raw.length !== "number") {
      throw new Error(`entropy seed file ${path}: expected { x0: <64 hex>, length: <number> }`);
    }
    return new EntropySeeds(Buffer.from(raw.x0, "hex"), raw.length);
  }

  /** `x_i` for `0 ≤ i ≤ length`. */
  link(i: number): Buffer {
    if (!Number.isInteger(i) || i < 0 || i > this.length) throw new RangeError(`link ${i} out of range`);
    const base = Math.floor(i / CHECKPOINT_EVERY);
    let x = this.checkpoints[base]!;
    for (let k = base * CHECKPOINT_EVERY; k < i; k += 1) x = sha256(x);
    return x;
  }

  /** The value to commit on chain when this chain is set: `x_N`. */
  commit(): Buffer {
    return this.link(this.length);
  }

  /**
   * The seed that opens the chain's current commit, or null when this seed
   * file does not belong to the on-chain chain (wrong file, rotated chain).
   */
  seedFor(commitHex: string, remaining: bigint): Buffer | null {
    if (remaining < 1n || remaining > BigInt(this.length)) return null;
    const seed = this.link(Number(remaining) - 1);
    return sha256(seed).toString("hex") === commitHex ? seed : null;
  }
}

export type SlotHashLookup =
  | { kind: "found"; slot: bigint; hash: Buffer }
  | { kind: "notReached" }
  | { kind: "expired" }
  | { kind: "malformed" };

/** First produced slot at or after `target` in raw SlotHashes sysvar data
 *  (newest first). Identical rules to the program's `find_slot_hash`. */
export function findSlotHash(data: Buffer, target: bigint): SlotHashLookup {
  const ENTRY = 40;
  if (data.length < 8) return { kind: "malformed" };
  const count = Number(data.readBigUInt64LE(0));
  if (count === 0 || data.length < 8 + count * ENTRY) return { kind: "malformed" };
  const slotAt = (i: number) => data.readBigUInt64LE(8 + i * ENTRY);
  if (slotAt(count - 1) > target) return { kind: "expired" };
  let found: { slot: bigint; hash: Buffer } | null = null;
  for (let i = 0; i < count; i += 1) {
    const slot = slotAt(i);
    if (slot < target) break;
    found = { slot, hash: data.subarray(8 + i * ENTRY + 8, 8 + (i + 1) * ENTRY) };
  }
  return found === null ? { kind: "notReached" } : { kind: "found", ...found };
}

/** `sha256(DOMAIN ‖ round_id_le ‖ slot_hash ‖ seed)` — the round's value. */
export function entropyValue(roundId: bigint, slotHash: Buffer, seed: Buffer): Buffer {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(roundId);
  return sha256(ENTROPY_VALUE_DOMAIN, id, slotHash, seed);
}
