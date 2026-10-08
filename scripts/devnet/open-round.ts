/**
 * Opens the next round on devnet (permissionless; admin pays here).
 *
 *   npx tsx scripts/devnet/open-round.ts
 */

import { OrbitJackpotClient, roundKey } from "@orbit-jackpot/sdk";
import { connection, loadAdmin, send } from "./common";

async function main(): Promise<void> {
  const client = new OrbitJackpotClient(connection);
  const admin = loadAdmin();
  const config = (await client.fetchConfig()) ?? null;
  if (config === null) throw new Error("not initialized — run init-config first");

  const active = await client.fetchRound(config.activeRoundId);
  if (active !== null && active.state === "open") {
    console.log(`round ${config.activeRoundId} is already open — nothing to do`);
    return;
  }
  // Fail-closed tail: present the unclosed active round when one exists.
  const previous =
    active !== null && config.activeRoundId !== 0n
      ? roundKey(config.activeRoundId)
      : active !== null
        ? roundKey(config.activeRoundId)
        : undefined;
  const nextId = config.nextRoundId;
  const tx = client.buildOpenRoundTx(admin.publicKey, nextId, previous);
  await send(tx, [admin], `open round ${nextId}`);
  console.log(`round ${nextId} open · window ${config.roundDurationSecs}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
