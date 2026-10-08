/**
 * GET/POST /api/raffle/cron/epoch-lock — Vercel serverless adapter
 * (§6.5; scheduled by pg_cron + pg_net every minute, guarded by the
 * x-cron-secret header).
 *
 * One pass: timer-lock expired epochs, commit each locked epoch's draw
 * (merkle root + target slot + on-chain memo), resolve any epoch nobody
 * entered, and open the next epoch when none is open.
 */

import { Connection } from "@solana/web3.js";
import {
  epochLockCronEndpoint,
  loadConfig,
  serveRaffle,
} from "../../../packages/raffle/src/index";

const config = loadConfig();
const connection = new Connection(config.solanaRpcUrl, { commitment: "finalized" });
const handler = epochLockCronEndpoint(config, connection);

export default async function epochLockCron(req: any, res: any): Promise<void> {
  await serveRaffle(req, res, handler);
}
