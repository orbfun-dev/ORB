/**
 * Keeper identity loading. Exactly one source, in this priority:
 *
 *   CRANK_KEYPAIR_BASE58 — the raw 64-byte secret key, base58-encoded
 *   CRANK_KEYPAIR_PATH   — a solana-cli JSON keypair file (chmod 600)
 *
 * The secret never touches the logs — only the derived public key does.
 * A group/world-readable keypair file logs a warning (best-effort check;
 * container runtimes may not expose meaningful modes).
 */

import { Keypair } from "@solana/web3.js";
import { readFileSync, statSync } from "node:fs";
import bs58 from "bs58";
import type { Logger } from "./log";

export interface KeeperIdentity {
  keypair: Keypair;
  /** Provenance for audit lines: "base58" | "file:<path>" */
  source: string;
}

export interface KeeperSources {
  keypairPath?: string;
  keypairBase58?: string;
}

export function loadKeeper(sources: KeeperSources, logger?: Logger): KeeperIdentity {
  if (sources.keypairBase58 !== undefined) {
    const secret = bs58.decode(sources.keypairBase58.trim());
    // fromSecretKey validates the 64-byte Ed25519 secret length.
    return { keypair: Keypair.fromSecretKey(secret), source: "base58" };
  }
  const path = sources.keypairPath;
  if (path !== undefined) {
    try {
      const mode = statSync(path).mode;
      if ((mode & 0o077) !== 0) {
        logger?.warn({ path, mode: (mode & 0o777).toString(8) }, "keeper keypair file is group/world accessible — chmod 600 advised");
      }
    } catch {
      // stat failure here just means the read below will produce the real error
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`keeper keypair file ${path} is not valid JSON: ${String(err)}`);
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)
    ) {
      throw new Error(
        `keeper keypair file ${path} is not a solana-cli keypair (expected a JSON array of 64 bytes)`,
      );
    }
    return {
      keypair: Keypair.fromSecretKey(Uint8Array.from(parsed as number[])),
      source: `file:${path}`,
    };
  }
  throw new Error(
    "no keeper identity: set CRANK_KEYPAIR_PATH (solana-cli JSON file) or CRANK_KEYPAIR_BASE58 (64-byte secret, base58)",
  );
}
