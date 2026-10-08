/**
 * P7 GATE — purchases + buyback (directive §7 P7, §6.4, R7, R8) under
 * the 2026-10-07 amendment: purchases are the ONLY paid path (the ORB
 * token buy was retired). A purchase is a SystemProgram.transfer of SOL
 * to the raffle treasury in a finalized transaction; entries =
 * floor(transferred / ENTRY_PRICE_LAMPORTS), server-derived.
 *
 *  - both R7 caps bind independently: PURCHASE_CAP_PER_WALLET (25) and
 *    PURCHASE_CAP_SHARE_BPS (30% of the pool, aggregate);
 *  - a 50 SOL buy-the-epoch attempt is capped (per-wallet first, share
 *    across wallets);
 *  - every recorded buyback writes a raffle_buybacks row (R8), UNIQUE
 *    per signature.
 */

import { expect } from "chai";
import bs58 from "bs58";
import { before, beforeEach, describe, it } from "mocha";
import { resetDb, testDb, testSignature, testWallet, TestDb } from "./helpers/db";
import { pgClaimStore, testConfig, type ServedResponse } from "./helpers/raffle";
import { syntheticTx } from "./helpers/tx";
import { purchaseEndpoint, sumSystemTransfersTo, SYSTEM_PROGRAM_ID } from "../src/endpoints/purchase";

let db: TestDb;
let handlePurchase: ReturnType<typeof purchaseEndpoint>;
const txQueue = new Map<string, any>();

const PRICE = 50_000_000; // 0.05 SOL
const TREASURY = "Treasury111111111111111111111111111111111111";

/** A finalized tx carrying `count` System transfers of `each` lamports. */
function purchaseTx(signature: string, wallet: string, transfers: Array<{ to: string; lamports: number }>): any {
  const accounts = [wallet, ...transfers.map((t) => t.to), SYSTEM_PROGRAM_ID];
  const tx = syntheticTx({
    signature,
    signers: [wallet],
    accountKeys: accounts,
  });
  tx.transaction.message.instructions = transfers.map((t) => {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(2, 0); // SystemInstruction::Transfer
    data.writeBigUInt64LE(BigInt(t.lamports), 4);
    return {
      programIdIndex: accounts.indexOf(SYSTEM_PROGRAM_ID),
      accounts: [accounts.indexOf(wallet), accounts.indexOf(t.to)],
      data: bs58.encode(data),
    };
  });
  return tx;
}

function claim(signature: string, wallet: string): Promise<ServedResponse> {
  return handlePurchase({ method: "POST", headers: {}, body: { signature, wallet } });
}

before(async () => {
  db = await testDb();
});
beforeEach(async () => {
  await resetDb(db);
  txQueue.clear();
  handlePurchase = purchaseEndpoint({
    config: testConfig(),
    store: pgClaimStore(db.pool),
    fetchTransaction: async (sig) => txQueue.get(sig) ?? null,
  });
});

async function openEpoch(cap = 1000): Promise<number> {
  const rows = await db.q(
    `INSERT INTO raffle_epochs (ends_at, cap) VALUES (now() + interval '7 days', $1) RETURNING id`,
    [cap],
  );
  return Number(rows[0].id);
}

describe("P7 — the manual 0.05 SOL purchase", () => {
  it("one 0.05 SOL transfer awards exactly 1 entry", async () => {
    const epoch = await openEpoch();
    const wallet = testWallet();
    const sig = testSignature();
    txQueue.set(sig, purchaseTx(sig, wallet, [{ to: TREASURY, lamports: PRICE }]));

    const res = await claim(sig, wallet);
    expect(res.status).to.equal(200);
    expect(res.payload.awarded).to.equal(1);

    const entries = await db.q(
      "SELECT source, status, wallet FROM raffle_entries WHERE epoch_id = $1",
      [epoch],
    );
    expect(entries).to.have.lengthOf(1);
    expect(entries[0].source).to.equal("purchase");
    expect(entries[0].status).to.equal("confirmed");

    const epochs = await db.q(
      "SELECT purchased_issued, entries_issued FROM raffle_epochs WHERE id = $1",
      [epoch],
    );
    expect(Number(epochs[0].purchased_issued)).to.equal(1);
  });

  it("a 1.2 SOL transfer awards 24 entries; 0.04 SOL awards 0 (and carries)", async () => {
    const epoch = await openEpoch();
    const whale = testWallet();
    const sig = testSignature();
    txQueue.set(sig, purchaseTx(sig, whale, [{ to: TREASURY, lamports: 1_200_000_000 }]));
    const res = await claim(sig, whale);
    expect(res.payload.awarded).to.equal(24); // 24 × 0.05 SOL, under the wallet cap

    const dust = testWallet();
    const sig2 = testSignature();
    txQueue.set(sig2, purchaseTx(sig2, dust, [{ to: TREASURY, lamports: 40_000_000 }]));
    const res2 = await claim(sig2, dust);
    expect(res2.payload.awarded).to.equal(0);
    const progress = await db.q(
      "SELECT cumulative_lamports FROM raffle_progress WHERE epoch_id = $1 AND source = 'purchase' AND wallet = $2",
      [epoch, dust],
    );
    expect(progress).to.have.lengthOf(1);
    expect(BigInt(progress[0].cumulative_lamports)).to.equal(40_000_000n);
  });

  it("only transfers TO THE TREASURY count; transfers elsewhere earn nothing", async () => {
    await openEpoch();
    const wallet = testWallet();
    const stranger = testWallet();
    const sig = testSignature();
    txQueue.set(sig, purchaseTx(sig, wallet, [
      { to: stranger, lamports: PRICE },
      { to: TREASURY, lamports: PRICE },
    ]));
    const res = await claim(sig, wallet);
    expect(res.payload.awarded).to.equal(1); // only the treasury leg
  });

  it("a non-signer cannot claim another wallet's purchase (403)", async () => {
    await openEpoch();
    const buyer = testWallet();
    const impostor = testWallet();
    const sig = testSignature();
    txQueue.set(sig, purchaseTx(sig, buyer, [{ to: TREASURY, lamports: PRICE }]));
    const res = await claim(sig, impostor);
    expect(res.status).to.equal(403);
  });

  it("a replayed purchase signature issues nothing new (R6) and reports what it earned", async () => {
    // The buy card re-sends until it hears back; a lost reply means the
    // retry is the only answer the buyer sees. It must say "you got 3",
    // not a bare 0 that reads as "refused".
    const epoch = await openEpoch();
    const wallet = testWallet();
    const sig = testSignature();
    txQueue.set(sig, purchaseTx(sig, wallet, [{ to: TREASURY, lamports: 3 * PRICE }]));
    expect((await claim(sig, wallet)).payload.awarded).to.equal(3);
    const replay = await claim(sig, wallet);
    expect(replay.payload).to.deep.equal({ awarded: 3, purchased: 3, replay: true });
    const entries = await db.q("SELECT count(*) AS n FROM raffle_entries WHERE epoch_id = $1", [epoch]);
    expect(Number(entries[0].n)).to.equal(3);
  });

  it("a replay of a purchase the ceiling refused still reports 0", async () => {
    const epoch = await openEpoch();
    const wallet = testWallet();
    // Fill this wallet's 25 first.
    const full = testSignature();
    txQueue.set(full, purchaseTx(full, wallet, [{ to: TREASURY, lamports: 25 * PRICE }]));
    expect((await claim(full, wallet)).payload.awarded).to.equal(25);

    const over = testSignature();
    txQueue.set(over, purchaseTx(over, wallet, [{ to: TREASURY, lamports: PRICE }]));
    expect((await claim(over, wallet)).payload.awarded).to.equal(0);
    expect((await claim(over, wallet)).payload.awarded).to.equal(0);
    const entries = await db.q("SELECT count(*) AS n FROM raffle_entries WHERE epoch_id = $1", [epoch]);
    expect(Number(entries[0].n)).to.equal(25);
  });

  it("sumSystemTransfersTo reads both the raw and jsonParsed instruction shapes", () => {
    const wallet = testWallet();
    const other = testWallet();
    const tx = purchaseTx(testSignature(), wallet, [
      { to: TREASURY, lamports: PRICE },
      { to: other, lamports: 1_000_000 },
    ]);
    expect(sumSystemTransfersTo(tx, wallet, TREASURY)).to.equal(BigInt(PRICE));

    // jsonParsed shape of the same transfer.
    const parsed = {
      transaction: { message: { accountKeys: [wallet, other, TREASURY].map((pubkey) => ({ pubkey, signer: pubkey === wallet, writable: true })) } },
      meta: {
        fee: 5000,
        preBalances: [1, 1, 1],
        postBalances: [1, 1, 1],
        preTokenBalances: [],
        postTokenBalances: [],
        innerInstructions: [],
        loadedAddresses: undefined,
      },
    };
    parsed.transaction.message.accountKeys.push({ pubkey: SYSTEM_PROGRAM_ID, signer: false, writable: false });
    (parsed.transaction.message as any).instructions = [
      {
        programId: SYSTEM_PROGRAM_ID,
        accounts: [wallet, TREASURY],
        parsed: { type: "transfer", info: { source: wallet, destination: TREASURY, lamports: "25000000" } },
      },
    ];
    expect(sumSystemTransfersTo(parsed, wallet, TREASURY)).to.equal(25_000_000n);
  });
});

describe("P7 — R7 per-wallet cap (25)", () => {
  it("a 50 SOL buy-the-epoch attempt gets exactly 25 entries", async () => {
    const epoch = await openEpoch();
    const wallet = testWallet();
    const sig = testSignature();
    txQueue.set(sig, purchaseTx(sig, wallet, [{ to: TREASURY, lamports: 50_000_000_000 }]));

    const res = await claim(sig, wallet);
    expect(res.status).to.equal(200);
    expect(res.payload.awarded).to.equal(25);

    // A second payment cannot buy past the wallet cap either.
    const sig2 = testSignature();
    txQueue.set(sig2, purchaseTx(sig2, wallet, [{ to: TREASURY, lamports: PRICE }]));
    const res2 = await claim(sig2, wallet);
    expect(res2.payload.awarded).to.equal(0);

    const epochs = await db.q(
      "SELECT entries_issued, purchased_issued, status FROM raffle_epochs WHERE id = $1",
      [epoch],
    );
    expect(Number(epochs[0].purchased_issued)).to.equal(25);
    expect(Number(epochs[0].entries_issued)).to.equal(25);
    expect(epochs[0].status).to.equal("open"); // far from the 1000 cap
  });
});

describe("P7 — R7 aggregate share cap (30% of the pool)", () => {
  it("the 13th wallet is refused once 12×25 = 30% of 1000 is purchased", async () => {
    await openEpoch(1000);
    for (let i = 1; i <= 12; i++) {
      const wallet = testWallet();
      const sig = testSignature();
      txQueue.set(sig, purchaseTx(sig, wallet, [{ to: TREASURY, lamports: 25 * PRICE }]));
      const res = await claim(sig, wallet);
      expect(res.payload.awarded, `wallet ${i}`).to.equal(25);
    }
    expect((await db.q("SELECT purchased_issued FROM raffle_epochs"))[0].purchased_issued).to.equal(300);

    // The 13th wallet pays, receives nothing, and the pool did not move.
    const thirteenth = testWallet();
    const sig = testSignature();
    txQueue.set(sig, purchaseTx(sig, thirteenth, [{ to: TREASURY, lamports: PRICE }]));
    const res = await claim(sig, thirteenth);
    expect(res.payload.awarded).to.equal(0);
    const issued = await db.q("SELECT entries_issued, purchased_issued FROM raffle_epochs");
    expect(Number(issued[0].purchased_issued)).to.equal(300);
    expect(Number(issued[0].entries_issued)).to.equal(300);
  });
});

describe("P7 — R8 buyback recording", () => {
  it("every recorded buyback writes a raffle_buybacks row; signatures are unique", async () => {
    const epoch = await openEpoch();
    await db.q(
      `INSERT INTO raffle_buybacks (epoch_id, signature, sol_in, orb_out) VALUES ($1, $2, $3, $4)`,
      [epoch, testSignature(), 500_000_000, 1_000_000_000],
    );
    const rows = await db.q("SELECT epoch_id, sol_in, signature FROM raffle_buybacks");
    expect(rows).to.have.lengthOf(1);
    expect(BigInt(rows[0].sol_in)).to.equal(500_000_000n);

    // UNIQUE (signature): a redelivered buyback cannot double-count (R8).
    let rejected = false;
    try {
      await db.q(
        `INSERT INTO raffle_buybacks (epoch_id, signature, sol_in, orb_out) VALUES ($1, $2, $3, $4)`,
        [epoch, rows[0].signature, 1, 1],
      );
    } catch {
      rejected = true;
    }
    expect(rejected).to.be.true;
  });
});
