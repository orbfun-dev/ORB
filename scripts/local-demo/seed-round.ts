/**
 * Seeds the demo round (roadmap 7.5):
 *  1. initialize (if the config does not exist) with demo-safe parameters
 *     and the deterministic oracle pin matching the preloaded account;
 *  2. open round 0 (skipped if a round is already open);
 *  3. three scripted bot deposits (1.0 / 2.5 / 4.0 SOL) through the same
 *     `buildDepositTx` + fresh-index retry contract the UI uses;
 *  4. funds the demo-player keypair (10 SOL) for a wallet import.
 *
 * Idempotent: safe to re-run; existing state is left alone.
 */

import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { OrbitJackpotClient, roundKey } from "@orbit-jackpot/sdk";
import {
  BOT_DEPOSITS_SOL,
  DEMO_ORACLE_PROGRAM_ID,
  DEMO_ORACLE_QUEUE_ID,
  DEMO_ROUND_ID,
  connection,
  fundWallet,
  loadOrGenerateKeypair,
  send,
} from "./common";

const ROUND_SECS = Number(process.env.DEMO_ROUND_SECS ?? 45);

async function main(): Promise<void> {
  const client = new OrbitJackpotClient(connection);
  const admin = loadOrGenerateKeypair("admin");
  await fundWallet(admin.publicKey, 60);
  console.log(`admin: ${admin.publicKey.toBase58()}`);

  let config = await client.fetchConfig();
  if (config === null) {
    console.log("initializing program…");
    const treasury = loadOrGenerateKeypair("treasury");
    const tx = client.buildInitializeTx(admin.publicKey, {
      treasuryAuthority: treasury.publicKey,
      oracleProgramId: DEMO_ORACLE_PROGRAM_ID,
      oracleQueue: DEMO_ORACLE_QUEUE_ID,
      oracleProvider: "switchboard",
      maxEntriesPerRound: 0,
      roundDurationSecs: BigInt(ROUND_SECS),
      maxRoundDurationSecs: BigInt(ROUND_SECS + 600),
      antiSnipeWindowSecs: 30n,
      antiSnipeExtensionSecs: 15n,
      claimDeadlineSecs: 2_592_000n,
      minDepositLamports: 10_000_000n,
      antiSnipeMinDepositLamports: 100_000_000n,
      keeperTipLamports: 0n,
      randomnessRevealDeadlineSlots: 400n,
    });
    await send(tx, [admin]);
    config = (await client.fetchConfig())!;
    console.log(
      `initialized · round ${ROUND_SECS}s · min 0.01 SOL · oracle pin ${config.oracleProgramId}`,
    );
  } else {
    console.log(`program already initialized (round ${config.roundDurationSecs}s)`);
  }

  let round = await client.fetchRound(config.activeRoundId);
  if (round === null || round.state !== "open") {
    const nextId = config.nextRoundId;
    // Fail-closed tail account: the round at active_round_id must be
    // presented whenever one exists (active < next); the very first open
    // (active == next == 0) simply omits it.
    const previous =
      config.activeRoundId === config.nextRoundId
        ? undefined
        : roundKey(config.activeRoundId);
    console.log(`opening round ${nextId}…`);
    const tx = client.buildOpenRoundTx(admin.publicKey, nextId, previous);
    await send(tx, [admin]);
    round = (await client.fetchRound(nextId))!;
  } else {
    console.log(`round ${round.roundId} already open`);
  }
  if (round.roundId !== DEMO_ROUND_ID) {
    console.log(
      `note: active round is ${round.roundId}; the preloaded randomness fixture targets round ${DEMO_ROUND_ID} — run against a fresh validator for the scripted outcome.`,
    );
  }

  const entries = await client.fetchEntries(round.roundId);
  let seeded = entries.length;
  for (const sol of BOT_DEPOSITS_SOL) {
    if (seeded >= BOT_DEPOSITS_SOL.length) break;
    const bot = loadOrGenerateKeypair(`bot${seeded + 1}`);
    await fundWallet(bot.publicKey, sol + 2);
    const amount = BigInt(Math.round(sol * LAMPORTS_PER_SOL));
    // Same contract as the UI's useDeposit: fresh index per attempt, retry
    // only when the chain says the index verifiably moved.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const index = await client.nextEntryIndex(round.roundId);
      const tx = await client.buildDepositTx(bot.publicKey, round.roundId, amount, index);
      try {
        await send(tx, [bot]);
        console.log(`deposited ${sol.toFixed(1)} SOL from bot${seeded + 1} (${bot.publicKey.toBase58().slice(0, 8)}…)`);
        break;
      } catch (err) {
        const nowIndex = await client.nextEntryIndex(round.roundId).catch(() => index);
        if (nowIndex > index && attempt < 3) continue;
        throw err;
      }
    }
    seeded += 1;
  }

  const demoPlayer = loadOrGenerateKeypair("demo-player");
  await fundWallet(demoPlayer.publicKey, 10);
  console.log(`demo player (import into Phantom): scripts/local-demo/keys/demo-player.json`);
  console.log(`demo player address: ${demoPlayer.publicKey.toBase58()}`);

  const finalRound = (await client.fetchRound(round.roundId))!;
  const book = await client.fetchEntries(round.roundId);
  console.log(
    `\nround ${finalRound.roundId} live: pot ${Number(finalRound.totalLamports) / LAMPORTS_PER_SOL} SOL · ${book.length} entries`,
  );
  for (const e of book) {
    console.log(
      `  #${e.entryIndex} ${e.player.slice(0, 8)}… ${(Number(e.amountLamports) / LAMPORTS_PER_SOL).toFixed(2)} SOL  tickets [${e.ticketStart}, ${e.ticketEnd})`,
    );
  }
  console.log(`\nnext: open http://localhost:5173/ (no ?fixture) — then 'npm run demo:settle'`);
}

main().catch((err) => {
  console.error("seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
