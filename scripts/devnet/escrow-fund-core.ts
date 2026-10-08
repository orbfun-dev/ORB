/**
 * Shared escrow-funding core for the devnet ops scripts: computes the REAL
 * §4.7 quote from chain-derived figures (config tip + rent RPC), airdrops
 * the player wallet when short, and sends `init_or_deposit_escrow`.
 * Consumed by escrow-fund.ts (the CLI) and escrow-demo.ts (the watcher).
 */

import { LAMPORTS_PER_SOL, Keypair, Transaction } from "@solana/web3.js";
import type { OrbitJackpotClient } from "@orbit-jackpot/sdk";
import { connection, send, sleep, withRetry } from "./common";

export interface FundResult {
  amountLamports: bigint;
  roundCost: bigint;
  entryRent: bigint;
  tip: bigint;
  escrowRentFloor: bigint;
  fresh: boolean;
}

export async function fundEscrowForRounds(
  client: OrbitJackpotClient,
  player: Keypair,
  perRoundSol: number,
  rounds: number,
  autoReinvest: boolean,
): Promise<FundResult> {
  const config = await client.fetchConfig();
  if (config === null) throw new Error("not initialized — run init-config first");

  const perRound = BigInt(Math.round(perRoundSol * LAMPORTS_PER_SOL));
  const entryRent = BigInt(
    await withRetry(() => connection.getMinimumBalanceForRentExemption(109), "rent109"),
  );
  const tip = config.autoDepositTipLamports;
  const roundCost = perRound + entryRent + tip;
  const amount = roundCost * BigInt(rounds);
  const existing = await client.fetchEscrow(player.publicKey);
  const escrowRentFloor = BigInt(
    await withRetry(() => connection.getMinimumBalanceForRentExemption(122), "rent122"),
  );
  const fresh = existing === null;
  const needed = amount + (fresh ? escrowRentFloor : 0n);

  console.log(
    `quote: ${rounds} × (${perRound} stake + ${entryRent} entry rent + ${tip} tip)` +
      `${fresh ? ` + ${escrowRentFloor} one-time floor` : ""} = ${needed} lamports`,
  );

  const balance = await withRetry(
    () => connection.getBalance(player.publicKey, "confirmed"),
    "getBalance",
  );
  if (balance < needed + 5_000_000n) {
    const missing = needed + 5_000_000n - balance;
    const missingSol = Math.ceil(Number(missing) / LAMPORTS_PER_SOL);
    let funded = false;
    for (let attempt = 0; attempt < 3 && !funded; attempt += 1) {
      try {
        const sig = await connection.requestAirdrop(
          player.publicKey,
          BigInt(missingSol * LAMPORTS_PER_SOL),
        );
        await withRetry(() => connection.confirmTransaction(sig, "confirmed"), "airdrop");
        funded = true;
      } catch (err) {
        console.warn(`airdrop attempt ${attempt + 1} failed: ${String(err).slice(0, 120)}`);
        await sleep(3_000);
      }
    }
    if (!funded) {
      throw new Error(
        `faucet refused — fund manually: solana transfer ${player.publicKey.toBase58()} ${missingSol}`,
      );
    }
  }

  const tx: Transaction = await client.buildInitOrDepositEscrowTx(
    player.publicKey,
    amount,
    perRound,
    rounds,
    autoReinvest,
  );
  await send(tx, [player], "init_or_deposit_escrow");

  const after = await client.fetchEscrow(player.publicKey);
  console.log(
    `state: rounds_remaining=${after!.roundsRemaining}/${rounds} per_round=${after!.perRoundLamports} ` +
      `reinvest=${after!.autoReinvest} next_eligible_round=${after!.nextEligibleRoundId}`,
  );
  return { amountLamports: amount, roundCost, entryRent, tip, escrowRentFloor, fresh };
}
