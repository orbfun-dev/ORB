/**
 * The action executor: signs, sends, and confirms one crank transaction.
 *
 * - Compute-budget plumbing: optional CU limit + priority fee prepended
 *   per config (off by default on devnet — inclusion is free there).
 * - Idempotent raw re-send through the gateway (identical bytes → same
 *   signature — safe to retry through 429s).
 * - Per-round in-flight lock: never two sends for the same round at once.
 * - Failure bookkeeping: 5 consecutive failures of one (kind, round)
 *   auto-quarantines the round instead of burning fees forever — unless the
 *   action opts out via `quarantineOnFailure: false` (routine contention,
 *   e.g. auto-deposit entry-index races, must never strand a live round).
 * - Post-landing hooks run OUTSIDE the send-retry boundary: a landed
 *   transaction is a success even if the hook's RPC calls throw.
 * - DRY_RUN: logs the action it would send, sends nothing.
 */

import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { CrankConfig } from "./config";
import type { HealthMonitor } from "./health";
import type { Logger } from "./log";
import type { RpcGateway } from "./rpc";
import type { QuarantineBook } from "./context";

export type ActionKind =
  | "open_round"
  | "lock_round"
  | "create_randomness"
  | "request_randomness"
  | "commit_randomness"
  | "reveal_randomness"
  | "reveal_and_settle"
  | "request_entropy"
  | "reveal_entropy"
  | "fulfill_settle"
  | "claim_winnings"
  | "sweep_unclaimed_prize"
  | "refund_entry"
  | "close_entry"
  | "close_entry_batch"
  | "close_round"
  | "cancel_round"
  | "close_randomness"
  | "close_randomness_lut"
  | "auto_deposit";

export interface CrankAction {
  kind: ActionKind;
  roundId?: bigint;
  label: string;
  /**
   * Builds the transaction; receives a fresh confirmed slot (the create
   * CPI's ALT derivation needs one inside the 512-slot window — rebuilt
   * per send attempt with a FRESH slot, exactly the phase-8 fix).
   */
  build: (freshSlot: bigint) => Transaction | Promise<Transaction>;
  /** Signers beyond the keeper (e.g. the fresh randomness keypair). */
  extraSigners?: Keypair[];
  /** Send attempts with a rebuilt tx each (default 1). */
  sendAttempts?: number;
  /** Post-landing hook (settle verification runs here). */
  after?: (sig: string) => Promise<void>;
  /**
   * Whether consecutive failures may quarantine the round (default true).
   * Actions whose failures are routine contention — auto-deposit against
   * entry-index races with human deposits, an owner withdrawing mid-flight —
   * set `false`: `evalSettle`/`evalCleanup` both bail on quarantined rounds,
   * so a cosmetic failure must never strand a live round's pot.
   */
  quarantineOnFailure?: boolean;
}

/**
 * AUDIT C-1: whether a send failure came from the chain itself (the
 * program or runtime rejected the transaction) rather than the transport.
 */
export function isDeterministicFailure(err: unknown): boolean {
  const text = `${(err as { name?: string })?.name ?? ""} ${String(err)} ${JSON.stringify((err as { logs?: unknown })?.logs ?? "")}`;
  if (/expired|block height exceeded|blockhash not found|429|too many requests|fetch failed|ECONN|ETIMEDOUT|socket hang up|timed? ?out|network|503|502|504/i.test(text)) {
    return false;
  }
  return /tx failed on-chain|custom program error|simulation failed|InstructionError|Error processing Instruction|AnchorError/i.test(text);
}

const explorer = (signature: string, cluster: "devnet" | "mainnet"): string =>
  `https://explorer.solana.com/tx/${signature}${cluster === "mainnet" ? "" : "?cluster=devnet"}`;

/** The cleanup family — every kind whose fees exist to return player
 *  money/rent (Phase 11.8's cost metric buckets these). */
const CLEANUP_KINDS: ReadonlySet<string> = new Set([
  "sweep_unclaimed_prize",
  "refund_entry",
  "close_entry",
  "close_entry_batch",
  "close_round",
  "close_randomness",
  "close_randomness_lut",
]);

/** The per-transaction fee estimate the cleanup metric books (devnet's
 *  5000-lamport signature fee; mainnet adds priority fees, which the
 *  config applies separately and which land in the tx, not here). */
const CLEANUP_FEE_LAMPORTS_EST = 5_000n;

const FAILURE_QUARANTINE_THRESHOLD = 5;

export class TxExecutor {
  private readonly rpc: RpcGateway;
  private readonly keeper: Keypair;
  private readonly cfg: CrankConfig;
  private readonly book: QuarantineBook;
  private readonly health: HealthMonitor;
  private readonly logger: Logger;
  private readonly inflight = new Set<string>();

  constructor(
    rpc: RpcGateway,
    keeper: Keypair,
    cfg: CrankConfig,
    book: QuarantineBook,
    health: HealthMonitor,
    logger: Logger,
  ) {
    this.rpc = rpc;
    this.keeper = keeper;
    this.cfg = cfg;
    this.book = book;
    this.health = health;
    this.logger = logger;
  }

  /** Sends (or dry-run plans) one action; resolves to the signature, or null in dry-run. */
  async dispatch(action: CrankAction): Promise<string | null> {
    const lockKey = action.roundId === undefined ? "*" : action.roundId.toString();
    if (this.inflight.has(lockKey)) {
      this.logger.debug({ kind: action.kind, roundId: lockKey }, "action already in flight — skipped");
      return null;
    }
    this.inflight.add(lockKey);
    try {
      return await this.send(action);
    } finally {
      this.inflight.delete(lockKey);
    }
  }

  private async send(action: CrankAction): Promise<string | null> {
    const failureKey = `${action.kind}:${action.roundId ?? "-"}`;

    if (this.cfg.dryRun) {
      this.logger.info({ event: "dry_run", kind: action.kind, roundId: action.roundId, label: action.label }, "DRY-RUN would send");
      this.book.recordAction({ kind: action.kind, roundId: action.roundId?.toString(), dryRun: true });
      this.health.action(action.label);
      return null;
    }

    const attempts = action.sendAttempts ?? 1;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const sig = await this.sendOnce(action);
        this.book.resetFailures(failureKey);
        await this.runAfter(action, sig);
        return sig;
      } catch (err) {
        lastError = err;
        this.logger.warn(
          { event: "action_attempt_failed", kind: action.kind, roundId: action.roundId?.toString(), attempt, of: attempts, err: String(err).slice(0, 200) },
          "send attempt failed",
        );
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 1_500));
      }
    }

    // AUDIT C-1: only a failure the CHAIN reported (an on-chain error or
    // a failed preflight simulation) says anything about the round.
    // Expired blockhashes, 429s and dropped connections are transport —
    // they retry on the next tick and never count toward quarantine.
    if (!isDeterministicFailure(lastError)) {
      this.logger.warn(
        { event: "transport_failure", kind: action.kind, roundId: action.roundId?.toString(), err: String(lastError).slice(0, 200) },
        "transport failure — not counted toward quarantine",
      );
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    const streak = this.book.recordFailure(failureKey);
    if (
      streak >= FAILURE_QUARANTINE_THRESHOLD &&
      action.roundId !== undefined &&
      (action.quarantineOnFailure ?? true)
    ) {
      this.book.quarantine(action.roundId, `${action.kind} failed ${streak} consecutive times`);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Post-landing hook, decoupled from the send-retry boundary: `verifySettle`'s
   * after-hook is documented non-fatal, yet its RPC calls can throw from
   * exhausted backoff — inside `sendOnce` that marked a LANDED transaction as
   * a failure (streak + possible quarantine). The transaction stands; the
   * failure book is not touched here.
   */
  private async runAfter(action: CrankAction, sig: string): Promise<void> {
    if (action.after === undefined) return;
    try {
      await action.after(sig);
    } catch (err) {
      this.logger.error(
        {
          event: "after_hook_failed",
          kind: action.kind,
          roundId: action.roundId?.toString(),
          sig,
          err: String(err).slice(0, 200),
        },
        "post-landing hook failed — the transaction stands, failure book untouched",
      );
    }
  }

  /**
   * AUDIT C-8: a static fee under congestion produces exactly the expiry
   * streaks that used to strand rounds. With a cap configured, follow the
   * network: p75 of recent fees on the written accounts, clamped to
   * [floor, cap]. Any RPC trouble falls back to the floor.
   */
  private async priorityFee(tx: Transaction): Promise<number> {
    const floor = this.cfg.priorityFeeMicrolamports;
    const cap = this.cfg.priorityFeeMaxMicrolamports;
    if (cap <= 0) return floor;
    try {
      const writable = [
        ...new Set(tx.instructions.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58()))),
      ].slice(0, 128).map((k) => new PublicKey(k));
      const recent = await this.rpc.call("getRecentPrioritizationFees", () =>
        this.rpc.connection.getRecentPrioritizationFees({ lockedWritableAccounts: writable }),
      );
      const fees = recent.map((r) => r.prioritizationFee).sort((a, b) => a - b);
      const p75 = fees.length === 0 ? 0 : fees[Math.min(fees.length - 1, Math.floor(fees.length * 0.75))]!;
      return Math.min(cap, Math.max(floor, p75));
    } catch {
      return floor;
    }
  }

  private async sendOnce(action: CrankAction): Promise<string> {
    // create_randomness demands a slot inside the recent 512-slot window;
    // every other action is happy with the (≤2 s old) cached clock.
    const slot = action.kind === "create_randomness" ? await this.rpc.slot() : (await this.rpc.chainNow()).slot;
    const tx = await action.build(slot);
    const budget: TransactionInstruction[] = [];
    if (this.cfg.computeUnitLimit !== undefined) {
      budget.push(ComputeBudgetProgram.setComputeUnitLimit({ units: this.cfg.computeUnitLimit }));
    }
    const price = await this.priorityFee(tx);
    if (price > 0) {
      budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }));
    }
    if (budget.length > 0) tx.instructions.unshift(...budget);

    const blockhash = await this.rpc.call("getLatestBlockhash", () =>
      this.rpc.connection.getLatestBlockhash("confirmed"),
    );
    tx.recentBlockhash = blockhash.blockhash;
    tx.feePayer = this.keeper.publicKey;
    const signers = [this.keeper, ...(action.extraSigners ?? [])];
    tx.sign(...signers);
    const raw = tx.serialize();

    const sig = await this.rpc.call(`send:${action.kind}`, () =>
      this.rpc.connection.sendRawTransaction(raw, { maxRetries: 10 }),
    );
    const outcome = await this.rpc.call(`confirm:${action.kind}`, () =>
      this.rpc.connection.confirmTransaction(
        { signature: sig, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
        "confirmed",
      ),
    );
    if (outcome.value.err !== null) {
      throw new Error(`tx failed on-chain: ${JSON.stringify(outcome.value.err)} — ${explorer(sig, this.cfg.cluster)}`);
    }

    this.logger.info({ event: "action", kind: action.kind, roundId: action.roundId?.toString(), sig, explorer: explorer(sig, this.cfg.cluster) }, action.label);
    this.book.recordAction({ kind: action.kind, roundId: action.roundId?.toString(), sig });
    this.health.action(action.label);
    if (action.roundId !== undefined && CLEANUP_KINDS.has(action.kind)) {
      this.health.recordCleanupTx(action.roundId, CLEANUP_FEE_LAMPORTS_EST);
    }
    return sig;
  }
}
