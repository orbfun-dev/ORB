/**
 * Operate the self-hosted randomness provider (randomness fallback,
 * docs/design/randomness-fallback.md §2.2). Dry run by default.
 *
 *   npx tsx scripts/mainnet/entropy-chain.ts generate <seed-file> <length>
 *       Writes a NEW secret chain { x0, length } (mode 600). Never commit
 *       it; back it up offline. Losing it halts entropy rounds for 24 h.
 *   ORB_CLUSTER=mainnet MAINNET_RPC_URL=<rpc> npx tsx scripts/mainnet/entropy-chain.ts status
 *   … set <seed-file> [--send]          admin: commit the chain on chain
 *   … provider <switchboard|entropy> [--send]   admin: provider for NEW rounds
 *
 * ORB_REHEARSAL=devnet + a devnet MAINNET_RPC_URL targets the mainnet build
 * deployed on devnet (same as init-config.ts).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  ENTROPY_NONE,
  MAINNET_PROGRAM_ID,
  ORB_CLUSTER,
  OrbitJackpotClient,
  PROGRAM_ID,
  type OracleProviderName,
} from "../../packages/sdk/src/index";
import { EntropySeeds } from "../../apps/crank/src/entropy";

const REHEARSAL = process.env.ORB_REHEARSAL === "devnet";

function keypair(dir: string, name: string): Keypair {
  const raw = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function connect(): { connection: Connection; client: OrbitJackpotClient } {
  if (ORB_CLUSTER !== "mainnet" || !PROGRAM_ID.equals(MAINNET_PROGRAM_ID)) {
    throw new Error("refusing: run with ORB_CLUSTER=mainnet so the SDK targets the mainnet program");
  }
  const rpc = process.env.MAINNET_RPC_URL;
  if (!rpc) throw new Error("MAINNET_RPC_URL is required");
  if (REHEARSAL !== /devnet/.test(rpc)) {
    throw new Error("MAINNET_RPC_URL must be a devnet URL exactly when ORB_REHEARSAL=devnet");
  }
  const connection = new Connection(rpc, "confirmed");
  return { connection, client: new OrbitJackpotClient(connection) };
}

async function sendOrDryRun(connection: Connection, tx: Transaction, admin: Keypair, what: string): Promise<void> {
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const sim = await connection.simulateTransaction(tx, [admin]);
  if (sim.value.err !== null) {
    console.error((sim.value.logs ?? []).join("\n"));
    throw new Error(`${what}: simulation failed ${JSON.stringify(sim.value.err)}`);
  }
  console.log(`${what}: simulation ok (${sim.value.unitsConsumed} CU)`);
  if (!process.argv.includes("--send")) {
    console.log("DRY RUN — re-run with --send");
    return;
  }
  const sig = await sendAndConfirmTransaction(connection, tx, [admin], { commitment: "confirmed" });
  console.log(`${what}: ${sig}`);
}

async function status(): Promise<void> {
  const { client } = connect();
  const config = await client.fetchConfig();
  const chain = await client.fetchEntropyChain();
  console.log(`cluster   ${REHEARSAL ? "DEVNET REHEARSAL" : "mainnet"} (${PROGRAM_ID.toBase58()})`);
  console.log(`provider  ${config?.oracleProvider ?? "(no config)"}`);
  if (chain === null) {
    console.log("chain     not set");
    return;
  }
  const r = (v: bigint) => (v === ENTROPY_NONE ? "none" : v.toString());
  console.log(`chain     commit ${chain.commit.slice(0, 16)}…  remaining ${chain.remaining}  revealed ${chain.revealedCount}`);
  console.log(`          pending ${r(chain.pendingRound)} (target slot ${chain.targetSlot})  unsettled value ${r(chain.valueRound)}`);
}

async function main(): Promise<void> {
  const [cmd, a1, a2] = process.argv.slice(2).filter((x) => x !== "--send");
  if (cmd === "generate") {
    const length = Number(a2);
    if (a1 === undefined || !Number.isInteger(length) || length < 1) throw new Error("usage: generate <seed-file> <length>");
    if (existsSync(a1)) throw new Error(`refusing to overwrite ${a1}`);
    const x0 = randomBytes(32);
    writeFileSync(a1, JSON.stringify({ x0: x0.toString("hex"), length }) + "\n", { mode: 0o600, flag: "wx" });
    const seeds = new EntropySeeds(x0, length);
    console.log(`wrote ${a1} (mode 600). commit ${seeds.commit().toString("hex")}  length ${length}`);
    return;
  }
  if (cmd === "status") return status();

  const keys = process.env.ORB_MAINNET_KEYS ?? join(homedir(), ".config", "orb", "mainnet");
  const admin = keypair(keys, "orb-admin");
  const { connection, client } = connect();
  const config = await client.fetchConfig();
  if (config === null) throw new Error("config not initialized");
  if (config.admin !== admin.publicKey.toBase58()) throw new Error(`admin mismatch: config ${config.admin}`);

  if (cmd === "set") {
    if (a1 === undefined) throw new Error("usage: set <seed-file> [--send]");
    const seeds = EntropySeeds.fromFile(a1);
    const commit = seeds.commit();
    console.log(`commit ${commit.toString("hex")}  length ${seeds.length}`);
    await sendOrDryRun(
      connection,
      client.buildSetEntropyChainTx(admin.publicKey, commit, BigInt(seeds.length)),
      admin,
      "set_entropy_chain",
    );
    return status();
  }
  if (cmd === "provider") {
    if (a1 !== "switchboard" && a1 !== "entropy") throw new Error("usage: provider <switchboard|entropy> [--send]");
    console.log(`provider ${config.oracleProvider} → ${a1}`);
    await sendOrDryRun(connection, client.buildSetOracleProviderTx(admin.publicKey, a1 as OracleProviderName), admin, "update_config oracle_provider");
    return status();
  }
  throw new Error("commands: generate | status | set | provider");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
