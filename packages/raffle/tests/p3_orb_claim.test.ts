/**
 * P3 GATE — ORB game claim (directive §7 P3, §6.1.1).
 *
 *  - a settled round awards (accrual into raffle_progress, grant paid);
 *  - a CANCELLED round awards ZERO and records reject_reason — the test
 *    is named for the farm it prevents: deposit alone, take the 100%
 *    I15 refund, keep the entry. Not here;
 *  - an unresolved round answers 202 pending, awarding nothing;
 *  - `AutoDeposited` attributes to the escrow OWNER, never the escrow
 *    PDA, and never the crank that signed the transaction;
 *  - a replayed signature is a no-op (R6).
 *
 * Runs the REAL endpoint orchestration over the REAL local-Postgres SQL
 * (pgClaimStore → raffle_submit_earned_event), with synthetic finalized
 * transactions.
 */

import { expect } from "chai";
import bs58 from "bs58";
import { before, beforeEach, describe, it } from "mocha";
import { resetDb, testDb, testSignature, testWallet, TestDb } from "./helpers/db";
import { pgClaimStore, testConfig, type ServedResponse } from "./helpers/raffle";
import {
  autoDepositedLogLine,
  depositedLogLine,
  syntheticTx,
} from "./helpers/tx";
import { claimEndpoint, type ClaimDeps } from "../src/endpoints/claim";
import { ORB_PROGRAM_ID } from "../src/classify";

let db: TestDb;
let deps: ClaimDeps;
let handleClaim: ReturnType<typeof claimEndpoint>;

const SOL = 1_000_000_000n;
const ROUND_ID = 42n;

/** Fixed, REAL base58 pubkeys for non-wallet fixtures. */
function fixedKey(tag: string): string {
  const seed = Buffer.alloc(32);
  Buffer.from(tag, "utf8").copy(seed, 0);
  return bs58.encode(seed);
}
const ESCROW_PDA = fixedKey("escrow-pda");
const CRANK = fixedKey("crank-wallet");

async function openEpoch(): Promise<number> {
  const rows = await db.q(
    `INSERT INTO raffle_epochs (ends_at, cap) VALUES (now() + interval '7 days', 1000) RETURNING id`,
  );
  return Number(rows[0].id);
}

async function cacheRound(state: string, reason: number | null = null): Promise<void> {
  await db.q(
    `INSERT INTO raffle_orb_rounds (round_id, state, reason, decided_at)
     VALUES ($1, $2, $3, now()) ON CONFLICT (round_id) DO UPDATE SET state = $2, reason = $3`,
    [Number(ROUND_ID), state, reason],
  );
}

function depsFor(): ClaimDeps {
  const store = pgClaimStore(db.pool);
  return {
    config: testConfig(),
    store,
    fetchTransaction: async (signature: string) => {
      // The test queue: one synthetic tx per signature, always finalized.
      return txQueue.get(signature) ?? null;
    },
  };
}

const txQueue = new Map<string, any>();

function claim(signature: string, wallet: string): Promise<ServedResponse> {
  return handleClaim({ method: "POST", headers: {}, body: { signature, wallet } });
}

before(async () => {
  db = await testDb();
});
beforeEach(async () => {
  await resetDb(db);
  txQueue.clear();
  deps = depsFor();
  handleClaim = claimEndpoint(deps);
});

describe("P3 — a settled round awards", () => {
  it("credits 1 entry per 1 SOL via accrual, attributing the depositor", async () => {
    const epoch = await openEpoch();
    await cacheRound("settled");
    const wallet = testWallet();
    const sig = testSignature();

    txQueue.set(
      sig,
      syntheticTx({
        signature: sig,
        signers: [wallet],
        accountKeys: [wallet, ORB_PROGRAM_ID],
        logLines: [
          depositedLogLine({ roundId: ROUND_ID, player: wallet, amountLamports: 2n * SOL }),
        ],
      }),
    );

    const res = await claim(sig, wallet);
    expect(res.status).to.equal(200);
    expect(res.payload.awarded).to.equal(2);
    expect(res.payload.reason).to.equal("ok");

    const entries = await db.q(
      "SELECT entry_no, source, status FROM raffle_entries WHERE epoch_id = $1 AND wallet = $2 ORDER BY entry_no",
      [epoch, wallet],
    );
    expect(entries.map((e) => Number(e.entry_no))).to.deep.equal([1, 2]);
    expect(entries.every((e) => e.source === "orb_game" && e.status === "confirmed")).to.be.true;

    const progress = await db.q(
      "SELECT cumulative_lamports, entries_awarded FROM raffle_progress WHERE epoch_id = $1 AND wallet = $2 AND source = 'orb_game'",
      [epoch, wallet],
    );
    expect(BigInt(progress[0].cumulative_lamports)).to.equal(2n * SOL);
    expect(Number(progress[0].entries_awarded)).to.equal(2);
  });

  it("sub-threshold deposits accrue without awarding (R5 carry)", async () => {
    const epoch = await openEpoch();
    await cacheRound("settled");
    const wallet = testWallet();
    const sig = testSignature();

    txQueue.set(
      sig,
      syntheticTx({
        signature: sig,
        signers: [wallet],
        accountKeys: [wallet, ORB_PROGRAM_ID],
        logLines: [
          depositedLogLine({ roundId: ROUND_ID, player: wallet, amountLamports: 600_000_000n }),
        ],
      }),
    );

    const res = await claim(sig, wallet);
    expect(res.status).to.equal(200);
    expect(res.payload.awarded).to.equal(0);

    const progress = await db.q(
      "SELECT cumulative_lamports FROM raffle_progress WHERE epoch_id = $1 AND wallet = $2 AND source = 'orb_game'",
      [epoch, wallet],
    );
    expect(BigInt(progress[0].cumulative_lamports)).to.equal(600_000_000n);
    const entries = await db.q("SELECT count(*) AS n FROM raffle_entries WHERE epoch_id = $1", [epoch]);
    expect(Number(entries[0].n)).to.equal(0);
  });
});

describe("P3 — the sole-depositor refund farm earns exactly zero entries (R3/I15)", () => {
  it("a cancelled round awards nothing, ever, and records reject_reason", async () => {
    const epoch = await openEpoch();
    await cacheRound("cancelled", 1); // reason 1: sole depositor, 100% refund
    const wallet = testWallet();
    const sig = testSignature();

    txQueue.set(
      sig,
      syntheticTx({
        signature: sig,
        signers: [wallet],
        accountKeys: [wallet, ORB_PROGRAM_ID],
        logLines: [
          depositedLogLine({ roundId: ROUND_ID, player: wallet, amountLamports: 5n * SOL }),
        ],
      }),
    );

    const res = await claim(sig, wallet);
    expect(res.status).to.equal(200);
    expect(res.payload.awarded).to.equal(0);
    expect(res.payload.reason).to.equal("round_cancelled");

    const entries = await db.q("SELECT count(*) AS n FROM raffle_entries WHERE epoch_id = $1", [epoch]);
    expect(Number(entries[0].n), "no entry may exist for a cancelled round").to.equal(0);

    const events = await db.q(
      "SELECT status, reject_reason, sol_lamports FROM raffle_events WHERE signature = $1",
      [sig],
    );
    expect(events).to.have.lengthOf(1);
    expect(events[0].status).to.equal("rejected");
    expect(events[0].reject_reason).to.equal("round_cancelled:1");
    expect(BigInt(events[0].sol_lamports)).to.equal(5n * SOL);

    // The refund farm is not transferable to progress either.
    const progress = await db.q(
      "SELECT count(*) AS n FROM raffle_progress WHERE epoch_id = $1",
      [epoch],
    );
    expect(Number(progress[0].n)).to.equal(0);
  });

  it("reason 2 (oracle timeout) also earns nothing", async () => {
    await openEpoch();
    await cacheRound("cancelled", 2);
    const wallet = testWallet();
    const sig = testSignature();

    txQueue.set(
      sig,
      syntheticTx({
        signature: sig,
        signers: [wallet],
        accountKeys: [wallet, ORB_PROGRAM_ID],
        logLines: [
          depositedLogLine({ roundId: ROUND_ID, player: wallet, amountLamports: 5n * SOL }),
        ],
      }),
    );

    const res = await claim(sig, wallet);
    expect(res.payload.awarded).to.equal(0);
    const events = await db.q("SELECT reject_reason FROM raffle_events WHERE signature = $1", [sig]);
    expect(events[0].reject_reason).to.equal("round_cancelled:2");
  });
});

describe("P3 — unresolved rounds stay pending", () => {
  it("202 with unlocks_at_round and no ledger row while the round is open", async () => {
    await openEpoch();
    await cacheRound("open");
    const wallet = testWallet();
    const sig = testSignature();

    txQueue.set(
      sig,
      syntheticTx({
        signature: sig,
        signers: [wallet],
        accountKeys: [wallet, ORB_PROGRAM_ID],
        logLines: [
          depositedLogLine({ roundId: ROUND_ID, player: wallet, amountLamports: 2n * SOL }),
        ],
      }),
    );

    const res = await claim(sig, wallet);
    expect(res.status).to.equal(202);
    expect(res.payload.status).to.equal("pending");
    expect(res.payload.unlocks_at_round).to.equal(Number(ROUND_ID));

    const events = await db.q("SELECT count(*) AS n FROM raffle_events WHERE signature = $1", [sig]);
    expect(Number(events[0].n)).to.equal(0);
  });

  it("202 when the round is not cached at all (late claim after close)", async () => {
    await openEpoch();
    const wallet = testWallet();
    const sig = testSignature();
    txQueue.set(
      sig,
      syntheticTx({
        signature: sig,
        signers: [wallet],
        accountKeys: [wallet, ORB_PROGRAM_ID],
        logLines: [
          depositedLogLine({ roundId: ROUND_ID, player: wallet, amountLamports: 2n * SOL }),
        ],
      }),
    );
    const res = await claim(sig, wallet);
    expect(res.status).to.equal(202);
  });
});

describe("P3 — AutoDeposited attributes to the escrow owner", () => {
  it("credits the owner, not the escrow PDA, on a crank-signed transaction", async () => {
    const epoch = await openEpoch();
    await cacheRound("settled");
    const owner = testWallet();
    const sig = testSignature();

    txQueue.set(
      sig,
      syntheticTx({
        signature: sig,
        signers: [CRANK], // the crank signs; the owner authorized the escrow
        accountKeys: [CRANK, ORB_PROGRAM_ID],
        logLines: [
          autoDepositedLogLine({
            roundId: ROUND_ID,
            owner,
            escrow: ESCROW_PDA,
            amountLamports: 1_500_000_000n,
          }),
        ],
      }),
    );

    const res = await claim(sig, owner); // owner claims, crank signed
    expect(res.status).to.equal(200);
    expect(res.payload.awarded).to.equal(1);

    const entries = await db.q(
      "SELECT wallet FROM raffle_entries WHERE epoch_id = $1",
      [epoch],
    );
    expect(entries.map((e) => e.wallet)).to.deep.equal([owner]);

    const events = await db.q("SELECT wallet FROM raffle_events WHERE signature = $1", [sig]);
    expect(events.map((e) => e.wallet)).to.deep.equal([owner]);
  });

  it("never credits the escrow PDA as a wallet", async () => {
    await openEpoch();
    await cacheRound("settled");
    const owner = testWallet();
    const sig = testSignature();
    txQueue.set(
      sig,
      syntheticTx({
        signature: sig,
        signers: [CRANK],
        accountKeys: [CRANK, ORB_PROGRAM_ID],
        logLines: [
          autoDepositedLogLine({
            roundId: ROUND_ID,
            owner,
            escrow: ESCROW_PDA,
            amountLamports: 2n * SOL,
          }),
        ],
      }),
    );
    await claim(sig, owner);
    const wallets = await db.q("SELECT pubkey FROM raffle_wallets");
    expect(wallets.map((w) => w.pubkey)).to.include(owner);
    expect(wallets.map((w) => w.pubkey)).to.not.include(ESCROW_PDA);
  });
});

describe("P3 — R6 replay and R2 authorization", () => {
  it("a replayed signature is a no-op", async () => {
    const epoch = await openEpoch();
    await cacheRound("settled");
    const wallet = testWallet();
    const sig = testSignature();
    txQueue.set(
      sig,
      syntheticTx({
        signature: sig,
        signers: [wallet],
        accountKeys: [wallet, ORB_PROGRAM_ID],
        logLines: [
          depositedLogLine({ roundId: ROUND_ID, player: wallet, amountLamports: 2n * SOL }),
        ],
      }),
    );

    const first = await claim(sig, wallet);
    expect(first.payload.awarded).to.equal(2);

    const replay = await claim(sig, wallet);
    expect(replay.status).to.equal(200);
    expect(replay.payload.awarded).to.equal(0);

    const events = await db.q("SELECT count(*) AS n FROM raffle_events WHERE signature = $1", [sig]);
    expect(Number(events[0].n)).to.equal(1);
    const entries = await db.q("SELECT count(*) AS n FROM raffle_entries WHERE epoch_id = $1", [epoch]);
    expect(Number(entries[0].n)).to.equal(2);
  });

  it("a transaction owned by another wallet earns the caller nothing", async () => {
    await openEpoch();
    await cacheRound("settled");
    const beneficiary = testWallet();
    const caller = testWallet();
    const sig = testSignature();
    txQueue.set(
      sig,
      syntheticTx({
        signature: sig,
        signers: [beneficiary],
        accountKeys: [beneficiary, ORB_PROGRAM_ID],
        logLines: [
          depositedLogLine({ roundId: ROUND_ID, player: beneficiary, amountLamports: 2n * SOL }),
        ],
      }),
    );
    const res = await claim(sig, caller);
    expect(res.status).to.equal(200);
    expect(res.payload.awarded).to.equal(0);
    expect(res.payload.reason).to.equal("no_qualifying_event");
    const entries = await db.q("SELECT count(*) AS n FROM raffle_entries");
    expect(Number(entries[0].n)).to.equal(0);
  });
});
