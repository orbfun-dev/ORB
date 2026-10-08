/**
 * Test doubles for the ORE fee-wallet indexer: a fake chain holding the
 * fee recipient's transaction history (getSignaturesForAddress paging
 * semantics included) and a pg-backed store running the shipping SQL.
 */

import bs58 from "bs58";
import type { Pool } from "pg";
import { ORE_PROGRAM_ID } from "../../src/ore-event";
import { SYSTEM_PROGRAM_ID } from "../../src/endpoints/purchase";
import {
  minimumPlatformFee,
  runOreIndexer,
  type OreIndexerRun,
  type OreIndexerStore,
  type SignatureRef,
} from "../../src/ore-indexer";
import type { RaffleConfig } from "../../src/env";
import { FEE_RECIPIENT, pgClaimStore, testConfig } from "./raffle";
import { oreDeployLogData, syntheticTx } from "./tx";

const DEFAULT_RULE = {
  bps: testConfig().oreFeeBps,
  minLamports: BigInt(testConfig().oreFeeMinLamports),
  maxLamports: BigInt(testConfig().oreFeeMaxLamports),
};

function transferData(lamports: bigint): string {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0); // SystemInstruction::Transfer
  data.writeBigUInt64LE(lamports, 4);
  return bs58.encode(data);
}

let slotSeq = 400_000_000;

export interface DeployTxOptions {
  authority: string;
  /** Defaults to the authority (a manual deploy). */
  signer?: string;
  amountPerSquare: bigint;
  totalSquares: bigint;
  mask?: bigint;
  strategy?: bigint;
  /** `null` = no fee transfer at all; default = exactly the page's fee. */
  feeLamports?: bigint | null;
  /** Who pays the fee. Defaults to the signer. */
  feePayer?: string;
  /** Unix seconds. Defaults to now — after any epoch the test opened. */
  blockTime?: number;
}

/**
 * A deploy shaped like the page's: ComputeBudget omitted, then
 * SystemProgram.transfer(fee) top-level, then the ORE Deploy whose Log
 * self-CPI carries the DeployEvent.
 */
export function playorbDeployTx(signature: string, opts: DeployTxOptions): any {
  const signer = opts.signer ?? opts.authority;
  const feePayer = opts.feePayer ?? signer;
  const signers = feePayer === signer ? [signer] : [signer, feePayer];
  const keys = [...signers, FEE_RECIPIENT, SYSTEM_PROGRAM_ID, ORE_PROGRAM_ID];
  const spend = opts.amountPerSquare * opts.totalSquares;
  const fee =
    opts.feeLamports === undefined ? minimumPlatformFee(DEFAULT_RULE, spend) : opts.feeLamports;

  const tx = syntheticTx({
    signature,
    slot: (slotSeq += 1),
    blockTime: opts.blockTime ?? Math.floor(Date.now() / 1000),
    signers,
    accountKeys: keys,
    innerInstructions: [
      {
        programId: ORE_PROGRAM_ID,
        data: oreDeployLogData({
          authority: opts.authority,
          signer,
          amount: opts.amountPerSquare,
          mask: opts.mask ?? ((1n << opts.totalSquares) - 1n),
          roundId: 431_030n,
          totalSquares: opts.totalSquares,
          strategy: opts.strategy,
        }),
      },
    ],
  });
  const feeIxs =
    fee === null || fee === 0n
      ? []
      : [
          {
            programIdIndex: keys.indexOf(SYSTEM_PROGRAM_ID),
            accounts: [keys.indexOf(feePayer), keys.indexOf(FEE_RECIPIENT)],
            data: transferData(fee),
          },
        ];
  // The ORE Deploy is the top-level instruction after the fee transfer,
  // and its Log self-CPI is that instruction's inner group (AUDIT R-4).
  tx.transaction.message.instructions = [
    ...feeIxs,
    { programIdIndex: keys.indexOf(ORE_PROGRAM_ID), accounts: [], data: bs58.encode(Buffer.from([6])) },
  ];
  tx.meta.innerInstructions[0].index = feeIxs.length;
  return tx;
}

/** The fee recipient's history, oldest first, as the RPC would page it. */
export class FakeFeeChain {
  private history: Array<{ ref: SignatureRef; tx: any }> = [];
  /** Signatures listed but whose transaction is not served yet. */
  readonly unserved = new Set<string>();

  add(signature: string, tx: any, opts: { err?: unknown } = {}): void {
    this.history.push({
      ref: {
        signature,
        slot: Number(tx.slot),
        blockTime: tx.blockTime ?? null,
        err: opts.err ?? null,
      },
      tx,
    });
  }

  async listSignatures(opts: { until?: string; before?: string; limit: number }) {
    const newestFirst = [...this.history].reverse().map((h) => h.ref);
    let start = 0;
    if (opts.before !== undefined) {
      start = newestFirst.findIndex((r) => r.signature === opts.before) + 1;
    }
    const out: SignatureRef[] = [];
    for (let i = start; i < newestFirst.length && out.length < opts.limit; i += 1) {
      if (newestFirst[i].signature === opts.until) break;
      out.push(newestFirst[i]);
    }
    return out;
  }

  async fetchTransaction(signature: string) {
    if (this.unserved.has(signature)) return null;
    return this.history.find((h) => h.ref.signature === signature)?.tx ?? null;
  }
}

export function pgIndexerStore(pool: Pool): OreIndexerStore {
  const claim = pgClaimStore(pool);
  return {
    async getCursor(name) {
      const res = await pool.query(
        "SELECT last_signature, last_slot FROM raffle_indexer_cursors WHERE name = $1",
        [name],
      );
      const row = res.rows[0];
      return row ? { signature: row.last_signature, slot: Number(row.last_slot) } : null;
    },
    async advanceCursor(name, cursor) {
      await pool.query("SELECT raffle_advance_indexer_cursor($1, $2, $3)", [
        name,
        cursor.signature,
        cursor.slot,
      ]);
    },
    currentOpenEpoch: () => claim.currentOpenEpoch(),
    async earliestEpochStart() {
      const res = await pool.query("SELECT starts_at FROM raffle_epochs ORDER BY id LIMIT 1");
      return res.rows[0] ? new Date(res.rows[0].starts_at) : null;
    },
    submitEarnedEvent: (args) => claim.submitEarnedEvent(args),
  };
}

export function runIndexer(
  pool: Pool,
  chain: FakeFeeChain,
  config: RaffleConfig = testConfig(),
): Promise<OreIndexerRun> {
  return runOreIndexer({
    config,
    store: pgIndexerStore(pool),
    listSignatures: (opts) => chain.listSignatures(opts),
    fetchTransaction: (sig) => chain.fetchTransaction(sig),
  });
}
