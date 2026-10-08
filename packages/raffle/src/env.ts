/**
 * Raffle configuration — environment, never literals in code (directive §3).
 *
 * All values come from the serverless function environment (Vercel) with
 * the directive defaults applied when unset. The browser never sees any
 * of this (R1) — importing this module from `apps/web/src` is a test
 * failure by the P1 isolation gate.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`raffle: missing required env ${name}`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`raffle: env ${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

export interface RaffleConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  /** Mainnet RPC for finalized transaction verification (R2). */
  solanaRpcUrl: string;
  /** Purchases pay this wallet (§6.4); buybacks are recorded per epoch (R8). */
  raffleTreasuryPubkey: string;
  /** Server-side secret guarding cron endpoints. */
  cronSecret: string;
  /**
   * Base58 secret key of the draw-commit wallet (§6.5 step 2d — the
   * on-chain memo tx). Optional in tests; the real cron wiring fails
   * loudly without it.
   */
  commitKeypair?: string;
  /**
   * The wallet playorb's ORE page sends its platform fee to (the web
   * app's VITE_ORE_FEE_RECIPIENT). Its transaction history IS the list
   * of deploys made through playorb, and only those earn ORE entries
   * (ore-indexer.ts). Optional so the other endpoints load without it;
   * the indexer fails loudly when it is missing.
   */
  oreFeeRecipient?: string;
  /**
   * The page's fee rule (apps/web/src/features/ore-lite/config.ts
   * PLATFORM_FEE). A deploy must have paid at least this much to earn.
   */
  oreFeeBps: number;
  oreFeeMinLamports: number;
  oreFeeMaxLamports: number;
  lamportsPerEntry: number;
  entryPriceLamports: number;
  referralMinLamports: number;
  referralCapPerEpoch: number;
  purchaseCapPerWallet: number;
  purchaseCapShareBps: number;
  epochCap: number;
  epochDurationDays: number;
}

/**
 * playorb's ORE platform fee — MUST mirror PLATFORM_FEE in
 * apps/web/src/features/ore-lite/config.ts (tests/p4_ore_indexer pins
 * the two together).
 */
export const ORE_FEE_DEFAULTS = {
  oreFeeBps: 100,
  oreFeeMinLamports: 100_000,
  oreFeeMaxLamports: 50_000_000,
} as const;

const DEFAULTS = {
  ...ORE_FEE_DEFAULTS,
  lamportsPerEntry: 1_000_000_000,
  entryPriceLamports: 50_000_000,
  referralMinLamports: 1_000_000_000,
  referralCapPerEpoch: 25,
  purchaseCapPerWallet: 25,
  purchaseCapShareBps: 3_000,
  epochCap: 1_000,
  epochDurationDays: 7,
} as const;

/** Loaded lazily so importing the module never throws without env. */
export function loadConfig(): RaffleConfig {
  const config = readConfig();
  assertDistinctWallets(config);
  return config;
}

/**
 * AUDIT R-14: if the ORE platform-fee wallet were also the raffle
 * treasury, every ORE deploy's fee transfer would ALSO read as a ticket
 * purchase. Refuse to start rather than double-count.
 */
export function assertDistinctWallets(config: Pick<RaffleConfig, "oreFeeRecipient" | "raffleTreasuryPubkey">): void {
  if (config.oreFeeRecipient !== undefined && config.oreFeeRecipient === config.raffleTreasuryPubkey) {
    throw new Error("RAFFLE_ORE_FEE_RECIPIENT must differ from RAFFLE_TREASURY_PUBKEY");
  }
}

function readConfig(): RaffleConfig {
  return {
    supabaseUrl: required("SUPABASE_URL"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    solanaRpcUrl: required("SOLANA_RPC_URL"),
    raffleTreasuryPubkey: required("RAFFLE_TREASURY_PUBKEY"),
    cronSecret: required("RAFFLE_CRON_SECRET"),
    commitKeypair: process.env.RAFFLE_COMMIT_KEYPAIR || undefined,
    oreFeeRecipient: process.env.RAFFLE_ORE_FEE_RECIPIENT || undefined,
    oreFeeBps: int("RAFFLE_ORE_FEE_BPS", DEFAULTS.oreFeeBps),
    oreFeeMinLamports: int("RAFFLE_ORE_FEE_MIN_LAMPORTS", DEFAULTS.oreFeeMinLamports),
    oreFeeMaxLamports: int("RAFFLE_ORE_FEE_MAX_LAMPORTS", DEFAULTS.oreFeeMaxLamports),
    lamportsPerEntry: int("LAMPORTS_PER_ENTRY", DEFAULTS.lamportsPerEntry),
    entryPriceLamports: int("ENTRY_PRICE_LAMPORTS", DEFAULTS.entryPriceLamports),
    referralMinLamports: int("REFERRAL_MIN_LAMPORTS", DEFAULTS.referralMinLamports),
    referralCapPerEpoch: int("REFERRAL_CAP_PER_EPOCH", DEFAULTS.referralCapPerEpoch),
    purchaseCapPerWallet: int("PURCHASE_CAP_PER_WALLET", DEFAULTS.purchaseCapPerWallet),
    purchaseCapShareBps: int("PURCHASE_CAP_SHARE_BPS", DEFAULTS.purchaseCapShareBps),
    epochCap: int("EPOCH_CAP", DEFAULTS.epochCap),
    epochDurationDays: int("EPOCH_DURATION_DAYS", DEFAULTS.epochDurationDays),
  };
}
