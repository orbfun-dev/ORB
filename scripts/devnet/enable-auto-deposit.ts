/**
 * Devnet ops: enable (or disable) the auto-deposit feature via
 * `update_config` — the design §7 step-4 lever and the ROLLBACK path
 * (disabling leaves every escrow funded and withdrawable; §3.5 is not
 * gated on the flag).
 *
 * Idempotent: prints the before/after config fields and only sends when
 * something actually changes. Refuses to enable with a window that is not
 * strictly inside the round duration (the on-chain validation, mirrored).
 *
 *   npx tsx scripts/devnet/enable-auto-deposit.ts            # window 20s, tip 200_000, enable
 *   npx tsx scripts/devnet/enable-auto-deposit.ts 15 500000  # explicit window/tip
 *   npx tsx scripts/devnet/enable-auto-deposit.ts off        # rollback: disable
 */

import { Transaction, TransactionInstruction } from "@solana/web3.js";
import { OrbitJackpotClient, configKey, INSTRUCTION_DISCRIMINATORS, PROGRAM_ID } from "@orbit-jackpot/sdk";
import { connection, explorer, loadAdmin, send } from "./common";

const DEFAULT_WINDOW_SECS = 20n;
const DEFAULT_TIP_LAMPORTS = 200_000n;

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "on";
  const admin = loadAdmin();
  const client = new OrbitJackpotClient(connection);

  const before = await client.fetchConfig();
  if (before === null) throw new Error("config not initialized — run init-config first");
  console.log(
    `before: window=${before.autoDepositWindowSecs}s tip=${before.autoDepositTipLamports} enabled=${before.autoDepositEnabled}`,
  );

  let windowSecs: bigint;
  let tipLamports: bigint;
  let enabled: boolean;
  if (mode === "off") {
    windowSecs = before.autoDepositWindowSecs;
    tipLamports = before.autoDepositTipLamports;
    enabled = false;
  } else {
    if (!/^\d+$/.test(mode)) {
      throw new Error(`usage: enable-auto-deposit [windowSecs] [tipLamports] | off — got "${mode}"`);
    }
    windowSecs = BigInt(mode);
    tipLamports = BigInt(process.argv[3] ?? DEFAULT_TIP_LAMPORTS);
    enabled = true;
    if (tipLamports > 1_000_000n) {
      throw new Error(`refusing: tip ${tipLamports} exceeds MAX_AUTO_DEPOSIT_TIP_LAMPORTS (1_000_000)`);
    }
    // The on-chain validation, mirrored: fail early with a clear message
    // instead of a chain error.
    if (windowSecs <= 0n || windowSecs >= before.roundDurationSecs) {
      throw new Error(
        `refusing: window ${windowSecs}s must satisfy 0 < window < round_duration (${before.roundDurationSecs}s)`,
      );
    }
  }

  if (
    before.autoDepositWindowSecs === windowSecs &&
    before.autoDepositTipLamports === tipLamports &&
    before.autoDepositEnabled === enabled
  ) {
    console.log("already at the requested state — nothing to send");
    return;
  }

  // borsh UpdateConfigArgs — fifteen options in declaration order
  // (update_config.rs, pinned against the generated IDL): the first eleven
  // as `None` (1-byte tag each), then the three Phase 10 fields as `Some`,
  // then Phase 11's trailing `account_open_fee_lamports` as `None`. (The
  // committed version wrote twelve leading `None` tags and omitted the
  // trailing one — off by one against the 15-field struct, it would have
  // misparsed the window bytes as the tip and failed on-chain.)
  const args = Buffer.alloc(11 + 9 + 9 + 2 + 2, 0); // +1: trailing oracle_provider None
  let off = 11;
  args[off] = 1; off += 1;
  args.writeBigInt64LE(windowSecs, off); off += 8;
  args[off] = 1; off += 1;
  args.writeBigUInt64LE(tipLamports, off); off += 8;
  args[off] = 1; off += 1;
  args[off] = enabled ? 1 : 0; off += 1;
  args[off] = 0; // account_open_fee_lamports: None

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
  await send(tx, [admin], "update_config auto-deposit");

  const after = await client.fetchConfig();
  console.log(
    `after:  window=${after!.autoDepositWindowSecs}s tip=${after!.autoDepositTipLamports} enabled=${after!.autoDepositEnabled}`,
  );
  console.log(`config: ${explorer(configKey().toBase58(), "address")}`);
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", event: "enable_auto_deposit_error", err: String(err) }));
  process.exit(1);
});
