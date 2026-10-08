/**
 * ORE PDA derivation — PURE. Seeds per directive §3.1, all under the ORE
 * program id, numeric seeds little-endian.
 */

import { PublicKey } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ORE_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./config";

/** `["miner", authority]` — one per wallet. */
export function minerPda(authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("miner"), authority.toBuffer()],
    ORE_PROGRAM_ID,
  )[0];
}

/** `["round", id u64 LE]` — the round account PDA. */
export function roundPda(roundId: bigint): PublicKey {
  const seed = Buffer.alloc(8);
  seed.writeBigUInt64LE(roundId);
  return PublicKey.findProgramAddressSync([Buffer.from("round"), seed], ORE_PROGRAM_ID)[0];
}

/** `["automation", authority]` — passed to Deploy/Checkpoint even when absent. */
export function automationPda(authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("automation"), authority.toBuffer()],
    ORE_PROGRAM_ID,
  )[0];
}

/**
 * SPL associated token account for `(owner, mint)` under the standard ATA
 * scheme. Works for PDA owners (the ORE treasury) as well — the derivation
 * is the same `findProgramAddressSync`, only the on-curve assert differs.
 */
export function associatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}
