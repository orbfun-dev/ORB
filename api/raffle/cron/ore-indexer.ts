/**
 * GET/POST /api/raffle/cron/ore-indexer — Vercel serverless adapter.
 * Scheduled by pg_cron + pg_net every 30 s (sql/008_ore_indexer.sql),
 * guarded by the x-cron-secret header. Awards ORE entries for deploys
 * that paid playorb's platform fee — the only ORE deploys that earn.
 */

import { Connection } from "@solana/web3.js";
import {
  loadConfig,
  oreIndexerCronEndpoint,
  serveRaffle,
} from "../../../packages/raffle/src/index";

const config = loadConfig();
const connection = new Connection(config.solanaRpcUrl, { commitment: "finalized" });
const handler = oreIndexerCronEndpoint(config, connection);

export default async function oreIndexerCron(req: any, res: any): Promise<void> {
  await serveRaffle(req, res, handler);
}
