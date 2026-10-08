/**
 * Auto-deposit gates (Phase 10.5): the pure `isEligible` predicate case by
 * case against the on-chain guards, the evaluator's batching/throttle/
 * quarantine-opt-out contract, and the escrow registry's discovery
 * (event + GPA + seed, refusal-tolerant) and dormancy backoff — all
 * against in-memory fakes (no Connection, no gateway), with the byte-exact
 * SDK layout fixture standing in for on-chain escrow accounts.
 */

import { expect } from "chai";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { GlobalConfigData, OrbitJackpotClient, PlayerEscrowData, RoundData } from "@orbit-jackpot/sdk";
import { escrowKey } from "@orbit-jackpot/sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/log";
import { evalAutoDeposit, isEligible } from "../src/handlers/auto_deposit";
import { FileEscrowRegistry } from "../src/escrows";
import type { EscrowCandidate, EscrowRegistry, HandlerCtx } from "../src/context";
import type { ChainClock, RpcGateway } from "../src/rpc";
import type { ChainReader } from "../src/reader";

const SILENT = createLogger("silent");
const CLOCK: ChainClock = { slot: 10_000n, unix: 1_700_000_000n, skewSec: 0 };
const SOME_PROGRAM = Keypair.generate().publicKey;
const ENTRY_RENT = 1_203_960n;
const ESCROW_RENT_MIN = 1_270_000n;

// ── factories ─────────────────────────────────────────────────────────────

function config(over: Partial<GlobalConfigData> = {}): GlobalConfigData {
  return {
    admin: Keypair.generate().publicKey.toBase58(),
    pendingAdmin: null,
    treasuryAuthority: Keypair.generate().publicKey.toBase58(),
    oracleProgramId: Keypair.generate().publicKey.toBase58(),
    oracleQueue: Keypair.generate().publicKey.toBase58(),
    feeBpsAdmin: 100,
    feeBpsMega: 100,
    winnerBps: 9_800,
    megaAwardBps: 9_000,
    megaTriggerModulus: 6_767,
    maxEntriesPerRound: 100,
    roundDurationSecs: 120n,
    maxRoundDurationSecs: 600n,
    antiSnipeWindowSecs: 30n,
    antiSnipeExtensionSecs: 15n,
    claimDeadlineSecs: 3_600n,
    minDepositLamports: 100_000_000n,
    antiSnipeMinDepositLamports: 100_000_000n,
    keeperTipLamports: 1_000_000n,
    randomnessRevealDeadlineSlots: 400n,
    activeRoundId: 7n,
    nextRoundId: 8n,
    oracleProvider: "switchboard",
    paused: false,
    bump: 254,
    autoDepositWindowSecs: 20n,
    autoDepositTipLamports: 200_000n,
    autoDepositEnabled: true,
    refundBps: 8_900,
    megaFieldBps: 4_000,
    megaPayoutCapBps: 80_000,
    accountOpenFeeLamports: 0n,
    economicsVersion: 2,
    ...over,
  };
}

/** The round opener whose rent comes back at close (Phase 12). */
const KEEPER = "61JhQhzyCU95sNKsBWAYjWjjTbvsKR79FkcDFfYWUys";

function round(over: Partial<RoundData> = {}): RoundData {
  // start_ts = CLOCK.unix − 5: inside both the round and the window.
  return {
    roundId: 7n,
    state: "open",
    startTs: CLOCK.unix - 5n,
    endTs: CLOCK.unix + 115n,
    lockTs: 0n,
    lockSlot: 0n,
    settleTs: 0n,
    totalLamports: 0n,
    entryCount: 0,
    entriesClosed: 0,
    firstDepositor: PublicKey.default.toBase58(),
    singleDepositor: true,
    randomnessAccount: PublicKey.default.toBase58(),
    randomnessCommitSlot: 0n,
    randomnessSeedSlot: 0n,
    winningTicket: 0n,
    winner: PublicKey.default.toBase58(),
    winnerPayout: 0n,
    adminCut: 0n,
    megaCut: 0n,
    megaAwarded: 0n,
    vaultOwed: 0n,
    megaTriggered: false,
    prizeClaimed: false,
    vaultBump: 255,
    bump: 255,
    refundPool: 0n,
    refundsPaid: 0n,
    megaFieldPool: 0n,
    megaFieldPaid: 0n,
    rentPayer: KEEPER,
    ...over,
  };
}

function escrow(over: Partial<PlayerEscrowData> = {}): PlayerEscrowData {
  return {
    owner: Keypair.generate().publicKey.toBase58(),
    perRoundLamports: 100_000_000n,
    maxRounds: 10,
    roundsRemaining: 5,
    nextEligibleRoundId: 0n,
    roundsFunded: 5n,
    lifetimeDeposited: 500_000_000n,
    lifetimeStaked: 500_000_000n,
    autoReinvest: false,
    bump: 255,
    ...over,
  };
}

/** Spendable covers exactly one round cost plus the stated slack. */
const solventLamports = (slack = 0n): bigint =>
  ESCROW_RENT_MIN + 100_000_000n + ENTRY_RENT + 200_000n + slack;

// ── isEligible: one failing guard per case ───────────────────────────────

describe("isEligible mirrors the on-chain guards", () => {
  const happy = { escrow: escrow(), lamports: solventLamports() };

  it("accepts the happy case", () => {
    expect(isEligible(happy.escrow, happy.lamports, round(), config(), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(true);
  });

  it("rejects when the feature flag is off (the deployed default)", () => {
    expect(isEligible(happy.escrow, happy.lamports, round(), config({ autoDepositEnabled: false }), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(false);
  });

  it("rejects while paused", () => {
    expect(isEligible(happy.escrow, happy.lamports, round(), config({ paused: true }), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(false);
  });

  it("rejects a non-open round", () => {
    expect(isEligible(happy.escrow, happy.lamports, round({ state: "locked" }), config(), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(false);
  });

  it("rejects past the round's deposit window", () => {
    expect(isEligible(happy.escrow, happy.lamports, round({ endTs: CLOCK.unix }), config(), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(false);
  });

  it("rejects past the auto-deposit window (the anti-selection boundary)", () => {
    expect(isEligible(happy.escrow, happy.lamports, round({ startTs: CLOCK.unix - 30n }), config(), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(false);
  });

  it("rejects a round the escrow already played (I17)", () => {
    expect(isEligible(escrow({ nextEligibleRoundId: 8n }), happy.lamports, round(), config(), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(false);
  });

  it("rejects an exhausted budget", () => {
    expect(isEligible(escrow({ roundsRemaining: 0 }), happy.lamports, round(), config(), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(false);
  });

  it("rejects terms below a raised minimum deposit", () => {
    expect(isEligible(happy.escrow, happy.lamports, round(), config({ minDepositLamports: 200_000_000n }), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(false);
  });

  it("rejects at the per-round entry cap (and honours 0 = unlimited)", () => {
    expect(isEligible(happy.escrow, happy.lamports, round({ entryCount: 100 }), config(), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(false);
    expect(isEligible(happy.escrow, happy.lamports, round({ entryCount: 9_999 }), config({ maxEntriesPerRound: 0 }), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(true);
  });

  it("rejects when spendable cannot cover stake + entry rent + tip", () => {
    expect(isEligible(happy.escrow, solventLamports() - 1n, round(), config(), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(false);
    // Rent floor never counts as spendable.
    expect(isEligible(happy.escrow, ESCROW_RENT_MIN, round(), config(), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(false);
  });
});

// ── evalAutoDeposit contract ──────────────────────────────────────────────

/** Stub client: counts nextEntryIndex reads, records batch builds. */
function stubClient() {
  let nextIndex = 40;
  const builds: { first: number; owners: number }[] = [];
  const client = {
    nextEntryIndex: async (): Promise<number> => {
      nextIndex += 1;
      return nextIndex - 1;
    },
    buildCrankAutoDepositBatchTx: async (
      _roundId: bigint,
      owners: PublicKey[],
      _crank: PublicKey,
      first: number,
    ): Promise<Transaction> => {
      builds.push({ first, owners: owners.length });
      const tx = new Transaction();
      owners.forEach(() =>
        tx.add(new TransactionInstruction({ keys: [], programId: SOME_PROGRAM, data: Buffer.alloc(1) })),
      );
      return tx;
    },
  };
  return { client, builds };
}

class FixedRegistry implements EscrowRegistry {
  async anyArmed(): Promise<boolean> {
    return true;
  }
  readonly dispatched: Array<{ roundId: bigint; count: number }> = [];
  private readonly candidates: EscrowCandidate[];
  private readonly due: boolean;

  constructor(candidates: EscrowCandidate[], due = true) {
    this.candidates = candidates;
    this.due = due;
  }

  async eligible(): Promise<EscrowCandidate[]> {
    return this.candidates;
  }
  noteFunded(): void {}
  async reconcile(): Promise<void> {}
  size(): number {
    return this.candidates.length;
  }
  lastEligibleCount(): number {
    return this.candidates.length;
  }
  lastAutoDeposit() {
    return null;
  }
  noteAutoDeposit(roundId: bigint, count: number): void {
    this.dispatched.push({ roundId, count });
  }
  autoDepositDue(): boolean {
    return this.due;
  }
  async rentMinimumFor(): Promise<bigint> {
    return ENTRY_RENT;
  }
}

function makeCtx(
  client: unknown,
  registry: EscrowRegistry,
  cfgOver: Record<string, string | number> = {},
): HandlerCtx {
  return {
    cfg: loadConfig(
      Object.fromEntries(Object.entries(cfgOver).map(([k, v]) => [k, String(v)])),
    ),
    logger: SILENT,
    rpc: null as unknown as RpcGateway,
    keeper: Keypair.generate(),
    client: client as unknown as OrbitJackpotClient,
    sb: null as never,
    bridge: null as never,
    book: null as never,
    escrows: registry,
  };
}

function candidates(n: number): EscrowCandidate[] {
  return Array.from({ length: n }, () => {
    const data = escrow();
    return { key: escrowKey(new PublicKey(data.owner)), owner: new PublicKey(data.owner), data };
  });
}

describe("evalAutoDeposit", () => {
  it("returns null when the env kill switch is off (deployment step 3)", async () => {
    const { client } = stubClient();
    const action = await evalAutoDeposit(makeCtx(client, new FixedRegistry(candidates(3)), { CRANK_AUTO_DEPOSIT_ENABLED: 0 }), config(), round(), CLOCK);
    expect(action).to.equal(null);
  });

  it("returns null when the on-chain feature flag is off", async () => {
    const { client } = stubClient();
    const action = await evalAutoDeposit(makeCtx(client, new FixedRegistry(candidates(3))), config({ autoDepositEnabled: false }), round(), CLOCK);
    expect(action).to.equal(null);
  });

  it("returns null when the scan throttle is not due", async () => {
    const { client } = stubClient();
    const action = await evalAutoDeposit(makeCtx(client, new FixedRegistry(candidates(3), /* due */ false)), config(), round(), CLOCK);
    expect(action).to.equal(null);
  });

  it("returns null with no eligible escrows", async () => {
    const { client } = stubClient();
    const action = await evalAutoDeposit(makeCtx(client, new FixedRegistry([])), config(), round(), CLOCK);
    expect(action).to.equal(null);
  });

  it("batches up to CRANK_AUTO_DEPOSIT_MAX_PER_TX with the §0.4 contract", async () => {
    const { client, builds } = stubClient();
    const registry = new FixedRegistry(candidates(8));
    const action = await evalAutoDeposit(makeCtx(client, registry, { CRANK_AUTO_DEPOSIT_MAX_PER_TX: 6 }), config(), round(), CLOCK);
    expect(action).to.not.equal(null);
    expect(action!.kind).to.equal("auto_deposit");
    expect(action!.roundId).to.equal(7n);
    expect(action!.quarantineOnFailure).to.equal(false, "routine contention must never quarantine a live round");
    expect(action!.sendAttempts).to.equal(3);
    const tx = await action!.build(123_456n);
    expect(tx.instructions).to.have.lengthOf(6, "capped at max per tx");
    expect(builds[0]!.owners).to.equal(6);
    await action!.after!("sig");
    expect(registry.dispatched).to.deep.equal([{ roundId: 7n, count: 6 }]);
  });

  it("re-reads nextEntryIndex per attempt and falls back to one escrow on the final attempt", async () => {
    const { client, builds } = stubClient();
    const action = await evalAutoDeposit(makeCtx(client, new FixedRegistry(candidates(4))), config(), round(), CLOCK);
    const tx1 = await action!.build(1n);
    const tx2 = await action!.build(2n);
    const tx3 = await action!.build(3n);
    expect(tx1.instructions).to.have.lengthOf(4);
    expect(tx2.instructions).to.have.lengthOf(4);
    expect(tx3.instructions).to.have.lengthOf(1, "a single bad escrow cannot block the rest");
    // Fresh indices per attempt: the stub increments on every read.
    expect(builds.map((b) => b.first)).to.deep.equal([40, 41, 42]);
  });
});

// ── the file-backed registry (discovery + dormancy) ───────────────────────

interface FixtureFile {
  accounts: Record<string, { hex: string }>;
}
const FIXTURE: FixtureFile = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "packages", "sdk", "tests", "fixtures", "account_layouts.json"),
    "utf8",
  ),
) as FixtureFile;
const ESCROW_HEX = FIXTURE.accounts.PlayerEscrow!.hex;
const ESCROW_DATA = Buffer.from(ESCROW_HEX, "hex");
const FIXTURE_OWNER = new PublicKey(
  (JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "packages", "sdk", "tests", "fixtures", "account_layouts.json"),
    "utf8",
  )) as { accounts: Record<string, { expected: { owner: string } }> }).accounts.PlayerEscrow!.expected.owner,
);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orbit-escrows-"));
}

/** Fake rpc whose `call` runs the op directly; GPA configurable. */
function fakeRpc(gpa: () => Promise<Array<{ pubkey: PublicKey; account: { data: Buffer } }>>): RpcGateway {
  return {
    call: (_label: string, op: () => Promise<unknown>) => op(),
    connection: { getProgramAccounts: gpa } as unknown as RpcGateway["connection"],
  } as unknown as RpcGateway;
}

/** Fake reader returning the fixture escrow bytes with chosen lamports. */
function fakeReader(lamports: bigint, reads: { count: number } = { count: 0 }): ChainReader {
  return {
    accountsWithLamports: async (keys: PublicKey[]) => {
      reads.count += 1;
      const out = new Map<string, { lamports: bigint; data: Buffer } | null>();
      for (const key of keys) {
        out.set(key.toBase58(), { lamports, data: ESCROW_DATA });
      }
      return out;
    },
  } as unknown as ChainReader;
}

describe("FileEscrowRegistry", () => {
  it("noteFunded registers and persists across restarts", () => {
    const dir = tmpDir();
    const owner = Keypair.generate().publicKey;
    const reg = new FileEscrowRegistry(dir, fakeReader(0n), fakeRpc(async () => []), loadConfig({}), SILENT);
    reg.noteFunded(escrowKey(owner), owner);
    expect(reg.size()).to.equal(1);
    expect(fs.existsSync(path.join(dir, "escrows.json"))).to.equal(true);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).to.deep.equal([]);
    const reloaded = new FileEscrowRegistry(dir, fakeReader(0n), fakeRpc(async () => []), loadConfig({}), SILENT);
    expect(reloaded.size()).to.equal(1, "survives the restart");
  });

  it("reconcile populates from a bounded GPA ({dataSize: 122}) and from the seed list", async () => {
    const dir = tmpDir();
    const seededOwner = Keypair.generate().publicKey;
    const cfg = loadConfig({ CRANK_ESCROW_SEED: seededOwner.toBase58() });
    const reg = new FileEscrowRegistry(
      dir,
      fakeReader(0n),
      fakeRpc(async () => [{ pubkey: escrowKey(FIXTURE_OWNER), account: { data: ESCROW_DATA } }]),
      cfg,
      SILENT,
    );
    await reg.reconcile();
    // GPA found the fixture escrow; the seed added the owner-derived one.
    expect(reg.size()).to.equal(2);
  });

  it("keeps the registry when the RPC refuses GPA (latency, not correctness)", async () => {
    const dir = tmpDir();
    const owner = Keypair.generate().publicKey;
    const reg = new FileEscrowRegistry(
      dir,
      fakeReader(0n),
      fakeRpc(async () => {
        throw new Error("429 too many requests: getProgramAccounts not allowed");
      }),
      loadConfig({}),
      SILENT,
    );
    reg.noteFunded(escrowKey(owner), owner);
    await reg.reconcile(); // must not throw
    expect(reg.size()).to.equal(1, "registry kept as-is");
  });

  it("eligible() decodes + filters via isEligible, and hard-dormancy backs off reads", async () => {
    const dir = tmpDir();
    const cfg = loadConfig({});
    // The fixture escrow: perRound 123,456,789,012,345, nextEligible
    // 987,654,321, roundsRemaining 37 — eligible under a big-id round with
    // a solvent balance.
    const roundBigId = round({ roundId: 987_654_321n });
    const solventLamportsFor = (perRound: bigint): bigint =>
      ESCROW_RENT_MIN + perRound + ENTRY_RENT + 200_000n;
    const reads = { count: 0 };
    const solvent = new FileEscrowRegistry(
      dir,
      fakeReader(solventLamportsFor(123_456_789_012_345n), reads),
      fakeRpc(async () => [{ pubkey: escrowKey(FIXTURE_OWNER), account: { data: ESCROW_DATA } }]),
      cfg,
      SILENT,
    );
    await solvent.reconcile();
    const found = await solvent.eligible(roundBigId, config(), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN);
    expect(found).to.have.lengthOf(1);
    expect(found[0]!.owner.toString()).to.equal(FIXTURE_OWNER.toString());
    expect(solvent.lastEligibleCount()).to.equal(1);
    expect(solvent.autoDepositDue(60_000)).to.equal(false, "just scanned");

    // Hard dormancy: a budget-exhausted escrow is read once, then skipped
    // until the reconcile backoff elapses — a thousand depleted escrows
    // cost nothing per round.
    const reads2 = { count: 0 };
    const depleted = escrow({ roundsRemaining: 0 });
    const depletedOwner = new PublicKey(depleted.owner);
    const reg2 = new FileEscrowRegistry(
      dir,
      {
        accountsWithLamports: async (keys: PublicKey[]) => {
          reads2.count += 1;
          const out = new Map<string, { lamports: bigint; data: Buffer } | null>();
          for (const key of keys) {
            out.set(key.toBase58(), {
              lamports: solventLamports(),
              data: Buffer.concat([ESCROW_DATA.subarray(0, 8), encodeEscrow(depleted)]),
            });
          }
          return out;
        },
      } as unknown as ChainReader,
      fakeRpc(async () => []),
      cfg,
      SILENT,
    );
    reg2.noteFunded(escrowKey(depletedOwner), depletedOwner);
    expect(await reg2.eligible(round(), config(), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN)).to.have.lengthOf(0);
    expect(reads2.count).to.equal(1);
    expect(await reg2.eligible(round(), config(), CLOCK, ENTRY_RENT, ESCROW_RENT_MIN)).to.have.lengthOf(0);
    expect(reads2.count).to.equal(1, "dormant escrow not re-read until the backoff elapses");
  });

  it("anyArmed(): true only for an escrow with rounds left AND balance for its next round", async () => {
    const cfg = loadConfig({});
    const perRound = 123_456_789_012_345n; // the fixture escrow's per-round stake
    const make = (lamports: bigint, reads = { count: 0 }) => {
      const reg = new FileEscrowRegistry(tmpDir(), fakeReader(lamports, reads), fakeRpc(async () => []), cfg, SILENT);
      reg.noteFunded(escrowKey(FIXTURE_OWNER), FIXTURE_OWNER);
      return reg;
    };
    const tip = config().autoDepositTipLamports;
    const enough = ESCROW_RENT_MIN + perRound + ENTRY_RENT + tip;
    expect(await make(enough).anyArmed(config(), ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(true);

    // One lamport short: not armed, and parked so idle ticks stop reading it.
    const reads = { count: 0 };
    const poor = make(enough - 1n, reads);
    expect(await poor.anyArmed(config(), ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(false);
    expect(await poor.anyArmed(config(), ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(false);
    expect(reads.count).to.equal(1, "a dormant escrow is not re-read every idle tick");

    // No escrows at all: false without a single read.
    const none = new FileEscrowRegistry(tmpDir(), fakeReader(enough, reads), fakeRpc(async () => []), cfg, SILENT);
    expect(await none.anyArmed(config(), ENTRY_RENT, ESCROW_RENT_MIN)).to.equal(false);
  });
});

/** Borsh-encodes a PlayerEscrowData struct body (114 bytes, no discriminator). */
function encodeEscrow(e: PlayerEscrowData): Buffer {
  const buf = Buffer.alloc(114);
  new PublicKey(e.owner).toBuffer().copy(buf, 0);
  buf.writeBigUInt64LE(e.perRoundLamports, 32);
  buf.writeUInt32LE(e.maxRounds, 40);
  buf.writeUInt32LE(e.roundsRemaining, 44);
  buf.writeBigUInt64LE(e.nextEligibleRoundId, 48);
  buf.writeBigUInt64LE(e.roundsFunded, 56);
  buf.writeBigUInt64LE(e.lifetimeDeposited, 64);
  buf.writeBigUInt64LE(e.lifetimeStaked, 72);
  buf.writeUInt8(e.autoReinvest ? 1 : 0, 80);
  buf.writeUInt8(e.bump, 81);
  return buf;
}

// ── config surface for the new variables ─────────────────────────────────

describe("auto-deposit config variables", () => {
  it("defaults: enabled, 6 per tx, 1s scan interval, GPA on, 10min reconcile, empty seed", () => {
    const cfg = loadConfig({});
    expect(cfg.autoDepositEnabled).to.equal(true);
    expect(cfg.autoDepositMaxPerTx).to.equal(6);
    expect(cfg.autoDepositIntervalMs).to.equal(1_000);
    expect(cfg.escrowGpaEnabled).to.equal(true);
    expect(cfg.escrowReconcileMs).to.equal(600_000);
    expect(cfg.escrowSeed).to.equal("");
  });

  it("parses overrides and rejects out-of-range values", () => {
    const cfg = loadConfig({
      CRANK_AUTO_DEPOSIT_ENABLED: "0",
      CRANK_AUTO_DEPOSIT_MAX_PER_TX: "12",
      CRANK_AUTO_DEPOSIT_INTERVAL_MS: "5000",
      CRANK_ESCROW_GPA_ENABLED: "false",
      CRANK_ESCROW_RECONCILE_MS: "120000",
      CRANK_ESCROW_SEED: "key1,key2",
    });
    expect(cfg.autoDepositEnabled).to.equal(false);
    expect(cfg.autoDepositMaxPerTx).to.equal(12);
    expect(cfg.autoDepositIntervalMs).to.equal(5_000);
    expect(cfg.escrowGpaEnabled).to.equal(false);
    expect(cfg.escrowReconcileMs).to.equal(120_000);
    expect(cfg.escrowSeed).to.equal("key1,key2");
    expect(() => loadConfig({ CRANK_AUTO_DEPOSIT_MAX_PER_TX: "13" })).to.throw(/CRANK_AUTO_DEPOSIT_MAX_PER_TX/);
    expect(() => loadConfig({ CRANK_ESCROW_RECONCILE_MS: "1000" })).to.throw(/CRANK_ESCROW_RECONCILE_MS/);
  });
});
