/**
 * POST /api/raffle/claim — Vercel serverless adapter.
 *
 * Functions live at the REPO ROOT /api/raffle/*.ts (vercel.json has
 * framework:null + outputDirectory:apps/web/dist, so Vercel discovers
 * root-level functions; /api/* matches before the rewrites). The SDK
 * and this package are imported FROM SOURCE via relative paths —
 * packages/sdk/dist is .vercelignore'd and workspace package resolution
 * is not guaranteed during function bundling.
 */

import { claimEndpoint, defaultClaimDeps, serveRaffle } from "../../packages/raffle/src/index";

const handler = claimEndpoint(defaultClaimDeps());

export default async function claim(req: any, res: any): Promise<void> {
  await serveRaffle(req, res, handler);
}
