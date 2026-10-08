/**
 * The authoritative round state machine (roadmap 7.2).
 *
 * One reducer reconciles three input families:
 *  - decoded accounts (websocket `accountSubscribe` + a 3 s poll floor),
 *  - CPI events (`Deposited`, `RoundSettled`, …) for instant optimistic
 *    patches ahead of the next account read,
 *  - the 250 ms clock tick + chain-clock offset for countdowns.
 *
 * Money and tickets are `bigint` end to end — the only `Number` in this
 * file is wall-clock milliseconds. The reducer is pure: "now" always
 * arrives in the action, so every transition is unit-testable.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  entryShare,
  findWinningEntry,
  type AutoDepositedEvent,
  type DepositedEvent,
  type EntryRefundPaidEvent,
  type EntryRefundedEvent,
  type GlobalConfigData,
  type MegaPotTriggeredEvent,
  type MegaPotVaultData,
  type PlayerEntryAccountData,
  type PrizeClaimedEvent,
  type RoundCancelledEvent,
  type RoundData,
  type RoundLockedEvent,
  type RoundOpenedEvent,
  type RoundSettledEvent,
} from "@orbit-jackpot/sdk";
import { useOrbitClient } from "./OrbitClientProvider";
import { buildFixtureSnapshot, FIXTURE_SCENARIO_NAMES } from "../dev/fixtures";
import { isMyKey } from "../lib/identity";
import { loadClaimables, saveClaimables } from "../lib/claims";
import { loadRefundRounds, saveRefundRounds } from "../lib/refundStore";
import { loadCancelledRounds, saveCancelledRounds } from "../lib/cancelledStore";
import { loadHistory, mergeHistory, saveHistory, type HistoryItem } from "../lib/rewardHistory";
import { scanOpenPositions } from "../lib/openPositions";
import { useRoundAccounts } from "../hooks/useRoundAccounts";
import { useEntries, usePreviousEntries } from "../hooks/useEntries";
import { useDepositFeed } from "../hooks/useDepositFeed";
import { useAutoDepositFeed } from "../hooks/useAutoDepositFeed";
import { useSettlementFeed } from "../hooks/useSettlementFeed";

export type DataMode = "live" | "fixture";
export type FeedStatus = "connecting" | "live" | "polling" | "offline";

/** Anti-snipe cue: `end_ts` moved while Open (event or account observed). */
export interface AntiSnipeCue {
  deltaSecs: bigint;
  at: number;
  source: "event" | "account";
}

/** The last settle outcome — the wheel's spin target. */
export interface SettlementOutcome {
  event: RoundSettledEvent;
  at: number;
  mega: MegaPotTriggeredEvent | null;
}

/**
 * A settled, unclaimed round the connected wallet WON — everything the
 * claim CTA needs, independent of which round is currently active. The
 * chain's 30-day claim window outlives many round rollovers, so these
 * records persist across `ROUND_OPENED` (session map) and page reloads
 * (localStorage, re-validated against the round account on hydrate).
 */
export interface ClaimableRound {
  roundId: bigint;
  /** Winner pubkey (the winning entry's player). */
  winner: string;
  /** The winning entry's index — the claim tx's PDA seed. */
  entryIndex: number;
  winningTicket: bigint;
  totalLamports: bigint;
  winnerPayout: bigint;
  megaAwarded: bigint;
  megaTriggered: boolean;
  /** Chain settle time (unix secs) — anchors the claim deadline. */
  settleTs: bigint;
  prizeClaimed: boolean;
}

/**
 * A settled round's refund position — everything the rewards card needs to
 * state and claim the 89% pool (+ Mega field) shares INDEPENDENT of which
 * round is currently active. The `entries` snapshot holds only accounts
 * that still exist when it was taken: `EntryRefundPaid` (keeper or manual
 * `close_entry`) prunes entries out live, and an empty record drops off
 * the map — the wallet's view self-cleans as the keeper sweeps.
 */
export interface RefundRound {
  roundId: bigint;
  /** Pool money at settle — the pro-rata share math's numerators. */
  refundPool: bigint;
  megaFieldPool: bigint;
  totalLamports: bigint;
  /** The winning ticket — gates the winning entry until its prize resolves. */
  winningTicket: bigint;
  prizeClaimed: boolean;
  /** Chain settle time (unix secs) — display ordering, newest first. */
  settleTs: bigint;
  /** The round's still-open entries (the whole book — wallet filtering is
   *  the card's job, exactly like the current-round row always was). */
  entries: PlayerEntryAccountData[];
}

/** One entry a cancelled round has already paid back — the receipt line. */
export interface RefundedEntry {
  entryIndex: number;
  /** Payout destination: the wallet, or the ESCROW PDA for auto-play. */
  player: string;
  /** The full stake returned (cancellation takes no cut — I15). */
  amountLamports: bigint;
}

/**
 * A CANCELLED round's refund position — the twin of {@link RefundRound}
 * for the terminal state that pays everyone back in full.
 *
 * It needs its own book for the same reason settled rounds do, only more
 * urgently: `lock_round` cancels a sole-depositor round and the keeper
 * opens the next one about a SECOND later, so a row read off
 * `state.entries` was on screen for about that long. Records survive the
 * rollover, `EntryRefunded` moves each paid entry across to `refunded`,
 * and a fully-paid record lingers as a RECEIPT (so the player learns
 * where the money went) until {@link CANCELLED_RECEIPT_TTL_MS} elapses.
 */
export interface CancelledRound {
  roundId: bigint;
  /** The round's close time (unix secs) — display ordering, newest first. */
  endTs: bigint;
  /** Entries the chain still owes a full refund (the whole book — wallet
   *  filtering is the card's job, exactly like the refund rows). */
  entries: PlayerEntryAccountData[];
  /** Entries `refund_entry` already paid — the receipt. */
  refunded: readonly RefundedEntry[];
  /** Local ms when the record went fully paid; null while money is owed. */
  receiptAt: number | null;
}

/**
 * The round the active one SUPERSEDED before its outcome was known.
 *
 * `open_round` only needs the previous round to have left Open, so the
 * keeper opens N+1 about two seconds after locking N — while N's
 * randomness pipeline (create → pin → commit → reveal → fulfill) takes
 * ~30 s. Every settle therefore lands for a round that is no longer
 * current. Live trace, 2026-10-07: lock 279 at 21:53:01, open 280 at
 * :03, fulfill_settle 279 at :31. Without this slot the reducer dropped
 * that settle on the floor: no claim record, no refund record, and the
 * wheel spun 279's ticket over 280's arcs.
 */
export interface PreviousRound {
  round: RoundData;
  /** Its book, frozen at the rollover (or fetched once after a reload). */
  entries: PlayerEntryAccountData[];
}

/** One payout the chain announced — the raw input of the rewards history. */
export interface PayoutRecord {
  /** `refund` = cancelled round, full stake; `settledRefund` = the 89%
   *  pro-rata share (+ Mega field); `prize` = the winner's payout. */
  kind: "refund" | "settledRefund" | "prize";
  roundId: bigint;
  entryIndex: number;
  /** Payout destination: the wallet, or the ESCROW PDA for auto-play. */
  player: string;
  lamports: bigint;
  /** Local ms when the event was observed. */
  at: number;
}

export interface RoundDataState {
  mode: DataMode;
  fixtureName: string | null;
  /** Local wall clock, advanced by CLOCK_TICK (250 ms). */
  nowMs: number;
  /** chainTime − localTime, measured by useRoundAccounts; countdowns add it. */
  clockOffsetMs: number;
  feedStatus: FeedStatus;
  /** Last surfaced feed/RPC error (cleared on recovery). */
  error: string | null;
  config: GlobalConfigData | null;
  round: RoundData | null;
  megaPot: MegaPotVaultData | null;
  entries: PlayerEntryAccountData[];
  /** Bumped when entries must be refetched (event-driven or rollover). */
  entriesVersion: number;
  antiSnipe: AntiSnipeCue | null;
  lastSettlement: SettlementOutcome | null;
  /**
   * Mega events that arrived before their `RoundSettled` (the settle tx
   * emits them in that order) — keyed by round id, attached when the
   * settlement processes.
   */
  pendingMega: ReadonlyMap<bigint, MegaPotTriggeredEvent>;
  /** Unclaimed settled rounds, by round id (see {@link ClaimableRound}). */
  claimableRounds: ReadonlyMap<bigint, ClaimableRound>;
  /** Settled rounds still owing entry refunds, by round id (see
   *  {@link RefundRound}) — survives rollovers, unlike `entries`. */
  refundRounds: ReadonlyMap<bigint, RefundRound>;
  /** Cancelled rounds owing (or freshly paid) full refunds, by round id
   *  (see {@link CancelledRound}) — survives rollovers too. */
  cancelledRounds: ReadonlyMap<bigint, CancelledRound>;
  /** The superseded round still drawing (or just drawn) behind the live
   *  one — see {@link PreviousRound}. */
  previous: PreviousRound | null;
  /** Every payout announced this session, oldest first, bounded — the
   *  provider files the viewer's own into the persistent history. */
  payouts: readonly PayoutRecord[];
}

export type RoundDataAction =
  | {
      type: "ACCOUNTS_UPDATED";
      config?: GlobalConfigData | null;
      round?: RoundData | null;
      megaPot?: MegaPotVaultData | null;
      entries?: PlayerEntryAccountData[];
    }
  | { type: "DEPOSITED"; event: DepositedEvent }
  | { type: "AUTO_DEPOSITED"; event: AutoDepositedEvent }
  | { type: "ROUND_OPENED"; event: RoundOpenedEvent }
  | { type: "ROUND_LOCKED"; event: RoundLockedEvent }
  | { type: "ROUND_SETTLED"; event: RoundSettledEvent }
  | { type: "MEGA_POT_TRIGGERED"; event: MegaPotTriggeredEvent }
  | { type: "ROUND_CANCELLED"; event: RoundCancelledEvent }
  | { type: "PRIZE_CLAIMED"; event: PrizeClaimedEvent }
  | { type: "CLOCK_TICK"; nowMs: number }
  | { type: "CLOCK_SYNC"; offsetMs: number }
  | { type: "FEED_STATUS"; status: FeedStatus; error?: string }
  | { type: "HYDRATE_CLAIMS"; records: ClaimableRound[] }
  | { type: "ENTRY_REFUND_PAID"; event: EntryRefundPaidEvent }
  | { type: "HYDRATE_REFUNDS"; records: RefundRound[] }
  | { type: "ENTRY_REFUNDED"; event: EntryRefundedEvent; nowMs: number }
  | { type: "HYDRATE_CANCELLED"; records: CancelledRound[] }
  | {
      type: "PREVIOUS_ROUND_UPDATED";
      round?: RoundData;
      entries?: PlayerEntryAccountData[];
    }
  | { type: "LOAD_FIXTURE"; name: string; nowMs: number };

/** The anti-snipe cue fades after this long (CLOCK_TICK clears it). */
export const ANTI_SNIPE_CUE_TTL_MS = 8_000;

/**
 * How long a fully-refunded cancelled round stays on the card as a
 * receipt. The keeper pays a cancellation within seconds, so without this
 * the player would see the row flick past and never learn where their
 * stake went; ten minutes is long enough to come back to the tab and
 * short enough that the card does not become a ledger.
 */
export const CANCELLED_RECEIPT_TTL_MS = 600_000;

const DEFAULT_PUBKEY = "11111111111111111111111111111111";

/** The live-mode initial state — exported for the mount-test harness. */
export function liveInitialState(nowMs: number): RoundDataState {
  return {
    mode: "live",
    fixtureName: null,
    nowMs,
    clockOffsetMs: 0,
    feedStatus: "connecting",
    error: null,
    config: null,
    round: null,
    megaPot: null,
    entries: [],
    entriesVersion: 0,
    antiSnipe: null,
    lastSettlement: null,
    pendingMega: new Map(),
    claimableRounds: new Map(),
    refundRounds: new Map(),
    cancelledRounds: new Map(),
    previous: null,
    payouts: [],
  };
}

function fixtureState(name: string, nowMs: number): RoundDataState {
  const snapshot = buildFixtureSnapshot(name, Math.floor(nowMs / 1000));
  if (snapshot === null) return liveInitialState(nowMs);
  const claimable = deriveClaimable(snapshot.round, snapshot.entries);
  const refund = deriveRefundRound(snapshot.round, snapshot.entries);
  const cancelled = deriveCancelledRound(snapshot.round, snapshot.entries);
  return {
    ...liveInitialState(nowMs),
    mode: "fixture",
    fixtureName: snapshot.name,
    feedStatus: "live",
    config: snapshot.config,
    round: snapshot.round,
    megaPot: snapshot.megaPot,
    entries: [...snapshot.entries],
    entriesVersion: 1,
    lastSettlement: snapshot.settled
      ? { event: snapshot.settled.event, at: nowMs, mega: snapshot.settled.mega ?? null }
      : null,
    claimableRounds: claimable === null ? new Map() : new Map([[claimable.roundId, claimable]]),
    refundRounds: refund === null ? new Map() : new Map([[refund.roundId, refund]]),
    cancelledRounds:
      cancelled === null ? new Map() : new Map([[cancelled.roundId, cancelled]]),
  };
}

/** Entries from a fetch/poll belong to the round we are displaying only. */
function entriesMatchRound(entries: readonly PlayerEntryAccountData[], round: RoundData | null): boolean {
  return entries.length === 0 || round === null || entries[0]!.roundId === round.roundId;
}

function freshRound(event: RoundOpenedEvent): RoundData {
  return {
    roundId: event.roundId,
    state: "open",
    startTs: event.startTs,
    endTs: event.endTs,
    lockTs: 0n,
    lockSlot: 0n,
    settleTs: 0n,
    totalLamports: 0n,
    entryCount: 0,
    entriesClosed: 0,
    // Phase 12: the RoundOpened EVENT carries no rent_payer — the sentinel
    // marks this optimistic round until the next account fetch lands the
    // real payer.
    rentPayer: DEFAULT_PUBKEY,
    firstDepositor: DEFAULT_PUBKEY,
    singleDepositor: true,
    randomnessAccount: DEFAULT_PUBKEY,
    randomnessCommitSlot: 0n,
    randomnessSeedSlot: 0n,
    winningTicket: 0n,
    winner: DEFAULT_PUBKEY,
    winnerPayout: 0n,
    adminCut: 0n,
    megaCut: 0n,
    megaAwarded: 0n,
    refundPool: 0n,
    refundsPaid: 0n,
    megaFieldPool: 0n,
    megaFieldPaid: 0n,
    vaultOwed: 0n,
    megaTriggered: false,
    prizeClaimed: false,
    vaultBump: 0,
    bump: 0,
  };
}

/**
 * Builds the claim record for a settled round from the account view plus
 * the round's own entry book (the integer lookup decides winnership and
 * yields the claim tx's entry index). `null` when the round is not
 * claimable or its book is not (yet) loaded — a later dispatch retries.
 */
function deriveClaimable(
  round: RoundData,
  entries: readonly PlayerEntryAccountData[],
): ClaimableRound | null {
  if (
    round.state !== "settled" ||
    round.prizeClaimed ||
    round.totalLamports <= 0n ||
    round.winningTicket >= round.totalLamports ||
    entries.length === 0 ||
    entries[0]!.roundId !== round.roundId
  ) {
    return null;
  }
  const winner = findWinningEntry(entries, round.winningTicket);
  if (winner === null) return null;
  return {
    roundId: round.roundId,
    winner: winner.player,
    entryIndex: winner.entryIndex,
    winningTicket: round.winningTicket,
    totalLamports: round.totalLamports,
    winnerPayout: round.winnerPayout,
    megaAwarded: round.megaAwarded,
    megaTriggered: round.megaTriggered,
    settleTs: round.settleTs,
    prizeClaimed: false,
  };
}

function claimableEquals(a: ClaimableRound, b: ClaimableRound): boolean {
  return (
    a.roundId === b.roundId &&
    a.winner === b.winner &&
    a.entryIndex === b.entryIndex &&
    a.winningTicket === b.winningTicket &&
    a.totalLamports === b.totalLamports &&
    a.winnerPayout === b.winnerPayout &&
    a.megaAwarded === b.megaAwarded &&
    a.megaTriggered === b.megaTriggered &&
    a.settleTs === b.settleTs &&
    a.prizeClaimed === b.prizeClaimed
  );
}

/** Upserts one record; returns the SAME map when nothing changed. */
function withClaimable(
  map: ReadonlyMap<bigint, ClaimableRound>,
  record: ClaimableRound | null,
): ReadonlyMap<bigint, ClaimableRound> {
  if (record === null) return map;
  const existing = map.get(record.roundId);
  if (existing !== undefined && claimableEquals(existing, record)) return map;
  // A claim is final: a stale account view must never re-open it.
  if (existing?.prizeClaimed === true && !record.prizeClaimed) return map;
  const next = new Map(map);
  next.set(record.roundId, record);
  return next;
}

/** Marks a round's prize claimed; returns the SAME map when already so. */
function markClaimed(
  map: ReadonlyMap<bigint, ClaimableRound>,
  roundId: bigint,
): ReadonlyMap<bigint, ClaimableRound> {
  const existing = map.get(roundId);
  if (existing === undefined || existing.prizeClaimed) return map;
  const next = new Map(map);
  next.set(roundId, { ...existing, prizeClaimed: true });
  return next;
}

/** The refund map's size ceiling — insertion order evicts the oldest.
 *  Sized for a full auto-play run inside the claim window (devnet: one
 *  hour of ≥60 s rounds). It was 8, which silently dropped the oldest
 *  owed rounds once the chain scan started finding all of them. */
const MAX_REFUND_ROUNDS = 64;

/**
 * Snapshots a settled round's refund position from the account view plus
 * its entry book. `null` while the book is not (yet) loaded — a later
 * dispatch retries, exactly like `deriveClaimable`.
 */
function deriveRefundRound(
  round: RoundData,
  entries: readonly PlayerEntryAccountData[],
): RefundRound | null {
  if (round.state !== "settled" || round.totalLamports <= 0n) return null;
  if (entries.length === 0 || entries[0]!.roundId !== round.roundId) return null;
  return {
    roundId: round.roundId,
    refundPool: round.refundPool,
    megaFieldPool: round.megaFieldPool,
    totalLamports: round.totalLamports,
    winningTicket: round.winningTicket,
    prizeClaimed: round.prizeClaimed,
    settleTs: round.settleTs,
    entries: entries as PlayerEntryAccountData[],
  };
}

/** Upserts one record (evicting past the cap); returns the SAME map when
 *  nothing changed — the 3 s account poll must not churn the map.
 *
 *  A settled round's entry set only ever SHRINKS (no deposits after the
 *  lock; `close_entry` deletes), so an update may drop entries but never
 *  re-add one: a re-derive from an older book would otherwise resurrect
 *  an entry `EntryRefundPaid` already pruned, as money still owed. */
function withRefundRound(
  map: ReadonlyMap<bigint, RefundRound>,
  incoming: RefundRound | null,
): ReadonlyMap<bigint, RefundRound> {
  if (incoming === null) return map;
  const existing = map.get(incoming.roundId);
  let record = incoming;
  if (existing !== undefined) {
    const kept = new Set(existing.entries.map((e) => e.entryIndex));
    const entries = incoming.entries.filter((e) => kept.has(e.entryIndex));
    record = {
      ...incoming,
      entries: entries.length === existing.entries.length ? existing.entries : entries,
      prizeClaimed: existing.prizeClaimed || incoming.prizeClaimed,
    };
    if (refundRoundEquals(existing, record)) return map;
  }
  const next = new Map(map);
  next.set(record.roundId, record);
  while (next.size > MAX_REFUND_ROUNDS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

function refundRoundEquals(a: RefundRound, b: RefundRound): boolean {
  return (
    a.roundId === b.roundId &&
    a.refundPool === b.refundPool &&
    a.megaFieldPool === b.megaFieldPool &&
    a.totalLamports === b.totalLamports &&
    a.winningTicket === b.winningTicket &&
    a.prizeClaimed === b.prizeClaimed &&
    a.settleTs === b.settleTs &&
    a.entries === b.entries
  );
}

/** Marks a refund record's prize resolved — the winning entry's refund
 *  unlocks only then (on-chain `WinningEntryNotClaimed`). */
function markRefundPrizeClaimed(
  map: ReadonlyMap<bigint, RefundRound>,
  roundId: bigint,
): ReadonlyMap<bigint, RefundRound> {
  const existing = map.get(roundId);
  if (existing === undefined || existing.prizeClaimed) return map;
  const next = new Map(map);
  next.set(roundId, { ...existing, prizeClaimed: true });
  return next;
}

/**
 * One entry drew its refund (`close_entry` — keeper batch or the player's
 * own click): prune it from the record. A record with no entries left has
 * nothing further to claim — it drops off the map entirely.
 */
function dropRefundEntry(
  map: ReadonlyMap<bigint, RefundRound>,
  roundId: bigint,
  entryIndex: number,
): ReadonlyMap<bigint, RefundRound> {
  const existing = map.get(roundId);
  if (existing === undefined) return map;
  const entries = existing.entries.filter((e) => e.entryIndex !== entryIndex);
  if (entries.length === existing.entries.length) return map; // unknown/stale index
  const next = new Map(map);
  if (entries.length === 0) next.delete(roundId);
  else next.set(roundId, { ...existing, entries });
  return next;
}

/** The cancelled map's size ceiling — insertion order evicts the oldest. */
const MAX_CANCELLED_ROUNDS = 8;

/**
 * Snapshots a cancelled round's refund position from the account view plus
 * its entry book. `null` while the book is not (yet) loaded — a later
 * dispatch retries, exactly like `deriveRefundRound`.
 */
function deriveCancelledRound(
  round: RoundData,
  entries: readonly PlayerEntryAccountData[],
): CancelledRound | null {
  if (round.state !== "cancelled") return null;
  if (entries.length === 0 || entries[0]!.roundId !== round.roundId) return null;
  return {
    roundId: round.roundId,
    endTs: round.endTs,
    entries: entries as PlayerEntryAccountData[],
    refunded: [],
    receiptAt: null,
  };
}

/**
 * Upserts one record (evicting past the cap); returns the SAME map when
 * nothing changed. Unlike the settled book this never OVERWRITES a record
 * that has already started paying out: the account poll re-derives from
 * the shrinking on-chain book, and a naive replace would resurrect
 * already-refunded entries as owed and throw the receipt away.
 */
function withCancelledRound(
  map: ReadonlyMap<bigint, CancelledRound>,
  record: CancelledRound | null,
): ReadonlyMap<bigint, CancelledRound> {
  if (record === null) return map;
  const existing = map.get(record.roundId);
  if (existing !== undefined) {
    if (existing.refunded.length > 0 || existing.receiptAt !== null) {
      // Reconcile only the owed side, and only ever downward.
      const paid = new Set(existing.refunded.map((r) => r.entryIndex));
      const entries = record.entries.filter((e) => !paid.has(e.entryIndex));
      if (entries.length === existing.entries.length) return map;
      const next = new Map(map);
      next.set(record.roundId, { ...existing, entries });
      return next;
    }
    if (cancelledRoundEquals(existing, record)) return map;
  }
  const next = new Map(map);
  next.set(record.roundId, existing === undefined ? record : { ...existing, ...record });
  while (next.size > MAX_CANCELLED_ROUNDS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

function cancelledRoundEquals(a: CancelledRound, b: CancelledRound): boolean {
  return (
    a.roundId === b.roundId &&
    a.endTs === b.endTs &&
    a.entries === b.entries &&
    a.refunded === b.refunded &&
    a.receiptAt === b.receiptAt
  );
}

/**
 * One entry of a cancelled round was paid in full (`refund_entry` — keeper
 * or the player's own click): move it from owed to the receipt. The last
 * one stamps `receiptAt`, which starts the record's display countdown
 * ({@link CANCELLED_RECEIPT_TTL_MS}).
 */
function markEntryRefunded(
  map: ReadonlyMap<bigint, CancelledRound>,
  event: EntryRefundedEvent,
  nowMs: number,
): ReadonlyMap<bigint, CancelledRound> {
  const existing = map.get(event.roundId);
  if (existing === undefined) return map;
  if (existing.refunded.some((r) => r.entryIndex === event.entryIndex)) return map;
  const owed = existing.entries.find((e) => e.entryIndex === event.entryIndex);
  if (owed === undefined) return map; // unknown/stale index
  const entries = existing.entries.filter((e) => e.entryIndex !== event.entryIndex);
  const next = new Map(map);
  next.set(event.roundId, {
    ...existing,
    entries,
    // The event's `amountLamports` is the stake the chain returned; the
    // snapshot's is the same number, but the event is the authority.
    refunded: [
      ...existing.refunded,
      {
        entryIndex: event.entryIndex,
        player: event.player,
        amountLamports: event.amountLamports > 0n ? event.amountLamports : owed.amountLamports,
      },
    ],
    receiptAt: entries.length === 0 ? nowMs : existing.receiptAt,
  });
  return next;
}

/** Drops receipts past their TTL. Returns the SAME map when none expired —
 *  this runs on the 250 ms clock tick and must not churn the tree. */
function pruneCancelledReceipts(
  map: ReadonlyMap<bigint, CancelledRound>,
  nowMs: number,
): ReadonlyMap<bigint, CancelledRound> {
  let expired: bigint[] | null = null;
  for (const [roundId, record] of map) {
    if (record.receiptAt !== null && nowMs - record.receiptAt > CANCELLED_RECEIPT_TTL_MS) {
      (expired ??= []).push(roundId);
    }
  }
  if (expired === null) return map;
  const next = new Map(map);
  for (const roundId of expired) next.delete(roundId);
  return next;
}

/** The session payout log's ceiling — the provider files the viewer's own
 *  into storage as they arrive, so this only bounds memory. */
const MAX_PAYOUTS = 64;

/** Appends one payout unless already logged (a websocket reconnect can
 *  replay events); returns the SAME array when nothing changed. */
function logPayout(
  log: readonly PayoutRecord[],
  payout: PayoutRecord,
): readonly PayoutRecord[] {
  if (
    log.some(
      (p) =>
        p.kind === payout.kind &&
        p.roundId === payout.roundId &&
        p.entryIndex === payout.entryIndex,
    )
  ) {
    return log;
  }
  const next = [...log, payout];
  return next.length > MAX_PAYOUTS ? next.slice(next.length - MAX_PAYOUTS) : next;
}

const isTerminal = (round: RoundData): boolean =>
  round.state === "settled" || round.state === "cancelled";

/** A round view patched with its `RoundSettled` outcome. */
function applySettled(round: RoundData, e: RoundSettledEvent, nowMs: number): RoundData {
  return {
    ...round,
    state: "settled",
    settleTs: BigInt(Math.floor(nowMs / 1000)),
    winningTicket: e.winningTicket,
    totalLamports: e.totalLamports,
    winnerPayout: e.winnerPayout,
    refundPool: e.refundPool,
    refundsPaid: 0n,
    adminCut: e.adminCut,
    megaCut: e.megaCut,
    megaAwarded: e.megaAwarded,
    megaFieldPool: e.megaFieldPool,
    megaFieldPaid: 0n,
    megaTriggered: e.megaTriggered,
  };
}

/**
 * What `previous` becomes when the live round rolls over from `outgoing`:
 * the outgoing round with its book frozen — or the existing `previous`
 * when the outgoing round has nothing to draw. A finished round never
 * displaces one that is still drawing.
 */
function supersede(state: RoundDataState, outgoing: RoundData | null): PreviousRound | null {
  if (outgoing === null) return state.previous;
  const book = entriesMatchRound(state.entries, outgoing) ? state.entries : [];
  if (outgoing.totalLamports === 0n && book.length === 0) return state.previous;
  if (isTerminal(outgoing) && state.previous !== null && !isTerminal(state.previous.round)) {
    return state.previous;
  }
  return {
    // The chain cannot open N+1 while N is Open: a missed lock event still
    // means N is drawing.
    round: outgoing.state === "open" ? { ...outgoing, state: "locked" } : outgoing,
    entries: book,
  };
}

/**
 * The records a change to `previous` implies. Snapshots are taken on the
 * TRANSITION (into settled/cancelled, or the book first arriving) — later
 * account pushes only carry the monotone flags, so a record the keeper
 * has fully paid (and pruned off the map) is never re-derived as owed.
 */
function creditPrevious(
  state: RoundDataState,
  before: PreviousRound | null,
  after: PreviousRound,
): Pick<RoundDataState, "claimableRounds" | "refundRounds" | "cancelledRounds"> {
  let { claimableRounds, refundRounds, cancelledRounds } = state;
  const { round, entries } = after;
  const sameRound = before !== null && before.round.roundId === round.roundId;
  const bookArrived = sameRound && before.entries.length === 0 && entries.length > 0;
  const entered = (s: RoundData["state"]): boolean =>
    round.state === s && (!sameRound || before.round.state !== s || bookArrived);

  if (round.state === "settled") {
    claimableRounds = withClaimable(claimableRounds, deriveClaimable(round, entries));
    if (entered("settled")) {
      refundRounds = withRefundRound(refundRounds, deriveRefundRound(round, entries));
    }
    if (round.prizeClaimed) {
      claimableRounds = markClaimed(claimableRounds, round.roundId);
      refundRounds = markRefundPrizeClaimed(refundRounds, round.roundId);
    }
  } else if (entered("cancelled")) {
    cancelledRounds = withCancelledRound(cancelledRounds, deriveCancelledRound(round, entries));
  }
  return { claimableRounds, refundRounds, cancelledRounds };
}

/** Replaces `previous` and books whatever records the change implies. */
function withPrevious(state: RoundDataState, previous: PreviousRound): RoundDataState {
  return { ...state, previous, ...creditPrevious(state, state.previous, previous) };
}

/** A settled round ACCOUNT, restated as the `RoundSettled` it implies. */
function settledEventFromRound(
  round: RoundData,
  megaPot: MegaPotVaultData | null,
): RoundSettledEvent {
  return {
    roundId: round.roundId,
    winningTicket: round.winningTicket,
    totalLamports: round.totalLamports,
    winnerPayout: round.winnerPayout,
    refundPool: round.refundPool,
    adminCut: round.adminCut,
    megaCut: round.megaCut,
    megaTriggered: round.megaTriggered,
    megaAwarded: round.megaAwarded,
    megaFieldPool: round.megaFieldPool,
    megaPotRemaining: megaPot?.accruedLamports ?? 0n,
    randomnessSeedSlot: round.randomnessSeedSlot,
    randomnessValue: new Uint8Array(32),
  };
}

export function roundDataReducer(state: RoundDataState, action: RoundDataAction): RoundDataState {
  switch (action.type) {
    case "ACCOUNTS_UPDATED": {
      const prevRound = state.round;
      // An OLDER round's view — its subscription outlives the rollover, or
      // a slow fetch resolved late. It belongs to `previous`, never to the
      // live slot: swapping it in dragged the page back a round (wheel,
      // book and all) until the next poll rolled it forward again.
      if (
        action.round !== undefined &&
        action.round !== null &&
        prevRound !== null &&
        action.round.roundId < prevRound.roundId
      ) {
        const routed = roundDataReducer(state, {
          type: "PREVIOUS_ROUND_UPDATED",
          round: action.round,
        });
        const { round: _older, ...rest } = action;
        return roundDataReducer(routed, rest);
      }
      const nextRound = action.round !== undefined ? action.round : prevRound;
      // Anti-snipe: end_ts moved up while still Open (account view).
      let antiSnipe = state.antiSnipe;
      if (
        prevRound?.state === "open" &&
        nextRound?.state === "open" &&
        nextRound.endTs > prevRound.endTs
      ) {
        antiSnipe = {
          deltaSecs: nextRound.endTs - prevRound.endTs,
          at: state.nowMs,
          source: "account",
        };
      }
      const rollover =
        nextRound !== null && prevRound !== null && nextRound.roundId !== prevRound.roundId;
      let entries = state.entries;
      let entriesVersion = state.entriesVersion;
      let previous = state.previous;
      if (rollover) {
        previous = supersede(state, prevRound);
        entries = [];
        entriesVersion += 1;
      }
      if (
        action.entries !== undefined &&
        entriesMatchRound(action.entries, nextRound)
      ) {
        entries = action.entries;
      }
      // Settled account view (page reloaded on a settled round, or the
      // entries landing after the round push): record the claim while its
      // 30-day window is open; a claimed/swept account clears the flag.
      let claimableRounds = state.claimableRounds;
      let refundRounds = state.refundRounds;
      let cancelledRounds = state.cancelledRounds;
      if (nextRound !== null) {
        claimableRounds = withClaimable(claimableRounds, deriveClaimable(nextRound, entries));
        if (nextRound.state === "settled" && nextRound.prizeClaimed) {
          claimableRounds = markClaimed(claimableRounds, nextRound.roundId);
        }
        // Snapshot on the transition only (or when the book lands) — see
        // `creditPrevious`: a re-derive on every push resurrected entries
        // the keeper had already paid and pruned.
        const enteredSettled =
          prevRound?.roundId !== nextRound.roundId ||
          prevRound.state !== "settled" ||
          entries !== state.entries;
        if (nextRound.state === "settled" && enteredSettled) {
          refundRounds = withRefundRound(refundRounds, deriveRefundRound(nextRound, entries));
        }
        // Page loaded (or reconnected) on a cancelled round, or its book
        // landing after the round push — the same retry-until-loaded rule
        // the settled snapshot above follows.
        if (nextRound.state === "cancelled") {
          cancelledRounds = withCancelledRound(
            cancelledRounds,
            deriveCancelledRound(nextRound, entries),
          );
        }
      }
      return {
        ...state,
        config: action.config !== undefined ? action.config : state.config,
        round: nextRound,
        megaPot: action.megaPot !== undefined ? action.megaPot : state.megaPot,
        entries,
        entriesVersion,
        antiSnipe,
        claimableRounds,
        refundRounds,
        cancelledRounds,
        previous,
      };
    }

    case "DEPOSITED": {
      const e = action.event;
      if (state.round === null || e.roundId !== state.round.roundId) return state;
      // Optimistic append — the refetch (entriesVersion bump) replaces it
      // with the authoritative account; unknown fields are zeroed, the UI
      // reads player/amount/range only.
      const optimistic: PlayerEntryAccountData = {
        roundId: e.roundId,
        entryIndex: e.entryIndex,
        player: e.player,
        amountLamports: e.amountLamports,
        ticketStart: e.ticketStart,
        ticketEnd: e.ticketEnd,
        depositTs: 0n,
        depositSlot: 0n,
        bump: 0,
      };
      const entries =
        e.entryIndex === state.entries.length ? [...state.entries, optimistic] : state.entries;
      const extended = e.extended && e.newEndTs > state.round.endTs;
      return {
        ...state,
        round: {
          ...state.round,
          totalLamports: e.roundTotalLamports,
          entryCount: Math.max(state.round.entryCount, e.entryIndex + 1),
          endTs: e.extended ? e.newEndTs : state.round.endTs,
        },
        entries,
        entriesVersion: state.entriesVersion + 1,
        antiSnipe: extended
          ? { deltaSecs: e.newEndTs - state.round.endTs, at: state.nowMs, source: "event" }
          : state.antiSnipe,
      };
    }

    case "AUTO_DEPOSITED": {
      const e = action.event;
      if (state.round === null || e.roundId !== state.round.roundId) return state;
      // Optimistic append, exactly as DEPOSITED — with one structural
      // difference: NO endTs patch and NO anti-snipe cue. The on-chain
      // instruction never extends the round (R3); the optimistic mirror
      // must not either. The entry's player is the ESCROW PDA.
      const optimistic: PlayerEntryAccountData = {
        roundId: e.roundId,
        entryIndex: e.entryIndex,
        player: e.escrow,
        amountLamports: e.amountLamports,
        ticketStart: e.ticketStart,
        ticketEnd: e.ticketEnd,
        depositTs: 0n,
        depositSlot: 0n,
        bump: 0,
      };
      const entries =
        e.entryIndex === state.entries.length ? [...state.entries, optimistic] : state.entries;
      return {
        ...state,
        round: {
          ...state.round,
          totalLamports: e.roundTotalLamports,
          entryCount: Math.max(state.round.entryCount, e.entryIndex + 1),
        },
        entries,
        entriesVersion: state.entriesVersion + 1,
      };
    }

    case "ROUND_OPENED": {
      if (state.round?.roundId === action.event.roundId) return state;
      // A replayed open of an older round (websocket reconnect) must not
      // roll the page backwards.
      if (state.round !== null && action.event.roundId < state.round.roundId) return state;
      return {
        ...state,
        round: freshRound(action.event),
        entries: [],
        entriesVersion: state.entriesVersion + 1,
        antiSnipe: null,
        // The outgoing round is usually still DRAWING — its settle lands
        // ~30 s from now and must find its book (see PreviousRound).
        previous: supersede(state, state.round),
        lastSettlement: null, // fresh wheel for the fresh round
        // claimableRounds AND refundRounds SURVIVE the rollover — round N's
        // winner keeps the claim CTA for the whole 30-day window (audit
        // fix), and round N's losers keep their 89% refund rows until the
        // keeper's close_entry sweep (or their own click) prunes them.
        pendingMega: new Map(),
      };
    }

    case "ROUND_LOCKED": {
      const e = action.event;
      const lock = (r: RoundData): RoundData => ({
        ...r,
        state: "locked",
        lockTs: e.lockTs,
        lockSlot: e.lockSlot,
        totalLamports: e.totalLamports,
        entryCount: Math.max(r.entryCount, e.entryCount),
      });
      if (state.round !== null && e.roundId === state.round.roundId) {
        return { ...state, round: lock(state.round) };
      }
      if (state.previous !== null && e.roundId === state.previous.round.roundId) {
        if (state.previous.round.state !== "open" && state.previous.round.state !== "locked") {
          return state; // already further down the pipeline
        }
        return { ...state, previous: { ...state.previous, round: lock(state.previous.round) } };
      }
      return state;
    }

    case "ROUND_SETTLED": {
      const e = action.event;
      // The settle tx emits MegaPotTriggered BEFORE RoundSettled — attach
      // the buffered mega event now that its settlement is here.
      // …or already attached to this round's settlement, when it was first
      // restated from the account push (see PREVIOUS_ROUND_UPDATED).
      const mega =
        state.pendingMega.get(e.roundId) ??
        (state.lastSettlement?.event.roundId === e.roundId ? state.lastSettlement.mega : null);
      const pendingMega = new Map(state.pendingMega);
      pendingMega.delete(e.roundId);
      if (state.round !== null && e.roundId === state.round.roundId) {
        const round = applySettled(state.round, e, state.nowMs);
        return {
          ...state,
          round,
          lastSettlement: { event: e, at: state.nowMs, mega },
          pendingMega,
          claimableRounds: withClaimable(
            state.claimableRounds,
            deriveClaimable(round, state.entries),
          ),
          // Snapshot the refund position NOW — the book is about to stop
          // being the current round, and refund claims outlive rollovers.
          refundRounds: withRefundRound(
            state.refundRounds,
            deriveRefundRound(round, state.entries),
          ),
        };
      }
      // The pipelined case — the NORMAL one with this keeper: round N+1 is
      // already live, so N's outcome is credited from its frozen book.
      if (state.previous !== null && e.roundId === state.previous.round.roundId) {
        const credited = withPrevious(state, {
          ...state.previous,
          round: applySettled(state.previous.round, e, state.nowMs),
        });
        return {
          ...credited,
          lastSettlement: { event: e, at: state.nowMs, mega },
          pendingMega,
        };
      }
      return {
        ...state,
        lastSettlement: { event: e, at: state.nowMs, mega },
        pendingMega,
      };
    }

    case "MEGA_POT_TRIGGERED": {
      const e = action.event;
      let lastSettlement = state.lastSettlement;
      let pendingMega: ReadonlyMap<bigint, MegaPotTriggeredEvent> = state.pendingMega;
      if (state.lastSettlement?.event.roundId === e.roundId) {
        lastSettlement = { ...state.lastSettlement, mega: e };
      } else {
        // Arrival ordering race: `fulfill_settle` emits MegaPotTriggered
        // BEFORE RoundSettled, so `lastSettlement` does not exist yet —
        // buffer by round id; ROUND_SETTLED attaches it. Bounded so a
        // never-settling stray cannot grow the map forever.
        const buffered = new Map(state.pendingMega);
        buffered.set(e.roundId, e);
        if (buffered.size > 8) {
          const oldest = buffered.keys().next().value;
          if (oldest !== undefined) buffered.delete(oldest);
        }
        pendingMega = buffered;
      }
      const megaPot = state.megaPot ? { ...state.megaPot, accruedLamports: e.retained } : state.megaPot;
      return { ...state, lastSettlement, pendingMega, megaPot };
    }

    case "ROUND_CANCELLED": {
      if (state.previous !== null && action.event.roundId === state.previous.round.roundId) {
        return withPrevious(state, {
          ...state.previous,
          round: { ...state.previous.round, state: "cancelled" },
        });
      }
      if (state.round === null || action.event.roundId !== state.round.roundId) return state;
      const round: RoundData = { ...state.round, state: "cancelled" };
      return {
        ...state,
        round,
        // Snapshot the refund position NOW, exactly as ROUND_SETTLED does.
        // `lock_round` cancels a sole-depositor round and the keeper opens
        // the next one about a second later, so without this the full
        // refund the chain owes leaves the card with `state.entries`.
        cancelledRounds: withCancelledRound(
          state.cancelledRounds,
          deriveCancelledRound(round, state.entries),
        ),
      };
    }

    case "PRIZE_CLAIMED": {
      const e = action.event;
      // The claim record is marked regardless of which round is active —
      // the event can land long after the round rolled over.
      const claimableRounds = markClaimed(state.claimableRounds, e.roundId);
      const refundRounds = markRefundPrizeClaimed(state.refundRounds, e.roundId);
      const payouts = logPayout(state.payouts, {
        kind: "prize",
        roundId: e.roundId,
        entryIndex: e.entryIndex,
        player: e.winner,
        lamports: e.winnerPayout + e.megaAwarded,
        at: state.nowMs,
      });
      const previous =
        state.previous !== null && state.previous.round.roundId === e.roundId
          ? {
              ...state.previous,
              round: { ...state.previous.round, prizeClaimed: true, winner: e.winner },
            }
          : state.previous;
      if (state.round === null || e.roundId !== state.round.roundId) {
        return { ...state, claimableRounds, refundRounds, payouts, previous };
      }
      return {
        ...state,
        round: { ...state.round, prizeClaimed: true, winner: e.winner },
        claimableRounds,
        refundRounds,
        payouts,
        previous,
      };
    }

    case "ENTRY_REFUND_PAID": {
      // Keeper sweep or the player's own close — the entry account is GONE;
      // only the record map reacts (`state.entries` stays untouched: the
      // wheel's landed presentation must not mutate mid-view).
      const e = action.event;
      const refundRounds = dropRefundEntry(state.refundRounds, e.roundId, e.entryIndex);
      const payouts = logPayout(state.payouts, {
        kind: "settledRefund",
        roundId: e.roundId,
        entryIndex: e.entryIndex,
        player: e.player,
        lamports: e.refundLamports + e.megaFieldLamports,
        at: state.nowMs,
      });
      if (refundRounds === state.refundRounds && payouts === state.payouts) return state;
      return { ...state, refundRounds, payouts };
    }

    case "ENTRY_REFUNDED": {
      // A CANCELLED round's `refund_entry` — pays the full stake and closes
      // the entry in one shot. The entry moves to the record's receipt so
      // the player can still see where the money went.
      const cancelledRounds = markEntryRefunded(
        state.cancelledRounds,
        action.event,
        action.nowMs,
      );
      const payouts = logPayout(state.payouts, {
        kind: "refund",
        roundId: action.event.roundId,
        entryIndex: action.event.entryIndex,
        player: action.event.player,
        lamports: action.event.amountLamports,
        at: action.nowMs,
      });
      if (cancelledRounds === state.cancelledRounds && payouts === state.payouts) return state;
      return { ...state, cancelledRounds, payouts };
    }

    case "PREVIOUS_ROUND_UPDATED": {
      // The superseded round's own feed: its account subscription (kept
      // alive past the rollover) and a one-off book fetch. It may only
      // ever describe a round OLDER than the live one.
      const live = state.round;
      let previous = state.previous;
      if (action.round !== undefined) {
        const r = action.round;
        if (live !== null && r.roundId >= live.roundId) return state;
        if (previous !== null && previous.round.roundId === r.roundId) {
          previous = { ...previous, round: r };
        } else if (previous === null || r.roundId > previous.round.roundId) {
          // A round that never took money, or one somehow still Open, has
          // nothing to draw and nothing to credit.
          if (r.state === "open" || (r.totalLamports === 0n && r.entryCount === 0)) return state;
          previous = { round: r, entries: [] };
        } else {
          return state; // older than the round already tracked
        }
      }
      // The book is frozen once known — the wheel draws against it.
      if (
        action.entries !== undefined &&
        previous !== null &&
        previous.entries.length === 0 &&
        action.entries.length > 0 &&
        action.entries[0]!.roundId === previous.round.roundId
      ) {
        previous = { ...previous, entries: action.entries };
      }
      if (previous === null || previous === state.previous) return state;
      const next = withPrevious(state, previous);
      // Watched it go drawing → settled: reveal from the account itself.
      // The push and `RoundSettled` ride the same transaction but arrive
      // on different channels, in either order — and a websocket hiccup
      // can drop the event outright. Only a transition SEEN live reveals;
      // a round that was already settled when first read (a reload) does
      // not replay its spin.
      const before = state.previous;
      if (
        previous.round.state === "settled" &&
        before !== null &&
        before.round.roundId === previous.round.roundId &&
        (before.round.state === "locked" || before.round.state === "awaitingRandomness") &&
        state.lastSettlement?.event.roundId !== previous.round.roundId
      ) {
        return {
          ...next,
          lastSettlement: {
            event: settledEventFromRound(previous.round, state.megaPot),
            at: state.nowMs,
            mega: state.pendingMega.get(previous.round.roundId) ?? null,
          },
        };
      }
      return next;
    }

    case "CLOCK_TICK": {
      const antiSnipe =
        state.antiSnipe !== null && action.nowMs - state.antiSnipe.at > ANTI_SNIPE_CUE_TTL_MS
          ? null
          : state.antiSnipe;
      const cancelledRounds = pruneCancelledReceipts(state.cancelledRounds, action.nowMs);
      return { ...state, nowMs: action.nowMs, antiSnipe, cancelledRounds };
    }

    case "CLOCK_SYNC":
      return { ...state, clockOffsetMs: action.offsetMs };

    case "FEED_STATUS": {
      if (state.feedStatus === action.status && state.error === (action.error ?? null)) {
        return state; // no-op keeps the 250 ms tick from churning
      }
      return { ...state, feedStatus: action.status, error: action.error ?? null };
    }

    case "HYDRATE_CLAIMS": {
      // Validated storage records merge UNDER the session map — anything
      // the live feed already knows (e.g. just-claimed) wins.
      let claimableRounds = state.claimableRounds;
      for (const record of action.records) {
        claimableRounds = withClaimable(claimableRounds, record);
      }
      return { ...state, claimableRounds };
    }

    case "HYDRATE_REFUNDS": {
      // Same merge-under rule, plus: a stored record never REPLACES the
      // session's — storage is wallet-filtered, the session book is whole.
      let refundRounds = state.refundRounds;
      for (const record of action.records) {
        if (refundRounds.has(record.roundId)) continue;
        refundRounds = withRefundRound(refundRounds, record);
      }
      return { ...state, refundRounds };
    }

    case "HYDRATE_CANCELLED": {
      // Same merge-under rule as the refunds above: the session book is
      // whole, storage is wallet-filtered, so a stored record only fills a
      // round the session has never seen.
      let cancelledRounds = state.cancelledRounds;
      for (const record of action.records) {
        if (cancelledRounds.has(record.roundId)) continue;
        cancelledRounds = withCancelledRound(cancelledRounds, record);
      }
      return { ...state, cancelledRounds };
    }

    case "LOAD_FIXTURE":
      return fixtureState(action.name, action.nowMs);
  }
}

/** `?fixture=<name>` — honored in development builds only. */
function readFixtureParam(): string | null {
  if (!import.meta.env.DEV) return null;
  if (typeof window === "undefined") return null;
  const name = new URLSearchParams(window.location.search).get("fixture");
  return name !== null && name.trim() !== "" ? name : null;
}

interface RoundDataContextValue {
  state: RoundDataState;
  /** The connected wallet's stored payout history (see lib/rewardHistory).
   *  Optional so crafted test contexts need not supply it. */
  history?: readonly HistoryItem[];
  loadFixture: (name: string) => void;
  fixtureScenarioNames: readonly string[];
}

const RoundDataContext = createContext<RoundDataContextValue | null>(null);

/**
 * The raw context — exported for the component mount-test harness, which
 * mounts consumers under crafted states (e.g. a settled round with no
 * settlement event in flight) without spinning the live provider.
 */
export { RoundDataContext };

export function RoundDataProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(roundDataReducer, undefined, () => {
    const fixture = readFixtureParam();
    return fixture !== null ? fixtureState(fixture, Date.now()) : liveInitialState(Date.now());
  });
  const { client } = useOrbitClient();
  const { publicKey } = useWallet();
  const live = state.mode === "live";
  const wallet = publicKey?.toString() ?? null;

  // Payout history (lib/rewardHistory): storage is the ledger; this
  // session's payout events and the reload reconciliations below are
  // filed into it as they appear.
  const [history, setHistory] = useState<readonly HistoryItem[]>([]);
  const fileHistory = useCallback(
    (items: readonly HistoryItem[]) => {
      if (!live || wallet === null) return;
      const stored = loadHistory(wallet);
      const next = mergeHistory(stored, items);
      if (next !== stored) saveHistory(wallet, next);
      setHistory(next);
    },
    [live, wallet],
  );
  useEffect(() => {
    if (!live || wallet === null) {
      setHistory([]);
      return;
    }
    fileHistory(state.payouts.filter((p) => isMyKey(p.player, wallet)));
  }, [live, wallet, state.payouts, fileHistory]);

  useRoundAccounts({ enabled: live, client, dispatch });
  useEntries({
    enabled: live,
    client,
    round: state.round,
    entriesVersion: state.entriesVersion,
    dispatch,
  });
  usePreviousEntries({ enabled: live, client, previous: state.previous, dispatch });
  useDepositFeed({ enabled: live, dispatch });
  useAutoDepositFeed({ enabled: live, dispatch });
  useSettlementFeed({ enabled: live, dispatch });

  // Claim persistence (audit fix): stored records are re-validated against
  // the chain when a wallet connects — kept only while the round account
  // still says settled + unclaimed + won by this wallet. Fixture mode
  // never touches storage (deterministic scenarios only).
  useEffect(() => {
    if (!live || wallet === null) return;
    const stored = loadClaimables(wallet);
    if (stored.length === 0) return;
    let alive = true;
    void (async () => {
      const validated: ClaimableRound[] = [];
      const paid: HistoryItem[] = [];
      for (const record of stored) {
        try {
          const round = await client.fetchRound(record.roundId);
          if (round === null) continue; // closed & swept — nothing to claim
          if (round.state === "settled" && round.prizeClaimed) {
            // Claimed while we were away — the prize went to the winner.
            paid.push({
              kind: "prize",
              roundId: record.roundId,
              entryIndex: record.entryIndex,
              player: record.winner,
              lamports: round.winnerPayout + round.megaAwarded,
              at: Date.now(),
            });
          }
          if (round.state !== "settled" || round.prizeClaimed) continue;
          if (round.winner !== record.winner) continue; // not ours (defensive)
          validated.push({
            ...record,
            winningTicket: round.winningTicket,
            totalLamports: round.totalLamports,
            winnerPayout: round.winnerPayout,
            megaAwarded: round.megaAwarded,
            megaTriggered: round.megaTriggered,
            settleTs: round.settleTs,
            prizeClaimed: false,
          });
        } catch {
          // RPC could not answer for this round — keep the stored record;
          // the chain remains the authority when the claim is sent.
          validated.push(record);
        }
      }
      if (alive && validated.length > 0) {
        dispatch({ type: "HYDRATE_CLAIMS", records: validated });
      }
      if (alive && paid.length > 0) fileHistory(paid);
    })();
    return () => {
      alive = false;
    };
  }, [live, client, wallet, fileHistory]);

  useEffect(() => {
    if (!live || wallet === null) return;
    // Only this wallet's own winnings — the session map may carry other
    // players' settled rounds (the reducer is wallet-agnostic); storage is
    // keyed per-wallet and stays minimal. "Own" includes the wallet's
    // ESCROW PDA (R1): an auto-play win records the escrow as winner, and
    // dropping it here made the prize row vanish on reload while the
    // refund row kept saying "unlocks once the prize is claimed" — with
    // no button left to claim it.
    saveClaimables(
      wallet,
      [...state.claimableRounds.values()].filter((r) => isMyKey(r.winner, wallet)),
    );
  }, [live, wallet, state.claimableRounds]);

  // Refund persistence — the same contract as the claims above: stored
  // snapshots are re-validated against the chain on wallet connect, kept
  // only while the round account still exists, is still settled, and
  // still holds UNCLOSED entries worth claiming. Fixture mode never
  // touches storage.
  useEffect(() => {
    if (!live || wallet === null) return;
    const stored = loadRefundRounds(wallet);
    if (stored.length === 0) return;
    let alive = true;
    void (async () => {
      const validated: RefundRound[] = [];
      const paid: HistoryItem[] = [];
      // A stored owed entry that is gone on chain WAS paid: `close_entry`
      // is the only way a settled round's entry closes, and it pays.
      const filePaid = (record: RefundRound, gone: readonly PlayerEntryAccountData[]): void => {
        for (const e of gone) {
          paid.push({
            kind: "settledRefund",
            roundId: record.roundId,
            entryIndex: e.entryIndex,
            player: e.player,
            lamports:
              record.totalLamports === 0n
                ? 0n
                : entryShare(e.amountLamports, record.refundPool, record.totalLamports) +
                  entryShare(e.amountLamports, record.megaFieldPool, record.totalLamports),
            at: Date.now(),
          });
        }
      };
      for (const record of stored) {
        try {
          const round = await client.fetchRound(record.roundId);
          // Closed & pruned, or no longer a refund-owing round — the
          // keeper delivered everything (fetchRound === null also covers
          // pre-Phase-11 rounds that never reach this store).
          if (round === null) {
            filePaid(record, record.entries); // close_round needs every entry closed
            continue;
          }
          if (round.state !== "settled") continue;
          let entries = record.entries;
          try {
            // Drop entries the keeper already closed while we were away;
            // a record with none left is fully paid — skip it.
            const open = await client.fetchEntries(record.roundId);
            const openIndexes = new Set(open.map((e) => e.entryIndex));
            entries = record.entries.filter((e) => openIndexes.has(e.entryIndex));
            filePaid(
              record,
              record.entries.filter((e) => !openIndexes.has(e.entryIndex)),
            );
          } catch {
            // Entry RPC blind — the stored snapshot stands; the chain
            // remains the authority when a close_entry is actually sent.
          }
          if (entries.length === 0) continue;
          validated.push({
            ...record,
            refundPool: round.refundPool,
            megaFieldPool: round.megaFieldPool,
            totalLamports: round.totalLamports,
            winningTicket: round.winningTicket,
            prizeClaimed: round.prizeClaimed,
            settleTs: round.settleTs,
            entries,
          });
        } catch {
          // Round RPC could not answer — keep the stored record.
          validated.push(record);
        }
      }
      if (alive && validated.length > 0) {
        dispatch({ type: "HYDRATE_REFUNDS", records: validated });
      }
      if (alive && paid.length > 0) fileHistory(paid);
    })();
    return () => {
      alive = false;
    };
  }, [live, client, wallet, fileHistory]);

  useEffect(() => {
    if (!live || wallet === null) return;
    // Persist only this wallet's OWN entries (wallet + escrow identities)
    // — the same minimality rule as the claims save above.
    saveRefundRounds(
      wallet,
      [...state.refundRounds.values()].flatMap((r) => {
        const mine = r.entries.filter((e) => isMyKey(e.player, wallet));
        return mine.length === 0 ? [] : [{ ...r, entries: mine }];
      }),
    );
  }, [live, wallet, state.refundRounds]);

  // Cancelled-round persistence — the same contract again, with one extra
  // rule the other two do not need: a MISSING round account is proof of
  // PAYMENT here, not a reason to forget. `close_round` is only permitted
  // once every entry is closed (close_round.rs), so a vanished cancelled
  // round means the keeper refunded the lot — the record converts to a
  // receipt instead of dropping, and the player finally learns where
  // their stake went.
  useEffect(() => {
    if (!live || wallet === null) return;
    const stored = loadCancelledRounds(wallet);
    if (stored.length === 0) return;
    let alive = true;
    void (async () => {
      const validated: CancelledRound[] = [];
      for (const record of stored) {
        const payAll = (): CancelledRound => ({
          ...record,
          entries: [],
          refunded: [
            ...record.refunded,
            ...record.entries.map((e) => ({
              entryIndex: e.entryIndex,
              player: e.player,
              amountLamports: e.amountLamports,
            })),
          ],
          receiptAt: record.receiptAt ?? Date.now(),
        });
        try {
          const round = await client.fetchRound(record.roundId);
          if (round === null) {
            validated.push(payAll());
            continue;
          }
          if (round.state !== "cancelled") continue; // never ours to show
          let entries = record.entries;
          try {
            const open = await client.fetchEntries(record.roundId);
            const openIndexes = new Set(open.map((e) => e.entryIndex));
            entries = record.entries.filter((e) => openIndexes.has(e.entryIndex));
          } catch {
            // Entry RPC blind — the stored snapshot stands; the chain
            // remains the authority when a refund is actually sent.
            validated.push({ ...record, endTs: round.endTs });
            continue;
          }
          const paid = record.entries.filter((e) => !entries.some((o) => o.entryIndex === e.entryIndex));
          validated.push({
            ...record,
            endTs: round.endTs,
            entries,
            refunded: [
              ...record.refunded,
              ...paid.map((e) => ({
                entryIndex: e.entryIndex,
                player: e.player,
                amountLamports: e.amountLamports,
              })),
            ],
            receiptAt:
              entries.length === 0 ? (record.receiptAt ?? Date.now()) : record.receiptAt,
          });
        } catch {
          // Round RPC could not answer — keep the stored record.
          validated.push(record);
        }
      }
      // Every paid entry — this session's events filed most already; the
      // ledger drops the duplicates.
      if (alive) {
        fileHistory(
          validated.flatMap((r) =>
            r.refunded.map((e) => ({
              kind: "refund" as const,
              roundId: r.roundId,
              entryIndex: e.entryIndex,
              player: e.player,
              lamports: e.amountLamports,
              at: r.receiptAt ?? Date.now(),
            })),
          ),
        );
      }
      // Receipts that already expired while the tab was closed never
      // reach the card (CLOCK_TICK would drop them on the next tick
      // anyway — this just avoids the flash).
      const fresh = validated.filter(
        (r) =>
          r.entries.length > 0 ||
          (r.receiptAt !== null && Date.now() - r.receiptAt <= CANCELLED_RECEIPT_TTL_MS),
      );
      if (alive && fresh.length > 0) {
        dispatch({ type: "HYDRATE_CANCELLED", records: fresh });
      }
    })();
    return () => {
      alive = false;
    };
  }, [live, client, wallet, fileHistory]);

  useEffect(() => {
    if (!live || wallet === null) return;
    // Only this wallet's own money, owed side AND receipt side.
    saveCancelledRounds(
      wallet,
      [...state.cancelledRounds.values()].flatMap((r) => {
        const entries = r.entries.filter((e) => isMyKey(e.player, wallet));
        const refunded = r.refunded.filter((e) => isMyKey(e.player, wallet));
        return entries.length === 0 && refunded.length === 0
          ? []
          : [{ ...r, entries, refunded }];
      }),
    );
  }, [live, wallet, state.cancelledRounds]);

  // Chain scan (lib/openPositions): every still-open entry of this wallet
  // or its escrow, in every round — the card's ground truth. The live feed
  // only credits rounds it watched settle, so an auto-play run while the
  // tab was away (or open on another wallet) owed money the card never
  // listed. Re-runs on connect and on every rollover (two filtered reads
  // plus one batched round read); records merge UNDER the session's.
  const activeRoundId = state.round?.roundId ?? null;
  useEffect(() => {
    if (!live || wallet === null) return;
    let alive = true;
    scanOpenPositions(client, wallet)
      .then(({ refunds, claims, cancelled }) => {
        if (!alive) return;
        if (claims.length > 0) dispatch({ type: "HYDRATE_CLAIMS", records: claims });
        if (refunds.length > 0) dispatch({ type: "HYDRATE_REFUNDS", records: refunds });
        if (cancelled.length > 0) dispatch({ type: "HYDRATE_CANCELLED", records: cancelled });
      })
      .catch(() => {
        // RPC refused the program-account scan — keep what the live feed
        // and storage already know.
      });
    return () => {
      alive = false;
    };
  }, [live, client, wallet, activeRoundId]);

  // One clock for the whole tree; countdowns derive from state.nowMs.
  useEffect(() => {
    const timer = setInterval(() => dispatch({ type: "CLOCK_TICK", nowMs: Date.now() }), 250);
    return () => clearInterval(timer);
  }, []);

  // Event-transport failures surface as feed degradation so the 3 s poll
  // floor is visibly in charge until the websocket recovers.
  useEffect(() => {
    if (!live) return;
    client.events.onError = (error) =>
      dispatch({ type: "FEED_STATUS", status: "polling", error: `event feed: ${error.message}` });
    return () => {
      client.events.onError = undefined;
    };
  }, [client, live]);

  const value = useMemo<RoundDataContextValue>(
    () => ({
      state,
      history,
      loadFixture: (name: string) => dispatch({ type: "LOAD_FIXTURE", name, nowMs: Date.now() }),
      fixtureScenarioNames: FIXTURE_SCENARIO_NAMES,
    }),
    [state, history],
  );

  return <RoundDataContext.Provider value={value}>{children}</RoundDataContext.Provider>;
}

export function useRoundData(): RoundDataContextValue {
  const ctx = useContext(RoundDataContext);
  if (ctx === null) {
    throw new Error("useRoundData requires <RoundDataProvider>");
  }
  return ctx;
}

export type RoundDispatch = Dispatch<RoundDataAction>;
