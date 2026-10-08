/**
 * The state monitor: snapshots of `GlobalConfig` and every tracked round,
 * kept fresh by batched reads, a WebSocket fast path, and the polling
 * floor as the correctness guarantee (the same posture as the web app's
 * event feed — WS accelerates, polling decides).
 *
 * Round tracking covers everything in a trailing window of
 * `maxTrackedRounds` ids that still exists on chain — non-terminal rounds
 * (the pending-settle queue) AND terminal rounds that still owe cleanup.
 * `close_round` deletes the account, so a clean round simply drops out of
 * the tracked set.
 */

import {
  configKey,
  decodeGlobalConfig,
  decodeRound,
  roundKey,
  type GlobalConfigData,
  type RoundData,
} from "@orbit-jackpot/sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import type { RandomnessView } from "./randomness";
import type { ChainReader } from "./reader";
import type { TrackedRoundStatus } from "./health";

const RECONCILE_EVERY_MS = 10 * 60_000;

/**
 * WebSocket subscriptions on the keys that matter. web3.js owns the
 * socket and its reconnection; the polling floor makes silent WS loss an
 * latency problem, never a correctness one.
 */
export class Watcher {
  private readonly connection: Connection;
  private readonly commitment: "confirmed" | "finalized";
  private readonly onWake: () => void;
  private readonly subs = new Map<string, number>();

  constructor(connection: Connection, commitment: "confirmed" | "finalized", onWake: () => void) {
    this.connection = connection;
    this.commitment = commitment;
    this.onWake = onWake;
  }

  /** Reconciles the subscription set to exactly `keys` (diff-based). */
  setWatched(keys: PublicKey[]): void {
    const want = new Set(keys.map((k) => k.toBase58()));
    for (const [key, id] of this.subs) {
      if (!want.has(key)) {
        void this.connection.removeAccountChangeListener(id).catch(() => undefined);
        this.subs.delete(key);
      }
    }
    for (const key of keys) {
      const b58 = key.toBase58();
      if (this.subs.has(b58)) continue;
      const id = this.connection.onAccountChange(key, () => this.onWake(), this.commitment);
      this.subs.set(b58, id);
    }
  }

  close(): void {
    for (const id of this.subs.values()) {
      void this.connection.removeAccountChangeListener(id).catch(() => undefined);
    }
    this.subs.clear();
  }

  get active(): boolean {
    return this.subs.size > 0;
  }
}

export class RoundMonitor {
  private readonly reader: ChainReader;
  private readonly windowSize: number;
  private readonly wsEnabled: boolean;
  private readonly watcher: Watcher;
  private readonly randomnessPeek: (key: PublicKey) => Promise<RandomnessView | null>;
  private configData: GlobalConfigData | null = null;
  private readonly rounds = new Map<bigint, RoundData>();
  private readonly views = new Map<string, RandomnessView>();
  private lastReconcileAt = 0;

  constructor(
    reader: ChainReader,
    opts: { windowSize: number; wsEnabled: boolean; connection: Connection; commitment: "confirmed" | "finalized" },
    randomnessPeek: (key: PublicKey) => Promise<RandomnessView | null>,
    onWake: () => void,
  ) {
    this.reader = reader;
    this.windowSize = opts.windowSize;
    this.wsEnabled = opts.wsEnabled;
    this.watcher = new Watcher(opts.connection, opts.commitment, onWake);
    this.randomnessPeek = randomnessPeek;
  }

  /** Boot: full reconcile, then one refresh so snapshots exist. */
  async bootstrap(): Promise<void> {
    await this.reconcile();
    await this.refresh();
  }

  /**
   * Rebuilds the tracked set from chain: every still-existing round in
   * the trailing id window. Gaps are tolerated (an older round may still
   * be unclosed when a newer is already closed).
   */
  async reconcile(): Promise<void> {
    this.lastReconcileAt = Date.now();
    const config = await this.reader.config();
    if (config === null) return; // uninitialized program — nothing to track
    const from = config.activeRoundId;
    const count = Number(
      from + 1n < BigInt(this.windowSize) ? from + 1n : BigInt(this.windowSize),
    );
    const found = await this.reader.roundRange(from, count);
    const tracked: Array<[bigint, RoundData]> = [];
    for (const [id, round] of found) {
      if (round !== null) tracked.push([id, round]);
    }
    this.configData = config;
    this.rounds.clear();
    for (const [id, round] of tracked) this.rounds.set(id, round);
    await this.refreshViews();
    this.syncWatcher();
  }

  /** One batched read: config + every tracked round (+ pinned randomness views). */
  async refresh(): Promise<void> {
    if (Date.now() - this.lastReconcileAt > RECONCILE_EVERY_MS || this.configData === null) {
      await this.reconcile();
      return;
    }
    const keys: PublicKey[] = [configKey(), ...this.trackedIds().map((id) => roundKey(id))];
    const batch = await this.reader.accounts(keys);
    const configData = batch.get(configKey().toBase58()) ?? null;
    if (configData !== null) this.configData = decodeGlobalConfig(configData);
    for (const id of this.trackedIds()) {
      const data = batch.get(roundKey(id).toBase58()) ?? null;
      if (data === null) {
        this.rounds.delete(id); // closed while we watched — drop it
      } else {
        this.rounds.set(id, decodeRound(data));
      }
    }
    await this.refreshViews();
    this.syncWatcher();
  }

  /** Targeted post-action refresh: config + one round + its randomness. */
  async refreshRound(roundId: bigint): Promise<void> {
    const keys: PublicKey[] = [configKey(), roundKey(roundId)];
    const round = this.rounds.get(roundId);
    const pinned = pinnedKeyOf(round);
    if (pinned !== null) keys.push(pinned);
    const batch = await this.reader.accounts(keys);
    const configData = batch.get(configKey().toBase58()) ?? null;
    if (configData !== null) this.configData = decodeGlobalConfig(configData);
    const data = batch.get(roundKey(roundId).toBase58()) ?? null;
    if (data === null) {
      this.rounds.delete(roundId);
    } else {
      this.rounds.set(roundId, decodeRound(data));
    }
    // Self-heal tracking: open_round advances config.active_round_id to a
    // round this snapshot has never seen — read it now or rollover
    // misreads "no active round" until the next full reconcile.
    const activeId = this.configData?.activeRoundId;
    if (activeId !== undefined && activeId !== roundId && !this.rounds.has(activeId)) {
      const active = await this.reader.round(activeId);
      if (active !== null) this.rounds.set(activeId, active);
    }
    const nowPinned = pinnedKeyOf(this.rounds.get(roundId));
    if (nowPinned !== null) {
      const view = await this.randomnessPeek(nowPinned);
      if (view === null) this.views.delete(nowPinned.toBase58());
      else this.views.set(nowPinned.toBase58(), view);
    } else if (pinned !== null) {
      this.views.delete(pinned.toBase58());
    }
    this.syncWatcher();
  }

  get config(): GlobalConfigData | null {
    return this.configData;
  }

  round(roundId: bigint): RoundData | null {
    return this.rounds.get(roundId) ?? null;
  }

  trackedIds(): bigint[] {
    return [...this.rounds.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest first
  }

  view(round: RoundData): RandomnessView | null {
    const pinned = pinnedKeyOf(round);
    return pinned === null ? null : this.views.get(pinned.toBase58()) ?? null;
  }

  watcherActive(): boolean {
    return this.wsEnabled && this.watcher.active;
  }

  closeWatcher(): void {
    this.watcher.close();
  }

  /**
   * Settled rounds still un-pruned past `alertSecs` (Phase 11.8): the
   * refund pool is principal — a round stuck here means players are
   * waiting on money, and the alert escalates to degraded health.
   */
  stuckSettled(alertSecs: number, nowUnix: bigint): string[] {
    const stuck: string[] = [];
    for (const [id, round] of this.rounds) {
      if (round.state !== "settled") continue;
      if (round.entriesClosed >= round.entryCount) continue;
      if (round.settleTs <= 0n) continue;
      if (nowUnix - round.settleTs > BigInt(alertSecs)) stuck.push(id.toString());
    }
    return stuck.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).map(String);
  }

  /** Health rows: tracked rounds with quarantine flags from the book. */
  statusRows(quarantined: (roundId: bigint) => string | null): TrackedRoundStatus[] {
    return this.trackedIds().map((id) => {
      const state = this.rounds.get(id)?.state ?? "unknown";
      return quarantined(id) !== null
        ? { roundId: id.toString(), state, quarantined: true }
        : { roundId: id.toString(), state };
    });
  }

  private async refreshViews(): Promise<void> {
    // Rounds mid-pipeline whose randomness account drives the next stage.
    const wanted = new Set<string>();
    for (const round of this.rounds.values()) {
      const pinned = pinnedKeyOf(round);
      if (pinned === null) continue;
      if (round.state === "locked" || round.state === "awaitingRandomness") {
        wanted.add(pinned.toBase58());
      }
    }
    for (const key of wanted) {
      const view = await this.randomnessPeek(new PublicKey(key));
      if (view === null) this.views.delete(key);
      else this.views.set(key, view);
    }
    for (const key of this.views.keys()) {
      if (!wanted.has(key)) this.views.delete(key);
    }
  }

  private syncWatcher(): void {
    if (!this.wsEnabled) return;
    const keys: PublicKey[] = [configKey()];
    for (const id of this.rounds.keys()) {
      keys.push(roundKey(id));
      const pinned = pinnedKeyOf(this.rounds.get(id));
      if (pinned !== null && (this.rounds.get(id)?.state ?? "") === "awaitingRandomness") {
        keys.push(pinned);
      }
    }
    this.watcher.setWatched(keys);
  }
}

/** A round's pinned randomness key, or null while unpinned (default pubkey). */
function pinnedKeyOf(round: RoundData | null | undefined): PublicKey | null {
  if (round === null || round === undefined) return null;
  if (round.randomnessAccount === PublicKey.default.toBase58()) return null;
  try {
    return new PublicKey(round.randomnessAccount);
  } catch {
    return null;
  }
}
