/**
 * Audit 2026-10-08 — failing tests for the crank findings in
 * docs/AUDIT_REPORT.md (C-1, C-2). Each test states the behaviour the
 * keeper MUST have on mainnet; today each fails.
 */

import { expect } from "chai";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Gateway } from "@switchboard-xyz/common";
import { TxExecutor } from "../src/actions";
import { loadConfig, type CrankConfig } from "../src/config";
import type { HealthMonitor } from "../src/health";
import { createLogger } from "../src/log";
import type { QuarantineBook } from "../src/context";
import type { RpcGateway } from "../src/rpc";
import { SwitchboardCtx } from "../src/randomness";

const SILENT = createLogger("silent");
const KEEPER = Keypair.generate();

class FakeBook implements QuarantineBook {
  readonly quarantines = new Map<string, string>();
  readonly failures = new Map<string, number>();
  isQuarantined(roundId: bigint): string | null {
    return this.quarantines.get(roundId.toString()) ?? null;
  }
  quarantine(roundId: bigint, reason: string): void {
    if (!this.quarantines.has(roundId.toString())) this.quarantines.set(roundId.toString(), reason);
  }
  randomnessKeypair(): Keypair {
    throw new Error("unused");
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
  recordAction(): void {}
  rememberLut(): void {}
  pendingLuts(): Array<{ roundId: bigint; randomness: string; lutSlot: bigint }> {
    return [];
  }
  forgetLut(): void {}
}

function transportFailingRpc(message: string): RpcGateway {
  const blockhash = Keypair.generate().publicKey.toBase58();
  const connection = {
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 1_000 }),
    sendRawTransaction: async () => {
      throw new Error(message);
    },
    confirmTransaction: async () => ({ value: { err: null } }),
  };
  return {
    connection,
    chainNow: async () => ({ slot: 123n, unix: 1_700_000_000n, skewSec: 0 }),
    call: (_label: string, op: () => Promise<unknown>) => op(),
  } as unknown as RpcGateway;
}

function tx(): Transaction {
  return new Transaction().add(
    new TransactionInstruction({
      keys: [{ pubkey: KEEPER.publicKey, isSigner: false, isWritable: true }],
      programId: Keypair.generate().publicKey,
      data: Buffer.alloc(1),
    }),
  );
}

describe("AUDIT C-1 — transport failures never quarantine a live round", () => {
  for (const message of [
    "TransactionExpiredBlockheightExceededError: Signature abc has expired: block height exceeded.",
    "fetch failed",
    "429 Too Many Requests",
  ]) {
    it(`five consecutive "${message.slice(0, 32)}…" failures leave the round un-quarantined`, async () => {
      const book = new FakeBook();
      const cfg: CrankConfig = loadConfig({});
      const exec = new TxExecutor(
        transportFailingRpc(message),
        KEEPER,
        cfg,
        book,
        { action: () => undefined } as unknown as HealthMonitor,
        SILENT,
      );
      for (let i = 0; i < 6; i += 1) {
        await exec
          .dispatch({ kind: "reveal_randomness", roundId: 7n, label: "reveal", build: () => tx() })
          .catch(() => undefined);
      }
      // A quarantined AwaitingRandomness round is player money frozen until a
      // hand-rolled transaction: only a deterministic on-chain refusal may
      // earn that, never congestion or an RPC blip.
      expect(book.isQuarantined(7n), "round must stay live").to.equal(null);
    });
  }
});

describe("AUDIT C-2 — the gateway reveal fetch is bounded in time", () => {
  it("returns within a budget when the gateway accepts the request and never answers", async function () {
    this.timeout(20_000);
    const original = Gateway.prototype.fetchRandomnessReveal;
    Gateway.prototype.fetchRandomnessReveal = () => new Promise(() => undefined); // hangs forever
    try {
      const ctx = new SwitchboardCtx(
        new Connection("https://api.devnet.solana.com"),
        KEEPER,
        "https://api.devnet.solana.com",
        SILENT,
        "https://crossbar.switchboard.xyz",
      );
      const view = {
        authority: PublicKey.default,
        queue: PublicKey.default,
        oracle: PublicKey.default,
        seedSlot: 1n,
        revealSlot: 0n,
        seedSlothash: new Uint8Array(32),
        value: new Uint8Array(32),
      } as any;
      const started = Date.now();
      const result = await Promise.race([
        ctx.fetchReveal("https://gateway.example.invalid", Keypair.generate().publicKey, view),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 15_000)),
      ]);
      expect(result, `fetchReveal must give up (took ${Date.now() - started} ms)`).to.not.equal("hung");
    } finally {
      Gateway.prototype.fetchRandomnessReveal = original;
    }
  });
});

describe("AUDIT C-1 — failure classification and the health alarm", () => {
  it("counts only chain-reported failures as deterministic", async () => {
    const { isDeterministicFailure } = await import("../src/actions");
    expect(isDeterministicFailure(new Error("tx failed on-chain: {\"InstructionError\":[0,{\"Custom\":6000}]}"))).to.equal(true);
    expect(isDeterministicFailure(new Error("Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1770"))).to.equal(true);
    for (const transport of [
      "TransactionExpiredBlockheightExceededError: block height exceeded",
      "429 Too Many Requests",
      "fetch failed",
      "Blockhash not found",
      "connect ETIMEDOUT 1.2.3.4:443",
      "gateway timed out after 4000 ms",
    ]) {
      expect(isDeterministicFailure(new Error(transport)), transport).to.equal(false);
    }
  });

  it("a quarantined round degrades /healthz", async () => {
    const { HealthMonitor } = await import("../src/health");
    const health = new HealthMonitor("t", "k", 0n, false);
    health.tick({ slot: 1n, unix: 1n, skewSec: 0 }, 10n ** 9n, null);
    expect(health.snapshot().status).to.equal("ok");
    health.setTrackedRounds([{ roundId: "9", state: "awaitingRandomness", quarantined: true }]);
    const snap = health.snapshot();
    expect(snap.status).to.equal("degraded");
    expect(snap.degradedReasons.join(" ")).to.match(/quarantined \(9\)/);
  });
});

describe("AUDIT C-8 — priority fee follows the network within [floor, cap]", () => {
  function execWithFees(fees: number[], env: Record<string, string>) {
    const sent: Transaction[] = [];
    const connection = {
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 }),
      getRecentPrioritizationFees: async () => fees.map((f, i) => ({ slot: i, prioritizationFee: f })),
      sendRawTransaction: async (raw: Buffer) => {
        sent.push(Transaction.from(raw));
        return "sig";
      },
      confirmTransaction: async () => ({ value: { err: null } }),
    };
    const rpc = {
      connection,
      chainNow: async () => ({ slot: 1n, unix: 1n, skewSec: 0 }),
      call: (_l: string, op: () => Promise<unknown>) => op(),
    } as unknown as RpcGateway;
    const exec = new TxExecutor(rpc, KEEPER, loadConfig(env), new FakeBook(), { action: () => undefined, recordCleanupTx: () => undefined } as unknown as HealthMonitor, SILENT);
    return { exec, sent };
  }
  const priceOf = (t: Transaction): number => {
    const ix = t.instructions.find((i) => i.programId.toBase58() === "ComputeBudget111111111111111111111111111111" && i.data[0] === 3);
    return ix === undefined ? 0 : Number(ix.data.readBigUInt64LE(1));
  };

  it("uses p75 of recent fees, clamped to the cap", async () => {
    const { exec, sent } = execWithFees([100, 200, 300, 900_000], {
      CRANK_PRIORITY_FEE_MICROLAMPORTS: "1000",
      CRANK_PRIORITY_FEE_MAX_MICROLAMPORTS: "50000",
    });
    await exec.dispatch({ kind: "lock_round", roundId: 1n, label: "l", build: () => tx() });
    expect(priceOf(sent[0]!)).to.equal(50_000, "p75 = 900 000 → capped");
  });

  it("never drops below the floor, and stays static without a cap", async () => {
    const quiet = execWithFees([0, 0, 0], { CRANK_PRIORITY_FEE_MICROLAMPORTS: "1000", CRANK_PRIORITY_FEE_MAX_MICROLAMPORTS: "50000" });
    await quiet.exec.dispatch({ kind: "lock_round", roundId: 2n, label: "l", build: () => tx() });
    expect(priceOf(quiet.sent[0]!)).to.equal(1_000);
    const stat = execWithFees([900_000], { CRANK_PRIORITY_FEE_MICROLAMPORTS: "1000" });
    await stat.exec.dispatch({ kind: "lock_round", roundId: 3n, label: "l", build: () => tx() });
    expect(priceOf(stat.sent[0]!)).to.equal(1_000);
  });
});
