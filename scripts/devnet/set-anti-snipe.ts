/**
 * Devnet ops: turn the anti-snipe timer off (or back on) via
 * `update_config`.
 *
 *   npx tsx scripts/devnet/set-anti-snipe.ts off        # disable
 *   npx tsx scripts/devnet/set-anti-snipe.ts 10 10      # window 10s, extension 10s
 *
 * "Off" is `anti_snipe_window_secs = 0`. `apply_anti_snipe_extension`
 * (deposit.rs:313) returns early whenever `remaining >= window_secs`, and
 * inside the deposit path `remaining` is always positive — the window roll
 * has already revived an expired round by then — so a zero window makes
 * the branch unreachable and `end_ts` is never rewritten. The extension is
 * zeroed alongside it so the stored config reads as deliberately off
 * rather than as a live mechanism with a degenerate bound.
 *
 * Nothing on-chain constrains these fields (update_config.rs validates the
 * reveal deadline, the duration pair, the oracle queue, the tip and fee
 * ceilings, and the auto-deposit window — never anti-snipe), so this is
 * purely a product lever and fully reversible.
 *
 * `max_round_duration_secs` is deliberately left alone: it is the ceiling
 * the extension would have been clamped to, and with the mechanism off it
 * binds nothing. The on-chain `max >= round_duration` invariant keeps
 * holding either way.
 */

import { Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  OrbitJackpotClient,
  configKey,
  INSTRUCTION_DISCRIMINATORS,
  PROGRAM_ID,
} from "@orbit-jackpot/sdk";
import { connection, explorer, loadAdmin, send } from "./common";

/**
 * `UpdateConfigArgs` is fifteen borsh Options in declaration order
 * (update_config.rs:22-50). Anti-snipe is fields 4 and 5, so the payload
 * is three leading `None` tags, two `Some(i64)`, then ten trailing `None`.
 */
function encodeArgs(windowSecs: bigint, extensionSecs: bigint): Buffer {
  const args = Buffer.alloc(3 + 9 + 9 + 11, 0); // +1: trailing oracle_provider None
  let off = 3; // max_entries_per_round, round_duration, max_round_duration
  args[off] = 1;
  off += 1;
  args.writeBigInt64LE(windowSecs, off);
  off += 8;
  args[off] = 1;
  off += 1;
  args.writeBigInt64LE(extensionSecs, off);
  // the ten trailing Options stay 0x00 = None
  return args;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "off";
  let windowSecs: bigint;
  let extensionSecs: bigint;
  if (mode === "off") {
    windowSecs = 0n;
    extensionSecs = 0n;
  } else {
    if (!/^\d+$/.test(mode)) {
      throw new Error(`usage: set-anti-snipe [windowSecs extensionSecs] | off — got "${mode}"`);
    }
    windowSecs = BigInt(mode);
    extensionSecs = BigInt(process.argv[3] ?? mode);
    if (windowSecs <= 0n) {
      throw new Error("a positive window is required to enable; use `off` to disable");
    }
  }

  const admin = loadAdmin();
  const client = new OrbitJackpotClient(connection);
  const before = await client.fetchConfig();
  if (before === null) throw new Error("config not initialized — run init-config first");
  if (before.admin !== admin.publicKey.toBase58()) {
    throw new Error(`admin mismatch: config ${before.admin} ≠ signer ${admin.publicKey.toBase58()}`);
  }
  console.log(
    `before: window=${before.antiSnipeWindowSecs}s extension=${before.antiSnipeExtensionSecs}s ` +
      `min=${before.antiSnipeMinDepositLamports} (round ${before.roundDurationSecs}s, cap ${before.maxRoundDurationSecs}s)`,
  );

  if (
    before.antiSnipeWindowSecs === windowSecs &&
    before.antiSnipeExtensionSecs === extensionSecs
  ) {
    console.log("already at the requested state — nothing to send");
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
        encodeArgs(windowSecs, extensionSecs),
      ]),
    }),
  );
  await send(tx, [admin], `update_config anti-snipe ${mode}`);

  const after = await client.fetchConfig();
  console.log(
    `after:  window=${after!.antiSnipeWindowSecs}s extension=${after!.antiSnipeExtensionSecs}s`,
  );
  if (
    after!.antiSnipeWindowSecs !== windowSecs ||
    after!.antiSnipeExtensionSecs !== extensionSecs
  ) {
    throw new Error("update did not land as requested — investigate");
  }
  console.log(
    windowSecs === 0n
      ? "anti-snipe is OFF — end_ts is now fixed at open and never extends"
      : `anti-snipe armed: a deposit ≥ ${after!.antiSnipeMinDepositLamports} lamports inside the last ${windowSecs}s resets the end to now + ${extensionSecs}s`,
  );
  console.log(`config: ${explorer(configKey().toBase58(), "address")}`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
