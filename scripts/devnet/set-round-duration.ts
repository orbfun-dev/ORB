/**
 * Devnet ops tourniquet (Phase 12 §3): raise `round_duration_secs` via
 * `update_config` to cut the idle rent burn while the real fix (the
 * empty-round window roll) ships. An empty 120 s cycle costs
 * 4 128 360 lamports (Round rent 2 992 800 + RoundVault rent 1 120 560 +
 * 3 × 5 000 base fees); stretching the cycle to 900 s divides the burn by
 * 7.5 (0.1239 → 0.0165 SOL/hour). This is NOT the fix — revert to the
 * product-correct duration once Phase 12 is deployed.
 *
 *   npx tsx scripts/devnet/set-round-duration.ts 900
 *
 * `max_round_duration_secs` is raised to max(current, 1800, new duration)
 * in the same call — the on-chain guard `max >= round_duration` must hold
 * and the anti-snipe ceiling should keep real headroom. Idempotent: prints
 * before/after and sends nothing when both fields are already effective.
 */

import { Transaction, TransactionInstruction } from "@solana/web3.js";
import { OrbitJackpotClient, configKey, INSTRUCTION_DISCRIMINATORS, PROGRAM_ID } from "@orbit-jackpot/sdk";
import { connection, explorer, loadAdmin, send } from "./common";

/** Per empty cycle: both rent-exemptions plus three 5 000-lamport base fees.
 * Rent at the devnet/mainnet rate (2 540 lamports/byte/year ⇒ 650 240
 * minimum per signature-exempt account): Round 302 B = 2 184 400,
 * RoundVault 33 B = 817 880 — NOT the 3 480-lamport test-genesis rate the
 * Rust battery's Rent sysvar reports. */
const EMPTY_CYCLE_LAMPORTS = 2_184_400n + 817_880n + 15_000n;
const LAMPORTS_PER_SOL = 1_000_000_000n;

function burnPerHour(durationSecs: bigint): string {
  const perHour = (EMPTY_CYCLE_LAMPORTS * 3_600n) / durationSecs;
  return `${perHour} lamports (~${Number(perHour) / Number(LAMPORTS_PER_SOL)} SOL)/hour`;
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(`usage: set-round-duration <secs> — got "${raw ?? ""}"`);
  }
  const duration = BigInt(raw);
  if (duration <= 0n) throw new Error(`duration must be positive — got ${duration}`);

  const admin = loadAdmin();
  const client = new OrbitJackpotClient(connection);
  const before = await client.fetchConfig();
  if (before === null) throw new Error("config not initialized — run init-config first");

  const maxRound = before.maxRoundDurationSecs > 1_800n ? before.maxRoundDurationSecs : 1_800n;
  const newMax = maxRound > duration ? maxRound : duration;

  console.log("before:");
  console.log(`  round_duration_secs    ${before.roundDurationSecs}`);
  console.log(`  max_round_duration_secs ${before.maxRoundDurationSecs}`);
  console.log(`  idle burn at ${before.roundDurationSecs}s cycles  ${burnPerHour(before.roundDurationSecs)}`);
  if (before.admin !== admin.publicKey.toBase58()) {
    throw new Error(`admin mismatch: config ${before.admin} ≠ signer ${admin.publicKey.toBase58()}`);
  }

  // The on-chain validation, mirrored: fail early with a clear message
  // instead of a chain error.
  if (before.autoDepositEnabled) {
    if (before.autoDepositWindowSecs <= 0n || before.autoDepositWindowSecs >= duration) {
      throw new Error(
        `refusing: auto-deposit window ${before.autoDepositWindowSecs}s must satisfy ` +
          `0 < window < round_duration (${duration}s) while the feature is enabled`,
      );
    }
  }

  console.log("\nafter (proposed):");
  console.log(`  round_duration_secs    ${duration}`);
  console.log(`  max_round_duration_secs ${newMax}`);
  console.log(`  idle burn at ${duration}s cycles  ${burnPerHour(duration)}`);

  if (before.roundDurationSecs === duration && before.maxRoundDurationSecs >= newMax) {
    console.log("\nalready at the requested state — nothing to send");
    return;
  }

  // borsh UpdateConfigArgs — fifteen options in declaration order
  // (update_config.rs, pinned against the generated IDL): max_entries as
  // `None`, round_duration and max_round_duration as `Some`, the remaining
  // twelve fields (anti-snipe … account_open_fee) as `None`.
  const args = Buffer.alloc(1 + 9 + 9 + 13, 0); // +1: trailing oracle_provider None
  let off = 0;
  args[off] = 0; off += 1; // max_entries_per_round: None
  args[off] = 1; off += 1;
  args.writeBigInt64LE(duration, off); off += 8;
  args[off] = 1; off += 1;
  args.writeBigInt64LE(newMax, off); off += 8;
  // bytes 19..31 stay 0x00 — the thirteen trailing `None` options.

  const tx = new Transaction().add(
    new TransactionInstruction({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: true },
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: Buffer.concat([
        Buffer.from(INSTRUCTION_DISCRIMINATORS.update_config!, "hex"),
        args,
      ]),
    }),
  );
  await send(tx, [admin], "update_config round-duration");

  const after = await client.fetchConfig();
  console.log("\nafter (on-chain):");
  console.log(`  round_duration_secs    ${after!.roundDurationSecs}`);
  console.log(`  max_round_duration_secs ${after!.maxRoundDurationSecs}`);
  if (after!.roundDurationSecs !== duration || after!.maxRoundDurationSecs < newMax) {
    throw new Error("update did not land as requested — investigate");
  }
  console.log(`config: ${explorer(configKey().toBase58(), "address")}`);
  console.log("tourniquet applied — remember to revert to the product duration after Phase 12 ships.");
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
