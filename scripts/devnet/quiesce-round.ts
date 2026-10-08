/**
 * Drives the active round to a closed terminal state so the protocol is
 * quiescent (`active_round_id == next_round_id`) — the precondition both
 * the preflight drain and the economics migration enforce. Meant for the
 * cutover window with the keeper STOPPED: it will not settle rounds.
 *
 * Empty round:  lock_round auto-cancels (zero deposits), close_round
 *               reclaims the rents to the admin.
 * Settled round with no open entries: closes directly.
 * Anything else (entries in play, randomness in flight): refuses loudly —
 * finish those rounds with the keeper or `npm run devnet:settle` first.
 *
 *   npx tsx scripts/devnet/quiesce-round.ts
 */

import { OrbitJackpotClient, type RoundData } from "@orbit-jackpot/sdk";
import { PublicKey } from "@solana/web3.js";
import { connection, loadAdmin, send, sleep } from "./common";

async function main(): Promise<void> {
  const client = new OrbitJackpotClient(connection);
  const admin = loadAdmin();
  let config = await client.fetchConfig();
  if (config === null) throw new Error("program not initialized");

  if (config.activeRoundId === config.nextRoundId) {
    console.log(`already quiescent: active ${config.activeRoundId} == next ${config.nextRoundId}`);
    return;
  }
  const roundId = config.activeRoundId;
  let round: RoundData | null = await client.fetchRound(roundId);
  if (round === null) throw new Error(`round ${roundId} is active but its account is missing`);

  if (round.state === "open") {
    // Wait out the deposit window on the CHAIN clock (anti-snipe may have
    // extended end_ts; with the keeper stopped nothing extends it further).
    console.log(`round ${roundId} open — waiting out the deposit window (end_ts ${round.endTs})…`);
    for (let i = 0; i < 90; i += 1) {
      const slot = await connection.getEpochInfo();
      const now = (await connection.getBlockTime(slot.absoluteSlot)) ?? 0;
      if (now >= Number(round.endTs)) break;
      await sleep(2_000);
      round = (await client.fetchRound(roundId))!;
    }
    if (round.state !== "open") {
      console.log(`round ${roundId} left Open on its own (state ${round.state})`);
    } else if (round.entryCount > 0n) {
      throw new Error(
        `round ${roundId} holds ${round.entryCount} entries — lock would go to randomness, ` +
          `not cancel. Finish it with the keeper or npm run devnet:settle, then re-run.`,
      );
    } else {
      console.log(`locking empty round ${roundId} (auto-cancels at lock)…`);
      await send(client.buildLockRoundTx(roundId, admin.publicKey), [admin], `lock_round ${roundId}`);
      round = (await client.fetchRound(roundId))!;
    }
  }

  if (round.state === "locked" || round.state === "awaitingRandomness") {
    throw new Error(
      `round ${roundId} is ${round.state} — needs the randomness pipeline ` +
        `(npm run devnet:settle); refusing to touch it here`,
    );
  }
  if (round.state === "settled" && round.entriesClosed !== round.entryCount) {
    throw new Error(
      `round ${roundId} is Settled with ${round.entryCount - round.entriesClosed} entries ` +
        `unclosed — close them (close_entry) first`,
    );
  }
  if (round.state !== "cancelled" && round.state !== "settled") {
    throw new Error(`round ${roundId} in unexpected state ${round.state}`);
  }

  console.log(`closing ${round.state} round ${roundId} (rents → admin)…`);
  const destination = new PublicKey(config.admin);
  await send(client.buildCloseRoundTx(roundId, destination, admin.publicKey), [admin], `close_round ${roundId}`);

  config = (await client.fetchConfig())!;
  console.log(`\nactive ${config.activeRoundId} / next ${config.nextRoundId}`);
  if (config.activeRoundId !== config.nextRoundId) {
    throw new Error("still not quiescent — run me again (older rounds may remain)");
  }
  console.log("quiescent — the drain and migration guards can pass now.");
}

void main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
