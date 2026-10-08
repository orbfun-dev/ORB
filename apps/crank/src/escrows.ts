/**
 * The escrow registry (Phase 10 design §5.1–§5.2): which escrows exist,
 * which are worth reading this round, and nothing else.
 *
 * Discovery mirrors the monitor's own posture — events accelerate,
 * reconciliation decides:
 *  1. PRIMARY — the `EscrowFunded` event feed (`noteFunded`): covers every
 *     escrow created while the keeper is up.
 *  2. RECONCILE — one bounded GPA at boot and every
 *     `CRANK_ESCROW_RECONCILE_MS` (`{ dataSize: 122 }` — unambiguous, no
 *     other account is 122 bytes). On refusal (public-RPC policy / rate
 *     limit) the registry is kept as-is: a missed log is a latency
 *     problem, never a correctness one.
 *  3. SEED — `CRANK_ESCROW_SEED` escrow/owner pubkeys, for recovery and
 *     for operators who disable GPA entirely.
 *
 * Per-round reads go through `ChainReader.accountsWithLamports` (chunked
 * `getMultipleAccounts`, 100 per call) — GPA never runs in the hot path.
 * Dormant escrows (budget exhausted, balance too low) back off via
 * `dormantUntilTick` so a thousand depleted escrows cost nothing per
 * round. State persists to `var/escrows.json` with the same atomic
 * temp-then-rename write as `state.json`.
 */

import {
  ACCOUNT_SIZES,
  decodePlayerEscrow,
  escrowKey as escrowKeyOf,
  PROGRAM_ID,
  type GlobalConfigData,
  type PlayerEscrowData,
  type RoundData,
} from "@orbit-jackpot/sdk";
import { PublicKey } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CrankConfig } from "./config";
import type { EscrowCandidate, EscrowRegistry, LastAutoDepositStatus } from "./context";
import { isEligible } from "./handlers/auto_deposit";
import type { Logger } from "./log";
import type { ChainReader } from "./reader";
import type { ChainClock, RpcGateway } from "./rpc";
import { atomicWriteJson } from "./state";

interface EscrowRecord {
  /** The escrow PDA (base58). */
  key: string;
  /** The owner wallet (base58); empty for seed entries not yet read. */
  owner: string;
  lastSeenSlot: bigint;
  /** Skip reads until this `Date.now()` tick — dormancy backoff. */
  dormantUntilTick: number;
}

interface PersistedEscrows {
  escrows: EscrowRecord[];
}

export class FileEscrowRegistry implements EscrowRegistry {
  private readonly reader: ChainReader;
  private readonly rpc: RpcGateway;
  private readonly cfg: CrankConfig;
  private readonly logger: Logger;
  private readonly file: string;
  private readonly records = new Map<string, EscrowRecord>();
  private readonly rentCache = new Map<number, bigint>();
  private lastEligible = 0;
  private lastAuto: LastAutoDepositStatus | null = null;
  private lastScanAt = 0;

  constructor(dir: string, reader: ChainReader, rpc: RpcGateway, cfg: CrankConfig, logger: Logger) {
    this.reader = reader;
    this.rpc = rpc;
    this.cfg = cfg;
    this.logger = logger;
    this.file = join(dir, "escrows.json");
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PersistedEscrows>;
        for (const rec of parsed.escrows ?? []) {
          // bigint does not survive JSON; round-trip through string.
          this.records.set(rec.key, {
            ...rec,
            lastSeenSlot: BigInt(rec.lastSeenSlot ?? 0),
          });
        }
      } catch (err) {
        // Same posture as StateStore: a corrupt file must not brick the
        // keeper — start empty and let reconciliation rebuild.
        this.logger.error(
          { event: "escrows_corrupt", file: this.file, err: String(err).slice(0, 160) },
          "escrows.json unreadable — rebuilding from reconciliation",
        );
      }
    }
  }

  /** Event-feed hook: an `EscrowFunded` was observed on chain. */
  noteFunded(escrow: PublicKey, owner: PublicKey): void {
    const key = escrow.toBase58();
    const existing = this.records.get(key);
    if (existing !== undefined) {
      existing.owner = owner.toBase58();
      // Fresh funding always ends dormancy.
      existing.dormantUntilTick = 0;
      this.persist();
      return;
    }
    this.records.set(key, {
      key,
      owner: owner.toBase58(),
      lastSeenSlot: 0n,
      dormantUntilTick: 0,
    });
    this.persist();
    this.logger.info(
      { event: "escrow_funded", escrow: key, owner: owner.toBase58() },
      "escrow registered from event feed",
    );
  }

  /**
   * Bounded GPA reconcile: `{ dataSize: 122 }` alone (no other account is
   * 122 bytes). Refusal keeps the registry — logged, never thrown, so a
   * public RPC's GPA policy degrades discovery latency, not correctness.
   */
  async reconcile(): Promise<void> {
    if (this.cfg.escrowGpaEnabled) {
      try {
        const accounts = await this.rpc.call("escrowGPA", () =>
          this.rpc.connection.getProgramAccounts(PROGRAM_ID, {
            filters: [{ dataSize: ACCOUNT_SIZES.PlayerEscrow! }],
          }),
        );
        let added = 0;
        for (const { pubkey, account } of accounts) {
          const key = pubkey.toBase58();
          const data = decodePlayerEscrow(account.data);
          const rec = this.records.get(key);
          if (rec === undefined) {
            this.records.set(key, {
              key,
              owner: data.owner,
              lastSeenSlot: 0n,
              dormantUntilTick: 0,
            });
            added += 1;
          } else {
            rec.owner = data.owner;
          }
        }
        if (added > 0) {
          this.persist();
          this.logger.info(
            { event: "escrow_reconcile", added, total: this.records.size },
            "escrow registry reconciled via GPA",
          );
        }
      } catch (err) {
        // The phase-8 lesson: public RPCs refuse or throttle GPA. Keep the
        // registry; the seed list and the event feed still cover discovery.
        this.logger.warn(
          { event: "escrow_gpa_refused", err: String(err).slice(0, 160) },
          "getProgramAccounts refused — keeping the registry as-is",
        );
      }
    }
    // The seed list is unconditional: recovery and no-GPA operators.
    const seed = this.cfg.escrowSeed.trim();
    if (seed !== "") {
      for (const part of seed.split(",")) {
        const raw = part.trim();
        if (raw === "") continue;
        let asKey: PublicKey;
        try {
          asKey = new PublicKey(raw);
        } catch {
          this.logger.warn({ event: "escrow_seed_invalid", value: raw.slice(0, 44) }, "seed entry is not a pubkey");
          continue;
        }
        // Owner-shaped seeds derive the escrow PDA; escrow-shaped seeds
        // are registered as-is (the owner fills in on the next read).
        const derived = escrowKeyOf(asKey);
        const isEscrowPda = derived.toBase58() === raw;
        const addr = isEscrowPda ? asKey : derived;
        if (!this.records.has(addr.toBase58())) {
          this.records.set(addr.toBase58(), {
            key: addr.toBase58(),
            owner: isEscrowPda ? "" : raw,
            lastSeenSlot: 0n,
            dormantUntilTick: 0,
          });
          this.persist();
        }
      }
    }
  }

  /**
   * Batched per-round read (never GPA) + the pure eligibility filter.
   * Escrows that are hard-dormant (no budget, no balance) back off until
   * the next reconcile interval — they cannot become eligible without an
   * external event (claim, refund, re-fund), all of which the feed sees.
   */
  async eligible(
    round: RoundData,
    config: GlobalConfigData,
    clock: ChainClock,
    entryRent: bigint,
    escrowRentMin: bigint,
  ): Promise<EscrowCandidate[]> {
    const now = Date.now();
    const candidates = [...this.records.values()].filter((r) => r.dormantUntilTick <= now);
    if (candidates.length === 0) {
      this.lastEligible = 0;
      this.lastScanAt = now;
      return [];
    }
    const infos = await this.reader.accountsWithLamports(
      candidates.map((r) => new PublicKey(r.key)),
    );
    const out: EscrowCandidate[] = [];
    for (const rec of candidates) {
      const info = infos.get(rec.key) ?? null;
      if (info === null) {
        // The escrow no longer exists (cannot happen in v1 — no close —
        // but a read hole must not crash the scan).
        continue;
      }
      let data: PlayerEscrowData;
      try {
        data = decodePlayerEscrow(info.data);
      } catch {
        continue; // foreign account at a seeded address
      }
      if (isEligible(data, info.lamports, round, config, clock, entryRent, escrowRentMin)) {
        out.push({ key: new PublicKey(rec.key), owner: new PublicKey(data.owner), data });
        continue;
      }
      // Hard dormancy: no budget or no balance ⇒ skip reads until the
      // next reconcile window. Everything else (window, round id) is
      // round-scoped, not escrow-scoped — retry next round.
      const roundCost = data.perRoundLamports + entryRent + config.autoDepositTipLamports;
      if (data.roundsRemaining === 0 || info.lamports - escrowRentMin < roundCost) {
        rec.dormantUntilTick = now + this.cfg.escrowReconcileMs;
        this.persist();
      }
    }
    this.lastEligible = out.length;
    this.lastScanAt = now;
    return out;
  }

  async anyArmed(
    config: GlobalConfigData,
    entryRent: bigint,
    escrowRentMin: bigint,
  ): Promise<boolean> {
    const now = Date.now();
    // Dormant escrows (no budget / no balance) were already read and
    // parked until the next reconcile — they cannot be armed.
    const candidates = [...this.records.values()].filter((r) => r.dormantUntilTick <= now);
    if (candidates.length === 0) return false;
    const infos = await this.reader.accountsWithLamports(
      candidates.map((r) => new PublicKey(r.key)),
    );
    let armed = false;
    for (const rec of candidates) {
      const info = infos.get(rec.key) ?? null;
      if (info === null) continue;
      let data: PlayerEscrowData;
      try {
        data = decodePlayerEscrow(info.data);
      } catch {
        continue;
      }
      const roundCost = data.perRoundLamports + entryRent + config.autoDepositTipLamports;
      if (data.roundsRemaining > 0 && info.lamports - escrowRentMin >= roundCost) {
        armed = true;
        continue;
      }
      if (data.roundsRemaining === 0 || info.lamports - escrowRentMin < roundCost) {
        rec.dormantUntilTick = now + this.cfg.escrowReconcileMs;
        this.persist();
      }
    }
    return armed;
  }

  size(): number {
    return this.records.size;
  }

  lastEligibleCount(): number {
    return this.lastEligible;
  }

  lastAutoDeposit(): LastAutoDepositStatus | null {
    return this.lastAuto;
  }

  noteAutoDeposit(roundId: bigint, count: number): void {
    this.lastAuto = { roundId: roundId.toString(), count, at: new Date().toISOString() };
  }

  autoDepositDue(intervalMs: number): boolean {
    return Date.now() - this.lastScanAt >= intervalMs;
  }

  /** Rent-exempt minimum per data length, memoized (stable per cluster). */
  async rentMinimumFor(dataLen: number): Promise<bigint> {
    const cached = this.rentCache.get(dataLen);
    if (cached !== undefined) return cached;
    const lamports = await this.rpc.call(`rentMin:${dataLen}`, () =>
      this.rpc.connection.getMinimumBalanceForRentExemption(dataLen),
    );
    const value = BigInt(lamports);
    this.rentCache.set(dataLen, value);
    return value;
  }

  private persist(): void {
    atomicWriteJson(this.file, {
      escrows: [...this.records.values()].map((r) => ({
        ...r,
        lastSeenSlot: r.lastSeenSlot.toString(),
      })),
    });
  }
}
