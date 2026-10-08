/**
 * One-time devnet `initialize`: LIVE Switchboard pins + devnet-test
 * operational params. Idempotent — skips when the config exists.
 *
 *   npx tsx scripts/devnet/init-config.ts
 */

import { OrbitJackpotClient } from "@orbit-jackpot/sdk";
import {
  connection,
  explorer,
  loadAdmin,
  loadOrGenerateKeypair,
  SB_DEVNET_PROGRAM_ID,
  SB_DEVNET_QUEUE,
  send,
} from "./common";

export const DEVNET_ROUND_SECS = 120n;

async function main(): Promise<void> {
  const client = new OrbitJackpotClient(connection);
  const admin = loadAdmin();
  console.log(`admin: ${admin.publicKey.toBase58()}`);

  const existing = await client.fetchConfig();
  if (existing !== null) {
    console.log("already initialized:");
    console.log(`  admin           ${existing.admin}`);
    console.log(`  oracle program  ${existing.oracleProgramId}`);
    console.log(`  oracle queue    ${existing.oracleQueue}`);
    console.log(`  round secs      ${existing.roundDurationSecs}`);
    return;
  }

  const treasury = loadOrGenerateKeypair("treasury");
  const tx = client.buildInitializeTx(admin.publicKey, {
    treasuryAuthority: treasury.publicKey,
    oracleProgramId: SB_DEVNET_PROGRAM_ID,
    oracleQueue: SB_DEVNET_QUEUE,
    oracleProvider: "switchboard",
    maxEntriesPerRound: 100,
    roundDurationSecs: DEVNET_ROUND_SECS,
    maxRoundDurationSecs: 600n,
    antiSnipeWindowSecs: 30n,
    antiSnipeExtensionSecs: 15n,
    claimDeadlineSecs: 3_600n, // 1 h — keeps devnet sweep-testing quick
    minDepositLamports: 10_000_000n, // 0.01 SOL
    antiSnipeMinDepositLamports: 50_000_000n,
    keeperTipLamports: 1_000_000n, // 0.001 SOL out of the admin cut
    randomnessRevealDeadlineSlots: 400n,
  });
  await send(tx, [admin], "initialize");

  const config = (await client.fetchConfig())!;
  console.log(`config: ${explorer("5uRityZDTa2a5LN8wcQjLfc1TuAwyHbfALcVUHn7T56m", "address")}`);
  console.log(`  oracle program  ${config.oracleProgramId}`);
  console.log(`  oracle queue    ${config.oracleQueue}`);
  console.log(`  round secs      ${config.roundDurationSecs}`);
  if (config.oracleProgramId !== SB_DEVNET_PROGRAM_ID.toBase58()) throw new Error("oracle pin mismatch");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
