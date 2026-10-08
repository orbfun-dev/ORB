/**
 * P4 GATE — ORE mining entries come from the fee-wallet indexer, and
 * only deploys made through playorb earn (owner decision, 2026-10-08).
 *
 *  - R4 survives the move: spend = amount × total_squares, attribution
 *    to the deploy `authority`;
 *  - a deploy qualifies only when the authority paid playorb's platform
 *    fee to the fee recipient in the same transaction, at least the
 *    page's own rate on that spend;
 *  - the claim endpoint no longer awards ORE — a direct POST with any
 *    ORE signature earns nothing and writes nothing;
 *  - the cursor walk: pre-launch, failed and not-yet-served
 *    transactions, no open epoch, the per-run cap, replays.
 *
 * The deploy fixture bytes mirror ore@48c203b deploy.rs (see tx.ts).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "chai";
import bs58 from "bs58";
import { before, beforeEach, describe, it } from "mocha";
import { resetDb, testDb, testSignature, testWallet, TestDb } from "./helpers/db";
import { pgClaimStore, testConfig, type ServedResponse } from "./helpers/raffle";
import { FakeFeeChain, playorbDeployTx, runIndexer } from "./helpers/indexer";
import { oreDeployLogData } from "./helpers/tx";
import { claimEndpoint } from "../src/endpoints/claim";
import { decodeOreLogInstruction, deploySpendLamports } from "../src/ore-event";
import { classifyTransaction } from "../src/classify";
import {
  MAX_TX_PER_RUN,
  ORE_INDEXER_CURSOR,
  feePaymentsTo,
  minimumPlatformFee,
} from "../src/ore-indexer";
import { ORE_FEE_DEFAULTS } from "../src/env";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import { ORE_PROGRAM_ID } from "../src/ore-event";
import { qualifyingDeploys } from "../src/ore-indexer";
import { platformFeeLamports } from "../../../apps/web/src/features/ore-lite/fee";

let db: TestDb;
let chain: FakeFeeChain;

const PER_SQUARE = 1_000_000n; // 0.001 SOL per square
const ONE_SOL_PER_25 = 40_000_000n; // 25 squares × 0.04 SOL = 1 SOL

async function openEpoch(): Promise<number> {
  const rows = await db.q(
    `INSERT INTO raffle_epochs (ends_at, cap) VALUES (now() + interval '7 days', 1000) RETURNING id`,
  );
  return Number(rows[0].id);
}

/** Put a deploy on the fake chain and return its signature. */
function deploy(opts: Parameters<typeof playorbDeployTx>[1], extra: { err?: unknown } = {}): string {
  const sig = testSignature();
  chain.add(sig, playorbDeployTx(sig, opts), extra);
  return sig;
}

async function entriesOf(wallet: string): Promise<number> {
  const rows = await db.q("SELECT count(*) AS n FROM raffle_entries WHERE wallet = $1", [wallet]);
  return Number(rows[0].n);
}

before(async () => {
  db = await testDb();
});
beforeEach(async () => {
  await resetDb(db);
  chain = new FakeFeeChain();
});

describe("P4 — R4 through the indexer: spend = amount × total_squares", () => {
  it("credits a 25-square deploy as 25× the per-square amount", async () => {
    const epochId = await openEpoch();
    const authority = testWallet();
    deploy({ authority, amountPerSquare: PER_SQUARE, totalSquares: 25n });

    const run = await runIndexer(db.pool, chain);
    expect(run.status).to.equal("ok");
    expect(run.qualified).to.equal(1);
    expect(run.awarded).to.equal(0); // 0.025 SOL is under the 1-entry bar

    const progress = await db.q(
      "SELECT cumulative_lamports FROM raffle_progress WHERE epoch_id = $1 AND source = 'ore_mining'",
      [epochId],
    );
    expect(BigInt(progress[0].cumulative_lamports)).to.equal(PER_SQUARE * 25n);
  });

  it("decodes a REAL mainnet playorb deploy's Log bytes", () => {
    // Inner ORE instruction of 5k4vtFhpZDxkRTRKBVsk2XBmVAF6SKSws9gWSdjr2sQcBVMiCvUA1MkyNe9pRh1VCJNXZYQHL15XdWukjuqmCzxP —
    // a 25-square, 0.0004 SOL/square deploy made on playorb's ORE tab on
    // 2026-10-07 (round 431294). Fixtures can share a mistake with the
    // decoder; these bytes cannot.
    const event = decodeOreLogInstruction(Buffer.from(bs58.decode(
      "5u9ffikrRy9ijE8mdbYE6LJpk1ohaeEo6YLtFBB3yUYMMhqG4g9H4NiN82wzsSAQzKvsgAY6ASMYFcG6qpS1463o5xpcD7EpCUe8Y4HRET1SrZPmW5Kv2HF6BT2Nwa9RBaezQSYaRtsS8YUYRSGwkUwPYhddaCXAKSGYw",
    )));
    expect(event).to.not.be.null;
    expect(event!.authority).to.equal("4woeMUVTaXqWfQWFGZyByUGKKdnPiRXM3FqwXPs9tjJz");
    expect(event!.signer).to.equal(event!.authority);
    expect(event!.amount).to.equal(400_000n);
    expect(event!.totalSquares).to.equal(25n);
    expect(event!.roundId).to.equal(431_294n);
    expect(deploySpendLamports(event!)).to.equal(10_000_000n);
  });

  it("the raw decoder agrees: spend = amount × total_squares", () => {
    const data = bs58.decode(
      oreDeployLogData({
        authority: testWallet(),
        signer: testWallet(),
        amount: PER_SQUARE,
        mask: (1n << 25n) - 1n,
        roundId: 1n,
        totalSquares: 25n,
      }),
    );
    const event = decodeOreLogInstruction(Buffer.from(data));
    expect(event).to.not.be.null;
    expect(deploySpendLamports(event!)).to.equal(PER_SQUARE * 25n);
    expect(deploySpendLamports(event!)).to.not.equal(event!.amount);
  });

  it("a 1 SOL deploy through playorb earns 1 confirmed ore_mining entry for the authority", async () => {
    const epochId = await openEpoch();
    const authority = testWallet();
    deploy({ authority, amountPerSquare: ONE_SOL_PER_25, totalSquares: 25n });

    const run = await runIndexer(db.pool, chain);
    expect(run.awarded).to.equal(1);

    const entries = await db.q(
      "SELECT source, status, wallet FROM raffle_entries WHERE epoch_id = $1",
      [epochId],
    );
    expect(entries).to.deep.equal([{ source: "ore_mining", status: "confirmed", wallet: authority }]);
  });
});

describe("P4 — only deploys that paid playorb's fee earn", () => {
  it("a transaction touching the fee wallet without a fee transfer earns nothing", async () => {
    await openEpoch();
    const authority = testWallet();
    deploy({ authority, amountPerSquare: ONE_SOL_PER_25, totalSquares: 25n, feeLamports: null });

    const run = await runIndexer(db.pool, chain);
    expect(run.awarded).to.equal(0);
    expect(run.skipped).to.deep.equal({ no_fee_payment: 1 });
    expect(await entriesOf(authority)).to.equal(0);
  });

  it("a fee below the page's own rate earns nothing (the token-transfer bot)", async () => {
    await openEpoch();
    const authority = testWallet();
    // 1 SOL deploy → the page charges 1% = 0.01 SOL; this pays the 0.0001 floor.
    deploy({
      authority,
      amountPerSquare: ONE_SOL_PER_25,
      totalSquares: 25n,
      feeLamports: 100_000n,
    });

    const run = await runIndexer(db.pool, chain);
    expect(run.skipped).to.deep.equal({ fee_below_rule: 1 });
    expect(await entriesOf(authority)).to.equal(0);
    const events = await db.q("SELECT count(*) AS n FROM raffle_events");
    expect(Number(events[0].n)).to.equal(0);
  });

  it("paying more than the page's fee still earns", async () => {
    await openEpoch();
    const authority = testWallet();
    deploy({
      authority,
      amountPerSquare: ONE_SOL_PER_25,
      totalSquares: 25n,
      feeLamports: 20_000_000n,
    });
    const run = await runIndexer(db.pool, chain);
    expect(run.awarded).to.equal(1);
  });

  it("a fee paid by someone other than the deploy authority credits nobody", async () => {
    await openEpoch();
    const authority = testWallet();
    const payer = testWallet();
    deploy({ authority, feePayer: payer, amountPerSquare: ONE_SOL_PER_25, totalSquares: 25n });

    const run = await runIndexer(db.pool, chain);
    expect(run.awarded).to.equal(0);
    expect(run.skipped).to.deep.equal({ no_deploy: 1 });
    expect(await entriesOf(authority)).to.equal(0);
    expect(await entriesOf(payer)).to.equal(0);
  });

  it("an automation deploy (executor signs, no fee) earns nothing for anyone", async () => {
    await openEpoch();
    const authority = testWallet();
    const executor = testWallet();
    deploy({
      authority,
      signer: executor,
      strategy: 7n,
      amountPerSquare: ONE_SOL_PER_25,
      totalSquares: 25n,
      feeLamports: null,
    });

    await runIndexer(db.pool, chain);
    expect(await entriesOf(authority)).to.equal(0);
    expect(await entriesOf(executor)).to.equal(0);
  });

  it("a zero-square deploy (all squares sniped) records nothing even with the fee paid", async () => {
    await openEpoch();
    const authority = testWallet();
    deploy({
      authority,
      amountPerSquare: PER_SQUARE,
      totalSquares: 0n,
      mask: 0n,
      feeLamports: 100_000n,
    });

    const run = await runIndexer(db.pool, chain);
    expect(run.skipped).to.deep.equal({ no_deploy: 1 });
    const events = await db.q("SELECT count(*) AS n FROM raffle_events");
    expect(Number(events[0].n)).to.equal(0);
  });

  it("reads the fee transfer out of a transaction", () => {
    const authority = testWallet();
    const sig = testSignature();
    const tx = playorbDeployTx(sig, {
      authority,
      amountPerSquare: ONE_SOL_PER_25,
      totalSquares: 25n,
    });
    const paid = feePaymentsTo(tx, testConfig().oreFeeRecipient!);
    expect([...paid.entries()]).to.deep.equal([[authority, 10_000_000n]]);
    expect(feePaymentsTo(tx, testWallet()).size).to.equal(0);
  });
});

describe("P4 — a real v0 message (what the page actually sends)", () => {
  // The page builds ONE v0 transaction. web3.js getTransaction returns
  // its message as a MessageV0 — compiledInstructions with raw bytes,
  // staticAccountKeys as PublicKeys — not the raw-json `instructions`
  // shape the synthetic fixtures use. Both must read the same.
  function v0DeployTx(authority: PublicKey, fee: bigint): any {
    const message = new TransactionMessage({
      payerKey: authority,
      recentBlockhash: bs58.encode(Buffer.alloc(32, 7)),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: authority,
          toPubkey: new PublicKey(testConfig().oreFeeRecipient!),
          lamports: fee,
        }),
        new TransactionInstruction({
          programId: new PublicKey(ORE_PROGRAM_ID),
          keys: [{ pubkey: authority, isSigner: true, isWritable: true }],
          data: Buffer.from([6]),
        }),
      ],
    }).compileToV0Message();
    return {
      slot: 400_000_000,
      blockTime: Math.floor(Date.now() / 1000),
      transaction: { message, signatures: [] },
      meta: {
        err: null,
        logMessages: [],
        loadedAddresses: { writable: [], readonly: [] },
        innerInstructions: [
          {
            index: 1,
            instructions: [
              {
                programIdIndex: message.staticAccountKeys.findIndex((k) => k.toBase58() === ORE_PROGRAM_ID),
                accounts: [],
                data: oreDeployLogData({
                  authority: authority.toBase58(),
                  signer: authority.toBase58(),
                  amount: ONE_SOL_PER_25,
                  mask: (1n << 25n) - 1n,
                  roundId: 1n,
                  totalSquares: 25n,
                }),
              },
            ],
          },
        ],
      },
    };
  }

  it("finds the fee and the deploy in a compiled v0 message", () => {
    const authority = Keypair.generate().publicKey;
    const tx = v0DeployTx(authority, 10_000_000n);
    expect([...feePaymentsTo(tx, testConfig().oreFeeRecipient!).entries()]).to.deep.equal([
      [authority.toBase58(), 10_000_000n],
    ]);
    const rule = {
      bps: ORE_FEE_DEFAULTS.oreFeeBps,
      minLamports: BigInt(ORE_FEE_DEFAULTS.oreFeeMinLamports),
      maxLamports: BigInt(ORE_FEE_DEFAULTS.oreFeeMaxLamports),
    };
    const verdict = qualifyingDeploys(tx, testConfig().oreFeeRecipient!, rule);
    expect(verdict).to.deep.equal({
      kind: "qualified",
      deploys: [{ wallet: authority.toBase58(), eventIndex: 0, solLamports: 1_000_000_000n }],
    });
    expect(qualifyingDeploys(v0DeployTx(authority, 9_999_999n), testConfig().oreFeeRecipient!, rule))
      .to.deep.equal({ kind: "skipped", reason: "fee_below_rule" });
  });
});

describe("P4 — the claim endpoint no longer awards ORE", () => {
  let handleClaim: ReturnType<typeof claimEndpoint>;
  const txs = new Map<string, any>();

  beforeEach(() => {
    txs.clear();
    handleClaim = claimEndpoint({
      config: testConfig(),
      store: pgClaimStore(db.pool),
      fetchTransaction: async (sig) => txs.get(sig) ?? null,
    });
  });

  function claim(signature: string, wallet: string): Promise<ServedResponse> {
    return handleClaim({ method: "POST", headers: {}, body: { signature, wallet } });
  }

  it("a deploy made elsewhere, claimed directly, earns nothing and writes nothing", async () => {
    await openEpoch();
    const authority = testWallet();
    const sig = testSignature();
    txs.set(sig, playorbDeployTx(sig, {
      authority,
      amountPerSquare: ONE_SOL_PER_25,
      totalSquares: 25n,
      feeLamports: null,
    }));

    const res = await claim(sig, authority);
    expect(res.status).to.equal(200);
    expect(res.payload).to.deep.equal({ awarded: 0, pending: 0, reason: "ore_deploys_are_indexed" });
    const events = await db.q("SELECT count(*) AS n FROM raffle_events");
    expect(Number(events[0].n)).to.equal(0);
  });

  it("answers the same with no open epoch — an ORE claim is never 'pending'", async () => {
    const authority = testWallet();
    const sig = testSignature();
    txs.set(sig, playorbDeployTx(sig, { authority, amountPerSquare: ONE_SOL_PER_25, totalSquares: 25n }));
    const res = await claim(sig, authority);
    expect(res.status).to.equal(200);
    expect(res.payload.reason).to.equal("ore_deploys_are_indexed");
  });

  it("claiming a playorb deploy first does not stop the indexer awarding it", async () => {
    await openEpoch();
    const authority = testWallet();
    const sig = deploy({ authority, amountPerSquare: ONE_SOL_PER_25, totalSquares: 25n });
    txs.set(sig, await chain.fetchTransaction(sig));

    expect((await claim(sig, authority)).payload.awarded).to.equal(0);
    const run = await runIndexer(db.pool, chain);
    expect(run.awarded).to.equal(1);
    expect(await entriesOf(authority)).to.equal(1);
  });

  it("the classifier still sees the deploy (it is the indexer's source of truth)", () => {
    const authority = testWallet();
    const tx = playorbDeployTx(testSignature(), {
      authority,
      amountPerSquare: PER_SQUARE,
      totalSquares: 25n,
    });
    const outcome = classifyTransaction(tx, authority);
    expect(outcome.events).to.have.lengthOf(1);
    expect(outcome.events[0].solLamports).to.equal(PER_SQUARE * 25n);
  });
});

describe("P4 — the cursor walk", () => {
  it("a second run over the same history awards nothing (replay is a no-op)", async () => {
    await openEpoch();
    const authority = testWallet();
    const sig = deploy({ authority, amountPerSquare: ONE_SOL_PER_25, totalSquares: 25n });

    const first = await runIndexer(db.pool, chain);
    expect(first.awarded).to.equal(1);
    expect(first.cursor).to.equal(sig);

    const second = await runIndexer(db.pool, chain);
    expect(second.seen).to.equal(0);
    expect(second.awarded).to.equal(0);

    // Even with the cursor wiped, the ledger dedups.
    await db.q("DELETE FROM raffle_indexer_cursors");
    const third = await runIndexer(db.pool, chain);
    expect(third.qualified).to.equal(1);
    expect(third.awarded).to.equal(0);
    expect(await entriesOf(authority)).to.equal(1);
  });

  it("only deploys newer than the cursor are fetched", async () => {
    await openEpoch();
    const a = testWallet();
    const b = testWallet();
    deploy({ authority: a, amountPerSquare: ONE_SOL_PER_25, totalSquares: 25n });
    await runIndexer(db.pool, chain);

    deploy({ authority: b, amountPerSquare: ONE_SOL_PER_25, totalSquares: 25n });
    const run = await runIndexer(db.pool, chain);
    expect(run.seen).to.equal(1);
    expect(run.awarded).to.equal(1);
    expect(await entriesOf(a)).to.equal(1);
    expect(await entriesOf(b)).to.equal(1);
  });

  it("pre-launch and failed transactions are passed over, not awarded", async () => {
    await openEpoch();
    const early = testWallet();
    const failed = testWallet();
    const good = testWallet();
    deploy({
      authority: early,
      amountPerSquare: ONE_SOL_PER_25,
      totalSquares: 25n,
      blockTime: Math.floor(Date.now() / 1000) - 86_400,
    });
    deploy(
      { authority: failed, amountPerSquare: ONE_SOL_PER_25, totalSquares: 25n },
      { err: { InstructionError: [3, "Custom"] } },
    );
    const last = deploy({ authority: good, amountPerSquare: ONE_SOL_PER_25, totalSquares: 25n });

    const run = await runIndexer(db.pool, chain);
    expect(run.processed).to.equal(3);
    expect(run.qualified).to.equal(1);
    expect(run.cursor).to.equal(last);
    expect(await entriesOf(early)).to.equal(0);
    expect(await entriesOf(failed)).to.equal(0);
    expect(await entriesOf(good)).to.equal(1);
  });

  it("does nothing before the first epoch exists", async () => {
    deploy({ authority: testWallet(), amountPerSquare: ONE_SOL_PER_25, totalSquares: 25n });
    const run = await runIndexer(db.pool, chain);
    expect(run.status).to.equal("not_launched");
    expect(run.cursor).to.equal(null);
  });

  it("with no open epoch the cursor holds, and the deploy lands once one opens", async () => {
    const epochId = await openEpoch();
    await db.q("UPDATE raffle_epochs SET status = 'locked', locked_at = now(), lock_reason = 'timer' WHERE id = $1", [epochId]);
    const authority = testWallet();
    deploy({ authority, amountPerSquare: ONE_SOL_PER_25, totalSquares: 25n });

    const held = await runIndexer(db.pool, chain);
    expect(held.status).to.equal("no_open_epoch");
    expect(held.processed).to.equal(0);

    const next = await openEpoch();
    const run = await runIndexer(db.pool, chain);
    expect(run.awarded).to.equal(1);
    const rows = await db.q("SELECT epoch_id FROM raffle_entries WHERE wallet = $1", [authority]);
    expect(Number(rows[0].epoch_id)).to.equal(next);
  });

  it("a listed but not-yet-served transaction stops the run before it", async () => {
    await openEpoch();
    const a = testWallet();
    const b = testWallet();
    const first = deploy({ authority: a, amountPerSquare: ONE_SOL_PER_25, totalSquares: 25n });
    const second = deploy({ authority: b, amountPerSquare: ONE_SOL_PER_25, totalSquares: 25n });
    chain.unserved.add(second);

    const run = await runIndexer(db.pool, chain);
    expect(run.cursor).to.equal(first);
    expect(await entriesOf(b)).to.equal(0);

    chain.unserved.delete(second);
    const later = await runIndexer(db.pool, chain);
    expect(later.awarded).to.equal(1);
    expect(await entriesOf(b)).to.equal(1);
  });

  it(`fetches at most ${MAX_TX_PER_RUN} transactions per run, then resumes`, async () => {
    await openEpoch();
    const wallets: string[] = [];
    for (let i = 0; i < MAX_TX_PER_RUN + 5; i += 1) {
      const w = testWallet();
      wallets.push(w);
      deploy({ authority: w, amountPerSquare: ONE_SOL_PER_25, totalSquares: 25n });
    }
    const first = await runIndexer(db.pool, chain);
    expect(first.qualified).to.equal(MAX_TX_PER_RUN);
    const second = await runIndexer(db.pool, chain);
    expect(second.qualified).to.equal(5);
    for (const w of wallets) expect(await entriesOf(w)).to.equal(1);
  });

  it("the cursor never moves back to an older slot", async () => {
    await db.q("SELECT raffle_advance_indexer_cursor($1, 'newer', 200)", [ORE_INDEXER_CURSOR]);
    await db.q("SELECT raffle_advance_indexer_cursor($1, 'older', 100)", [ORE_INDEXER_CURSOR]);
    const rows = await db.q("SELECT last_signature, last_slot FROM raffle_indexer_cursors");
    expect(rows).to.deep.equal([{ last_signature: "newer", last_slot: "200" }]);
  });

  it("refuses to run without the fee recipient configured", async () => {
    await openEpoch();
    let thrown: unknown = null;
    try {
      await runIndexer(db.pool, chain, { ...testConfig(), oreFeeRecipient: undefined });
    } catch (err) {
      thrown = err;
    }
    expect(String(thrown)).to.match(/RAFFLE_ORE_FEE_RECIPIENT/);
  });
});

describe("P4 — the server's fee rule is the page's fee rule", () => {
  // The page's PLATFORM_FEE lives in a Vite-env module that cannot load
  // under node, so its literal is read as text. If this fails, someone
  // changed the page's fee: change ORE_FEE_DEFAULTS (or the Vercel
  // RAFFLE_ORE_FEE_* env) with it, or the page's own users stop earning.
  const configText = readFileSync(
    resolve(__dirname, "..", "..", "..", "apps", "web", "src", "features", "ore-lite", "config.ts"),
    "utf8",
  );
  const block = configText.slice(configText.indexOf("export const PLATFORM_FEE"));
  const num = (field: string): bigint =>
    BigInt(new RegExp(`${field}:\\s*([0-9_]+)`).exec(block)![1].replace(/_/g, ""));

  it("bps, floor and ceiling match apps/web PLATFORM_FEE", () => {
    expect(num("bps")).to.equal(BigInt(ORE_FEE_DEFAULTS.oreFeeBps));
    expect(num("minLamports")).to.equal(BigInt(ORE_FEE_DEFAULTS.oreFeeMinLamports));
    expect(num("maxLamports")).to.equal(BigInt(ORE_FEE_DEFAULTS.oreFeeMaxLamports));
  });

  it("minimumPlatformFee computes what the page's fee engine charges", () => {
    const rule = {
      bps: ORE_FEE_DEFAULTS.oreFeeBps,
      minLamports: BigInt(ORE_FEE_DEFAULTS.oreFeeMinLamports),
      maxLamports: BigInt(ORE_FEE_DEFAULTS.oreFeeMaxLamports),
    };
    const page = {
      kind: "bps" as const,
      bps: rule.bps,
      minLamports: rule.minLamports,
      maxLamports: rule.maxLamports,
    };
    for (const spend of [0n, 1n, 9_999_999n, 10_000_000n, 1_000_000_000n, 4_999_999_999n, 1_000_000_000_000n]) {
      expect(minimumPlatformFee(rule, spend), `spend ${spend}`).to.equal(platformFeeLamports(page, spend));
    }
  });
});
