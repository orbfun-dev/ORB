/**
 * MAINNET one-time setup: `initialize` + `migrate_economics_v3` in ONE
 * transaction, so the deployment never spends a moment on v2 economics.
 *
 *   ORB_CLUSTER=mainnet MAINNET_RPC_URL=<paid rpc> npx tsx scripts/mainnet/init-config.ts          # dry run
 *   ORB_CLUSTER=mainnet MAINNET_RPC_URL=<paid rpc> npx tsx scripts/mainnet/init-config.ts --send   # execute
 *
 * Runbook: docs/runbooks/mainnet-launch.md (phase 5). Before `--send`:
 *   - the program is deployed at the mainnet id with the expected upgrade
 *     authority (checked below);
 *   - the v3-aware crank is ready to start (v3 settlement requires the
 *     winning entry; a v2-era crank would fail every settle);
 *   - every value in VALUES has been agreed (phase 0).
 *
 * Rehearsal (runbook phase 2): ORB_REHEARSAL=devnet runs the identical
 * flow against DEVNET — the same mainnet binary and program id deployed
 * there — with Switchboard's devnet program and queue. Nothing else moves.
 *
 * The SDK is imported from SOURCE by relative path on purpose: the
 * workspace package can resolve to another checkout's stale `dist`.
 * Keys come from ~/.config/orb/mainnet (override: ORB_MAINNET_KEYS).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  MAINNET_PROGRAM_ID,
  ORB_CLUSTER,
  OrbitJackpotClient,
  PROGRAM_ID,
  type InitializeArgsData,
} from "../../packages/sdk/src/index";

/** Switchboard On-Demand (verified live 2026-10-08). */
const REHEARSAL = process.env.ORB_REHEARSAL === "devnet";
const SB_PROGRAM_ID = new PublicKey(
  REHEARSAL ? "Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2" : "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv",
);
const SB_QUEUE = new PublicKey(
  REHEARSAL ? "EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7" : "A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w",
);
const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/**
 * Phase-0 values (docs/runbooks/mainnet-launch.md). Tips are starting
 * points; set the measured values with update_config after the smoke test.
 */
const VALUES = {
  // AUDIT P-6: at 100, filling a round with minimum deposits to lock
  // everyone else out cost ~0.07 SOL. Entries are O(1) on chain (settle
  // takes the winning entry directly), so 500 multiplies that cost by five
  // for a cleanup bill the keeper easily covers (11 closes per tx).
  maxEntriesPerRound: 500,
  roundDurationSecs: 120n,
  maxRoundDurationSecs: 600n,
  antiSnipeWindowSecs: 0n, // off, as on devnet
  antiSnipeExtensionSecs: 0n,
  claimDeadlineSecs: 604_800n, // 7 days
  minDepositLamports: 10_000_000n, // 0.01 SOL
  antiSnipeMinDepositLamports: 50_000_000n, // inert while anti-snipe is off
  keeperTipLamports: 100_000n,
  randomnessRevealDeadlineSlots: 400n,
  autoDepositWindowSecs: 20n,
  autoDepositTipLamports: 30_000n,
  autoDepositEnabled: true,
  accountOpenFeeLamports: 10_000_000n, // 0.01 SOL, seeds the Mega-Pot
} as const;

function keypair(dir: string, name: string): Keypair {
  const raw = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main(): Promise<void> {
  const send = process.argv.includes("--send");
  if (ORB_CLUSTER !== "mainnet" || !PROGRAM_ID.equals(MAINNET_PROGRAM_ID)) {
    throw new Error("refusing: run with ORB_CLUSTER=mainnet so the SDK targets the mainnet program");
  }
  const rpc = process.env.MAINNET_RPC_URL;
  if (!rpc) throw new Error("MAINNET_RPC_URL is required (a paid mainnet endpoint)");
  if (REHEARSAL && !/devnet/.test(rpc)) throw new Error("ORB_REHEARSAL=devnet needs a devnet MAINNET_RPC_URL");
  if (!REHEARSAL && /devnet|testnet|127\.0\.0\.1|localhost/.test(rpc)) throw new Error(`MAINNET_RPC_URL looks wrong: ${rpc.replace(/api-key=[^&]+/, "api-key=***")}`);

  const keys = process.env.ORB_MAINNET_KEYS ?? join(homedir(), ".config", "orb", "mainnet");
  const admin = keypair(keys, "orb-admin");
  const treasuryAuthority = keypair(keys, "orb-treasury-authority").publicKey;
  const upgradeAuthority = keypair(keys, "orb-upgrade-authority").publicKey;

  const connection = new Connection(rpc, "confirmed");
  const client = new OrbitJackpotClient(connection);

  // ── the program must be live, at the right id, under our authority ──
  const program = await connection.getAccountInfo(PROGRAM_ID);
  if (program === null || !program.executable || !program.owner.equals(BPF_UPGRADEABLE_LOADER)) {
    throw new Error(`program ${PROGRAM_ID.toBase58()} is not deployed (upgradeable loader) on this cluster`);
  }
  const programData = new PublicKey(program.data.subarray(4, 36));
  const pd = await connection.getAccountInfo(programData);
  if (pd === null) throw new Error("program data account missing");
  const hasAuthority = pd.data[12] === 1;
  const authority = hasAuthority ? new PublicKey(pd.data.subarray(13, 45)) : null;
  if (authority === null || !authority.equals(upgradeAuthority)) {
    throw new Error(`upgrade authority is ${authority?.toBase58() ?? "NONE (immutable)"}, expected orb-upgrade-authority ${upgradeAuthority.toBase58()}`);
  }

  const existing = await client.fetchConfig();
  if (existing !== null) {
    console.log(`already initialized (economics v${existing.economicsVersion}, admin ${existing.admin}) — nothing to do`);
    return;
  }

  const args: InitializeArgsData = {
    treasuryAuthority,
    oracleProgramId: SB_PROGRAM_ID,
    oracleQueue: SB_QUEUE,
    oracleProvider: "switchboard",
    ...VALUES,
  };

  console.log(`cluster          ${REHEARSAL ? "DEVNET REHEARSAL" : "mainnet"} (${PROGRAM_ID.toBase58()})`);
  console.log(`upgrade auth     ${upgradeAuthority.toBase58()} ✓`);
  console.log(`admin (signer)   ${admin.publicKey.toBase58()}  balance ${(await connection.getBalance(admin.publicKey)) / 1e9} SOL`);
  console.log(`treasury auth    ${treasuryAuthority.toBase58()}`);
  console.log(`oracle           ${SB_PROGRAM_ID.toBase58()} queue ${SB_QUEUE.toBase58()}`);
  for (const [k, v] of Object.entries(VALUES)) console.log(`  ${k.padEnd(30)} ${String(v)}`);
  console.log(`then: migrate_economics_v3 (same transaction)`);

  const tx = new Transaction()
    .add(...client.buildInitializeTx(admin.publicKey, args).instructions)
    .add(...client.buildMigrateEconomicsV3Tx(admin.publicKey).instructions);
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const sim = await connection.simulateTransaction(tx, [admin]);
  if (sim.value.err !== null) {
    console.error((sim.value.logs ?? []).join("\n"));
    throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`);
  }
  console.log(`simulation ok (${sim.value.unitsConsumed} CU)`);

  if (!send) {
    console.log("DRY RUN — nothing sent. Re-run with --send to initialize mainnet.");
    return;
  }
  const sig = await sendAndConfirmTransaction(connection, tx, [admin], { commitment: "confirmed" });
  console.log(`initialized: ${sig}`);

  const config = await client.fetchConfig();
  if (config === null) throw new Error("config missing after initialize");
  const problems: string[] = [];
  if (config.economicsVersion !== 3) problems.push(`economics_version ${config.economicsVersion}`);
  if (config.admin !== admin.publicKey.toBase58()) problems.push("admin");
  if (config.treasuryAuthority !== treasuryAuthority.toBase58()) problems.push("treasury authority");
  if (config.oracleProgramId !== SB_PROGRAM_ID.toBase58()) problems.push("oracle program");
  if (config.oracleQueue !== SB_QUEUE.toBase58()) problems.push("oracle queue");
  if (config.keeperTipLamports !== VALUES.keeperTipLamports) problems.push("keeper tip");
  if (config.claimDeadlineSecs !== VALUES.claimDeadlineSecs) problems.push("claim deadline");
  if (problems.length > 0) throw new Error(`config mismatch after initialize: ${problems.join(", ")}`);
  console.log("verified: economics v3, admin, treasury authority, oracle, tips, deadlines");
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
