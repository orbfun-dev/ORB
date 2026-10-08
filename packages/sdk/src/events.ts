/**
 * Event wire decoding and subscriptions for all 21 on-chain events.
 *
 * The program uses BOTH anchor transports (events.rs is the source of
 * truth) — the client must speak both or it silently loses events:
 *
 * - `emit_cpi!` (RoundSettled, MegaPotTriggered, PrizeClaimed — the
 *   settlement-critical trio that must survive log truncation): the event
 *   is NOT written to program logs but chained after an 8-byte tag as
 *   instruction data of a self-CPI to the program. The anchor 0.32
 *   client's `Program.addEventListener` parses logs only and therefore
 *   never fires for these; the inner-instruction path below implements
 *   the correct transport instead.
 * - `emit!` (RoundOpened, Deposited, RoundLocked, RandomnessRequested,
 *   RandomnessCommitted, RoundCancelled, EntryRefunded, MegaPotContribution,
 *   FeesSwept, UnclaimedPrizeSwept, RoundWindowRolled): written to program logs as
 *   `Program data: <base64(discriminator ++ borsh payload)>` — parsed off
 *   the transaction's log messages.
 *
 * Both transports meet in one subscription:
 *
 *   connection.onLogs(programId)
 *     → getTransaction(signature, confirmed)
 *     → scan meta.innerInstructions for PartiallyDecodedInstruction with
 *       data = EVENT_IX_TAG ++ event discriminator ++ borsh payload   (cpi)
 *     → scan meta.logMessages for "Program data: <base64>" lines       (logs)
 *     → decode and dispatch.
 *
 * Wire format (anchor-lang 0.32.2 source of record):
 * - `EVENT_IX_TAG`: the first 8 bytes of sha256("anchor:event"), little-
 *   endian on the wire (u64 0x1d9acb512ea545e4) — see
 *   anchor-lang/src/event.rs.
 * - event discriminator: sha256("event:<CamelCase>")[..8], identical to the
 *   discriminators embedded in the canonical IDL and the Rust `Event::data`
 *   fixture — three-way pinned.
 * - payload: borsh, little-endian, field order = Rust declaration order.
 */

import bs58 from "bs58";
import { Connection, PublicKey } from "@solana/web3.js";
import { BorshReader } from "./codec";
import { PROGRAM_ID } from "./pda";

/** sha256("anchor:event")[..8] as LE wire bytes (hex, byte order as sent).
 *
 * Pinned against anchor-lang 0.32.2 source (`EVENT_IX_TAG: u64 =
 * 0x1d9acb512ea545e4`, serialized little-endian) AND against a live devnet
 * settle transaction — an earlier typo (…51ac…) made the CPI transport
 * unable to match ANY real emit_cpi! instruction; only self-referential
 * tests had exercised it.
 */
export const EVENT_IX_TAG = "e445a52e51cb9a1d";

/** sha256("event:<Name>")[..8] — matches the IDL and Rust `Event::data`. */
export const EVENT_DISCRIMINATORS: Readonly<Record<string, string>> = {
  RoundOpened: "63ade4488e396db2",
  Deposited: "6f8d1a2da1236439",
  RoundLocked: "133a5b9d184ccf07",
  RandomnessRequested: "0a40b71d683f5a95",
  RandomnessCommitted: "7d962e4766fbfd6c",
  RoundSettled: "f9e142369dc8eade",
  PrizeClaimed: "d596c04cc721d426",
  RoundCancelled: "ee8d69afb69e0f07",
  EntryRefunded: "225282745d8bbcea",
  MegaPotContribution: "cdab51f23fa847a0",
  MegaPotTriggered: "5bfee10b2ac8a6a3",
  FeesSwept: "60da73884aaacaac",
  UnclaimedPrizeSwept: "564c51cce827e6c9",
  EscrowFunded: "e4f3a64a16a79df4",
  EscrowWithdrawn: "2bceae2f69dbd8ef",
  AutoDeposited: "b359bee262d304fb",
  EscrowDepleted: "ee877c4c45e56216",
  EntryRefundPaid: "6fee49089029f0da",
  RoundDustSwept: "c06695cae1fd99b1",
  AccountOpened: "fa59274323777e3f",
  EconomicsMigrated: "418dea38f25b8a05",
  MegaPotDrainedPreflight: "4268f2e8d7ec51e4",
  RoundWindowRolled: "feaa3ae7dabab2ec",
} as const;

/** `RoundCancelled::reason` wire encodings (events.rs). */
export const CANCEL_REASON_ZERO_DEPOSITS = 0;
export const CANCEL_REASON_SOLE_DEPOSITOR = 1;
export const CANCEL_REASON_ORACLE_TIMEOUT = 2;

export interface RoundOpenedEvent {
  roundId: bigint;
  startTs: bigint;
  endTs: bigint;
}

/** One deposit — the participants feed and the anti-snipe clock cue. */
export interface DepositedEvent {
  roundId: bigint;
  entryIndex: number;
  player: string;
  amountLamports: bigint;
  ticketStart: bigint;
  ticketEnd: bigint;
  roundTotalLamports: bigint;
  /** The (possibly extended) countdown target after this deposit. */
  newEndTs: bigint;
  /** `true` when this deposit moved the anti-snipe timer. */
  extended: boolean;
}

export interface RoundLockedEvent {
  roundId: bigint;
  lockTs: bigint;
  lockSlot: bigint;
  totalLamports: bigint;
  entryCount: number;
}

export interface RandomnessRequestedEvent {
  roundId: bigint;
  randomnessAccount: string;
  commitSlot: bigint;
}

/** The round PDA committed its pinned account via the commit CPI (exactly-once). */
export interface RandomnessCommittedEvent {
  roundId: bigint;
  randomnessAccount: string;
  oracle: string;
  seedSlot: bigint;
}

/**
 * The economic core — carries everything needed to recompute the outcome.
 * Phase 11 semantics: `winnerPayout` is the 9% winner slice (it was the
 * 98% residual before), the residual lives in `refundPool`, and a trigger
 * splits its payable between `megaAwarded` (winner) and `megaFieldPool`
 * (every entry, pro-rata).
 */
export interface RoundSettledEvent {
  roundId: bigint;
  winningTicket: bigint;
  totalLamports: bigint;
  winnerPayout: bigint;
  refundPool: bigint;
  adminCut: bigint;
  megaCut: bigint;
  megaTriggered: boolean;
  megaAwarded: bigint;
  megaFieldPool: bigint;
  megaPotRemaining: bigint;
  randomnessSeedSlot: bigint;
  randomnessValue: Uint8Array;
}

export interface PrizeClaimedEvent {
  roundId: bigint;
  entryIndex: number;
  winner: string;
  winningTicket: bigint;
  winnerPayout: bigint;
  megaAwarded: bigint;
}

export interface RoundCancelledEvent {
  roundId: bigint;
  /** One of the CANCEL_REASON_* constants. */
  reason: number;
}

export interface EntryRefundedEvent {
  roundId: bigint;
  entryIndex: number;
  player: string;
  amountLamports: bigint;
}

export interface MegaPotContributionEvent {
  roundId: bigint;
  amountLamports: bigint;
  accruedAfter: bigint;
}

export interface MegaPotTriggeredEvent {
  roundId: bigint;
  cycleIndex: bigint;
  awarded: bigint;
  fieldPool: bigint;
  retained: bigint;
}

export interface FeesSweptEvent {
  amountLamports: bigint;
  destination: string;
}

export interface UnclaimedPrizeSweptEvent {
  roundId: bigint;
  amountLamports: bigint;
  megaPotAccruedAfter: bigint;
}

/** An escrow was funded (or re-funded) and its terms set (Phase 10). */
export interface EscrowFundedEvent {
  owner: string;
  escrow: string;
  amountLamports: bigint;
  perRoundLamports: bigint;
  maxRounds: number;
  roundsRemaining: number;
  autoReinvest: boolean;
  /** Post-call on-chain balance (rent floor included). */
  totalLamports: bigint;
}

/** The owner withdrew spendable escrow lamports. */
export interface EscrowWithdrawnEvent {
  owner: string;
  escrow: string;
  amountLamports: bigint;
  /** Post-withdrawal on-chain balance (rent floor included). */
  remainingLamports: bigint;
}

/** A permissionless crank entered an escrow into a round. */
export interface AutoDepositedEvent {
  roundId: bigint;
  entryIndex: number;
  owner: string;
  escrow: string;
  amountLamports: bigint;
  tipLamports: bigint;
  entryRentLamports: bigint;
  ticketStart: bigint;
  ticketEnd: bigint;
  roundTotalLamports: bigint;
  roundsRemaining: number;
}

/** An escrow's budget ran dry — demote without polling it. */
export interface EscrowDepletedEvent {
  owner: string;
  escrow: string;
  lastRoundId: bigint;
}

/** One entry drew its pro-rata refund + field share at `close_entry` (Phase 11). */
export interface EntryRefundPaidEvent {
  roundId: bigint;
  entryIndex: number;
  player: string;
  /** The entry's stake, for context. */
  amountLamports: bigint;
  /** Pro-rata share of the round's `refundPool`. */
  refundLamports: bigint;
  /** Pro-rata share of `megaFieldPool` (0 unless the round triggered). */
  megaFieldLamports: bigint;
}

/** The two pro-rata pools' rounding dust swept to the Mega-Pot at close_round. */
export interface RoundDustSweptEvent {
  roundId: bigint;
  amountLamports: bigint;
  megaPotAccruedAfter: bigint;
}

/** A player profile was born; the one-time fee seeded the Mega-Pot (Phase 11.6). */
export interface AccountOpenedEvent {
  owner: string;
  escrow: string;
  feeLamports: bigint;
  rentLamports: bigint;
  megaPotAccruedAfter: bigint;
}

/** ADR-11: the one-way economics cutover ran (`economics_version` = 2). */
export interface EconomicsMigratedEvent {
  fromVersion: number;
  toVersion: number;
  winnerBps: number;
  refundBps: number;
  feeBpsAdmin: number;
  feeBpsMega: number;
  megaAwardBps: number;
  megaFieldBps: number;
  megaTriggerModulus: number;
  megaPayoutCapBps: number;
  accountOpenFeeLamports: bigint;
}

/** ADR-11 preflight: the pre-v2 Mega-Pot drained to the treasury. */
export interface MegaPotDrainedPreflightEvent {
  amountLamports: bigint;
  destinationTreasury: string;
  megaPotAccruedAfter: bigint;
}

/**
 * An empty `Open` round's deposit window rolled forward in place
 * (Phase 12): same accounts, same parked rent, no state change — the
 * idle-burn fix's on-chain footprint.
 */
export interface RoundWindowRolledEvent {
  roundId: bigint;
  /** The new window start — `now` at roll time (R2: both timestamps move). */
  startTs: bigint;
  /** The new window end — `now + round_duration_secs`. */
  endTs: bigint;
  /** `0` = lock sweep, `1` = first-deposit revival (ROLL_REASON_*). */
  reason: number;
}

export type OrbitEvent =
  | { name: "RoundOpened"; data: RoundOpenedEvent }
  | { name: "Deposited"; data: DepositedEvent }
  | { name: "RoundLocked"; data: RoundLockedEvent }
  | { name: "RandomnessRequested"; data: RandomnessRequestedEvent }
  | { name: "RandomnessCommitted"; data: RandomnessCommittedEvent }
  | { name: "RoundSettled"; data: RoundSettledEvent }
  | { name: "PrizeClaimed"; data: PrizeClaimedEvent }
  | { name: "RoundCancelled"; data: RoundCancelledEvent }
  | { name: "EntryRefunded"; data: EntryRefundedEvent }
  | { name: "MegaPotContribution"; data: MegaPotContributionEvent }
  | { name: "MegaPotTriggered"; data: MegaPotTriggeredEvent }
  | { name: "FeesSwept"; data: FeesSweptEvent }
  | { name: "UnclaimedPrizeSwept"; data: UnclaimedPrizeSweptEvent }
  | { name: "EscrowFunded"; data: EscrowFundedEvent }
  | { name: "EscrowWithdrawn"; data: EscrowWithdrawnEvent }
  | { name: "AutoDeposited"; data: AutoDepositedEvent }
  | { name: "EscrowDepleted"; data: EscrowDepletedEvent }
  | { name: "EntryRefundPaid"; data: EntryRefundPaidEvent }
  | { name: "RoundDustSwept"; data: RoundDustSweptEvent }
  | { name: "AccountOpened"; data: AccountOpenedEvent }
  | { name: "EconomicsMigrated"; data: EconomicsMigratedEvent }
  | { name: "MegaPotDrainedPreflight"; data: MegaPotDrainedPreflightEvent }
  | { name: "RoundWindowRolled"; data: RoundWindowRolledEvent };

export type OrbitEventName = OrbitEvent["name"];

const TAG_BYTES = Buffer.from(EVENT_IX_TAG, "hex");

/** Reverse map: discriminator hex → event name. */
const DISC_TO_NAME: ReadonlyMap<string, OrbitEventName> = new Map(
  Object.entries(EVENT_DISCRIMINATORS).map(([name, disc]) => [
    disc,
    name as OrbitEventName,
  ]),
);

/**
 * Decodes a known event name's borsh payload. Shared by both wire forms
 * (cpi instruction data / program log line); throws on malformed payloads.
 */
function decodeEvent(name: OrbitEventName, payload: Buffer): OrbitEvent {
  const r = new BorshReader(payload);

  switch (name) {
    case "RoundOpened":
      return {
        name: "RoundOpened",
        data: {
          roundId: r.u64Le("roundId"),
          startTs: r.i64Le("startTs"),
          endTs: r.i64Le("endTs"),
        },
      };
    case "Deposited":
      return {
        name: "Deposited",
        data: {
          roundId: r.u64Le("roundId"),
          entryIndex: r.u32Le("entryIndex"),
          player: r.pubkey("player"),
          amountLamports: r.u64Le("amount"),
          ticketStart: r.u64Le("ticketStart"),
          ticketEnd: r.u64Le("ticketEnd"),
          roundTotalLamports: r.u64Le("roundTotal"),
          newEndTs: r.i64Le("newEndTs"),
          extended: r.bool("extended"),
        },
      };
    case "RoundLocked":
      return {
        name: "RoundLocked",
        data: {
          roundId: r.u64Le("roundId"),
          lockTs: r.i64Le("lockTs"),
          lockSlot: r.u64Le("lockSlot"),
          totalLamports: r.u64Le("totalLamports"),
          entryCount: r.u32Le("entryCount"),
        },
      };
    case "RandomnessRequested":
      return {
        name: "RandomnessRequested",
        data: {
          roundId: r.u64Le("roundId"),
          randomnessAccount: r.pubkey("randomnessAccount"),
          commitSlot: r.u64Le("commitSlot"),
        },
      };
    case "RandomnessCommitted":
      return {
        name: "RandomnessCommitted",
        data: {
          roundId: r.u64Le("roundId"),
          randomnessAccount: r.pubkey("randomnessAccount"),
          oracle: r.pubkey("oracle"),
          seedSlot: r.u64Le("seedSlot"),
        },
      };
    case "RoundSettled":
      return {
        name: "RoundSettled",
        data: {
          roundId: r.u64Le("roundId"),
          winningTicket: r.u64Le("winningTicket"),
          totalLamports: r.u64Le("totalLamports"),
          winnerPayout: r.u64Le("winnerPayout"),
          refundPool: r.u64Le("refundPool"),
          adminCut: r.u64Le("adminCut"),
          megaCut: r.u64Le("megaCut"),
          megaTriggered: r.bool("megaTriggered"),
          megaAwarded: r.u64Le("megaAwarded"),
          megaFieldPool: r.u64Le("megaFieldPool"),
          megaPotRemaining: r.u64Le("megaPotRemaining"),
          randomnessSeedSlot: r.u64Le("randomnessSeedSlot"),
          randomnessValue: r.fixedBytes(32, "randomnessValue"),
        },
      };
    case "PrizeClaimed":
      return {
        name: "PrizeClaimed",
        data: {
          roundId: r.u64Le("roundId"),
          entryIndex: r.u32Le("entryIndex"),
          winner: r.pubkey("winner"),
          winningTicket: r.u64Le("winningTicket"),
          winnerPayout: r.u64Le("winnerPayout"),
          megaAwarded: r.u64Le("megaAwarded"),
        },
      };
    case "RoundCancelled":
      return {
        name: "RoundCancelled",
        data: {
          roundId: r.u64Le("roundId"),
          reason: r.u8("reason"),
        },
      };
    case "EntryRefunded":
      return {
        name: "EntryRefunded",
        data: {
          roundId: r.u64Le("roundId"),
          entryIndex: r.u32Le("entryIndex"),
          player: r.pubkey("player"),
          amountLamports: r.u64Le("amount"),
        },
      };
    case "MegaPotContribution":
      return {
        name: "MegaPotContribution",
        data: {
          roundId: r.u64Le("roundId"),
          amountLamports: r.u64Le("amount"),
          accruedAfter: r.u64Le("accruedAfter"),
        },
      };
    case "MegaPotTriggered":
      return {
        name: "MegaPotTriggered",
        data: {
          roundId: r.u64Le("roundId"),
          cycleIndex: r.u64Le("cycleIndex"),
          awarded: r.u64Le("awarded"),
          fieldPool: r.u64Le("fieldPool"),
          retained: r.u64Le("retained"),
        },
      };
    case "FeesSwept":
      return {
        name: "FeesSwept",
        data: {
          amountLamports: r.u64Le("amount"),
          destination: r.pubkey("destination"),
        },
      };
    case "UnclaimedPrizeSwept":
      return {
        name: "UnclaimedPrizeSwept",
        data: {
          roundId: r.u64Le("roundId"),
          amountLamports: r.u64Le("amount"),
          megaPotAccruedAfter: r.u64Le("megaPotAccruedAfter"),
        },
      };
    case "EscrowFunded":
      return {
        name: "EscrowFunded",
        data: {
          owner: r.pubkey("owner"),
          escrow: r.pubkey("escrow"),
          amountLamports: r.u64Le("amount"),
          perRoundLamports: r.u64Le("perRoundLamports"),
          maxRounds: r.u32Le("maxRounds"),
          roundsRemaining: r.u32Le("roundsRemaining"),
          autoReinvest: r.bool("autoReinvest"),
          totalLamports: r.u64Le("totalLamports"),
        },
      };
    case "EscrowWithdrawn":
      return {
        name: "EscrowWithdrawn",
        data: {
          owner: r.pubkey("owner"),
          escrow: r.pubkey("escrow"),
          amountLamports: r.u64Le("amount"),
          remainingLamports: r.u64Le("remaining"),
        },
      };
    case "AutoDeposited":
      return {
        name: "AutoDeposited",
        data: {
          roundId: r.u64Le("roundId"),
          entryIndex: r.u32Le("entryIndex"),
          owner: r.pubkey("owner"),
          escrow: r.pubkey("escrow"),
          amountLamports: r.u64Le("amount"),
          tipLamports: r.u64Le("tip"),
          entryRentLamports: r.u64Le("entryRent"),
          ticketStart: r.u64Le("ticketStart"),
          ticketEnd: r.u64Le("ticketEnd"),
          roundTotalLamports: r.u64Le("roundTotal"),
          roundsRemaining: r.u32Le("roundsRemaining"),
        },
      };
    case "EscrowDepleted":
      return {
        name: "EscrowDepleted",
        data: {
          owner: r.pubkey("owner"),
          escrow: r.pubkey("escrow"),
          lastRoundId: r.u64Le("lastRoundId"),
        },
      };
    case "EntryRefundPaid":
      return {
        name: "EntryRefundPaid",
        data: {
          roundId: r.u64Le("roundId"),
          entryIndex: r.u32Le("entryIndex"),
          player: r.pubkey("player"),
          amountLamports: r.u64Le("amount"),
          refundLamports: r.u64Le("refund"),
          megaFieldLamports: r.u64Le("megaField"),
        },
      };
    case "RoundDustSwept":
      return {
        name: "RoundDustSwept",
        data: {
          roundId: r.u64Le("roundId"),
          amountLamports: r.u64Le("amount"),
          megaPotAccruedAfter: r.u64Le("megaPotAccruedAfter"),
        },
      };
    case "AccountOpened":
      return {
        name: "AccountOpened",
        data: {
          owner: r.pubkey("owner"),
          escrow: r.pubkey("escrow"),
          feeLamports: r.u64Le("feeLamports"),
          rentLamports: r.u64Le("rentLamports"),
          megaPotAccruedAfter: r.u64Le("megaPotAccruedAfter"),
        },
      };
    case "EconomicsMigrated":
      return {
        name: "EconomicsMigrated",
        data: {
          fromVersion: r.u8("fromVersion"),
          toVersion: r.u8("toVersion"),
          winnerBps: r.u16Le("winnerBps"),
          refundBps: r.u16Le("refundBps"),
          feeBpsAdmin: r.u16Le("feeBpsAdmin"),
          feeBpsMega: r.u16Le("feeBpsMega"),
          megaAwardBps: r.u16Le("megaAwardBps"),
          megaFieldBps: r.u16Le("megaFieldBps"),
          megaTriggerModulus: r.u32Le("megaTriggerModulus"),
          megaPayoutCapBps: r.u32Le("megaPayoutCapBps"),
          accountOpenFeeLamports: r.u64Le("accountOpenFeeLamports"),
        },
      };
    case "MegaPotDrainedPreflight":
      return {
        name: "MegaPotDrainedPreflight",
        data: {
          amountLamports: r.u64Le("amount"),
          destinationTreasury: r.pubkey("destinationTreasury"),
          megaPotAccruedAfter: r.u64Le("megaPotAccruedAfter"),
        },
      };
    case "RoundWindowRolled":
      return {
        name: "RoundWindowRolled",
        data: {
          roundId: r.u64Le("roundId"),
          startTs: r.i64Le("startTs"),
          endTs: r.i64Le("endTs"),
          reason: r.u8("reason"),
        },
      };
  }
}

/**
 * Decodes one `emit_cpi!` event instruction (tag ++ discriminator ++
 * payload). Returns `null` for anything that is not a recognizable Orbit
 * event — the self-CPI pattern is anchor-wide, so foreign programs
 * sharing a transaction are expected and skipped, not errors.
 */
export function parseEventInstruction(data: Buffer): OrbitEvent | null {
  if (data.length < 16 || !data.subarray(0, 8).equals(TAG_BYTES)) {
    return null;
  }
  const discriminator = data.subarray(8, 16).toString("hex");
  const name = DISC_TO_NAME.get(discriminator);
  if (name === undefined) {
    // An anchor event-cpi from a foreign program sharing the transaction.
    return null;
  }
  return decodeEvent(name, data.subarray(16));
}

/**
 * Decodes one `emit!` program-log event (discriminator ++ payload — the
 * base64 body of a `Program data:` line). Same foreign-program tolerance
 * as the cpi path: an unknown discriminator is skipped, not an error.
 */
export function parseEventLog(data: Buffer): OrbitEvent | null {
  if (data.length < 8) {
    return null;
  }
  const discriminator = data.subarray(0, 8).toString("hex");
  const name = DISC_TO_NAME.get(discriminator);
  if (name === undefined) {
    return null;
  }
  return decodeEvent(name, data.subarray(8));
}

/** Context around one delivered event. */
export interface OrbitEventEnvelope {
  event: OrbitEvent;
  slot: number;
  signature: string;
}

type EventCallback = (envelope: OrbitEventEnvelope) => void;

/** Context attached to feed failures surfaced through `onError`. */
export interface OrbitEventErrorContext {
  /** The transaction the feed was processing, when known. */
  signature?: string;
}

/** Options for {@link OrbitEventFeed}. */
export interface OrbitEventFeedOptions {
  /**
   * Failure hook: fetch exhaustion, RPC errors, malformed event payloads,
   * and consumer-callback throws. The feed never throws — this is the only
   * error surface. Never throws out of the feed; assignment is safe at any
   * time. Without it, failures are silent by design of the caller.
   */
  onError?: (error: Error, context: OrbitEventErrorContext) => void;
  /** Base retry delay for transaction fetches; grows linearly per attempt. */
  retryMs?: number;
}

const FETCH_ATTEMPTS = 5;
const DEFAULT_RETRY_MS = 400;

/** web3.js's parsed-transaction shape, without dragging in its union maze. */
type ParsedTx = NonNullable<Awaited<ReturnType<Connection["getTransaction"]>>>;

/**
 * The transaction's account keys as base58 strings, covering both the
 * legacy parsed shape (`accountKeys: string[] | {pubkey}[]`) and the
 * versioned shape (`staticAccountKeys` + `meta.loadedAddresses`). Some
 * module graphs also hand back String OBJECTS for the legacy keys —
 * coerce defensively.
 */
function resolveAccountKeys(tx: ParsedTx): string[] {
  const message = (tx.transaction as { message?: unknown } | undefined)?.message as
    | { accountKeys?: unknown[]; staticAccountKeys?: unknown[] }
    | undefined;
  const asKey = (k: unknown): string => {
    if (typeof k === "object" && k !== null && "pubkey" in k) {
      return String((k as { pubkey: unknown }).pubkey);
    }
    return String(k);
  };
  const keys = (message?.accountKeys ?? message?.staticAccountKeys ?? []).map(asKey);
  const loaded = tx.meta?.loadedAddresses as
    | { writable?: unknown[]; readonly?: unknown[] }
    | undefined;
  if (loaded !== undefined) {
    keys.push(...(loaded.writable ?? []).map(asKey), ...(loaded.readonly ?? []).map(asKey));
  }
  return keys;
}

/**
 * Inner-instruction program id in BOTH RPC shapes: the jsonParsed
 * `PartiallyDecodedInstruction` (`programId` string) and the RAW form
 * (`programIdIndex` into the message account keys — e.g.
 * api.devnet.solana.com).
 */
function resolveInnerProgramId(
  ix: Record<string, unknown>,
  accountKeys: string[],
): string | undefined {
  if (typeof ix.programId === "string") return ix.programId;
  if (typeof ix.programIdIndex === "number") return accountKeys[ix.programIdIndex];
  return undefined;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Live event feed over one multiplexed `onLogs` subscription.
 *
 * A notification fires before the transaction is confirmable — each
 * signature is fetched with bounded retries at `confirmed` commitment
 * (a transaction whose `meta` is still null counts as not-yet-available
 * and retries too). Delivery guarantees:
 *
 * - a signature is dispatched at most once (seen-ring), but is only
 *   marked seen after a successful fetch — an exhausted signature stays
 *   retryable so a later re-drive can pick it up;
 * - concurrent notifications for one signature coalesce (`inFlight`);
 * - one malformed event payload never drops its sibling instructions
 *   (`RoundSettled` and `MegaPotTriggered` share one transaction);
 * - the feed never rejects: every failure goes to {@link onError}.
 */
export class OrbitEventFeed {
  /** Failure hook; may be reassigned at any time (constructor option wins initially). */
  onError?: (error: Error, context: OrbitEventErrorContext) => void;

  private readonly connection: Connection;
  private readonly programId: PublicKey;
  private readonly retryMs: number;
  private readonly listeners = new Map<OrbitEventName, Set<EventCallback>>();
  private readonly seen = new Set<string>();
  private readonly inFlight = new Set<string>();
  private seenOrder: string[] = [];
  private logsSubscription: number | null = null;
  private listenerSeq = 0;
  private readonly listenerIndex = new Map<number, [OrbitEventName, EventCallback]>();

  constructor(
    connection: Connection,
    programId: PublicKey = PROGRAM_ID,
    options: OrbitEventFeedOptions = {},
  ) {
    this.connection = connection;
    this.programId = programId;
    this.onError = options.onError;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  }

  /** Subscribe to one event name; returns a listener id for `off`. */
  async on(name: OrbitEventName, callback: EventCallback): Promise<number> {
    if (!this.listeners.has(name)) {
      this.listeners.set(name, new Set());
    }
    this.listeners.get(name)!.add(callback);
    const id = this.listenerSeq++;
    this.listenerIndex.set(id, [name, callback]);
    await this.ensureSubscribed();
    return id;
  }

  async off(id: number): Promise<void> {
    const entry = this.listenerIndex.get(id);
    if (!entry) return;
    const [name, callback] = entry;
    this.listenerIndex.delete(id);
    const set = this.listeners.get(name);
    if (!set) return;
    set.delete(callback);
    if (set.size === 0) this.listeners.delete(name);
    if (this.listenerIndex.size === 0 && this.logsSubscription !== null) {
      await this.connection.removeOnLogsListener(this.logsSubscription);
      this.logsSubscription = null;
    }
  }

  private async ensureSubscribed(): Promise<void> {
    if (this.logsSubscription !== null) return;
    this.logsSubscription = this.connection.onLogs(
      this.programId,
      (logs, ctx) => {
        if (logs.err || logs.signature === undefined) return;
        // deliver never rejects; the void is safe by contract, not by luck.
        void this.deliver(logs.signature, ctx.slot);
      },
      "confirmed",
    );
  }

  private raiseError(err: unknown, context: OrbitEventErrorContext): void {
    const error = asError(err);
    try {
      this.onError?.(error, context);
    } catch {
      // a broken consumer hook must not break the feed
    }
  }

  /** Fetches the transaction and dispatches every Orbit event inside it. */
  private async deliver(signature: string, slot: number): Promise<void> {
    if (this.seen.has(signature) || this.inFlight.has(signature)) return;
    this.inFlight.add(signature);
    try {
      const { tx, lastError } = await this.fetchTransaction(signature);
      if (tx === null) {
        // Not marked seen: the signature stays retryable by a later
        // notification or reconnect sweep. This is the one path where the
        // feed may drop events — surface it, never swallow it.
        const reason = lastError === undefined ? "" : ` (last error: ${asError(lastError).message})`;
        this.raiseError(
          new Error(
            `transaction ${signature} not fetchable after ${FETCH_ATTEMPTS} attempts${reason} — events possibly missed`,
          ),
          { signature },
        );
        return;
      }
      this.markSeen(signature);
      this.dispatch(tx, signature, slot);
    } catch (err) {
      this.raiseError(err, { signature });
    } finally {
      this.inFlight.delete(signature);
    }
  }
  /**
   * Fetches with bounded retries until the transaction is available WITH
   * metadata. `meta === null` is a transient RPC state for freshly
   * confirmed transactions — retryable, not terminal.
   */
  private async fetchTransaction(
    signature: string,
  ): Promise<{ tx: ParsedTx | null; lastError?: unknown }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
      try {
        const tx = await this.connection.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        if (tx !== null && tx.meta !== null) {
          return { tx };
        }
      } catch (err) {
        // RPC hiccup (rate limit, timeout) — retry like not-yet-available,
        // but remember the cause for the exhaustion error.
        lastError = err;
      }
      await sleep(attempt * this.retryMs);
    }
    return { tx: null, lastError };
  }

  /** One decoded event → every matching listener; isolated failures. */
  private emitToListeners(event: OrbitEvent, signature: string, slot: number): void {
    const envelope: OrbitEventEnvelope = { event, slot, signature };
    for (const cb of this.listeners.get(event.name) ?? []) {
      try {
        cb(envelope);
      } catch (err) {
        this.raiseError(err, { signature });
      }
    }
  }

  /**
   * Scans one fetched transaction for Orbit events on BOTH wire forms:
   * `emit_cpi!` self-instructions (RoundSettled, MegaPotTriggered,
   * PrizeClaimed) and `emit!` `Program data:` log lines (everything
   * else). An event can only ride one transport, so there is no overlap.
   *
   * Inner instructions arrive in TWO shapes depending on the RPC (see
   * `resolveInnerProgramId`) — both are resolved against the message's
   * account keys.
   */
  private dispatch(tx: ParsedTx, signature: string, slot: number): void {
    const accountKeys = resolveAccountKeys(tx);
    const innerGroups = (tx.meta?.innerInstructions ?? []) as Array<{
      instructions: Array<Record<string, unknown>>;
    }>;
    for (const inner of innerGroups) {
      for (const ix of inner.instructions) {
        const data = typeof ix.data === "string" ? ix.data : undefined;
        if (data === undefined) continue;
        if (resolveInnerProgramId(ix, accountKeys) !== this.programId.toString()) continue;
        try {
          const event = parseEventInstruction(bs58.decode(data));
          if (event === null) continue;
          this.emitToListeners(event, signature, slot);
        } catch (err) {
          // One malformed event payload (known discriminator, truncated
          // body) must not drop its sibling instructions — the settle
          // transaction carries RoundSettled AND MegaPotTriggered.
          this.raiseError(err, { signature });
        }
      }
    }

    // `emit!` events: anchor writes them as program-log lines
    // "Program data: <base64(discriminator ++ payload)>". The whole
    // transaction's logs arrive together — foreign anchor programs in a
    // shared transaction are filtered by discriminator, same as the cpi
    // path.
    const LOG_PREFIX = "Program data: ";
    for (const line of tx.meta?.logMessages ?? []) {
      if (!line.startsWith(LOG_PREFIX)) continue;
      try {
        const event = parseEventLog(Buffer.from(line.slice(LOG_PREFIX.length), "base64"));
        if (event === null) continue;
        this.emitToListeners(event, signature, slot);
      } catch (err) {
        this.raiseError(err, { signature });
      }
    }
  }

  private markSeen(signature: string): void {
    this.seen.add(signature);
    this.seenOrder.push(signature);
    if (this.seenOrder.length > 512) {
      for (const stale of this.seenOrder.splice(0, this.seenOrder.length - 512)) {
        this.seen.delete(stale);
      }
    }
  }
}
