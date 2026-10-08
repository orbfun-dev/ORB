/**
 * Admin: set the mainnet round duration (applies from the NEXT round
 * opened; the current round keeps its end time). Dry run by default.
 *
 *   ORB_CLUSTER=mainnet MAINNET_RPC_URL=<rpc> npx tsx scripts/mainnet/set-round-duration.ts 60 [--send]
 *
 * Only `round_duration_secs` is `Some`; the other fifteen UpdateConfigArgs
 * options are `None`. The program enforces ≥ 30 s, ≤ max_round_duration,
 * and auto-deposit window < duration.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  configKey,
  INSTRUCTION_DISCRIMINATORS,
  MAINNET_PROGRAM_ID,
  ORB_CLUSTER,
  OrbitJackpotClient,
  PROGRAM_ID,
} from "../../packages/sdk/src/index";

async function main(): Promise<void> {
  const secs = BigInt(process.argv[2] ?? "NaN");
  if (ORB_CLUSTER !== "mainnet" || !PROGRAM_ID.equals(MAINNET_PROGRAM_ID)) throw new Error("run with ORB_CLUSTER=mainnet");
  const rpc = process.env.MAINNET_RPC_URL;
  if (!rpc || /devnet|testnet/.test(rpc)) throw new Error("MAINNET_RPC_URL must be a mainnet endpoint");
  const keys = process.env.ORB_MAINNET_KEYS ?? join(homedir(), ".config", "orb", "mainnet");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(keys, "orb-admin.json"), "utf8"))));
  const connection = new Connection(rpc, "confirmed");
  const client = new OrbitJackpotClient(connection);
  const before = await client.fetchConfig();
  if (before === null) throw new Error("config not initialized");
  if (before.admin !== admin.publicKey.toBase58()) throw new Error(`admin mismatch: config ${before.admin}`);
  console.log(`round_duration_secs ${before.roundDurationSecs} → ${secs}  (max ${before.maxRoundDurationSecs}, auto-deposit window ${before.autoDepositWindowSecs})`);
  if (before.roundDurationSecs === secs) return console.log("already set — nothing to send");

  // max_entries None, round_duration Some(i64), then 14 Nones.
  const args = Buffer.alloc(1 + 9 + 14, 0);
  args[1] = 1;
  args.writeBigInt64LE(secs, 2);
  const tx = new Transaction().add({
    keys: [
      { pubkey: configKey(), isSigner: false, isWritable: true },
      { pubkey: admin.publicKey, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: Buffer.concat([Buffer.from(INSTRUCTION_DISCRIMINATORS.update_config!, "hex"), args]),
  });
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const sim = await connection.simulateTransaction(tx, [admin]);
  if (sim.value.err !== null) {
    console.error((sim.value.logs ?? []).join("\n"));
    throw new Error(`simulation failed ${JSON.stringify(sim.value.err)}`);
  }
  console.log(`simulation ok (${sim.value.unitsConsumed} CU)`);
  if (!process.argv.includes("--send")) return console.log("DRY RUN — re-run with --send");
  console.log(await sendAndConfirmTransaction(connection, tx, [admin], { commitment: "confirmed" }));

  const after = (await client.fetchConfig())!;
  const changed = (Object.keys(before) as Array<keyof typeof before>).filter((k) => String(before[k]) !== String(after[k]));
  console.log(`after: round_duration_secs ${after.roundDurationSecs}; changed fields: ${changed.join(", ")}`);
  if (after.roundDurationSecs !== secs || changed.some((k) => k !== "roundDurationSecs")) throw new Error("unexpected config change");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
