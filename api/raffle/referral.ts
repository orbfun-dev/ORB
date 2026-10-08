/**
 * POST /api/raffle/referral — Vercel serverless adapter (§6.3).
 */

import { defaultReferralDeps, referralEndpoint, serveRaffle } from "../../packages/raffle/src/index";

const handler = referralEndpoint(defaultReferralDeps());

export default async function referral(req: any, res: any): Promise<void> {
  await serveRaffle(req, res, handler);
}
