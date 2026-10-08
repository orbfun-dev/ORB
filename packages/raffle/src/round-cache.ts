/**
 * Round-outcome cache — directive §6.2. The ONLY background job.
 *
 * `close_round` deletes the round account, so a late claim can never
 * read `state` from the chain. This cache snapshots each round's state
 * into `raffle_orb_rounds` before that happens:
 *
 *   1. fetchConfig() → active_round_id
 *   2. for every round_id from (max cached + 1) .. active_round_id:
 *        account exists → decodeRound → upsert (state, reason)
 *        account missing → sentinel row `state='open'`, seen_at=now —
 *          a missing account is either a just-closed round or a not-yet-
 *          visible one; `open` makes claims answer 202 (never a wrong
 *          award) and the row's seen_at is how staleness is tracked.
 *   3. sentinel rows stale for > STALE_AFTER_MS → resolve from the
 *      chain's event history (getSignaturesForAddress on the round PDA,
 *      decode RoundSettled / RoundCancelled). The rare path — closed
 *      accounts are the only permanent misses — never optimised.
 *
 * 1–3 RPC calls per minute; NOT an indexer.
 */

import type { Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { ORB_PROGRAM_ID, attributeLogLines } from "./classify";
import { decodeRound, roundKey, type RoundData } from "../../sdk/src/index";
import type { RaffleConfig } from "./env";
import { raffleDb, type RaffleDb } from "./db";
import {
  maxOrbRoundId,
  staleOpenOrbRounds,
  upsertOrbRound,
  type OrbRoundState,
} from "./store";

export const STALE_AFTER_MS = 60 * 60 * 1000; // directive §6.2 step 3: one hour

export interface RoundCacheDeps {
  /** The three store operations, overridable for tests (in-memory). */
  store: RoundCacheStore;
  /** GlobalConfig.active_round_id, or null when unreadable. */
  fetchActiveRoundId(): Promise<bigint | null>;
  /** The round account's decoded data, or null when absent/closed. */
  fetchRound(roundId: bigint): Promise<RoundData | null>;
  /** §6.2 step 3 — the rare event-history fallback. */
  fetchOutcomeFromHistory(roundId: bigint): Promise<CachedOutcome | null>;
  now?(): Date;
}

export interface RoundCacheStore {
  maxCachedRoundId(): Promise<number | null>;
  upsert(
    roundId: number,
    state: OrbRoundState,
    reason: number | null,
    decidedAt: string | null,
    opts: { refreshSeenAt: boolean },
  ): Promise<void>;
  staleOpen(cutoffIso: string, maxRoundId: number): Promise<Array<{ roundId: number }>>;
}

export function postgrestRoundCacheStore(db: RaffleDb): RoundCacheStore {
  return {
    maxCachedRoundId: () => maxOrbRoundId(db),
    upsert: (roundId, state, reason, decidedAt, opts) =>
      upsertOrbRound(db, roundId, state, reason, decidedAt, opts),
    staleOpen: (cutoff, maxRoundId) => staleOpenOrbRounds(db, cutoff, maxRoundId),
  };
}

export interface CachedOutcome {
  state: "settled" | "cancelled";
  reason: number | null;
  decidedAt: string | null;
}

export interface RoundCacheRun {
  scanned: number;
  resolved: number;
  unresolved: number;
  historyResolved: number;
}

/** Rounds unresolvable this run are sentinel rows; claims read 202. */
export async function runRoundCache(deps: RoundCacheDeps): Promise<RoundCacheRun> {
  const now = deps.now?.() ?? new Date();
  const store = deps.store;
  const active = await deps.fetchActiveRoundId();
  if (active === null) {
    return { scanned: 0, resolved: 0, unresolved: 0, historyResolved: 0 };
  }

  const maxCached = await store.maxCachedRoundId(); // null ⇒ nothing cached yet
  const from = maxCached === null ? 1n : BigInt(maxCached) + 1n;
  const to = active;

  let resolved = 0;
  let unresolved = 0;
  for (let id = from; id <= to; id += 1n) {
    const round = await deps.fetchRound(id);
    if (round !== null) {
      await store.upsert(Number(id), mapState(round.state), null, isoOrNull(round.settleTs), {
        refreshSeenAt: true,
      });
      resolved += 1;
    } else {
      // Sentinel: state stays 'open' (claims → 202 pending), seen_at set
      // once — refreshed only when the account is actually seen.
      await store.upsert(Number(id), "open", null, null, { refreshSeenAt: false });
      unresolved += 1;
    }
  }

  // §6.2 step 3 — stale sentinels resolve via the event history.
  let historyResolved = 0;
  const stale = await store.staleOpen(
    new Date(now.getTime() - STALE_AFTER_MS).toISOString(),
    Number(to),
  );
  for (const row of stale) {
    const outcome = await deps.fetchOutcomeFromHistory(BigInt(row.roundId));
    if (outcome === null) continue; // stays sentinel; retried next tick
    await store.upsert(row.roundId, outcome.state, outcome.reason, outcome.decidedAt, {
      refreshSeenAt: true,
    });
    historyResolved += 1;
  }

  return {
    scanned: Number(to - from + 1n),
    resolved,
    unresolved,
    historyResolved,
  };
}

/** decodeRound's state name → the raffle_orb_rounds CHECK domain. */
export function mapState(state: RoundData["state"]): OrbRoundState {
  switch (state) {
    case "open":
      return "open";
    case "locked":
      return "locked";
    case "awaitingRandomness":
      return "awaiting";
    case "settled":
      return "settled";
    case "cancelled":
      return "cancelled";
  }
}

function isoOrNull(unixSeconds: bigint): string | null {
  if (unixSeconds === 0n) return null;
  return new Date(Number(unixSeconds) * 1000).toISOString();
}

// ─── the real deps (cron function wiring) ──────────────────────────────

export function roundCacheDeps(
  config: RaffleConfig,
  connection: Connection,
  db: RaffleDb = raffleDb(config),
): RoundCacheDeps {
  return {
    store: postgrestRoundCacheStore(db),
    fetchActiveRoundId: async () => {
      const fetched = await fetchConfigVia(connection);
      return fetched === null ? null : fetched.activeRoundId;
    },
    fetchRound: (roundId) => fetchRoundVia(connection, roundId),
    fetchOutcomeFromHistory: (roundId) => outcomeFromHistory(connection, roundId),
  };
}

async function fetchConfigVia(connection: Connection) {
  const { configKey } = await import("../../sdk/src/index");
  const info = await connection.getAccountInfo(configKey(), "finalized");
  if (info === null) return null;
  const { decodeGlobalConfig } = await import("../../sdk/src/index");
  return decodeGlobalConfig(info.data);
}

async function fetchRoundVia(connection: Connection, roundId: bigint) {
  const info = await connection.getAccountInfo(roundKey(roundId), "finalized");
  if (info === null) return null;
  try {
    return decodeRound(info.data);
  } catch {
    return null; // a mid-upgrade layout — sentinel until history resolves
  }
}

/**
 * The rare path: the round PDA is closed, so its state survives only in
 * transaction history. RoundSettled rides the event-CPI transport,
 * RoundCancelled the program-log transport — scan both.
 */
export async function outcomeFromHistory(
  connection: Connection,
  roundId: bigint,
): Promise<CachedOutcome | null> {
  const { parseEventInstruction, parseEventLog } = await import("../../sdk/src/index");
  const signatures = await connection.getSignaturesForAddress(roundKey(roundId), {
    limit: 100,
  }, "finalized");
  for (const sigInfo of signatures) {
    const tx = await connection.getTransaction(sigInfo.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (tx === null) continue;
    // AUDIT R-2 class: a failed transaction decided nothing.
    if (tx.meta == null || (tx.meta.err !== null && tx.meta.err !== undefined)) continue;
    const keys: string[] = (tx.transaction.message.staticAccountKeys ?? []).map((k: { toBase58(): string }) => k.toBase58());
    const orb = ORB_PROGRAM_ID;

    // AUDIT R-1 class: only lines the ORB program itself logged count.
    const LOG_PREFIX = "Program data: ";
    const logs = tx.meta.logMessages ?? [];
    const owners = attributeLogLines(logs) ?? logs.map(() => null);
    for (let i = 0; i < logs.length; i += 1) {
      const line = logs[i]!;
      if (!line.startsWith(LOG_PREFIX) || owners[i] !== orb) continue;
      try {
        const event = parseEventLog(Buffer.from(line.slice(LOG_PREFIX.length), "base64"));
        if (event?.name === "RoundCancelled" && event.data.roundId === roundId) {
          return { state: "cancelled", reason: event.data.reason, decidedAt: isoOrNull(BigInt(tx.blockTime ?? 0)) };
        }
      } catch {
        /* malformed foreign payload */
      }
    }
    // emit_cpi! events are inner instructions TO the ORB program; any
    // other program's inner instruction is not an ORB event. The data is
    // base58 in the json encoding (it was decoded as base64 before, so
    // this fallback could never see a RoundSettled).
    for (const group of tx.meta.innerInstructions ?? []) {
      for (const ix of group.instructions) {
        if (typeof ix.data !== "string") continue;
        if (keys[ix.programIdIndex] !== orb) continue;
        let bytes: Buffer;
        try {
          bytes = Buffer.from(bs58.decode(ix.data));
        } catch {
          continue;
        }
        try {
          const event = parseEventInstruction(bytes);
          if (event?.name === "RoundSettled" && event.data.roundId === roundId) {
            return { state: "settled", reason: null, decidedAt: isoOrNull(BigInt(tx.blockTime ?? 0)) };
          }
        } catch {
          /* malformed foreign payload */
        }
      }
    }
  }
  return null;
}
