/**
 * ORE account decoders (R1).
 *
 * ORE is a `steel`/bytemuck program, NOT Anchor: account data is an 8-byte
 * little-endian u64 discriminator followed by a `#[repr(C)]` POD struct —
 * no Borsh, no length prefixes, no option tags. Every field is read at the
 * fixed offsets documented in the integration directive §3.4 (layouts
 * verified against ore commit 48c203b and live mainnet accounts).
 *
 * This module is PURE: no React, no Connection, no app imports.
 */

import { PublicKey } from "@solana/web3.js";

/** Steel `AccountDiscriminator` values (u64 LE at offset 0). */
export const ORE_DISCRIMINANTS = {
  Automation: 100,
  Config: 101,
  Miner: 103,
  Treasury: 104,
  Board: 105,
  Round: 109,
} as const;

/** Total account sizes incl. the 8-byte discriminator (§3.4). */
export const ORE_ACCOUNT_SIZES = {
  board: 40,
  config: 232,
  treasury: 48,
  miner: 752,
  round: 952,
  automation: 160,
} as const;

export const U64_MAX = 18_446_744_073_709_551_615n;

/** Thrown when account data does not match the expected ORE layout. */
export class OreCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OreCodecError";
  }
}

export interface OreBoard {
  roundId: bigint;
  startSlot: bigint;
  /** `U64_MAX` ⇒ the round has not started yet (R6). */
  endSlot: bigint;
  /** Lamports per whole ORE. */
  productionCostEma: bigint;
}

export interface OreConfig {
  adminAuthority: PublicKey;
  adminFeeCollector: PublicKey;
  adminFeeRate: bigint;
  protocolAuthority: PublicKey;
  protocolFeeCollector: PublicKey;
  protocolFeeRate: bigint;
  intermissionSlots: bigint;
  roundSlots: bigint;
  entropyVarAddress: PublicKey;
  entropyProgramId: PublicKey;
}

export interface OreTreasury {
  /** ORE grams (11 decimals). */
  motherlode: bigint;
  /** Steel `Numeric` (I80F48) raw bits: value = bits / 2^48. Refining fees
   *  accrue to unrefined holders through this (rewards.ts). */
  minerRewardsFactor: bigint;
  totalRefined: bigint;
  totalUnclaimed: bigint;
}

export interface OreMiner {
  authority: PublicKey;
  autoReturn: bigint;
  checkpointId: bigint;
  checkpointFee: bigint;
  /** Per-square lamports deployed this round — R3 reads this. */
  deployed: readonly bigint[];
  mass: readonly bigint[];
  cumulative: readonly bigint[];
  /** The round the miner account is parked on — R4 reads this. */
  roundId: bigint;
  /** I80F48 raw bits of the treasury factor at the miner's last sync. */
  rewardsFactor: bigint;
  rewardsSol: bigint;
  refinedOre: bigint;
  rewardsOre: bigint;
  lastClaimOreAt: bigint;
  lastClaimSolAt: bigint;
  lifetimeRewardsOre: bigint;
  lifetimeDeployed: bigint;
  lifetimeRewardsSol: bigint;
}

export interface OreRound {
  id: bigint;
  /** Per-square lamports; `sum()` of this is the DEPLOYED headline. */
  deployed: readonly bigint[];
  mass: readonly bigint[];
  count: readonly bigint[];
  /** Entropy; all-zero ⇒ round unresolved. */
  slotHash: Uint8Array;
  expiresAt: bigint;
  motherlode: bigint;
  rentPayer: PublicKey;
  rewards: readonly bigint[];
  totalVaulted: bigint;
  totalReturnedSol: bigint;
  totalMiners: bigint;
  topMiner: PublicKey;
}

export interface OreAutomation {
  /** Lamports per square per round (`Preferred` ignores instruction data). */
  amount: bigint;
  authority: PublicKey;
  /** Accounting field — deployable lamports, NOT the account's lamports. */
  balance: bigint;
  executor: PublicKey;
  /** Flat lamports per round (bps iff strategy === 3). */
  fee: bigint;
  strategy: bigint;
  mask: bigint;
  reload: bigint;
  totalSolSpent: bigint;
  /** ORE grams (11 decimals). */
  totalOreEarned: bigint;
  /** Raw 24-byte `AutomationConditions` — see encodeAutomationConditions. */
  conditions: Uint8Array;
}

// ── primitive readers (little-endian, fixed offsets) ──────────────────

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function readDiscriminator(data: Uint8Array): bigint {
  if (data.byteLength < 8) {
    throw new OreCodecError(`account too short for a discriminator: ${data.byteLength} bytes`);
  }
  return viewOf(data).getBigUint64(0, true);
}

function expectDiscriminator(data: Uint8Array, expected: number, account: string): void {
  const actual = readDiscriminator(data);
  if (actual !== BigInt(expected)) {
    throw new OreCodecError(
      `${account}: wrong discriminator — expected ${expected}, got ${actual} ` +
        `(is this really an ORE ${account} account?)`,
    );
  }
}

function expectSize(data: Uint8Array, expected: number, account: string): void {
  if (data.byteLength < expected) {
    throw new OreCodecError(
      `${account}: account too short — expected >= ${expected} bytes, got ${data.byteLength}`,
    );
  }
}

function readU64(data: Uint8Array, offset: number): bigint {
  return viewOf(data).getBigUint64(offset, true);
}

function readI64(data: Uint8Array, offset: number): bigint {
  return viewOf(data).getBigInt64(offset, true);
}

/** Steel `Numeric` — I80F48 stored as its raw little-endian i128 bits. */
function readI128(data: Uint8Array, offset: number): bigint {
  const view = viewOf(data);
  const low = view.getBigUint64(offset, true);
  const high = view.getBigInt64(offset + 8, true);
  return (high << 64n) | low;
}

function readU64Array(data: Uint8Array, offset: number, length: number): bigint[] {
  const out = new Array<bigint>(length);
  for (let i = 0; i < length; i++) out[i] = readU64(data, offset + i * 8);
  return out;
}

function readPubkey(data: Uint8Array, offset: number): PublicKey {
  // PublicKey copies the bytes; the subarray view never escapes.
  return new PublicKey(data.subarray(offset, offset + 32));
}

// ── decoders ───────────────────────────────────────────────────────────

export function decodeOreBoard(data: Uint8Array): OreBoard {
  expectDiscriminator(data, ORE_DISCRIMINANTS.Board, "Board");
  expectSize(data, ORE_ACCOUNT_SIZES.board, "Board");
  return {
    roundId: readU64(data, 8),
    startSlot: readU64(data, 16),
    endSlot: readU64(data, 24),
    productionCostEma: readU64(data, 32),
  };
}

export function decodeOreConfig(data: Uint8Array): OreConfig {
  expectDiscriminator(data, ORE_DISCRIMINANTS.Config, "Config");
  expectSize(data, ORE_ACCOUNT_SIZES.config, "Config");
  return {
    adminAuthority: readPubkey(data, 8),
    adminFeeCollector: readPubkey(data, 40),
    adminFeeRate: readU64(data, 72),
    protocolAuthority: readPubkey(data, 80),
    protocolFeeCollector: readPubkey(data, 112),
    protocolFeeRate: readU64(data, 144),
    intermissionSlots: readU64(data, 152),
    roundSlots: readU64(data, 160),
    entropyVarAddress: readPubkey(data, 168),
    entropyProgramId: readPubkey(data, 200),
  };
}

export function decodeOreTreasury(data: Uint8Array): OreTreasury {
  expectDiscriminator(data, ORE_DISCRIMINANTS.Treasury, "Treasury");
  expectSize(data, ORE_ACCOUNT_SIZES.treasury, "Treasury");
  return {
    motherlode: readU64(data, 8),
    minerRewardsFactor: readI128(data, 16),
    totalRefined: readU64(data, 32),
    totalUnclaimed: readU64(data, 40),
  };
}

export function decodeOreMiner(data: Uint8Array): OreMiner {
  expectDiscriminator(data, ORE_DISCRIMINANTS.Miner, "Miner");
  expectSize(data, ORE_ACCOUNT_SIZES.miner, "Miner");
  return {
    authority: readPubkey(data, 8),
    autoReturn: readU64(data, 40),
    checkpointId: readU64(data, 48),
    checkpointFee: readU64(data, 56),
    deployed: readU64Array(data, 64, 25),
    mass: readU64Array(data, 264, 25),
    cumulative: readU64Array(data, 464, 25),
    roundId: readU64(data, 664),
    rewardsFactor: readI128(data, 672),
    rewardsSol: readU64(data, 688),
    refinedOre: readU64(data, 696),
    rewardsOre: readU64(data, 704),
    lastClaimOreAt: readI64(data, 712),
    lastClaimSolAt: readI64(data, 720),
    lifetimeRewardsOre: readU64(data, 728),
    lifetimeDeployed: readU64(data, 736),
    lifetimeRewardsSol: readU64(data, 744),
  };
}

export function decodeOreRound(data: Uint8Array): OreRound {
  expectDiscriminator(data, ORE_DISCRIMINANTS.Round, "Round");
  expectSize(data, ORE_ACCOUNT_SIZES.round, "Round");
  return {
    id: readU64(data, 8),
    deployed: readU64Array(data, 16, 25),
    mass: readU64Array(data, 216, 25),
    count: readU64Array(data, 416, 25),
    slotHash: data.slice(616, 648),
    expiresAt: readU64(data, 648),
    motherlode: readU64(data, 656),
    rentPayer: readPubkey(data, 664),
    rewards: readU64Array(data, 696, 25),
    totalVaulted: readU64(data, 896),
    totalReturnedSol: readU64(data, 904),
    totalMiners: readU64(data, 912),
    topMiner: readPubkey(data, 920),
  };
}

/** Layout verified field-by-field against a live mainnet Automation account
 *  (auto-join directive §3.3). `conditions` rides as raw bytes — the only
 *  on-chain consumer is the motherlode gate in deploy.rs. */
export function decodeOreAutomation(data: Uint8Array): OreAutomation {
  expectDiscriminator(data, ORE_DISCRIMINANTS.Automation, "Automation");
  expectSize(data, ORE_ACCOUNT_SIZES.automation, "Automation");
  return {
    amount: readU64(data, 8),
    authority: readPubkey(data, 16),
    balance: readU64(data, 48),
    executor: readPubkey(data, 56),
    fee: readU64(data, 88),
    strategy: readU64(data, 96),
    mask: readU64(data, 104),
    reload: readU64(data, 112),
    totalSolSpent: readU64(data, 120),
    totalOreEarned: readU64(data, 128),
    conditions: data.slice(136, 160),
  };
}

/** `sum(round.deployed)` — the DEPLOYED headline, in integer math. */
export function sumRoundDeployed(round: OreRound): bigint {
  let total = 0n;
  for (const v of round.deployed) total += v;
  return total;
}
