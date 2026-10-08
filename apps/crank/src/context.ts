/**
 * The handler context: everything a crank evaluator needs, with the
 * chain-facing seams as structural interfaces so the test suite can drive
 * decisions against in-memory fakes (no Connection, no gateway). The real
 * implementations are `ChainReader`, `SwitchboardCtx`, `StateStore`, and
 * the `RpcGateway` — assembled in main.ts.
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import type {
  EntropyChainData,
  GlobalConfigData,
  OrbitJackpotClient,
  PlayerEntryAccountData,
  PlayerEscrowData,
  RoundData,
} from "@orbit-jackpot/sdk";
import type { CrankConfig } from "./config";
import type { Logger } from "./log";
import type { RandomnessView, RevealPayload } from "./randomness";
import type { ChainClock, RpcGateway } from "./rpc";

/** The reads settle/cleanup evaluators perform (fresh, never cached). */
export interface SettleBridge {
  randomness(key: PublicKey): Promise<RandomnessView | null>;
  entries(roundId: bigint, entryCount: number): Promise<PlayerEntryAccountData[]>;
  /** An address lookup table's deactivation slot (u64::MAX = still
   *  active), or null when the table no longer exists. */
  lookupTable(key: PublicKey): Promise<{ deactivationSlot: bigint } | null>;
  /** Randomness fallback: the entropy chain singleton (null before set). */
  entropyChain?(): Promise<EntropyChainData | null>;
  /** Raw SlotHashes sysvar bytes (for the entropy reveal's value mirror). */
  slotHashes?(): Promise<Buffer | null>;
}

/** A lookup table awaiting its post-cooldown close (Phase 13). */
export interface PendingLut {
  roundId: bigint;
  randomness: string;
  lutSlot: bigint;
}

/** Switchboard-side oracle facts the settle pipeline needs. */
export interface SbOracleSource {
  selectOracle(queue: PublicKey): Promise<PublicKey>;
  oracleGatewayUrl(oracle: PublicKey): Promise<string>;
  fetchReveal(gatewayUrl: string, randomnessAccount: PublicKey, view: RandomnessView): Promise<RevealPayload | null>;
  programStateKey(): Promise<PublicKey>;
}

/** The persistent book-keeping surface handlers touch. */
export interface QuarantineBook {
  isQuarantined(roundId: bigint): string | null;
  quarantine(roundId: bigint, reason: string): void;
  randomnessKeypair(roundId: bigint): Keypair;
  recordFailure(key: string): number;
  resetFailures(key: string): void;
  /** Current consecutive-failure streak of an action key (0 = clean). The
   *  cleanup handler reads it to downgrade a failed batch to singles. */
  failureCount(key: string): number;
  recordAction(entry: { kind: string; roundId?: string; sig?: string; dryRun?: boolean }): void;
  /** Phase 13: remember a round's LUT before its randomness account (the
   *  only on-chain record of `lut_slot`) is closed. Idempotent. */
  rememberLut(roundId: bigint, randomness: string, lutSlot: bigint): void;
  pendingLuts(): PendingLut[];
  forgetLut(roundId: bigint): void;
}

/** One escrow the registry resolved, with its decoded on-chain state. */
export interface EscrowCandidate {
  key: PublicKey;
  owner: PublicKey;
  data: PlayerEscrowData;
}

/** The /healthz mirror of the last dispatched auto-deposit batch. */
export interface LastAutoDepositStatus {
  roundId: string;
  count: number;
  at: string;
}

/**
 * The escrow registry seam (design §5.1): event-sourced discovery with a
 * bounded GPA reconcile, per-round batched reads (never GPA in the hot
 * path), dormant backoff, and the auto-deposit scan throttle. Structural
 * so the handler tests run against in-memory fakes.
 */
export interface EscrowRegistry {
  /** Eligible escrows for THIS round, mirroring the on-chain guards. */
  eligible(
    round: RoundData,
    config: GlobalConfigData,
    clock: ChainClock,
    entryRent: bigint,
    escrowRentMin: bigint,
  ): Promise<EscrowCandidate[]>;
  /** Event-feed hook: an `EscrowFunded` was observed. */
  noteFunded(escrow: PublicKey, owner: PublicKey): void;
  /** Bounded GPA reconcile (boot + interval); refusal keeps the registry. */
  reconcile(): Promise<void>;
  size(): number;
  /**
   * Whether ANY registered escrow could auto-deposit into its next round
   * (rounds remaining and enough balance for stake + entry rent + tip).
   * The idle-roll gate: with nothing armed, an empty round's expired
   * window costs nobody anything, so the keeper sends nothing.
   */
  anyArmed(config: GlobalConfigData, entryRent: bigint, escrowRentMin: bigint): Promise<boolean>;
  /** Health mirrors: last eligibility sweep + last dispatched batch. */
  lastEligibleCount(): number;
  lastAutoDeposit(): LastAutoDepositStatus | null;
  noteAutoDeposit(roundId: bigint, count: number): void;
  /** Scan throttle — `CRANK_AUTO_DEPOSIT_INTERVAL_MS`. */
  autoDepositDue(intervalMs: number): boolean;
  /** Memoized rent-exempt minimum for an account data length. */
  rentMinimumFor(dataLen: number): Promise<bigint>;
}

export interface HandlerCtx {
  cfg: CrankConfig;
  logger: Logger;
  rpc: RpcGateway;
  keeper: Keypair;
  client: OrbitJackpotClient;
  sb: SbOracleSource;
  bridge: SettleBridge;
  book: QuarantineBook;
  escrows: EscrowRegistry;
  /** Randomness fallback: the keeper's hash-chain seeds, when configured. */
  entropy?: import("./entropy").EntropySeeds | null;
}

/** One round under evaluation with its (possibly absent) randomness view. */
export interface RoundEval {
  round: RoundData;
  randomness: RandomnessView | null;
  clock: ChainClock;
  config: GlobalConfigData;
}
