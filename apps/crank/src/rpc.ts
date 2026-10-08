/**
 * The RPC gateway every keeper call goes through:
 *
 * - SERIALIZED + PACED: one RPC call in flight at a time, at least
 *   `paceMs` apart — the public devnet ceiling the phase-8 scripts lived
 *   under (they slept 400 ms after every send).
 * - SELF-HEALING: 429s and transient network errors retry with
 *   exponential backoff + jitter (the scripts' linear `withRetry`,
 *   hardened for unattended operation).
 * - CLOCK: `chainNow()` reads the CHAIN clock (slot → blockTime) with a
 *   short cache, and reports skew vs local time — every `end_ts` /
 *   claim-deadline comparison must use it, never `Date.now()`.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { randomInt } from "node:crypto";
import type { Logger } from "./log";

export interface RpcGatewayOptions {
  /** Minimum gap between RPC call starts (0 disables). */
  paceMs: number;
  /** Cap for the exponential backoff between retries. */
  maxBackoffMs: number;
  /** Total attempts per call before giving up. */
  maxAttempts?: number;
  /** First backoff delay; doubles per attempt up to the cap. */
  baseBackoffMs?: number;
}

/** Errors worth retrying: rate limits and transient transport faults. */
const RETRYABLE =
  /429|too many requests|econnreset|etimedout|eai_again|econnrefused|enotfound|fetch failed|socket hang up|network|service unavailable|bad gateway|timeout/i;

export interface ChainClock {
  slot: bigint;
  unix: bigint;
  /** chain_time − local_time, seconds — positive means chain is ahead. */
  skewSec: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RpcGateway {
  readonly connection: Connection;
  private readonly logger: Logger;
  private readonly paceMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  /** Serializes calls; also carries the pacing reservation. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;
  private clockCache: { atMs: number; clock: ChainClock } | null = null;

  constructor(connection: Connection, logger: Logger, opts: RpcGatewayOptions) {
    this.connection = connection;
    this.logger = logger;
    this.paceMs = opts.paceMs;
    this.maxBackoffMs = opts.maxBackoffMs;
    this.maxAttempts = opts.maxAttempts ?? 8;
    this.baseBackoffMs = opts.baseBackoffMs ?? 600;
  }

  /**
   * Runs `op` through the pace gate and the retry harness. Non-retryable
   * errors (business failures like "blockhash not found" on a stale tx)
   * rethrow immediately — the caller's state machine decides what to do.
   */
  call<T>(label: string, op: () => Promise<T>): Promise<T> {
    const run = this.enqueue(async () => {
      await this.pace();
      return this.withBackoff(label, op);
    });
    return run;
  }

  /** Confirmed slot as bigint (devnet slots ≈ 5×10⁸ — far inside 2⁵³). */
  slot(commitment: "confirmed" | "finalized" = "confirmed"): Promise<bigint> {
    return this.call("getSlot", async () =>
      BigInt(await this.connection.getSlot(commitment)),
    );
  }

  /**
   * The chain clock, cached ~2 s: `end_ts`/deadline comparisons and the
   * create CPI's slot-freshness precheck both read this, never local time.
   */
  async chainNow(commitment: "confirmed" | "finalized" = "confirmed"): Promise<ChainClock> {
    if (this.clockCache !== null && Date.now() - this.clockCache.atMs < 2_000) {
      return this.clockCache.clock;
    }
    const slot = await this.slot(commitment);
    const blockTime = await this.call("getBlockTime", () =>
      this.connection.getBlockTime(Number(slot)),
    );
    if (blockTime === null) {
      throw new Error(`getBlockTime returned null for slot ${slot}`);
    }
    const unix = BigInt(Math.floor(blockTime));
    const clock: ChainClock = {
      slot,
      unix,
      skewSec: Number(unix) - Math.floor(Date.now() / 1_000),
    };
    this.clockCache = { atMs: Date.now(), clock };
    return clock;
  }

  /** Lamport balance at `commitment`, as bigint. */
  balance(pubkey: PublicKey, commitment: "confirmed" | "finalized" = "confirmed"): Promise<bigint> {
    return this.call("getBalance", async () =>
      BigInt(await this.connection.getBalance(pubkey, commitment)),
    );
  }

  /** Invalidate the chain-clock cache (call after long pauses/sleeps). */
  invalidateClock(): void {
    this.clockCache = null;
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Reserves a start slot `paceMs` after the previous call's start. */
  private async pace(): Promise<void> {
    if (this.paceMs === 0) return;
    const now = Date.now();
    const wait = this.lastCallAt + this.paceMs - now;
    this.lastCallAt = Math.max(now, this.lastCallAt + this.paceMs);
    if (wait > 0) await sleep(wait);
  }

  private async withBackoff<T>(label: string, op: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await op();
      } catch (err) {
        lastError = err;
        if (!RETRYABLE.test(String(err))) throw err;
        const delay = Math.min(this.baseBackoffMs * 2 ** (attempt - 1), this.maxBackoffMs);
        const jitter = randomInt(0, Math.max(1, Math.min(delay / 2, 250)));
        this.logger.warn(
          { label, attempt, delayMs: delay + jitter, err: String(err).slice(0, 140) },
          "rpc retry",
        );
        await sleep(delay + jitter);
      }
    }
    throw new Error(
      `rpc ${label} failed after ${this.maxAttempts} attempts: ${String(lastError).slice(0, 200)}`,
    );
  }
}
