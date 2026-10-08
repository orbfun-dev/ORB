/**
 * Epoch lock + verifiable draw (directive §6.5, §6.6).
 *
 * Lock (cron, idempotent, under the same FOR UPDATE row lock as the
 * award):
 *   1. raffle_lock_expired_epochs — WHERE status='open' AND now() >= ends_at;
 *   2. for each locked epoch without a draw commitment: merkle root over
 *      the canonical entry list (entry_no order), target_slot =
 *      currentSlot + 1200 (~8 min), and a SIGNED memo carrying
 *      (epoch, root, target). AUDIT R-8: the draw row is reserved with
 *      that memo's signature BEFORE the memo is sent; a later pass
 *      confirms it once finalized, or — only when the memo provably can
 *      never land — signs a replacement. At most one memo per epoch lands,
 *      and the earliest successful one is canonical;
 *   3. open the next epoch when none is open.
 *
 * The 2026-10-07 amendment retires the ORB token buy, so there are no
 * provisional entries and §6.5's hold-through balance check is vacuous —
 * deliberately absent.
 *
 * Draw: for epochs whose commitment is confirmed and whose target_slot
 * has passed, take the FIRST BLOCK AT OR AFTER target_slot (AUDIT R-7: a
 * skipped slot has no block) and reveal
 * winning_no = u64_le(sha256(root ‖ blockhash)) mod issued + 1.
 * scripts/raffle/verify-draw.ts reproduces it independently.
 */

import bs58 from "bs58";
import type { RaffleConfig } from "./env";
import type { RaffleDb } from "./db";
import {
  confirmDrawCommit,
  currentOpenEpoch,
  epochsAwaitingCommit,
  entryWalletAt,
  finalizeEmptyEpoch,
  listEntries,
  lockExpiredEpochs,
  openEpoch,
  pendingDraws,
  recordDrawResult,
  replaceDrawCommit,
  reserveDraw,
  unconfirmedDraws,
  type UnconfirmedDraw,
} from "./store";
import { merkleRoot, winningEntryNo } from "./merkle";

export const TARGET_SLOT_AHEAD = 1200; // ~8 minutes at 2.5 slots/sec

/** A commit memo, signed but not necessarily sent. */
export interface SignedCommit {
  signature: string;
  /** The memo's blockhash expires after this block height. */
  lastValidBlockHeight: number;
  /** The serialized transaction, for sendCommit. */
  wire: Buffer;
}

/**
 * finalized: the memo is on chain at finalized commitment, successful.
 * pending:   not finalized yet, and it may still land.
 * dead:      it can never land (expired unseen) or it failed — a
 *            replacement is safe because no commitment exists on chain.
 */
export type CommitStatus = "finalized" | "pending" | "dead";

export interface RevealBlock {
  slot: bigint;
  blockhash: Buffer;
}

export interface EpochDeps {
  config: RaffleConfig;
  store: DrawStore;
  currentSlot(): Promise<bigint>;
  /** §6.5 step 2d — sign (do not send) the on-chain memo commit. */
  signCommitMemo(epochId: number, rootHex: string, targetSlot: bigint): Promise<SignedCommit>;
  /** Broadcast a signed memo. Errors are tolerated: the status pass decides. */
  sendCommit(signed: SignedCommit): Promise<void>;
  commitStatus(signature: string, lastValidBlockHeight: number | null): Promise<CommitStatus>;
  /**
   * AUDIT R-7: the first finalized block at or after `slot`, or null when
   * none is finalized yet (or the history is unavailable — retried).
   */
  revealBlockAtOrAfter(slot: bigint): Promise<RevealBlock | null>;
  now?(): Date;
}

export interface DrawStore {
  lockExpiredEpochs(): Promise<number>;
  currentOpenEpoch(): Promise<{ id: number } | null>;
  openEpoch(endsAtIso: string, cap: number): Promise<number>;
  epochsAwaitingCommit(): Promise<number[]>;
  listEntries(epochId: number): Promise<Array<{ entryNo: number; wallet: string }>>;
  /** Resolve a locked epoch nobody entered: 'drawn', no draw row. */
  finalizeEmptyEpoch(epochId: number): Promise<boolean>;
  /** False when another pass already reserved the epoch. */
  reserveDraw(
    epochId: number,
    root: Buffer,
    targetSlot: number,
    commitSig: string,
    lastValidHeight: number,
  ): Promise<boolean>;
  unconfirmedDraws(): Promise<UnconfirmedDraw[]>;
  confirmDrawCommit(epochId: number, commitSig: string): Promise<boolean>;
  replaceDrawCommit(
    epochId: number,
    oldSig: string,
    newSig: string,
    targetSlot: number,
    lastValidHeight: number,
  ): Promise<boolean>;
  pendingDraws(nowSlot: number): Promise<
    Array<{ epochId: number; merkleRoot: Buffer; targetSlot: number; entriesIssued: number }>
  >;
  entryWalletAt(epochId: number, entryNo: number): Promise<string | null>;
  recordDrawResult(
    epochId: number,
    blockSlot: number,
    blockhash: string,
    winningNo: number,
    winner: string | null,
  ): Promise<boolean>;
}

export function postgrestDrawStore(db: RaffleDb): DrawStore {
  return {
    lockExpiredEpochs: () => lockExpiredEpochs(db),
    currentOpenEpoch: async () => {
      const e = await currentOpenEpoch(db);
      return e === null ? null : { id: e.id };
    },
    openEpoch: (endsAt, cap) => openEpoch(db, endsAt, cap),
    epochsAwaitingCommit: () => epochsAwaitingCommit(db),
    listEntries: (epochId) => listEntries(db, epochId),
    finalizeEmptyEpoch: (epochId) => finalizeEmptyEpoch(db, epochId),
    reserveDraw: (epochId, root, targetSlot, sig, lvh) =>
      reserveDraw(db, epochId, root, targetSlot, sig, lvh),
    unconfirmedDraws: () => unconfirmedDraws(db),
    confirmDrawCommit: (epochId, sig) => confirmDrawCommit(db, epochId, sig),
    replaceDrawCommit: (epochId, oldSig, newSig, targetSlot, lvh) =>
      replaceDrawCommit(db, epochId, oldSig, newSig, targetSlot, lvh),
    pendingDraws: (nowSlot) => pendingDraws(db, nowSlot),
    entryWalletAt: (epochId, entryNo) => entryWalletAt(db, epochId, entryNo),
    recordDrawResult: (epochId, blockSlot, blockhash, winningNo, winner) =>
      recordDrawResult(db, epochId, blockSlot, blockhash, winningNo, winner),
  };
}

export interface LockRunResult {
  locked: number;
  /** Epochs whose commit memo was reserved and sent this pass. */
  committed: number[];
  /** Epochs whose commit memo was seen finalized this pass. */
  confirmed: number[];
  /** Epochs whose unlanded memo was replaced this pass. */
  recommitted: number[];
  emptied: number[];
  openedEpoch: number | null;
  /** Per-epoch failures; one epoch's error never blocks the others. */
  errors: Array<{ epochId: number; error: string }>;
}

async function sendTolerant(deps: EpochDeps, signed: SignedCommit): Promise<void> {
  try {
    await deps.sendCommit(signed);
  } catch {
    // Not fatal: the row already holds this signature. The status pass
    // confirms it if it landed, or replaces it once it provably cannot.
  }
}

export async function runEpochLock(deps: EpochDeps): Promise<LockRunResult> {
  const locked = await deps.store.lockExpiredEpochs();

  const committed: number[] = [];
  const confirmed: number[] = [];
  const recommitted: number[] = [];
  const emptied: number[] = [];
  const errors: LockRunResult["errors"] = [];

  for (const epochId of await deps.store.epochsAwaitingCommit()) {
    try {
      const entries = await deps.store.listEntries(epochId);
      if (entries.length === 0) {
        // A quiet week: the timer locks an expired epoch whatever its
        // entry count, and there is no root over an empty list. Resolve
        // it and carry on — throwing here would abort the pass before
        // step 3 and leave the raffle with no open epoch at all.
        await deps.store.finalizeEmptyEpoch(epochId);
        emptied.push(epochId);
        continue;
      }
      const root = merkleRoot(entries);
      const targetSlot = (await deps.currentSlot()) + BigInt(TARGET_SLOT_AHEAD);
      const signed = await deps.signCommitMemo(epochId, root.toString("hex"), targetSlot);
      // AUDIT R-8: the row first. If a concurrent pass got here first,
      // it owns the send — this signed memo is discarded unsent.
      const reserved = await deps.store.reserveDraw(
        epochId,
        root,
        Number(targetSlot),
        signed.signature,
        signed.lastValidBlockHeight,
      );
      if (!reserved) continue;
      await sendTolerant(deps, signed);
      committed.push(epochId);
    } catch (err) {
      errors.push({ epochId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // The status pass: confirm what landed, replace what never can.
  for (const draw of await deps.store.unconfirmedDraws()) {
    try {
      const status = await deps.commitStatus(draw.commitSig, draw.lastValidHeight);
      if (status === "finalized") {
        if (await deps.store.confirmDrawCommit(draw.epochId, draw.commitSig)) {
          confirmed.push(draw.epochId);
        }
        continue;
      }
      if (status === "pending") continue;
      // dead: nothing for this epoch is on chain, so a fresh memo with a
      // fresh (future) target is the only commitment there will be.
      const targetSlot = (await deps.currentSlot()) + BigInt(TARGET_SLOT_AHEAD);
      const signed = await deps.signCommitMemo(
        draw.epochId,
        draw.merkleRoot.toString("hex"),
        targetSlot,
      );
      const swapped = await deps.store.replaceDrawCommit(
        draw.epochId,
        draw.commitSig,
        signed.signature,
        Number(targetSlot),
        signed.lastValidBlockHeight,
      );
      if (!swapped) continue; // another pass replaced or confirmed it
      await sendTolerant(deps, signed);
      recommitted.push(draw.epochId);
    } catch (err) {
      errors.push({ epochId: draw.epochId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  let openedEpoch: number | null = null;
  if ((await deps.store.currentOpenEpoch()) === null) {
    const now = deps.now?.() ?? new Date();
    const endsAt = new Date(now.getTime() + deps.config.epochDurationDays * 24 * 3600 * 1000);
    openedEpoch = await deps.store.openEpoch(endsAt.toISOString(), deps.config.epochCap);
  }

  return { locked, committed, confirmed, recommitted, emptied, openedEpoch, errors };
}

export interface DrawRunResult {
  drawn: Array<{ epochId: number; blockSlot: number; winningNo: number; winner: string | null }>;
  skipped: number;
  errors: Array<{ epochId: number; error: string }>;
}

/** §6.6 — one pass over pending reveals. */
export async function runDraw(deps: EpochDeps): Promise<DrawRunResult> {
  const slot = await deps.currentSlot();
  const drawn: DrawRunResult["drawn"] = [];
  const errors: DrawRunResult["errors"] = [];
  let skipped = 0;

  // Number(), not the bigint: pendingDraws reaches Postgres through
  // PostgREST, whose body is JSON.stringify'd — and a BigInt there
  // throws "Do not know how to serialize a BigInt", killing every draw
  // tick. A slot fits a double with ~27 million years to spare.
  for (const pending of await deps.store.pendingDraws(Number(slot))) {
    // AUDIT R-7: one epoch's RPC error must not stall every later draw.
    try {
      if (pending.entriesIssued < 1) {
        // Unreachable while the lock resolves empty epochs, but a draw
        // row with no entries must never take the cron down with a
        // `mod 0`.
        skipped += 1;
        continue;
      }
      const block = await deps.revealBlockAtOrAfter(BigInt(pending.targetSlot));
      if (block === null || block.blockhash.length !== 32 || block.slot < BigInt(pending.targetSlot)) {
        skipped += 1;
        continue; // not finalized yet / history unavailable — retried next tick
      }
      const winningNo = winningEntryNo(pending.merkleRoot, block.blockhash, pending.entriesIssued);
      const winner = await deps.store.entryWalletAt(pending.epochId, winningNo);
      const written = await deps.store.recordDrawResult(
        pending.epochId,
        Number(block.slot),
        bs58.encode(block.blockhash),
        winningNo,
        winner,
      );
      if (written) {
        drawn.push({ epochId: pending.epochId, blockSlot: Number(block.slot), winningNo, winner });
      }
    } catch (err) {
      errors.push({ epochId: pending.epochId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { drawn, skipped, errors };
}
