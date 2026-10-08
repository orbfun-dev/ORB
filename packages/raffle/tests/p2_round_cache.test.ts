/**
 * P2 GATE — round-outcome cache (directive §7 P2, §6.2).
 *
 * Fixture test over a SYNTHETIC round sequence proving:
 *  - no round is skipped: every id from (max cached + 1) to the config's
 *    active_round_id ends up in raffle_orb_rounds, in order, including
 *    rounds whose account is missing at scan time;
 *  - a closed round (account deleted by close_round) resolves via the
 *    signature-history fallback once its sentinel goes stale (> 1 h);
 *  - before that fallback fires, claims see `open` and stay 202-pending
 *    (never a wrong award — R3);
 *  - the watermark means each run only scans what it must (1–3 RPC/min).
 *
 * The SQL side (states accepted by raffle_orb_rounds, staleness query)
 * is exercised against the real local Postgres.
 */

import { expect } from "chai";
import { before, beforeEach, describe, it } from "mocha";
import { resetDb, testDb, TestDb } from "./helpers/db";
import {
  runRoundCache,
  STALE_AFTER_MS,
  type CachedOutcome,
  type RoundCacheStore,
} from "../src/round-cache";
import type { RoundData } from "../../sdk/src/index";

// ── synthetic chain ────────────────────────────────────────────────────

function roundFixture(id: bigint, state: RoundData["state"]): RoundData {
  return {
    roundId: id,
    state,
    startTs: 1_700_000_000n,
    endTs: 1_700_000_600n,
    lockTs: state === "open" ? 0n : 1_700_000_600n,
    lockSlot: 1n,
    settleTs: state === "settled" ? 1_700_000_900n : 0n,
    totalLamports: 5_000_000_000n,
    entryCount: 5,
    entriesClosed: 0,
    firstDepositor: "11111111111111111111111111111111",
    singleDepositor: false,
    randomnessAccount: "11111111111111111111111111111111",
    randomnessCommitSlot: 0n,
    randomnessSeedSlot: 0n,
    winningTicket: 0n,
    winner: "11111111111111111111111111111111",
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
    rentPayer: "11111111111111111111111111111111",
  };
}

/** In-memory RoundCacheStore mirroring raffle_orb_rounds semantics. */
function memoryStore(now: () => Date) {
  const rows = new Map<number, { state: string; reason: number | null; decidedAt: string | null; seenAt: Date }>();
  const store: RoundCacheStore = {
    async maxCachedRoundId() {
      let max: number | null = null;
      for (const id of rows.keys()) max = max === null ? id : Math.max(max, id);
      return max;
    },
    async upsert(roundId, state, reason, decidedAt, opts) {
      const prev = rows.get(roundId);
      const seenAt =
        opts.refreshSeenAt || prev === undefined ? now() : prev.seenAt;
      rows.set(roundId, { state, reason, decidedAt, seenAt });
    },
    async staleOpen(cutoffIso, maxRoundId) {
      const cutoff = new Date(cutoffIso).getTime();
      const out: Array<{ roundId: number }> = [];
      for (const [id, row] of rows) {
        if (row.state === "open" && row.seenAt.getTime() < cutoff && id <= maxRoundId) {
          out.push({ roundId: id });
        }
      }
      return out.sort((a, b) => a.roundId - b.roundId);
    },
  };
  return { store, rows };
}

const CLOSED_ROUND = 4n; // account deleted by close_round — the R3-critical miss

function depsFor(
  mem: ReturnType<typeof memoryStore>,
  opts: { activeRoundId: bigint; now: () => Date; historyOutcome?: CachedOutcome | null },
) {
  return {
    store: mem.store,
    fetchActiveRoundId: async () => opts.activeRoundId,
    fetchRound: async (roundId: bigint) => {
      // The closed round's account is gone; everything else decodes.
      if (roundId === CLOSED_ROUND) return null;
      return roundFixture(roundId, roundId === 1n || roundId === 2n ? "settled" : roundId === 3n ? "cancelled" : "open");
    },
    fetchOutcomeFromHistory: async (roundId: bigint) => {
      if (roundId !== CLOSED_ROUND) return null;
      return opts.historyOutcome ?? null;
    },
    now: opts.now,
  };
}

describe("P2 — round-outcome cache over a synthetic sequence", () => {
  let mem: ReturnType<typeof memoryStore>;
  let t0: Date;
  let clock: () => Date;

  before(async () => {
    t0 = new Date("2026-10-07T12:00:00Z");
    let t = t0.getTime();
    clock = () => new Date((t += 1000)); // each scan sees a later "now"
    mem = memoryStore(clock);

    // Run 1: active round is 5. Round 4's account is missing (closed).
    const run1 = await runRoundCache(depsFor(mem, { activeRoundId: 5n, now: clock }));
    expect(run1).to.deep.equal({ scanned: 5, resolved: 4, unresolved: 1, historyResolved: 0 });

    // Nothing skipped: every id 1..5 has a row, in the right state.
    const states = [...mem.rows.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, row]) => [id, row.state] as const);
    expect(states).to.deep.equal([
      [1, "settled"],
      [2, "settled"],
      [3, "cancelled"],
      [4, "open"], // sentinel — the closed round, pending history resolution
      [5, "open"], // genuinely open
    ]);

    // Run 2, one minute later: watermark is 5, nothing rescanned.
    const run2 = await runRoundCache(depsFor(mem, { activeRoundId: 5n, now: clock }));
    expect(run2.scanned).to.equal(0);

    // The sentinel for round 4 is still fresh — the rare path must not fire early.
    const run3 = await runRoundCache(
      depsFor(mem, {
        activeRoundId: 5n,
        now: () => new Date(t0.getTime() + 30 * 60 * 1000), // +30 min < 1 h
        historyOutcome: { state: "cancelled", reason: 1, decidedAt: null },
      }),
    );
    expect(run3.historyResolved).to.equal(0);
    expect(mem.rows.get(4)!.state).to.equal("open");

    // Run 4, past the staleness gate: the history fallback resolves the
    // closed round as cancelled (reason 1 = sole depositor, full refund).
    const run4 = await runRoundCache(
      depsFor(mem, {
        activeRoundId: 5n,
        now: () => new Date(t0.getTime() + STALE_AFTER_MS + 60 * 1000),
        historyOutcome: { state: "cancelled", reason: 1, decidedAt: null },
      }),
    );
    expect(run4.historyResolved).to.equal(1);
    const closed = mem.rows.get(4)!;
    expect(closed.state).to.equal("cancelled");
    expect(closed.reason).to.equal(1);

    // After resolution, no further history lookups.
    const run5 = await runRoundCache(
      depsFor(mem, {
        activeRoundId: 5n,
        now: () => new Date(t0.getTime() + STALE_AFTER_MS + 120 * 1000),
        historyOutcome: { state: "cancelled", reason: 1, decidedAt: null },
      }),
    );
    expect(run5.historyResolved).to.equal(0);
  });

  it("no round is skipped and the closed round resolves via the signature fallback", () => {
    const states = [...mem.rows.entries()].sort((a, b) => a[0] - b[0]);
    expect(states.map(([id]) => id)).to.deep.equal([1, 2, 3, 4, 5]);
    expect(mem.rows.get(4)!.state).to.equal("cancelled");
  });

  it("history returning null keeps the sentinel (retried next tick)", async () => {
    let t = Date.now();
    const fresh = memoryStore(() => new Date((t += 1000)));
    // Scan 1: sentinel for the closed round 4 (seen_at = t).
    await runRoundCache(depsFor(fresh, { activeRoundId: 4n, now: () => new Date(t) }));
    expect(fresh.rows.get(4)!.state).to.equal("open");

    // Scan 2, past the staleness gate, but history finds nothing —
    // the sentinel must survive untouched for the next tick.
    const outcome = await runRoundCache(
      depsFor(fresh, {
        activeRoundId: 4n,
        now: () => new Date((t += 1000) + STALE_AFTER_MS * 2),
        historyOutcome: null,
      }),
    );
    expect(outcome.historyResolved).to.equal(0);
    expect(fresh.rows.get(4)!.state).to.equal("open");
  });
});

// ── the SQL side, against real Postgres ────────────────────────────────

describe("P2 — raffle_orb_rounds SQL accepts the cache's states", () => {
  let db: TestDb;

  before(async () => {
    db = await testDb();
  });
  beforeEach(async () => {
    await resetDb(db);
  });

  it("accepts every mapped state and rejects unknown ones", async () => {
    for (const state of ["open", "locked", "awaiting", "settled", "cancelled"]) {
      await db.q(
        "INSERT INTO raffle_orb_rounds (round_id, state) VALUES ($1, $2) ON CONFLICT (round_id) DO UPDATE SET state = $2",
        [Number(state.length) + 100, state],
      );
    }
    let rejected = false;
    try {
      await db.q("INSERT INTO raffle_orb_rounds (round_id, state) VALUES ($1, $2)", [999, "unknown"]);
    } catch {
      rejected = true;
    }
    expect(rejected).to.be.true;
  });

  it("staleness query semantics: only stale open rows qualify", async () => {
    await db.q("INSERT INTO raffle_orb_rounds (round_id, state, seen_at) VALUES ($1, 'open', now() - interval '2 hours')", [7]);
    await db.q("INSERT INTO raffle_orb_rounds (round_id, state, seen_at) VALUES ($1, 'open', now())", [8]);
    await db.q("INSERT INTO raffle_orb_rounds (round_id, state, seen_at) VALUES ($1, 'settled', now() - interval '2 hours')", [9]);
    const stale = await db.q(
      "SELECT round_id FROM raffle_orb_rounds WHERE state='open' AND seen_at < $1 AND round_id <= $2",
      [new Date(Date.now() - STALE_AFTER_MS).toISOString(), 10],
    );
    expect(stale.map((r) => Number(r.round_id))).to.deep.equal([7]);
  });
});
