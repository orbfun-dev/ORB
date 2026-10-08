/**
 * Cron endpoints — driven by pg_cron + pg_net (Supabase schedules an
 * HTTP call; the Node function does the RPC work pg_cron cannot).
 *
 * Every cron endpoint requires the `x-cron-secret` header to equal the
 * server-only RAFFLE_CRON_SECRET; a request without it is 401 before
 * any work happens.
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import type { RaffleConfig } from "../env";
import { loadConfig } from "../env";
import { raffleDb } from "../db";
import { HttpError, isBase58Of, json, secretMatches, type JsonResponse, type RaffleRequest } from "../http";
import { mapState, outcomeFromHistory, runRoundCache, roundCacheDeps } from "../round-cache";
import { runOrbIndexer, type OrbIndexerDeps } from "../orb-indexer";
import { decodeRound, PROGRAM_ID, roundKey } from "../../../sdk/src/index";
import {
  postgrestDrawStore,
  runDraw,
  runEpochLock,
  type CommitStatus,
  type EpochDeps,
  type RevealBlock,
  type SignedCommit,
} from "../epoch";
import type { RaffleDb } from "../db";
import {
  advanceIndexerCursor,
  currentOpenEpoch,
  earliestEpochStart,
  getIndexerCursor,
  getOrbRound,
  recordBuyback,
  upsertOrbRound,
  submitEarnedEvent,
} from "../store";
import { runOreIndexer, type OreIndexerDeps } from "../ore-indexer";
import { fetchFinalizedTransaction } from "./claim";

export function requireCronSecret(req: RaffleRequest, config: RaffleConfig): void {
  const header = req.headers["x-cron-secret"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!secretMatches(value, config.cronSecret)) {
    throw new HttpError(401, "unauthorized", "cron secret missing or wrong");
  }
}

/** GET /api/raffle/cron/round-cache — §6.2, scheduled every 30 s. */
export function roundCacheCronEndpoint(
  config: RaffleConfig,
  connection: Connection,
) {
  return async function handleRoundCacheCron(req: RaffleRequest): Promise<JsonResponse> {
    requireCronSecret(req, config);
    const result = await runRoundCache(roundCacheDeps(config, connection, raffleDb(config)));
    return json(200, { status: "ok", ...result });
  };
}

// ─── ORE deploy indexer (008) ──────────────────────────────────────────

export function oreIndexerDeps(
  config: RaffleConfig,
  connection: Connection,
  db: RaffleDb = raffleDb(config),
): OreIndexerDeps {
  if (!config.oreFeeRecipient) {
    throw new HttpError(500, "not_configured", "RAFFLE_ORE_FEE_RECIPIENT is not set");
  }
  const recipient = new PublicKey(config.oreFeeRecipient);
  return {
    config,
    store: {
      getCursor: (name) => getIndexerCursor(db, name),
      advanceCursor: (name, cursor) => advanceIndexerCursor(db, name, cursor),
      currentOpenEpoch: () => currentOpenEpoch(db),
      earliestEpochStart: () => earliestEpochStart(db),
      submitEarnedEvent: (args) => submitEarnedEvent(db, args),
    },
    listSignatures: async ({ until, before, limit }) => {
      const page = await connection.getSignaturesForAddress(
        recipient,
        { until, before, limit },
        "finalized",
      );
      return page.map((s) => ({
        signature: s.signature,
        slot: s.slot,
        blockTime: s.blockTime ?? null,
        err: s.err,
      }));
    },
    fetchTransaction: (signature) => fetchFinalizedTransaction(connection, config, signature),
  };
}

/**
 * GET /api/raffle/cron/ore-indexer — scheduled every 30 s by 008. Awards
 * ORE entries for deploys that paid playorb's platform fee.
 */
export function oreIndexerCronEndpoint(config: RaffleConfig, connection: Connection) {
  return async function handleOreIndexerCron(req: RaffleRequest): Promise<JsonResponse> {
    requireCronSecret(req, config);
    const result = await runOreIndexer(oreIndexerDeps(config, connection));
    return json(200, result);
  };
}

// ─── ORB wheel indexer (012) ───────────────────────────────────────────

export function orbIndexerDeps(
  config: RaffleConfig,
  connection: Connection,
  db: RaffleDb = raffleDb(config),
): OrbIndexerDeps {
  return {
    config,
    store: {
      getCursor: (name) => getIndexerCursor(db, name),
      advanceCursor: (name, cursor) => advanceIndexerCursor(db, name, cursor),
      currentOpenEpoch: () => currentOpenEpoch(db),
      earliestEpochStart: () => earliestEpochStart(db),
      submitEarnedEvent: (args) => submitEarnedEvent(db, args),
      getOrbRound: (roundId) => getOrbRound(db, roundId),
      upsertOrbRound: (roundId, o) =>
        upsertOrbRound(db, roundId, o.state, o.reason, o.decidedAt, { refreshSeenAt: true }),
    },
    listSignatures: async ({ until, before, limit }) => {
      const page = await connection.getSignaturesForAddress(PROGRAM_ID, { until, before, limit }, "finalized");
      return page.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, err: s.err }));
    },
    fetchTransaction: (signature) => fetchFinalizedTransaction(connection, config, signature),
    fetchRoundState: async (roundId) => {
      const info = await connection.getAccountInfo(roundKey(roundId), "finalized");
      if (info === null) return null;
      const round = decodeRound(info.data);
      return { state: mapState(round.state), settleTs: round.settleTs };
    },
    fetchOutcomeFromHistory: (roundId) => outcomeFromHistory(connection, roundId),
  };
}

/** GET/POST /api/raffle/cron/orb-indexer — every 30 s (sql/012). */
export function orbIndexerCronEndpoint(config: RaffleConfig, connection: Connection) {
  return async function handleOrbIndexerCron(req: RaffleRequest): Promise<JsonResponse> {
    requireCronSecret(req, config);
    const result = await runOrbIndexer(orbIndexerDeps(config, connection));
    return json(200, { ...result, program: PROGRAM_ID.toBase58() });
  };
}

// ─── epoch lock + draw wiring ──────────────────────────────────────────

const MEMO_PROGRAM_ID = "MemoSq4g9ABPF5z6ftm3KvFjYjfntYt8p1GKUPnKcUKEB";

/**
 * The reveal rule, written into every commit memo so the commitment
 * itself states how the draw is computed (AUDIT R-7).
 */
export const REVEAL_RULE = "first_block_at_or_after_target";

export function commitMemoText(epochId: number, rootHex: string, targetSlot: bigint): string {
  return `orb-raffle epoch=${epochId} root=${rootHex} target_slot=${targetSlot} reveal=${REVEAL_RULE}`;
}

/**
 * §6.5 step 2d — the on-chain commitment: one memo transaction carrying
 * (epoch, root, target_slot), signed by the draw-commit wallet. SIGNED
 * here, sent separately (AUDIT R-8): the draw row records the signature
 * before anything reaches the chain. The transaction's slot later proves
 * the root predated the reveal slot; anyone can read it back from the
 * commit wallet's history.
 */
export async function signCommitMemo(
  config: RaffleConfig,
  connection: Connection,
  epochId: number,
  rootHex: string,
  targetSlot: bigint,
): Promise<SignedCommit> {
  if (!config.commitKeypair) {
    throw new Error("RAFFLE_COMMIT_KEYPAIR is not configured — the draw cannot commit");
  }
  const payer = Keypair.fromSecretKey(bs58.decode(config.commitKeypair));
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
  const tx = new Transaction({
    blockhash,
    lastValidBlockHeight,
    feePayer: payer.publicKey,
  }).add(
    new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM_ID),
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from(commitMemoText(epochId, rootHex, targetSlot), "utf8"),
    }),
  );
  tx.sign(payer);
  return {
    signature: bs58.encode(tx.signature!),
    lastValidBlockHeight,
    wire: tx.serialize(),
  };
}

/** Where a signed memo stands; see CommitStatus. */
export async function commitStatus(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number | null,
): Promise<CommitStatus> {
  const { value } = await connection.getSignatureStatuses([signature], {
    searchTransactionHistory: true,
  });
  const status = value[0];
  if (status) {
    if (status.confirmationStatus !== "finalized") return "pending";
    // A finalized FAILED memo is no commitment (verify-draw ignores it).
    return status.err === null ? "finalized" : "dead";
  }
  // Unseen. It can still land until its blockhash expires; once the
  // finalized chain is past the last valid height, it never will.
  if (lastValidBlockHeight === null) return "pending";
  const height = await connection.getBlockHeight("finalized");
  return height > lastValidBlockHeight ? "dead" : "pending";
}

/** AUDIT R-7: the first finalized block at or after `slot`. */
export async function revealBlockAtOrAfter(
  connection: Connection,
  slot: bigint,
): Promise<RevealBlock | null> {
  const finalized = await connection.getSlot("finalized");
  const target = Number(slot);
  if (finalized < target) return null;
  for (let start = target; start <= finalized; start += 500) {
    const end = Math.min(start + 499, finalized);
    const slots = await connection.getBlocks(start, end, "finalized");
    if (slots.length === 0) continue;
    const first = Math.min(...slots);
    const block = await connection.getBlock(first, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
      transactionDetails: "none",
      rewards: false,
    });
    if (block === null) return null;
    return { slot: BigInt(first), blockhash: Buffer.from(bs58.decode(block.blockhash)) };
  }
  return null;
}

export function epochCronDeps(
  config: RaffleConfig,
  connection: Connection,
  db: RaffleDb = raffleDb(config),
): EpochDeps {
  return {
    config,
    store: postgrestDrawStore(db),
    currentSlot: async () => BigInt(await connection.getSlot("finalized")),
    signCommitMemo: (epochId, rootHex, targetSlot) =>
      signCommitMemo(config, connection, epochId, rootHex, targetSlot),
    sendCommit: async (signed) => {
      await connection.sendRawTransaction(signed.wire, { skipPreflight: true, maxRetries: 10 });
    },
    commitStatus: (signature, lvh) => commitStatus(connection, signature, lvh),
    revealBlockAtOrAfter: (slot) => revealBlockAtOrAfter(connection, slot),
  };
}

/** GET /api/raffle/cron/epoch-lock — §6.5, scheduled every minute. */
export function epochLockCronEndpoint(config: RaffleConfig, connection: Connection) {
  return async function handleEpochLockCron(req: RaffleRequest): Promise<JsonResponse> {
    requireCronSecret(req, config);
    const result = await runEpochLock(epochCronDeps(config, connection));
    return json(200, { status: "ok", ...result });
  };
}

/** GET /api/raffle/cron/draw — §6.6, scheduled every minute. */
export function drawCronEndpoint(config: RaffleConfig, connection: Connection) {
  return async function handleDrawCron(req: RaffleRequest): Promise<JsonResponse> {
    requireCronSecret(req, config);
    const result = await runDraw(epochCronDeps(config, connection));
    return json(200, { status: "ok", ...result });
  };
}

/**
 * POST /api/raffle/cron/buyback — ops records a buyback transaction
 * against its epoch (R8: an unpublished buyback is an unverifiable
 * claim). Body: { epoch_id, signature, sol_in, orb_out }.
 */
export function buybackCronEndpoint(config: RaffleConfig, db: RaffleDb = raffleDb(config)) {
  return async function handleBuybackCron(req: RaffleRequest): Promise<JsonResponse> {
    requireCronSecret(req, config);
    const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<
      string,
      unknown
    >;
    const epochId = Number(body["epoch_id"]);
    const signature = typeof body["signature"] === "string" ? body["signature"] : "";
    const solIn = Number(body["sol_in"]);
    const orbOut = typeof body["orb_out"] === "string" ? body["orb_out"] : "";
    // AUDIT R-13: real shapes only — a 64-byte signature, a positive SOL
    // amount and a non-negative integer token amount.
    if (
      !Number.isInteger(epochId) ||
      epochId <= 0 ||
      !isBase58Of(signature, 64) ||
      !Number.isFinite(solIn) ||
      solIn <= 0 ||
      !/^[0-9]{1,30}$/.test(orbOut)
    ) {
      throw new HttpError(400, "invalid_body", "epoch_id, signature, sol_in and orb_out are required");
    }
    await recordBuyback(db, epochId, signature, solIn, orbOut);
    return json(200, { status: "recorded" });
  };
}
