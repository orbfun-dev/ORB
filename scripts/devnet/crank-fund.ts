/**
 * Funds the crank keeper wallet from the vaulted admin (the devnet
 * airdrop is rate-limited; the admin is this deployment's faucet).
 *
 *   npx tsx scripts/devnet/crank-fund.ts [SOL] [TARGET_PUBKEY]
 *
 * Without TARGET_PUBKEY: load-or-generate the durable keeper at
 * scripts/devnet/keys/keeper.json and fund THAT (this is the keeper the
 * local live run uses). With TARGET_PUBKEY: a plain transfer — use it to
 * fund a keeper generated on the droplet.
 */

import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { connection, loadAdmin, loadOrGenerateKeypair, send, withRetry } from "./common";

async function main(): Promise<void> {
  const sol = Number(process.argv[2] ?? "2");
  if (!Number.isFinite(sol) || sol <= 0 || sol > 100) {
    throw new Error("SOL must be a positive number ≤ 100");
  }
  const admin = loadAdmin();
  const target = process.argv[3];

  let recipient: PublicKey;
  if (target === undefined) {
    const keeper = loadOrGenerateKeypair("keeper");
    recipient = keeper.publicKey;
    console.log(`keeper wallet: ${recipient.toBase58()} (scripts/devnet/keys/keeper.json)`);
  } else {
    recipient = new PublicKey(target);
    console.log(`funding external keeper: ${recipient.toBase58()}`);
  }

  const want = BigInt(Math.round(sol * LAMPORTS_PER_SOL));
  const balance = await withRetry(
    () => connection.getBalance(recipient, "confirmed"),
    "getBalance",
  );
  if (balance >= want) {
    console.log(`already funded: ${Number(balance) / LAMPORTS_PER_SOL} SOL`);
    return;
  }
  const adminBalance = await withRetry(
    () => connection.getBalance(admin.publicKey, "confirmed"),
    "adminBalance",
  );
  console.log(`admin holds ${Number(adminBalance) / LAMPORTS_PER_SOL} SOL`);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: admin.publicKey,
      toPubkey: recipient,
      lamports: want - BigInt(balance),
    }),
  );
  await send(tx, [admin], `fund keeper ${recipient.toBase58().slice(0, 8)}…`);
  console.log(`keeper now holds ${sol} SOL`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
