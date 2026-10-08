/**
 * PDA derivation — the single TS source of truth for every seed the
 * program uses (roadmap 6.1). All integers are little-endian, matching
 * `constants.rs` exactly; a typo'd seed is a silently different address,
 * so the seed literals here must never drift from the Rust side.
 */

import { PublicKey } from "@solana/web3.js";

/** The devnet deployment (default build of `declare_id!` in `lib.rs`). */
export const DEVNET_PROGRAM_ID = new PublicKey(
  "G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R",
);
/** The mainnet deployment (`anchor build -- --features mainnet`). */
export const MAINNET_PROGRAM_ID = new PublicKey(
  "ETMqujXHndqa3SfGHFhNMPwb4w43NhV96Majv3xbC3bH",
);

export type OrbCluster = "devnet" | "mainnet";

/**
 * Which deployment this build talks to. Unset means devnet, so nothing
 * changes unless a deployment opts in. A typo throws instead of silently
 * pointing real money at the wrong program.
 */
export function resolveCluster(raw: string | undefined): OrbCluster {
  const value = raw?.trim() ?? "";
  if (value === "" || value === "devnet") return "devnet";
  if (value === "mainnet" || value === "mainnet-beta") return "mainnet";
  throw new Error(`ORB_CLUSTER must be "devnet" or "mainnet", got "${value}"`);
}

function configuredCluster(): string | undefined {
  // Node (crank, scripts): the real environment. Browser: Vite replaces
  // this exact expression with VITE_ORB_CLUSTER at build time
  // (apps/web/vite.config.ts `define`), so `process` is never touched.
  try {
    return process.env.ORB_CLUSTER;
  } catch {
    return undefined;
  }
}

export const ORB_CLUSTER: OrbCluster = resolveCluster(configuredCluster());

/** The deployed program id for `ORB_CLUSTER` (matches its `declare_id!`). */
export const PROGRAM_ID =
  ORB_CLUSTER === "mainnet" ? MAINNET_PROGRAM_ID : DEVNET_PROGRAM_ID;

export const CONFIG_SEED = Buffer.from("config") as Buffer;
export const TREASURY_SEED = Buffer.from("treasury") as Buffer;
export const MEGA_POT_SEED = Buffer.from("mega_pot") as Buffer;
export const ROUND_SEED = Buffer.from("round") as Buffer;
export const ROUND_VAULT_SEED = Buffer.from("round_vault") as Buffer;
export const ENTRY_SEED = Buffer.from("entry") as Buffer;
/** `PlayerEscrow = ["escrow", owner]` — one escrow per wallet (Phase 10). */
/** `EntropyChain` = ["entropy_chain"], singleton (randomness fallback). */
export const ENTROPY_CHAIN_SEED = Buffer.from("entropy_chain") as Buffer;
export const ESCROW_SEED = Buffer.from("escrow") as Buffer;

/** Little-endian u64 (round ids are `u64` on-chain). */
export function u64Le(value: bigint | number): Buffer {
  let v = BigInt(value);
  const buf = Buffer.alloc(8);
  for (let i = 0; i < 8; i += 1) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

/** Little-endian u16 (bps fields are `u16` on-chain). */
export function u16Le(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value >>> 0, 0);
  return buf;
}

/** Little-endian u32 (entry indices are `u32` on-chain). */
export function u32Le(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function pda(seeds: readonly Buffer[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([...seeds], PROGRAM_ID);
}

export function configKey(): PublicKey {
  return pda([CONFIG_SEED])[0];
}

export function treasuryKey(): PublicKey {
  return pda([TREASURY_SEED])[0];
}

export function megaPotKey(): PublicKey {
  return pda([MEGA_POT_SEED])[0];
}

export function roundKey(roundId: bigint | number): PublicKey {
  return pda([ROUND_SEED, u64Le(roundId)])[0];
}

export function roundVaultKey(roundId: bigint | number): PublicKey {
  return pda([ROUND_VAULT_SEED, u64Le(roundId)])[0];
}

export function entryKey(
  roundId: bigint | number,
  entryIndex: number,
): PublicKey {
  return pda([ENTRY_SEED, u64Le(roundId), u32Le(entryIndex)])[0];
}

/** The owner's `PlayerEscrow` PDA (seed contains the owner — no nonce). */
export function escrowKey(owner: PublicKey): PublicKey {
  return pda([ESCROW_SEED, owner.toBuffer()])[0];
}

/** Anchor's `#[event_cpi]` authority PDA. */
export function entropyChainKey(): PublicKey {
  return PublicKey.findProgramAddressSync([ENTROPY_CHAIN_SEED], PROGRAM_ID)[0];
}

export function eventAuthorityKey(): PublicKey {
  return pda([Buffer.from("__event_authority")])[0];
}

/**
 * AUDIT R-3: the text a wallet signs to consent to a raffle referral.
 * Built here so the web app (which signs) and the raffle server (which
 * verifies) can never drift apart. The server accepts a signature only
 * within a short window of `issuedAt`.
 */
export function referralConsentMessage(wallet: string, referrer: string, issuedAt: string): string {
  return [
    "playorb raffle referral",
    `wallet: ${wallet}`,
    `referrer: ${referrer}`,
    `issued: ${issuedAt}`,
  ].join("\n");
}
