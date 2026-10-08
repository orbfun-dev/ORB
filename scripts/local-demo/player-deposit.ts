/**
 * Deposits `SOL` (default 0.5) from the demo-player keypair into the
 * active open round — the exact SDK path the UI's useDeposit hook runs
 * (fresh index, buildDepositTx, sign, confirm). Useful for demonstrating
 * the wheel appending a slice live without a browser wallet.
 *
 * Usage: npm run demo:player-deposit [-- <sol>]
 */

import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { OrbitJackpotClient } from "@orbit-jackpot/sdk";
import { connection, fundWallet, loadOrGenerateKeypair, send } from "./common";

async function main(): Promise<void> {
  const sol = Number(process.argv[2] ?? 0.5);
  const client = new OrbitJackpotClient(connection);
  const player = loadOrGenerateKeypair("demo-player");
  await fundWallet(player.publicKey, sol + 2);

  const config = await client.fetchConfig();
  if (config === null) throw new Error("program not initialized");
  const round = await client.fetchRound(config.activeRoundId);
  if (round === null || round.state !== "open") {
    throw new Error(`active round is ${round?.state ?? "missing"} — deposits need Open`);
  }

  const before = await connection.getBalance(player.publicKey, "confirmed");
  const index = await client.nextEntryIndex(round.roundId);
  const tx = await client.buildDepositTx(
    player.publicKey,
    round.roundId,
    BigInt(Math.round(sol * LAMPORTS_PER_SOL)),
    index,
  );
  await send(tx, [player]);
  const after = await connection.getBalance(player.publicKey, "confirmed");

  console.log(`demo player ${player.publicKey.toBase58()}`);
  console.log(`deposited ${sol} SOL as entry #${index}`);
  console.log(`balance ${before / LAMPORTS_PER_SOL} → ${after / LAMPORTS_PER_SOL} SOL (−${(before - after) / LAMPORTS_PER_SOL})`);
}

main().catch((err) => {
  console.error("player deposit failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
