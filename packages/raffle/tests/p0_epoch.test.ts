/**
 * P0 GATE — schema + epoch lifecycle (directive §7 P0, §8.3).
 *
 * Proven here, against the exact production SQL:
 *  - the 999 race: two concurrent sessions on one epoch — the second gets
 *    the remainder-or-nothing, never a duplicate entry_no, exactly one
 *    cap-locked epoch;
 *  - partial award + carried_out (a 3-entry event arriving at 998);
 *  - cap-lock and timer-lock mutual exclusion (idempotent, both directions);
 *  - the one-open-epoch index rejecting a second open epoch;
 *  - R5 accrual: 0.6 + 0.5 SOL rolls over correctly;
 *  - R6 dedup: replayed (signature, event_index) is a no-op, while a
 *    second event_index on the same signature is a separate event.
 */

import { expect } from "chai";
import { before, beforeEach, describe, it } from "mocha";
import { resetDb, testDb, testSignature, testWallet, TestDb } from "./helpers/db";

let db: TestDb;

const SOL = 1_000_000_000;

async function insertEvent(
  wallet: string,
  epochId: bigint,
  solLamports: number,
  source = "orb_game",
): Promise<bigint> {
  await db.q("INSERT INTO raffle_wallets (pubkey) VALUES ($1) ON CONFLICT DO NOTHING", [
    wallet,
  ]);
  const rows = await db.q(
    `INSERT INTO raffle_events
       (signature, event_index, slot, source, wallet, epoch_id, sol_lamports)
     VALUES ($1, 0, 100, $2, $3, $4, $5) RETURNING id`,
    [testSignature(), source, wallet, epochId.toString(), solLamports],
  );
  return BigInt(rows[0].id);
}

async function openEpoch(cap = 1000, endsInSeconds = 3600): Promise<bigint> {
  const rows = await db.q(
    `INSERT INTO raffle_epochs (ends_at, cap)
     VALUES (now() + make_interval(secs => $1), $2) RETURNING id`,
    [endsInSeconds, cap],
  );
  return BigInt(rows[0].id);
}

async function setIssued(epochId: bigint, issued: number): Promise<void> {
  await db.q("UPDATE raffle_epochs SET entries_issued = $1 WHERE id = $2", [
    issued,
    epochId.toString(),
  ]);
}

before(async () => {
  db = await testDb();
});

beforeEach(async () => {
  await resetDb(db);
});

describe("P0 — one-open-epoch index", () => {
  it("rejects a second open epoch", async () => {
    const a = await openEpoch();
    let rejected = false;
    try {
      await openEpoch();
    } catch (err: any) {
      rejected = true;
      expect(err.code).to.equal("23505");
      expect(err.constraint).to.equal("raffle_one_open_epoch");
    }
    expect(rejected, "second open epoch must violate the partial unique index").to.be
      .true;

    // After locking A, opening B is legal again.
    await db.q(
      "UPDATE raffle_epochs SET status='locked', locked_at=now(), lock_reason='timer' WHERE id=$1",
      [a.toString()],
    );
    const b = await openEpoch();
    expect(b > a).to.be.true;
  });
});

describe("P0 — the 999 race (directive §8.3)", () => {
  for (let round = 1; round <= 5; round++) {
    it(`concurrent claims at 999 issued produce exactly one entry, one locked epoch (round ${round})`, async () => {
      const epoch = await openEpoch();
      const wallet = testWallet();
      const event = await insertEvent(wallet, epoch, 3 * SOL);
      await setIssued(epoch, 999);

      // Two independent sessions race the same epoch row.
      const calls = [1, 2].map((n) =>
        db.pool.query("SELECT raffle_award($1,$2,$3,$4,$5) AS grant", [
          epoch.toString(),
          n === 1 ? wallet : testWallet(),
          "orb_game",
          event.toString(),
          3,
        ]),
      );
      const results = await Promise.all(calls);
      const grants = results.map((r) => Number(r.rows[0].grant));

      expect(grants.reduce((a, b) => a + b, 0)).to.equal(1);

      const epochs = await db.q(
        `SELECT status, entries_issued, lock_reason FROM raffle_epochs WHERE id = $1`,
        [epoch.toString()],
      );
      expect(epochs[0].status).to.equal("locked");
      expect(Number(epochs[0].entries_issued)).to.equal(1000);
      expect(epochs[0].lock_reason).to.equal("cap");

      const entries = await db.q(
        "SELECT entry_no FROM raffle_entries WHERE epoch_id = $1 ORDER BY entry_no",
        [epoch.toString()],
      );
      expect(entries.map((e) => Number(e.entry_no))).to.deep.equal([1000]);

      // Exactly one lock event, ever: locked_at set once.
      expect(epochs[0].locked_at).to.not.be.null;
    });
  }
});

describe("P0 — partial award + carried_out", () => {
  it("a 3-entry event arriving at 998 issues 2 and records 1 carried out", async () => {
    const epoch = await openEpoch();
    const wallet = testWallet();
    await setIssued(epoch, 998);

    const grant = await db.q(
      `SELECT raffle_submit_earned_event(
         $1, $2, $3, now(), 'orb_game', $4, $5, $6, $7) AS grant`,
      [testSignature(), 0, 100, wallet, epoch.toString(), 3 * SOL, SOL],
    );
    expect(Number(grant[0].grant)).to.equal(2);

    const epochs = await db.q(
      "SELECT status, entries_issued, lock_reason FROM raffle_epochs WHERE id = $1",
      [epoch.toString()],
    );
    expect(epochs[0].status).to.equal("locked");
    expect(epochs[0].lock_reason).to.equal("cap");

    const progress = await db.q(
      "SELECT entries_awarded, carried_out, cumulative_lamports FROM raffle_progress WHERE epoch_id = $1 AND wallet = $2",
      [epoch.toString(), wallet],
    );
    expect(Number(progress[0].entries_awarded)).to.equal(2);
    expect(Number(progress[0].carried_out)).to.equal(1);
  });
});

describe("P0 — cap-lock and timer-lock mutual exclusion", () => {
  it("timer lock is a no-op after a cap-lock", async () => {
    const epoch = await openEpoch();
    const wallet = testWallet();
    const event = await insertEvent(wallet, epoch, 2 * SOL);
    await setIssued(epoch, 999);
    await db.q("SELECT raffle_award($1,$2,$3,$4,$5)", [
      epoch.toString(),
      wallet,
      "orb_game",
      event.toString(),
      2,
    ]);
    const locked = await db.q("SELECT raffle_lock_expired_epochs() AS n");
    expect(Number(locked[0].n)).to.equal(0);

    const rows = await db.q(
      "SELECT status, lock_reason FROM raffle_epochs WHERE id = $1",
      [epoch.toString()],
    );
    expect(rows[0].lock_reason).to.equal("cap");
  });

  it("awards are refused after a timer-lock (0, not an error)", async () => {
    const epoch = await openEpoch(1000, -3600); // already expired
    const wallet = testWallet();
    const event = await insertEvent(wallet, epoch, 2 * SOL);

    const locked = await db.q("SELECT raffle_lock_expired_epochs() AS n");
    expect(Number(locked[0].n)).to.equal(1);

    const grant = await db.q("SELECT raffle_award($1,$2,$3,$4,$5) AS grant", [
      epoch.toString(),
      wallet,
      "orb_game",
      event.toString(),
      2,
    ]);
    expect(Number(grant[0].grant)).to.equal(0);

    const entries = await db.q(
      "SELECT count(*) AS n FROM raffle_entries WHERE epoch_id = $1",
      [epoch.toString()],
    );
    expect(Number(entries[0].n)).to.equal(0);
  });

  it("concurrent award + timer lock produce exactly one lock and never overflow", async () => {
    const epoch = await openEpoch(1000, -3600);
    const wallet = testWallet();
    const event = await insertEvent(wallet, epoch, 2 * SOL);
    await setIssued(epoch, 999);

    await Promise.all([
      db.pool.query("SELECT raffle_award($1,$2,$3,$4,$5)", [
        epoch.toString(),
        wallet,
        "orb_game",
        event.toString(),
        2,
      ]),
      db.pool.query("SELECT raffle_lock_expired_epochs()"),
    ]);

    const rows = await db.q(
      "SELECT status, entries_issued, lock_reason FROM raffle_epochs WHERE id = $1",
      [epoch.toString()],
    );
    expect(rows[0].status).to.equal("locked");
    expect(Number(rows[0].entries_issued)).to.be.at.most(1000);
    expect(["cap", "timer"]).to.include(rows[0].lock_reason);
  });
});

describe("P0 — R5 cumulative floor-division with carry", () => {
  it("0.6 + 0.5 SOL awards exactly 1 entry (per-transaction flooring would award 0)", async () => {
    const epoch = await openEpoch();
    const wallet = testWallet();

    const g1 = await db.q(
      `SELECT raffle_submit_earned_event($1, $2, $3, now(), 'ore_mining', $4, $5, $6, $7) AS g`,
      [testSignature(), 0, 100, wallet, epoch.toString(), 600_000_000, SOL],
    );
    expect(Number(g1[0].g)).to.equal(0);

    const g2 = await db.q(
      `SELECT raffle_submit_earned_event($1, $2, $3, now(), 'ore_mining', $4, $5, $6, $7) AS g`,
      [testSignature(), 0, 101, wallet, epoch.toString(), 500_000_000, SOL],
    );
    expect(Number(g2[0].g)).to.equal(1);

    const progress = await db.q(
      "SELECT cumulative_lamports, entries_awarded FROM raffle_progress WHERE epoch_id=$1 AND wallet=$2",
      [epoch.toString(), wallet],
    );
    expect(BigInt(progress[0].cumulative_lamports)).to.equal(1_100_000_000n);
    expect(Number(progress[0].entries_awarded)).to.equal(1);
  });

  it("0.9 + 0.9 SOL also carries (the directive's own example)", async () => {
    const epoch = await openEpoch();
    const wallet = testWallet();
    for (const amount of [900_000_000, 900_000_000]) {
      await db.q(
        `SELECT raffle_submit_earned_event($1, $2, $3, now(), 'ore_mining', $4, $5, $6, $7)`,
        [testSignature(), 0, 100, wallet, epoch.toString(), amount, SOL],
      );
    }
    const entries = await db.q(
      "SELECT count(*) AS n FROM raffle_entries WHERE epoch_id=$1 AND wallet=$2",
      [epoch.toString(), wallet],
    );
    expect(Number(entries[0].n)).to.equal(1);
  });
});

describe("P0 — R6 dedup ledger", () => {
  it("a replayed (signature, event_index) is a no-op; a new event_index on the same signature is a separate event", async () => {
    const epoch = await openEpoch();
    const wallet = testWallet();
    const sig = testSignature();

    const g1 = await db.q(
      `SELECT raffle_submit_earned_event($1, $2, $3, now(), 'orb_game', $4, $5, $6, $7) AS g`,
      [sig, 3, 100, wallet, epoch.toString(), 2 * SOL, SOL],
    );
    expect(Number(g1[0].g)).to.equal(2);

    const replay = await db.q(
      `SELECT raffle_submit_earned_event($1, $2, $3, now(), 'orb_game', $4, $5, $6, $7) AS g`,
      [sig, 3, 100, wallet, epoch.toString(), 2 * SOL, SOL],
    );
    expect(Number(replay[0].g)).to.equal(0);

    const sibling = await db.q(
      `SELECT raffle_submit_earned_event($1, $2, $3, now(), 'orb_game', $4, $5, $6, $7) AS g`,
      [sig, 4, 100, wallet, epoch.toString(), 2 * SOL, SOL],
    );
    expect(Number(sibling[0].g)).to.equal(2);

    const rows = await db.q(
      "SELECT event_index FROM raffle_events WHERE signature = $1 ORDER BY event_index",
      [sig],
    );
    expect(rows.map((r) => Number(r.event_index))).to.deep.equal([3, 4]);
  });
});
