/**
 * RPC endpoint configuration.
 *
 * Default targets Solana Devnet, where the program is deployed live
 * (phase 8.2); override with `VITE_SOLANA_RPC_URL` (see
 * apps/web/.env.example) — e.g. the Phase 7.5 local validator
 * (`http://127.0.0.1:8899`) per the local-demo runbook, or a paid RPC.
 * An unset OR blank value must never silently produce an invalid endpoint.
 * `confirmed` is the fastest commitment at which our decoders'
 * accounts are final enough for UI display.
 */

const configured = (import.meta.env.VITE_SOLANA_RPC_URL as string | undefined)?.trim();

export const RPC_ENDPOINT: string =
  configured !== undefined && configured.length > 0
    ? configured
    : "https://api.devnet.solana.com";

export const RPC_COMMITMENT = "confirmed" as const;
