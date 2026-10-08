/**
 * Smoke-test deposits: orb-smoke-a and orb-smoke-b (keys in
 * ~/.config/orb/mainnet) each deposit into the active round once it is
 * open, so the round has two depositors and must draw randomness.
 *
 *   ORB_CLUSTER=mainnet RPC=<rpc> AMOUNTS=10000000,20000000 npx tsx scripts/mainnet/smoke-deposit.ts
 *
 * Used for the entropy-provider rehearsal on devnet (2026-10-08).
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, sendAndConfirmTransaction } from "@solana/web3.js";
import { OrbitJackpotClient } from "../../packages/sdk/src/index";
const kp = (n: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/orb/mainnet/${n}.json`, "utf8"))));
async function main() {
  const conn = new Connection(process.env.RPC!, "confirmed");
  const client = new OrbitJackpotClient(conn);
  const amounts = (process.env.AMOUNTS ?? "10000000,20000000").split(",").map(BigInt);
  for (let attempt = 0; attempt < 60; attempt++) {
    const cfg = (await client.fetchConfig())!;
    const r = await client.fetchRound(cfg.activeRoundId);
    if (r && r.state === "open") {
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (r.endTs - now < 15n && r.totalLamports > 0n) { await new Promise((x) => setTimeout(x, 3000)); continue; }
      console.log(`round ${r.roundId} open, ends in ${r.endTs - now}s, total ${r.totalLamports}`);
      for (const [i, name] of ["orb-smoke-a", "orb-smoke-b"].entries()) {
        const w = kp(name);
        const tx = await client.buildDepositTx(w.publicKey, r.roundId, amounts[i]!);
        const sig = await sendAndConfirmTransaction(conn, tx, [w], { commitment: "confirmed" });
        console.log(`${name} deposited ${amounts[i]} into round ${r.roundId}: ${sig}`);
      }
      return;
    }
    await new Promise((x) => setTimeout(x, 3000));
  }
  throw new Error("no open round");
}
main().catch((e) => { console.error(e); process.exit(1); });
