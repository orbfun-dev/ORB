/**
 * Switchboard On-Demand plumbing, ported from the proven
 * `scripts/devnet/devnet-settle.ts` pipeline:
 *
 * - the 408-byte `RandomnessAccountData` decoder (repr(C), offsets probed
 *   live in phase 8);
 * - a lazily-loaded anchor `Program` handle for the Switchboard program
 *   (oracle selection + oracle account reads need it; the IDL fetch is
 *   once-per-process);
 * - the TEE reveal fetch from the oracle's HTTPS gateway, behind the URL
 *   guard, with bounded retries (the oracle needs a beat to sign after
 *   commit).
 */

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { type Wallet } from "@coral-xyz/anchor";
import { CrossbarClient, Gateway } from "@switchboard-xyz/common";
import { AnchorUtils, Oracle, Queue, State } from "@switchboard-xyz/on-demand";
import { getLutSigner, getLutKey } from "@switchboard-xyz/on-demand/dist/esm/utils/lookupTable.js";
import bs58 from "bs58";
import type { Logger } from "./log";
import { assertSafeGatewayUrl } from "./urlguard";

/** Read-only wallet stand-in — the Program handle needs one; the executor
 *  signs every crank transaction itself, so these never fire. */
function keeperWallet(keeper: Keypair): Wallet {
  return {
    publicKey: keeper.publicKey,
    payer: keeper,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      return tx;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
      return txs;
    },
  };
}

/** The 408-byte RandomnessAccountData offsets (repr(C), probed live). */
const RA = {
  discriminator: [10, 66, 229, 135, 220, 239, 217, 114],
  authority: [8, 40],
  queue: [40, 72],
  seedSlothash: [72, 104],
  seedSlot: [104, 112],
  oracle: [112, 144],
  revealSlot: [144, 152],
  value: [152, 184],
  /** Slot the lookup table was derived from — needed to find (and close)
   *  the LUT once the randomness account itself is gone. */
  lutSlot: [184, 192],
} as const;

export interface RandomnessView {
  authority: PublicKey;
  queue: PublicKey;
  seedSlothash: Uint8Array;
  seedSlot: bigint;
  oracle: PublicKey;
  revealSlot: bigint;
  value: Uint8Array;
  /** 0 when the account is shorter than the 480-byte deployed layout. */
  lutSlot: bigint;
}

export function decodeRandomnessView(data: Buffer): RandomnessView | null {
  if (data.length < RA.value[1]!) return null;
  if (!RA.discriminator.every((b, i) => data[i] === b)) return null;
  const pk = (r: readonly [number, number]) => new PublicKey(data.subarray(r[0], r[1]));
  const u64 = (r: readonly [number, number]) => data.readBigUInt64LE(r[0]);
  return {
    authority: pk(RA.authority),
    queue: pk(RA.queue),
    seedSlothash: Uint8Array.from(data.subarray(RA.seedSlothash[0], RA.seedSlothash[1])),
    seedSlot: u64(RA.seedSlot),
    oracle: pk(RA.oracle),
    revealSlot: u64(RA.revealSlot),
    value: Uint8Array.from(data.subarray(RA.value[0], RA.value[1])),
    lutSlot: data.length >= RA.lutSlot[1] ? u64(RA.lutSlot) : 0n,
  };
}

export function randomnessStatsKey(oracle: PublicKey, oracleProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("OracleRandomnessStats"), oracle.toBuffer()],
    oracleProgramId,
  )[0];
}

/** The gateway's TEE-signed reveal payload for a committed account. */
export interface RevealPayload {
  signature: Uint8Array;
  recoveryId: number;
  value: Uint8Array;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** AUDIT C-2: per-attempt and total budgets for the gateway reveal fetch. */
export const REVEAL_ATTEMPT_TIMEOUT_MS = 4_000;
export const REVEAL_FETCH_BUDGET_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`gateway timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Live Switchboard handle. `loadProgramFromConnection` performs its own
 * IDL fetches outside the RPC gateway's pacing — acceptable at settle
 * frequency (a handful of calls per round), and it is the exact code path
 * phase 8 proved on devnet.
 */
export class SwitchboardCtx {
  private readonly connection: Connection;
  private readonly keeper: Keypair;
  private readonly rpcUrl: string;
  private readonly logger: Logger;
  private readonly crossbar: CrossbarClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- anchor Program typing is irrelevant here.
  private programPromise: Promise<any> | null = null;

  constructor(
    connection: Connection,
    keeper: Keypair,
    rpcUrl: string,
    logger: Logger,
    crossbarUrl: string,
  ) {
    this.connection = connection;
    this.keeper = keeper;
    this.rpcUrl = rpcUrl;
    this.logger = logger;
    this.crossbar = new CrossbarClient(crossbarUrl);
  }

  /** The anchor Program handle for the pinned Switchboard deployment. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program(): Promise<any> {
    if (this.programPromise === null) {
      // AUDIT C-5: a rejected load must not be cached forever.
      this.programPromise = AnchorUtils.loadProgramFromConnection(
        this.connection,
        keeperWallet(this.keeper),
      ).catch((err: unknown) => {
        this.programPromise = null;
        throw err;
      });
    }
    return this.programPromise;
  }

  async programStateKey(): Promise<PublicKey> {
    return State.keyFromSeed(await this.program());
  }

  /** A queue-assigned oracle for the commit (round-robin on their side).
   *  The crossbar is passed explicitly: the SDK's default host is dead,
   *  and its fallback cost ~11 s per round (see `sbCrossbarUrl`). */
  async selectOracle(queue: PublicKey): Promise<PublicKey> {
    const program = await this.program();
    const started = Date.now();
    const { oracle, metadata } = await new Queue(program, queue).selectRandomnessOracle(
      this.crossbar,
    );
    this.logger.debug(
      { ms: Date.now() - started, tier: metadata.tier, oracle: oracle.pubkey.toBase58() },
      "oracle selected",
    );
    return oracle.pubkey;
  }

  /** The oracle's HTTPS gateway base URL, nulls trimmed. */
  async oracleGatewayUrl(oracle: PublicKey): Promise<string> {
    const program = await this.program();
    const data = await new Oracle(program, oracle).loadData();
    return Buffer.from(data.gatewayUri).toString().replace(/\0+$/, "");
  }

  /**
   * Fetch the reveal from the oracle gateway: URL-guarded, bounded retries
   * (~20 s worst case), `null` when the oracle never produced one.
   */
  async fetchReveal(
    gatewayUrl: string,
    randomnessAccount: PublicKey,
    view: RandomnessView,
  ): Promise<RevealPayload | null> {
    assertSafeGatewayUrl(gatewayUrl);
    // AUDIT C-2: the vendored gateway call sets no timeout, and the tick is
    // sequential — a gateway that never answers would stall lock,
    // auto-deposit and rollover behind it. Every attempt is bounded, and so
    // is the whole fetch.
    const deadline = Date.now() + REVEAL_FETCH_BUDGET_MS;
    for (let attempt = 1; attempt <= 10 && Date.now() < deadline; attempt += 1) {
      try {
        const reveal = await withTimeout(
          new Gateway(gatewayUrl).fetchRandomnessReveal({
            randomnessAccount,
            slothash: bs58.encode(Buffer.from(view.seedSlothash)),
            slot: Number(view.seedSlot),
            rpc: this.rpcUrl,
          }),
          Math.min(REVEAL_ATTEMPT_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
        );
        return {
          signature: Buffer.from(reveal.signature, "base64"),
          recoveryId: reveal.recovery_id,
          value: Buffer.from(reveal.value, "base64"),
        };
      } catch (err) {
        this.logger.debug({ attempt, err: String(err).slice(0, 120) }, "gateway not ready");
        await sleep(2_000);
      }
    }
    return null;
  }
}

/** LUT derivations for the create CPI (per-randomness-account). */
export function lutKeys(
  oracleProgramId: PublicKey,
  randomness: PublicKey,
  recentSlot: bigint,
): { lutSigner: PublicKey; lut: PublicKey } {
  const lutSigner = getLutSigner(oracleProgramId, randomness);
  return { lutSigner, lut: getLutKey(lutSigner, Number(recentSlot)) };
}

/** sha256("global:randomness_close_lut")[..8] — confirmed on the deployed
 *  devnet program by simulation (logs "Instruction: RandomnessCloseLut"). */
const RANDOMNESS_CLOSE_LUT_DISC = Buffer.from("ea0585cc372555de", "hex");
const ALT_PROGRAM_ID = new PublicKey("AddressLookupTab1e1111111111111111111111111");

/**
 * Switchboard's post-cooldown lookup-table close. Signed by the RANDOMNESS
 * KEYPAIR (the crank persisted it at create time); works after the
 * randomness account itself is closed — the LUT is only located through
 * it. The table must already be deactivated (our `close_randomness` does
 * that) and past the address-lookup-table cooldown, or the ALT program
 * refuses with "Lookup table is not deactivated".
 */
export function closeLutInstruction(
  oracleProgramId: PublicKey,
  randomness: PublicKey,
  lutSlot: bigint,
  recipient: PublicKey,
): TransactionInstruction {
  const { lutSigner, lut } = lutKeys(oracleProgramId, randomness, lutSlot);
  const slot = Buffer.alloc(8);
  slot.writeBigUInt64LE(lutSlot);
  return new TransactionInstruction({
    programId: oracleProgramId,
    data: Buffer.concat([RANDOMNESS_CLOSE_LUT_DISC, slot]),
    keys: [
      { pubkey: randomness, isSigner: true, isWritable: false },
      { pubkey: lut, isSigner: false, isWritable: true },
      { pubkey: lutSigner, isSigner: false, isWritable: false },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: ALT_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}
