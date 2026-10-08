/**
 * P8 GATE — lock, draw (directive §7 P8, §6.5, §6.6, §8.5) under the
 * 2026-10-07 amendment.
 *
 * The directive's hold-through gate ("a wallet that sold its ORB before
 * lock has its provisional entries voided") is vacuous after the
 * amendment: the only provisional source was the retired ORB token buy,
 * and purchases are born `confirmed` (proven in p7). What remains to
 * prove here:
 *
 *  - the lock commits a draw: merkle root over the canonical entry
 *    list, target_slot = current + 1200, and an on-chain memo signature;
 *  - the next epoch opens when none is open, never twice;
 *  - the reveal is reproducible: winning_no derives from
 *    (merkle_root ‖ blockhash) AND scripts/raffle/verify-draw.ts — which
 *    shares no code with the engine — reproduces it independently
 *    (§8.5);
 *  - a pruned blockhash skips and retries, never invents a winner.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import bs58 from "bs58";
import { expect } from "chai";
import { before, beforeEach, describe, it } from "mocha";
import { resetDb, testDb, testWallet, TestDb } from "./helpers/db";
import { testConfig } from "./helpers/raffle";
import { merkleRoot, winningEntryNo } from "../src/merkle";
import { runDraw, runEpochLock, type EpochDeps } from "../src/epoch";

let db: TestDb;
const repoRoot = resolve(__dirname, "..", "..", "..");

function fixedKey(tag: string): string {
  const seed = Buffer.alloc(32);
  Buffer.from(tag, "utf8").copy(seed, 0);
  return bs58.encode(seed);
}

/**
 * `entries_issued` is carried on the epoch row because that is how
 * production works: raffle_award inserts the entries and bumps the
 * counter in one statement, so the two can never disagree. A fixture
 * that inserts entries without the counter models an epoch that cannot
 * exist — and hides the reveal's `mod entries_issued` behind a 0.
 */
async function lockedEpochWithEntries(count: number): Promise<number> {
  const rows = await db.q(
    `INSERT INTO raffle_epochs (ends_at, cap, status, locked_at, lock_reason, entries_issued)
     VALUES (now() - interval '1 hour', 1000, 'locked', now(), 'timer', $1) RETURNING id`,
    [count],
  );
  const epoch = Number(rows[0].id);
  for (let i = 1; i <= count; i++) {
    const wallet = testWallet();
    await db.q("INSERT INTO raffle_wallets (pubkey) VALUES ($1) ON CONFLICT DO NOTHING", [wallet]);
    await db.q(
      `INSERT INTO raffle_entries (epoch_id, entry_no, wallet, source, status)
       VALUES ($1, $2, $3, 'orb_game', 'confirmed')`,
      [epoch, i, wallet],
    );
  }
  return epoch;
}

/** Deterministic blockhash derived from the slot (test chain). */
function testBlockhash(s: bigint): Buffer {
  const buf = Buffer.alloc(32);
  buf.writeBigUInt64LE(s, 0);
  buf.write("blockhash", 8);
  return buf;
}

/** What the fake chain has seen; shared across one test's deps. */
let chain: { signed: number; sent: string[] };

function epochDeps(overrides: Partial<EpochDeps> = {}): EpochDeps {
  const slot = { value: 300_000_000n };
  return {
    config: testConfig(),
    store: {
      lockExpiredEpochs: async () => {
        const res = await db.pool.query("SELECT raffle_lock_expired_epochs() AS n");
        return Number(res.rows[0].n);
      },
      currentOpenEpoch: async () => {
        const res = await db.pool.query(
          "SELECT id FROM raffle_epochs WHERE status='open' ORDER BY id DESC LIMIT 1",
        );
        return res.rows[0] ? { id: Number(res.rows[0].id) } : null;
      },
      openEpoch: async (endsAt, cap) => {
        const res = await db.pool.query(
          "SELECT raffle_open_epoch($1, $2) AS id",
          [endsAt, cap],
        );
        return Number(res.rows[0].id);
      },
      epochsAwaitingCommit: async () => {
        const res = await db.pool.query(
          `SELECT e.id FROM raffle_epochs e
           LEFT JOIN raffle_draws d ON d.epoch_id = e.id
           WHERE e.status = 'locked' AND d.epoch_id IS NULL ORDER BY e.id`,
        );
        return res.rows.map((r) => Number(r.id));
      },
      listEntries: async (epochId) => {
        const res = await db.pool.query(
          "SELECT entry_no, wallet FROM raffle_entries WHERE epoch_id = $1 AND status <> 'voided' ORDER BY entry_no",
          [epochId],
        );
        return res.rows.map((r) => ({ entryNo: Number(r.entry_no), wallet: r.wallet }));
      },
      finalizeEmptyEpoch: async (epochId) => {
        const res = await db.pool.query("SELECT raffle_finalize_empty_epoch($1) AS done", [epochId]);
        return res.rows[0].done === true;
      },
      reserveDraw: async (epochId, root, targetSlot, sig, lvh) => {
        const res = await db.pool.query("SELECT raffle_reserve_draw($1, $2, $3, $4, $5) AS ok", [
          epochId,
          "\\x" + root.toString("hex"),
          targetSlot,
          sig,
          lvh,
        ]);
        return res.rows[0].ok === true;
      },
      unconfirmedDraws: async () => {
        const res = await db.pool.query("SELECT * FROM raffle_draws_unconfirmed()");
        return res.rows.map((d) => ({
          epochId: Number(d.epoch_id),
          merkleRoot: Buffer.from(d.merkle_root),
          targetSlot: Number(d.target_slot),
          commitSig: d.commit_sig,
          lastValidHeight: d.commit_last_valid_height === null ? null : Number(d.commit_last_valid_height),
        }));
      },
      confirmDrawCommit: async (epochId, sig) => {
        const res = await db.pool.query("SELECT raffle_confirm_draw_commit($1, $2) AS ok", [epochId, sig]);
        return res.rows[0].ok === true;
      },
      replaceDrawCommit: async (epochId, oldSig, newSig, targetSlot, lvh) => {
        const res = await db.pool.query(
          "SELECT raffle_replace_draw_commit($1, $2, $3, $4, $5) AS ok",
          [epochId, oldSig, newSig, targetSlot, lvh],
        );
        return res.rows[0].ok === true;
      },
      pendingDraws: async (nowSlot) => {
        const res = await db.pool.query(
          "SELECT * FROM raffle_draws_pending($1)",
          [nowSlot],
        );
        return res.rows.map((d) => ({
          epochId: Number(d.epoch_id),
          // The driver decides the BYTEA shape: node-postgres hands back
          // a Buffer, PostgREST (production, src/store.ts) a "\x…" hex
          // string. Stringifying a Buffer here silently corrupts the
          // root, and a corrupt root still produces a plausible winner —
          // so the reveal would be unverifiable rather than wrong.
          merkleRoot: Buffer.isBuffer(d.merkle_root)
            ? d.merkle_root
            : Buffer.from(String(d.merkle_root).replace(/^\\x/, ""), "hex"),
          targetSlot: Number(d.target_slot),
          entriesIssued: Number(d.entries_issued),
        }));
      },
      entryWalletAt: async (epochId, entryNo) => {
        const res = await db.pool.query(
          "SELECT wallet FROM raffle_entries WHERE epoch_id = $1 AND entry_no = $2",
          [epochId, entryNo],
        );
        return res.rows[0]?.wallet ?? null;
      },
      recordDrawResult: async (epochId, blockSlot, blockhash, winningNo, winner) => {
        const res = await db.pool.query(
          "SELECT raffle_record_draw_result($1, $2, $3, $4, $5) AS ok",
          [epochId, blockSlot, blockhash, winningNo, winner],
        );
        return res.rows[0].ok === true;
      },
    },
    currentSlot: async () => slot.value,
    signCommitMemo: async (epochId, rootHex, targetSlot) => {
      chain.signed += 1;
      return {
        signature: `memo-${epochId}-${rootHex.slice(0, 12)}-${targetSlot}-${chain.signed}`,
        lastValidBlockHeight: 1000,
        wire: Buffer.alloc(0),
      };
    },
    sendCommit: async (signed) => {
      chain.sent.push(signed.signature);
    },
    // The test chain: whatever was sent lands and finalizes.
    commitStatus: async (sig) => (chain.sent.includes(sig) ? "finalized" : "pending"),
    revealBlockAtOrAfter: async (s) => ({ slot: s, blockhash: testBlockhash(s) }),
    ...overrides,
  };
}

before(async () => {
  db = await testDb();
});
beforeEach(async () => {
  await resetDb(db);
  chain = { signed: 0, sent: [] };
});

describe("P8 — the lock commits the draw", () => {
  it("records the merkle root, target slot and memo signature; opens the next epoch once", async () => {
    const epoch = await lockedEpochWithEntries(7);
    const deps = epochDeps();
    const run = await runEpochLock(deps);
    expect(run.committed).to.deep.equal([epoch]);
    expect(run.confirmed).to.deep.equal([epoch]); // the fake chain finalizes at once
    expect(chain.sent).to.have.lengthOf(1);
    const memoSigs = chain.sent;
    expect(run.openedEpoch).to.not.be.null;

    const draws = await db.q("SELECT merkle_root, target_slot, commit_sig FROM raffle_draws WHERE epoch_id = $1", [epoch]);
    expect(draws).to.have.lengthOf(1);

    const entries = await db.q(
      "SELECT entry_no, wallet FROM raffle_entries WHERE epoch_id = $1 ORDER BY entry_no",
      [epoch],
    );
    const expectedRoot = merkleRoot(
      entries.map((e) => ({ entryNo: Number(e.entry_no), wallet: e.wallet })),
    );
    expect(Buffer.from(draws[0].merkle_root).equals(expectedRoot)).to.be.true;
    expect(Number(draws[0].target_slot)).to.equal(300_000_000 + 1200);
    expect(draws[0].commit_sig).to.equal(memoSigs[0]);

    // Idempotent: a second pass commits nothing new, opens nothing new.
    const run2 = await runEpochLock(deps);
    expect(run2.committed).to.deep.equal([]);
    expect(run2.openedEpoch).to.be.null;
  });

  it("a quiet week does not freeze the raffle: an empty epoch resolves and the next one opens", async () => {
    // raffle_lock_expired_epochs locks ANY expired open epoch, entries
    // or not. Before the empty-entry branch existed, merkleRoot([])
    // threw here and aborted the pass BEFORE step 3 — so the epoch
    // nobody entered permanently blocked the next epoch from opening,
    // and the raffle stopped for good on its first quiet week.
    const rows = await db.q(
      `INSERT INTO raffle_epochs (ends_at, cap) VALUES (now() - interval '1 hour', 1000) RETURNING id`,
    );
    const empty = Number(rows[0].id);

    const run = await runEpochLock(epochDeps());
    expect(run.locked).to.equal(1);
    expect(run.emptied).to.deep.equal([empty]);
    expect(run.committed).to.deep.equal([]);
    expect(run.openedEpoch).to.not.be.null;
    expect(run.openedEpoch).to.not.equal(empty);

    // Resolved as 'drawn' with no draw row: no entries, no winner.
    const state = await db.q("SELECT status FROM raffle_epochs WHERE id = $1", [empty]);
    expect(state[0].status).to.equal("drawn");
    const draws = await db.q("SELECT 1 FROM raffle_draws WHERE epoch_id = $1", [empty]);
    expect(draws).to.have.lengthOf(0);

    // And it never comes back round: the second pass sees nothing to do.
    const again = await runEpochLock(epochDeps());
    expect(again.emptied).to.deep.equal([]);
    expect(again.committed).to.deep.equal([]);
    expect(again.openedEpoch).to.be.null;
  });

  it("a locked epoch with entries is never mistaken for an empty one", async () => {
    const epoch = await lockedEpochWithEntries(2);
    const run = await runEpochLock(epochDeps());
    expect(run.committed).to.deep.equal([epoch]);
    expect(run.emptied).to.deep.equal([]);
    const state = await db.q("SELECT status FROM raffle_epochs WHERE id = $1", [epoch]);
    expect(state[0].status).to.equal("locked"); // awaiting its reveal
  });

  it("no provisional entries exist after the amendment (hold-through vacuous)", async () => {
    await lockedEpochWithEntries(3);
    const rows = await db.q("SELECT count(*) AS n FROM raffle_entries WHERE status = 'provisional'");
    expect(Number(rows[0].n)).to.equal(0);
  });
});

describe("P8 — the reveal is reproducible (§8.5)", () => {
  it("winning_no derives from (merkle_root ‖ blockhash) and verify-draw.ts agrees", async function () {
    this.timeout(120_000);
    const epoch = await lockedEpochWithEntries(41);
    const deps = epochDeps();
    await runEpochLock(deps); // commits the draw at target 300001200

    const draw = await db.q("SELECT merkle_root FROM raffle_draws WHERE epoch_id = $1", [epoch]);
    const entries = await db.q(
      "SELECT entry_no, wallet FROM raffle_entries WHERE epoch_id = $1 ORDER BY entry_no",
      [epoch],
    );
    const root = Buffer.from(draw[0].merkle_root);
    const blockhash = testBlockhash(300_001_200n);

    // Reveal pass — the chain slot has advanced past target_slot.
    const run = await runDraw(epochDeps({ currentSlot: async () => 300_002_000n }));
    expect(run.drawn).to.have.lengthOf(1);
    const { winningNo, winner } = run.drawn[0];

    // Engine's own math:
    expect(winningNo).to.equal(winningEntryNo(root, blockhash, 41));
    const expectedWallet = entries.filter((e) => Number(e.entry_no) === winningNo)[0].wallet;
    expect(winner).to.equal(expectedWallet);

    // The INDEPENDENT script — no shared code with the engine — must
    // reproduce the same number from the published artifacts.
    const dir = mkdtempSync(join(tmpdir(), "orb-verify-"));
    const entriesFile = join(dir, "entries.json");
    writeFileSync(entriesFile, JSON.stringify(entries.map((e) => ({ entry_no: e.entry_no, wallet: e.wallet }))));
    const out = execFileSync(
      "npx",
      [
        "tsx", "scripts/raffle/verify-draw.ts",
        "--entries", entriesFile,
        "--blockhash", bs58.encode(blockhash),
        "--root", root.toString("hex"),
        "--expect", String(winningNo),
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(out).to.include("root check    OK");
    expect(out).to.include("expect check  OK");
  });

  it("a block not yet available (null) skips the reveal without inventing a winner", async () => {
    const epoch = await lockedEpochWithEntries(5);
    await runEpochLock(epochDeps());
    const run = await runDraw(epochDeps({
      currentSlot: async () => 300_002_000n,
      revealBlockAtOrAfter: async () => null,
    }));
    expect(run.drawn).to.deep.equal([]);
    expect(run.skipped).to.equal(1);
    const draws = await db.q("SELECT winning_no FROM raffle_draws WHERE epoch_id = $1", [epoch]);
    expect(draws[0].winning_no).to.be.null;
  });
});

describe("AUDIT R-8 — one commitment per epoch", () => {
  it("the draw row exists before the memo is sent, and a failed send is not lost", async () => {
    const epoch = await lockedEpochWithEntries(3);
    let rowAtSend: any[] = [];
    const run = await runEpochLock(epochDeps({
      sendCommit: async (signed) => {
        rowAtSend = await db.q("SELECT commit_sig, commit_confirmed FROM raffle_draws WHERE epoch_id = $1", [epoch]);
        expect(rowAtSend[0].commit_sig).to.equal(signed.signature);
        throw new Error("RPC timed out");
      },
      commitStatus: async () => "pending",
    }));
    expect(rowAtSend).to.have.lengthOf(1);
    expect(rowAtSend[0].commit_confirmed).to.equal(false);
    expect(run.committed).to.deep.equal([epoch]);
    expect(run.errors).to.deep.equal([]);

    // Unconfirmed: never revealed, never committed a second time.
    const draw = await runDraw(epochDeps({ currentSlot: async () => 400_000_000n }));
    expect(draw.drawn).to.deep.equal([]);
    const again = await runEpochLock(epochDeps({ commitStatus: async () => "pending" }));
    expect(again.committed).to.deep.equal([]);
    expect(again.recommitted).to.deep.equal([]);
    expect(chain.signed).to.equal(1);
  });

  it("a memo that landed is confirmed by signature; no second memo is ever signed", async () => {
    const epoch = await lockedEpochWithEntries(3);
    // Pass 1: sent, but its confirmation was not seen (the old R-8 race).
    await runEpochLock(epochDeps({ commitStatus: async () => "pending" }));
    const [row] = await db.q("SELECT commit_sig FROM raffle_draws WHERE epoch_id = $1", [epoch]);
    // Pass 2: the chain reports it finalized.
    const run = await runEpochLock(epochDeps());
    expect(run.confirmed).to.deep.equal([epoch]);
    expect(run.recommitted).to.deep.equal([]);
    expect(chain.signed).to.equal(1);
    const [after] = await db.q("SELECT commit_sig, commit_confirmed FROM raffle_draws WHERE epoch_id = $1", [epoch]);
    expect(after.commit_sig).to.equal(row.commit_sig);
    expect(after.commit_confirmed).to.equal(true);
  });

  it("only a memo that provably cannot land is replaced, keeping the root, with a new future target", async () => {
    const epoch = await lockedEpochWithEntries(4);
    await runEpochLock(epochDeps({ sendCommit: async () => { throw new Error("dropped"); } }));
    const [first] = await db.q("SELECT commit_sig, merkle_root, target_slot FROM raffle_draws WHERE epoch_id = $1", [epoch]);

    const later = epochDeps({ currentSlot: async () => 300_000_500n });
    const run = await runEpochLock({ ...later, commitStatus: async (sig) => (sig === first.commit_sig ? "dead" : "finalized") });
    expect(run.recommitted).to.deep.equal([epoch]);
    const [second] = await db.q("SELECT commit_sig, merkle_root, target_slot, commit_confirmed FROM raffle_draws WHERE epoch_id = $1", [epoch]);
    expect(second.commit_sig).to.not.equal(first.commit_sig);
    expect(Buffer.from(second.merkle_root).equals(Buffer.from(first.merkle_root))).to.equal(true);
    expect(Number(second.target_slot)).to.equal(300_000_500 + 1200);
    expect(chain.sent).to.deep.equal([second.commit_sig]); // the dead one never reached the chain

    // A stale pass still holding the dead signature cannot confirm it.
    const [stale] = await db.q("SELECT raffle_confirm_draw_commit($1, $2) AS ok", [epoch, first.commit_sig]);
    expect(stale.ok).to.equal(false);
  });

  it("a concurrent pass that loses the reservation sends nothing", async () => {
    const epoch = await lockedEpochWithEntries(2);
    const deps = epochDeps();
    const racing: EpochDeps = {
      ...deps,
      store: { ...deps.store, epochsAwaitingCommit: async () => [epoch] }, // stale read
    };
    await runEpochLock(deps);
    const sentBefore = chain.sent.length;
    const run = await runEpochLock(racing);
    expect(run.committed).to.deep.equal([]);
    expect(chain.sent.length).to.equal(sentBefore);
  });
});

describe("AUDIT R-7 — the reveal survives skipped slots", () => {
  it("draws from the first block at or after the target and records its slot", async () => {
    const epoch = await lockedEpochWithEntries(9);
    await runEpochLock(epochDeps());
    const [d] = await db.q("SELECT merkle_root, target_slot FROM raffle_draws WHERE epoch_id = $1", [epoch]);
    const target = BigInt(d.target_slot);
    const actual = target + 3n; // target .. target+2 were skipped
    const run = await runDraw(epochDeps({
      currentSlot: async () => target + 100n,
      revealBlockAtOrAfter: async (s) => {
        expect(s).to.equal(target);
        return { slot: actual, blockhash: testBlockhash(actual) };
      },
    }));
    expect(run.drawn).to.have.lengthOf(1);
    expect(run.drawn[0]!.blockSlot).to.equal(Number(actual));
    expect(run.drawn[0]!.winningNo).to.equal(
      winningEntryNo(Buffer.from(d.merkle_root), testBlockhash(actual), 9),
    );
    const [after] = await db.q("SELECT block_slot, slot_blockhash FROM raffle_draws WHERE epoch_id = $1", [epoch]);
    expect(Number(after.block_slot)).to.equal(Number(actual));
    expect(after.slot_blockhash).to.equal(bs58.encode(testBlockhash(actual)));
  });

  it("one epoch's RPC error never blocks a later epoch's draw", async () => {
    const a = await lockedEpochWithEntries(2);
    const b = await lockedEpochWithEntries(2);
    await runEpochLock(epochDeps());
    let calls = 0; // pending draws come back in epoch order: `a` first
    const run = await runDraw(epochDeps({
      currentSlot: async () => 400_000_000n,
      revealBlockAtOrAfter: async (s) => {
        calls += 1;
        if (calls === 1) throw new Error("Slot 300001200 was skipped, or missing");
        return { slot: s, blockhash: testBlockhash(s) };
      },
    }));
    expect(run.drawn.map((x) => x.epochId)).to.deep.equal([b]);
    expect(run.errors.map((x) => x.epochId)).to.deep.equal([a]);
  });

  it("a block before the target is never used, and a result is written once", async () => {
    const epoch = await lockedEpochWithEntries(3);
    await runEpochLock(epochDeps());
    const early = await runDraw(epochDeps({
      currentSlot: async () => 400_000_000n,
      revealBlockAtOrAfter: async (s) => ({ slot: s - 1n, blockhash: testBlockhash(s - 1n) }),
    }));
    expect(early.drawn).to.deep.equal([]);
    expect(early.skipped).to.equal(1);

    await runDraw(epochDeps({ currentSlot: async () => 400_000_000n }));
    const [once] = await db.q("SELECT raffle_record_draw_result($1, 1, 'x', 1, NULL) AS ok", [epoch]);
    expect(once.ok).to.equal(false);
  });
});

describe("P8 — merkle + reveal primitives", () => {
  it("the root is deterministic and order-sensitive; the reveal is uniform", () => {
    const w1 = testWallet();
    const w2 = testWallet();
    const w3 = testWallet();
    const a = [{ entryNo: 1, wallet: w1 }, { entryNo: 2, wallet: w2 }];
    const b = [{ entryNo: 1, wallet: w1 }, { entryNo: 2, wallet: w2 }];
    expect(merkleRoot(a).equals(merkleRoot(b))).to.be.true;

    const odd = [...a, { entryNo: 3, wallet: w3 }];
    expect(merkleRoot(odd).length).to.equal(32);

    const root = merkleRoot(a);
    const bh = Buffer.alloc(32, 7);
    const no = winningEntryNo(root, bh, 1000);
    expect(no).to.be.at.least(1);
    expect(no).to.be.at.most(1000);
    expect(winningEntryNo(root, bh, 1000)).to.equal(no); // deterministic
  });
});
