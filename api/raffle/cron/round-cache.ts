/**
 * GET/POST /api/raffle/cron/round-cache — Vercel serverless adapter
 * (§6.2; scheduled by pg_cron + pg_net every 30 s, guarded by the
 * x-cron-secret header).
 */

import { Connection } from "@solana/web3.js";
import {
  loadConfig,
  raffleDb,
  roundCacheCronEndpoint,
  serveRaffle,
} from "../../../packages/raffle/src/index";

const config = loadConfig();
const connection = new Connection(config.solanaRpcUrl, { commitment: "finalized" });
const handler = roundCacheCronEndpoint(config, connection);

export default async function roundCacheCron(req: any, res: any): Promise<void> {
  await serveRaffle(req, res, handler);
}
