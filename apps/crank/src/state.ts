/**
 * Persistent crank state under `CRANK_STATE_DIR` (default `var/`):
 *
 *   state.json              quarantined rounds + per-action failure streaks
 *   keys/randomness-N.json  per-round randomness keypairs (0600) — created
 *                           BEFORE the first create_randomness send, so a
 *                           crash can never orphan the account's signer
 *   actions.jsonl           append-only audit trail (ts, kind, round, sig)
 *
 * Round-tracking itself is derived from chain state on every reconcile —
 * this file only carries what the chain cannot reconstruct.
 */

import { Keypair } from "@solana/web3.js";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Logger } from "./log";

/**
 * Durable JSON write: temp file → fsync → rename, so a crash or full disk
 * mid-write can never leave a truncated file behind (a truncated
 * `state.json` would discard the quarantine list and the failure streaks —
 * the keeper would resume burning fees on a round a human decided broken).
 */
export function atomicWriteJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

interface PersistedState {
  /** roundId → quarantine reason. */
  quarantined: Record<string, string>;
  /** action key ("kind:roundId") → consecutive failure count. */
  failures: Record<string, number>;
  /**
   * Phase 13: roundId → the LUT to close after its cooldown. The lut_slot
   * lives only in the randomness account, which close_randomness deletes,
   * so it is copied here first.
   */
  pendingLuts: Record<string, { randomness: string; lutSlot: string }>;
}

/** A FRESH empty state each time — the store mutates its maps in place. */
const empty = (): PersistedState => ({ quarantined: {}, failures: {}, pendingLuts: {} });

export class StateStore {
  private readonly dir: string;
  private readonly logger: Logger;
  private data: PersistedState = empty();

  constructor(dir: string, logger: Logger) {
    this.dir = dir;
    this.logger = logger;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, "state.json");
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedState>;
        this.data = {
          quarantined: parsed.quarantined ?? {},
          failures: parsed.failures ?? {},
          pendingLuts: parsed.pendingLuts ?? {},
        };
      } catch (err) {
        // A corrupt state file must not brick the keeper: start clean and
        // keep the broken file around for forensics.
        const backup = `${file}.corrupt-${Date.now()}`;
        try {
          writeFileSync(backup, readFileSync(file, "utf8"));
        } catch {
          // best-effort backup only
        }
        this.logger.error({ event: "state_corrupt", file, backup, err: String(err).slice(0, 160) }, "state.json unreadable — starting clean");
        this.data = empty();
      }
    }
  }

  /** The round's randomness keypair — load-or-create, persisted first. */
  randomnessKeypair(roundId: bigint): Keypair {
    const id = roundId.toString();
    if (!/^\d+$/.test(id)) throw new Error(`illegal round id ${id}`);
    const keysDir = join(this.dir, "keys");
    if (!existsSync(keysDir)) mkdirSync(keysDir, { recursive: true });
    const file = join(keysDir, `randomness-${id}.json`);
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(parsed));
    }
    const kp = Keypair.generate();
    // AUDIT C-7: created 0600 from the first byte, fsynced, then renamed —
    // a crash can never leave a truncated key file (or a readable one).
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(Array.from(kp.secretKey)));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    this.logger.info({ event: "randomness_keypair_created", roundId: id, pubkey: kp.publicKey.toBase58() }, "persisted per-round randomness keypair");
    return kp;
  }

  rememberLut(roundId: bigint, randomness: string, lutSlot: bigint): void {
    const id = roundId.toString();
    const existing = this.data.pendingLuts[id];
    if (existing !== undefined && existing.randomness === randomness && existing.lutSlot === lutSlot.toString()) return;
    this.data.pendingLuts[id] = { randomness, lutSlot: lutSlot.toString() };
    this.persist();
  }

  pendingLuts(): Array<{ roundId: bigint; randomness: string; lutSlot: bigint }> {
    return Object.entries(this.data.pendingLuts)
      .map(([id, v]) => ({ roundId: BigInt(id), randomness: v.randomness, lutSlot: BigInt(v.lutSlot) }))
      .sort((a, b) => (a.roundId < b.roundId ? -1 : a.roundId > b.roundId ? 1 : 0));
  }

  forgetLut(roundId: bigint): void {
    const id = roundId.toString();
    if (this.data.pendingLuts[id] === undefined) return;
    delete this.data.pendingLuts[id];
    this.persist();
  }

  isQuarantined(roundId: bigint): string | null {
    return this.data.quarantined[roundId.toString()] ?? null;
  }

  quarantine(roundId: bigint, reason: string): void {
    const id = roundId.toString();
    if (this.data.quarantined[id] !== undefined) return;
    this.data.quarantined[id] = reason;
    this.persist();
    this.logger.error({ event: "round_quarantined", roundId: id, reason }, "round quarantined — manual intervention required (remove from state.json to retry)");
  }

  /** Bumps the action's failure streak; returns the new count. */
  recordFailure(key: string): number {
    const next = (this.data.failures[key] ?? 0) + 1;
    this.data.failures[key] = next;
    this.persist();
    return next;
  }

  resetFailures(key: string): void {
    if (this.data.failures[key] === undefined) return;
    delete this.data.failures[key];
    this.persist();
  }

  /** Current streak of an action key (0 = clean) — read-only. */
  failureCount(key: string): number {
    return this.data.failures[key] ?? 0;
  }

  /** Append-only audit line for every sent (or dry-run planned) action. */
  recordAction(entry: { kind: string; roundId?: string; sig?: string; dryRun?: boolean; note?: string }): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    try {
      appendFileSync(join(this.dir, "actions.jsonl"), `${line}\n`);
    } catch (err) {
      this.logger.warn({ err: String(err).slice(0, 120) }, "actions.jsonl append failed");
    }
  }

  private persist(): void {
    atomicWriteJson(join(this.dir, "state.json"), this.data);
  }
}
