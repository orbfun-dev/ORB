/**
 * The ADR-11 economics cutover for the devnet deployment: retunes the
 * deployed v1 config (98/1/1 winner-take-all) to the v2 soft-jackpot
 * economics (9/89/1/1 + the capped 50/40/10 Mega split) via the one-way
 * `migrate_economics_v2` latch.
 *
 *   npx tsx scripts/devnet/migrate-economics-v2.ts            # print plan
 *   npx tsx scripts/devnet/migrate-economics-v2.ts --confirm  # send it
 *
 * Safety rails, in order — each refuses loudly instead of proceeding:
 *   1. the latch must still be open (`economics_version < 2`);
 *   2. the Mega-Pot must be DRAINED (`accrued_lamports == 0`) — retuning
 *      odds while the pot holds lamports contributed under the old odds
 *      is the exact rug ADR-10 exists to prevent. The script says how to
 *      drain it (settle a triggered round or let the sweep run) instead
 *      of overriding; `--confirm` never bypasses this;
 *   3. no round in flight (`active_round_id == next_round_id`);
 *   4. the I14 four-way sum and the I21 farm-guard arithmetic are printed
 *      and verified client-side before anything is signed.
 */

import {
  OrbitJackpotClient,
  splitMegaPot,
  splitRoundPot,
  type MigrateEconomicsV2ArgsData,
} from "@orbit-jackpot/sdk";
import { connection, explorer, loadAdmin, send } from "./common";

/** The canonical Phase 11 economics (design §3/§9, both decisions baked). */
export const V2_ARGS: MigrateEconomicsV2ArgsData = {
  winnerBps: 900,
  refundBps: 8_900,
  megaAwardBps: 5_000,
  megaFieldBps: 4_000,
  megaTriggerModulus: 625, // D2: ~1.3-day pops at 180 s rounds
  megaPayoutCapBps: 80_000, // 8× the round pot, 1.56× inside the I21 bound
  accountOpenFeeLamports: 10_000_000n, // D1: 0.01 SOL, once per wallet
};

const SOL = 1_000_000_000n;

async function main(): Promise<void> {
  const confirmed = process.argv.includes("--confirm");
  const client = new OrbitJackpotClient(connection);
  const admin = loadAdmin();

  const config = await client.fetchConfig();
  if (config === null) throw new Error("program not initialized — run init-config first");
  const megaPot = await client.fetchMegaPot();
  if (megaPot === null) throw new Error("mega-pot account missing");

  // ── the current state, plainly ──
  console.log("current config:");
  console.log(`  admin              ${config.admin}`);
  console.log(`  economics_version  ${config.economicsVersion}`);
  console.log(`  split              ${config.winnerBps}/${config.refundBps}/${config.feeBpsAdmin}/${config.feeBpsMega} bps (w/r/a/m)`);
  console.log(`  mega               award ${config.megaAwardBps} / field ${config.megaFieldBps} / 1-in-${config.megaTriggerModulus} / cap ${config.megaPayoutCapBps}`);
  console.log(`  account fee        ${config.accountOpenFeeLamports} lamports`);
  console.log(`  rounds             active ${config.activeRoundId} / next ${config.nextRoundId}`);
  console.log(`  mega-pot accrued   ${megaPot.accruedLamports} lamports`);

  // ── the proposed state, plainly ──
  console.log("\nproposed config (v2 soft-jackpot):");
  console.log(`  split              ${V2_ARGS.winnerBps}/${V2_ARGS.refundBps}/${config.feeBpsAdmin}/${config.feeBpsMega} bps (w/r/a/m)`);
  console.log(`  mega               award ${V2_ARGS.megaAwardBps} / field ${V2_ARGS.megaFieldBps} / 1-in-${V2_ARGS.megaTriggerModulus} / cap ${V2_ARGS.megaPayoutCapBps}`);
  console.log(`  account fee        ${V2_ARGS.accountOpenFeeLamports} lamports (once per wallet)`);

  // ── client-side arithmetic: I14 (four-way) and I21 (farm guard) ──
  const i14 = V2_ARGS.winnerBps + V2_ARGS.refundBps + config.feeBpsAdmin + config.feeBpsMega;
  console.log(`\nI14  ${V2_ARGS.winnerBps} + ${V2_ARGS.refundBps} + ${config.feeBpsAdmin} + ${config.feeBpsMega} = ${i14} (must be 10_000)`);
  if (i14 !== 10_000) throw new Error("I14 violated — refusing");
  const g = V2_ARGS.megaAwardBps + V2_ARGS.megaFieldBps;
  if (g > 10_000) throw new Error("mega bps exceed the denominator — refusing");
  const i21Bound = V2_ARGS.megaTriggerModulus * (config.feeBpsAdmin + config.feeBpsMega);
  console.log(`I21  cap ${V2_ARGS.megaPayoutCapBps} ≤ ${V2_ARGS.megaTriggerModulus} × ${config.feeBpsAdmin + config.feeBpsMega} = ${i21Bound}`);
  if (V2_ARGS.megaPayoutCapBps > i21Bound) throw new Error("I21 violated — the pop would be farmable — refusing");

  // Worked example on a 10 SOL pot, both splits, so the operator sees the
  // economics they are signing.
  const pot = 10n * SOL;
  const split = splitRoundPot(pot, V2_ARGS.winnerBps, config.feeBpsAdmin, config.feeBpsMega);
  console.log(`\nworked example (10 SOL pot): winner ${split.winnerPayout} · refunds ${split.refundPool} · admin ${split.adminCut} · mega ${split.megaCut}`);
  const pop = splitMegaPot(50n * SOL, pot, V2_ARGS.megaAwardBps, V2_ARGS.megaFieldBps, V2_ARGS.megaPayoutCapBps);
  console.log(`worked example (50 SOL pop):  winner ${pop.awarded} · field ${pop.fieldPool} · retained ${pop.retained}`);

  // ── the guards ──
  if (config.economicsVersion >= 2) {
    throw new Error("economics_version already 2 — the latch is closed forever (no override exists)");
  }
  if (megaPot.accruedLamports > 0n) {
    throw new Error(
      `mega-pot holds ${megaPot.accruedLamports} lamports — drain it first: settle a triggered ` +
        `round (let the keeper pop it) or wait out the claim deadline so sweep_unclaimed_prize ` +
        `reroutes the prize, then re-run. Refusing regardless of --confirm.`,
    );
  }
  if (config.activeRoundId !== config.nextRoundId) {
    throw new Error(
      `round ${config.activeRoundId} is still in flight (next ${config.nextRoundId}) — let every ` +
        `round reach a terminal state and close before the cutover`,
    );
  }
  if (config.admin !== admin.publicKey.toBase58()) {
    throw new Error(`admin mismatch: config ${config.admin} ≠ signer ${admin.publicKey.toBase58()}`);
  }

  if (!confirmed) {
    console.log("\ndry run — all guards passed. Re-run with --confirm to send the migration.");
    return;
  }

  console.log("\nsending migrate_economics_v2…");
  const tx = client.buildMigrateEconomicsV2Tx(admin.publicKey, V2_ARGS);
  await send(tx, [admin], "migrate_economics_v2");

  const after = (await client.fetchConfig())!;
  console.log(`\neconomics_version  ${after.economicsVersion}`);
  console.log(`  winner/refund     ${after.winnerBps}/${after.refundBps}`);
  console.log(`  mega              ${after.megaAwardBps}/${after.megaFieldBps} · 1-in-${after.megaTriggerModulus} · cap ${after.megaPayoutCapBps}`);
  console.log(`  account fee       ${after.accountOpenFeeLamports}`);
  if (after.economicsVersion !== 2) throw new Error("latch did not close — investigate");
  console.log(`\nconfig: ${explorer("5uRityZDTa2a5LN8wcQjLfc1TuAwyHbfALcVUHn7T56m", "address")}`);
  console.log("done — the next round opens under v2 economics.");
}

void main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
