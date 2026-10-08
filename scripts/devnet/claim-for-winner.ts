/**
 * Claim a round's prize for its winner (I13). Two modes:
 *   npx tsx scripts/devnet/claim-for-winner.ts <roundId> <entryIndex> <playerPubkey>
 *     — admin-driven: replaces the builder's authority meta (the player)
 *       with the admin signer; any wallet can crank the claim.
 *   WINNER_KEYPAIR=<name> … — the winner signs their own claim using
 *     scripts/devnet/keys/<name>.json (the wallet-native path).
 */

import { OrbitJackpotClient } from "@orbit-jackpot/sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import { connection, loadAdmin, loadOrGenerateKeypair, send } from "./common";

async function main(): Promise<void> {
  const [roundId, entryIndex, player] = process.argv.slice(2) as [string, string, string];
  if (roundId === undefined || entryIndex === undefined || player === undefined) {
    throw new Error("usage: claim-for-winner.ts <roundId> <entryIndex> <playerPubkey>");
  }
  const client = new OrbitJackpotClient(connection);
  const tx = client.buildClaimTx(new PublicKey(player), BigInt(roundId), Number(entryIndex));

  if (process.env.WINNER_KEYPAIR !== undefined) {
    const winner: Keypair = loadOrGenerateKeypair(process.env.WINNER_KEYPAIR);
    if (!winner.publicKey.equals(new PublicKey(player))) {
      throw new Error(`keypair ${winner.publicKey} is not the round winner ${player}`);
    }
    await send(tx, [winner], `claim_winnings r${roundId} #${entryIndex}`);
    return;
  }

  // Admin-cranked: the builder bound authority to the player (the
  // wallet-native path); rebind it to the paying admin signer.
  const admin = loadAdmin();
  for (const key of tx.instructions[0]!.keys) {
    if (key.isSigner && key.pubkey.equals(new PublicKey(player))) {
      key.pubkey = admin.publicKey;
    }
  }
  await send(tx, [admin], `claim_winnings r${roundId} #${entryIndex}`);
}

void main().catch((err: unknown) => {
  console.error(String(err));
  const logs = (err as { logs?: string[] }).logs;
  if (Array.isArray(logs)) console.error(logs.join("\n"));
  process.exitCode = 1;
});
