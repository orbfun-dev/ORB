/**
 * ORE Lite configuration: hard-coded mainnet addresses, the dedicated
 * mainnet RPC endpoint, and the platform-fee policy (directive §3.1/§5.1).
 *
 * The three singletons are pinned with `has_address` inside the ORE
 * program — they are constants of the protocol, never re-derived.
 *
 * This module throws at load when `VITE_ORE_FEE_RECIPIENT` is unset or
 * malformed, ON PURPOSE: a fee silently zeroed by a missing env var is a
 * revenue bug nobody notices for a month. (The OreLiteRoot chunk is lazy-
 * loaded, so the throw is confined to the /ore-lite route.)
 */

import { PublicKey } from "@solana/web3.js";
import type { PlatformFee } from "./fee";

// ── protocol addresses (§3.1, verified against source + live chain) ────

export const ORE_PROGRAM_ID = new PublicKey("oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv");
export const BOARD_ADDRESS = new PublicKey("BrcSxdp1nXFzou1YyDnQJcPNBNHgoypZmTsyKBSLLXzi");
export const CONFIG_ADDRESS = new PublicKey("9c9X7aDRAF41faiDs94ELjT19UrGnn72wBW9hPsS4Awy");
export const TREASURY_ADDRESS = new PublicKey("45db2FSR4mcXdSVVZbKbwojU6uYDpMyhpEi7cC8nHaWG");
export const ENTROPY_VAR_ADDRESS = new PublicKey("BWCaDY96Xe4WkFq1M7UiCCRcChsJ3p51L5KrGzhxgm2E");
export const ENTROPY_PROGRAM_ID = new PublicKey("3jSkUuYBoJzQPMEzTvkDFXCZUBksPamrVhrnHR9igu2X");
export const ORE_MINT_ADDRESS = new PublicKey("oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp");

// SPL constants this web3.js version does not re-export (§3.3 pins them).
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

// ── cluster ────────────────────────────────────────────────────────────

/**
 * Env lookup that works in Vite (import.meta.env) and in plain Node
 * (verification scripts run with tsx) without weakening the browser
 * behavior. Returns `undefined` when unset/blank in both sources.
 */
function envValue(key: string): string | undefined {
  const fromVite = (import.meta.env?.[key] as string | undefined)?.trim();
  if (fromVite !== undefined && fromVite !== "") return fromVite;
  const fromProcess =
    typeof process !== "undefined" ? process.env?.[key]?.trim() : undefined;
  return fromProcess !== undefined && fromProcess !== "" ? fromProcess : undefined;
}

/**
 * Dedicated mainnet-beta RPC. The main app's provider stack is devnet and
 * is never used here (the cluster split is the core isolation constraint).
 * Point `VITE_ORE_RPC_URL` at a private endpoint for production traffic —
 * the public one is heavily rate-limited.
 */
export const ORE_RPC_URL =
  envValue("VITE_ORE_RPC_URL") ?? "https://api.mainnet-beta.solana.com";

// ── platform fee policy (§5.1) ─────────────────────────────────────────

/** Throws on missing/malformed env — fail loudly, never skip the fee. */
export const PLATFORM_FEE_RECIPIENT = new PublicKey(envValue("VITE_ORE_FEE_RECIPIENT") ?? "");

// ── auto-join (multi-round Automate) — no-keeper design ───────────────

/**
 * ORE's permissionless executor sentinel (api/src/consts.rs
 * EXECUTOR_ADDRESS). An automation with this executor may be run by ANY
 * bot — deploy.rs:76's assert accepts every signer — and a competitive
 * public fleet races to execute them every round for the on-account fee
 * (verified live 2026-10-07: 27 Preferred+permissionless automations,
 * top one Bsxit5rr… with 290 SOL pushed through automated deploys at
 * ~115 s cadence, multiple same-slot racing signatures). Liveness is
 * backed by that fleet, not by us; we run nothing.
 */
export const ORE_PERMISSIONLESS_EXECUTOR = new PublicKey(
  "executor11111111111111111111111111111111112",
);

/**
 * Auto-join gate. Our revenue on this path is a ONE-TIME platform fee on
 * the setup transaction (the per-round executor fee goes to whichever bot
 * wins the round — the 7 000-lamport market rate set in the planner).
 * The flag stays off until the P5 dust run proves OUR setup/stop
 * transaction combo end-to-end; the execution path itself is already
 * proven by 27 live accounts.
 */
const ORE_AUTOJOIN_ENV = envValue("VITE_ORE_AUTOJOIN_ENABLED");

export const ORE_AUTOJOIN = {
  enabled: ORE_AUTOJOIN_ENV !== undefined,
  /** Always the permissionless sentinel — there is no keeper to configure. */
  executor: ORE_PERMISSIONLESS_EXECUTOR,
};

export const PLATFORM_FEE: PlatformFee = {
  kind: "bps",
  bps: 100, // 1.00%
  minLamports: 100_000n, // 0.0001 SOL floor
  maxLamports: 50_000_000n, // 0.05 SOL ceiling
};

/** ORE grams per whole ORE — ORE has 11 decimals, not SOL's 9. */
export const ORE_DECIMALS = 11;
export const GRAMS_PER_ORE = 100_000_000_000n;
