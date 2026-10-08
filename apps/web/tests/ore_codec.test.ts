/**
 * ORE codec + instruction wire-format gates (directive Phase 1 / GATE 1).
 *
 * `instructions.ts` imports `config.ts`, which throws at module load when
 * `VITE_ORE_FEE_RECIPIENT` is unset (fail-loud fee policy). The stubbed
 * env + dynamic import below runs BEFORE that module evaluates, so the
 * production behavior is exercised, not bypassed.
 */

import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  decodeOreBoard,
  decodeOreConfig,
  decodeOreMiner,
  decodeOreRound,
  decodeOreTreasury,
  ORE_ACCOUNT_SIZES,
  ORE_DISCRIMINANTS,
  sumRoundDeployed,
  U64_MAX,
} from "../src/features/ore-lite/codec";

vi.stubEnv(
  "VITE_ORE_FEE_RECIPIENT",
  Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58(),
);
const {
  assertDeployMask,
  buildCheckpointIx,
  buildClaimOreIx,
  buildClaimSolIx,
  buildDeployIx,
  encodeClaimOreData,
  encodeDeployData,
} = await import("../src/features/ore-lite/instructions");
const { BOARD_ADDRESS, ORE_MINT_ADDRESS } = await import("../src/features/ore-lite/config");

// ── fixture builders (hand-packed steel layouts, §3.4) ─────────────────

function alloc(size: number, discriminator: number): Buffer {
  const buf = Buffer.alloc(size);
  buf.writeBigUInt64LE(BigInt(discriminator), 0);
  return buf;
}

function putU64(buf: Buffer, offset: number, value: bigint): void {
  buf.writeBigUInt64LE(value, offset);
}

function putKey(buf: Buffer, offset: number, key: PublicKey): void {
  key.toBuffer().copy(buf, offset);
}

/** Steel `Numeric` = I80F48 raw bits as a little-endian i128. */
function putI128(buf: Buffer, offset: number, bits: bigint): void {
  const u = BigInt.asUintN(128, bits);
  buf.writeBigUInt64LE(u & 0xffff_ffff_ffff_ffffn, offset);
  buf.writeBigUInt64LE(u >> 64n, offset + 8);
}

function readU64(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

function readU32(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
const otherKey = (seed: number): PublicKey => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;

function boardFixture(): Buffer {
  const buf = alloc(ORE_ACCOUNT_SIZES.board, ORE_DISCRIMINANTS.Board);
  putU64(buf, 8, 454_137n);
  putU64(buf, 16, 454_100_000n);
  putU64(buf, 24, 454_100_240n);
  putU64(buf, 32, 123_456_789n);
  return buf;
}

function configFixture(): Buffer {
  const buf = alloc(ORE_ACCOUNT_SIZES.config, ORE_DISCRIMINANTS.Config);
  putKey(buf, 8, otherKey(11));
  putKey(buf, 40, otherKey(12));
  putU64(buf, 72, 100n); // admin.fee_rate — live value
  putKey(buf, 80, otherKey(13));
  putKey(buf, 112, otherKey(14));
  putU64(buf, 144, 1000n); // protocol.fee_rate — live value
  putU64(buf, 152, 48n); // intermission_slots — live value
  putU64(buf, 160, 240n); // round_slots — live value
  putKey(buf, 168, otherKey(15));
  putKey(buf, 200, otherKey(16));
  return buf;
}

function treasuryFixture(): Buffer {
  const buf = alloc(ORE_ACCOUNT_SIZES.treasury, ORE_DISCRIMINANTS.Treasury);
  putU64(buf, 8, 123_456_789_012n);
  putI128(buf, 16, 3n * 2n ** 48n + 5n); // miner_rewards_factor (Numeric, I80F48 bits)
  putU64(buf, 32, 555n);
  putU64(buf, 40, 777n);
  return buf;
}

function minerFixture(): Buffer {
  const buf = alloc(ORE_ACCOUNT_SIZES.miner, ORE_DISCRIMINANTS.Miner);
  putKey(buf, 8, wallet);
  putU64(buf, 40, 1n); // auto_return
  putU64(buf, 48, 454_137n); // checkpoint_id
  putU64(buf, 56, 10_000n); // checkpoint_fee
  for (let i = 0; i < 25; i++) putU64(buf, 64 + i * 8, BigInt(i) * 100n); // deployed
  for (let i = 0; i < 25; i++) putU64(buf, 264 + i * 8, BigInt(i) * 7n); // mass
  for (let i = 0; i < 25; i++) putU64(buf, 464 + i * 8, BigInt(i) * 11n); // cumulative
  putU64(buf, 664, 454_136n); // round_id — STALE by one
  putI128(buf, 672, 2n * 2n ** 48n); // rewards_factor (Numeric, I80F48 bits)
  putU64(buf, 688, 987_654n); // rewards_sol
  putU64(buf, 696, 42n); // refined_ore
  putU64(buf, 704, 4242n); // rewards_ore
  buf.writeBigInt64LE(-5n, 712);
  buf.writeBigInt64LE(1_700_000_000n, 720);
  putU64(buf, 728, 99n);
  putU64(buf, 736, 88n);
  putU64(buf, 744, 77n);
  return buf;
}

function roundFixture(): Buffer {
  const buf = alloc(ORE_ACCOUNT_SIZES.round, ORE_DISCRIMINANTS.Round);
  putU64(buf, 8, 454_137n);
  for (let i = 0; i < 25; i++) putU64(buf, 16 + i * 8, BigInt(i) * 1_000_000n);
  for (let i = 0; i < 25; i++) putU64(buf, 216 + i * 8, BigInt(i) * 3n);
  for (let i = 0; i < 25; i++) putU64(buf, 416 + i * 8, BigInt(i) * 5n);
  buf.fill(0xee, 616, 648); // slot_hash
  putU64(buf, 648, 454_100_300n);
  putU64(buf, 656, 1_000_000_000n);
  putKey(buf, 664, otherKey(21));
  for (let i = 0; i < 25; i++) putU64(buf, 696 + i * 8, BigInt(i) * 13n);
  putU64(buf, 896, 25_000_000n);
  putU64(buf, 904, 24_000_000n);
  putU64(buf, 912, 640n);
  putKey(buf, 920, otherKey(22));
  return buf;
}

// ── R1: fixed-offset decoding, every field, every offset ───────────────

describe("ORE account decoders (steel/bytemuck, no Borsh)", () => {
  it("decodes Board at the documented offsets", () => {
    const board = decodeOreBoard(boardFixture());
    expect(board.roundId).toBe(454_137n);
    expect(board.startSlot).toBe(454_100_000n);
    expect(board.endSlot).toBe(454_100_240n);
    expect(board.productionCostEma).toBe(123_456_789n);
  });

  it("decodes Config and reproduces the live mainnet values (1%/10% fees, 48/240 slots)", () => {
    const config = decodeOreConfig(configFixture());
    expect(config.adminAuthority.equals(otherKey(11))).toBe(true);
    expect(config.adminFeeCollector.equals(otherKey(12))).toBe(true);
    expect(config.adminFeeRate).toBe(100n);
    expect(config.protocolAuthority.equals(otherKey(13))).toBe(true);
    expect(config.protocolFeeCollector.equals(otherKey(14))).toBe(true);
    expect(config.protocolFeeRate).toBe(1000n);
    expect(config.intermissionSlots).toBe(48n);
    expect(config.roundSlots).toBe(240n);
    expect(config.entropyVarAddress.equals(otherKey(15))).toBe(true);
    expect(config.entropyProgramId.equals(otherKey(16))).toBe(true);
  });

  it("decodes Treasury incl. the Numeric rewards factor as raw I80F48 bits", () => {
    const treasury = decodeOreTreasury(treasuryFixture());
    expect(treasury.minerRewardsFactor).toBe(3n * 2n ** 48n + 5n);
    expect(treasury.motherlode).toBe(123_456_789_012n);
    expect(treasury.totalRefined).toBe(555n);
    expect(treasury.totalUnclaimed).toBe(777n);
  });

  it("decodes Miner incl. the R3 `deployed` array and the R4 `round_id`", () => {
    const miner = decodeOreMiner(minerFixture());
    expect(miner.authority.equals(wallet)).toBe(true);
    expect(miner.rewardsFactor).toBe(2n * 2n ** 48n);
    expect(miner.autoReturn).toBe(1n);
    expect(miner.checkpointId).toBe(454_137n);
    expect(miner.checkpointFee).toBe(10_000n);
    expect(miner.deployed).toHaveLength(25);
    expect(miner.deployed[0]).toBe(0n);
    expect(miner.deployed[7]).toBe(700n);
    expect(miner.deployed[24]).toBe(2400n);
    expect(miner.mass[24]).toBe(168n);
    expect(miner.cumulative[24]).toBe(264n);
    expect(miner.roundId).toBe(454_136n);
    expect(miner.rewardsSol).toBe(987_654n);
    expect(miner.refinedOre).toBe(42n);
    expect(miner.rewardsOre).toBe(4242n);
    expect(miner.lastClaimOreAt).toBe(-5n);
    expect(miner.lastClaimSolAt).toBe(1_700_000_000n);
    expect(miner.lifetimeRewardsOre).toBe(99n);
    expect(miner.lifetimeDeployed).toBe(88n);
    expect(miner.lifetimeRewardsSol).toBe(77n);
  });

  it("decodes Round and sums the DEPLOYED headline", () => {
    const round = decodeOreRound(roundFixture());
    expect(round.id).toBe(454_137n);
    expect(round.deployed).toHaveLength(25);
    expect(round.deployed[3]).toBe(3_000_000n);
    expect(round.count[24]).toBe(120n);
    expect(round.slotHash).toEqual(Buffer.alloc(32, 0xee));
    expect(round.expiresAt).toBe(454_100_300n);
    expect(round.motherlode).toBe(1_000_000_000n);
    expect(round.rentPayer.equals(otherKey(21))).toBe(true);
    expect(round.rewards[24]).toBe(312n);
    expect(round.totalVaulted).toBe(25_000_000n);
    expect(round.totalReturnedSol).toBe(24_000_000n);
    expect(round.totalMiners).toBe(640n);
    expect(round.topMiner.equals(otherKey(22))).toBe(true);
    // sum(0..24 × 1e6) = 25·24/2 × 1e6 = 300e6
    expect(sumRoundDeployed(round)).toBe(300_000_000n);
  });

  it("treats u64::MAX end_slot as not-started (R6 sentinel survives decode)", () => {
    const buf = boardFixture();
    putU64(buf, 24, U64_MAX);
    expect(decodeOreBoard(buf).endSlot).toBe(U64_MAX);
  });

  it("every decoder rejects a wrong discriminator", () => {
    const cases: Array<[Buffer, (data: Buffer) => unknown]> = [
      [boardFixture(), decodeOreBoard],
      [configFixture(), decodeOreConfig],
      [treasuryFixture(), decodeOreTreasury],
      [minerFixture(), decodeOreMiner],
      [roundFixture(), decodeOreRound],
    ];
    for (const [fixture, decode] of cases) {
      const bad = Buffer.from(fixture);
      bad.writeUInt8(106, 0); // 106 is not a valid ORE discriminator
      expect(() => decode(bad), `${decode.name}`).toThrow(/discriminator/i);
    }
  });

  it("rejects buffers too short for the discriminator and the body", () => {
    expect(() => decodeOreBoard(Buffer.alloc(4))).toThrow(/too short/i);
    expect(() => decodeOreBoard(boardFixture().subarray(0, 20))).toThrow(/too short/i);
    expect(() => decodeOreMiner(minerFixture().subarray(0, 700))).toThrow(/too short/i);
  });
});

// ── instruction wire format (§3.2) ─────────────────────────────────────

describe("ORE instruction encoding", () => {
  it("Deploy data is exactly 13 bytes: disc 6 | amount u64 LE | squares u32 LE", () => {
    const data = encodeDeployData(601_562n, 0b101);
    expect(data).toHaveLength(13);
    expect(data[0]).toBe(6);
    expect(readU64(data, 1)).toBe(601_562n);
    expect(readU32(data, 9)).toBe(0b101);
  });

  it("Checkpoint data is exactly 1 byte with disc 2", () => {
    const ix = buildCheckpointIx({ signer: wallet, authority: wallet, minerRoundId: 454_136n });
    expect(ix.data).toHaveLength(1);
    expect(ix.data[0]).toBe(2);
  });

  it("ClaimSOL data is exactly 1 byte with disc 3", () => {
    const ix = buildClaimSolIx(wallet);
    expect(ix.data).toHaveLength(1);
    expect(ix.data[0]).toBe(3);
  });

  it("ClaimORE data is exactly 9 bytes: disc 4 | bps u64 LE", () => {
    const data = encodeClaimOreData(2_500n);
    expect(data).toHaveLength(9);
    expect(data[0]).toBe(4);
    expect(readU64(data, 1)).toBe(2_500n);
    expect(() => encodeClaimOreData(0n)).toThrow();
    expect(() => encodeClaimOreData(10_001n)).toThrow();
  });

  it("a full 25-square mask round-trips", () => {
    const data = encodeDeployData(1n, 0x01ff_ffff);
    expect(readU32(data, 9)).toBe(0x01ff_ffff);
    const ix = buildDeployIx({
      signer: wallet,
      authority: wallet,
      roundId: 454_137n,
      amountPerSquare: 1n,
      mask: 0x01ff_ffff,
    });
    expect(readU32(ix.data, 9)).toBe(0x01ff_ffff);
  });

  it("rejects masks with bits 25+ set, zero, negative, and non-integer masks", () => {
    expect(() => assertDeployMask(1 << 25)).toThrow(RangeError);
    expect(() => assertDeployMask(0xffff_ffff)).toThrow(RangeError);
    expect(() => assertDeployMask(0)).toThrow(RangeError);
    expect(() => assertDeployMask(-1)).toThrow(RangeError);
    expect(() => assertDeployMask(1.5)).toThrow(RangeError);
    expect(() => encodeDeployData(0n, 0b101)).toThrow(); // non-positive amount
  });

  it("builds ClaimORE with 11 metas", () => {
    const ix = buildClaimOreIx(wallet, 10_000n);
    expect(ix.keys).toHaveLength(11);
  });

  // Live mainnet claims mark BOARD writable (and MINT, for ClaimORE): the
  // program's self-CPI needs it, and a read-only BOARD failed every claim
  // with "Cross-program invocation with unauthorized signer or writable
  // account" (PrivilegeEscalation, 2026-10-08).
  it("claims pass BOARD writable, and ClaimORE passes MINT writable", () => {
    const writable = (ix: { keys: { pubkey: PublicKey; isWritable: boolean }[] }, key: PublicKey) =>
      ix.keys.find((k) => k.pubkey.equals(key))?.isWritable;
    const ore = buildClaimOreIx(wallet, 10_000n);
    expect(writable(buildClaimSolIx(wallet), BOARD_ADDRESS)).toBe(true);
    expect(writable(ore, BOARD_ADDRESS)).toBe(true);
    expect(writable(ore, ORE_MINT_ADDRESS)).toBe(true);
  });
});
