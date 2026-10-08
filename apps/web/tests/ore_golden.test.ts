/**
 * Golden transaction-shape test (directive Phase 6).
 *
 * ORE is not deployed on devnet/localnet, so transaction correctness is
 * proven structurally: build a deploy bundle for FIXED inputs and assert
 * the serialized shape byte-for-byte against the live-verified tables in
 * directive §3.3 — instruction count/order, programs, data lengths,
 * discriminants, and the full account lists with flags.
 *
 * PDA expectations are derived in-test from the documented seeds
 * (§3.1) rather than imported from the feature's pda.ts.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

vi.stubEnv(
  "VITE_ORE_FEE_RECIPIENT",
  Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58(),
);
const {
  BOARD_ADDRESS,
  CONFIG_ADDRESS,
  ENTROPY_PROGRAM_ID,
  ENTROPY_VAR_ADDRESS,
  ORE_PROGRAM_ID,
  PLATFORM_FEE_RECIPIENT,
  TREASURY_ADDRESS,
} = await import("../src/features/ore-lite/config");
const { buildCheckpointIx, buildDeployIx } = await import(
  "../src/features/ore-lite/instructions"
);

// ── fixed inputs ───────────────────────────────────────────────────────

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey;
const blockhash = Keypair.fromSeed(new Uint8Array(32).fill(6)).publicKey.toBase58();
const roundId = 454_137n;
const minerRoundId = 454_136n; // stale by one — the R4 trap
const amountPerSquare = 601_562n;
const mask = 0b101; // squares 0 and 2
const platformFee = 100_000n; // the 0.0001 SOL floor

// ── independent PDA derivation from the documented seeds (§3.1) ────────

function pda(seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, ORE_PROGRAM_ID)[0];
}

function u64le(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

const SYSTEM = SystemProgram.programId;
const COMPUTE_BUDGET = ComputeBudgetProgram.programId;

describe("golden deploy transaction shape (CB, CB, transfer, Checkpoint, Deploy)", () => {
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000 }),
    SystemProgram.transfer({
      fromPubkey: wallet,
      toPubkey: PLATFORM_FEE_RECIPIENT,
      lamports: platformFee,
    }),
    buildCheckpointIx({ signer: wallet, authority: wallet, minerRoundId }),
    buildDeployIx({
      signer: wallet,
      authority: wallet,
      roundId,
      amountPerSquare,
      mask,
    }),
  ];

  const message = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);

  it("compiles to a v0 message with 5 instructions; payer signs; no ALTs", () => {
    expect(tx.version).toBe(0);
    expect(message.compiledInstructions).toHaveLength(5);
    expect(message.header.numRequiredSignatures).toBe(1);
    expect(message.addressTableLookups).toHaveLength(0);
    expect(message.staticAccountKeys[0]!.equals(wallet)).toBe(true);
  });

  it("instruction programs and data lengths match the live-verified shape", () => {
    const programOf = (ix: (typeof message.compiledInstructions)[number]): PublicKey =>
      message.staticAccountKeys[ix.programIdIndex]!;
    expect(message.compiledInstructions.map(programOf).map((p) => p.toBase58())).toEqual([
      COMPUTE_BUDGET.toBase58(), // setComputeUnitLimit
      COMPUTE_BUDGET.toBase58(), // setComputeUnitPrice
      SYSTEM.toBase58(), // SystemProgram.transfer (fee)
      ORE_PROGRAM_ID.toBase58(), // Checkpoint
      ORE_PROGRAM_ID.toBase58(), // Deploy
    ]);
    // System program uses a u32 discriminator: transfer data = 4 + 8 bytes.
    expect(message.compiledInstructions.map((ix) => ix.data.length)).toEqual([5, 9, 12, 1, 13]);
    // discriminants: CU-limit=2, CU-price=3, transfer=2, Checkpoint=2, Deploy=6
    expect(message.compiledInstructions.map((ix) => ix.data[0])).toEqual([2, 3, 2, 2, 6]);
  });

  it("fee transfer moves the exact lamports wallet → recipient", () => {
    const transfer = ixs[2]!;
    expect(transfer.keys).toHaveLength(2);
    expect(transfer.keys[0]).toMatchObject({ pubkey: wallet, isSigner: true, isWritable: true });
    expect(transfer.keys[1]).toMatchObject({
      pubkey: PLATFORM_FEE_RECIPIENT,
      isSigner: false,
      isWritable: true,
    });
    expect(transfer.data.readUInt32LE(0)).toBe(2);
    expect(transfer.data.readBigUInt64LE(4)).toBe(platformFee);
  });

  it("Checkpoint carries exactly 8 metas with the STALE round PDA (R4)", () => {
    const ix = ixs[3]!;
    const expected: Array<[PublicKey, boolean, boolean]> = [
      [wallet, true, true],
      [wallet, false, true],
      // §3.4: WRITABLE — checkpoint.rs:183-203 writes the automation
      // account whenever one exists (total_ore_earned, balance on reload).
      [pda([Buffer.from("automation"), wallet.toBuffer()]), false, true],
      [BOARD_ADDRESS, false, false],
      [pda([Buffer.from("miner"), wallet.toBuffer()]), false, true],
      [pda([Buffer.from("round"), u64le(minerRoundId)]), false, true],
      [TREASURY_ADDRESS, false, true],
      [SYSTEM, false, false],
    ];
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(
      expected.map(([k, s, w]) => [k.toBase58(), s, w]),
    );
    expect(ix.data.length).toBe(1);
    expect(ix.data[0]).toBe(2);
  });

  it("Deploy carries the full live-verified 12-meta list with exact flags", () => {
    const ix = ixs[4]!;
    const expected: Array<[PublicKey, boolean, boolean]> = [
      [wallet, true, true],
      [wallet, false, true],
      [pda([Buffer.from("automation"), wallet.toBuffer()]), false, true],
      [BOARD_ADDRESS, false, true],
      [CONFIG_ADDRESS, false, true],
      [pda([Buffer.from("miner"), wallet.toBuffer()]), false, true],
      [pda([Buffer.from("round"), u64le(roundId)]), false, true],
      [TREASURY_ADDRESS, false, true],
      [SYSTEM, false, false],
      [ORE_PROGRAM_ID, false, false],
      [ENTROPY_VAR_ADDRESS, false, true],
      [ENTROPY_PROGRAM_ID, false, false],
    ];
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(
      expected.map(([k, s, w]) => [k.toBase58(), s, w]),
    );
    expect(ix.data.length).toBe(13);
    expect(ix.data[0]).toBe(6);
    expect(ix.data.readBigUInt64LE(1)).toBe(amountPerSquare);
    expect(ix.data.readUInt32LE(9)).toBe(mask);
  });

  it("Deploy All: the full 25-square mask keeps the wire format and the 12-meta list identical", () => {
    const full = buildDeployIx({
      signer: wallet,
      authority: wallet,
      roundId,
      amountPerSquare: 1_000_000n,
      mask: 0x01ff_ffff,
    });
    expect(full.keys).toHaveLength(12);
    expect(full.data.length).toBe(13);
    expect(full.data[0]).toBe(6);
    expect(full.data.readBigUInt64LE(1)).toBe(1_000_000n);
    expect(full.data.readUInt32LE(9)).toBe(0x01ff_ffff);
    // The account list is mask-independent: byte-for-byte the same 12
    // metas (same order, same flags) as the narrow-mask deploy above.
    expect(full.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(
      ixs[4]!.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    );
  });

  it("executor-shaped Deploy (signer = keeper ≠ authority) keeps the same 12 metas, keeper at 0, user at 1 (§3.5)", () => {
    const keeper = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey;
    const exec = buildDeployIx({
      signer: keeper,
      authority: wallet,
      roundId,
      amountPerSquare,
      mask,
    });
    expect(exec.keys).toHaveLength(12);
    expect(exec.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(
      ixs[4]!.keys.map((k, i) =>
        i === 0
          ? [keeper.toBase58(), k.isSigner, k.isWritable]
          : [k.pubkey.toBase58(), k.isSigner, k.isWritable],
      ),
    );
    // Only the payer/signer slot differs; the authority keeps its writable
    // non-signer slot and every PDA is derived from the authority.
    expect(exec.keys[0]).toMatchObject({ pubkey: keeper, isSigner: true, isWritable: true });
    expect(exec.keys[1]).toMatchObject({ pubkey: wallet, isSigner: false, isWritable: true });
    expect(exec.keys[2]!.pubkey.equals(pda([Buffer.from("automation"), wallet.toBuffer()]))).toBe(
      true,
    );
    expect(exec.keys[5]!.pubkey.equals(pda([Buffer.from("miner"), wallet.toBuffer()]))).toBe(true);
  });

  it("serializes deterministically (byte-for-byte stable for fixed inputs)", () => {
    const again = new TransactionMessage({
      payerKey: wallet,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000 }),
        SystemProgram.transfer({
          fromPubkey: wallet,
          toPubkey: PLATFORM_FEE_RECIPIENT,
          lamports: platformFee,
        }),
        buildCheckpointIx({ signer: wallet, authority: wallet, minerRoundId }),
        buildDeployIx({ signer: wallet, authority: wallet, roundId, amountPerSquare, mask }),
      ],
    }).compileToV0Message();
    expect(Buffer.from(tx.serialize()).equals(Buffer.from(new VersionedTransaction(again).serialize()))).toBe(
      true,
    );
    expect(tx.serialize().length).toBeGreaterThan(0);
  });
});
