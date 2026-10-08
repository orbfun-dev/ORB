/**
 * POST /api/raffle/purchase — Vercel serverless adapter (§6.4).
 */

import { defaultPurchaseDeps, purchaseEndpoint, serveRaffle } from "../../packages/raffle/src/index";

const handler = purchaseEndpoint(defaultPurchaseDeps());

export default async function purchase(req: any, res: any): Promise<void> {
  await serveRaffle(req, res, handler);
}
