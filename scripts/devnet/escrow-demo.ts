/**
 * Devnet ops: the end-to-end escrow acceptance driver (design §7 step 5) —
 * funds the durable demo escrow for 3 rounds, then polls and prints the
 * `AutoDeposited`/`EscrowDepleted` TIMELINE as the keeper cranks it:
 * rounds_remaining counting down (or recompute-on-reinvest), prizes and
 * refunds landing IN the escrow, and the terminal depleted state.
 *
 *   npx tsx scripts/devnet/escrow-demo.ts        # fund 0.1 SOL × 3, then watch
 *
 * Exits when the escrow is depleted, or after `--max-rounds` observed
 * auto-deposits, or on Ctrl-C. Pair with escrow-withdraw.ts to finish the
 * loop back to the wallet.
 */

import { OrbitJackpotClient, escrowKey } from "@orbit-jackpot/sdk";
import { connection, explorer, loadOrGenerateKeypair } from "./common";
import { fundEscrowForRounds } from "./escrow-fund-core";

const POLL_MS = 8_000;

async function main(): Promise<void> {
  const maxRounds = Number(process.argv[2] ?? 3);
  if (!Number.isInteger(maxRounds) || maxRounds <= 0) {
    throw new Error("usage: escrow-demo [rounds]");
  }
  const client = new OrbitJackpotClient(connection);
  const player = loadOrGenerateKeypair("escrow-player");
  const escrowAddr = escrowKey(player.publicKey);
  console.log(`player: ${player.publicKey.toBase58()}`);
  console.log(`escrow: ${explorer(escrowAddr.toBase58(), "address")}`);

  await fundEscrowForRounds(client, player, 0.1, maxRounds, true);

  // The timeline: watch the escrow account mutate. Each keeper crank shows
  // up as rounds_funded +1 / next_eligible +1; a win or refund lands as a
  // balance bump; depletion freezes the book.
  let last = "";
  let observed = 0;
  console.log(`watching (poll every ${POLL_MS / 1000}s) — Ctrl-C to stop…`);
  for (;;) {
    const escrow = await client.fetchEscrow(player.publicKey).catch(() => null);
    if (escrow === null) throw new Error("escrow vanished — this cannot happen in v1 (no close)");
    const balance = await connection.getBalance(escrowAddr, "confirmed").catch(() => 0n);
    const line =
      `funded=${escrow.roundsFunded} remaining=${escrow.roundsRemaining} ` +
      `next_eligible=${escrow.nextEligibleRoundId} staked=${escrow.lifetimeStaked} balance=${balance}`;
    if (line !== last) {
      console.log(`[${new Date().toISOString()}] ${line}`);
      if (escrow.roundsFunded > 0 && last !== "") observed = Number(escrow.roundsFunded);
      last = line;
      if (escrow.roundsRemaining === 0) {
        console.log("EscrowDepleted — the budget is dry; re-fund or withdraw:");
        console.log(`  npx tsx scripts/devnet/escrow-fund.ts 0.1 3 1`);
        console.log(`  npx tsx scripts/devnet/escrow-withdraw.ts`);
        return;
      }
    }
    if (observed >= maxRounds) {
      console.log(`observed ${observed} auto-deposits — done (budget still has ${escrow.roundsRemaining})`);
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", event: "escrow_demo_error", err: String(err) }));
  process.exit(1);
});
