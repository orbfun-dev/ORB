/**
 * GET/POST /api/raffle/cron/draw — Vercel serverless adapter (§6.6;
 * scheduled by pg_cron + pg_net every minute, guarded by the
 * x-cron-secret header).
 *
 * Reveals locked epochs whose target slot has passed:
 * winning_no = u64_le(sha256(merkle_root ‖ blockhash)) mod issued + 1.
 * A pruned blockhash skips and retries — it never invents a winner.
 */

import { Connection } from "@solana/web3.js";
import { drawCronEndpoint, loadConfig, serveRaffle } from "../../../packages/raffle/src/index";

const config = loadConfig();
const connection = new Connection(config.solanaRpcUrl, { commitment: "finalized" });
const handler = drawCronEndpoint(config, connection);

export default async function drawCron(req: any, res: any): Promise<void> {
  await serveRaffle(req, res, handler);
}
