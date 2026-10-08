/**
 * Is Switchboard's mainnet randomness working? Read-only, costs nothing.
 *
 *   MAINNET_RPC_URL=<rpc> npx tsx scripts/mainnet/sb-health.ts
 *
 * Checks two things: (1) oracle selection on our queue, which the crank's
 * commit step needs, and (2) when anyone last completed a RandomnessReveal
 * on mainnet. Both broke on 2026-10-08 (every gateway 503, last reveal
 * ~17 h before) — mainnet rounds can only cancel and refund until this
 * prints "HEALTHY".
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Queue } from "@switchboard-xyz/on-demand";
import { CrossbarClient } from "@switchboard-xyz/common";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";

const SB = new PublicKey("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
const QUEUE = new PublicKey("A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w");

async function main(): Promise<void> {
  const rpc = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const c = new Connection(rpc, "confirmed");
  const provider = new AnchorProvider(c, new Wallet(Keypair.generate()), {});
  const program = new Program((await Program.fetchIdl(SB, provider))!, provider);

  let selectable = false;
  try {
    const r = await new Queue(program, QUEUE).selectRandomnessOracle(
      new CrossbarClient(process.env.CRANK_SB_CROSSBAR_URL ?? "https://crossbar.switchboardlabs.xyz"),
    );
    console.log(`oracle selection  OK (${r.oracle.pubkey.toBase58()})`);
    selectable = true;
  } catch (err) {
    console.log(`oracle selection  FAILED: ${String(err).slice(0, 120)}`);
  }

  let lastRevealAgo: number | null = null;
  const sigs = await c.getSignaturesForAddress(SB, { limit: 100 });
  for (const s of sigs) {
    if (s.err !== null || s.blockTime == null) continue;
    const tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (tx?.meta?.logMessages?.some((l) => l.includes("Instruction: RandomnessReveal"))) {
      lastRevealAgo = Math.floor(Date.now() / 1000) - s.blockTime;
      break;
    }
  }
  console.log(
    lastRevealAgo === null
      ? "last reveal       none in the program's last 100 transactions"
      : `last reveal       ${(lastRevealAgo / 3600).toFixed(1)} h ago`,
  );
  const healthy = selectable && lastRevealAgo !== null && lastRevealAgo < 6 * 3600;
  console.log(healthy ? "HEALTHY" : "NOT HEALTHY — mainnet rounds will cancel and refund");
  process.exit(healthy ? 0 : 1);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(2);
});
