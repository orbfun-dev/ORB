/**
 * Operational health: a mutable snapshot every loop iteration refreshes,
 * served as JSON at `GET /healthz`.
 *
 * 200 while `starting`/`ok`; 503 once `degraded` — three or more
 * consecutive tick errors, or the keeper wallet below its configured
 * minimum (the service cannot fund transactions then). Everything the
 * loop knows — chain clock, balance, tracked rounds — rides along so a
 * remote `curl` is a full status page.
 *
 * Phase 12: an IDLE keeper (active round Open and empty) is healthy —
 * `idle: true` in the snapshot explains the quiet; a non-zero idle burn
 * is a bug worth paging on, silence is not.
 */

import { createServer, type Server } from "node:http";
import type { LastAutoDepositStatus } from "./context";
import type { ChainClock } from "./rpc";

export type HealthStatus = "starting" | "ok" | "degraded";

export interface TrackedRoundStatus {
  roundId: string;
  state: string;
  /** Present when the settle pipeline quarantined this round. */
  quarantined?: boolean;
}

export interface HealthSnapshot {
  status: HealthStatus;
  degradedReasons: string[];
  version: string;
  pid: number;
  startedAt: string;
  uptimeSec: number;
  dryRun: boolean;
  keeperPubkey: string;
  keeperBalanceLamports: string | null;
  minKeeperBalanceLamports: string;
  consecutiveErrors: number;
  lastTickAt: string | null;
  lastTickError: string | null;
  lastAction: string | null;
  lastActionAt: string | null;
  chainSlot: string | null;
  chainUnix: string | null;
  chainSkewSec: number | null;
  wsConnected: boolean;
  trackedRounds: TrackedRoundStatus[];
  /** Phase 10: escrow registry health — tracked/eligible counts and the
   *  last dispatched batch (a large eligible population can crowd out
   *  human deposits against `maxEntriesPerRound`; keep it observable). */
  escrowsTracked: number;
  escrowsEligible: number;
  lastAutoDeposit: LastAutoDepositStatus | null;
  /** Phase 11.8: cleanup cost — estimated tx fees burned returning player
   *  money (refunds, rent, dust), cumulative and per round (most recent). */
  cleanupTxsSent: number;
  cleanupLamportsSpentEst: string;
  cleanupPerRound: Array<{ roundId: string; txs: number; lamportsEst: string }>;
  /** Phase 11.8: settled rounds still un-pruned past the alert threshold —
   *  players are waiting on principal; non-empty degrades health. */
  stuckCleanupRounds: string[];
  /** Phase 12: the active round is Open and holds no money — the keeper's
   *  sanctioned zero-work state. Healthy by definition (the first bettor
   *  revives the window in place); carried so a quiet /healthz says why. */
  idle: boolean;
}

export class HealthMonitor {
  private readonly version: string;
  private readonly keeperPubkey: string;
  private readonly minKeeperBalanceLamports: bigint;
  private readonly dryRun: boolean;
  private readonly startedAtMs: number;
  private server: Server | null = null;
  /** The bound port once `listen` resolves (useful with port 0 in tests). */
  port = 0;

  private tickCount = 0;
  private consecutiveErrors = 0;
  private lastTickAt: string | null = null;
  private lastTickError: string | null = null;
  private lastAction: string | null = null;
  private lastActionAt: string | null = null;
  private balanceLamports: bigint | null = null;
  private chain: ChainClock | null = null;
  private wsConnected = false;
  private trackedRounds: TrackedRoundStatus[] = [];
  private escrowsTracked = 0;
  private escrowsEligible = 0;
  private lastAutoDeposit: LastAutoDepositStatus | null = null;
  private cleanupTxsSent = 0;
  private cleanupLamportsSpentEst = 0n;
  private readonly cleanupPerRound = new Map<string, { txs: number; lamportsEst: bigint }>();
  private stuckCleanupRounds: string[] = [];
  private idle = false;

  constructor(
    version: string,
    keeperPubkey: string,
    minKeeperBalanceLamports: bigint,
    dryRun: boolean,
  ) {
    this.version = version;
    this.keeperPubkey = keeperPubkey;
    this.minKeeperBalanceLamports = minKeeperBalanceLamports;
    this.dryRun = dryRun;
    this.startedAtMs = Date.now();
  }

  /** Record one evaluation-tick outcome (success carries clock + balance). */
  tick(clock: ChainClock | null, balanceLamports: bigint | null, error: string | null): void {
    this.tickCount += 1;
    this.lastTickAt = new Date().toISOString();
    if (error !== null) {
      this.consecutiveErrors += 1;
      this.lastTickError = error;
    } else {
      this.consecutiveErrors = 0;
      this.lastTickError = null;
      if (clock !== null) this.chain = clock;
      if (balanceLamports !== null) this.balanceLamports = balanceLamports;
    }
  }

  /** Record a successfully sent (or dry-run planned) crank action. */
  action(name: string): void {
    this.lastAction = name;
    this.lastActionAt = new Date().toISOString();
  }

  setWsConnected(connected: boolean): void {
    this.wsConnected = connected;
  }

  setTrackedRounds(rounds: TrackedRoundStatus[]): void {
    this.trackedRounds = rounds;
  }

  setEscrows(tracked: number, eligible: number, lastAuto: LastAutoDepositStatus | null): void {
    this.escrowsTracked = tracked;
    this.escrowsEligible = eligible;
    this.lastAutoDeposit = lastAuto;
  }

  /** Books one landed cleanup transaction (fee estimate) against its round. */
  recordCleanupTx(roundId: bigint, feeLamportsEst: bigint): void {
    this.cleanupTxsSent += 1;
    this.cleanupLamportsSpentEst += feeLamportsEst;
    const key = roundId.toString();
    const cur = this.cleanupPerRound.get(key) ?? { txs: 0, lamportsEst: 0n };
    cur.txs += 1;
    cur.lamportsEst += feeLamportsEst;
    this.cleanupPerRound.set(key, cur);
    if (this.cleanupPerRound.size > 16) {
      // Drop the oldest insertion (Map preserves it) — the metric is a window.
      const oldest = this.cleanupPerRound.keys().next().value;
      if (oldest !== undefined) this.cleanupPerRound.delete(oldest);
    }
  }

  /** The stuck-round alert list — non-empty degrades health (Phase 11.8). */
  setCleanupAlerts(roundIds: string[]): void {
    this.stuckCleanupRounds = roundIds;
  }

  /** Phase 12: mark the idle (Open-and-empty active round) state. Never a
   *  degradedReason — an idle keeper is a HEALTHY keeper; this exists so
   *  `curl /healthz` explains the quiet. */
  setIdle(idle: boolean): void {
    this.idle = idle;
  }

  snapshot(): HealthSnapshot {
    const reasons: string[] = [];
    if (this.consecutiveErrors >= 3) {
      reasons.push(`${this.consecutiveErrors} consecutive tick errors`);
    }
    if (
      this.balanceLamports !== null &&
      this.balanceLamports < this.minKeeperBalanceLamports
    ) {
      reasons.push("keeper balance below minimum");
    }
    // AUDIT C-1: a quarantined round is player money nobody is moving.
    const quarantined = this.trackedRounds.filter((r) => r.quarantined === true);
    if (quarantined.length > 0) {
      reasons.push(
        `${quarantined.length} round(s) quarantined (${quarantined.map((r) => r.roundId).join(", ")}) — manual intervention needed`,
      );
    }
    if (this.stuckCleanupRounds.length > 0) {
      reasons.push(
        `${this.stuckCleanupRounds.length} settled round(s) un-pruned past the cleanup alert threshold — player refunds are waiting`,
      );
    }
    return {
      status: this.tickCount === 0 ? "starting" : reasons.length > 0 ? "degraded" : "ok",
      degradedReasons: reasons,
      version: this.version,
      pid: process.pid,
      startedAt: new Date(this.startedAtMs).toISOString(),
      uptimeSec: Math.floor((Date.now() - this.startedAtMs) / 1_000),
      dryRun: this.dryRun,
      keeperPubkey: this.keeperPubkey,
      keeperBalanceLamports: this.balanceLamports === null ? null : String(this.balanceLamports),
      minKeeperBalanceLamports: String(this.minKeeperBalanceLamports),
      consecutiveErrors: this.consecutiveErrors,
      lastTickAt: this.lastTickAt,
      lastTickError: this.lastTickError,
      lastAction: this.lastAction,
      lastActionAt: this.lastActionAt,
      chainSlot: this.chain === null ? null : String(this.chain.slot),
      chainUnix: this.chain === null ? null : String(this.chain.unix),
      chainSkewSec: this.chain === null ? null : this.chain.skewSec,
      wsConnected: this.wsConnected,
      trackedRounds: this.trackedRounds,
      escrowsTracked: this.escrowsTracked,
      escrowsEligible: this.escrowsEligible,
      lastAutoDeposit: this.lastAutoDeposit,
      cleanupTxsSent: this.cleanupTxsSent,
      cleanupLamportsSpentEst: this.cleanupLamportsSpentEst.toString(),
      cleanupPerRound: [...this.cleanupPerRound.entries()].map(([roundId, v]) => ({
        roundId,
        txs: v.txs,
        lamportsEst: v.lamportsEst.toString(),
      })),
      stuckCleanupRounds: this.stuckCleanupRounds,
      idle: this.idle,
    };
  }

  /** Start the HTTP endpoint; resolves once listening. */
  listen(host: string, port: number): Promise<void> {
    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
        const snap = this.snapshot();
        const body = JSON.stringify(snap);
        res.writeHead(snap.status === "degraded" ? 503 : 200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(body);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        const addr = server.address();
        this.port = typeof addr === "object" && addr !== null ? addr.port : port;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err === undefined ? resolve() : reject(err)));
    });
  }
}
