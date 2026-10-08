/**
 * POST /api/raffle/referral — directive §6.3.
 *
 * Binds attribution ONCE: first touch wins and is immutable. The bonus
 * entry itself is awarded later, inside the locked transaction of the
 * referee's FIRST qualifying event (raffle_maybe_award_referral), only
 * when that event is ≥ REFERRAL_MIN_LAMPORTS and the referrer is under
 * REFERRAL_CAP_PER_EPOCH (SQL GUC defaults mirror the env config).
 *
 * The lazy-sybil guard (§6.3): the referee's or referrer's FIRST funder
 * being the other party rejects the binding — one
 * getSignaturesForAddress lookback at bind time.
 */

import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";
import { referralConsentMessage } from "../../sdk/src/index";
import type { RaffleConfig } from "./env";
import { loadConfig } from "./env";
import { raffleDb, type RaffleDb } from "./db";
import {
  RATE_LIMITS,
  clientIp,
  enforceRateLimit,
  guardRequest,
  json,
  requireJsonObject,
  requirePubkeyString,
  type JsonResponse,
  type RaffleRequest,
  type RateLimiter,
} from "./http";
import { bindReferral, postgrestRateLimiter } from "./store";

export interface ReferralStore {
  bindReferral(wallet: string, ref: string): Promise<"bound" | "already_bound">;
}

export function postgrestReferralStore(db: RaffleDb): ReferralStore {
  return { bindReferral: (wallet, ref) => bindReferral(db, wallet, ref) };
}

export interface ReferralDeps {
  config: RaffleConfig;
  store: ReferralStore;
  /**
   * The wallet that funded `of` first (its first inbound System
   * transfer's source), or null when unknown. Defaults to the real
   * chain lookback; tests inject the sybil graph.
   */
  firstFunder(of: string): Promise<string | null>;
  /** Clock override for tests. */
  nowMs?(): number;
  /** AUDIT R-9 — absent in tests that do not exercise it. */
  rateLimit?: RateLimiter;
}

export function defaultReferralDeps(config: RaffleConfig = loadConfig()): ReferralDeps {
  const db = raffleDb(config);
  return {
    config,
    store: postgrestReferralStore(db),
    firstFunder: (of) => chainFirstFunder(config, db, of),
    rateLimit: postgrestRateLimiter(db),
  };
}

/** How long a signed referral consent stays valid (AUDIT R-3). */
export const REFERRAL_SIGNATURE_WINDOW_MS = 10 * 60 * 1000;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Ed25519 verification with Node's built-in crypto — no extra dependency. */
export function verifyWalletSignature(wallet: string, message: string, signatureB64: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(bs58.decode(wallet))]),
      format: "der",
      type: "spki",
    });
    const sig = Buffer.from(signatureB64, "base64");
    if (sig.length !== 64) return false;
    return verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}

export function referralEndpoint(deps: ReferralDeps) {
  return async function handleReferral(req: RaffleRequest): Promise<JsonResponse> {
    guardRequest(req);
    const body = requireJsonObject(req.body);
    const wallet = requirePubkeyString(body, "wallet");
    const ref = requirePubkeyString(body, "ref");

    if (wallet === ref) {
      return json(400, { error: "self_referral", message: "a wallet cannot refer itself" });
    }

    // AUDIT R-3: only the wallet's owner may bind it. Without this anyone
    // could pre-bind every fresh wallet to their own referrers, forever
    // (first touch is immutable).
    const issuedAt = typeof body.issuedAt === "string" ? body.issuedAt : "";
    const signature = typeof body.signature === "string" ? body.signature : "";
    const issuedMs = Date.parse(issuedAt);
    if (issuedAt === "" || signature === "" || Number.isNaN(issuedMs)) {
      return json(401, { error: "signature_required", message: "sign the referral consent with the wallet" });
    }
    if (Math.abs((deps.nowMs?.() ?? Date.now()) - issuedMs) > REFERRAL_SIGNATURE_WINDOW_MS) {
      return json(401, { error: "signature_expired", message: "the referral consent is too old — sign again" });
    }
    if (!verifyWalletSignature(wallet, referralConsentMessage(wallet, ref, issuedAt), signature)) {
      return json(401, { error: "bad_signature", message: "the signature does not match the wallet" });
    }

    // AUDIT R-9: the funding lookback below costs up to a dozen RPC calls.
    await enforceRateLimit(deps.rateLimit, [
      { key: `ip:${clientIp(req)}`, max: RATE_LIMITS.perIpPerMinute },
      { key: `referral:${wallet}`, max: RATE_LIMITS.referralPerWalletPerMinute },
    ]);

    // One-hop funding guard, both directions (§6.3).
    for (const [subject, other] of [
      [wallet, ref],
      [ref, wallet],
    ] as const) {
      const funder = await deps.firstFunder(subject);
      if (funder !== null && funder === other) {
        return json(422, {
          error: "funding_link",
          message: `the first funder of ${subject} is ${other} — lazy sybil rejected`,
        });
      }
    }

    const result = await deps.store.bindReferral(wallet, ref);
    return json(200, { status: result });
  };
}

/**
 * §6.3 — the one-hop lookback: the wallet's earliest available inbound
 * System transfer. "Rare path, do not optimise": signature history for a
 * fresh wallet is short; 20 signatures covers the funding moment.
 */
export async function chainFirstFunder(
  config: RaffleConfig,
  _db: RaffleDb,
  of: string,
): Promise<string | null> {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const connection = new Connection(config.solanaRpcUrl, { commitment: "finalized" });  const signatures = await connection.getSignaturesForAddress(new PublicKey(of), {
    limit: 20,
  }, "finalized");
  if (signatures.length === 0) return null;

  // Newest-first; the funding moment is the OLDEST transaction.
  const oldest = signatures.slice(-5);
  let firstFunder: string | null = null;
  for (const sigInfo of oldest.reverse()) {
    const tx = await connection.getTransaction(sigInfo.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    // `tx.meta?.err` alone lets a null meta through, and the balance
    // reads below would then throw on it.
    if (tx === null || tx.meta === null || tx.meta.err) continue;
    const index = indexOfWallet(tx, of);
    if (index === -1) continue;
    const delta =
      BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index]);
    const isFeePayer = index === 0;
    if (delta > (isFeePayer ? 0n : BigInt(tx.meta.fee))) {
      // Inbound lamports: the funder is the signer who lost the most.
      firstFunder = largestPayer(tx, index);
      break;
    }
  }
  return firstFunder;
}

function indexOfWallet(tx: any, wallet: string): number {
  const keys = tx.transaction.message.accountKeys ?? tx.transaction.message.staticAccountKeys ?? [];
  return keys.findIndex((k: any) => (typeof k === "object" ? k.pubkey : k) === wallet);
}

function largestPayer(tx: any, recipientIndex: number): string | null {
  const keys = tx.transaction.message.accountKeys ?? tx.transaction.message.staticAccountKeys ?? [];
  let best: { pubkey: string; paid: bigint } | null = null;
  for (let i = 0; i < keys.length; i++) {
    if (i === recipientIndex) continue;
    const paid = BigInt(tx.meta.preBalances[i]) - BigInt(tx.meta.postBalances[i]);
    if (paid > 0n && (best === null || paid > best.paid)) {
      const k = keys[i];
      best = { pubkey: typeof k === "object" ? k.pubkey : k, paid };
    }
  }
  return best?.pubkey ?? null;
}
