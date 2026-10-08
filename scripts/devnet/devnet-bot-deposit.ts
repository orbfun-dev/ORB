/**
 * Seeds 3 bot deposits on the open devnet round — real ticket ranges from
 * distinct wallets, funded from the admin wallet (airdrop is rate-limited).
 *
 *   npx tsx scripts/devnet/devnet-bot-deposit.ts
 */

import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { OrbitJackpotClient } from "@orbit-jackpot/sdk";
import {
  connection,
  fundFromAdmin,
  loadAdmin,
  loadOrGenerateKeypair,
  send,
  sleep,
  withRetry,
} from "./common";

export const BOT_DEPOSITS_SOL = [0.1, 0.25, 0.4];

async function main(): Promise<void> {
  const client = new OrbitJackpotClient(connection);
  const admin = loadAdmin();
  const config = (await client.fetchConfig()) ?? null;
  if (config === null) throw new Error("not initialized — run init-config first");
  const roundId = config.activeRoundId;
  const round = await client.fetchRound(roundId);
  if (round === null || round.state !== "open") {
    throw new Error(`round ${roundId} is not open — run open-round first`);
  }

  for (let i = 0; i < BOT_DEPOSITS_SOL.length; i += 1) {
    const bot = loadOrGenerateKeypair(`bot${i}`);
    await fundFromAdmin(admin, bot.publicKey, 1);
    const amount = BigInt(Math.round(BOT_DEPOSITS_SOL[i]! * LAMPORTS_PER_SOL));
    // Contention retry: rebuild with a fresh index only when the chain's
    // counter verifiably moved (same discipline as useDeposit).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const index = await withRetry(() => client.nextEntryIndex(roundId), "nextEntryIndex");
      try {
        await send(
          await client.buildDepositTx(bot.publicKey, roundId, amount, index),
          [bot],
          `bot${i} deposit ${BOT_DEPOSITS_SOL[i]} SOL (entry ${index})`,
        );
        break;
      } catch (err) {
        const moved = await withRetry(() => client.nextEntryIndex(roundId), "nextEntryIndex");
        if (attempt === 2 || moved <= index) throw err;
        console.log(`  contention (used ${index}, chain at ${moved}) — retrying`);
      }
    }
    await sleep(600);
  }

  const after = await client.fetchRound(roundId);
  console.log(
    `round ${roundId}: ${after?.entryCount} entries · pot ${Number(after?.totalLamports ?? 0n) / LAMPORTS_PER_SOL} SOL`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
