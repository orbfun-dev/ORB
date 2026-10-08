/**
 * ORB wheel indexer — raffle entries for wheel rounds, awarded
 * automatically (owner decision 2026-10-08: "make wheel rounds award
 * raffle entries", once the wheel moved to mainnet).
 *
 * RULE (the rules page): 1 entry per 1 SOL deposited, paid when the
 * round SETTLES; a cancelled round earns nothing. Auto-play deposits earn
 * for the escrow's OWNER, never the escrow PDA.
 *
 * HOW. Walk the ORB program's own transaction history (every deposit is
 * a program transaction) oldest-first from a cursor, exactly like the ORE
 * fee-wallet indexer. Each `Deposited` / `AutoDeposited` event waits for
 * its round's outcome:
 *   settled   → award (raffle_submit_earned_event, source orb_game)
 *   cancelled → a rejected ledger row, never entries
 *   unknown   → STOP: the cursor stays before this transaction, and the
 *               next run (30 s) re-reads it. Rounds settle within about
 *               a minute of their deposits, so the wait is short; a
 *               halted round halts this job, which is the honest answer.
 *
 * OUTCOMES come from (in order): this run's memo, the raffle_orb_rounds
 * cache, the round account on chain, and — once `close_round` deleted the
 * account — the round PDA's event history. Terminal outcomes are cached.
 *
 * EPOCH. A deposit counts in the epoch open when it is awarded, and only
 * if it happened after that epoch opened (AUDIT R-5: no banking a
 * deposit from before the epoch). Nothing before the first epoch earns.
 *
 * IDEMPOTENT. Awards dedup on (signature, event_index), with the same
 * tx-wide indices the claim endpoint uses, so overlaps, replays and a
 * deposit someone already claimed never award twice.
 */

import type { RaffleConfig } from "./env";
import { orbDepositEvents } from "./classify";
import type { CachedOutcome } from "./round-cache";
import { EPOCH_CLOSED, type EpochRef, type OrbRoundState, type SubmitEarnedEventArgs } from "./store";
import type { IndexerCursor, SignatureRef } from "./ore-indexer";

/** The job's row in raffle_indexer_cursors. */
export const ORB_INDEXER_CURSOR = "orb_game_deposits";

const PAGE_LIMIT = 1000;
/** See ore-indexer.ts: 10 000 program transactions behind = backlog. */
const MAX_PAGES = 10;
/** Program transactions fetched per run (most carry no deposit). */
export const ORB_MAX_TX_PER_RUN = 60;
export const ORB_RUN_BUDGET_MS = 8_000;

export interface OrbRoundOutcome {
  state: OrbRoundState;
  reason: number | null;
  decidedAt: string | null;
}

export interface OrbIndexerStore {
  getCursor(name: string): Promise<IndexerCursor | null>;
  advanceCursor(name: string, cursor: IndexerCursor): Promise<void>;
  currentOpenEpoch(): Promise<EpochRef | null>;
  earliestEpochStart(): Promise<Date | null>;
  submitEarnedEvent(args: SubmitEarnedEventArgs): Promise<number>;
  getOrbRound(roundId: number): Promise<{ state: OrbRoundState; reason: number | null } | null>;
  upsertOrbRound(roundId: number, outcome: OrbRoundOutcome): Promise<void>;
}

export interface OrbIndexerDeps {
  config: RaffleConfig;
  store: OrbIndexerStore;
  /** getSignaturesForAddress(ORB program) at finalized, newest first. */
  listSignatures(opts: { until?: string; before?: string; limit: number }): Promise<SignatureRef[]>;
  fetchTransaction(signature: string): Promise<any | null>;
  /** The round account's state, or null when the account is gone. */
  fetchRoundState(roundId: bigint): Promise<{ state: OrbRoundState; settleTs: bigint } | null>;
  /** The round PDA's history (settled / cancelled), or null if not found. */
  fetchOutcomeFromHistory(roundId: bigint): Promise<CachedOutcome | null>;
  nowMs?(): number;
}

export interface OrbIndexerRun {
  status: "ok" | "no_open_epoch" | "not_launched" | "backlog" | "waiting_for_round";
  seen: number;
  processed: number;
  /** Deposit events awarded entries (may be 0 entries each below 1 SOL). */
  deposits: number;
  awarded: number;
  /** Deposit events that earn nothing, by reason. */
  skipped: Record<string, number>;
  /** The round the run stopped at, when status is waiting_for_round. */
  waitingRound: number | null;
  cursor: string | null;
}

const TERMINAL: ReadonlySet<OrbRoundState> = new Set(["settled", "cancelled"]);

export async function runOrbIndexer(deps: OrbIndexerDeps): Promise<OrbIndexerRun> {
  const now = deps.nowMs ?? (() => Date.now());
  const started = now();
  const { config, store } = deps;

  const cursor = await store.getCursor(ORB_INDEXER_CURSOR);
  const result: OrbIndexerRun = {
    status: "ok",
    seen: 0,
    processed: 0,
    deposits: 0,
    awarded: 0,
    skipped: {},
    waitingRound: null,
    cursor: cursor?.signature ?? null,
  };

  const launch = await store.earliestEpochStart();
  if (launch === null) return { ...result, status: "not_launched" };
  const floorSec = Math.floor(launch.getTime() / 1000);
  const epoch = await store.currentOpenEpoch();
  if (epoch === null) return { ...result, status: "no_open_epoch" };
  const epochStartSec = epoch.startsAt ? Math.floor(Date.parse(epoch.startsAt) / 1000) : floorSec;

  const newer: SignatureRef[] = [];
  let before: string | undefined;
  let reachedEnd = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await deps.listSignatures({ until: cursor?.signature, before, limit: PAGE_LIMIT });
    newer.push(...batch);
    const last = batch[batch.length - 1];
    if (batch.length < PAGE_LIMIT || (last.blockTime !== null && last.blockTime < floorSec)) {
      reachedEnd = true;
      break;
    }
    before = last.signature;
  }
  result.seen = newer.length;
  if (!reachedEnd) return { ...result, status: "backlog" };

  const memo = new Map<number, OrbRoundOutcome | null>();
  const outcomeOf = async (roundId: number): Promise<OrbRoundOutcome | null> => {
    if (memo.has(roundId)) return memo.get(roundId)!;
    let outcome: OrbRoundOutcome | null = null;
    const cached = await store.getOrbRound(roundId);
    if (cached !== null && TERMINAL.has(cached.state)) {
      outcome = { state: cached.state, reason: cached.reason, decidedAt: null };
    } else {
      const live = await deps.fetchRoundState(BigInt(roundId));
      if (live !== null) {
        if (TERMINAL.has(live.state)) {
          outcome = {
            state: live.state,
            reason: null,
            decidedAt: live.settleTs > 0n ? new Date(Number(live.settleTs) * 1000).toISOString() : null,
          };
        }
      } else {
        const history = await deps.fetchOutcomeFromHistory(BigInt(roundId));
        if (history !== null) outcome = history;
      }
      if (outcome !== null) await store.upsertOrbRound(roundId, outcome);
    }
    memo.set(roundId, outcome);
    return outcome;
  };

  let fetched = 0;
  let advanced: IndexerCursor | null = null;
  outer: for (const sig of newer.reverse()) {
    const preLaunch = sig.blockTime !== null && sig.blockTime < floorSec;
    if (sig.err === null && !preLaunch) {
      if (fetched >= ORB_MAX_TX_PER_RUN || now() - started > ORB_RUN_BUDGET_MS) break;
      fetched += 1;
      const tx = await deps.fetchTransaction(sig.signature);
      if (tx === null || tx === undefined) break; // not served yet — next tick
      if (tx.meta == null || (tx.meta.err !== null && tx.meta.err !== undefined)) {
        advanced = { signature: sig.signature, slot: sig.slot };
        result.processed += 1;
        continue;
      }

      const deposits = orbDepositEvents(tx);
      // Resolve every round first, so a transaction is either fully
      // handled or not touched at all (a batched auto-deposit can carry
      // several owners, all in one round).
      for (const d of deposits) {
        const outcome = await outcomeOf(Number(d.orbRoundId));
        if (outcome === null) {
          result.status = "waiting_for_round";
          result.waitingRound = Number(d.orbRoundId);
          break outer;
        }
      }

      const blockTime = typeof tx.blockTime === "number" ? tx.blockTime : null;
      for (const d of deposits) {
        const outcome = memo.get(Number(d.orbRoundId))!;
        const base: SubmitEarnedEventArgs = {
          signature: sig.signature,
          eventIndex: d.eventIndex,
          slot: Number(tx.slot ?? sig.slot),
          blockTime: blockTime === null ? null : new Date(blockTime * 1000).toISOString(),
          source: "orb_game",
          wallet: d.wallet,
          epochId: epoch.id,
          solLamports: Number(d.solLamports),
          lamportsPerEntry: config.lamportsPerEntry,
          referralMinLamports: config.referralMinLamports,
          referralCap: config.referralCapPerEpoch,
          orbRoundId: Number(d.orbRoundId),
        };
        if (blockTime === null || blockTime < epochStartSec) {
          // AUDIT R-5: made before this epoch opened — never banked into it.
          result.skipped.before_epoch = (result.skipped.before_epoch ?? 0) + 1;
          continue;
        }
        if (outcome.state === "cancelled") {
          const granted = await store.submitEarnedEvent({
            ...base,
            status: "rejected",
            rejectReason: `round_cancelled:${outcome.reason ?? "unknown"}`,
          });
          if (granted === EPOCH_CLOSED) break outer;
          result.skipped.round_cancelled = (result.skipped.round_cancelled ?? 0) + 1;
          continue;
        }
        const granted = await store.submitEarnedEvent(base);
        if (granted === EPOCH_CLOSED) {
          // AUDIT R-11: the epoch locked mid-run; this transaction is
          // re-read against the next epoch (recorded rows dedup).
          break outer;
        }
        result.deposits += 1;
        result.awarded += granted;
      }
    }
    advanced = { signature: sig.signature, slot: sig.slot };
    result.processed += 1;
  }

  if (advanced !== null) {
    await store.advanceCursor(ORB_INDEXER_CURSOR, advanced);
    result.cursor = advanced.signature;
  }
  return result;
}
