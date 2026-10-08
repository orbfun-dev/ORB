/**
 * Handler decision gates: the evaluator matrix across the whole
 * lifecycle, driven against in-memory fakes (no Connection, no gateway).
 * Every action is also BUILT and its instruction discriminator pinned, so
 * a decision can never drift from the wire format.
 */

import { expect } from "chai";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { OrbitJackpotClient, PROGRAM_ID, entryKey, roundKey, type GlobalConfigData, type PlayerEntryAccountData, type RoundData } from "@orbit-jackpot/sdk";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/log";
import type { CrankAction } from "../src/actions";
import type { EscrowCandidate, EscrowRegistry, HandlerCtx, QuarantineBook, SettleBridge, SbOracleSource } from "../src/context";
import type { ChainClock, RpcGateway } from "../src/rpc";
import type { RandomnessView, RevealPayload } from "../src/randomness";
import { evalRollover } from "../src/handlers/rollover";
import { evalLock } from "../src/handlers/lock";
import { evalSettle } from "../src/handlers/settle";
import { evalCleanup } from "../src/handlers/cleanup";
import { evalLutSweep, LUT_COOLDOWN_SLOTS } from "../src/handlers/lut";
import { lutKeys } from "../src/randomness";
import { splitEntropy, ticketFromEntropy } from "../src/mirror";
import { EntropySeeds, entropyValue, findSlotHash, sha256 } from "../src/entropy";
import { ENTROPY_NONE, entropyChainKey, type EntropyChainData } from "@orbit-jackpot/sdk";

/** In-memory escrow registry — no chain, no GPA (the structural seam). */
class FakeEscrowRegistry implements EscrowRegistry {
  eligibleCalls = 0;
  armed = true;
  private readonly candidates: EscrowCandidate[];

  constructor(candidates: EscrowCandidate[] = []) {
    this.candidates = candidates;
  }

  async anyArmed(): Promise<boolean> {
    return this.armed;
  }

  async eligible(): Promise<EscrowCandidate[]> {
    this.eligibleCalls += 1;
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
  noteAutoDeposit(): void {}
  autoDepositDue(): boolean {
    return true;
  }
  async rentMinimumFor(): Promise<bigint> {
    return 1_203_960n;
  }
}

const DEFAULT_PK = PublicKey.default.toBase58();
const ORACLE_PROGRAM = Keypair.generate().publicKey;
const ORACLE_QUEUE = Keypair.generate().publicKey;
const ORACLE = Keypair.generate().publicKey;
const PROGRAM_STATE = Keypair.generate().publicKey;
const SILENT = createLogger("silent");
const CLOCK: ChainClock = { slot: 10_000n, unix: 1_700_000_000n, skewSec: 0 };
const clockAt = (slot: bigint, unix: bigint): ChainClock => ({ slot, unix, skewSec: 0 });

// ── factories ───────────────────────────────────────────────────────────

function config(over: Partial<GlobalConfigData> = {}): GlobalConfigData {
  return {
    admin: Keypair.generate().publicKey.toBase58(),
    pendingAdmin: null,
    treasuryAuthority: Keypair.generate().publicKey.toBase58(),
    oracleProgramId: ORACLE_PROGRAM.toBase58(),
    oracleQueue: ORACLE_QUEUE.toBase58(),
    feeBpsAdmin: 200,
    feeBpsMega: 100,
    winnerBps: 9_800,
    megaAwardBps: 9_000,
    megaTriggerModulus: 6_767,
    maxEntriesPerRound: 500,
    roundDurationSecs: 120n,
    maxRoundDurationSecs: 600n,
    antiSnipeWindowSecs: 30n,
    antiSnipeExtensionSecs: 15n,
    claimDeadlineSecs: 3_600n,
    minDepositLamports: 10_000_000n,
    antiSnipeMinDepositLamports: 100_000_000n,
    keeperTipLamports: 1_000_000n,
    randomnessRevealDeadlineSlots: 400n,
    activeRoundId: 2n,
    nextRoundId: 3n,
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
  return {
    roundId: 2n,
    state: "open",
    startTs: 1_699_999_800n,
    endTs: 1_699_999_920n,
    lockTs: 0n,
    lockSlot: 0n,
    settleTs: 0n,
    totalLamports: 750_000_000n,
    entryCount: 3,
    entriesClosed: 0,
    firstDepositor: Keypair.generate().publicKey.toBase58(),
    singleDepositor: false,
    randomnessAccount: DEFAULT_PK,
    randomnessCommitSlot: 0n,
    randomnessSeedSlot: 0n,
    winningTicket: 0n,
    winner: DEFAULT_PK,
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

function view(over: Partial<RandomnessView> = {}): RandomnessView {
  return {
    authority: Keypair.generate().publicKey,
    queue: ORACLE_QUEUE,
    seedSlothash: new Uint8Array(32).fill(7),
    seedSlot: 0n,
    oracle: ORACLE,
    revealSlot: 0n,
    value: new Uint8Array(32).fill(9),
    lutSlot: 0n,
    ...over,
  };
}

function entry(over: Partial<PlayerEntryAccountData> = {}): PlayerEntryAccountData {
  return {
    roundId: 2n,
    entryIndex: 0,
    player: Keypair.generate().publicKey.toBase58(),
    amountLamports: 100_000_000n,
    ticketStart: 0n,
    ticketEnd: 100_000_000n,
    depositTs: 0n,
    depositSlot: 0n,
    bump: 255,
    ...over,
  };
}

// ── fakes ───────────────────────────────────────────────────────────────

class FakeBook implements QuarantineBook {
  readonly quarantines = new Map<string, string>();
  readonly keypairs = new Map<string, Keypair>();
  readonly failures = new Map<string, number>();
  readonly actions: Array<Record<string, unknown>> = [];

  isQuarantined(roundId: bigint): string | null {
    return this.quarantines.get(roundId.toString()) ?? null;
  }
  quarantine(roundId: bigint, reason: string): void {
    if (!this.quarantines.has(roundId.toString())) this.quarantines.set(roundId.toString(), reason);
  }
  randomnessKeypair(roundId: bigint): Keypair {
    const key = roundId.toString();
    let kp = this.keypairs.get(key);
    if (kp === undefined) {
      kp = Keypair.generate();
      this.keypairs.set(key, kp);
    }
    return kp;
  }
  recordFailure(key: string): number {
    const next = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, next);
    return next;
  }
  resetFailures(key: string): void {
    this.failures.delete(key);
  }
  failureCount(key: string): number {
    return this.failures.get(key) ?? 0;
  }
  recordAction(e: Record<string, unknown>): void {
    this.actions.push(e);
  }
  readonly luts = new Map<string, { randomness: string; lutSlot: bigint }>();
  rememberLut(roundId: bigint, randomness: string, lutSlot: bigint): void {
    this.luts.set(roundId.toString(), { randomness, lutSlot });
  }
  pendingLuts(): Array<{ roundId: bigint; randomness: string; lutSlot: bigint }> {
    return [...this.luts.entries()].map(([id, v]) => ({ roundId: BigInt(id), ...v }));
  }
  forgetLut(roundId: bigint): void {
    this.luts.delete(roundId.toString());
  }
}

interface CtxOpts {
  views?: Map<string, RandomnessView | null>;
  entries?: PlayerEntryAccountData[];
  reveal?: RevealPayload | null;
  /** LUT address → deactivation slot (absent = closed). */
  luts?: Map<string, bigint>;
  claimForWinners?: boolean;
  cleanupEnabled?: boolean;
  chain?: EntropyChainData | null;
  slotHashes?: Buffer | null;
  entropy?: EntropySeeds | null;
}

function makeCtx(opts: CtxOpts = {}): { ctx: HandlerCtx; book: FakeBook; views: Map<string, RandomnessView | null> } {
  const book = new FakeBook();
  const views = opts.views ?? new Map<string, RandomnessView | null>();
  const bridge: SettleBridge = {
    randomness: async (key) => views.get(key.toBase58()) ?? null,
    entries: async () => opts.entries ?? [],
    lookupTable: async (key) => {
      const slot = opts.luts?.get(key.toBase58());
      return slot === undefined ? null : { deactivationSlot: slot };
    },
    entropyChain: async () => opts.chain ?? null,
    slotHashes: async () => opts.slotHashes ?? null,
  };
  const sb: SbOracleSource = {
    selectOracle: async () => ORACLE,
    oracleGatewayUrl: async () => "https://oracle-gateway.example",
    fetchReveal: async () => opts.reveal ?? null,
    programStateKey: async () => PROGRAM_STATE,
  };
  const cfg = loadConfig({
    ...(opts.claimForWinners ? { CRANK_CLAIM_FOR_WINNERS: "1" } : {}),
    ...(opts.cleanupEnabled === false ? { CRANK_CLEANUP_ENABLED: "0" } : {}),
  });
  const ctx: HandlerCtx = {
    cfg,
    logger: SILENT,
    rpc: null as unknown as RpcGateway,
    keeper: Keypair.generate(),
    client: new OrbitJackpotClient(new Connection("http://127.0.0.1:1")),
    sb,
    bridge,
    book,
    escrows: new FakeEscrowRegistry(),
    entropy: opts.entropy ?? null,
  };
  return { ctx, book, views };
}

async function discOf(action: CrankAction): Promise<string> {
  const tx = await action.build(123_456n);
  return tx.instructions[0]!.data.subarray(0, 8).toString("hex");
}

// ── rollover ────────────────────────────────────────────────────────────

describe("rollover evaluator", () => {
  it("opens the next round when the active round left Open, presenting it as tail", async () => {
    const { ctx } = makeCtx();
    const cfg = config();
    const action = evalRollover(ctx, cfg, round({ state: "settled" }));
    expect(action?.kind).to.equal("open_round");
    expect(action?.roundId).to.equal(cfg.nextRoundId);
    expect(await discOf(action!)).to.equal("42eb7bf00823b99f");
    const tx = await action!.build(123_456n);
    // The active round's key rides the tail slot (fail-closed presentation).
    expect(tx.instructions[0]!.keys[6]!.pubkey.toString()).to.equal(
      roundKey(cfg.activeRoundId).toString(),
    );
    expect(tx.instructions[0]!.keys[6]!.isWritable).to.equal(false);
  });

  it("opens the very first round with the sentinel tail", async () => {
    const { ctx } = makeCtx();
    const action = evalRollover(ctx, config({ activeRoundId: 0n, nextRoundId: 0n }), null);
    expect(action?.kind).to.equal("open_round");
    const tx = await action!.build(123_456n);
    // No predecessor exists: the program-id sentinel encodes `None`.
    expect(tx.instructions[0]!.keys[6]!.pubkey.toString()).to.equal(PROGRAM_ID.toString());
  });

  it("does nothing while a round is open, or when paused", () => {
    const { ctx } = makeCtx();
    expect(evalRollover(ctx, config(), round({ state: "open" }))).to.equal(null);
    expect(evalRollover(ctx, config({ paused: true }), round({ state: "settled" }))).to.equal(null);
  });
});

// ── lock ────────────────────────────────────────────────────────────────

describe("lock evaluator", () => {
  it("locks on the chain clock passing end_ts — never before", async () => {
    const { ctx } = makeCtx();
    const cfg = config();
    const before = await evalLock(ctx, cfg, round({ endTs: CLOCK.unix + 1n }), CLOCK);
    expect(before).to.equal(null);
    const due = await evalLock(ctx, cfg, round({ endTs: CLOCK.unix }), CLOCK);
    expect(due?.kind).to.equal("lock_round");
    expect(await discOf(due!)).to.equal("447c2be61e2cf8e3");
  });

  it("ignores non-open rounds and paused protocols", async () => {
    const { ctx } = makeCtx();
    expect(await evalLock(ctx, config(), round({ state: "locked" }), CLOCK)).to.equal(null);
    expect(await evalLock(ctx, config({ paused: true }), round({ endTs: 0n }), CLOCK)).to.equal(null);
  });

  // ── Phase 12: an expired EMPTY round is none of the keeper's business ──

  it("returns null on an expired empty round — the first bettor revives it", async () => {
    const { ctx } = makeCtx();
    // Expired long ago (clock way past end_ts) and holding zero lamports.
    const empty = round({ totalLamports: 0n, entryCount: 0, endTs: 0n });
    expect(await evalLock(ctx, config(), empty, CLOCK)).to.equal(null);
  });

  it("still locks an expired NON-empty round immediately", async () => {
    const { ctx } = makeCtx();
    const due = await evalLock(ctx, config(), round({ endTs: CLOCK.unix }), CLOCK);
    expect(due?.kind).to.equal("lock_round");
  });

  it("rolls an expired empty round only when the idle-roll net is armed and due", async () => {
    const { ctx } = makeCtx();
    const empty = round({ totalLamports: 0n, entryCount: 0, endTs: 0n });
    const armed: HandlerCtx = { ...ctx, cfg: { ...ctx.cfg, idleRollSecs: 600 } };
    // Not yet 600 s past end_ts — still nothing to do.
    const soon = { slot: CLOCK.slot, unix: 300n, skewSec: 0 };
    expect(await evalLock(armed, config(), empty, soon)).to.equal(null);
    // 600 s past: one UI-freshness roll, labelled as such.
    const late = { slot: CLOCK.slot, unix: 601n, skewSec: 0 };
    const roll = await evalLock(armed, config(), empty, late);
    expect(roll?.kind).to.equal("lock_round");
    expect(roll?.label).to.include("idle window roll");
    expect(await discOf(roll!)).to.equal("447c2be61e2cf8e3");
  });

  it("never rolls an idle round when no auto-play escrow is armed — zero cost", async () => {
    const { ctx } = makeCtx();
    (ctx.escrows as FakeEscrowRegistry).armed = false;
    const empty = round({ totalLamports: 0n, entryCount: 0, endTs: 0n });
    const armedNet: HandlerCtx = { ...ctx, cfg: { ...ctx.cfg, idleRollSecs: 15 } };
    const late = { slot: CLOCK.slot, unix: 10_000n, skewSec: 0 };
    expect(await evalLock(armedNet, config(), empty, late)).to.equal(null);
    // An expired NON-empty round still locks regardless.
    expect((await evalLock(armedNet, config(), round({ endTs: 0n }), late))?.kind).to.equal("lock_round");
  });
});

// ── settle pipeline ─────────────────────────────────────────────────────

describe("settle evaluator", () => {
  it("creates the randomness account when locked and unpinned (3 attempts, persisted signer)", async () => {
    const { ctx, book } = makeCtx();
    const first = await evalSettle(ctx, config(), round({ state: "locked" }), CLOCK);
    expect(first?.kind).to.equal("create_randomness");
    expect(first?.sendAttempts).to.equal(3);
    expect(first?.extraSigners?.length).to.equal(1);
    const again = await evalSettle(ctx, config(), round({ state: "locked" }), CLOCK);
    expect(again?.extraSigners?.[0]!.publicKey.toString()).to.equal(
      first?.extraSigners?.[0]!.publicKey.toString(),
    );
    expect(book.keypairs.size).to.equal(1);
    expect(await discOf(first!)).to.equal("26a26be5984fd017");
  });

  it("pins an existing randomness account instead of creating", async () => {
    const { ctx, book, views } = makeCtx();
    // The account the keeper would create already exists — pin it.
    const kp = book.randomnessKeypair(2n);
    views.set(kp.publicKey.toBase58(), view());
    const action = await evalSettle(ctx, config(), round({ state: "locked" }), CLOCK);
    expect(action?.kind).to.equal("request_randomness");
    expect(await discOf(action!)).to.equal("d505ada625ec1f12");
  });

  it("commits through the round PDA when seed_slot is zero", async () => {
    const pinned = Keypair.generate().publicKey;
    const { ctx } = makeCtx({
      views: new Map([[pinned.toBase58(), view({ seedSlot: 0n })]]),
    });
    const action = await evalSettle(
      ctx,
      config(),
      round({ state: "awaitingRandomness", randomnessAccount: pinned.toBase58(), lockSlot: 100n, randomnessCommitSlot: 9_900n }),
      CLOCK,
    );
    expect(action?.kind).to.equal("commit_randomness");
    expect(await discOf(action!)).to.equal("9234c3dc4f1e351a");
  });

  it("quarantines a commit that is not fresh vs the lock (post-landing belt)", async () => {
    const pinned = Keypair.generate().publicKey;
    const views = new Map<string, RandomnessView | null>([[pinned.toBase58(), view({ seedSlot: 0n })]]);
    const { ctx, book } = makeCtx({ views });
    const action = await evalSettle(
      ctx,
      config(),
      round({ state: "awaitingRandomness", randomnessAccount: pinned.toBase58(), lockSlot: 100n, randomnessCommitSlot: 9_900n }),
      CLOCK,
    );
    // The landing reveals a stale commit — the belt must quarantine.
    views.set(pinned.toBase58(), view({ seedSlot: 50n }));
    await action!.after!("sig");
    expect(book.isQuarantined(2n)).to.match(/not fresh/);
  });

  it("quarantines an already-stale committed round and stops touching it", async () => {
    const pinned = Keypair.generate().publicKey;
    const { ctx, book } = makeCtx({
      views: new Map([[pinned.toBase58(), view({ seedSlot: 50n })]]),
    });
    const action = await evalSettle(
      ctx,
      config(),
      round({ state: "awaitingRandomness", randomnessAccount: pinned.toBase58(), lockSlot: 100n, randomnessCommitSlot: 9_900n }),
      CLOCK,
    );
    expect(action).to.equal(null);
    expect(book.isQuarantined(2n)).to.match(/not fresh/);
  });

  it("cancels (never quarantines) an unrevealed round past the ON-CHAIN deadline (AUDIT C-1, C-3)", async () => {
    const pinned = Keypair.generate().publicKey;
    const { ctx, book } = makeCtx({
      views: new Map([[pinned.toBase58(), view({ seedSlot: 9_000n })]]),
    });
    // Deadline runs from the pin's commit slot (100), not the seed slot (9 000).
    const r = round({ state: "awaitingRandomness", randomnessAccount: pinned.toBase58(), lockSlot: 50n, randomnessCommitSlot: 100n });
    const action = await evalSettle(ctx, config(), r, clockAt(10_000n, CLOCK.unix));
    expect(action?.kind).to.equal("cancel_round");
    expect(action?.quarantineOnFailure).to.equal(false);
    expect(await discOf(action!)).to.equal("524686362e609408");
    const ix = (await action!.build(1n)).instructions[0]!;
    expect(ix.keys[5]!.pubkey.toBase58()).to.equal(pinned.toBase58(), "the pin rides along (AUDIT P-1)");
    expect(book.isQuarantined(2n)).to.equal(null);
  });

  it("cancels a round whose oracle never even committed, past the deadline", async () => {
    const pinned = Keypair.generate().publicKey;
    const { ctx } = makeCtx({ views: new Map([[pinned.toBase58(), view({ seedSlot: 0n })]]) });
    const r = round({ state: "awaitingRandomness", randomnessAccount: pinned.toBase58(), lockSlot: 50n, randomnessCommitSlot: 100n });
    const action = await evalSettle(ctx, config(), r, clockAt(10_000n, CLOCK.unix));
    expect(action?.kind).to.equal("cancel_round");
    expect(action?.label).to.include("never committed");
  });

  it("reveals once the gateway produces the TEE payload", async () => {
    const pinned = Keypair.generate().publicKey;
    const reveal: RevealPayload = {
      signature: new Uint8Array(64).fill(0xab),
      recoveryId: 1,
      value: new Uint8Array(32).fill(0xcd),
    };
    const { ctx } = makeCtx({
      views: new Map([[pinned.toBase58(), view({ seedSlot: 9_900n })]]),
      reveal,
    });
    const action = await evalSettle(
      ctx,
      config(),
      round({ state: "awaitingRandomness", randomnessAccount: pinned.toBase58(), lockSlot: 100n, randomnessCommitSlot: 9_890n }),
      clockAt(10_000n, CLOCK.unix), // 100 slots after seed — inside the window
    );
    // AUDIT P-5: reveal and settle ride ONE transaction — no window for
    // a third party to settle first and take the keeper tip.
    expect(action?.kind).to.equal("reveal_and_settle");
    expect(await discOf(action!)).to.equal("1e8255dcd0501ca9");
    // Payload bytes ride the instruction data verbatim.
    const tx = await action!.build(123_456n);
    const data = tx.instructions[0]!.data;
    expect(data.length).to.equal(8 + 64 + 1 + 32);
    expect(data[data.length - 1]!).to.equal(0xcd);
    expect(tx.instructions).to.have.lengthOf(2);
    expect(tx.instructions[1]!.data.subarray(0, 8).toString("hex")).to.equal(
      (await discOf({ ...action!, build: async () => ctx.client.buildFulfillSettleTx(2n, pinned, ctx.keeper.publicKey) })),
    );
  });

  it("v3 combined: the settle carries the winning entry computed from the payload (AUDIT P-5)", async () => {
    const pinned = Keypair.generate().publicKey;
    const value = new Uint8Array(32).fill(0x5a);
    const total = 300_000_000n;
    const ticket = ticketFromEntropy(splitEntropy(value).ticket, total);
    const entries = [0, 1, 2].map((i) =>
      entry({ entryIndex: i, ticketStart: BigInt(i) * 100_000_000n, ticketEnd: BigInt(i + 1) * 100_000_000n }),
    );
    const { ctx } = makeCtx({
      views: new Map([[pinned.toBase58(), view({ seedSlot: 9_900n })]]),
      reveal: { signature: new Uint8Array(64).fill(1), recoveryId: 0, value },
      entries,
    });
    const r = round({
      state: "awaitingRandomness",
      randomnessAccount: pinned.toBase58(),
      lockSlot: 100n,
      randomnessCommitSlot: 9_890n,
      totalLamports: total,
      entryCount: 3,
    });
    const action = await evalSettle(ctx, config({ economicsVersion: 3 }), r, clockAt(10_000n, CLOCK.unix));
    expect(action?.kind).to.equal("reveal_and_settle");
    const settle = (await action!.build(1n)).instructions[1]!;
    expect(settle.keys.at(-1)!.pubkey.toBase58()).to.equal(
      entryKey(r.roundId, Number(ticket / 100_000_000n)).toBase58(),
    );
  });

  it("falls back to a plain reveal after a failed combined send (AUDIT P-5)", async () => {
    const pinned = Keypair.generate().publicKey;
    const { ctx, book } = makeCtx({
      views: new Map([[pinned.toBase58(), view({ seedSlot: 9_900n })]]),
      reveal: { signature: new Uint8Array(64).fill(1), recoveryId: 0, value: new Uint8Array(32).fill(2) },
    });
    const r = round({ state: "awaitingRandomness", randomnessAccount: pinned.toBase58(), lockSlot: 100n, randomnessCommitSlot: 9_890n });
    book.recordFailure(`reveal_and_settle:${r.roundId}`);
    const action = await evalSettle(ctx, config(), r, clockAt(10_000n, CLOCK.unix));
    expect(action?.kind).to.equal("reveal_randomness");
    expect((await action!.build(1n)).instructions).to.have.lengthOf(1);
  });

  it("waits for the next tick when the gateway is not ready", async () => {
    const pinned = Keypair.generate().publicKey;
    const { ctx } = makeCtx({
      views: new Map([[pinned.toBase58(), view({ seedSlot: 9_900n })]]),
      reveal: null,
    });
    const action = await evalSettle(
      ctx,
      config(),
      round({ state: "awaitingRandomness", randomnessAccount: pinned.toBase58(), lockSlot: 100n, randomnessCommitSlot: 9_900n }),
      CLOCK,
    );
    expect(action).to.equal(null);
  });

  it("settles once revealed", async () => {
    const pinned = Keypair.generate().publicKey;
    const { ctx } = makeCtx({
      views: new Map([[pinned.toBase58(), view({ seedSlot: 9_900n, revealSlot: 9_950n })]]),
    });
    const action = await evalSettle(
      ctx,
      config(),
      round({ state: "awaitingRandomness", randomnessAccount: pinned.toBase58(), lockSlot: 100n, randomnessCommitSlot: 9_900n }),
      CLOCK,
    );
    expect(action?.kind).to.equal("fulfill_settle");
    expect(await discOf(action!)).to.equal("78ab73054b43bb43");
    expect(action?.after).to.not.equal(undefined);
  });

  it("v3: settles with the entry that holds the winning ticket", async () => {
    const pinned = Keypair.generate().publicKey;
    const value = new Uint8Array(32).fill(9);
    const total = 300_000_000n;
    const ticket = ticketFromEntropy(splitEntropy(value).ticket, total);
    // Three entries partitioning [0, 300M); find which one holds the ticket.
    const entries = [0, 1, 2].map((i) =>
      entry({ entryIndex: i, ticketStart: BigInt(i) * 100_000_000n, ticketEnd: BigInt(i + 1) * 100_000_000n }),
    );
    const winnerIndex = Number(ticket / 100_000_000n);
    const { ctx } = makeCtx({
      views: new Map([[pinned.toBase58(), view({ seedSlot: 9_900n, revealSlot: 9_950n, value })]]),
      entries,
    });
    const r = round({
      state: "awaitingRandomness",
      randomnessAccount: pinned.toBase58(),
      lockSlot: 100n,
      totalLamports: total,
      entryCount: 3,
    });
    const action = await evalSettle(ctx, config({ economicsVersion: 3 }), r, CLOCK);
    expect(action?.kind).to.equal("fulfill_settle");
    const keys = (await action!.build(1n)).instructions[0]!.keys;
    expect(keys.at(-1)!.pubkey.toBase58()).to.equal(entryKey(r.roundId, winnerIndex).toBase58());

    // v2 sends no extra account.
    const v2 = await evalSettle(ctx, config(), r, CLOCK);
    expect((await v2!.build(1n)).instructions[0]!.keys.length).to.equal(keys.length - 1);
  });

  it("v3: waits when no entry holds the winning ticket yet", async () => {
    const pinned = Keypair.generate().publicKey;
    const { ctx } = makeCtx({
      views: new Map([[pinned.toBase58(), view({ seedSlot: 9_900n, revealSlot: 9_950n })]]),
      entries: [],
    });
    const r = round({ state: "awaitingRandomness", randomnessAccount: pinned.toBase58(), lockSlot: 100n, totalLamports: 5n, entryCount: 1 });
    expect(await evalSettle(ctx, config({ economicsVersion: 3 }), r, CLOCK)).to.equal(null);
  });

  it("quarantines an awaiting round whose pinned account vanished", async () => {
    const pinned = Keypair.generate().publicKey;
    const { ctx, book } = makeCtx({
      views: new Map([[pinned.toBase58(), null]]),
    });
    const action = await evalSettle(
      ctx,
      config(),
      round({ state: "awaitingRandomness", randomnessAccount: pinned.toBase58() }),
      CLOCK,
    );
    expect(action).to.equal(null);
    expect(book.isQuarantined(2n)).to.match(/missing/);
  });

  it("never touches quarantined or non-settleable rounds", async () => {
    const { ctx, book } = makeCtx();
    book.quarantine(2n, "manual");
    expect(await evalSettle(ctx, config(), round({ state: "locked" }), CLOCK)).to.equal(null);
    expect(
      await evalSettle(ctx, config(), round({ state: "settled", endTs: 0n }), CLOCK),
    ).to.equal(null);
    expect(await evalSettle(ctx, config({ paused: true }), round({ state: "locked" }), CLOCK)).to.equal(null);
  });
});

// ── cleanup ─────────────────────────────────────────────────────────────

describe("cleanup evaluator", () => {
  const settledBase = round({
    state: "settled",
    settleTs: 1_699_999_000n,
    entryCount: 3,
    entriesClosed: 0,
    winningTicket: 150_000_000n,
    prizeClaimed: false,
  });

  it("waits while the claim window is open", async () => {
    const { ctx } = makeCtx();
    // settle 1h+ ago, deadline 1h — exactly at the edge is NOT past.
    const action = await evalCleanup(ctx, config(), settledBase, clockAt(CLOCK.slot, 1_699_999_000n + 3_600n));
    expect(action).to.equal(null);
  });

  it("sweeps the unclaimed prize once past the deadline", async () => {
    const { ctx } = makeCtx();
    const action = await evalCleanup(ctx, config(), settledBase, clockAt(CLOCK.slot, 1_699_999_000n + 3_601n));
    expect(action?.kind).to.equal("sweep_unclaimed_prize");
    expect(await discOf(action!)).to.equal("72cea44accc08538");
  });

  it("claims for an absent winner at mid-deadline when configured", async () => {
    const winner = entry({ entryIndex: 1, ticketStart: 100_000_000n, ticketEnd: 300_000_000n });
    const { ctx } = makeCtx({ claimForWinners: true, entries: [winner] });
    const action = await evalCleanup(ctx, config(), settledBase, clockAt(CLOCK.slot, 1_699_999_000n + 1_800n));
    expect(action?.kind).to.equal("claim_winnings");
    expect(await discOf(action!)).to.equal("a1d7183b0eecf2dd");
  });

  it("sweeps BEFORE any close while the prize is unresolved (the winner proof outlives the sweep decision)", async () => {
    const loser = entry({ entryIndex: 0, ticketEnd: 100_000_000n });
    const winner = entry({ entryIndex: 1, ticketStart: 100_000_000n, ticketEnd: 300_000_000n });
    const { ctx } = makeCtx({ entries: [winner, loser] });
    // Unclaimed past deadline: the R4-isolated sweep comes first — entries
    // are NOT closed yet (the winning membership proof must survive).
    const sweep = await evalCleanup(ctx, config(), settledBase, clockAt(CLOCK.slot, 1_699_999_000n + 3_601n));
    expect(sweep?.kind).to.equal("sweep_unclaimed_prize");
    // Claimed: the batch may include the winner.
    const close = await evalCleanup(
      ctx,
      config(),
      { ...settledBase, prizeClaimed: true },
      clockAt(CLOCK.slot, 1_699_999_000n + 3_601n),
    );
    expect(close?.kind).to.equal("close_entry_batch");
    const tx = await close!.build(123_456n);
    expect(tx.instructions).to.have.lengthOf(2);
  });

  it("batches up to the configured width over a 25-entry round, excluding the winner until claimed", async () => {
    // Winner sits at index 3 so the first-11 batch would otherwise hit it.
    const entries = Array.from({ length: 25 }, (_, i) =>
      entry({
        entryIndex: i,
        ticketStart: BigInt(i) * 100_000_000n,
        ticketEnd: BigInt(i + 1) * 100_000_000n,
      }),
    );
    const winnerAt = 3;
    const winning = round({
      state: "settled",
      settleTs: 1_699_999_000n,
      entryCount: 25,
      entriesClosed: 0,
      prizeClaimed: false,
      winningTicket: BigInt(winnerAt) * 100_000_000n + 1n,
    });
    // Unclaimed: never reaches closes (sweep first) — the exclusion is the
    // belt below; the sweep-first ordering is the primary enforcement.
    const { ctx } = makeCtx({ entries });
    const sweep = await evalCleanup(ctx, config(), winning, clockAt(CLOCK.slot, 1_699_999_000n + 3_601n));
    expect(sweep?.kind).to.equal("sweep_unclaimed_prize");

    // Claimed: one batch of 11 covering all still-open entries, winner
    // included (its proof was consumed by the claim).
    const claimed = { ...winning, prizeClaimed: true };
    const batch = await evalCleanup(ctx, config(), claimed, clockAt(CLOCK.slot, 1_699_999_000n + 3_601n));
    expect(batch?.kind).to.equal("close_entry_batch");
    expect(batch?.quarantineOnFailure).to.equal(false, "contention must never quarantine refunds");
    const tx = await batch!.build(123_456n);
    expect(tx.instructions).to.have.lengthOf(11, "the configured width");
    const indices = tx.instructions.map((ix) => ix.data.readUInt32LE(8));
    expect(indices).to.deep.equal([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Belt: even if the prize were somehow unresolved at the close branch,
    // the winner is filtered out of the batch.
    const filtered = entries.filter((e) => e.entryIndex !== winnerAt);
    const { ctx: ctx2 } = makeCtx({ entries: filtered });
    // (settle book claims the prize so the branch is reachable)
    const belt = await evalCleanup(
      ctx2,
      config(),
      { ...claimed, prizeClaimed: false, settleTs: 1_699_999_000n },
      clockAt(CLOCK.slot, 1_699_999_000n),
    );
    // AUDIT C-4: inside the claim window the LOSERS' entries close now;
    // only the winning entry waits for its claim.
    expect(belt?.kind).to.equal("close_entry_batch");
    const beltIdx = (await belt!.build(1n)).instructions.map((ix) => ix.data.readUInt32LE(8));
    expect(beltIdx).to.not.include(winnerAt);
  });

  it("downgrades to single closes for the round after a batch failure", async () => {
    const entries = Array.from({ length: 25 }, (_, i) =>
      entry({ entryIndex: i, ticketStart: BigInt(i) * 100_000_000n, ticketEnd: BigInt(i + 1) * 100_000_000n }),
    );
    const settled = round({
      state: "settled",
      settleTs: 1_699_999_000n,
      entryCount: 25,
      entriesClosed: 0,
      prizeClaimed: true,
      winningTicket: 50_000_000n,
    });
    const { ctx, book } = makeCtx({ entries });
    // One failed atomic batch (the executor keys failures "kind:roundId").
    book.recordFailure(`close_entry_batch:${settled.roundId}`);
    const downgraded = await evalCleanup(ctx, config(), settled, clockAt(CLOCK.slot, 1_699_999_000n + 3_601n));
    expect(downgraded?.kind).to.equal("close_entry", "one bad entry must not stall the other ten");
    expect(downgraded?.quarantineOnFailure).to.equal(false);
    expect(await discOf(downgraded!)).to.equal("841aca91be257243");
    const tx = await downgraded!.build(123_456n);
    expect(tx.instructions).to.have.lengthOf(1);
    expect(tx.instructions[0]!.data.readUInt32LE(8)).to.equal(0);

    // A successful single resets nothing about the batch key — the round
    // stays downgraded until the entries are all closed.
    const again = await evalCleanup(ctx, config(), settled, clockAt(CLOCK.slot, 1_699_999_000n + 3_601n));
    expect(again?.kind).to.equal("close_entry");
  });

  it("closes the round once fully pruned", async () => {
    const { ctx } = makeCtx();
    const action = await evalCleanup(
      ctx,
      config(),
      { ...settledBase, prizeClaimed: true, entriesClosed: 3 },
      clockAt(CLOCK.slot, 1_699_999_000n + 4_000n),
    );
    expect(action?.kind).to.equal("close_round");
    expect(await discOf(action!)).to.equal("950e5158e6e2ea25");
    const tx = await action!.build(123_456n);
    // Phase 11.4 account list: config, round, vault, megaPot, destination,
    // crank, rent — the dust sink precedes the pinned admin destination.
    expect(tx.instructions[0]!.keys[3]!.pubkey.toString()).to.not.equal(DEFAULT_PK, "megaPot dust sink");
    expect(tx.instructions[0]!.keys[4]!.pubkey.toString()).to.not.equal(DEFAULT_PK, "rent destination");
  });

  it("refunds cancelled rounds immediately, then closes them", async () => {
    const cancelled = round({ state: "cancelled", entryCount: 2, entriesClosed: 0 });
    const sole = entry({ entryIndex: 0 });
    const { ctx } = makeCtx({ entries: [sole] });
    const refund = await evalCleanup(ctx, config(), cancelled, clockAt(CLOCK.slot, CLOCK.unix));
    expect(refund?.kind).to.equal("refund_entry");
    expect(await discOf(refund!)).to.equal("d6058817fd07e651");
    const drained = await evalCleanup(
      ctx,
      config(),
      { ...cancelled, entriesClosed: 2 },
      clockAt(CLOCK.slot, CLOCK.unix),
    );
    expect(drained?.kind).to.equal("close_round");
  });

  it("respects the cleanup kill-switch", async () => {
    const { ctx } = makeCtx({ cleanupEnabled: false });
    const action = await evalCleanup(ctx, config(), settledBase, clockAt(CLOCK.slot, 1_699_999_000n + 9_999n));
    expect(action).to.equal(null);
  });
});


// ── Phase 13: reclaiming the Switchboard rent ──────────────────────────

describe("close_randomness (cleanup)", () => {
  const pinned = Keypair.generate().publicKey;
  const pruned = round({
    state: "settled",
    settleTs: 1_699_999_000n,
    entryCount: 3,
    entriesClosed: 3,
    prizeClaimed: true,
    randomnessAccount: pinned.toBase58(),
  });
  const at = clockAt(CLOCK.slot, 1_699_999_000n + 4_000n);

  it("closes a pruned round's randomness BEFORE close_round, remembering its LUT", async () => {
    const views = new Map([[pinned.toBase58(), view({ lutSlot: 777n })]]);
    const { ctx, book } = makeCtx({ views });
    const action = await evalCleanup(ctx, config(), pruned, at);
    expect(action?.kind).to.equal("close_randomness");
    expect(action?.quarantineOnFailure).to.equal(false, "a stuck close must never strand the round");
    expect(await discOf(action!)).to.equal("f8105307bf85afac");
    const tx = await action!.build(1n);
    const keys = tx.instructions[0]!.keys;
    expect(keys[1]!.pubkey.toBase58()).to.equal(roundKey(pruned.roundId).toBase58());
    expect(keys[2]!.pubkey.toBase58()).to.equal(pinned.toBase58());
    const { lut } = lutKeys(new PublicKey(config().oracleProgramId), pinned, 777n);
    expect(keys[8]!.pubkey.toBase58()).to.equal(lut.toBase58(), "the LUT derives from the account's lut_slot");
    expect(book.pendingLuts()).to.deep.equal([
      { roundId: pruned.roundId, randomness: pinned.toBase58(), lutSlot: 777n },
    ]);
  });

  it("still calls close_randomness when the account is gone — the program only clears the pin (AUDIT P-4)", async () => {
    const { ctx } = makeCtx({ views: new Map([[pinned.toBase58(), null]]) });
    const action = await evalCleanup(ctx, config(), pruned, at);
    expect(action?.kind).to.equal("close_randomness");
    expect(action?.label).to.include("already gone");
  });

  it("never falls through to close_round while the pin is set, however often the close fails (AUDIT P-4)", async () => {
    const views = new Map([[pinned.toBase58(), view({ lutSlot: 777n })]]);
    const { ctx, book } = makeCtx({ views });
    for (let i = 0; i < 5; i += 1) {
      book.recordFailure(`close_randomness:${pruned.roundId}`);
      expect((await evalCleanup(ctx, config(), pruned, at))?.kind).to.equal("close_randomness");
    }
  });

  it("skips rounds that never pinned randomness (sole-depositor cancels)", async () => {
    const { ctx } = makeCtx();
    const cancelled = round({ state: "cancelled", entryCount: 1, entriesClosed: 1 });
    expect((await evalCleanup(ctx, config(), cancelled, at))?.kind).to.equal("close_round");
  });

  it("also reclaims a cancelled round that did pin randomness (oracle timeout)", async () => {
    const views = new Map([[pinned.toBase58(), view({ lutSlot: 5n })]]);
    const { ctx } = makeCtx({ views });
    const cancelled = round({
      state: "cancelled",
      entryCount: 1,
      entriesClosed: 1,
      randomnessAccount: pinned.toBase58(),
    });
    expect((await evalCleanup(ctx, config(), cancelled, at))?.kind).to.equal("close_randomness");
  });
});

describe("LUT sweep", () => {
  const oracleProgram = () => new PublicKey(config().oracleProgramId);

  function setup(deactivationSlot: bigint | null) {
    const luts = new Map<string, bigint>();
    const made = makeCtx({ luts });
    const kp = made.book.randomnessKeypair(42n);
    made.book.rememberLut(42n, kp.publicKey.toBase58(), 900n);
    const { lut } = lutKeys(oracleProgram(), kp.publicKey, 900n);
    if (deactivationSlot !== null) luts.set(lut.toBase58(), deactivationSlot);
    return { ...made, kp, lut };
  }

  it("closes a deactivated table once it is past the cooldown, signed by the randomness keypair", async () => {
    const { ctx, book, kp, lut } = setup(CLOCK.slot - LUT_COOLDOWN_SLOTS - 1n);
    const action = await evalLutSweep(ctx, config(), CLOCK);
    expect(action?.kind).to.equal("close_randomness_lut");
    expect(action?.extraSigners?.map((k) => k.publicKey.toBase58())).to.deep.equal([kp.publicKey.toBase58()]);
    const ix = (await action!.build(1n)).instructions[0]!;
    expect(ix.programId.toBase58()).to.equal(oracleProgram().toBase58());
    expect(ix.data.subarray(0, 8).toString("hex")).to.equal("ea0585cc372555de");
    expect(ix.data.readBigUInt64LE(8)).to.equal(900n);
    expect(ix.keys[0]!.isSigner).to.equal(true);
    expect(ix.keys[1]!.pubkey.toBase58()).to.equal(lut.toBase58());
    expect(ix.keys[3]!.pubkey.toBase58()).to.equal(ctx.keeper.publicKey.toBase58(), "rent returns to the keeper");
    await action!.after!("sig");
    expect(book.pendingLuts()).to.deep.equal([]);
  });

  it("waits out the cooldown", async () => {
    const { ctx, book } = setup(CLOCK.slot - LUT_COOLDOWN_SLOTS);
    expect(await evalLutSweep(ctx, config(), CLOCK)).to.equal(null);
    expect(book.pendingLuts()).to.have.lengthOf(1);
  });

  it("keeps waiting while the table is still active", async () => {
    const { ctx, book } = setup(18_446_744_073_709_551_615n);
    expect(await evalLutSweep(ctx, config(), CLOCK)).to.equal(null);
    expect(book.pendingLuts()).to.have.lengthOf(1);
  });

  it("drops an active table whose close_randomness was given up on", async () => {
    const { ctx, book } = setup(18_446_744_073_709_551_615n);
    book.recordFailure("close_randomness:42");
    book.recordFailure("close_randomness:42");
    expect(await evalLutSweep(ctx, config(), CLOCK)).to.equal(null);
    expect(book.pendingLuts()).to.deep.equal([]);
  });

  it("forgets a table that no longer exists", async () => {
    const { ctx, book } = setup(null);
    expect(await evalLutSweep(ctx, config(), CLOCK)).to.equal(null);
    expect(book.pendingLuts()).to.deep.equal([]);
  });

  it("refuses to sign with a keypair that does not match the recorded account", async () => {
    const luts = new Map<string, bigint>();
    const { ctx, book } = makeCtx({ luts });
    const stranger = Keypair.generate().publicKey;
    book.rememberLut(7n, stranger.toBase58(), 900n);
    const { lut } = lutKeys(oracleProgram(), stranger, 900n);
    luts.set(lut.toBase58(), 1n);
    expect(await evalLutSweep(ctx, config(), CLOCK)).to.equal(null);
    expect(book.pendingLuts()).to.deep.equal([]);
  });

  it("does nothing with cleanup disabled", async () => {
    const luts = new Map<string, bigint>();
    const { ctx, book } = makeCtx({ luts, cleanupEnabled: false });
    book.rememberLut(1n, Keypair.generate().publicKey.toBase58(), 1n);
    expect(await evalLutSweep(ctx, config(), CLOCK)).to.equal(null);
  });
});


// ── randomness fallback: entropy provider ─────────────────────────────

describe("entropy seeds and mirror", () => {
  it("walks the chain from checkpoints exactly as a naive hash loop", () => {
    const x0 = Buffer.alloc(32, 9);
    const seeds = new EntropySeeds(x0, 3000);
    let x: Buffer = x0;
    for (let i = 0; i <= 3000; i += 1) {
      if (i === 0 || i === 1023 || i === 1024 || i === 2049 || i === 3000) {
        expect(seeds.link(i).equals(x)).to.equal(true, `link ${i}`);
      }
      x = sha256(x);
    }
  });

  it("finds the seed that opens the on-chain commit, and only that one", () => {
    const seeds = new EntropySeeds(Buffer.alloc(32, 4), 10);
    const commit = seeds.commit().toString("hex");
    const seed = seeds.seedFor(commit, 10n)!;
    expect(sha256(seed).toString("hex")).to.equal(commit);
    expect(seeds.seedFor(commit, 9n)).to.equal(null, "wrong position");
    expect(seeds.seedFor("00".repeat(32), 10n)).to.equal(null, "foreign chain");
    expect(seeds.seedFor(commit, 0n)).to.equal(null);
  });

  it("matches the program's value known answer", () => {
    expect(entropyValue(7n, Buffer.alloc(32, 1), Buffer.alloc(32, 2)).toString("hex")).to.equal(
      "da5387c4b14dda39212d5fecb05802001a7e5a0be11ff26ee0354877ce62987c",
    );
  });

  it("resolves SlotHashes with the program's rules", () => {
    const sysvar = (entries: Array<[bigint, number]>) => {
      const b = Buffer.alloc(8 + entries.length * 40);
      b.writeBigUInt64LE(BigInt(entries.length), 0);
      entries.forEach(([slot, fill], i) => {
        b.writeBigUInt64LE(slot, 8 + i * 40);
        b.fill(fill, 16 + i * 40, 48 + i * 40);
      });
      return b;
    };
    const skipped = findSlotHash(sysvar([[106n, 6], [104n, 4], [102n, 2]]), 103n);
    expect(skipped.kind === "found" && skipped.slot === 104n && skipped.hash[0] === 4).to.equal(true);
    expect(findSlotHash(sysvar([[102n, 2]]), 103n).kind).to.equal("notReached");
    expect(findSlotHash(sysvar([[106n, 6], [104n, 4]]), 103n).kind).to.equal("expired");
    expect(findSlotHash(Buffer.alloc(4), 1n).kind).to.equal("malformed");
  });
});

describe("settle evaluator — entropy provider", () => {
  const CHAIN = entropyChainKey().toBase58();
  const seeds = new EntropySeeds(Buffer.alloc(32, 5), 8);
  function chainData(over: Partial<EntropyChainData> = {}): EntropyChainData {
    return {
      commit: seeds.commit().toString("hex"),
      remaining: 8n,
      pendingRound: ENTROPY_NONE,
      targetSlot: 0n,
      requestSlot: 0n,
      value: "00".repeat(32),
      valueRound: ENTROPY_NONE,
      valueSlot: 0n,
      revealedCount: 0n,
      bump: 255,
      ...over,
    };
  }
  const slotHashes = (slots: bigint[]) => {
    const b = Buffer.alloc(8 + slots.length * 40);
    b.writeBigUInt64LE(BigInt(slots.length), 0);
    slots.forEach((slot, i) => {
      b.writeBigUInt64LE(slot, 8 + i * 40);
      b.fill(0x11 + i, 16 + i * 40, 48 + i * 40);
    });
    return b;
  };
  const entropyConfig = () => config({ oracleProvider: "entropy" });

  it("pins a locked round to the chain when the provider is entropy", async () => {
    const { ctx } = makeCtx({ chain: chainData(), entropy: seeds });
    const action = await evalSettle(ctx, entropyConfig(), round({ state: "locked" }), CLOCK);
    expect(action?.kind).to.equal("request_entropy");
    expect(await discOf(action!)).to.equal("e66c1accaf8ff12b");
  });

  it("waits while the chain is busy with the previous round", async () => {
    const { ctx } = makeCtx({ chain: chainData({ pendingRound: 3n }), entropy: seeds });
    expect(await evalSettle(ctx, entropyConfig(), round({ state: "locked", roundId: 4n }), CLOCK)).to.equal(null);
    const { ctx: c2 } = makeCtx({ chain: chainData({ valueRound: 3n }), entropy: seeds });
    expect(await evalSettle(c2, entropyConfig(), round({ state: "locked", roundId: 4n }), CLOCK)).to.equal(null);
  });

  it("keeps a Switchboard-pinned round on Switchboard after a flip", async () => {
    const pinned = Keypair.generate().publicKey;
    const { ctx } = makeCtx({
      views: new Map([[pinned.toBase58(), view({ seedSlot: 9_900n, revealSlot: 9_950n })]]),
      chain: chainData(),
      entropy: seeds,
    });
    const action = await evalSettle(
      ctx,
      entropyConfig(),
      round({ state: "awaitingRandomness", randomnessAccount: pinned.toBase58(), lockSlot: 100n, randomnessCommitSlot: 9_900n }),
      CLOCK,
    );
    expect(action?.kind).to.equal("fulfill_settle");
    const keys = (await action!.build(1n)).instructions[0]!.keys;
    expect(keys[5]!.pubkey.equals(pinned)).to.equal(true);
  });

  it("waits for the target slot, then reveals and settles in one tx with the locally computed winner", async () => {
    const r = round({ roundId: 0n, state: "awaitingRandomness", randomnessAccount: CHAIN, randomnessCommitSlot: 9_990n, totalLamports: 3_000_000_000n });
    const pending = chainData({ pendingRound: 0n, targetSlot: 9_992n });
    const early = makeCtx({ chain: pending, entropy: seeds, slotHashes: slotHashes([9_991n, 9_990n]) });
    expect(await evalSettle(early.ctx, entropyConfig(), r, clockAt(9_992n, 1n))).to.equal(null);

    const sysvar = slotHashes([9_994n, 9_993n, 9_991n, 9_990n]);
    const seed = seeds.seedFor(pending.commit, pending.remaining)!;
    const value = entropyValue(0n, Buffer.alloc(32, 0x12), seed); // 9_993 is index 1 → fill 0x12
    const ticket = ticketFromEntropy(splitEntropy(value).ticket, r.totalLamports);
    const entries = [
      entry({ roundId: 0n, entryIndex: 0, ticketStart: 0n, ticketEnd: 1_000_000_000n }),
      entry({ roundId: 0n, entryIndex: 1, ticketStart: 1_000_000_000n, ticketEnd: 3_000_000_000n }),
    ];
    const winnerIdx = ticket < 1_000_000_000n ? 0 : 1;
    const { ctx } = makeCtx({ chain: pending, entropy: seeds, slotHashes: sysvar, entries });
    const action = await evalSettle(ctx, config({ oracleProvider: "entropy", economicsVersion: 3 }), r, clockAt(9_995n, 1n));
    expect(action?.kind).to.equal("reveal_and_settle");
    const tx = await action!.build(1n);
    expect(tx.instructions[0]!.data.subarray(0, 8).toString("hex")).to.equal("709dae7be95310ee");
    expect(tx.instructions[0]!.data.subarray(8).equals(seed)).to.equal(true);
    expect(tx.instructions[1]!.data.subarray(0, 8).toString("hex")).to.equal("78ab73054b43bb43");
    const settleKeys = tx.instructions[1]!.keys;
    expect(settleKeys[5]!.pubkey.toBase58()).to.equal(CHAIN);
    expect(settleKeys[settleKeys.length - 1]!.pubkey.equals(entryKey(0n, winnerIdx))).to.equal(true);
  });

  it("falls back to a plain reveal after a failed combined send", async () => {
    const r = round({ state: "awaitingRandomness", randomnessAccount: CHAIN, randomnessCommitSlot: 9_990n });
    const { ctx, book } = makeCtx({
      chain: chainData({ pendingRound: r.roundId, targetSlot: 9_992n }),
      entropy: seeds,
      slotHashes: slotHashes([9_994n, 9_993n, 9_990n]),
    });
    book.recordFailure(`reveal_and_settle:${r.roundId}`);
    const action = await evalSettle(ctx, entropyConfig(), r, clockAt(9_995n, 1n));
    expect(action?.kind).to.equal("reveal_entropy");
  });

  it("halts loudly (no tx) when the seed file does not match the chain", async () => {
    const r = round({ state: "awaitingRandomness", randomnessAccount: CHAIN, randomnessCommitSlot: 9_990n });
    const other = new EntropySeeds(Buffer.alloc(32, 6), 8);
    const { ctx } = makeCtx({
      chain: chainData({ pendingRound: r.roundId, targetSlot: 9_992n }),
      entropy: other,
      slotHashes: slotHashes([9_994n, 9_993n, 9_990n]),
    });
    expect(await evalSettle(ctx, entropyConfig(), r, clockAt(9_995n, 1n))).to.equal(null);
  });

  it("settles a revealed value", async () => {
    const r = round({ state: "awaitingRandomness", randomnessAccount: CHAIN, randomnessCommitSlot: 9_990n });
    const { ctx } = makeCtx({ chain: chainData({ valueRound: r.roundId, value: "ab".repeat(32) }), entropy: seeds });
    const action = await evalSettle(ctx, entropyConfig(), r, CLOCK);
    expect(action?.kind).to.equal("fulfill_settle");
  });

  it("cancels only after the 24 h entropy deadline, never at the Switchboard one", async () => {
    const r = round({ state: "awaitingRandomness", randomnessAccount: CHAIN, randomnessCommitSlot: 1_000n });
    const chain = chainData({ pendingRound: r.roundId, targetSlot: 1_002n });
    const { ctx } = makeCtx({ chain, entropy: null, slotHashes: null });
    expect(await evalSettle(ctx, entropyConfig(), r, clockAt(1_401n, 1n))).to.equal(null);
    const action = await evalSettle(ctx, entropyConfig(), r, clockAt(1_000n + 216_001n, 1n));
    expect(action?.kind).to.equal("cancel_round");
    expect((await action!.build(1n)).instructions[0]!.keys[5]!.pubkey.toBase58()).to.equal(CHAIN);
  });
});

describe("close_randomness (cleanup) — entropy pin", () => {
  it("only clears the chain pin, never treats it as Switchboard rent", async () => {
    const { ctx } = makeCtx();
    const r = round({
      state: "cancelled",
      randomnessAccount: entropyChainKey().toBase58(),
      entryCount: 0,
      entriesClosed: 0,
    });
    const action = await evalCleanup(ctx, config(), r, CLOCK);
    expect(action?.kind).to.equal("close_randomness");
    expect(action?.label).to.contain("entropy pin");
  });
});
