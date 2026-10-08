/**
 * GET/POST /api/raffle/cron/orb-indexer — Vercel serverless adapter.
 * Scheduled by pg_cron + pg_net every 30 s (sql/012_orb_indexer.sql),
 * guarded by the x-cron-secret header. Awards raffle entries for wheel
 * deposits in settled rounds (1 per 1 SOL); cancelled rounds earn nothing.
 */

import { Connection } from "@solana/web3.js";
import {
  loadConfig,
  orbIndexerCronEndpoint,
  serveRaffle,
} from "../../../packages/raffle/src/index";

const config = loadConfig();
const connection = new Connection(config.solanaRpcUrl, { commitment: "finalized" });
const handler = orbIndexerCronEndpoint(config, connection);

export default async function orbIndexerCron(req: any, res: any): Promise<void> {
  await serveRaffle(req, res, handler);
}
