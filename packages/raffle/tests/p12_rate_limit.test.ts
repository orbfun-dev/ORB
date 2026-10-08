/**
 * AUDIT R-9 — unauthenticated requests cannot buy unlimited paid RPC.
 *
 *  - the shared counter (sql/010) is per bucket, per fixed window;
 *  - over the limit, /purchase answers 429 BEFORE fetching anything;
 *  - a limiter that itself fails never blocks a real credit;
 *  - a repeat report of a credited purchase is answered from the ledger
 *    without another RPC fetch — and only for the wallet it credited.
 */

import bs58 from "bs58";
import { expect } from "chai";
import { before, beforeEach, describe, it } from "mocha";
import { resetDb, testDb, testSignature, testWallet, TestDb } from "./helpers/db";
import { pgClaimStore, testConfig } from "./helpers/raffle";
import { syntheticTx } from "./helpers/tx";
import { purchaseEndpoint, SYSTEM_PROGRAM_ID } from "../src/endpoints/purchase";
import { clientIp, enforceRateLimit, HttpError, type RateLimiter } from "../src/http";

let db: TestDb;
const TREASURY = "Treasury111111111111111111111111111111111111";

function pgLimiter(windowSecs = 60): RateLimiter {
  return {
    async allow(buckets) {
      const res = await db.pool.query("SELECT raffle_rate_allow($1, $2, $3) AS ok", [
        buckets.map((b) => b.key),
        buckets.map((b) => b.max),
        windowSecs,
      ]);
      return res.rows[0].ok === true;
    },
  };
}

function purchaseTx(signature: string, wallet: string, lamports: number): any {
  const accounts = [wallet, TREASURY, SYSTEM_PROGRAM_ID];
  const tx = syntheticTx({ signature, signers: [wallet], accountKeys: accounts });
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(BigInt(lamports), 4);
  tx.transaction.message.instructions = [{ programIdIndex: 2, accounts: [0, 1], data: bs58.encode(data) }];
  return tx;
}

async function rejects(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    expect(err).to.be.instanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected a rejection");
}

before(async () => {
  db = await testDb();
});
beforeEach(async () => {
  await resetDb(db);
});

describe("AUDIT R-9 — the shared counter", () => {
  it("allows up to the limit per bucket, then refuses; buckets are independent", async () => {
    const limiter = pgLimiter();
    for (let i = 0; i < 3; i += 1) {
      expect(await limiter.allow([{ key: "ip:1.2.3.4", max: 3 }])).to.equal(true);
    }
    expect(await limiter.allow([{ key: "ip:1.2.3.4", max: 3 }])).to.equal(false);
    expect(await limiter.allow([{ key: "ip:5.6.7.8", max: 3 }])).to.equal(true);
    // Any bucket over its limit refuses the request.
    expect(await limiter.allow([{ key: "ip:5.6.7.8", max: 3 }, { key: "ip:1.2.3.4", max: 3 }])).to.equal(false);
  });

  it("is locked to service_role like every raffle_ object", async () => {
    const [row] = await db.q(
      "SELECT has_function_privilege('public', 'raffle_rate_allow(text[], int[], int)', 'EXECUTE') AS open",
    );
    expect(row.open).to.equal(false);
  });
});

describe("AUDIT R-9 — the endpoints", () => {
  let fetches = 0;
  const txs = new Map<string, any>();
  function endpoint(limiter?: RateLimiter) {
    return purchaseEndpoint({
      config: testConfig(),
      store: pgClaimStore(db.pool),
      fetchTransaction: async (sig) => {
        fetches += 1;
        return txs.get(sig) ?? null;
      },
      rateLimit: limiter,
    });
  }
  beforeEach(async () => {
    fetches = 0;
    txs.clear();
    await db.q(`INSERT INTO raffle_epochs (ends_at, cap) VALUES (now() + interval '7 days', 1000)`);
  });

  it("over the per-wallet limit: 429 and no RPC fetch", async () => {
    const handle = endpoint(pgLimiter());
    const wallet = testWallet();
    for (let i = 0; i < 30; i += 1) {
      await handle({ method: "POST", headers: { "x-real-ip": "9.9.9.9" }, body: { signature: testSignature(), wallet } });
    }
    expect(fetches).to.equal(30);
    const err = await rejects(
      handle({ method: "POST", headers: { "x-real-ip": "9.9.9.9" }, body: { signature: testSignature(), wallet } }),
    );
    expect(err.status).to.equal(429);
    expect(fetches).to.equal(30);
  });

  it("a failing limiter never blocks a real purchase", async () => {
    const broken: RateLimiter = { allow: async () => { throw new Error("db down"); } };
    const handle = endpoint(broken);
    const wallet = testWallet();
    const sig = testSignature();
    txs.set(sig, purchaseTx(sig, wallet, 50_000_000));
    const res = await handle({ method: "POST", headers: {}, body: { signature: sig, wallet } });
    expect(res.status).to.equal(200);
    expect((res.payload as any).awarded).to.equal(1);
  });

  it("a repeat report is answered from the ledger, for the credited wallet only", async () => {
    const handle = endpoint();
    const wallet = testWallet();
    const sig = testSignature();
    txs.set(sig, purchaseTx(sig, wallet, 100_000_000));
    const first = await handle({ method: "POST", headers: {}, body: { signature: sig, wallet } });
    expect((first.payload as any).awarded).to.equal(2);
    expect(fetches).to.equal(1);

    const again = await handle({ method: "POST", headers: {}, body: { signature: sig, wallet } });
    expect(again.payload).to.deep.include({ awarded: 2, replay: true });
    expect(fetches).to.equal(1); // no second RPC fetch

    // Another wallet replaying the signature is not handed the credit.
    const other = await handle({ method: "POST", headers: {}, body: { signature: sig, wallet: testWallet() } });
    expect(fetches).to.equal(2);
    expect(other.status).to.equal(403); // not a signer
  });
});

describe("AUDIT R-9 — client IP", () => {
  it("prefers x-real-ip, then the first x-forwarded-for hop, else one shared bucket", () => {
    expect(clientIp({ headers: { "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" } } as any)).to.equal("1.1.1.1");
    expect(clientIp({ headers: { "x-forwarded-for": "3.3.3.3, 10.0.0.1" } } as any)).to.equal("3.3.3.3");
    expect(clientIp({ headers: {} } as any)).to.equal("unknown");
  });

  it("enforceRateLimit is a no-op without a limiter", async () => {
    await enforceRateLimit(undefined, [{ key: "ip:x", max: 0 }]);
  });
});
