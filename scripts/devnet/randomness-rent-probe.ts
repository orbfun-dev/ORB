/**
 * Phase 12.6 investigation probe (REPORT-ONLY, read-only — no state
 * change): gathers the on-chain evidence for
 * docs/reports/switchboard-rent.md.
 *
 *   npx tsx scripts/devnet/randomness-rent-probe.ts
 *
 * 1. Resolves the CURRENT round's live randomness account and its
 *    companion accounts (reward-escrow wSOL ATA) with balances.
 * 2. Walks the randomness account's signature history and prints each
 *    touching transaction's exact economics: fee, keeper balance delta,
 *    and every account it created with its rent — the create_randomness
 *    entry is the all-in cost figure the report needs.
 * 3. SIMULATES (never sends) a `randomness_close` instruction against the
 *    live randomness account to test whether the DEPLOYED devnet
 *    Switchboard program recognizes the instruction at all: an Anchor
 *    program logs "Instruction: RandomnessClose" when the discriminator
 *    is known; an unknown discriminator fails before any anchor log.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { createHash } from "node:crypto";
import { OrbitJackpotClient } from "@orbit-jackpot/sdk";
import { sleep, withRetry } from "./common";

const RPC = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");

const PROGRAM_ID_STR = "G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R";
const SB_PID = new PublicKey("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");
const KEEPER = new PublicKey("61JhQhzyCU95sNKsBWAYjWjjTbvsKR79FkcDFfYWUys");
const ALT_PROGRAM = new PublicKey("AddressLookupTab1e1111111111111111111111111");

function sighash(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

async function main(): Promise<void> {
  const client = new OrbitJackpotClient(conn);

  // ── 1. the live randomness account of the active round ──
  const config = await withRetry(() => client.fetchConfig(), "config");
  if (config === null) throw new Error("config missing");
  const activeId = config.activeRoundId;
  let round: { id: bigint; randomness: string } | null = null;
  for (const id of [activeId, activeId + 1n, activeId - 1n, activeId + 2n]) {
    if (id < 0n) continue;
    const r = await withRetry(() => client.fetchRound(id), `round ${id}`);
    if (r !== null) {
      round = { id, randomness: r.randomnessAccount };
      break;
    }
    await sleep(200);
  }
  if (round === null) throw new Error("no round account found near active id");
  console.log(`round ${round.id}: state fetch ok`);

  // ── 2. walk the KEEPER's recent history for create_randomness txs ──
  // (Closed rounds vanish, so the per-round randomness key must come out
  // of the transaction itself; the create is recognizable by our program
  // id + the create_randomness discriminator.)
  const CREATE_DISC = Buffer.from("26a26be5984fd017", "hex");
  const sigs = await withRetry(
    () => conn.getSignaturesForAddress(KEEPER, { limit: 60 }),
    "keeper history",
  );
  console.log(`\nkeeper history: ${sigs.length} signature(s)`);
  let randomnessKey: PublicKey | null = null;
  let randAuthority: PublicKey | null = null;
  let escrow: PublicKey | null = null;
  let escrowLamports: number | null = null;
  let found = 0;
  for (const s of sigs) {
    if (found >= 2) break;
    const tx = await withRetry(
      () => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }),
      `tx ${s.signature.slice(0, 8)}`,
    );
    if (tx === null || tx.meta === null) continue;
    const message = tx.transaction.message as unknown as {
      accountKeys: Array<{ toBase58(): string } | string>;
      instructions: Array<{ programIdIndex: number; data: Buffer }>;
    };
    const keys = message.accountKeys.map((k) =>
      typeof k === "string" ? k : k.toBase58(),
    );
    // Our create_randomness outer instruction?
    let isCreate = false;
    for (const ix of message.instructions) {
      const pid = keys[ix.programIdIndex];
      if (pid === PROGRAM_ID_STR && ix.data.subarray(0, 8).equals(CREATE_DISC)) {
        isCreate = true;
        break;
      }
    }
    if (!isCreate) {
      await sleep(150);
      continue;
    }
    found += 1;
    const keeperIdx = keys.indexOf(KEEPER.toBase58());
    const keeperDelta =
      keeperIdx >= 0 ? tx.meta.postBalances[keeperIdx]! - tx.meta.preBalances[keeperIdx]! : null;
    console.log(`\ncreate_randomness tx ${s.signature} (slot ${tx.slot}, blockTime ${tx.blockTime})`);
    console.log(`  fee=${tx.meta.fee} keeper delta=${keeperDelta} status=${JSON.stringify(tx.meta.err)}`);
    const created: Array<[string, number]> = [];
    for (let i = 0; i < keys.length; i += 1) {
      if (tx.meta.preBalances[i] === 0 && tx.meta.postBalances[i]! > 0) {
        created.push([keys[i]!, tx.meta.postBalances[i]!]);
      }
    }
    const infos = await withRetry(
      () => conn.getMultipleAccountsInfo(created.map(([k]) => new PublicKey(k))),
      "created owners",
    );
    console.log(`  accounts created (${created.length}):`);
    for (let i = 0; i < created.length; i += 1) {
      const [key, lamports] = created[i]!;
      const owner = infos[i]?.owner.toBase58() ?? "?";
      const len = infos[i]?.data.length ?? 0;
      const tag = owner === SB_PID.toBase58() ? " ← SB-owned" : "";
      console.log(`    ${key} lamports=${lamports} owner=${owner} len=${len}${tag}`);
      if (owner === SB_PID.toBase58() && len >= 400 && randomnessKey === null) {
        randomnessKey = new PublicKey(key);
      }
    }
    const sbInner = (tx.meta.innerInstructions ?? []).flatMap((ii) => ii.instructions);
    console.log(`  inner ix count=${sbInner.length}`);
    await sleep(400);
  }
  if (randomnessKey === null) throw new Error("no create_randomness tx found in recent history");
  escrow = getAssociatedTokenAddressSync(NATIVE_MINT, randomnessKey);
  const escrowAcc = await withRetry(() => conn.getAccountInfo(escrow!), "escrow");
  escrowLamports = escrowAcc?.lamports ?? null;
  const randAcc = await withRetry(() => conn.getAccountInfo(randomnessKey!), "randomness");
  if (randAcc === null) throw new Error("randomness account already closed");
  randAuthority = new PublicKey(randAcc.data.subarray(8, 40));
  console.log(`\nlive randomness account : ${randomnessKey.toBase58()}`);
  console.log(`  owner=${randAcc.owner.toBase58()} len=${randAcc.data.length} lamports=${randAcc.lamports}`);
  console.log(`  authority        = ${randAuthority.toBase58()}`);
  console.log(`  reward escrow ATA: ${escrow.toBase58()} lamports=${escrowLamports ?? "missing"} len=${escrowAcc?.data.length ?? 0}`);

  // ── 3. does the DEPLOYED program know `randomness_close`? ──
  const closeDisc = sighash("randomness_close");
  console.log(`\nsimulating randomness_close (disc ${closeDisc.toString("hex")}) against the live account…`);
  const lutSigner = PublicKey.findProgramAddressSync(
    [Buffer.from("LutSigner"), randomnessKey.toBuffer()],
    SB_PID,
  )[0];
  const simIx = new TransactionInstruction({
    programId: SB_PID,
    keys: [
      { pubkey: randomnessKey, isSigner: false, isWritable: true },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: randAuthority, isSigner: false, isWritable: false },
      { pubkey: PublicKey.findProgramAddressSync([Buffer.from("STATE")], SB_PID)[0], isSigner: false, isWritable: true },
      { pubkey: PublicKey.systemProgramId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), isSigner: false, isWritable: false },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: lutSigner, isSigner: false, isWritable: false },
      { pubkey: randomnessKey, isSigner: false, isWritable: true }, // lut stand-in
      { pubkey: ALT_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: closeDisc,
  });
  const simTx = new Transaction();
  simTx.add(simIx);
  simTx.feePayer = KEEPER;
  simTx.recentBlockhash = (await withRetry(() => conn.getLatestBlockhash("confirmed"), "blockhash")).blockhash;
  const sim = await withRetry(() => conn.simulateTransaction(simTx), "simulate close");
  console.log("  simulation err:", JSON.stringify(sim.value.err));
  console.log("  logs:");
  for (const l of sim.value.logs ?? []) console.log(`    ${l}`);
}

void main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
