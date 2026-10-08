/**
 * POST /api/raffle/purchase — directive §6.4 (the manual buy path; the
 * ORB token-buy source was retired on 2026-10-07 by owner decision).
 *
 * The client sends { signature, wallet } only (R2). The server fetches
 * the FINALIZED transaction and sums every SystemProgram.transfer from
 * the claimed wallet to the raffle treasury; entries =
 * floor(transferred / ENTRY_PRICE_LAMPORTS) — the price and the count
 * are server-derived, never client-supplied (R1/R2).
 *
 * Entries are `confirmed` immediately (an SOL payment is irreversible;
 * there is no hold-through for purchases) and both R7 caps bind inside
 * the same locked award transaction:
 *   PURCHASE_CAP_PER_WALLET (25) and PURCHASE_CAP_SHARE_BPS (30%).
 *
 * R9: the unit is an ENTRY. The colloquial "ticket" never appears in
 * code — `ticket` is load-bearing vocabulary in the on-chain program.
 */

import type { RaffleConfig } from "../env";
import { loadConfig } from "../env";
import { raffleDb, type RaffleDb } from "../db";
import {
  currentOpenEpoch,
  EPOCH_CLOSED,
  entriesForSignature,
  postgrestRateLimiter,
  submitEarnedEvent,
  type EpochRef,
  type SubmitEarnedEventArgs,
} from "../store";
import {
  RATE_LIMITS,
  clientIp,
  enforceRateLimit,
  guardRequest,
  json,
  requireJsonObject,
  requirePubkeyString,
  requireSignatureString,
  type JsonResponse,
  type RaffleRequest,
  type RateLimiter,
} from "../http";
import { resolveKeys } from "../classify";
import { transactionFailed } from "./claim";
import bs58 from "bs58";

export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/**
 * AUDIT R-10: a purchase's ledger slot. Game and ORE events number from 0
 * in scan order; a purchase used 0 too, so a transaction carrying both
 * collided on (signature, event_index). Purchases live far above any
 * real event count (SMALLINT column).
 */
export const PURCHASE_EVENT_INDEX = 30_000;
const SYSTEM_TRANSFER_IX = 2; // u32 LE tag in the instruction data

export interface PurchaseStore {
  currentOpenEpoch(): Promise<EpochRef | null>;
  submitEarnedEvent(args: SubmitEarnedEventArgs): Promise<number>;
  /**
   * Entries this signature already earned (for `wallet` when given);
   * null if never counted.
   */
  entriesForSignature(signature: string, wallet?: string): Promise<number | null>;
}

export function postgrestPurchaseStore(db: RaffleDb): PurchaseStore {
  return {
    currentOpenEpoch: () => currentOpenEpoch(db),
    submitEarnedEvent: (args) => submitEarnedEvent(db, args),
    entriesForSignature: (signature, wallet) => entriesForSignature(db, signature, wallet),
  };
}

export interface PurchaseDeps {
  config: RaffleConfig;
  store: PurchaseStore;
  /** R2: fetch at finalized; null ⇒ not yet finalized / not found. */
  fetchTransaction(signature: string): Promise<any | null>;
  /** AUDIT R-9 — absent in tests that do not exercise it. */
  rateLimit?: RateLimiter;
}

export function defaultPurchaseDeps(config: RaffleConfig = loadConfig()): PurchaseDeps {
  const db = raffleDb(config);
  return {
    config,
    store: postgrestPurchaseStore(db),
    rateLimit: postgrestRateLimiter(db),
    fetchTransaction: (signature) => fetchFinalized(config, signature),
  };
}

async function fetchFinalized(config: RaffleConfig, signature: string): Promise<any | null> {
  const { Connection } = await import("@solana/web3.js");
  const connection = new Connection(config.solanaRpcUrl, { commitment: "finalized" });
  const { fetchFinalizedTransaction } = await import("./claim");
  return fetchFinalizedTransaction(connection, config, signature);
}

/**
 * Sums every SystemProgram.transfer(from → to) lamports in the
 * transaction. Handles BOTH instruction encodings: the raw json shape
 * (programIdIndex/programId + data base58 + account indices) and the
 * jsonParsed shape (programId + accounts as pubkeys), across the main
 * instructions and every inner instruction group.
 */
export function sumSystemTransfersTo(tx: any, from: string, to: string): bigint {
  const message = tx.transaction.message;
  const asKey = (k: any): string =>
    typeof k === "object" && k !== null && "pubkey" in k ? String(k.pubkey) : String(k);
  const keys: string[] = (message.accountKeys ?? message.staticAccountKeys ?? []).map(asKey);
  const loaded = tx.meta?.loadedAddresses;
  if (loaded) {
    keys.push(...(loaded.writable ?? []).map(asKey), ...(loaded.readonly ?? []).map(asKey));
  }

  const resolveKey = (account: any): string | null => {
    if (typeof account === "string") {
      return BASE58.test(account) && account.length >= 32 ? account : keys[Number(account)] ?? null;
    }
    if (typeof account === "number") return keys[account] ?? null;
    return null;
  };

  const programOf = (ix: any): string | null => {
    if (typeof ix.programId === "string") return ix.programId;
    if (typeof ix.programIdIndex === "number") return keys[ix.programIdIndex] ?? null;
    return null;
  };

  let total = 0n;
  const groups: any[] = [
    ...((message.instructions ?? []) as any[]),
    ...((tx.meta?.innerInstructions ?? []) as any[]).flatMap((g: any) => g.instructions ?? []),
  ];
  for (const ix of groups) {
    if (programOf(ix) !== SYSTEM_PROGRAM_ID) continue;

    // jsonParsed shape: { program: "system", parsed: { type: "transfer", info } }
    if (ix.parsed?.type === "transfer" && ix.parsed?.info) {
      const info = ix.parsed.info;
      if (info.source === from && info.destination === to) {
        total += BigInt(info.lamports ?? 0);
      }
      continue;
    }

    // Raw shape: data = u32 tag (2) ++ u64 lamports.
    if (typeof ix.data !== "string") continue;
    let data: Buffer;
    try {
      data = Buffer.from(bs58.decode(ix.data));
    } catch {
      continue;
    }
    if (data.length < 12 || data.readUInt32LE(0) !== SYSTEM_TRANSFER_IX) continue;
    const lamports = data.readBigUInt64LE(4);
    const accounts = ix.accounts ?? [];
    const src = resolveKey(accounts[0]);
    const dst = resolveKey(accounts[1]);
    if (src === from && dst === to) {
      total += lamports;
    }
  }
  return total;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function purchaseEndpoint(deps: PurchaseDeps) {
  return async function handlePurchase(req: RaffleRequest): Promise<JsonResponse> {
    guardRequest(req);
    const body = requireJsonObject(req.body);
    const signature = requireSignatureString(body, "signature");
    const wallet = requirePubkeyString(body, "wallet");
    await enforceRateLimit(deps.rateLimit, [
      { key: `ip:${clientIp(req)}`, max: RATE_LIMITS.perIpPerMinute },
      { key: `wallet:${wallet}`, max: RATE_LIMITS.perWalletPerMinute },
    ]);

    // AUDIT R-9: a repeat report of an already-credited purchase is
    // answered from the ledger, without paying for another RPC fetch.
    const known = await deps.store.entriesForSignature(signature, wallet);
    if (known !== null) {
      return json(200, { awarded: known, purchased: known, replay: true });
    }

    const tx = await deps.fetchTransaction(signature);
    if (tx === null || tx === undefined) {
      return json(202, { status: "pending" });
    }
    // AUDIT R-2: a failed transaction keeps its instructions in the
    // ledger but moved nothing except the fee. Never credit one.
    if (transactionFailed(tx)) {
      return json(200, { awarded: 0, reason: "transaction_failed" });
    }

    // R2 step 3: the claimed wallet must have signed.
    const { signers } = resolveKeys(tx);
    if (!signers.includes(wallet)) {
      return json(403, { error: "not_signer", message: "wallet is not a signer on the transaction" });
    }

    const transferred = sumSystemTransfersTo(tx, wallet, deps.config.raffleTreasuryPubkey);
    if (transferred <= 0n) {
      return json(200, { awarded: 0, reason: "no_purchase_found" });
    }

    // A repeat report (the buy card re-sends until it hears back, and a
    // reply can be lost) answers with what the first one earned. The
    // ledger's dedup would return a bare 0, which the card cannot tell
    // apart from "a ceiling refused it".
    const prior = await deps.store.entriesForSignature(signature);
    if (prior !== null) {
      return json(200, { awarded: prior, purchased: prior, replay: true });
    }

    const epoch = await deps.store.currentOpenEpoch();
    if (epoch === null) {
      return json(202, { status: "pending", reason: "no_open_epoch" });
    }

    // 1 entry per ENTRY_PRICE_LAMPORTS of cumulative transferred SOL;
    // partial payments carry (R5 semantics with the purchase price as
    // the unit). Both R7 caps bind inside raffle_award.
    const awarded = await deps.store.submitEarnedEvent({
      signature,
      eventIndex: PURCHASE_EVENT_INDEX,
      slot: Number(tx.slot),
      blockTime: isoTime(tx.blockTime),
      source: "purchase",
      wallet,
      epochId: epoch.id,
      solLamports: Number(transferred),
      lamportsPerEntry: deps.config.entryPriceLamports,
      referralMinLamports: deps.config.referralMinLamports,
      referralCap: deps.config.referralCapPerEpoch,
      entryStatus: "confirmed",
    });
    if (awarded === EPOCH_CLOSED) {
      // AUDIT R-11: the epoch locked between the lookup and the award.
      // Nothing was recorded; the card's next report lands in the next epoch.
      return json(202, { status: "pending", reason: "epoch_closed" });
    }

    return json(200, { awarded, purchased: awarded });
  };
}

function isoTime(blockTimeSeconds: number | undefined): string | null {
  if (blockTimeSeconds === undefined || blockTimeSeconds === null) return null;
  return new Date(blockTimeSeconds * 1000).toISOString();
}
