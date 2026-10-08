/**
 * Devnet ops: set the SETTLE keeper tip (`keeper_tip_lamports`) via
 * `update_config`.
 *
 *   npx tsx scripts/devnet/set-keeper-tip.ts 100000
 *
 * The tip is paid to whoever sends `fulfill_settle`, OUT OF the 1% admin
 * cut (`split_admin_cut`): tip = min(keeper_tip, admin_cut), and the
 * treasury keeps the rest. At 1 000 000 lamports it swallowed the whole
 * admin cut of every pot under 0.1 SOL. With the Switchboard rent
 * reclaimed (Phase 13 close_randomness), a settled round costs the keeper
 * only transaction fees (~70 000 lamports), so the tip only has to cover
 * those. Not to be confused with `auto_deposit_tip_lamports`, which
 * escrows pay per auto-deposit.
 *
 * Fully reversible; nothing on-chain bounds this field.
 */

import { Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  OrbitJackpotClient,
  configKey,
  INSTRUCTION_DISCRIMINATORS,
  PROGRAM_ID,
} from "@orbit-jackpot/sdk";
import { connection, loadAdmin, send } from "./common";

/**
 * `UpdateConfigArgs` is fifteen borsh Options in declaration order
 * (update_config.rs). `keeper_tip_lamports` is field 9: eight leading
 * `None` tags, one `Some(u64)`, six trailing `None`.
 */
export function encodeKeeperTipArgs(tip: bigint): Buffer {
  const args = Buffer.alloc(8 + 9 + 7, 0); // +1: trailing oracle_provider None
  args[8] = 1;
  args.writeBigUInt64LE(tip, 9);
  return args;
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error("usage: set-keeper-tip <lamports>");
  }
  const tip = BigInt(raw);

  const admin = loadAdmin();
  const client = new OrbitJackpotClient(connection);
  const before = await client.fetchConfig();
  if (before === null) throw new Error("config not initialized");
  if (before.admin !== admin.publicKey.toBase58()) {
    throw new Error(`admin mismatch: config ${before.admin} ≠ signer ${admin.publicKey.toBase58()}`);
  }
  console.log(`before: keeper_tip=${before.keeperTipLamports} auto_deposit_tip=${before.autoDepositTipLamports}`);
  if (before.keeperTipLamports === tip) {
    console.log("already at the requested tip — nothing to send");
    return;
  }

  const tx = new Transaction().add(
    new TransactionInstruction({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: true },
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: Buffer.concat([
        Buffer.from(INSTRUCTION_DISCRIMINATORS.update_config!, "hex"),
        encodeKeeperTipArgs(tip),
      ]),
    }),
  );
  await send(tx, [admin], `update_config keeper_tip ${tip}`);

  const after = await client.fetchConfig();
  console.log(`after:  keeper_tip=${after!.keeperTipLamports} auto_deposit_tip=${after!.autoDepositTipLamports}`);
  // Belt: every other field must be untouched.
  const unchanged = (Object.keys(before) as Array<keyof typeof before>).filter(
    (k) => k !== "keeperTipLamports" && String(before[k]) !== String(after![k]),
  );
  if (after!.keeperTipLamports !== tip || unchanged.length > 0) {
    throw new Error(`update did not land as requested — changed: ${unchanged.join(", ") || "tip mismatch"}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
