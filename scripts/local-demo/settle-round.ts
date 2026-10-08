/**
 * Settles the demo round (roadmap 7.5): waits out the deposit window on
 * the REAL chain clock, then runs the permissionless crank sequence
 * `lock_round → request_randomness → fulfill_settle` against the
 * genesis-preloaded mock randomness account, and prints the settled
 * outcome re-derived from chain state (the script never decides anything).
 */

import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  findWinningEntry,
  OrbitJackpotClient,
} from "@orbit-jackpot/sdk";
import {
  connection,
  DEMO_RANDOMNESS_ID,
  fundWallet,
  loadOrGenerateKeypair,
  send,
} from "./common";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function chainNowSec(): Promise<number> {
  const epoch = await connection.getEpochInfo();
  const t = await connection.getBlockTime(epoch.absoluteSlot);
  return t ?? Math.floor(Date.now() / 1000);
}

async function main(): Promise<void> {
  const client = new OrbitJackpotClient(connection);
  const crank = loadOrGenerateKeypair("crank");
  await fundWallet(crank.publicKey, 5);

  const config = await client.fetchConfig();
  if (config === null) throw new Error("program not initialized — run npm run demo:seed first");
  const round = await client.fetchRound(config.activeRoundId);
  if (round === null) throw new Error("no active round");
  const roundId = round.roundId;
  console.log(`round ${roundId} · state ${round.state} · pot ${Number(round.totalLamports) / LAMPORTS_PER_SOL} SOL`);

  if (round.state === "open") {
    // Wait out the window on the chain clock (block time, not local time).
    for (;;) {
      const now = await chainNowSec();
      const end = Number(round.endTs);
      if (now >= end) break;
      const wait = Math.max(1, end - now);
      console.log(`deposit window: ${wait}s left (chain clock)…`);
      await sleep(Math.min(wait, 5) * 1000);
    }
    console.log("locking round…");
    await send(client.buildLockRoundTx(roundId, crank.publicKey), [crank]);
  }

  let current = (await client.fetchRound(roundId))!;
  if (current.state === "locked") {
    console.log("pinning randomness (request_randomness)…");
    await send(
      client.buildRequestRandomnessTx(roundId, DEMO_RANDOMNESS_ID, crank.publicKey),
      [crank],
    );
    current = (await client.fetchRound(roundId))!;
  }
  if (current.state !== "awaitingRandomness") {
    throw new Error(`unexpected state ${current.state} before settle`);
  }

  console.log("settling (fulfill_settle)…");
  await send(client.buildFulfillSettleTx(roundId, DEMO_RANDOMNESS_ID, crank.publicKey), [crank]);

  const settled = (await client.fetchRound(roundId))!;
  const book = await client.fetchEntries(roundId);
  const winner = findWinningEntry(book, settled.winningTicket);
  const mega = await client.fetchMegaPot();

  console.log("\n── settled on-chain ──");
  console.log(`winning ticket : ${settled.winningTicket} / ${settled.totalLamports}`);
  console.log(
    `winner entry   : #${winner?.entryIndex} (${winner?.player.slice(0, 8)}…) · ${
      winner ? (Number(winner.amountLamports) / LAMPORTS_PER_SOL).toFixed(2) : "?"
    } SOL staked`,
  );
  console.log(
    `payout         : ${Number(settled.winnerPayout) / LAMPORTS_PER_SOL} SOL (of ${Number(settled.totalLamports) / LAMPORTS_PER_SOL})`,
  );
  console.log(`mega triggered : ${settled.megaTriggered} · awarded ${Number(settled.megaAwarded) / LAMPORTS_PER_SOL} SOL`);
  console.log(`mega-pot now   : ${Number(mega?.accruedLamports ?? 0n) / LAMPORTS_PER_SOL} SOL`);

  if (winner === null) throw new Error("settled round has no findable winner — book corrupt?");
  if (settled.megaTriggered) {
    console.log("\nthe wheel should now be celebrating — check the browser.");
  }
}

main().catch((err) => {
  console.error("settle failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
