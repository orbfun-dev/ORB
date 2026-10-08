/**
 * Raw ORE instruction builders — PURE (no React, no Connection).
 *
 * Wire format (R1): one u8 discriminant followed by a `#[repr(C)]` POD
 * struct, little-endian, no Borsh. Account meta order and flags are the
 * tables in directive §3.3, cross-checked against live mainnet
 * transactions. The published `api/idl.json` is STALE (11 metas for
 * deploy, 6 for checkpoint) — do not regenerate from it.
 */

import {
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  BOARD_ADDRESS,
  CONFIG_ADDRESS,
  ENTROPY_PROGRAM_ID,
  ENTROPY_VAR_ADDRESS,
  ORE_MINT_ADDRESS,
  ORE_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TREASURY_ADDRESS,
} from "./config";
import { associatedTokenAddress, automationPda, minerPda, roundPda } from "./pda";

// ── discriminants & encoding (§3.2) ────────────────────────────────────

export const ORE_INSTRUCTION_DISCRIMINANTS = {
  Automate: 0,
  Checkpoint: 2,
  ClaimSOL: 3,
  ClaimORE: 4,
  Deploy: 6,
} as const;

/** `AutomationStrategy` (api/src/state/automation.rs). */
export const ORE_AUTOMATION_STRATEGIES = {
  Random: 0,
  Preferred: 1,
  Discretionary: 2,
  DiscretionaryBps: 3,
} as const;

function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

function u32le(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

/** Validates a 25-bit square mask packed in a u32: bits 25–31 must be 0. */
export function assertDeployMask(mask: number): void {
  if (!Number.isInteger(mask) || mask <= 0 || mask > 0x01ff_ffff) {
    throw new RangeError(
      `invalid deploy mask 0x${(mask >>> 0).toString(16)}: must be a non-zero 25-bit mask`,
    );
  }
}

export function encodeDeployData(amountPerSquare: bigint, squares: number): Buffer {
  assertDeployMask(squares);
  if (amountPerSquare <= 0n) {
    throw new RangeError("deploy amount per square must be positive");
  }
  // disc 6 | amount u64 | squares u32  →  13 bytes
  return Buffer.concat([
    Buffer.from([ORE_INSTRUCTION_DISCRIMINANTS.Deploy]),
    u64le(amountPerSquare),
    u32le(squares),
  ]);
}

export function encodeClaimOreData(bps: bigint): Buffer {
  if (bps <= 0n || bps > 10_000n) {
    throw new RangeError("claim-ore bps must be in (0, 10000]");
  }
  // disc 4 | bps u64  →  9 bytes
  return Buffer.concat([Buffer.from([ORE_INSTRUCTION_DISCRIMINANTS.ClaimORE]), u64le(bps)]);
}

// ── Automate (V2) — disc 0, 66 bytes (auto-join directive §3.1/§3.2) ───

const U64_MAX_LAMPORTS = 18_446_744_073_709_551_615n;

/**
 * `AutomationConditions::default()` as bytes (api/src/state/automation.rs):
 * max_production_cost u64::MAX | min_motherlode 0 | max_motherlode 65 535 |
 * split_tiles 0 | solo_tiles 0 | _buffer 0. `deploy.rs` reads only the
 * motherlode bounds — with this blob they never gate.
 */
export const DEFAULT_AUTOMATION_CONDITIONS: Buffer = Buffer.concat([
  u64le(U64_MAX_LAMPORTS),
  Buffer.from([0, 0]), // min_motherlode u16
  Buffer.from([0xff, 0xff]), // max_motherlode u16 = 65 535 (the Rust doc
  // comment claims u64::MAX and is wrong — u16 is the widest cap expressible)
  Buffer.from([0, 0]), // split_tiles u16 (non-zero requires Random — A4)
  Buffer.from([0, 0]), // solo_tiles u16
  Buffer.alloc(8), // _buffer
]);

/**
 * A3 guard: an all-zero 24-byte conditions blob means `max_motherlode = 0`,
 * and live motherlode is far above zero, so every deploy would return Ok(())
 * having deployed nothing — green transactions, zero SOL, fees burned. Only
 * an explicitly-zeroed V2 blob is dangerous; the 42-byte legacy form makes
 * the program substitute the safe default itself.
 */
function assertSafeConditions(conditions: Buffer): void {
  if (conditions.length !== 24) {
    throw new RangeError(`automation conditions must be 24 bytes, got ${conditions.length}`);
  }
  if (conditions.every((b) => b === 0)) {
    throw new RangeError(
      "automation conditions are all zero — max_motherlode 0 would make every deploy " +
        "a silent no-op (deploy.rs returns Ok() without deploying); use " +
        "DEFAULT_AUTOMATION_CONDITIONS",
    );
  }
}

export interface AutomateArgs {
  /** Lamports per square per round. */
  amountPerSquare: bigint;
  /** Lamports added to the automation balance by this call. */
  deposit: bigint;
  /** Flat executor fee per round (lamports). */
  fee: bigint;
  /** 25-bit square mask (u64 on the wire). */
  mask: number | bigint;
  strategy: number;
  /** 0 in this phase (A5: reload makes the round count open-ended). */
  reload: bigint;
  conditions?: Buffer;
}

/** disc 0 | amount u64 | deposit u64 | fee u64 | mask u64 | strategy u8 | reload u64 | conditions 24B → 66 bytes. */
export function encodeAutomateData(args: AutomateArgs): Buffer {
  const conditions = args.conditions ?? DEFAULT_AUTOMATION_CONDITIONS;
  assertSafeConditions(conditions);
  const mask = typeof args.mask === "bigint" ? args.mask : BigInt(args.mask);
  if (mask <= 0n || mask > 0x01ff_ffffn) {
    throw new RangeError(
      `invalid automation mask 0x${mask.toString(16)}: must be a non-zero 25-bit mask`,
    );
  }
  return Buffer.concat([
    Buffer.from([ORE_INSTRUCTION_DISCRIMINANTS.Automate]),
    u64le(args.amountPerSquare),
    u64le(args.deposit),
    u64le(args.fee),
    u64le(mask),
    Buffer.from([args.strategy]),
    u64le(args.reload),
    conditions,
  ]);
}

/** Inverse of encodeAutomateData — round-trip checks in tests. */
export function decodeAutomateData(data: Uint8Array): AutomateArgs & { conditions: Buffer } {
  if (data.length !== 66 || data[0] !== ORE_INSTRUCTION_DISCRIMINANTS.Automate) {
    throw new RangeError(`not an Automate V2 payload: ${data.length} bytes`);
  }
  const buf = Buffer.from(data);
  return {
    amountPerSquare: buf.readBigUInt64LE(1),
    deposit: buf.readBigUInt64LE(9),
    fee: buf.readBigUInt64LE(17),
    mask: buf.readBigUInt64LE(25),
    strategy: buf[33]!,
    reload: buf.readBigUInt64LE(34),
    conditions: buf.subarray(42, 66),
  };
}

// ── account meta shorthands ────────────────────────────────────────────

type Meta = { pubkey: PublicKey; isSigner: boolean; isWritable: boolean };

const ro = (pubkey: PublicKey): Meta => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey): Meta => ({ pubkey, isSigner: false, isWritable: true });
const signW = (pubkey: PublicKey): Meta => ({ pubkey, isSigner: true, isWritable: true });

const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

// ── builders (§3.3 — exact order, exact flags) ─────────────────────────

export interface CheckpointIxArgs {
  signer: PublicKey;
  authority: PublicKey;
  /** `miner.round_id` — the miner's STALE round, not the current one (R4). */
  minerRoundId: bigint;
}

/** 8 metas, live-verified `accts=8`. */
export function buildCheckpointIx(args: CheckpointIxArgs): TransactionInstruction {
  const { signer, authority, minerRoundId } = args;
  return new TransactionInstruction({
    programId: ORE_PROGRAM_ID,
    keys: [
      signW(signer),
      rw(authority),
      // WRITABLE (auto-join §3.4): checkpoint.rs:183-203 writes the
      // automation account whenever one exists (total_ore_earned, and
      // balance when reload is on). Read-only failed every automated
      // checkpoint; on the manual path the account is absent and this is a
      // harmless writable pass-through.
      rw(automationPda(authority)),
      ro(BOARD_ADDRESS),
      rw(minerPda(authority)),
      rw(roundPda(minerRoundId)),
      rw(TREASURY_ADDRESS),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: Buffer.from([ORE_INSTRUCTION_DISCRIMINANTS.Checkpoint]),
  });
}

export interface DeployIxArgs {
  signer: PublicKey;
  authority: PublicKey;
  /** `board.round_id` — the CURRENT round. */
  roundId: bigint;
  /** Per-square amount — the SOL leaving the wallet is `amount × popcount` (R2). */
  amountPerSquare: bigint;
  /** 25-bit square mask. */
  mask: number;
}

/** 12 metas, live-verified `accts=12`. */
export function buildDeployIx(args: DeployIxArgs): TransactionInstruction {
  const { signer, authority, roundId, amountPerSquare, mask } = args;
  return new TransactionInstruction({
    programId: ORE_PROGRAM_ID,
    keys: [
      signW(signer),
      rw(authority),
      rw(automationPda(authority)), // passed even when the account does not exist
      rw(BOARD_ADDRESS),
      rw(CONFIG_ADDRESS),
      rw(minerPda(authority)),
      rw(roundPda(roundId)),
      rw(TREASURY_ADDRESS),
      ro(SYSTEM_PROGRAM_ID),
      ro(ORE_PROGRAM_ID),
      rw(ENTROPY_VAR_ADDRESS),
      ro(ENTROPY_PROGRAM_ID),
    ],
    data: encodeDeployData(amountPerSquare, mask),
  });
}

/**
 * 5 metas: signer(s,w), BOARD(w), miner(signer)(w), System, ORE.
 *
 * BOARD is WRITABLE, as on every live mainnet claim: the handler's
 * self-CPI passes it writable, so a read-only BOARD failed every claim with
 * "Cross-program invocation with unauthorized signer or writable account"
 * (PrivilegeEscalation). Directive §3.3 had it read-only — it came from
 * source, not a live transaction. Reproduced and fixed by mainnet
 * simulation 2026-10-08.
 */
export function buildClaimSolIx(signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ORE_PROGRAM_ID,
    keys: [
      signW(signer),
      rw(BOARD_ADDRESS),
      rw(minerPda(signer)),
      ro(SYSTEM_PROGRAM_ID),
      ro(ORE_PROGRAM_ID),
    ],
    data: Buffer.from([ORE_INSTRUCTION_DISCRIMINANTS.ClaimSOL]),
  });
}

/**
 * 11 metas — see §3.3 ClaimORE. BOARD writable for the same reason as
 * ClaimSOL; MINT writable to match live mainnet claims exactly (the
 * BOARD flag alone is what the failure needed).
 */
export function buildClaimOreIx(signer: PublicKey, bps: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: ORE_PROGRAM_ID,
    keys: [
      signW(signer),
      rw(BOARD_ADDRESS),
      rw(minerPda(signer)),
      rw(ORE_MINT_ADDRESS),
      rw(associatedTokenAddress(ORE_MINT_ADDRESS, signer)),
      rw(TREASURY_ADDRESS),
      rw(associatedTokenAddress(ORE_MINT_ADDRESS, TREASURY_ADDRESS)),
      ro(SYSTEM_PROGRAM_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(ORE_PROGRAM_ID),
    ],
    data: encodeClaimOreData(bps),
  });
}

// ── Automate — setup, top-up and stop (auto-join directive §3.1) ────────

export interface AutomateIxArgs extends AutomateArgs {
  /** The wallet that owns (or will own) the automation — pays deposit + rent. */
  authority: PublicKey;
  /**
   * OUR keeper for setup/top-up; `PublicKey.default` for the user-side stop
   * (automate.rs:87-96 closes the account and refunds every lamport).
   */
  executor: PublicKey;
}

/**
 * 5 metas. Meta 2 (executor) is deliberately READ-ONLY, diverging from the
 * Rust SDK (A1): automate.rs only reads `executor_info.key` — but on the
 * stop path the executor IS the System program address (32 zero bytes), so
 * a writable meta would request a write lock on a native program.
 */
export function buildAutomateIx(args: AutomateIxArgs): TransactionInstruction {
  const { authority, executor, ...data } = args;
  return new TransactionInstruction({
    programId: ORE_PROGRAM_ID,
    keys: [
      signW(authority),
      rw(automationPda(authority)),
      ro(executor),
      rw(minerPda(authority)),
      ro(SYSTEM_PROGRAM_ID),
    ],
    data: encodeAutomateData(data),
  });
}
