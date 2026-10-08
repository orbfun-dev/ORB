/**
 * The draw's two pure primitives (directive §6.5, §6.6).
 *
 * CANONICAL ENTRY LIST — ordered by entry_no ascending.
 * LEAF i — sha256(u32le(entry_no) ++ utf8(wallet)).
 * TREE   — pairwise sha256(left ++ right), an odd trailing node is
 *          duplicated (bitcoin style); the root is the 32-byte digest.
 *
 * REVEAL — winning_no = u64_le(sha256(merkle_root ‖ blockhash))
 *          mod entries_issued + 1.
 *
 * scripts/raffle/verify-draw.ts re-implements BOTH from scratch with
 * node:crypto (no shared code) — that independence is the point.
 */

import { createHash } from "node:crypto";

export interface CanonicalEntry {
  entryNo: number;
  wallet: string;
}

function sha256(...chunks: Buffer[]): Buffer {
  return createHash("sha256").update(Buffer.concat(chunks)).digest();
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

export function entryLeaf(entry: CanonicalEntry): Buffer {
  return sha256(u32le(entry.entryNo), Buffer.from(entry.wallet, "utf8"));
}

/** Merkle root over the canonical entry list (odd nodes duplicated). */
export function merkleRoot(entries: CanonicalEntry[]): Buffer {
  if (entries.length === 0) {
    throw new Error("merkleRoot: the entry list is empty — nothing to draw over");
  }
  let level = entries.map(entryLeaf);
  while (level.length > 1) {
    if (level.length % 2 === 1) level = [...level, level[level.length - 1]];
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256(level[i], level[i + 1]));
    }
    level = next;
  }
  return level[0];
}

/** §6.6 — the reveal, verifiable by anyone with the root and the blockhash. */
export function winningEntryNo(
  root: Buffer,
  /** The 32-byte blockhash of the target slot (raw bytes, not base58). */
  blockhash: Buffer,
  entriesIssued: number,
): number {
  if (!Number.isInteger(entriesIssued) || entriesIssued < 1) {
    // `mod 0` is a RangeError, and an epoch with no entries has no
    // winner to name. Callers resolve empty epochs before the reveal
    // (raffle_finalize_empty_epoch); this says so out loud if one slips.
    throw new Error(
      `winningEntryNo: entriesIssued must be >= 1, got ${entriesIssued} — an empty epoch has no winner`,
    );
  }
  const h = sha256(root, blockhash);
  const u64 = h.readBigUInt64LE(0);
  return Number(u64 % BigInt(entriesIssued)) + 1;
}
