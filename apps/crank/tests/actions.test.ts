/**
 * TxExecutor contract tests for the two Phase 10 defect fixes:
 *
 * - a throwing post-landing (`after`) hook must not mark a LANDED
 *   transaction as failed — the settle verifier's RPC backoff can exhaust
 *   long after the settlement itself confirmed;
 * - `quarantineOnFailure: false` opts an action out of round quarantine:
 *   routine contention (auto-deposit entry-index races) must never strand a
 *   live round, because evalSettle/evalCleanup both bail on quarantined
 *   rounds.
 *
 * Driven against in-memory fakes (no Connection, no gateway).
 */

import { expect } from "chai";
import { Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import { TxExecutor, type CrankAction } from "../src/actions";
import type { CrankConfig } from "../src/config";
import { loadConfig } from "../src/config";
import type { HealthMonitor } from "../src/health";
import { createLogger } from "../src/log";
import type { QuarantineBook } from "../src/context";
import type { RpcGateway } from "../src/rpc";

const SILENT = createLogger("silent");
const KEEPER = Keypair.generate();
const SOME_PROGRAM = Keypair.generate().publicKey;
const SIG = "4Rf9W7EvCwJ92npehzWcLQFVh74YEvXWvLzZpNcVhUJmXTb2QoJKnRQ4DPmWoXqkpQTvyMvUuMAUF2CzEuyG5hU";

/** Minimal in-memory QuarantineBook (trimmed from handlers.test.ts). */
class FakeBook implements QuarantineBook {
  readonly quarantines = new Map<string, string>();
  readonly failures = new Map<string, number>();
  readonly actions: Array<Record<string, unknown>> = [];

  isQuarantined(roundId: bigint): string | null {
    return this.quarantines.get(roundId.toString()) ?? null;
  }
  quarantine(roundId: bigint, reason: string): void {
    if (!this.quarantines.has(roundId.toString())) this.quarantines.set(roundId.toString(), reason);
  }
  randomnessKeypair(): Keypair {
    throw new Error("not used in these tests");
  }
  recordFailure(key: string): number {
    const next = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, next);
    return next;
  }
  failureCount(key: string): number {
    return this.failures.get(key) ?? 0;
  }
  resetFailures(key: string): void {
    this.failures.delete(key);
  }
  recordAction(e: Record<string, unknown>): void {
    this.actions.push(e);
  }
  rememberLut(): void {}
  pendingLuts(): Array<{ roundId: bigint; randomness: string; lutSlot: bigint }> {
    return [];
  }
  forgetLut(): void {}
}

/** A gateway whose `call` invokes the op directly (no pacing/backoff). */
function fakeRpc(over: { sendRawTransaction?: () => Promise<string> } = {}): RpcGateway {
  const blockhash = Keypair.generate().publicKey.toBase58(); // any base58 32-byte string
  const connection = {
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1_000 }),
    sendRawTransaction: async () => SIG,
    confirmTransaction: async () => ({ value: { err: null } }),
    ...over,
  };
  return {
    connection,
    chainNow: async () => ({ slot: 123n, unix: 1_700_000_000n, skewSec: 0 }),
    call: (_label: string, op: () => Promise<unknown>) => op(),
  } as unknown as RpcGateway;
}

function fakeHealth(): HealthMonitor {
  return { action: () => undefined } as unknown as HealthMonitor;
}

function tx(): Transaction {
  return new Transaction().add(
    new TransactionInstruction({
      keys: [{ pubkey: KEEPER.publicKey, isSigner: false, isWritable: true }],
      programId: SOME_PROGRAM,
      data: Buffer.alloc(1),
    }),
  );
}

function executor(book: FakeBook, rpc: RpcGateway): TxExecutor {
  const cfg: CrankConfig = loadConfig({});
  return new TxExecutor(rpc, KEEPER, cfg, book, fakeHealth(), SILENT);
}

describe("TxExecutor post-landing hooks", () => {
  it("a throwing after-hook does not fail a landed action", async () => {
    const book = new FakeBook();
    const exec = executor(book, fakeRpc());
    let seenSig: string | null = null;
    const sig = await exec.dispatch({
      kind: "fulfill_settle",
      roundId: 2n,
      label: "settle",
      build: () => tx(),
      // verifySettlement's shape: documented non-fatal, but its RPC calls
      // throw after exhausted backoff.
      after: async (s) => {
        seenSig = s;
        throw new Error("rpc verify failed after 6 attempts");
      },
    });
    expect(sig).to.equal(SIG);
    expect(seenSig).to.equal(SIG);
    // Landed, not failed: no streak entry, and the action is recorded.
    expect(book.failures.size).to.equal(0);
    expect(book.actions).to.have.lengthOf(1);
    expect(book.actions[0]).to.include({ kind: "fulfill_settle", sig: SIG });
  });

  it("a healthy after-hook still runs and observes the signature", async () => {
    const book = new FakeBook();
    const exec = executor(book, fakeRpc());
    let seen: string | null = null;
    const sig = await exec.dispatch({
      kind: "fulfill_settle",
      roundId: 2n,
      label: "settle",
      build: () => tx(),
      after: async (s) => {
        seen = s;
      },
    });
    expect(sig).to.equal(SIG);
    expect(seen).to.equal(SIG);
  });
});

describe("TxExecutor quarantine opt-out", () => {
  const ALWAYS_FAILS = { sendRawTransaction: (): Promise<string> => Promise.reject(new Error("Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1770")) };

  async function dispatchFive(exec: TxExecutor, action: () => CrankAction): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      let threw: unknown = null;
      try {
        await exec.dispatch(action());
      } catch (err) {
        threw = err;
      }
      expect(String(threw)).to.match(/custom program error/);
    }
  }

  it("quarantineOnFailure: false keeps the streak but never quarantines the round", async () => {
    const book = new FakeBook();
    const exec = executor(book, fakeRpc(ALWAYS_FAILS));
    await dispatchFive(exec, () => ({
      kind: "close_entry",
      roundId: 7n,
      label: "cleanup",
      build: () => tx(),
      quarantineOnFailure: false,
    }));
    // The failure streak is still bookkept (observability)…
    expect(book.failures.get("close_entry:7")).to.equal(5);
    // …but the round is not quarantined — a live pot must not be stranded.
    expect(book.isQuarantined(7n)).to.equal(null);
  });

  it("default actions still quarantine at the streak threshold", async () => {
    const book = new FakeBook();
    const exec = executor(book, fakeRpc(ALWAYS_FAILS));
    await dispatchFive(exec, () => ({
      kind: "close_entry",
      roundId: 7n,
      label: "cleanup",
      build: () => tx(),
    }));
    expect(book.isQuarantined(7n)).to.be.a("string").and.to.match(/failed 5 consecutive times/);
  });
});
