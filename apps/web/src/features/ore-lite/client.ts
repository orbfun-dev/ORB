/**
 * OreClient: mainnet RPC reads + transaction assembly (directive §5.4/§5.5).
 *
 * Every deploy is ONE atomic v0 transaction shaped exactly like a live
 * ore.com deploy:
 *
 *   ComputeBudget | ComputeBudget | SystemProgram.transfer(fee) |
 *   Checkpoint | Deploy
 *
 * The transaction is simulated BEFORE it is handed to the wallet: a failed
 * simulation costs the user nothing, a failed send costs a fee and trust.
 */

import {
  ComputeBudgetProgram,
  type Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  type TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  type OreAutomation,
  type OreBoard,
  type OreConfig,
  type OreMiner,
  type OreRound,
  type OreTreasury,
  decodeOreAutomation,
  decodeOreBoard,
  decodeOreConfig,
  decodeOreMiner,
  decodeOreRound,
  decodeOreTreasury,
} from "./codec";
import {
  BOARD_ADDRESS,
  CONFIG_ADDRESS,
  PLATFORM_FEE_RECIPIENT,
  TREASURY_ADDRESS,
} from "./config";
import {
  buildAutomateIx,
  buildCheckpointIx,
  buildClaimOreIx,
  buildClaimSolIx,
  buildDeployIx,
  ORE_AUTOMATION_STRATEGIES,
} from "./instructions";
import { minerPda, automationPda, roundPda } from "./pda";
import type { DeployPlan } from "./planner";

export class OreRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OreRpcError";
  }
}

export class OreSimulationError extends Error {
  constructor(
    public readonly err: unknown,
    public readonly logs: string[],
  ) {
    super(`simulation failed: ${JSON.stringify(err)}`);
    this.name = "OreSimulationError";
    this.logs = logs;
  }
}

/** The blockhash expired before the transaction landed — nothing was spent. */
export class OreExpiredError extends Error {
  constructor(cause: unknown) {
    super(`transaction expired before landing: ${String(cause)}`);
    this.name = "OreExpiredError";
  }
}

/**
 * Squares the simulated deploy actually reached, from ore's end-of-deploy
 * log — `Round #<id>: deploying <sol> SOL to <K> squares` (deploy.rs
 * `sol_log`, emitted even when every square was skipped, K = 0). Returns
 * null when no such line exists. Deliberately regex-free string parsing:
 * the log format is fixed by the program, and structural markers are all
 * we need.
 */
export function parseDeployedSquareCount(logs: readonly string[]): number | null {
  for (const line of logs) {
    const trimmed = line.trim();
    // Program logs arrive as `Program log: Round #…`; accept the bare
    // form too by locating the marker anywhere in the line.
    const roundAt = trimmed.indexOf("Round #");
    if (roundAt === -1) continue;
    const deployAt = trimmed.indexOf(": deploying ", roundAt);
    if (deployAt === -1) continue;
    const afterAmount = trimmed.indexOf(" SOL to ", deployAt);
    if (afterAmount === -1) continue;
    const tail = trimmed.slice(afterAmount + " SOL to ".length);
    const end = tail.indexOf(" squares");
    if (end <= 0) continue;
    const digits = tail.slice(0, end);
    let allDigits = true;
    for (const ch of digits) {
      if (ch < "0" || ch > "9") {
        allDigits = false;
        break;
      }
    }
    if (allDigits) return Number(digits);
  }
  return null;
}

/**
 * R3 race guard (Item B): a competing transaction can snipe the user's
 * squares between our snapshot and the send — ORE then silently skips
 * every square while the bundled platform-fee transfer still charges. The
 * deploy log's square count is the on-chain truth from the simulation,
 * i.e. our last pre-sign look at chain state. Abort before the wallet is
 * ever asked to sign when the count disagrees with the plan — and when
 * the log is missing entirely, since a zero-op deploy can no longer be
 * ruled out (log-format drift should stop sends, not silently fund them).
 */
export function verifySimulationDeployCount(
  logs: readonly string[],
  expectedCount: number,
): void {
  const actual = parseDeployedSquareCount(logs);
  if (actual === expectedCount) return;
  if (actual === null) {
    throw new Error(
      "deploy log line not found in simulation output — aborting because a " +
        "zero-op deploy (fee charged, nothing deployed) cannot be ruled out",
    );
  }
  throw new Error(
    "Squares occupied by competing transaction; deploy aborted to save platform fee " +
      `(planned ${expectedCount} square${expectedCount === 1 ? "" : "s"}, ` +
      `simulation reached ${actual})`,
  );
}

/** Multiplier on the 75th-percentile priority fee: Normal / Fast / Turbo. */
export type FeeSpeed = 1 | 2 | 4;

export interface OreSnapshot {
  board: OreBoard;
  config: OreConfig;
  treasury: OreTreasury;
  /** `null` right after a reset, before the account is (re)created. */
  round: OreRound | null;
  /** `null` when the wallet has never deployed. */
  miner: OreMiner | null;
  /**
   * `null` when the wallet has no automation. Read for EVERY connected
   * wallet (§2): an existing automation of any executor mutates the manual
   * deploy path — custom executors fail the on-chain assert, permissionless
   * ones silently deploy the automation's plan from automation.balance
   * while the platform fee still lands. The planner blocks on this.
   */
  automation: OreAutomation | null;
  /**
   * Whether PLATFORM_FEE_RECIPIENT exists on-chain. A bundled fee transfer
   * to a non-existent system account must CREATE it, which requires the
   * transfer to cover rent-exemption — so an unfunded treasury makes every
   * floor-sized fee fail at simulation with InsufficientFundsForRent on the
   * recipient. Read in the same batch (no extra round trip) so the planner
   * can name the condition instead of leaking that error (live 2026-10-07).
   */
  feeRecipientExists: boolean;
  slot: bigint;
}

export interface PreparedTransaction {
  /** Unsigned v0 transaction — sign with the wallet, then send. */
  transaction: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
  /** CU consumed by the pre-sign simulation (diagnostics + CU budget). */
  unitsConsumed: number;
  cuLimit: number;
  cuPriceMicroLamports: number;
}

/** Matches the official client's flat deploy budget (ore-starter-app
 *  use_deploy_transaction.rs:70 / use_pro_deploy_transaction.rs:97); the
 *  real limit is still sized down from `unitsConsumed × 1.25` after the
 *  simulation. Must cover 25-square writes across miner/round arrays plus
 *  the round-opening entropy CPI — an under-sized placeholder makes the
 *  SIMULATION itself fail for a transaction that would have succeeded. */
const CU_PLACEHOLDER = 750_000;
/** Automate creates (or resizes) two PDAs + two system transfers — far
 *  lighter than a 25-square deploy; sized down from the simulation. */
const AUTOMATE_CU_PLACEHOLDER = 200_000;
/** Checkpoint + ClaimSOL + ClaimORE (incl. creating the ORE ATA) —
 *  well under this; sized down from the simulation like every send. */
const CLAIM_CU_PLACEHOLDER = 300_000;
const CU_FLOOR = 50_000;
const CU_HEADROOM_NUM = 1.25;
/** R6: the round-opening deploy pays an entropy CPI — budget extra units. */
const ROUND_OPENER_EXTRA_CU = 100_000;
const PRIORITY_FEE_MIN = 1_000;
const PRIORITY_FEE_MAX = 2_000_000;

export class OreClient {
  constructor(private readonly connection: Connection) {}

  /**
   * Batched state read. The round PDA depends on `board.round_id`, which is
   * only known after the first fetch — so this is two RPC round trips
   * (slot + 3–4 accounts, then the round), never five.
   */
  async fetchSnapshot(authority: PublicKey | null): Promise<OreSnapshot> {
    const minerAddress = authority !== null ? minerPda(authority) : null;
    const automationAddress = authority !== null ? automationPda(authority) : null;
    const [slot, core] = await Promise.all([
      this.connection.getSlot("confirmed"),
      this.connection.getMultipleAccountsInfo(
        [
          BOARD_ADDRESS,
          CONFIG_ADDRESS,
          TREASURY_ADDRESS,
          PLATFORM_FEE_RECIPIENT,
          ...(minerAddress ? [minerAddress] : []),
          ...(automationAddress ? [automationAddress] : []),
        ],
        "confirmed",
      ),
    ]);
    const [boardInfo, configInfo, treasuryInfo, feeRecipientInfo, minerInfo, automationInfo] = core;
    if (boardInfo === null || configInfo === null || treasuryInfo === null) {
      throw new OreRpcError(
        "ORE Board/Config/Treasury missing — the RPC endpoint is not mainnet-beta " +
          "(set VITE_ORE_RPC_URL) or the protocol moved",
      );
    }
    const board = decodeOreBoard(boardInfo.data);
    const roundInfo = await this.connection.getAccountInfo(roundPda(board.roundId), "confirmed");
    return {
      board,
      config: decodeOreConfig(configInfo.data),
      treasury: decodeOreTreasury(treasuryInfo.data),
      round: roundInfo !== null ? decodeOreRound(roundInfo.data) : null,
      miner: minerInfo !== null && minerAddress !== null ? decodeOreMiner(minerInfo.data) : null,
      automation:
        automationInfo !== null && automationAddress !== null
          ? decodeOreAutomation(automationInfo.data)
          : null,
      feeRecipientExists: feeRecipientInfo !== null,
      slot: BigInt(slot),
    };
  }

  /**
   * Assembles the deploy bundle. Simulates first (sigVerify off, fresh
   * blockhash), sizes the CU limit from `unitsConsumed × 1.25`, and prices
   * priority from the 75th percentile over the exact writable accounts.
   * Throws (never sends) when the simulation fails.
   */
  async buildDeployTransaction(args: {
    wallet: PublicKey;
    plan: DeployPlan;
    board: OreBoard;
    miner: OreMiner | null;
    speed?: FeeSpeed;
  }): Promise<PreparedTransaction> {
    const { wallet, plan, board, miner } = args;
    if (plan.blocker !== null || plan.mask === 0) {
      throw new OreRpcError(`deploy is blocked: ${plan.blocker ?? "empty mask"}`);
    }

    const assemble = (cuLimit: number, cuPrice: number, lamports: bigint): VersionedTransaction => {
      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
      ];
      if (lamports > 0n) {
        // Skipped entirely on a zero fee — never emit a 0-lamport transfer.
        ixs.push(
          SystemProgram.transfer({
            fromPubkey: wallet,
            toPubkey: PLATFORM_FEE_RECIPIENT,
            lamports,
          }),
        );
      }
      if (miner !== null) {
        // R4: Checkpoint is unconditional when the miner exists; its round
        // meta is the miner's STALE round, not the current one.
        ixs.push(buildCheckpointIx({ signer: wallet, authority: wallet, minerRoundId: miner.roundId }));
      }
      ixs.push(
        buildDeployIx({
          signer: wallet,
          authority: wallet,
          roundId: board.roundId,
          amountPerSquare: plan.amountPerSquare,
          mask: plan.mask,
        }),
      );
      return new VersionedTransaction(
        new TransactionMessage({
          payerKey: wallet,
          recentBlockhash: blockhash,
          instructions: ixs,
        }).compileToV0Message(),
      );
    };

    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const simulation = await this.connection.simulateTransaction(
      assemble(CU_PLACEHOLDER, 0, plan.platformFee),
      { sigVerify: false, replaceRecentBlockhash: true },
    );
    if (simulation.value.err !== null) {
      throw new OreSimulationError(simulation.value.err, simulation.value.logs ?? []);
    }
    // Item B: the simulation is the last pre-sign view of chain state —
    // abort when the squares were sniped between snapshot and here.
    verifySimulationDeployCount(simulation.value.logs ?? [], plan.eligibleSquares.length);
    const consumed = simulation.value.unitsConsumed ?? CU_FLOOR;
    let cuLimit = Math.max(CU_FLOOR, Math.ceil(consumed * CU_HEADROOM_NUM));
    if (board.endSlot === 18_446_744_073_709_551_615n) cuLimit += ROUND_OPENER_EXTRA_CU;

    const cuPrice = await this.priorityFeeMicroLamports(
      [BOARD_ADDRESS, CONFIG_ADDRESS, TREASURY_ADDRESS, roundPda(board.roundId), minerPda(wallet)],
      args.speed ?? 1,
    );
    return {
      transaction: assemble(cuLimit, cuPrice, plan.platformFee),
      blockhash,
      lastValidBlockHeight,
      unitsConsumed: consumed,
      cuLimit,
      cuPriceMicroLamports: cuPrice,
    };
  }

  /**
   * The miner as a Checkpoint would leave it — the winnings of its last
   * settled round recorded and its refined ORE synced — read from a
   * simulation's post-state (sigVerify off, nothing is sent). This is how
   * the rewards panel shows winnings the chain has not recorded yet without
   * re-deriving the round math. `null` when the simulation fails (the panel
   * then falls back to the stored balances).
   */
  async simulateCheckpointedMiner(wallet: PublicKey, minerRoundId: bigint): Promise<OreMiner | null> {
    const { blockhash } = await this.connection.getLatestBlockhash("confirmed");
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: wallet,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: CLAIM_CU_PLACEHOLDER }),
          buildCheckpointIx({ signer: wallet, authority: wallet, minerRoundId }),
        ],
      }).compileToV0Message(),
    );
    const simulation = await this.connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: "base64", addresses: [minerPda(wallet).toBase58()] },
    });
    const account = simulation.value.accounts?.[0];
    if (simulation.value.err !== null || account == null) return null;
    return decodeOreMiner(Buffer.from(account.data[0]!, "base64"));
  }

  /**
   * Claim SOL, ORE, or both in ONE transaction — no platform fee, ever
   * (§6: feeing a withdrawal of the user's own winnings is hostile). Shaped
   * like the official ore-starter-app claims:
   *
   *   ComputeBudget | ComputeBudget | Checkpoint | ClaimSOL? | ClaimORE?
   *
   * The Checkpoint records the miner's last settled round first, so its
   * winnings are claimed too; it is a no-op when already checkpointed.
   * ClaimORE takes `oreBps` of BOTH refined and unrefined ORE. With
   * `auto_return` on (ore's default) the Checkpoint itself pays the round's
   * SOL to the wallet, so a SOL claim can be the Checkpoint alone.
   */
  async buildClaimTransaction(
    wallet: PublicKey,
    claim: { sol: boolean; oreBps: bigint | null; minerRoundId: bigint | null },
  ): Promise<PreparedTransaction> {
    if (!claim.sol && claim.oreBps === null && claim.minerRoundId === null) {
      throw new OreRpcError("nothing to claim");
    }
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const ixs: TransactionInstruction[] = [];
    if (claim.minerRoundId !== null) {
      ixs.push(buildCheckpointIx({ signer: wallet, authority: wallet, minerRoundId: claim.minerRoundId }));
    }
    if (claim.sol) ixs.push(buildClaimSolIx(wallet));
    if (claim.oreBps !== null) ixs.push(buildClaimOreIx(wallet, claim.oreBps));
    const assemble = (cuLimit: number, cuPrice: number): VersionedTransaction =>
      new VersionedTransaction(
        new TransactionMessage({
          payerKey: wallet,
          recentBlockhash: blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
            ...ixs,
          ],
        }).compileToV0Message(),
      );

    const simulation = await this.connection.simulateTransaction(assemble(CLAIM_CU_PLACEHOLDER, 0), {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    if (simulation.value.err !== null) {
      throw new OreSimulationError(simulation.value.err, simulation.value.logs ?? []);
    }
    const consumed = simulation.value.unitsConsumed ?? CU_FLOOR;
    const cuLimit = Math.max(CU_FLOOR, Math.ceil(consumed * CU_HEADROOM_NUM));
    const cuPrice = await this.priorityFeeMicroLamports(
      [BOARD_ADDRESS, minerPda(wallet), ...(claim.oreBps !== null ? [TREASURY_ADDRESS] : [])],
      1,
    );
    return {
      transaction: assemble(cuLimit, cuPrice),
      blockhash,
      lastValidBlockHeight,
      unitsConsumed: consumed,
      cuLimit,
      cuPriceMicroLamports: cuPrice,
    };
  }

  /**
   * Automate setup / top-up: ONE atomic v0 transaction. With a non-zero
   * `platformFee` (our revenue — charged ONCE against the deposit; the
   * per-round `fee` on the automation goes to whichever public bot
   * executes each round, not to us) the shape is:
   *
   *   ComputeBudget | ComputeBudget | SystemProgram.transfer | Automate
   *
   * In the no-keeper design this transfer IS the fee mechanism — atomic
   * with the setup, so it lands iff the Automate lands. The stop variant
   * passes 0 (never fee a withdrawal).
   */
  async buildAutomateTransaction(args: {
    wallet: PublicKey;
    /** The permissionless sentinel for setup; the account's own for top-up; Pubkey.default for stop. */
    executor: PublicKey;
    amountPerSquare: bigint;
    deposit: bigint;
    /** The automation's per-round executor fee (flat lamports, to the bots). */
    fee: bigint;
    mask: number | bigint;
    reload?: bigint;
    /** OUR one-time platform fee on this deposit; 0n on stop. */
    platformFee?: bigint;
  }): Promise<PreparedTransaction> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const assemble = (cuLimit: number, cuPrice: number): VersionedTransaction => {
      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
      ];
      const platformFee = args.platformFee ?? 0n;
      if (platformFee > 0n) {
        // Skipped entirely on a zero fee — never emit a 0-lamport transfer.
        ixs.push(
          SystemProgram.transfer({
            fromPubkey: args.wallet,
            toPubkey: PLATFORM_FEE_RECIPIENT,
            lamports: platformFee,
          }),
        );
      }
      ixs.push(
        buildAutomateIx({
          authority: args.wallet,
          executor: args.executor,
          amountPerSquare: args.amountPerSquare,
          deposit: args.deposit,
          fee: args.fee,
          mask: args.mask,
          strategy: ORE_AUTOMATION_STRATEGIES.Preferred,
          reload: args.reload ?? 0n,
        }),
      );
      return new VersionedTransaction(
        new TransactionMessage({
          payerKey: args.wallet,
          recentBlockhash: blockhash,
          instructions: ixs,
        }).compileToV0Message(),
      );
    };

    const simulation = await this.connection.simulateTransaction(assemble(AUTOMATE_CU_PLACEHOLDER, 0), {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    if (simulation.value.err !== null) {
      throw new OreSimulationError(simulation.value.err, simulation.value.logs ?? []);
    }
    const consumed = simulation.value.unitsConsumed ?? CU_FLOOR;
    const cuLimit = Math.max(CU_FLOOR, Math.ceil(consumed * CU_HEADROOM_NUM));
    const cuPrice = await this.priorityFeeMicroLamports(
      [args.wallet, automationPda(args.wallet), minerPda(args.wallet)],
      1,
    );
    return {
      transaction: assemble(cuLimit, cuPrice),
      blockhash,
      lastValidBlockHeight,
      unitsConsumed: consumed,
      cuLimit,
      cuPriceMicroLamports: cuPrice,
    };
  }

  /**
   * User-side stop: `Automate` with `executor = Pubkey::default()` closes
   * the automation and refunds balance + rent to the wallet in the same
   * transaction (automate.rs:87-96) — no executor cooperation. The
   * program ignores every other argument on this path, but the bytes
   * carry the account's own honest values. No fee: it is a withdrawal.
   */
  async buildStopAutomationTransaction(
    wallet: PublicKey,
    automation: OreAutomation,
  ): Promise<PreparedTransaction> {
    return this.buildAutomateTransaction({
      wallet,
      executor: PublicKey.default,
      amountPerSquare: automation.amount,
      deposit: 0n,
      fee: automation.fee,
      mask: automation.mask,
      reload: automation.reload,
    });
  }

  /** 75th percentile over the given writable accounts, clamped, × speed. */
  private async priorityFeeMicroLamports(accounts: PublicKey[], speed: FeeSpeed): Promise<number> {
    let percentile = PRIORITY_FEE_MIN;
    try {
      const samples = await this.connection.getRecentPrioritizationFees({
        lockedWritableAccounts: accounts,
      });
      if (samples.length > 0) {
        const fees = samples.map((s) => s.prioritizationFee).sort((a, b) => a - b);
        const index = Math.min(fees.length - 1, Math.ceil(0.75 * (fees.length - 1)));
        percentile = fees[index]!;
      }
    } catch {
      // Priority-fee estimation is best-effort; the floor keeps the tx live.
    }
    const clamped = Math.min(Math.max(percentile, PRIORITY_FEE_MIN), PRIORITY_FEE_MAX);
    return clamped * speed;
  }

  /**
   * Sends an already-signed transaction and confirms it with the
   * block-height strategy. Atomicity: if this expires or fails, the
   * platform fee transfer did not land either.
   */
  async sendSignedTransaction(
    transaction: VersionedTransaction,
    blockhash: string,
    lastValidBlockHeight: number,
  ): Promise<string> {
    const raw = transaction.serialize();
    let signature: string;
    try {
      signature = await this.connection.sendRawTransaction(raw, { skipPreflight: false });
    } catch (err) {
      throw isBlockhashExpiry(err) ? new OreExpiredError(err) : err;
    }
    try {
      const confirmation = await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      if (confirmation.value.err !== null) {
        throw new Error(`transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }
    } catch (err) {
      if (isBlockhashExpiry(err)) throw new OreExpiredError(err);
      throw err;
    }
    return signature;
  }
}

function isBlockhashExpiry(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /block height exceeded|blockhash not found|transaction expired/i.test(message);
}
