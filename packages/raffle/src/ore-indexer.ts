/**
 * ORE deploy indexer — entries for deploys made through playorb, and
 * only those (owner decision, 2026-10-08).
 *
 * WHY AN INDEXER AND NOT CLAIMS. A claim proves a wallet deployed into
 * ORE; it cannot prove WHERE. Any mainnet deploy from any frontend or
 * bot used to earn entries through /api/raffle/claim. What playorb's
 * deploys have that nobody else's do is the platform fee: every deploy
 * the ORE page builds bundles a `SystemProgram.transfer` from the wallet
 * to the fee recipient INSIDE the same atomic transaction (see
 * apps/web/src/features/ore-lite/client.ts). So the fee recipient's own
 * transaction history is, by construction, the list of deploys made
 * through playorb. This job walks that history and awards entries
 * itself. Nobody claims anything.
 *
 * WHAT QUALIFIES. For each fee payment in a transaction:
 *   - the payer must be the deploy's `authority` (the wallet that earns
 *     — classifyTransaction already attributes ORE deploys that way);
 *   - the payment must be at least the fee playorb would have charged on
 *     that spend (`minimumPlatformFee`). A bot that tacks a token
 *     transfer onto its own deploy is paying our full fee, which makes
 *     it a playorb customer in every sense that matters.
 * Automation deploys (an executor signs, nobody pays the fee) never
 * qualify. ORB-game events in the same transaction are ignored here —
 * they still go through the claim endpoint and its round gate.
 *
 * EPOCH. Events go to the epoch open when they are indexed, exactly as a
 * claim did. Deploys older than the first epoch's start (pre-launch) are
 * skipped. If no epoch is open — the few seconds between a lock and the
 * next open — the run stops without moving the cursor.
 *
 * IDEMPOTENT. Every award goes through raffle_submit_earned_event, whose
 * (signature, event_index) dedup makes a replay a no-op. The cursor is
 * an optimisation, not the safety net: overlapping runs, a cursor that
 * lags, or a signature claimed before this job existed all dedup.
 */

import bs58 from "bs58";
import type { RaffleConfig } from "./env";
import { classifyTransaction } from "./classify";
import { EPOCH_CLOSED, type EpochRef, type SubmitEarnedEventArgs } from "./store";

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
/** SystemInstruction::Transfer — u32 LE tag 2, then u64 LE lamports. */
const SYSTEM_TRANSFER_TAG = 2;

/** The job's row in raffle_indexer_cursors. */
export const ORE_INDEXER_CURSOR = "ore_fee_payments";

/** getSignaturesForAddress hard maximum per page. */
const PAGE_LIMIT = 1000;
/**
 * Pages walked per run before giving up on reaching the cursor. 10 000
 * fee payments since the last successful run means the job was down for
 * a long time; processing the newest ones first would leave a hole, so
 * the run reports `backlog` and does nothing until someone looks.
 */
const MAX_PAGES = 10;
/** Transactions fetched per run. pg_cron fires every 30 s. */
export const MAX_TX_PER_RUN = 40;
/** Wall-clock budget per run, under the function and pg_net timeouts. */
export const RUN_BUDGET_MS = 8_000;

// ─── the fee rule ──────────────────────────────────────────────────────

export interface PlatformFeeRule {
  bps: number;
  minLamports: bigint;
  maxLamports: bigint;
}

/**
 * The fee playorb charges on `spendLamports` of deploy. MUST mirror
 * apps/web/src/features/ore-lite/fee.ts + PLATFORM_FEE in config.ts —
 * if the page charges less than this, its own users stop earning. The
 * defaults live in env.ts; change both sides together.
 *
 * Monotonic in spend, so a deploy that lost squares on-chain (and spent
 * less than the page planned) always clears the bar it paid for.
 */
export function minimumPlatformFee(rule: PlatformFeeRule, spendLamports: bigint): bigint {
  if (spendLamports <= 0n) return 0n;
  const raw = (spendLamports * BigInt(rule.bps)) / 10_000n;
  if (raw < rule.minLamports) return rule.minLamports;
  if (raw > rule.maxLamports) return rule.maxLamports;
  return raw;
}

// ─── reading the transaction ───────────────────────────────────────────

/**
 * Every account key the instructions can index: the static keys, then
 * the address-table writable and readonly sets, in that order (the
 * runtime's own ordering). Handles both the raw JSON-RPC shape and the
 * web3.js VersionedTransactionResponse shape.
 */
function allAccountKeys(tx: any): string[] {
  const message = tx.transaction?.message ?? {};
  const asKey = (k: any): string =>
    typeof k === "object" && k !== null && "pubkey" in k ? String(k.pubkey) : String(k);
  const statics: any[] = message.accountKeys ?? message.staticAccountKeys ?? [];
  const loaded = tx.meta?.loadedAddresses ?? {};
  return [
    ...statics.map(asKey),
    ...((loaded.writable ?? []) as any[]).map(asKey),
    ...((loaded.readonly ?? []) as any[]).map(asKey),
  ];
}

interface TopLevelIx {
  programId: string | undefined;
  accounts: string[];
  data: Uint8Array;
}

function topLevelInstructions(tx: any): TopLevelIx[] {
  const message = tx.transaction?.message ?? {};
  const keys = allAccountKeys(tx);
  const out: TopLevelIx[] = [];

  // MessageV0 (web3.js): compiledInstructions with raw bytes.
  if (Array.isArray(message.compiledInstructions)) {
    for (const ix of message.compiledInstructions) {
      out.push({
        programId: keys[ix.programIdIndex],
        accounts: (ix.accountKeyIndexes ?? []).map((i: number) => keys[i]),
        data: ix.data instanceof Uint8Array ? ix.data : Uint8Array.from(ix.data ?? []),
      });
    }
    return out;
  }

  // Raw JSON-RPC and web3.js legacy Message: base58 data strings.
  for (const ix of (message.instructions ?? []) as any[]) {
    let data: Uint8Array;
    try {
      data = typeof ix.data === "string" ? bs58.decode(ix.data) : Uint8Array.from(ix.data ?? []);
    } catch {
      continue; // not base58 — not a transfer we wrote
    }
    out.push({
      programId:
        typeof ix.programId === "string" ? ix.programId : keys[ix.programIdIndex],
      accounts: (ix.accounts ?? []).map((i: number | string) =>
        typeof i === "number" ? keys[i] : String(i),
      ),
      data,
    });
  }
  return out;
}

/**
 * Lamports each wallet paid `recipient` through top-level System
 * transfers in this transaction. Top-level only: the page puts the fee
 * there, and a transfer buried in some other program's CPI is not one
 * the page built.
 */
export function feePaymentsTo(tx: any, recipient: string): Map<string, bigint> {
  const paid = new Map<string, bigint>();
  for (const ix of topLevelInstructions(tx)) {
    if (ix.programId !== SYSTEM_PROGRAM_ID) continue;
    if (ix.data.length < 12) continue;
    const view = Buffer.from(ix.data);
    if (view.readUInt32LE(0) !== SYSTEM_TRANSFER_TAG) continue;
    const [from, to] = ix.accounts;
    if (to !== recipient || from === undefined) continue;
    paid.set(from, (paid.get(from) ?? 0n) + view.readBigUInt64LE(4));
  }
  return paid;
}

export interface QualifiedDeploy {
  wallet: string;
  eventIndex: number;
  solLamports: bigint;
}

export type DeployVerdict =
  | { kind: "qualified"; deploys: QualifiedDeploy[] }
  | { kind: "skipped"; reason: "no_fee_payment" | "no_deploy" | "fee_below_rule" };

/**
 * Which ORE deploys in `tx` were made through playorb. Event indices are
 * classifyTransaction's, so a deploy someone claimed before the indexer
 * existed dedups against the claim instead of awarding twice.
 */
export function qualifyingDeploys(
  tx: any,
  recipient: string,
  rule: PlatformFeeRule,
): DeployVerdict {
  const payments = feePaymentsTo(tx, recipient);
  if (payments.size === 0) return { kind: "skipped", reason: "no_fee_payment" };

  const deploys: QualifiedDeploy[] = [];
  let sawDeploy = false;
  for (const [wallet, paid] of payments) {
    const ore = classifyTransaction(tx, wallet).events.filter((e) => e.source === "ore_mining");
    if (ore.length === 0) continue;
    sawDeploy = true;
    const spend = ore.reduce((sum, e) => sum + e.solLamports, 0n);
    if (paid < minimumPlatformFee(rule, spend)) continue;
    for (const e of ore) {
      deploys.push({ wallet, eventIndex: e.eventIndex, solLamports: e.solLamports });
    }
  }
  if (deploys.length > 0) return { kind: "qualified", deploys };
  return { kind: "skipped", reason: sawDeploy ? "fee_below_rule" : "no_deploy" };
}

// ─── the job ───────────────────────────────────────────────────────────

export interface SignatureRef {
  signature: string;
  slot: number;
  blockTime: number | null;
  /** Non-null for a failed transaction — it moved no fee and no deploy. */
  err: unknown;
}

export interface IndexerCursor {
  signature: string;
  slot: number;
}

export interface OreIndexerStore {
  getCursor(name: string): Promise<IndexerCursor | null>;
  /** Never moves the cursor to an older slot (overlapping runs). */
  advanceCursor(name: string, cursor: IndexerCursor): Promise<void>;
  currentOpenEpoch(): Promise<EpochRef | null>;
  /** The first epoch's starts_at — nothing before launch earns. */
  earliestEpochStart(): Promise<Date | null>;
  submitEarnedEvent(args: SubmitEarnedEventArgs): Promise<number>;
}

export interface OreIndexerDeps {
  config: RaffleConfig;
  store: OreIndexerStore;
  /** getSignaturesForAddress(recipient) at finalized, newest first. */
  listSignatures(opts: { until?: string; before?: string; limit: number }): Promise<SignatureRef[]>;
  /** Finalized transaction or null when not (yet) available. */
  fetchTransaction(signature: string): Promise<any | null>;
  nowMs?(): number;
}

export interface OreIndexerRun {
  status: "ok" | "no_open_epoch" | "not_launched" | "backlog";
  /** Signatures newer than the cursor, before this run. */
  seen: number;
  /** Signatures this run moved past. */
  processed: number;
  /** Transactions holding at least one qualifying deploy. */
  qualified: number;
  awarded: number;
  /** Transactions paying the fee wallet that earned nothing, by reason. */
  skipped: Record<string, number>;
  cursor: string | null;
}

export async function runOreIndexer(deps: OreIndexerDeps): Promise<OreIndexerRun> {
  const now = deps.nowMs ?? (() => Date.now());
  const started = now();
  const { config, store } = deps;
  const recipient = config.oreFeeRecipient;
  if (!recipient) {
    throw new Error("RAFFLE_ORE_FEE_RECIPIENT is not configured — the ORE indexer cannot run");
  }

  const cursor = await store.getCursor(ORE_INDEXER_CURSOR);
  const result: OreIndexerRun = {
    status: "ok",
    seen: 0,
    processed: 0,
    qualified: 0,
    awarded: 0,
    skipped: {},
    cursor: cursor?.signature ?? null,
  };

  const launch = await store.earliestEpochStart();
  if (launch === null) return { ...result, status: "not_launched" };
  const floorSec = Math.floor(launch.getTime() / 1000);

  const epoch = await store.currentOpenEpoch();
  if (epoch === null) return { ...result, status: "no_open_epoch" };

  // Walk back from the newest signature to the cursor (or, on the first
  // run, to launch). Newest first, so collect then reverse.
  const newer: SignatureRef[] = [];
  let before: string | undefined;
  let reachedEnd = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await deps.listSignatures({
      until: cursor?.signature,
      before,
      limit: PAGE_LIMIT,
    });
    newer.push(...batch);
    const last = batch[batch.length - 1];
    if (
      batch.length < PAGE_LIMIT ||
      (last.blockTime !== null && last.blockTime < floorSec)
    ) {
      reachedEnd = true;
      break;
    }
    before = last.signature;
  }
  result.seen = newer.length;
  if (!reachedEnd) return { ...result, status: "backlog" };

  const rule: PlatformFeeRule = {
    bps: config.oreFeeBps,
    minLamports: BigInt(config.oreFeeMinLamports),
    maxLamports: BigInt(config.oreFeeMaxLamports),
  };

  let fetched = 0;
  let advanced: IndexerCursor | null = null;
  for (const sig of newer.reverse()) {
    const preLaunch = sig.blockTime !== null && sig.blockTime < floorSec;
    if (sig.err === null && !preLaunch) {
      if (fetched >= MAX_TX_PER_RUN || now() - started > RUN_BUDGET_MS) break;
      fetched += 1;
      const tx = await deps.fetchTransaction(sig.signature);
      if (tx === null || tx === undefined) break; // listed but not served yet — next tick
      // AUDIT R-2 belt: the signature list already skips failed
      // transactions, but never trust one list over the transaction itself.
      if (tx.meta == null || (tx.meta.err !== null && tx.meta.err !== undefined)) {
        result.skipped.failed = (result.skipped.failed ?? 0) + 1;
        advanced = { signature: sig.signature, slot: sig.slot };
        result.processed += 1;
        continue;
      }

      const verdict = qualifyingDeploys(tx, recipient, rule);
      let epochClosed = false;
      if (verdict.kind === "skipped") {
        result.skipped[verdict.reason] = (result.skipped[verdict.reason] ?? 0) + 1;
      } else {
        result.qualified += 1;
        for (const d of verdict.deploys) {
          const granted = await store.submitEarnedEvent({
            signature: sig.signature,
            eventIndex: d.eventIndex,
            slot: Number(tx.slot ?? sig.slot),
            blockTime: tx.blockTime == null ? null : new Date(tx.blockTime * 1000).toISOString(),
            source: "ore_mining",
            wallet: d.wallet,
            epochId: epoch.id,
            solLamports: Number(d.solLamports),
            lamportsPerEntry: config.lamportsPerEntry,
            referralMinLamports: config.referralMinLamports,
            referralCap: config.referralCapPerEpoch,
          });
          if (granted === EPOCH_CLOSED) {
            epochClosed = true;
            break;
          }
          result.awarded += granted;
        }
      }
      // AUDIT R-11: the epoch locked mid-run. Stop BEFORE this transaction;
      // the next run re-reads it against the new epoch (deploys already
      // recorded dedup on (signature, event_index)).
      if (epochClosed) {
        result.qualified -= 1;
        break;
      }
    }
    advanced = { signature: sig.signature, slot: sig.slot };
    result.processed += 1;
  }

  if (advanced !== null) {
    await store.advanceCursor(ORE_INDEXER_CURSOR, advanced);
    result.cursor = advanced.signature;
  }
  return result;
}
