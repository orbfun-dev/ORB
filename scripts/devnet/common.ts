/**
 * Shared plumbing for the devnet ops scripts (phase 8.3): connection,
 * the deployer wallet, durable helper keypairs, and a send/confirm helper
 * that prints explorer links. Everything targets Solana Devnet and the
 * LIVE Switchboard On-Demand deployment verified in phase 8.0.
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

/** Public devnet RPC by default; override with DEVNET_RPC_URL. */
export const DEVNET_RPC_URL = (
  process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com"
).trim();

export const connection = new Connection(DEVNET_RPC_URL, "confirmed");

/** LIVE Switchboard On-Demand artifacts (verified on-chain, phase 8.0). */
export const SB_DEVNET_PROGRAM_ID = new PublicKey(
  "Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2",
);
export const SB_DEVNET_QUEUE = new PublicKey(
  "EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7",
);

const KEYS_DIR = join(import.meta.dirname, "keys");

/**
 * Durable per-purpose keypairs for the devnet deployment (gitignored).
 * Names are script-controlled literals; separators and traversal segments
 * are refused outright so the resolved path stays inside KEYS_DIR.
 */
export function loadOrGenerateKeypair(name: string): Keypair {
  if (name.includes("/") || name.includes(sep) || name.includes("\\") || name.includes("..")) {
    throw new Error(`illegal keypair name ${name}`);
  }
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

/**
 * The deployer/admin wallet: `~/.config/solana/vaulted-admin.json`, fixed —
 * the deployment's upgrade authority and config admin. No env-driven paths.
 */
export function loadAdmin(): Keypair {
  const path = join(homedir(), ".config", "solana", "vaulted-admin.json");
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]),
  );
}

export function explorer(signatureOrKey: string, kind: "tx" | "address" = "tx"): string {
  return `https://explorer.solana.com/${kind}/${signatureOrKey}?cluster=devnet`;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Public devnet RPC rate-limits aggressively (429). Retries the call with
 * linear backoff when it sees one; rethrows anything else.
 */
export async function withRetry<T>(op: () => Promise<T>, label = "rpc"): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      lastError = err;
      const text = String(err);
      if (!/429|Too many requests/i.test(text)) throw err;
      await sleep(attempt * 1_200);
    }
  }
  throw new Error(`${label} failed after retries (last: ${String(lastError).slice(0, 160)})`);
}

export async function confirm(signature: string): Promise<void> {
  const outcome = await withRetry(
    () => connection.confirmTransaction(signature, "confirmed"),
    `confirm ${signature.slice(0, 8)}`,
  );
  if (outcome.value.err !== null) {
    throw new Error(`tx failed: ${JSON.stringify(outcome.value.err)} — ${explorer(signature)}`);
  }
}

/** Signs, sends (429-retried), confirms, prints an explorer link. */
export async function send(
  tx: Transaction,
  signers: Keypair[],
  label = "tx",
): Promise<string> {
  const blockhash = await withRetry(() => connection.getLatestBlockhash("confirmed"), "blockhash");
  tx.recentBlockhash = blockhash.blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const raw = tx.serialize();
  // Re-sending an identical raw tx is idempotent by signature, so retrying
  // through 429s is safe.
  const sig = await withRetry(
    () => connection.sendRawTransaction(raw, { maxRetries: 10 }),
    `send ${label}`,
  );
  await confirm(sig);
  await sleep(400); // stay under the public RPC rate ceiling
  console.log(`${label}: ${sig}`);
  console.log(`  ${explorer(sig)}`);
  return sig;
}

/** Funds `wallet` from the admin by direct transfer (devnet airdrop is rate-limited). */
export async function fundFromAdmin(
  admin: Keypair,
  wallet: PublicKey,
  sol: number,
): Promise<void> {
  const target = sol * LAMPORTS_PER_SOL;
  const balance = await withRetry(
    () => connection.getBalance(wallet, "confirmed"),
    "getBalance",
  );
  if (balance >= target) return;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: wallet,
      lamports: target - balance,
    }),
  );
  await send(tx, [admin], `fund ${wallet.toBase58().slice(0, 8)}…`);
}

/**
 * Guards outbound oracle-gateway requests (they carry chain-derived data):
 * https only, and never localhost / loopback / private / reserved hosts.
 */
export function assertSafeGatewayUrl(raw: string): void {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error(`gateway url must be https, got ${raw}`);
  }
  const host = url.hostname;
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (ip !== null &&
      (ip[1]! === "10" ||
        ip[1]! === "127" ||
        ip[1]! === "0" ||
        (ip[1]! === "172" && Number(ip[2]) >= 16 && Number(ip[2]) <= 31) ||
        (ip[1]! === "192" && ip[2]! === "168") ||
        (ip[1]! === "169" && ip[2]! === "254")))
  ) {
    throw new Error(`gateway host ${host} is private/reserved — refusing`);
  }
}
