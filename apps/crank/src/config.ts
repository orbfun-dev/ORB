/**
 * Environment parsing for the crank. One place turns `CRANK_*` variables
 * into a validated, typed config — every default targets Solana Devnet and
 * public-RPC etiquette (pacing + backoff), matching the posture the
 * phase-8 ops scripts proved live.
 *
 * `loadConfig(env)` is pure over its argument so the test suite can pin
 * defaults, overrides, and rejection cases without touching process env.
 */

import { resolveCluster } from "@orbit-jackpot/sdk";
export interface CrankConfig {
  /**
   * The RPC URL handed to Switchboard ORACLE GATEWAYS (third parties) so
   * they can read the slothash for a reveal. Never the paid `rpcUrl`: that
   * would give our API key to every oracle operator we pick. Defaults to
   * the cluster's public endpoint; override with CRANK_GATEWAY_RPC_URL.
   */
  gatewayRpcUrl: string;
  /**
   * AUDIT C-8: when > 0, the priority fee follows the network — the 75th
   * percentile of recent prioritization fees on the accounts the tx
   * writes, clamped to [priorityFeeMicrolamports, this]. 0 = static fee.
   */
  priorityFeeMaxMicrolamports: number;
  /** Which ORB deployment (ORB_CLUSTER; the SDK reads the same variable). */
  cluster: "devnet" | "mainnet";
  rpcUrl: string;
  /** Everything the keeper does is safe at `confirmed`; the create CPI's
   *  512-slot ALT window effectively demands it (finalized goes stale). */
  commitment: "confirmed" | "finalized";
  pollIntervalMs: number;
  wsEnabled: boolean;
  keypairPath?: string;
  keypairBase58?: string;
  priorityFeeMicrolamports: number;
  computeUnitLimit?: number;
  /** Randomness fallback: path to the entropy seed file (`{ x0, length }`),
   *  required only while the on-chain provider is `entropy`. */
  entropySeedFile?: string;
  minKeeperBalanceLamports: bigint;
  healthzHost: string;
  healthzPort: number;
  maxTrackedRounds: number;
  cleanupEnabled: boolean;
  claimForWinners: boolean;
  /** Phase 11.8: entries per close_entry batch transaction (the SDK's
   *  packet-width-measured figure — 4 shared + 2 per-entry accounts; see
   *  CLOSE_ENTRY_MAX_PER_TX and docs/reports/cu_profile.md). */
  closeBatchMaxPerTx: number;
  /** Phase 11.8: a Settled round still un-pruned past this many seconds
   *  trips the health alert — players are waiting on principal, not rent. */
  stuckCleanupAlertSecs: number;
  /** Phase 10: permissionless auto-deposit cranking (env kill switch). */
  autoDepositEnabled: boolean;
  /** Escrows per auto-deposit transaction (CU-measured basis: 6 fits the
   *  200k default budget with 1.5× headroom — docs/reports/cu_profile.md). */
  autoDepositMaxPerTx: number;
  /** Minimum gap between auto-deposit batch scans (the window is short;
   *  this keeps reads and retries paced without blocking other actions). */
  autoDepositIntervalMs: number;
  /** Escrow discovery: bounded GPA reconcile (boot + interval). */
  escrowGpaEnabled: boolean;
  escrowReconcileMs: number;
  /** Comma-separated escrow OR owner pubkeys — recovery / no-GPA operators. */
  escrowSeed: string;
  dryRun: boolean;
  logLevel: string;
  logFile?: string;
  stateDir: string;
  rpcPaceMs: number;
  maxBackoffMs: number;
  /** Phase 12: ceiling for the idle poll backoff — while the active round
   *  is Open and empty, the supervisor doubles its poll floor up to this
   *  instead of hammering the RPC at the active pace. Any action or
   *  WebSocket wake resets to the active floor immediately. */
  idlePollMaxMs: number;
  /** Phase 12: `0` = off (default — the keeper sends nothing while idle).
   *  Otherwise, once an empty expired round's `end_ts` is this many seconds
   *  in the past, the keeper sends ONE `lock_round` window roll so the UI
   *  countdown does not show a window that died hours ago. */
  idleRollSecs: number;
  /** Switchboard crossbar the oracle pick asks for live gateways. The
   *  SDK's own default host (crossbar.switchboard.xyz) stopped resolving,
   *  and every pick then waited out a ~11 s health-check fallback before
   *  the commit — most of the delay between a round closing and its
   *  winner appearing. https only. */
  sbCrossbarUrl: string;
}

class ConfigError extends Error {
  constructor(name: string, problem: string) {
    super(`config error: ${name} ${problem}`);
    this.name = "ConfigError";
  }
}

function httpsUrl(
  env: Record<string, string | undefined>,
  name: string,
  fallback: string,
): string {
  const raw = str(env, name, fallback);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(name, `must be an https URL, got "${raw}"`);
  }
  if (url.protocol !== "https:") {
    throw new ConfigError(name, `must be an https URL, got "${raw}"`);
  }
  return raw.replace(/\/+$/, "");
}

function str(
  env: Record<string, string | undefined>,
  name: string,
  fallback: string,
): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim();
}

function int(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(name, `must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return value;
}

function bool(
  env: Record<string, string | undefined>,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  throw new ConfigError(name, `must be a boolean (0/1/true/false), got "${raw}"`);
}

function solToLamports(
  env: Record<string, string | undefined>,
  name: string,
  fallbackSol: number,
): bigint {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return BigInt(Math.round(fallbackSol * 1_000_000_000));
  }
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
    throw new ConfigError(name, `must be a SOL amount in [0, 1000000], got "${raw}"`);
  }
  return BigInt(Math.round(value * 1_000_000_000));
}

/**
 * An RPC URL safe to log: query-string credentials (Helius `api-key=…`,
 * `token=…`) and any user:password are masked. Logs land in journald on
 * the droplet; a paid key there is a key anyone with log access can use.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username ? "***" : "";
      u.password = u.password ? "***" : "";
    }
    for (const k of [...u.searchParams.keys()]) u.searchParams.set(k, "***");
    return u.toString();
  } catch {
    return "<unparseable url>";
  }
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): CrankConfig {
  const keypairPath = str(env, "CRANK_KEYPAIR_PATH", "");
  const keypairBase58 = str(env, "CRANK_KEYPAIR_BASE58", "");
  if (keypairPath !== "" && keypairBase58 !== "") {
    throw new ConfigError(
      "CRANK_KEYPAIR_PATH",
      "and CRANK_KEYPAIR_BASE58 are both set — pick exactly one keeper identity source",
    );
  }

  const commitment = str(env, "CRANK_COMMITMENT", "confirmed");
  if (commitment !== "confirmed" && commitment !== "finalized") {
    throw new ConfigError("CRANK_COMMITMENT", `must be confirmed|finalized, got "${commitment}"`);
  }

  const logLevel = str(env, "CRANK_LOG_LEVEL", "info");
  const logFile = str(env, "CRANK_LOG_FILE", "");

  const cluster = resolveCluster(env.ORB_CLUSTER);
  const rpcUrl = str(env, "CRANK_RPC_URL", cluster === "mainnet" ? "" : "https://api.devnet.solana.com");
  if (cluster === "mainnet") {
    // A mainnet keeper on a devnet RPC (or the silent devnet default)
    // would read the wrong chain and sign nothing useful — or worse.
    if (rpcUrl === "") throw new Error("ORB_CLUSTER=mainnet requires CRANK_RPC_URL (a mainnet endpoint)");
    // ORB_REHEARSAL=devnet: the launch dress rehearsal runs the mainnet
    // build (mainnet program id) on devnet — the one sanctioned exception.
    const rehearsal = env.ORB_REHEARSAL === "devnet";
    if (rehearsal && !/devnet/.test(rpcUrl)) throw new Error("ORB_REHEARSAL=devnet needs a devnet CRANK_RPC_URL");
    if (!rehearsal && /devnet|testnet/.test(rpcUrl)) throw new Error("ORB_CLUSTER=mainnet but CRANK_RPC_URL points at devnet/testnet");
    if (keypairPath === "" && keypairBase58 === "") {
      throw new Error("ORB_CLUSTER=mainnet requires CRANK_KEYPAIR_PATH or CRANK_KEYPAIR_BASE58");
    }
  }

  const rehearsalDevnet = env.ORB_REHEARSAL === "devnet";
  const publicRpc =
    cluster === "mainnet" && !rehearsalDevnet ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
  const gatewayRpcUrl = str(env, "CRANK_GATEWAY_RPC_URL", publicRpc);

  return {
    cluster,
    rpcUrl,
    gatewayRpcUrl,
    commitment: commitment as CrankConfig["commitment"],
    pollIntervalMs: int(env, "CRANK_POLL_INTERVAL_MS", 10_000, 1_000, 3_600_000),
    wsEnabled: bool(env, "CRANK_WS_ENABLED", true),
    keypairPath: keypairPath === "" ? undefined : keypairPath,
    keypairBase58: keypairBase58 === "" ? undefined : keypairBase58,
    priorityFeeMicrolamports: int(env, "CRANK_PRIORITY_FEE_MICROLAMPORTS", 0, 0, 100_000_000),
    priorityFeeMaxMicrolamports: int(env, "CRANK_PRIORITY_FEE_MAX_MICROLAMPORTS", 0, 0, 100_000_000),
    computeUnitLimit:
      str(env, "CRANK_COMPUTE_UNIT_LIMIT", "") === ""
        ? undefined
        : int(env, "CRANK_COMPUTE_UNIT_LIMIT", 0, 1, 1_400_000),
    entropySeedFile: str(env, "CRANK_ENTROPY_SEED_FILE", "") || undefined,
    minKeeperBalanceLamports: solToLamports(env, "CRANK_MIN_KEEPER_BALANCE_SOL", 0.05),
    healthzHost: str(env, "CRANK_HEALTHZ_HOST", "127.0.0.1"),
    healthzPort: int(env, "CRANK_HEALTHZ_PORT", 8_080, 1, 65_535),
    maxTrackedRounds: int(env, "CRANK_MAX_TRACKED_ROUNDS", 64, 1, 10_000),
    cleanupEnabled: bool(env, "CRANK_CLEANUP_ENABLED", true),
    claimForWinners: bool(env, "CRANK_CLAIM_FOR_WINNERS", false),
    closeBatchMaxPerTx: int(env, "CRANK_CLOSE_BATCH_MAX_PER_TX", 11, 1, 16),
    stuckCleanupAlertSecs: int(env, "CRANK_STUCK_CLEANUP_ALERT_SECS", 3_600, 60, 86_400_000),
    autoDepositEnabled: bool(env, "CRANK_AUTO_DEPOSIT_ENABLED", true),
    autoDepositMaxPerTx: int(env, "CRANK_AUTO_DEPOSIT_MAX_PER_TX", 6, 1, 12),
    autoDepositIntervalMs: int(env, "CRANK_AUTO_DEPOSIT_INTERVAL_MS", 1_000, 250, 60_000),
    escrowGpaEnabled: bool(env, "CRANK_ESCROW_GPA_ENABLED", true),
    escrowReconcileMs: int(env, "CRANK_ESCROW_RECONCILE_MS", 600_000, 60_000, 86_400_000),
    escrowSeed: str(env, "CRANK_ESCROW_SEED", ""),
    dryRun: bool(env, "CRANK_DRY_RUN", false),
    logLevel,
    logFile: logFile === "" ? undefined : logFile,
    stateDir: str(env, "CRANK_STATE_DIR", "var"),
    rpcPaceMs: int(env, "CRANK_RPC_PACE_MS", 350, 0, 60_000),
    maxBackoffMs: int(env, "CRANK_MAX_BACKOFF_MS", 30_000, 100, 600_000),
    idlePollMaxMs: int(env, "CRANK_IDLE_POLL_MAX_MS", 120_000, 1_000, 3_600_000),
    idleRollSecs: int(env, "CRANK_IDLE_ROLL_SECS", 0, 0, 86_400),
    sbCrossbarUrl: httpsUrl(env, "CRANK_SB_CROSSBAR_URL", "https://crossbar.switchboardlabs.xyz"),
  };
}
