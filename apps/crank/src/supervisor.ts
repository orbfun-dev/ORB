/**
 * The supervisor: one evaluation tick at a time, woken by WebSocket
 * account changes (fast path) or the polling floor (correctness
 * guarantee). Ticks never overlap; a wake during a running tick re-runs
 * immediately after.
 *
 * Phase 12 idle behaviour: while the active round is Open and empty, the
 * keeper has NOTHING to do — the program revives the window on the first
 * bet — so the poll floor doubles up to `CRANK_IDLE_POLL_MAX_MS` and the
 * daemon sends zero transactions. Any activity (an action, a tick error,
 * a WebSocket wake — a deposit always wakes the watcher) restores the
 * active floor instantly.
 *
 * Action priority per tick — most time-critical first:
 *   1. lock   — the expiring window unblocks everything else
 *   2. auto_deposit — its window expires too (start + config window),
 *      while nothing else in the chain is window-bound; sitting above
 *      rollover means the tick that OPENS a round still reaches it, since
 *      the loop re-evaluates after each landing
 *   3. rollover — reopen the deposit window (round N+1 may collect while
 *      N settles; the protocol is built for the overlap)
 *   4. settle — the tri-step pipeline, oldest round first
 *   5. cleanup — deadline-driven, never urgent
 *
 * At most `cap` actions per tick (8 live, 1 dry-run), each followed by a
 * targeted re-read of the round it touched, so the next evaluation sees
 * the post-action chain state. A failed action ends the tick's action
 * chain — every step is state-gated on-chain, so the next tick re-derives
 * exactly what to retry.
 */

import type { GlobalConfigData } from "@orbit-jackpot/sdk";
import { Keypair } from "@solana/web3.js";
import type { CrankAction } from "./actions";
import { TxExecutor } from "./actions";
import type { CrankConfig } from "./config";
import type { HandlerCtx } from "./context";
import type { HealthMonitor } from "./health";
import type { Logger } from "./log";
import type { RoundMonitor } from "./monitor";
import type { ChainClock, RpcGateway } from "./rpc";
import type { StateStore } from "./state";
import { evalRollover } from "./handlers/rollover";
import { evalLock } from "./handlers/lock";
import { evalAutoDeposit } from "./handlers/auto_deposit";
import { evalSettle } from "./handlers/settle";
import { evalCleanup } from "./handlers/cleanup";
import { evalLutSweep } from "./handlers/lut";

const MAX_ACTIONS_PER_TICK = 8;

/** The health floor needs minute-scale freshness, not per-tick reads —
 * one balance probe per minute keeps the at-rest RPC diet tiny. */
const BALANCE_CACHE_MS = 60_000;

/**
 * The Phase 12 idle poll ladder — pure so the growth/reset/cap contract is
 * unit-testable without the loop. While the world stays idle (a tick
 * produced no action AND the active round is Open and empty), `bump()`
 * doubles the wait toward the ceiling; `reset()` snaps back to the active
 * floor the instant anything happens — an action fired, a tick errored,
 * or the WebSocket watcher woke the loop (a deposit always wakes the
 * keeper immediately; that is what keeps the backoff safe).
 */
export class IdleBackoff {
  private waitMs: number;

  constructor(
    private readonly floorMs: number,
    private readonly maxMs: number,
  ) {
    this.waitMs = floorMs;
  }

  /** The wait currently in effect. */
  current(): number {
    return this.waitMs;
  }

  /** The world stayed idle: double toward the ceiling, return the next wait. */
  bump(): number {
    this.waitMs = Math.min(this.waitMs * 2, this.maxMs);
    return this.waitMs;
  }

  /** Something happened: back to the active floor. */
  reset(): number {
    this.waitMs = this.floorMs;
    return this.waitMs;
  }
}

export interface SupervisorDeps {
  cfg: CrankConfig;
  logger: Logger;
  rpc: RpcGateway;
  keeper: Keypair;
  monitor: RoundMonitor;
  state: StateStore;
  health: HealthMonitor;
  executor: TxExecutor;
  ctx: HandlerCtx;
}

export class Supervisor {
  private readonly deps: SupervisorDeps;
  private ticking = false;
  private wakePending = false;
  private stopping = false;
  private wakeResolve: (() => void) | null = null;
  private lastPausedLogAt = 0;
  private lastLowBalanceWarnAt = 0;
  private cachedBalance: bigint | null = null;
  private cachedBalanceAt = 0;
  private readonly idleBackoff: IdleBackoff;
  /** Set by each tick: did the keeper DO anything (or hit an error)? Any
   * activity resets the idle ladder — only a quiet, empty world backs off. */
  private lastTickActed = true;

  constructor(deps: SupervisorDeps) {
    this.deps = deps;
    this.idleBackoff = new IdleBackoff(deps.cfg.pollIntervalMs, deps.cfg.idlePollMaxMs);
  }

  /** Wake request from the watcher (WS) — coalesced, never overlaps a tick.
   * A wake means the world moved (a deposit, a settle, anything): the idle
   * ladder resets so the keeper reacts at full pace immediately. */
  wake(): void {
    this.idleBackoff.reset();
    if (this.stopping) return;
    if (this.ticking) {
      this.wakePending = true;
      return;
    }
    if (this.wakeResolve !== null) {
      const resolve = this.wakeResolve;
      this.wakeResolve = null;
      resolve();
    } else {
      void this.tick();
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.wakeResolve !== null) {
      const resolve = this.wakeResolve;
      this.wakeResolve = null;
      resolve();
    }
  }

  /** Main loop: bootstrap → { tick, wait for wake or poll floor }. While
   * idle (no action AND an Open-and-empty active round) the poll floor
   * doubles up to `CRANK_IDLE_POLL_MAX_MS`; any activity — an action, a
   * tick error, a WebSocket wake — restores the active floor instantly. */
  async run(): Promise<void> {
    await this.deps.monitor.bootstrap();
    this.deps.logger.info(
      {
        tracked: this.deps.monitor.trackedIds().map(String),
        activeRoundId: String(this.deps.monitor.config?.activeRoundId ?? "?"),
      },
      "bootstrap complete — tracking rounds",
    );
    while (!this.stopping) {
      await this.tick();
      if (this.stopping) break;
      const waitMs = this.activeRoundIdle()
        ? this.idleBackoff.bump()
        : this.idleBackoff.reset();
      await this.waitForWake(waitMs);
    }
  }

  /** True when the tracked active round is Open and holds no money — the
   * Phase 12 idle state in which the keeper has nothing whatsoever to do
   * (the first bettor revives the window without us). Only trust this for
   * poll-scaling while the WebSocket watcher is LIVE: a dropped watcher
   * means no push will ever announce the reviving deposit, so the loop
   * must keep polling at the active floor or the auto-deposit window
   * (start + CRANK window) could pass unnoticed. */
  private activeRoundIdle(): boolean {
    if (this.lastTickActed) return false;
    if (!this.deps.monitor.watcherActive()) return false;
    const config = this.deps.monitor.config;
    if (config === null) return false;
    const active = this.deps.monitor.round(config.activeRoundId);
    return active !== null && active.state === "open" && active.totalLamports === 0n;
  }

  private waitForWake(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeResolve = null;
        resolve();
      }, timeoutMs);
      this.wakeResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.ticking) {
      this.wakePending = true;
      return;
    }
    this.ticking = true;
    const { logger, health } = this.deps;
    try {
      await this.tickInner();
    } catch (err) {
      // The wake path fires ticks detached (`void this.tick()`); an
      // exhausted-backoff throw from the clock/balance probes must land
      // HERE, not as an unhandled rejection that kills the process.
      const message = String(err).slice(0, 300);
      logger.error({ event: "tick_error", err: message }, "tick failed");
      health.tick(null, null, message);
      // Fail-active: never let an erroring tick stretch the poll interval.
      this.lastTickActed = true;
    } finally {
      this.ticking = false;
      if (this.wakePending) {
        this.wakePending = false;
        void this.tick();
      }
    }
  }

  private async tickInner(): Promise<void> {
    const { logger, rpc, health, monitor, cfg, keeper, state, ctx } = this.deps;
    const clock = await rpc.chainNow();
    let balance: bigint;
    if (this.cachedBalance !== null && Date.now() - this.cachedBalanceAt <= BALANCE_CACHE_MS) {
      balance = this.cachedBalance;
    } else {
      balance = await rpc.balance(keeper.publicKey);
      this.cachedBalance = balance;
      this.cachedBalanceAt = Date.now();
    }
    let tickError: string | null = null;
    try {
      await monitor.refresh();
      this.lastTickActed = await this.runActions(clock);
    } catch (err) {
      tickError = String(err).slice(0, 300);
      logger.error({ event: "tick_error", err: tickError }, "tick failed");
    }
    health.tick(tickError === null ? clock : null, balance, tickError);
    health.setWsConnected(monitor.watcherActive());
    health.setTrackedRounds(monitor.statusRows((id) => state.isQuarantined(id)));
    // Phase 12: an Open-and-empty active round is the IDLE state — healthy
    // by definition (the first bettor revives the window in place; the
    // keeper owes the world zero transactions). Surface it so a quiet
    // /healthz explains itself.
    const configNow = monitor.config;
    const activeNow =
      configNow === null ? null : monitor.round(configNow.activeRoundId);
    health.setIdle(
      activeNow !== null && activeNow.state === "open" && activeNow.totalLamports === 0n,
    );
    // Phase 11.8: un-pruned settled rounds mean player refunds are stuck —
    // escalates to degraded health past the configured threshold.
    health.setCleanupAlerts(
      clock === null ? [] : monitor.stuckSettled(ctx.cfg.stuckCleanupAlertSecs, clock.unix),
    );
    health.setEscrows(
      ctx.escrows.size(),
      ctx.escrows.lastEligibleCount(),
      ctx.escrows.lastAutoDeposit(),
    );
    const dueForLowBalanceWarn =
      balance < cfg.minKeeperBalanceLamports && Date.now() - this.lastLowBalanceWarnAt > 300_000;
    if (dueForLowBalanceWarn) {
      this.lastLowBalanceWarnAt = Date.now();
      logger.warn(
        {
          event: "keeper_balance_low",
          balanceLamports: String(balance),
          minLamports: String(cfg.minKeeperBalanceLamports),
        },
        "keeper wallet below minimum — top up before it cannot fund crank transactions",
      );
    }
  }

  /** Runs the action chain; returns whether the keeper DID anything (any
   * action produced — dispatched or failed — counts as activity for the
   * idle ladder: the world moved, or at least demanded attention). */
  private async runActions(clock: ChainClock): Promise<boolean> {
    const { monitor, logger, cfg } = this.deps;
    const cap = cfg.dryRun ? 1 : MAX_ACTIONS_PER_TICK;
    for (let i = 0; i < cap; i += 1) {
      // Re-read each iteration: a landed action (open_round) advances the
      // config, and evaluating against a stale snapshot double-fires.
      const config = monitor.config;
      if (config === null) {
        logger.warn("program not initialized (no GlobalConfig) — idling");
        return false;
      }
      if (config.paused) {
        const shouldLogPause = Date.now() - this.lastPausedLogAt > 300_000;
        if (shouldLogPause) {
          this.lastPausedLogAt = Date.now();
          logger.warn({ event: "paused" }, "protocol paused — idling until unpaused");
        }
        return false;
      }
      const action = await this.nextAction(config, clock);
      if (action === null) return false;
      try {
        await this.deps.executor.dispatch(action);
      } catch (err) {
        const message = String(err).slice(0, 300);
        const round = action.roundId === undefined ? null : action.roundId.toString();
        logger.error(
          { event: "action_failed", kind: action.kind, roundId: round, err: message },
          "action failed — re-evaluating next tick",
        );
        return true;
      }
      const target = action.roundId ?? monitor.config?.activeRoundId;
      if (target !== null && target !== undefined) await monitor.refreshRound(target);
    }
    return true;
  }

  private async nextAction(config: GlobalConfigData, clock: ChainClock): Promise<CrankAction | null> {
    const { monitor, ctx } = this.deps;

    // 1. lock due windows (time-critical; at most one Open round exists)
    for (const id of monitor.trackedIds()) {
      const round = monitor.round(id);
      if (round === null || round.state !== "open") continue;
      const action = await evalLock(ctx, config, round, clock);
      if (action !== null) return action;
    }

    // 2. auto-deposit the open round's eligible escrows — the window gate
    //    is `start_ts + auto_deposit_window_secs`, so this outranks
    //    rollover: the tick that opens a round re-evaluates and reaches
    //    auto-deposit immediately, inside the window.
    const active = monitor.round(config.activeRoundId);
    if (active !== null && active.state === "open") {
      const action = await evalAutoDeposit(ctx, config, active, clock);
      if (action !== null) return action;
    }

    // 3. keep the deposit window open
    const rollover = evalRollover(ctx, config, active);
    if (rollover !== null) return rollover;

    // 4. settle pending rounds, oldest first
    const ascending = [...monitor.trackedIds()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const id of ascending) {
      const round = monitor.round(id);
      if (round === null) continue;
      if (round.state !== "locked" && round.state !== "awaitingRandomness") continue;
      const action = await evalSettle(ctx, config, round, clock);
      if (action !== null) return action;
    }

    // 5. cleanup terminal rounds
    for (const id of ascending) {
      const round = monitor.round(id);
      if (round === null) continue;
      if (round.state !== "settled" && round.state !== "cancelled") continue;
      const action = await evalCleanup(ctx, config, round, clock);
      if (action !== null) return action;
    }

    // 6. reclaim deactivated randomness lookup tables (Phase 13)
    return evalLutSweep(ctx, config, clock);
  }
}
