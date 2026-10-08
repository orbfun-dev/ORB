/**
 * Minimal borsh reader for the raw-account and event decoders.
 *
 * Every integer wider than 32 bits is returned as `BigInt` — `u64` lamports
 * and slots exceed `Number.MAX_SAFE_INTEGER`, and the wheel module's
 * no-float-before-the-render-boundary rule starts here (roadmap 6.2/6.4).
 * Signed `i64`s round-trip through `BigInt.asIntN` so negative timestamps
 * (used deliberately in the Rust layout fixture) decode exactly.
 */

import { PublicKey } from "@solana/web3.js";

export class BorshReader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  /** Bytes consumed so far. */
  get position(): number {
    return this.offset;
  }

  /** Requires `count` unread bytes to exist, else throws with context. */
  private need(count: number, what: string): void {
    if (this.offset + count > this.buf.length) {
      throw new RangeError(
        `borsh: need ${count} byte(s) for ${what} at offset ${this.offset}, ` +
          `buffer holds ${this.buf.length}`,
      );
    }
  }

  u8(what = "u8"): number {
    this.need(1, what);
    return this.buf.readUInt8(this.offset++);
  }

  bool(what = "bool"): boolean {
    const v = this.u8(what);
    if (v !== 0 && v !== 1) {
      throw new RangeError(`borsh: ${what} at offset ${this.offset - 1} is ${v}, expected 0/1`);
    }
    return v === 1;
  }

  u16Le(what = "u16"): number {
    this.need(2, what);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  u32Le(what = "u32"): number {
    this.need(4, what);
    const v = this.buf.readUInt32LE(this.offset);
    this.offset += 4;
    return v;
  }

  /** Unsigned 64-bit little-endian — lamports, slots, tickets. */
  u64Le(what = "u64"): bigint {
    this.need(8, what);
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  /** Signed 64-bit little-endian — unix timestamps. */
  i64Le(what = "i64"): bigint {
    this.need(8, what);
    const v = this.buf.readBigInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  /** 32-byte public key, rendered base58. */
  pubkey(what = "pubkey"): string {
    this.need(32, what);
    const key = new PublicKey(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return key.toString();
  }

  /** Fixed-length byte array (e.g. `[u8; 32]` randomness values). */
  fixedBytes(count: number, what = `bytes[${count}]`): Uint8Array {
    this.need(count, what);
    const v = new Uint8Array(this.buf.subarray(this.offset, this.offset + count));
    this.offset += count;
    return v;
  }
}
