/**
 * P9 GATE — the public read surface (directive §7 P9).
 *
 * §6 of the directive specifies no read endpoints, so these are the
 * gates for the ones P9 needs:
 *
 *  - the progress bar reads an epoch that always exists to read: the
 *    open one, or the most recent when the raffle is mid-draw;
 *  - the advertised purchase ceiling is the one raffle_award actually
 *    enforces — proven by moving the GUC and watching both follow;
 *  - the leaderboard orders by entries and breaks ties deterministically,
 *    so polling does not reshuffle equal rows;
 *  - voided entries count nowhere;
 *  - a wallet query is optional and a malformed one is ignored, never
 *    fatal — a bad query string must not blank the page;
 *  - the endpoint is GET-only and still refuses `amount` / `entries`.
 */

import { expect } from "chai";
import { before, beforeEach, describe, it } from "mocha";
import { resetDb, testDb, testSignature, testWallet, TestDb } from "./helpers/db";
import { testConfig, type ServedResponse } from "./helpers/raffle";
import { statusEndpoint, type StatusStore } from "../src/endpoints/status";

let db: TestDb;
let handleStatus: ReturnType<typeof statusEndpoint>;

/** The real SQL, reached through pg — same functions production calls. */
function pgStatusStore(): StatusStore {
  return {
    async epochStatus() {
      const res = await db.pool.query("SELECT * FROM raffle_epoch_status()");
      const row = res.rows[0];
      if (row === undefined) return null;
      return {
        epochId: Number(row.epoch_id),
        status: String(row.status),
        cap: Number(row.cap),
        entriesIssued: Number(row.entries_issued),
        purchasedIssued: Number(row.purchased_issued),
        purchaseCap: Number(row.purchase_cap),
        startsAt: String(row.starts_at),
        endsAt: String(row.ends_at),
      };
    },
    async leaderboard(epochId, limit) {
      const res = await db.pool.query("SELECT * FROM raffle_leaderboard($1, $2)", [epochId, limit]);
      return res.rows.map((r) => ({ wallet: r.wallet, entries: Number(r.entries) }));
    },
    async walletSummary(epochId, wallet) {
      const res = await db.pool.query("SELECT * FROM raffle_wallet_summary($1, $2)", [
        epochId,
        wallet,
      ]);
      return res.rows.map((r) => ({ source: r.source, entries: Number(r.entries) }));
    },
    async walletProgress(epochId, wallet) {
      const res = await db.pool.query(
        "SELECT source, cumulative_lamports FROM raffle_progress WHERE epoch_id = $1 AND wallet = $2",
        [epochId, wallet],
      );
      return res.rows.map((r) => ({ source: r.source, lamports: Number(r.cumulative_lamports) }));
    },
  };
}

function get(query: Record<string, string> = {}): Promise<ServedResponse> {
  return handleStatus({ method: "GET", headers: {}, query });
}

async function openEpoch(cap = 1000): Promise<number> {
  const rows = await db.q(
    `INSERT INTO raffle_epochs (ends_at, cap) VALUES (now() + interval '7 days', $1) RETURNING id`,
    [cap],
  );
  return Number(rows[0].id);
}

/** Issue `n` entries to `wallet` the way raffle_award would. */
async function giveEntries(
  epoch: number,
  wallet: string,
  n: number,
  source = "orb_game",
  status = "confirmed",
): Promise<void> {
  await db.q("INSERT INTO raffle_wallets (pubkey) VALUES ($1) ON CONFLICT DO NOTHING", [wallet]);
  const next = await db.q(
    "SELECT COALESCE(max(entry_no), 0) AS n FROM raffle_entries WHERE epoch_id = $1",
    [epoch],
  );
  let entryNo = Number(next[0].n);
  for (let i = 0; i < n; i++) {
    entryNo += 1;
    await db.q(
      `INSERT INTO raffle_entries (epoch_id, entry_no, wallet, source, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [epoch, entryNo, wallet, source, status],
    );
  }
  // Only non-voided entries count toward the epoch's issued total.
  if (status !== "voided") {
    await db.q("UPDATE raffle_epochs SET entries_issued = entries_issued + $2 WHERE id = $1", [
      epoch,
      n,
    ]);
  }
}

before(async () => {
  db = await testDb();
});
beforeEach(async () => {
  await resetDb(db);
  handleStatus = statusEndpoint({ config: testConfig(), store: pgStatusStore() });
});

describe("P9 — the epoch progress bar has something to read", () => {
  it("reports the open epoch's cap and issued count", async () => {
    const epoch = await openEpoch();
    await giveEntries(epoch, testWallet(), 7);

    const res = await get();
    expect(res.status).to.equal(200);
    expect(res.payload.epoch.id).to.equal(epoch);
    expect(res.payload.epoch.status).to.equal("open");
    expect(res.payload.epoch.cap).to.equal(1000);
    expect(res.payload.epoch.entriesIssued).to.equal(7);
    expect(res.payload.epoch.endsAt).to.be.a("string");
  });

  it("falls back to the most recent epoch while the raffle is mid-draw", async () => {
    // Between a lock and the next open there is NO open epoch. The page
    // must still render — showing the locked epoch — rather than blank.
    const epoch = await openEpoch();
    await giveEntries(epoch, testWallet(), 3);
    await db.q("UPDATE raffle_epochs SET status = 'locked', locked_at = now() WHERE id = $1", [
      epoch,
    ]);

    const res = await get();
    expect(res.payload.epoch.id).to.equal(epoch);
    expect(res.payload.epoch.status).to.equal("locked");
  });

  it("prefers the open epoch over a newer locked one", async () => {
    const open = await openEpoch();
    await db.q(
      `INSERT INTO raffle_epochs (ends_at, cap, status, locked_at)
       VALUES (now() - interval '1 day', 1000, 'locked', now())`,
    );
    const res = await get();
    expect(res.payload.epoch.id).to.equal(open);
  });

  it("reports no epoch, not an error, before the promotion starts", async () => {
    const res = await get();
    expect(res.status).to.equal(200);
    expect(res.payload.epoch).to.be.null;
    expect(res.payload.leaderboard).to.deep.equal([]);
    expect(res.payload.wallet).to.be.null;
  });
});

describe("P9 — the buy card's terms come from the server", () => {
  it("publishes where to pay, the price and the per-wallet ceiling", async () => {
    await openEpoch();
    const config = testConfig();
    expect((await get()).payload.purchase).to.deep.equal({
      treasury: config.raffleTreasuryPubkey,
      priceLamports: config.entryPriceLamports,
      perWalletCap: config.purchaseCapPerWallet,
    });
  });

  it("the per-wallet ceiling it advertises is where raffle_award stops one wallet", async () => {
    // The card clamps a purchase to the advertised ceiling BEFORE the
    // user pays, because SOL sent past the ceiling buys nothing. So the
    // advertised figure must be the enforced one: SQL's default
    // (raffle.purchase_cap_wallet unset, as in production) against the
    // config value the endpoint publishes.
    const epoch = await openEpoch(1000);
    const wallet = testWallet();
    await db.q("INSERT INTO raffle_wallets (pubkey) VALUES ($1)", [wallet]);

    const advertised = (await get()).payload.purchase.perWalletCap;
    const granted = Number(
      (await db.q("SELECT raffle_award($1, $2, 'purchase', NULL, $3) AS n", [epoch, wallet, 100]))[0]
        .n,
    );
    expect(granted).to.equal(advertised);
  });
});

describe("P9 — the advertised purchase ceiling is the enforced one", () => {
  it("advertises 30% of the pool by default", async () => {
    await openEpoch(1000);
    expect((await get()).payload.epoch.purchaseCap).to.equal(300);
  });

  it("the figure it advertises is the figure raffle_award stops at", async () => {
    // Both the status read and the award resolve the ceiling from
    // `raffle.purchase_cap_bps`. Reading the same expression twice would
    // prove nothing, so this moves the knob and checks the ADVERTISED
    // number against where purchases ACTUALLY stop — on one connection,
    // because a GUC set with set_config lives on that session alone.
    const epoch = await openEpoch(1000);
    const wallet = testWallet();
    await db.q("INSERT INTO raffle_wallets (pubkey) VALUES ($1)", [wallet]);

    const client = await db.pool.connect();
    try {
      await client.query("SELECT set_config('raffle.purchase_cap_bps', '1500', false)");
      // Lift the per-wallet limb out of the way so the share cap is the
      // only thing that can bind here.
      await client.query("SELECT set_config('raffle.purchase_cap_wallet', '100000', false)");

      const advertised = Number(
        (await client.query("SELECT purchase_cap FROM raffle_epoch_status()")).rows[0]
          .purchase_cap,
      );
      expect(advertised).to.equal(150); // 15% of 1000

      // Ask for far more than the share cap allows, in one award.
      const granted = Number(
        (
          await client.query("SELECT raffle_award($1, $2, 'purchase', NULL, $3) AS n", [
            epoch,
            wallet,
            1000,
          ])
        ).rows[0].n,
      );
      expect(granted).to.equal(advertised);

      const issued = Number(
        (await client.query("SELECT purchased_issued FROM raffle_epochs WHERE id = $1", [epoch]))
          .rows[0].purchased_issued,
      );
      expect(issued).to.equal(advertised);
    } finally {
      client.release();
    }
  });
});

describe("P9 — the leaderboard", () => {
  it("orders by entries, breaking ties on the earliest entry", async () => {
    const epoch = await openEpoch();
    const big = testWallet();
    const firstTie = testWallet();
    const secondTie = testWallet();

    await giveEntries(epoch, firstTie, 2); // entry_no 1–2
    await giveEntries(epoch, big, 5); // entry_no 3–7
    await giveEntries(epoch, secondTie, 2); // entry_no 8–9

    const board = (await get()).payload.leaderboard;
    expect(board.map((r: any) => r.wallet)).to.deep.equal([big, firstTie, secondTie]);
    expect(board.map((r: any) => r.entries)).to.deep.equal([5, 2, 2]);

    // Deterministic: a second read must not reshuffle the tied pair.
    const again = (await get()).payload.leaderboard;
    expect(again.map((r: any) => r.wallet)).to.deep.equal(board.map((r: any) => r.wallet));
  });

  it("counts no voided entry, on the board or in the wallet panel", async () => {
    const epoch = await openEpoch();
    const wallet = testWallet();
    await giveEntries(epoch, wallet, 3);
    await giveEntries(epoch, wallet, 4, "orb_game", "voided");

    const res = await get({ wallet });
    expect(res.payload.leaderboard[0].entries).to.equal(3);
    expect(res.payload.wallet.total).to.equal(3);
  });

  it("is capped at 10 rows however many wallets entered", async () => {
    const epoch = await openEpoch();
    for (let i = 0; i < 14; i++) await giveEntries(epoch, testWallet(), 1);
    expect((await get()).payload.leaderboard).to.have.lengthOf(10);
  });
});

describe("P9 — the wallet panel is optional", () => {
  it("splits a wallet's entries by how they were earned", async () => {
    const epoch = await openEpoch();
    const wallet = testWallet();
    await giveEntries(epoch, wallet, 2, "orb_game");
    await giveEntries(epoch, wallet, 3, "ore_mining");
    await giveEntries(epoch, wallet, 1, "purchase");

    const res = await get({ wallet });
    expect(res.payload.wallet.pubkey).to.equal(wallet);
    expect(res.payload.wallet.total).to.equal(6);
    expect(res.payload.wallet.bySource).to.deep.equal({
      orb_game: 2,
      ore_mining: 3,
      purchase: 1,
    });
  });

  it("is null for a visitor who has not connected a wallet", async () => {
    await openEpoch();
    expect((await get()).payload.wallet).to.be.null;
  });

  it("reports zero for a wallet with no entries, rather than failing", async () => {
    await openEpoch();
    const res = await get({ wallet: testWallet() });
    expect(res.payload.wallet.total).to.equal(0);
    expect(res.payload.wallet.bySource).to.deep.equal({});
    expect(res.payload.wallet.progress).to.deep.equal([]);
  });

  it("ignores a malformed wallet instead of blanking the leaderboard", async () => {
    const epoch = await openEpoch();
    await giveEntries(epoch, testWallet(), 2);

    const res = await get({ wallet: "not-a-pubkey" });
    expect(res.status).to.equal(200);
    expect(res.payload.wallet).to.be.null;
    expect(res.payload.leaderboard).to.have.lengthOf(1);
  });
});

describe("P9 — progress toward the next entry", () => {
  /** Accrue one earned event through the shipping award SQL (R5). */
  async function spend(epoch: number, wallet: string, lamports: number, source = "ore_mining") {
    await db.q(
      `SELECT raffle_submit_earned_event($1, 0::SMALLINT, 1, now(), $2, $3, $4, $5, $6)`,
      [testSignature(), source, wallet, epoch, lamports, testConfig().lamportsPerEntry],
    );
  }

  it("shows a 0.01 SOL deploy as 0.01 of 1 SOL, 0.99 SOL to go, with no entries yet", async () => {
    const epoch = await openEpoch();
    const wallet = testWallet();
    await spend(epoch, wallet, 10_000_000);

    const res = await get({ wallet });
    expect(res.payload.wallet.total).to.equal(0);
    expect(res.payload.wallet.lamportsPerEntry).to.equal(1_000_000_000);
    expect(res.payload.wallet.progress).to.deep.equal([
      { source: "ore_mining", lamports: 10_000_000, intoNext: 10_000_000, toNext: 990_000_000 },
    ]);
  });

  it("carries the remainder past a whole entry", async () => {
    const epoch = await openEpoch();
    const wallet = testWallet();
    await spend(epoch, wallet, 600_000_000);
    await spend(epoch, wallet, 650_000_000); // 1.25 SOL → 1 entry + 0.25 toward the next

    const res = await get({ wallet });
    expect(res.payload.wallet.total).to.equal(1);
    expect(res.payload.wallet.progress).to.deep.equal([
      { source: "ore_mining", lamports: 1_250_000_000, intoNext: 250_000_000, toNext: 750_000_000 },
    ]);
  });

  it("keeps each source's running total separate", async () => {
    const epoch = await openEpoch();
    const wallet = testWallet();
    await spend(epoch, wallet, 400_000_000, "ore_mining");
    await spend(epoch, wallet, 300_000_000, "orb_game");

    const res = await get({ wallet });
    expect(res.payload.wallet.progress.map((p: any) => [p.source, p.toNext])).to.deep.equal([
      ["orb_game", 700_000_000],
      ["ore_mining", 600_000_000],
    ]);
  });

  it("only counts the current epoch", async () => {
    const old = await openEpoch();
    const wallet = testWallet();
    await spend(old, wallet, 500_000_000);
    await db.q("UPDATE raffle_epochs SET status = 'drawn' WHERE id = $1", [old]);
    await openEpoch();

    const res = await get({ wallet });
    expect(res.payload.wallet.progress).to.deep.equal([]);
  });
});

describe("P9 — the read endpoint keeps the write posture", () => {
  it("is GET-only", async () => {
    const res = await handleStatus({ method: "POST", headers: {}, query: {} }).catch(
      (e: any) => e,
    );
    expect(res).to.be.instanceOf(Error);
    expect((res as any).status).to.equal(405);
  });

  it("still refuses a body carrying amount or entries", async () => {
    const err = await handleStatus({
      method: "GET",
      headers: {},
      query: {},
      body: { entries: 999 },
    }).catch((e: any) => e);
    expect(err).to.be.instanceOf(Error);
    expect((err as any).status).to.equal(400);
    expect((err as any).code).to.equal("forbidden_body_field");
  });
});
