/**
 * Synthetic Solana transaction fixtures in the json getTransaction
 * shape — only the fields the raffle reads (R2 classification) plus
 * enough realism to keep the decoders honest.
 *
 * ORB `emit!` events are base64(discriminator ++ borsh payload) log
 * lines; discriminators are pinned to packages/sdk/src/events.ts and
 * payloads serialized in events.rs declaration order.
 */

import bs58 from "bs58";
import { ORB_PROGRAM_ID } from "../../src/classify";

const DISC_DEPOSITED = Buffer.from("6f8d1a2da1236439", "hex");
const DISC_AUTO_DEPOSITED = Buffer.from("b359bee262d304fb", "hex");

/**
 * ORE `DeployEvent` inner instruction (base58 ix.data) — pinned to
 * regolith-labs/ore@48c203b program/src/deploy.rs: a self-CPI to the
 * `Log` instruction (disc 8) carrying the 120-byte `#[repr(C)]` POD:
 * disc(8) authority(32) amount(8) mask(8) round_id(8) signer(32)
 * strategy(8) total_squares(8) ts(8).
 */
export function oreDeployLogData(fields: {
  authority: string;
  signer: string;
  amount: bigint;
  mask: bigint;
  roundId: bigint;
  totalSquares: bigint;
  strategy?: bigint;
}): string {
  const event = Buffer.alloc(120);
  event.writeBigUInt64LE(2n, 0); // OreEvent::Deploy
  pubkey32(fields.authority).copy(event, 8);
  event.writeBigUInt64LE(fields.amount, 40);
  event.writeBigUInt64LE(fields.mask, 48);
  event.writeBigUInt64LE(fields.roundId, 56);
  pubkey32(fields.signer).copy(event, 64);
  event.writeBigUInt64LE(fields.strategy ?? 0xffffffffffffffffn, 96);
  event.writeBigUInt64LE(fields.totalSquares, 104);
  event.writeBigInt64LE(1_760_000_000n, 112);
  const carrier = Buffer.from([8]); // OreInstruction::Log — a one-byte steel tag
  return bs58.encode(Buffer.concat([carrier, event]));
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}
function i64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n);
  return b;
}
function pubkey32(base58: string): Buffer {
  // Every fixture wallet must be a REAL base58 pubkey so the decoded
  // event's player/owner round-trips to the claimed wallet string.
  const decoded = bs58.decode(base58);
  if (decoded.length !== 32) {
    throw new Error(`fixture pubkey must decode to 32 bytes: ${base58}`);
  }
  return Buffer.from(decoded);
}

/** `Deposited` — directive entry source `orb_game` (signed deposits). */
export function depositedLogLine(fields: {
  roundId: bigint;
  entryIndex?: number;
  player: string;
  amountLamports: bigint;
}): string {
  const payload = Buffer.concat([
    u64(fields.roundId),
    u32(fields.entryIndex ?? 0),
    pubkey32(fields.player),
    u64(fields.amountLamports),
    u64(0n), // ticketStart
    u64(1n), // ticketEnd
    u64(fields.amountLamports), // roundTotal
    i64(1_700_000_600n), // newEndTs
    Buffer.from([0]), // extended = false
  ]);
  return "Program data: " + Buffer.concat([DISC_DEPOSITED, payload]).toString("base64");
}

/** `AutoDeposited` — permissionless crank entry; attributes to `owner`. */
export function autoDepositedLogLine(fields: {
  roundId: bigint;
  entryIndex?: number;
  owner: string;
  escrow: string;
  amountLamports: bigint;
}): string {
  const payload = Buffer.concat([
    u64(fields.roundId),
    u32(fields.entryIndex ?? 0),
    pubkey32(fields.owner),
    pubkey32(fields.escrow),
    u64(fields.amountLamports),
    u64(0n), // tip
    u64(0n), // entryRent
    u64(0n), // ticketStart
    u64(1n), // ticketEnd
    u64(fields.amountLamports), // roundTotal
    u32(1), // roundsRemaining
  ]);
  return (
    "Program data: " + Buffer.concat([DISC_AUTO_DEPOSITED, payload]).toString("base64")
  );
}

export interface SyntheticTxOptions {
  signature: string;
  slot?: number;
  blockTime?: number;
  signers: string[];
  /** All account keys (signers included first). */
  accountKeys?: string[];
  logLines?: string[];
  innerInstructions?: Array<{ programId: string; data: string }>;
  preBalances?: number[];
  postBalances?: number[];
  preTokenBalances?: Array<Record<string, unknown>>;
  postTokenBalances?: Array<Record<string, unknown>>;
}

export function syntheticTx(opts: SyntheticTxOptions): any {
  const keys = opts.accountKeys ?? opts.signers;
  const accountKeys = keys.map((pubkey, i) => ({
    pubkey,
    signer: i < opts.signers.length,
    writable: i < opts.signers.length,
    source: "transaction",
  }));
  // Each inner group's parent top-level instruction is, by default, a call
  // to the same program (ORE's Deploy for an ORE Log CPI) — the real
  // shape AUDIT R-4 relies on. Tests that need another parent overwrite
  // `transaction.message.instructions`.
  const instructions = (opts.innerInstructions ?? []).map((ix) => ({
    programIdIndex: keys.indexOf(ix.programId),
    accounts: [],
    data: "",
  }));
  return {
    slot: opts.slot ?? 300_000_000,
    // "Now" by default: an event must postdate the epoch it is claimed in
    // (AUDIT R-5), and tests open their epochs at now().
    blockTime: opts.blockTime ?? Math.floor(Date.now() / 1000),
    transaction: { message: { accountKeys, instructions } },
    meta: {
      fee: 5000,
      preBalances: opts.preBalances ?? keys.map(() => 1_000_000_000),
      postBalances: opts.postBalances ?? keys.map(() => 1_000_000_000),
      preTokenBalances: opts.preTokenBalances ?? [],
      postTokenBalances: opts.postTokenBalances ?? [],
      // Real logs always sit inside runtime frame lines (AUDIT R-1 reads
      // them). Fixtures that pass bare event lines mean "the ORB program
      // emitted these"; fixtures that pass their own frames are left as-is.
      logMessages:
        opts.logLines === undefined
          ? []
          : opts.logLines.some((l) => / invoke \[\d+\]$/.test(l))
            ? opts.logLines
            : [`Program ${ORB_PROGRAM_ID} invoke [1]`, ...opts.logLines, `Program ${ORB_PROGRAM_ID} success`],
      innerInstructions: (opts.innerInstructions ?? []).map((ix, index) => ({
        index,
        instructions: [{ programId: ix.programId, data: ix.data }],
      })),
      loadedAddresses: undefined,
      err: null,
    },
  };
}
