/**
 * The ADR-11 preflight drain for the devnet deployment: pays the pre-v2
 * Mega-Pot out to the treasury so the migration's `accrued_lamports == 0`
 * guard is satisfied by real bookkeeping. Under the live v1 config
 * (award 9 000, uncapped, 1-in-6 767) the pot can never reach 0 by
 * itself — a pop retains ≥ 10% + the round's own cut — so this is the
 * honest resolution, and it is one-shot: the on-chain instruction refuses
 * once `economics_version >= 2`.
 *
 *   npx tsx scripts/devnet/drain-mega-pot.ts            # print state
 *   npx tsx scripts/devnet/drain-mega-pot.ts --confirm  # send it
 *
 * Client-side guards mirror the program's, each refusing loudly:
 *   1. `economics_version < 2` (the latch must still be open);
 *   2. `active_round_id == next_round_id` (no round in flight — stop the
 *      keeper and let the last round close first);
 *   3. `accrued_lamports > 0` (nothing to drain is a mistake, not a no-op);
 *   4. the signer is the config admin (`vaulted-admin`).
 */

import { OrbitJackpotClient } from "@orbit-jackpot/sdk";
import { connection, explorer, loadAdmin, send } from "./common";

async function main(): Promise<void> {
  const confirmed = process.argv.includes("--confirm");
  const client = new OrbitJackpotClient(connection);
  const admin = loadAdmin();

  const config = await client.fetchConfig();
  if (config === null) throw new Error("program not initialized — run init-config first");
  const megaPot = await client.fetchMegaPot();
  if (megaPot === null) throw new Error("mega-pot account missing");

  console.log("current state:");
  console.log(`  admin              ${config.admin}`);
  console.log(`  economics_version  ${config.economicsVersion}`);
  console.log(`  rounds             active ${config.activeRoundId} / next ${config.nextRoundId}`);
  console.log(`  mega-pot accrued   ${megaPot.accruedLamports} lamports`);

  if (config.economicsVersion >= 2) {
    throw new Error(
      "economics_version already 2 — the preflight drain died with the latch " +
        "(EconomicsAlreadyMigrated on-chain). Nothing to do.",
    );
  }
  if (config.activeRoundId !== config.nextRoundId) {
    throw new Error(
      `round ${config.activeRoundId} is still in flight (next ${config.nextRoundId}) — stop the ` +
        `keeper, let every round reach a terminal state and close, then re-run`,
    );
  }
  if (megaPot.accruedLamports === 0n) {
    throw new Error(
      "mega-pot is already empty — run the migration dry run " +
        "(npm run devnet:migrate-economics) directly",
    );
  }
  if (config.admin !== admin.publicKey.toBase58()) {
    throw new Error(`admin mismatch: config ${config.admin} ≠ signer ${admin.publicKey.toBase58()}`);
  }

  if (!confirmed) {
    console.log(
      `\ndry run — would drain ${megaPot.accruedLamports} lamports to the treasury ` +
        "(CvYKZpxmhpFmrkuPuWEFuT22yMDgHyMwnkvL5pDpLupL). Re-run with --confirm to send it.",
    );
    return;
  }

  console.log("\nsending drain_mega_pot_v1_preflight…");
  const tx = client.buildDrainMegaPotPreflightTx(admin.publicKey);
  await send(tx, [admin], "drain_mega_pot_v1_preflight");

  const after = (await client.fetchMegaPot())!;
  console.log(`\nmega-pot accrued   ${after.accruedLamports} lamports`);
  if (after.accruedLamports !== 0n) throw new Error("pot did not drain to exactly 0 — investigate");
  console.log(`\nmega-pot: ${explorer("G1Wu9GwnP62jQJRMR1juUxJGnBDG1itc7waXHG327kkm", "address")}`);
  console.log("done — the migration dry run should now pass its drain guard.");
}

void main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
