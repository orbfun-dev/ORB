/**
 * Devnet ops: fund (or re-fund / re-terms) the durable demo escrow — the
 * design §7 step-5 "one manual escrow" driver, and the player-side CLI
 * for direct testing.
 *
 *   npx tsx scripts/devnet/escrow-fund.ts                  # 0.1 SOL × 3 rounds, reinvest on
 *   npx tsx scripts/devnet/escrow-fund.ts 0.25 5 0         # explicit terms, reinvest off
 *
 * The funded amount is the REAL quote (design §4.7):
 * `rounds × (per_round + entry_rent + tip)` — the entry rent is returned
 * per round at close_entry but must be funded up-front; the tip is not
 * returned. A brand-new escrow additionally needs its one-time rent floor
 * (charged by `init_if_needed` on top of the transfer). Balances come from
 * a devnet airdrop loop (the admin wallet is intentionally not spent
 * here); if the faucet refuses, the printed manual fallback works.
 */

import { OrbitJackpotClient, escrowKey } from "@orbit-jackpot/sdk";
import { connection, explorer, loadOrGenerateKeypair } from "./common";
import { fundEscrowForRounds } from "./escrow-fund-core";

async function main(): Promise<void> {
  const perRoundSol = Number(process.argv[2] ?? "0.1");
  const rounds = Number(process.argv[3] ?? "3");
  const autoReinvest = (process.argv[4] ?? "1") !== "0";
  if (!Number.isFinite(perRoundSol) || perRoundSol <= 0 || !Number.isInteger(rounds) || rounds <= 0) {
    throw new Error("usage: escrow-fund [perRoundSol] [rounds] [autoReinvest 0|1]");
  }

  const client = new OrbitJackpotClient(connection);
  const player = loadOrGenerateKeypair("escrow-player");
  console.log(`player: ${player.publicKey.toBase58()}`);
  console.log(`escrow: ${explorer(escrowKey(player.publicKey).toBase58(), "address")}`);
  console.log(`terms: ${perRoundSol} SOL × ${rounds} rounds (reinvest ${autoReinvest ? "on" : "off"})`);

  const config = await client.fetchConfig();
  await fundEscrowForRounds(client, player, perRoundSol, rounds, autoReinvest);
  console.log(
    `next:  any permissionless crank (the keeper, or a third party) enters this escrow while ` +
      `now <= round.start_ts + ${config!.autoDepositWindowSecs}s — the escrow owner may crank ANY time before the round ends`,
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", event: "escrow_fund_error", err: String(err) }));
  process.exit(1);
});
