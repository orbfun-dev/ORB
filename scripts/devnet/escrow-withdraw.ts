/**
 * Devnet ops: withdraw spendable lamports from the durable demo escrow —
 * the §7 step-5 exit proof ("withdraw_escrow reaches the wallet"). Not
 * pause-gated and carries no config dependency on-chain; the same shape
 * works on any funded escrow by swapping the payer keypair.
 *
 *   npx tsx scripts/devnet/escrow-withdraw.ts            # drain all spendable
 *   npx tsx scripts/devnet/escrow-withdraw.ts 0.5        # explicit SOL
 */

import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { OrbitJackpotClient, escrowKey } from "@orbit-jackpot/sdk";
import { connection, explorer, loadOrGenerateKeypair, send, withRetry } from "./common";

async function main(): Promise<void> {
  const client = new OrbitJackpotClient(connection);
  const player = loadOrGenerateKeypair("escrow-player");
  const escrowAddr = escrowKey(player.publicKey);

  const escrow = await client.fetchEscrow(player.publicKey);
  if (escrow === null) {
    throw new Error(`no escrow for ${player.publicKey.toBase58()} — run escrow-fund first`);
  }
  const escrowLamports = await withRetry(
    () => connection.getBalance(escrowAddr, "confirmed"),
    "getBalance",
  );
  const rentFloor = BigInt(
    await withRetry(() => connection.getMinimumBalanceForRentExemption(122), "rent122"),
  );
  const spendable = escrowLamports > rentFloor ? escrowLamports - rentFloor : 0n;

  const requested =
    process.argv[2] !== undefined
      ? BigInt(Math.round(Number(process.argv[2]) * LAMPORTS_PER_SOL))
      : spendable;
  if (requested <= 0n) throw new Error("nothing to withdraw (spendable is zero)");
  if (requested > spendable) {
    throw new Error(
      `requested ${requested} exceeds spendable ${spendable} (the ${rentFloor}-lamport rent floor stays locked — there is no close_escrow in this release)`,
    );
  }

  console.log(`escrow: ${explorer(escrowAddr.toBase58(), "address")}`);
  console.log(`balance ${escrowLamports} · floor ${rentFloor} · spendable ${spendable}`);
  console.log(`state: rounds_remaining=${escrow.roundsRemaining} (optimistic after withdrawals)`);

  const tx = await client.buildWithdrawEscrowTx(player.publicKey, requested);
  await send(tx, [player], "withdraw_escrow");
  console.log(
    `wallet now holds ${await withRetry(
      () => connection.getBalance(player.publicKey, "confirmed"),
      "getBalance",
    )} lamports`,
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", event: "escrow_withdraw_error", err: String(err) }));
  process.exit(1);
});
