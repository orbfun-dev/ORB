/**
 * Shared plumbing for the local demo scripts (roadmap 7.5).
 *
 * Everything is deterministic: keypairs live under scripts/local-demo/keys
 * (generated once, git-ignored), the oracle pin and the randomness
 * account address are derived constants, and the entropy mirror below is
 * the TS twin of `entropy.rs`/`math/tickets.rs` — pure integer math, used
 * only to CHOOSE a fixture value whose outcome the runbook can promise
 * (the chain recomputes it; nothing here is trusted by the program).
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RPC_URL = process.env.DEMO_RPC_URL ?? "http://127.0.0.1:8899";

export const connection = new Connection(RPC_URL, "confirmed");

const KEYS_DIR = join(import.meta.dirname, "keys");

/** Deterministic demo pin for `config.oracle_program_id` (local stand-in). */
export const DEMO_ORACLE_PROGRAM_ID = PublicKey.findProgramAddressSync(
  [Buffer.from("demo_oracle")],
  PublicKey.default,
)[0];

/** Deterministic demo pin for `config.oracle_queue` (unused by the mock
 * settle path, but initialize refuses the default pubkey). */
export const DEMO_ORACLE_QUEUE_ID = PublicKey.findProgramAddressSync(
  [Buffer.from("demo_queue")],
  PublicKey.default,
)[0];

/** The genesis-preloaded randomness account address (any stable address). */
export const DEMO_RANDOMNESS_ID = PublicKey.findProgramAddressSync(
  [Buffer.from("demo_randomness", "ascii")],
  DEMO_ORACLE_PROGRAM_ID,
)[0];

/** The demo round is always id 0 — the fixture's authority is roundKey(0). */
export const DEMO_ROUND_ID = 0n;

/** The scripted bot deposits; the fixture value is chosen against this total. */
export const BOT_DEPOSITS_SOL = [1.0, 2.5, 4.0];
export const DEMO_TOTAL_LAMPORTS = BigInt(
  BOT_DEPOSITS_SOL.reduce((a, b) => a + b, 0) * LAMPORTS_PER_SOL,
);

export function loadOrGenerateKeypair(name: string): Keypair {
  if (!existsSync(KEYS_DIR)) mkdirSync(KEYS_DIR, { recursive: true });
  const file = join(KEYS_DIR, `${name}.json`);
  if (existsSync(file)) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]),
    );
  }
  const kp = Keypair.generate();
  writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

/** Airdrops (in ≤10 SOL chunks) until the wallet holds at least `sol`. */
export async function fundWallet(wallet: PublicKey, sol: number): Promise<void> {
  const target = sol * LAMPORTS_PER_SOL;
  for (let i = 0; i < 8; i += 1) {
    const balance = await connection.getBalance(wallet, "confirmed");
    if (balance >= target) return;
    const missing = target - balance;
    const request = Math.min(missing, 10 * LAMPORTS_PER_SOL);
    const sig = await connection.requestAirdrop(wallet, request);
    await confirm(sig);
  }
  throw new Error(`could not fund ${wallet.toBase58()} (faucet exhausted?)`);
}

export async function confirm(signature: string): Promise<void> {
  const outcome = await connection.confirmTransaction(signature, "confirmed");
  if (outcome.value.err !== null) {
    throw new Error(`tx failed: ${JSON.stringify(outcome.value.err)}`);
  }
}

export async function send(
  tx: Transaction,
  signers: Keypair[],
): Promise<string> {
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

// ── entropy mirror (pure display/fixture math — the chain is the authority) ──

/** `entropy.rs::split_entropy` — LE u128 halves of the 32-byte value. */
export function splitEntropy(value: Uint8Array): { ticket: bigint; mega: bigint } {
  const le = (bytes: Uint8Array): bigint => {
    let out = 0n;
    for (let i = bytes.length - 1; i >= 0; i -= 1) {
      out = (out << 8n) | BigInt(bytes[i]!);
    }
    return out;
  };
  return { ticket: le(value.subarray(0, 16)), mega: le(value.subarray(16, 32)) };
}

/** `math/tickets.rs::ticket_from_entropy` — entropy mod total. */
export function ticketFromEntropy(ticketEntropy: bigint, totalLamports: bigint): bigint {
  return ticketEntropy % totalLamports;
}

export const MEGA_TRIGGER_MODULUS = 6_767n;

export function megaTriggered(megaEntropy: bigint): boolean {
  return megaEntropy % MEGA_TRIGGER_MODULUS === 0n;
}

/**
 * Searches a deterministic fixture value such that, against the scripted
 * bot total: the Mega-Pot FIRES and the winning ticket lands inside
 * `winRange` ([start, end) lamports) — so the runbook can promise the
 * outcome and the browser demo always shows the celebration.
 */
export function findDemoFixtureValue(winRange: [bigint, bigint]): Uint8Array {
  const value = new Uint8Array(32);
  const megaSeed = MEGA_TRIGGER_MODULUS * 0x00dea_beefn; // any multiple fires
  for (let i = 0; i < 16 && i < 8; i += 1) {
    value[16 + i] = Number((megaSeed >> BigInt(8 * i)) & 0xffn);
  }
  // Deterministic ticket-half search: linear probes from a fixed base.
  const base = 0x5eed_0000_0000_0000_0000_0000_0000_0000n;
  for (let probe = 0n; probe < 5_000_000n; probe += 1) {
    const ticketSeed = base + probe;
    const ticket = ticketSeed % DEMO_TOTAL_LAMPORTS;
    if (ticket >= winRange[0] && ticket < winRange[1]) {
      for (let i = 0; i < 16; i += 1) {
        value[i] = Number((ticketSeed >> BigInt(8 * i)) & 0xffn);
      }
      // Sanity: the mirror must fire the mega AND land the ticket.
      const halves = splitEntropy(value);
      if (!megaTriggered(halves.mega)) throw new Error("fixture mega math broken");
      if (ticketFromEntropy(halves.ticket, DEMO_TOTAL_LAMPORTS) !== ticket) {
        throw new Error("fixture ticket math broken");
      }
      return value;
    }
  }
  throw new Error("no fixture value found (impossible for a non-empty range)");
}
