/**
 * POST /api/raffle/cron/buyback — Vercel serverless adapter (R8).
 *
 * Ops records a buyback transaction signature against its epoch. An
 * unpublished buyback is an unverifiable claim, so this is the only way
 * the public buyback figure is allowed to move. Guarded by the
 * x-cron-secret header; it is an ops endpoint, never a user one.
 */

import { buybackCronEndpoint, loadConfig, serveRaffle } from "../../../packages/raffle/src/index";

const config = loadConfig();
const handler = buybackCronEndpoint(config);

export default async function buybackCron(req: any, res: any): Promise<void> {
  await serveRaffle(req, res, handler);
}
