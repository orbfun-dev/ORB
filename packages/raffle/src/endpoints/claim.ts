/**
 * POST /api/raffle/claim — directive §6.1.
 *
 * The single entry point for both earned sources. The client sends
 * { signature, wallet } and NOTHING else that matters (R2): the server
 * fetches the transaction at `finalized` commitment and derives wallet,
 * program, amount and round from the chain.
 *
 * ORB-game awards are deferred (R3, §6.1.1): the round must have reached
 * `settled` in the raffle_orb_rounds cache; a `cancelled` round awards
 * nothing, ever; an unresolved round answers 202 pending.
 * ORE deploys are NOT awarded here (owner decision, 2026-10-08): only
 * deploys made through playorb earn, and the fee-wallet indexer
 * (ore-indexer.ts) is what finds those. A claim for one answers 200 with
 * `ore_deploys_are_indexed`. Manual purchases use the separate
 * /api/raffle/purchase endpoint.
 */

import { Connection } from "@solana/web3.js";
import type { RaffleConfig } from "../env";
import { loadConfig } from "../env";
import { raffleDb, type RaffleDb } from "../db";
import {
  HttpError,
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
import { classifyTransaction } from "../classify";
import {
  EPOCH_CLOSED,
  currentOpenEpoch,
  getOrbRound,
  postgrestRateLimiter,
  submitEarnedEvent,
  type EpochRef,
  type OrbRoundRow,
  type SubmitEarnedEventArgs,
} from "../store";

/**
 * The three database operations a claim needs, behind one interface:
 * production uses the PostgREST store; tests run the SAME SQL against a
 * local Postgres through a pg-backed store, so the gates exercise the
 * shipping functions.
 */
export interface ClaimStore {
  currentOpenEpoch(): Promise<EpochRef | null>;
  getOrbRound(roundId: number): Promise<OrbRoundRow | null>;
  submitEarnedEvent(args: SubmitEarnedEventArgs): Promise<number>;
}

export function postgrestClaimStore(db: RaffleDb): ClaimStore {
  return {
    currentOpenEpoch: () => currentOpenEpoch(db),
    getOrbRound: (roundId) => getOrbRound(db, roundId),
    submitEarnedEvent: (args) => submitEarnedEvent(db, args),
  };
}

export interface ClaimDeps {
  config: RaffleConfig;
  store: ClaimStore;
  /** R2: fetch at finalized; null ⇒ not yet finalized / not found. */
  fetchTransaction(signature: string): Promise<any | null>;
  /** AUDIT R-9 — absent in tests that do not exercise it. */
  rateLimit?: RateLimiter;
}

export function defaultClaimDeps(config: RaffleConfig = loadConfig()): ClaimDeps {
  const connection = new Connection(config.solanaRpcUrl, {
    commitment: "finalized",
  });
  const db = raffleDb(config);
  return {
    config,
    store: postgrestClaimStore(db),
    rateLimit: postgrestRateLimiter(db),
    fetchTransaction: (signature) =>
      fetchFinalizedTransaction(connection, config, signature),
  };
}

/**
 * R2 fetch with a version-1 fallback: web3.js's
 * maxSupportedTransactionVersion: 0 hard-rejects the (rare) version-1
 * transactions live on mainnet; a raw JSON-RPC retry keeps those claims
 * verifiable instead of permanently 202-pending.
 */
export async function fetchFinalizedTransaction(
  connection: Connection,
  config: RaffleConfig,
  signature: string,
): Promise<any | null> {
  try {
    const tx = await connection.getTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (tx !== null) return tx;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("Transaction version")) throw err;
  }
  const res = await fetch(`${config.solanaRpcUrl.replace(/\/$/, "")}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 1 },
      ],
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { result?: any };
  return json.result ?? null;
}

/**
 * True when the finalized transaction failed (or carries no status at
 * all — treated as failed, never as a success).
 */
export function transactionFailed(tx: any): boolean {
  return tx?.meta == null || (tx.meta.err !== null && tx.meta.err !== undefined);
}

export function claimEndpoint(deps: ClaimDeps) {
  return async function handleClaim(req: RaffleRequest): Promise<JsonResponse> {
    guardRequest(req);
    const body = requireJsonObject(req.body);
    const signature = requireSignatureString(body, "signature");
    const wallet = requirePubkeyString(body, "wallet");
    await enforceRateLimit(deps.rateLimit, [
      { key: `ip:${clientIp(req)}`, max: RATE_LIMITS.perIpPerMinute },
      { key: `wallet:${wallet}`, max: RATE_LIMITS.perWalletPerMinute },
    ]);

    // R2: finalized only. A transaction that exists but is not yet
    // finalized reads as null here — 202 pending, never award on
    // `confirmed`.
    const tx = await deps.fetchTransaction(signature);
    if (tx === null || tx === undefined) {
      return json(202, { status: "pending" });
    }

    // AUDIT R-2: a failed transaction's logs and inner instructions stay
    // in the ledger though every effect was rolled back. Never credit one.
    if (transactionFailed(tx)) {
      return json(200, { awarded: 0, pending: 0, reason: "transaction_failed" });
    }

    const outcome = classifyTransaction(tx, wallet);

    if (outcome.events.length === 0) {
      return json(200, { awarded: 0, pending: 0, reason: "no_qualifying_event" });
    }
    if (outcome.events.every((e) => e.source === "ore_mining")) {
      // Answer before the epoch lookup: an ORE-only claim is never
      // "pending", whatever state the epochs are in.
      return json(200, { awarded: 0, pending: 0, reason: "ore_deploys_are_indexed" });
    }

    const epoch = await deps.store.currentOpenEpoch();
    if (epoch === null) {
      // Between epochs (post-lock, pre-open) — nothing can be recorded.
      return json(202, { status: "pending", reason: "no_open_epoch" });
    }

    // AUDIT R-5: a deposit counts only in the epoch it happened in. One
    // finalized before this epoch opened cannot be banked into it (or
    // dumped at its end to cap-lock it). Missing block time = not proven.
    const startsAtSec = epoch.startsAt ? Math.floor(Date.parse(epoch.startsAt) / 1000) : null;
    if (startsAtSec !== null && (typeof tx.blockTime !== "number" || tx.blockTime < startsAtSec)) {
      return json(200, { awarded: 0, pending: 0, reason: "before_epoch" });
    }

    let awarded = 0;
    let pending = 0;
    let pendingRound: number | undefined;
    const reasons: string[] = [];

    for (const event of outcome.events) {
      if (event.source === "orb_game") {
        // R3 / §6.1.1 — the round-outcome gate.
        const round = await deps.store.getOrbRound(Number(event.orbRoundId));
        if (round === null || (round.state !== "settled" && round.state !== "cancelled")) {
          pending += 1;
          pendingRound = Number(event.orbRoundId);
          continue; // unresolved: client re-polls
        }
        if (round.state === "cancelled") {
          // A fully-refunded round cost the user nothing. Award nothing,
          // ever, for any reason code — but record the ledger row.
          await deps.store.submitEarnedEvent({
            signature,
            eventIndex: event.eventIndex,
            slot: Number(tx.slot),
            blockTime: isoTime(tx.blockTime),
            source: "orb_game",
            wallet: event.wallet,
            epochId: epoch.id,
            solLamports: Number(event.solLamports),
            lamportsPerEntry: deps.config.lamportsPerEntry,
            referralMinLamports: deps.config.referralMinLamports,
            referralCap: deps.config.referralCapPerEpoch,
            orbRoundId: Number(event.orbRoundId),
            status: "rejected",
            rejectReason: `round_cancelled:${round.reason ?? "unknown"}`,
          });
          reasons.push("round_cancelled");
          continue;
        }
        // settled → accrue + award
        const granted = await deps.store.submitEarnedEvent({
          signature,
          eventIndex: event.eventIndex,
          slot: Number(tx.slot),
          blockTime: isoTime(tx.blockTime),
          source: "orb_game",
          wallet: event.wallet,
          epochId: epoch.id,
          solLamports: Number(event.solLamports),
          lamportsPerEntry: deps.config.lamportsPerEntry,
          referralMinLamports: deps.config.referralMinLamports,
          referralCap: deps.config.referralCapPerEpoch,
          orbRoundId: Number(event.orbRoundId),
        });
        if (granted === EPOCH_CLOSED) {
          // AUDIT R-11: the epoch locked mid-claim; nothing was recorded.
          return json(202, { status: "pending", awarded, reason: "epoch_closed" });
        }
        awarded += granted;
      } else if (event.source === "ore_mining") {
        // ORE entries are awarded by the fee-wallet indexer (ore-indexer.ts),
        // never by a claim: a claim proves a deploy happened, not that it
        // was made through playorb. Nothing is written, so the indexer
        // still records the deploy if it qualifies.
        reasons.push("ore_deploys_are_indexed");
        continue;
      } else {
        throw new HttpError(500, "unreachable_source", `unknown source ${event.source}`);
      }
    }

    if (pending > 0) {
      return json(202, {
        status: "pending",
        awarded,
        pending,
        unlocks_at_round: pendingRound,
      });
    }
    return json(200, {
      awarded,
      pending: 0,
      reason: reasons.length > 0 ? reasons.join(",") : "ok",
    });
  };
}

function isoTime(blockTimeSeconds: number | undefined): string | null {
  if (blockTimeSeconds === undefined || blockTimeSeconds === null) return null;
  return new Date(blockTimeSeconds * 1000).toISOString();
}
