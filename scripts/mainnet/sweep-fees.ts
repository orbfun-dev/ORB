/**
 * MAINNET fee sweep: moves the treasury vault's accrued admin fees to the
 * fee receiver. Signer: orb-treasury-authority (needs ~0.001 SOL for fees).
 *
 *   ORB_CLUSTER=mainnet MAINNET_RPC_URL=<rpc> npx tsx scripts/mainnet/sweep-fees.ts          # dry run
 *   ORB_CLUSTER=mainnet MAINNET_RPC_URL=<rpc> npx tsx scripts/mainnet/sweep-fees.ts --send   # execute
 *
 * Destination defaults to orb-fee-receiver; pass `--to <pubkey>` to
 * override. ORB_REHEARSAL=devnet allows a devnet RPC (runbook phase 2).
 * SDK imported from source on purpose (see init-config.ts).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  INSTRUCTION_DISCRIMINATORS,
  MAINNET_PROGRAM_ID,
  ORB_CLUSTER,
  OrbitJackpotClient,
  PROGRAM_ID,
  configKey,
  treasuryKey,
} from "../../packages/sdk/src/index";

const REHEARSAL = process.env.ORB_REHEARSAL === "devnet";

function keypair(dir: string, name: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as number[]));
}

async function main(): Promise<void> {
  const send = process.argv.includes("--send");
  if (ORB_CLUSTER !== "mainnet" || !PROGRAM_ID.equals(MAINNET_PROGRAM_ID)) {
    throw new Error("refusing: run with ORB_CLUSTER=mainnet");
  }
  const rpc = process.env.MAINNET_RPC_URL;
  if (!rpc) throw new Error("MAINNET_RPC_URL is required");
  if (REHEARSAL ? !/devnet/.test(rpc) : /devnet|testnet|127\.0\.0\.1|localhost/.test(rpc)) {
    throw new Error(REHEARSAL ? "ORB_REHEARSAL=devnet needs a devnet RPC" : "MAINNET_RPC_URL looks wrong");
  }
  const keys = process.env.ORB_MAINNET_KEYS ?? join(homedir(), ".config", "orb", "mainnet");
  const authority = keypair(keys, "orb-treasury-authority");
  const toArg = process.argv.indexOf("--to");
  const destination =
    toArg >= 0 ? new PublicKey(process.argv[toArg + 1]!) : keypair(keys, "orb-fee-receiver").publicKey;

  const connection = new Connection(rpc, "confirmed");
  const client = new OrbitJackpotClient(connection);
  const config = await client.fetchConfig();
  if (config === null) throw new Error("not initialized");
  if (config.treasuryAuthority !== authority.publicKey.toBase58()) {
    throw new Error(`treasury authority on chain is ${config.treasuryAuthority}, not orb-treasury-authority`);
  }
  const vault = await connection.getAccountInfo(treasuryKey());
  if (vault === null) throw new Error("treasury vault missing");
  const accrued = vault.data.readBigUInt64LE(8);
  console.log(`treasury accrued  ${Number(accrued) / 1e9} SOL`);
  console.log(`destination       ${destination.toBase58()}  (balance ${(await connection.getBalance(destination)) / 1e9} SOL)`);
  if (accrued === 0n) {
    console.log("nothing to sweep");
    return;
  }

  const tx = new Transaction().add({
    programId: PROGRAM_ID,
    data: Buffer.from(INSTRUCTION_DISCRIMINATORS.admin_sweep_fees!, "hex"),
    keys: [
      { pubkey: configKey(), isSigner: false, isWritable: false },
      { pubkey: treasuryKey(), isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
  });
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const sim = await connection.simulateTransaction(tx, [authority]);
  if (sim.value.err !== null) {
    console.error((sim.value.logs ?? []).join("\n"));
    throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`);
  }
  if (!send) {
    console.log("DRY RUN — simulation ok; re-run with --send to sweep.");
    return;
  }
  const before = await connection.getBalance(destination);
  const sig = await sendAndConfirmTransaction(connection, tx, [authority], { commitment: "confirmed" });
  const gained = BigInt((await connection.getBalance(destination)) - before);
  console.log(`swept ${Number(gained) / 1e9} SOL → ${destination.toBase58()} (${sig})`);
  if (gained !== accrued) throw new Error(`destination gained ${gained}, expected ${accrued}`);
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
