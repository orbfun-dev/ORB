/**
 * GET /api/raffle/status — Vercel serverless adapter (§7 P9).
 *
 * The page's single read: epoch progress, leaderboard, and the
 * connected wallet's entries. Public data, no cron secret — but still
 * server-side, because the browser holds no database credential (R1).
 */

import { defaultStatusDeps, serveRaffle, statusEndpoint } from "../../packages/raffle/src/index";

const handler = statusEndpoint(defaultStatusDeps());

export default async function status(req: any, res: any): Promise<void> {
  await serveRaffle(req, res, handler);
}
