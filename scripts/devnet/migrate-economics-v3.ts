/**
 * Devnet ops: one-way latch to economics v3 — the winner's own stake is
 * never raked (programs/orbit_jackpot/src/math/split.rs
 * `split_round_pot_v3`).
 *
 *   npx tsx scripts/devnet/migrate-economics-v3.ts
 *
 * ORDER MATTERS: from v3 on, `fulfill_settle` requires the winning entry,
 * so the crank that sends it must be live BEFORE this runs (a v2-era
 * crank would fail every settlement with WinningEntryRequired). No bps
 * change; safe with rounds in flight.
 */

import { OrbitJackpotClient, configKey } from "@orbit-jackpot/sdk";
import { Transaction, TransactionInstruction } from "@solana/web3.js";
import { connection, loadAdmin, send } from "./common";

async function main(): Promise<void> {
  const admin = loadAdmin();
  const client = new OrbitJackpotClient(connection);
  const before = await client.fetchConfig();
  if (before === null) throw new Error("config not initialized");
  if (before.admin !== admin.publicKey.toBase58()) {
    throw new Error(`admin mismatch: config ${before.admin} ≠ signer ${admin.publicKey.toBase58()}`);
  }
  console.log(`before: economics_version=${before.economicsVersion}`);
  if (before.economicsVersion >= 3) {
    console.log("already v3 — nothing to send");
    return;
  }
  // Built by hand (sha256("global:migrate_economics_v3")[..8]) so this
  // script does not depend on which SDK build the workspace resolves.
  const tx = new Transaction().add(
    new TransactionInstruction({
      programId: client.programId,
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: true },
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from("016c4d3451e5d242", "hex"),
    }),
  );
  await send(tx, [admin], "migrate_economics_v3");
  const after = await client.fetchConfig();
  console.log(`after:  economics_version=${after!.economicsVersion}`);
  if (after!.economicsVersion !== 3) throw new Error("latch did not land — investigate");
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
