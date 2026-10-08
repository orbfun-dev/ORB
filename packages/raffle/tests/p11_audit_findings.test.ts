/**
 * Audit 2026-10-08 — failing tests for the raffle findings in
 * docs/AUDIT_REPORT.md (R-1 … R-5). Each test states the behaviour the
 * endpoint MUST have; today each one fails because the endpoint awards.
 */

import { expect } from "chai";
import bs58 from "bs58";
import { before, beforeEach, describe, it } from "mocha";
import { resetDb, testDb, testSignature, testWallet, TestDb } from "./helpers/db";
import { pgClaimStore, testConfig, type ServedResponse } from "./helpers/raffle";
import { depositedLogLine, oreDeployLogData, syntheticTx } from "./helpers/tx";
import { claimEndpoint, type ClaimDeps } from "../src/endpoints/claim";
import { purchaseEndpoint, SYSTEM_PROGRAM_ID } from "../src/endpoints/purchase";
import { referralEndpoint, type ReferralDeps } from "../src/referral";
import { classifyTransaction, ORB_PROGRAM_ID } from "../src/classify";
import { ORE_PROGRAM_ID } from "../src/ore-event";

let db: TestDb;
const SOL = 1_000_000_000n;
const ROUND_ID = 42n;
const txQueue = new Map<string, any>();

function fixedKey(tag: string): string {
  const seed = Buffer.alloc(32);
  Buffer.from(tag, "utf8").copy(seed, 0);
  return bs58.encode(seed);
}
const ATTACKER_PROGRAM = fixedKey("attacker-program");
const TREASURY = "Treasury111111111111111111111111111111111111";

function claimDeps(): ClaimDeps {
  return {
    config: testConfig(),
    store: pgClaimStore(db.pool),
    fetchTransaction: async (signature: string) => txQueue.get(signature) ?? null,
  };
}

async function openEpoch(startsAt = "now()"): Promise<number> {
  const rows = await db.q(
    `INSERT INTO raffle_epochs (starts_at, ends_at, cap)
     VALUES (${startsAt}, now() + interval '7 days', 1000) RETURNING id`,
  );
  return Number(rows[0].id);
}

async function cacheSettledRound(): Promise<void> {
  await db.q(
    `INSERT INTO raffle_orb_rounds (round_id, state, reason, decided_at)
     VALUES ($1, 'settled', NULL, now()) ON CONFLICT (round_id) DO UPDATE SET state = 'settled'`,
    [Number(ROUND_ID)],
  );
}

before(async () => {
  db = await testDb();
});
beforeEach(async () => {
  await resetDb(db);
  txQueue.clear();
});

describe("AUDIT R-1 — ORB events are credited only when the ORB program emitted them", () => {
  it("a Deposited log line from a transaction that never invokes the ORB program awards nothing", async () => {
    await openEpoch();
    await cacheSettledRound();
    const handleClaim = claimEndpoint(claimDeps());
    const wallet = testWallet();
    const sig = testSignature();
    // Any program can sol_log_data() bytes that look like our emit!.
    txQueue.set(
      sig,
      syntheticTx({
        signature: sig,
        signers: [wallet],
        accountKeys: [wallet, ATTACKER_PROGRAM],
        logLines: [
          `Program ${ATTACKER_PROGRAM} invoke [1]`,
          depositedLogLine({ roundId: ROUND_ID, player: wallet, amountLamports: 1000n * SOL }),
          `Program ${ATTACKER_PROGRAM} success`,
        ],
      }),
    );
    const res: ServedResponse = await handleClaim({ method: "POST", headers: {}, body: { signature: sig, wallet } });
    expect(res.status).to.equal(200);
    expect(res.payload.awarded, "forged event must not award").to.equal(0);
  });

  it("a Deposited log line emitted inside another program's frame awards nothing even if ORB is in the key list", async () => {
    await openEpoch();
    await cacheSettledRound();
    const handleClaim = claimEndpoint(claimDeps());
    const wallet = testWallet();
    const sig = testSignature();
    txQueue.set(
      sig,
      syntheticTx({
        signature: sig,
        signers: [wallet],
        accountKeys: [wallet, ORB_PROGRAM_ID, ATTACKER_PROGRAM],
        logLines: [
          `Program ${ATTACKER_PROGRAM} invoke [1]`,
          depositedLogLine({ roundId: ROUND_ID, player: wallet, amountLamports: 1000n * SOL }),
          `Program ${ATTACKER_PROGRAM} success`,
        ],
      }),
    );
    const res: ServedResponse = await handleClaim({ method: "POST", headers: {}, body: { signature: sig, wallet } });
    expect(res.payload.awarded, "event outside the ORB frame must not award").to.equal(0);
  });
});

describe("AUDIT R-2 — failed transactions (meta.err) are never credited", () => {
  it("/claim ignores a Deposited event from a transaction that failed", async () => {
    await openEpoch();
    await cacheSettledRound();
    const handleClaim = claimEndpoint(claimDeps());
    const wallet = testWallet();
    const sig = testSignature();
    const tx = syntheticTx({
      signature: sig,
      signers: [wallet],
      accountKeys: [wallet, ORB_PROGRAM_ID],
      logLines: [
        `Program ${ORB_PROGRAM_ID} invoke [1]`,
        depositedLogLine({ roundId: ROUND_ID, player: wallet, amountLamports: 5n * SOL }),
        `Program ${ORB_PROGRAM_ID} success`,
      ],
    });
    tx.meta.err = { InstructionError: [1, "InsufficientFunds"] };
    txQueue.set(sig, tx);
    const res: ServedResponse = await handleClaim({ method: "POST", headers: {}, body: { signature: sig, wallet } });
    expect(res.payload.awarded, "a rolled-back deposit must not award").to.equal(0);
  });

  it("/purchase ignores a treasury transfer inside a transaction that failed", async () => {
    await openEpoch();
    const handlePurchase = purchaseEndpoint({
      config: testConfig(),
      store: pgClaimStore(db.pool),
      fetchTransaction: async (signature: string) => txQueue.get(signature) ?? null,
    });
    const wallet = testWallet();
    const sig = testSignature();
    const accounts = [wallet, TREASURY, SYSTEM_PROGRAM_ID];
    const tx = syntheticTx({ signature: sig, signers: [wallet], accountKeys: accounts });
    const data = Buffer.alloc(12);
    data.writeUInt32LE(2, 0);
    data.writeBigUInt64LE(25n * 50_000_000n, 4); // 25 entries' worth
    tx.transaction.message.instructions = [
      { programIdIndex: 2, accounts: [0, 1], data: bs58.encode(data) },
    ];
    tx.meta.err = { InstructionError: [1, "Custom"] }; // a later ix failed: nothing moved
    txQueue.set(sig, tx);
    const res: ServedResponse = await handlePurchase({ method: "POST", headers: {}, body: { signature: sig, wallet } });
    expect(res.payload.awarded ?? 0, "a rolled-back purchase must not award").to.equal(0);
  });
});

describe("AUDIT R-3 — referral binding needs proof of wallet control", () => {
  it("rejects a bare {wallet, ref} body with no wallet signature", async () => {
    const deps: ReferralDeps = {
      config: testConfig(),
      store: {
        bindReferral: async (wallet, ref) => {
          const r = await db.pool.query("SELECT raffle_bind_referral($1,$2) AS r", [wallet, ref]);
          return Number(r.rows[0].r) === 1 ? "bound" : "already_bound";
        },
      },
      firstFunder: async () => null,
    };
    const handleReferral = referralEndpoint(deps);
    const victim = testWallet();
    const attacker = testWallet();
    const res: ServedResponse = await handleReferral({
      method: "POST",
      headers: {},
      body: { wallet: victim, ref: attacker },
    });
    expect(res.status, "an unsigned binding must be refused").to.be.oneOf([400, 401, 403]);
    const rows = await db.q("SELECT referred_by FROM raffle_wallets WHERE pubkey = $1", [victim]);
    expect(rows.length === 0 || rows[0].referred_by === null, "nothing bound").to.be.true;
  });

  it("binds with the owner's signature; refuses another signer and a stale consent", async () => {
    const { consent, signerWallet } = await import("./helpers/referral");
    const deps: ReferralDeps = {
      config: testConfig(),
      store: {
        bindReferral: async (wallet, ref) => {
          const r = await db.pool.query("SELECT raffle_bind_referral($1,$2) AS r", [wallet, ref]);
          return Number(r.rows[0].r) === 1 ? "bound" : "already_bound";
        },
      },
      firstFunder: async () => null,
    };
    const handle = referralEndpoint(deps);
    const victim = signerWallet();
    const attacker = signerWallet();
    const post = (body: Record<string, unknown>) => handle({ method: "POST", headers: {}, body });

    // The attacker signs a consent naming the victim's wallet: refused.
    const forged = await post(consent(victim, attacker, undefined, attacker));
    expect(forged.status).to.equal(401);
    expect((forged as ServedResponse).payload.error).to.equal("bad_signature");

    // The victim's own consent from an hour ago: refused as expired.
    const stale = await post(consent(victim, attacker, new Date(Date.now() - 3_600_000).toISOString()));
    expect((stale as ServedResponse).payload.error).to.equal("signature_expired");

    // A fresh consent signed by the wallet itself binds.
    const ok = await post(consent(victim, attacker));
    expect(ok.status).to.equal(200);
    expect((ok as ServedResponse).payload.status).to.equal("bound");
  });
});

describe("AUDIT R-5 — ORB deposits count only inside the epoch they happened in", () => {
  it("a deposit finalized before the open epoch started awards nothing", async () => {
    await openEpoch("now() - interval '1 hour'");
    await cacheSettledRound();
    const handleClaim = claimEndpoint(claimDeps());
    const wallet = testWallet();
    const sig = testSignature();
    txQueue.set(
      sig,
      syntheticTx({
        signature: sig,
        signers: [wallet],
        accountKeys: [wallet, ORB_PROGRAM_ID],
        blockTime: Math.floor(Date.now() / 1000) - 30 * 24 * 3600, // a month ago
        logLines: [
          `Program ${ORB_PROGRAM_ID} invoke [1]`,
          depositedLogLine({ roundId: ROUND_ID, player: wallet, amountLamports: 3n * SOL }),
          `Program ${ORB_PROGRAM_ID} success`,
        ],
      }),
    );
    const res: ServedResponse = await handleClaim({ method: "POST", headers: {}, body: { signature: sig, wallet } });
    expect(res.payload.awarded, "stale deposit must not be bankable into a later epoch").to.equal(0);
  });
});

describe("AUDIT R-4 — ORE DeployEvents are read only under a top-level ORE instruction", () => {
  it("an ORE Log CPI issued by a foreign top-level program is not a deploy", () => {
    const authority = testWallet();
    const sig = testSignature();
    const tx = syntheticTx({
      signature: sig,
      signers: [authority],
      accountKeys: [authority, ATTACKER_PROGRAM, ORE_PROGRAM_ID],
      innerInstructions: [
        {
          programId: ORE_PROGRAM_ID,
          data: oreDeployLogData({
            authority,
            signer: authority,
            amount: 1_000n * SOL,
            mask: 1n,
            roundId: 1n,
            totalSquares: 25n,
          }),
        },
      ],
    });
    // The only top-level instruction is the attacker's program, which CPI'd ORE's Log.
    tx.transaction.message.instructions = [{ programIdIndex: 1, accounts: [0], data: "" }];
    const outcome = classifyTransaction(tx, authority);
    expect(outcome.events, "a Log CPI from a foreign frame is not a deploy").to.have.length(0);
  });
});

describe("attributeLogLines (the R-1 frame tracker)", () => {
  const ORB = ORB_PROGRAM_ID;
  const X = "XxXxXxXxXxXxXxXxXxXxXxXxXxXxXxXxXxXxXxXxXxXx";
  it("attributes nested CPI lines to the innermost frame and pops back out", async () => {
    const { attributeLogLines } = await import("../src/classify");
    const owners = attributeLogLines([
      `Program ${ORB} invoke [1]`,
      "Program data: A",
      `Program ${X} invoke [2]`,
      "Program data: B",
      `Program ${X} success`,
      "Program data: C",
      `Program ${ORB} success`,
      "Program data: D",
    ])!;
    expect(owners[1]).to.equal(ORB);
    expect(owners[3]).to.equal(X, "a line inside the CPI belongs to the callee");
    expect(owners[5]).to.equal(ORB, "back in the ORB frame after the CPI returns");
    expect(owners[7]).to.equal(null, "a line outside every frame belongs to nobody");
  });
  it("refuses to attribute a truncated log at all", async () => {
    const { attributeLogLines } = await import("../src/classify");
    expect(attributeLogLines([`Program ${ORB} invoke [1]`, "Log truncated"])).to.equal(null);
  });
});
