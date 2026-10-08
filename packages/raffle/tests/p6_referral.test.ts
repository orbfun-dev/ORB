/**
 * P6 GATE — referrals (directive §7 P6, §6.3).
 *
 *  - self-referral rejected;
 *  - second attribution attempt rejected (first touch wins, immutable);
 *  - one-hop funding rejected (the referrer's/ referee's first funder is
 *    the other party — the lazy sybil);
 *  - the bonus is capped per referrer per epoch (25), enforced inside
 *    the same locked transaction as the referee's award;
 *  - the bonus fires only on the referee's FIRST accepted event and
 *    only when it clears REFERRAL_MIN_LAMPORTS.
 */

import { expect } from "chai";
import { before, beforeEach, describe, it } from "mocha";
import { resetDb, testDb, testSignature, testWallet, TestDb } from "./helpers/db";
import { testConfig } from "./helpers/raffle";
import { FakeFeeChain, playorbDeployTx, runIndexer } from "./helpers/indexer";
import { referralEndpoint, type ReferralDeps } from "../src/referral";
import { consent, signerWallet } from "./helpers/referral";

let db: TestDb;
let handleReferral: ReturnType<typeof referralEndpoint>;

/** Referral deps whose first-funder graph is an injectable Map. */
function referralDepsWith(graph: Map<string, string>): ReferralDeps {
  return {
    config: testConfig(),
    store: {
      bindReferral: async (wallet, ref) => {
        const res = await db.pool.query("SELECT raffle_bind_referral($1,$2) AS r", [wallet, ref]);
        return Number(res.rows[0].r) === 1 ? "bound" : "already_bound";
      },
    },
    firstFunder: async (of) => graph.get(of) ?? null,
  };
}

/**
 * An ORE deploy through playorb, indexed. ORE entries come only from
 * the fee-wallet indexer now (P4), so that is the vehicle for the
 * referee's qualifying event. Returns the entries awarded to the referee.
 */
let chain: FakeFeeChain;
async function oreDeploy(authority: string, amountPerSquare: bigint): Promise<number> {
  const sig = testSignature();
  chain.add(sig, playorbDeployTx(sig, { authority, amountPerSquare, totalSquares: 25n }));
  return (await runIndexer(db.pool, chain)).awarded;
}

before(async () => {
  db = await testDb();
});
beforeEach(async () => {
  await resetDb(db);
  chain = new FakeFeeChain();
  handleReferral = referralEndpoint(referralDepsWith(new Map()));
});

async function openEpoch(): Promise<number> {
  const rows = await db.q(
    `INSERT INTO raffle_epochs (ends_at, cap) VALUES (now() + interval '7 days', 1000) RETURNING id`,
  );
  return Number(rows[0].id);
}

function call(handler: any, body: any) {
  return handler({ method: "POST", headers: {}, body });
}

describe("P6 — self-referral is rejected", () => {
  it("400 and no binding row", async () => {
    const w = signerWallet();
    const res = await call(handleReferral, consent(w, w));
    expect(res.status).to.equal(400);
    expect(res.payload.error).to.equal("self_referral");

    const rows = await db.q("SELECT referred_by FROM raffle_wallets WHERE pubkey = $1", [w]);
    expect(rows.every((r) => r.referred_by === null)).to.be.true;
  });
});

describe("P6 — first touch wins, immutable", () => {
  it("binds once; a second attribution attempt is rejected", async () => {
    const referee = signerWallet();
    const first = testWallet();
    const second = testWallet();

    const r1 = await call(handleReferral, consent(referee, first));
    expect(r1.status).to.equal(200);
    expect(r1.payload.status).to.equal("bound");

    const r2 = await call(handleReferral, consent(referee, second));
    expect(r2.status).to.equal(200);
    expect(r2.payload.status).to.equal("already_bound");

    const rows = await db.q("SELECT referred_by FROM raffle_wallets WHERE pubkey = $1", [referee]);
    expect(rows[0].referred_by).to.equal(first);
  });
});

describe("P6 — one-hop funding is rejected", () => {
  it("the referee's first funder being the referrer is a 422", async () => {
    const referee = signerWallet();
    const referrer = testWallet();
    handleReferral = referralEndpoint(
      referralDepsWith(new Map([[referee, referrer]])),
    );

    const res = await call(handleReferral, consent(referee, referrer));
    expect(res.status).to.equal(422);
    expect(res.payload.error).to.equal("funding_link");
    const rows = await db.q("SELECT referred_by FROM raffle_wallets WHERE pubkey = $1", [referee]);
    expect(rows.every((r) => r.referred_by === null)).to.be.true;
  });

  it("the reverse direction (referrer first funded by referee) is also a 422", async () => {
    const referee = signerWallet();
    const referrer = testWallet();
    handleReferral = referralEndpoint(
      referralDepsWith(new Map([[referrer, referee]])),
    );
    const res = await call(handleReferral, consent(referee, referrer));
    expect(res.status).to.equal(422);
  });
});

describe("P6 — the bonus fires on the referee's first qualifying event", () => {
  it("1 SOL ORE deploy → referrer gets exactly 1 referral entry", async () => {
    const epoch = await openEpoch();
    const referee = signerWallet();
    const referrer = testWallet();

    const bound = await call(handleReferral, consent(referee, referrer));
    expect(bound.payload.status).to.equal("bound");

    // 1 SOL deploy (the referee's own entry) + the referrer's bonus.
    const awarded = await oreDeploy(referee, 40_000_000n);
    expect(awarded).to.equal(1); // the referee's own entry

    const bonus = await db.q(
      `SELECT wallet, referee, source, origin_event FROM raffle_entries
       WHERE epoch_id = $1 AND source = 'referral'`,
      [epoch],
    );
    expect(bonus).to.have.lengthOf(1);
    expect(bonus[0].wallet).to.equal(referrer);
    expect(bonus[0].referee).to.equal(referee);
    expect(bonus[0].origin_event).to.not.be.null;
  });

  it("a sub-minimum first event never earns the bonus (strict first-event)", async () => {
    await openEpoch();
    const referee = signerWallet();
    const referrer = testWallet();
    await call(handleReferral, consent(referee, referrer));

    // First event: 0.5 SOL (below the 1 SOL referral minimum).
    await oreDeploy(referee, 20_000_000n);

    // Later event: 1 SOL — not the FIRST event, so still no bonus.
    await oreDeploy(referee, 40_000_000n);

    const bonus = await db.q("SELECT count(*) AS n FROM raffle_entries WHERE source = 'referral'");
    expect(Number(bonus[0].n)).to.equal(0);
  });
});

describe("P6 — REFERRAL_CAP_PER_EPOCH binds", () => {
  it("a referrer at 25 referral entries earns nothing from the 26th referee", async () => {
    const epoch = await openEpoch();
    const referrer = testWallet();

    // Pre-insert 25 referral entries for this referrer this epoch.
    await db.q("INSERT INTO raffle_wallets (pubkey) VALUES ($1)", [referrer]);
    for (let i = 1; i <= 25; i++) {
      await db.q(
        `INSERT INTO raffle_entries (epoch_id, entry_no, wallet, source, status)
         VALUES ($1, $2, $3, 'referral', 'confirmed')`,
        [epoch, i, referrer],
      );
    }
    await db.q("UPDATE raffle_epochs SET entries_issued = 25 WHERE id = $1", [epoch]);

    // The 26th referee claims their first 1 SOL event.
    const referee = signerWallet();
    await call(handleReferral, consent(referee, referrer));
    expect(await oreDeploy(referee, 40_000_000n)).to.equal(1); // referee still earns their own

    const bonus = await db.q(
      "SELECT count(*) AS n FROM raffle_entries WHERE epoch_id = $1 AND wallet = $2 AND source = 'referral'",
      [epoch, referrer],
    );
    expect(Number(bonus[0].n)).to.equal(25); // unchanged
  });
});
