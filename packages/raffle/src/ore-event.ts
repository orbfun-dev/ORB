/**
 * ORE event decoding — the `Log` self-CPI transport, pinned to
 * regolith-labs/ore@48c203b (v3.8.25).
 *
 * ORE is a steel program: `program_log()` CPIs into its own `Log`
 * instruction with data = `Log{}.to_bytes() ++ event_bytes`, i.e. a
 * ONE-byte instruction discriminant (Log = 8 — steel instruction tags
 * are a single u8) followed by a `#[repr(C)]` bytemuck POD event struct
 * — no borsh, no anchors. 121 bytes in all for a DeployEvent.
 *
 * Until 2026-10-08 this read an 8-byte tag, as did the test fixture, so
 * the tests agreed with each other and no real deploy ever decoded.
 * Checked against mainnet that day: a playorb deploy's Log data is
 * `08 | 02 00 00 00 00 00 00 00 | authority …`. tests/p4 pins those
 * real bytes. The
 * event structs live in ore api/src/event.rs; `DeployEvent` (disc 2) is
 * the one this engine qualifies (R4).
 *
 *   struct DeployEvent {        // 120 bytes
 *     disc: u64,                // 0   — 2 for Deploy
 *     authority: Pubkey,        // 8   — attributed wallet (R4)
 *     amount: u64,              // 40  — PER SQUARE
 *     mask: u64,                // 48
 *     round_id: u64,            // 56
 *     signer: Pubkey,           // 64  — executor on automation deploys
 *     strategy: u64,            // 96  — u64::MAX when manual
 *     total_squares: u64,       // 104 — real spend = amount × THIS
 *     ts: i64,                  // 112
 *   }
 */

import bs58 from "bs58";

export const ORE_PROGRAM_ID = "oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv";

/** `OreInstruction::Log` — the self-CPI carrier for events (one byte). */
export const ORE_IX_LOG = 8;

/** `OreEvent::Deploy` — the only OreEvent this engine qualifies. */
export const ORE_EVENT_DEPLOY = 2n;

export interface OreDeployEvent {
  /** Base58 — the attributed wallet (R4). */
  authority: string;
  /** Lamports per square. */
  amount: bigint;
  mask: bigint;
  roundId: bigint;
  /** The transaction signer — NOT attributed (R4). */
  signer: string;
  strategy: bigint;
  /** Real spend is amount × total_squares (R4). */
  totalSquares: bigint;
  ts: bigint;
}

export class OreEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OreEventError";
  }
}

function readU64(data: Buffer, offset: number): bigint {
  return data.readBigUInt64LE(offset);
}

/**
 * Decodes the data of an inner instruction to the ORE program. Returns
 * null for anything that is not an ORE Log-carried DeployEvent (the
 * program also logs Reset/Bury/Liq/Claim events through the same
 * carrier; foreign programs share the anchor event-cpi shape).
 */
export function decodeOreLogInstruction(data: Buffer): OreDeployEvent | null {
  if (data.length < 1) return null;
  if (data[0] !== ORE_IX_LOG) return null;
  const event = data.subarray(1);
  if (event.length < 120) return null; // exact DeployEvent size
  if (readU64(event, 0) !== ORE_EVENT_DEPLOY) return null;
  const pub = (offset: number): string =>
    bs58.encode(event.subarray(offset, offset + 32));
  return {
    authority: pub(8),
    amount: readU64(event, 40),
    mask: readU64(event, 48),
    roundId: readU64(event, 56),
    signer: pub(64),
    strategy: readU64(event, 96),
    totalSquares: readU64(event, 104),
    ts: event.readBigInt64LE(112),
  };
}

/** R4: the qualifying spend of one deploy event. */
export function deploySpendLamports(event: OreDeployEvent): bigint {
  return event.amount * event.totalSquares;
}
