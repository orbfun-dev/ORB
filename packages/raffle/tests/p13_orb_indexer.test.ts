/**
 * P13 — the ORB wheel indexer (randomness-fallback launch, 2026-10-08):
 * settled rounds award 1 entry per 1 SOL automatically, cancelled rounds
 * never do, unresolved rounds hold the cursor, auto-play credits the
 * escrow OWNER, and every award dedups.
 */

import { expect } from "chai";
import { before, beforeEach, describe, it } from "mocha";
import { resetDb, testDb, testSignature, testWallet, TestDb } from "./helpers/db";
import { testConfig } from "./helpers/raffle";
import { FakeFeeChain, pgIndexerStore } from "./helpers/indexer";
import { autoDepositedLogLine, depositedLogLine, syntheticTx } from "./helpers/tx";
import { ORB_INDEXER_CURSOR, runOrbIndexer, type OrbIndexerRun } from "../src/orb-indexer";
import { upsertOrbRound } from "../src/store";
import type { OrbRoundState } from "../src/store";
import type { CachedOutcome } from "../src/round-cache";

const SOL = 1_000_000_000n;
let db: TestDb;
let chain: FakeFeeChain;
/** Live round accounts: state, or absent (= closed). */
let live: Map<number, OrbRoundState>;
/** Closed rounds' outcomes from their PDA history. */
let history: Map<number, CachedOutcome>;
let slotSeq = 500_000_000;

async function openEpoch(): Promise<number> {
  const rows = await db.q(
    `INSERT INTO raffle_epochs (starts_at, ends_at, cap) VALUES (now() - interval '1 minute', now() + interval '7 days', 1000) RETURNING id`,
  );
  return Number(rows[0].id);
}

function deposit(roundId: number, player: string, lamports: bigint, blockTime?: number): string {
  const sig = testSignature();
  chain.add(
    sig,
    syntheticTx({
      signature: sig,
      slot: (slotSeq += 1),
      blockTime,
      signers: [player],
      logLines: [depositedLogLine({ roundId: BigInt(roundId), player, amountLamports: lamports })],
    }),
  );
  return sig;
}

function autoDeposit(roundId: number, crank: string, items: Array<{ owner: string; escrow: string; lamports: bigint }>): string {
  const sig = testSignature();
  chain.add(
    sig,
    syntheticTx({
      signature: sig,
      slot: (slotSeq += 1),
      signers: [crank],
      logLines: items.map((it, i) =>
        autoDepositedLogLine({ roundId: BigInt(roundId), entryIndex: i, owner: it.owner, escrow: it.escrow, amountLamports: it.lamports }),
      ),
    }),
  );
  return sig;
}

/** A program transaction with no deposit (lock, settle, close…). */
function other(): string {
  const sig = testSignature();
  chain.add(sig, syntheticTx({ signature: sig, slot: (slotSeq += 1), signers: [testWallet()] }));
  return sig;
}

function run(): Promise<OrbIndexerRun> {
  const pool = db.pool;
  const base = pgIndexerStore(pool);
  return runOrbIndexer({
    config: testConfig(),
    store: {
      ...base,
      async getOrbRound(roundId) {
        const res = await pool.query("SELECT state, reason FROM raffle_orb_rounds WHERE round_id = $1", [roundId]);
        const row = res.rows[0];
        return row ? { state: row.state, reason: row.reason ?? null } : null;
      },
      async upsertOrbRound(roundId, o) {
        await pool.query(
          `INSERT INTO raffle_orb_rounds (round_id, state, reason, decided_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (round_id) DO UPDATE SET state = $2, reason = $3, decided_at = $4`,
          [roundId, o.state, o.reason, o.decidedAt],
        );
      },
    },
    listSignatures: (opts) => chain.listSignatures(opts),
    fetchTransaction: (sig) => chain.fetchTransaction(sig),
    fetchRoundState: async (roundId) => {
      const state = live.get(Number(roundId));
      return state === undefined ? null : { state, settleTs: 1_700_000_000n };
    },
    fetchOutcomeFromHistory: async (roundId) => history.get(Number(roundId)) ?? null,
  });
}

async function entriesOf(wallet: string): Promise<number> {
  const rows = await db.q("SELECT count(*) AS n FROM raffle_entries WHERE wallet = $1", [wallet]);
  return Number(rows[0].n);
}

async function cursor(): Promise<string | null> {
  const rows = await db.q("SELECT last_signature FROM raffle_indexer_cursors WHERE name = $1", [ORB_INDEXER_CURSOR]);
  return rows[0]?.last_signature ?? null;
}

before(async () => {
  db = await testDb();
});
beforeEach(async () => {
  await resetDb(db);
  chain = new FakeFeeChain();
  live = new Map();
  history = new Map();
  void upsertOrbRound; // store helper is exercised through the endpoint wiring
});

describe("P13 — ORB wheel indexer", () => {
  it("awards 1 entry per 1 SOL for a settled round, and caches the outcome", async () => {
    await openEpoch();
    const player = testWallet();
    deposit(7, player, (5n * SOL) / 2n); // 2.5 SOL
    const last = other();
    live.set(7, "settled");
    const r = await run();
    expect(r.status).to.equal("ok");
    expect(r.awarded).to.equal(2);
    expect(await entriesOf(player)).to.equal(2);
    expect(await cursor()).to.equal(last);
    const cached = await db.q("SELECT state FROM raffle_orb_rounds WHERE round_id = 7");
    expect(cached[0].state).to.equal("settled");
  });

  it("never awards a cancelled round — a rejected ledger row only", async () => {
    await openEpoch();
    const player = testWallet();
    deposit(8, player, 3n * SOL);
    live.set(8, "cancelled");
    const r = await run();
    expect(r.awarded).to.equal(0);
    expect(r.skipped.round_cancelled).to.equal(1);
    expect(await entriesOf(player)).to.equal(0);
    const rows = await db.q("SELECT status FROM raffle_events WHERE wallet = $1", [player]);
    expect(rows.map((x: { status: string }) => x.status)).to.deep.equal(["rejected"]);
  });

  it("holds the cursor before a deposit whose round is unresolved, then awards once it settles", async () => {
    await openEpoch();
    const player = testWallet();
    const first = other();
    deposit(9, player, 1n * SOL);
    other();
    live.set(9, "locked");
    const r1 = await run();
    expect(r1.status).to.equal("waiting_for_round");
    expect(r1.waitingRound).to.equal(9);
    expect(await cursor()).to.equal(first);
    expect(await entriesOf(player)).to.equal(0);

    live.set(9, "settled");
    const r2 = await run();
    expect(r2.status).to.equal("ok");
    expect(await entriesOf(player)).to.equal(1);
  });

  it("credits auto-play deposits to each escrow OWNER, never the escrow", async () => {
    await openEpoch();
    const a = testWallet();
    const b = testWallet();
    const escrowA = testWallet();
    const escrowB = testWallet();
    autoDeposit(10, testWallet(), [
      { owner: a, escrow: escrowA, lamports: 1n * SOL },
      { owner: b, escrow: escrowB, lamports: 2n * SOL },
    ]);
    live.set(10, "settled");
    await run();
    expect(await entriesOf(a)).to.equal(1);
    expect(await entriesOf(b)).to.equal(2);
    expect(await entriesOf(escrowA)).to.equal(0);
  });

  it("resolves a closed round from its history", async () => {
    await openEpoch();
    const player = testWallet();
    deposit(11, player, 1n * SOL);
    history.set(11, { state: "settled", reason: null, decidedAt: null });
    const r = await run();
    expect(r.status).to.equal("ok");
    expect(await entriesOf(player)).to.equal(1);
  });

  it("skips a deposit made before the open epoch started (AUDIT R-5)", async () => {
    await openEpoch();
    const player = testWallet();
    deposit(12, player, 2n * SOL, Math.floor(Date.now() / 1000) - 3600);
    live.set(12, "settled");
    const r = await run();
    expect(r.skipped.before_epoch ?? 0).to.equal(0, "pre-launch deposits are not even fetched");
    expect(await entriesOf(player)).to.equal(0);
  });

  it("is idempotent: a re-run (cursor reset) never double-awards", async () => {
    await openEpoch();
    const player = testWallet();
    deposit(13, player, 2n * SOL);
    live.set(13, "settled");
    await run();
    await db.q("DELETE FROM raffle_indexer_cursors");
    await db.q("DELETE FROM raffle_orb_rounds");
    await run();
    expect(await entriesOf(player)).to.equal(2);
  });

  it("does nothing without an open epoch", async () => {
    await db.q(
      `INSERT INTO raffle_epochs (starts_at, ends_at, cap, status) VALUES (now() - interval '2 days', now() - interval '1 day', 1000, 'locked')`,
    );
    deposit(14, testWallet(), 1n * SOL);
    live.set(14, "settled");
    const r = await run();
    expect(r.status).to.equal("no_open_epoch");
  });
});
