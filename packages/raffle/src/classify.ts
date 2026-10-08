/**
 * Transaction classification (R2) — every fact is derived from the
 * finalized transaction; nothing is taken from the caller.
 *
 * Sources (2026-10-07 amendment: the ORB token buy is retired — the
 * raffle earns via the game, ORE mining, and manual purchases only):
 *
 *  - orb_game:   `Deposited` / `AutoDeposited` emit! log events
 *  - ore_mining: ORE `DeployEvent` via the `Log` self-CPI (ore-event.ts)
 *
 * One transaction can legitimately carry several qualifying events (a
 * batched auto-deposit, an ORE deploy bundled with a claim). Qualifying
 * events get a canonical `event_index`: their 0-based ordinal in a fixed
 * scan order (inner instructions, then program log lines), which makes
 * the (signature, event_index) dedup key (R6) stable for replays.
 */

import bs58 from "bs58";
import { PROGRAM_ID as SDK_PROGRAM_ID, parseEventLog } from "../../sdk/src/index";
import {
  ORE_PROGRAM_ID,
  decodeOreLogInstruction,
  deploySpendLamports,
} from "./ore-event";

export type RaffleSource = "orb_game" | "ore_mining";

export interface ClassifiedEvent {
  eventIndex: number;
  source: RaffleSource;
  /** The wallet the entry is attributed to (never the executor). */
  wallet: string;
  solLamports: bigint;
  /** orb_game only — the R3 gate. */
  orbRoundId?: bigint;
}

export interface ClassifyOutcome {
  events: ClassifiedEvent[];
  /** The transaction's signer set (base58). */
  signers: string[];
  /** The ORB program participated ( Deposited/AutoDeposited may exist). */
  touchesOrbProgram: boolean;
}

/**
 * The ORB program whose events count — the SDK's cluster-selected id
 * (ORB_CLUSTER), so the mainnet raffle reads the mainnet program.
 */
export const ORB_PROGRAM_ID = SDK_PROGRAM_ID.toBase58();

/**
 * AUDIT R-1: `Program data:` lines carry no author — any program can
 * `sol_log_data` bytes that decode as our events. The runtime's own frame
 * lines (`Program <id> invoke [n]` … `Program <id> success|failed`) do
 * name the program, and only the runtime writes them. This returns, for
 * every log line, the program executing at that point (null outside any
 * frame), or null overall when the log was truncated — a truncated log
 * cannot be attributed, so nothing in it is trusted.
 */
export function attributeLogLines(logs: readonly string[]): Array<string | null> | null {
  const stack: string[] = [];
  const out: Array<string | null> = [];
  for (const line of logs) {
    if (line === "Log truncated") return null;
    const invoke = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      out.push(invoke[1]!);
      continue;
    }
    const exit = /^Program (\S+) (success|failed)/.exec(line);
    if (exit) {
      out.push(stack.length > 0 ? stack[stack.length - 1]! : null);
      if (stack.length > 0 && stack[stack.length - 1] === exit[1]) stack.pop();
      continue;
    }
    out.push(stack.length > 0 ? stack[stack.length - 1]! : null);
  }
  return out;
}

interface AccountKeyLike {
  pubkey: string;
  signer?: boolean;
}

/**
 * The program of top-level instruction `index`, in both RPC shapes (raw
 * json `instructions[].programIdIndex` and web3.js v0
 * `compiledInstructions[].programIdIndex`), resolving loaded addresses.
 */
export function topLevelProgramId(tx: any, staticKeys: string[], index: number): string | undefined {
  const message = tx.transaction?.message ?? {};
  const list: any[] = message.compiledInstructions ?? message.instructions ?? [];
  const ix = list[index];
  if (ix === undefined) return undefined;
  if (typeof ix.programId === "string") return ix.programId;
  const loaded = tx.meta?.loadedAddresses ?? {};
  const asKey = (k: any): string =>
    typeof k === "object" && k !== null && "pubkey" in k ? String(k.pubkey) : String(k);
  const all = [
    ...staticKeys,
    ...((loaded.writable ?? []) as any[]).map(asKey),
    ...((loaded.readonly ?? []) as any[]).map(asKey),
  ];
  return all[ix.programIdIndex];
}

/** The tx's account keys in BOTH RPC shapes, with signer flags where present. */
export function resolveKeys(tx: any): { keys: string[]; signers: string[] } {
  const message = tx.transaction.message;
  const asKey = (k: any): string =>
    typeof k === "object" && k !== null && "pubkey" in k ? String(k.pubkey) : String(k);

  const rawKeys: any[] = message.accountKeys ?? message.staticAccountKeys ?? [];
  const keys = rawKeys.map(asKey);
  // AUDIT R-12: a v0 transaction's lookup-table addresses follow the
  // static keys (writable, then readonly) in index space. Without them an
  // inner instruction whose program sits in a table resolved to
  // undefined and its event was dropped. jsonParsed accountKeys already
  // include them (each carries a `source`), so only append for raw shapes.
  const loaded = tx.meta?.loadedAddresses;
  const alreadyIncluded = rawKeys.some((k) => typeof k === "object" && k !== null && "source" in k);
  if (loaded && !alreadyIncluded) {
    keys.push(...((loaded.writable ?? []) as any[]).map(asKey), ...((loaded.readonly ?? []) as any[]).map(asKey));
  }

  let signers: string[];
  const flagged = rawKeys.filter((k) => typeof k === "object" && k?.signer === true);
  if (flagged.length > 0) {
    signers = flagged.map(asKey);
  } else {
    // Raw message shape: the first numRequiredSignatures static keys sign.
    const required = message.header?.numRequiredSignatures ?? 1;
    signers = keys.slice(0, Number(required));
  }
  // Lookup-table addresses are never signers: signers come from the
  // static keys only (above).
  return { keys, signers };
}

function innerProgramId(ix: any, keys: string[]): string | undefined {
  if (typeof ix.programId === "string") return ix.programId;
  if (typeof ix.programIdIndex === "number") return keys[ix.programIdIndex];
  return undefined;
}

/**
 * Classifies one finalized transaction for one claimed wallet. Events
 * attributed to any other wallet are dropped: the claimed wallet must be
 * the beneficiary (R2 step 3, with the escrow/automation exception —
 * attribution to the authorized owner/authority is the whole point of
 * those events).
 */
export function classifyTransaction(
  tx: any,
  claimedWallet: string,
): ClassifyOutcome {
  const { events, signers, touchesOrbProgram } = candidateEvents(tx, claimedWallet);
  return authorizeAndFilter(events, signers, touchesOrbProgram, claimedWallet);
}

/**
 * Every ORB-game deposit in `tx`, for EVERY wallet, with the same
 * tx-wide `eventIndex` classifyTransaction assigns (AUDIT R-10) — so an
 * indexer award and a claim of the same deposit dedup on
 * (signature, event_index). Wallet attribution is classifyTransaction's:
 * the depositor for `Deposited`, the escrow OWNER for `AutoDeposited`.
 * No authorization step: an indexer is not acting for a claimant.
 */
export function orbDepositEvents(tx: any): ClassifiedEvent[] {
  const { events } = candidateEvents(tx, "");
  const out: ClassifiedEvent[] = [];
  for (const [txIndex, e] of events.entries()) {
    if (e.source !== "orb_game") continue;
    out.push({
      eventIndex: txIndex,
      source: e.source,
      wallet: e.wallet,
      solLamports: e.solLamports,
      orbRoundId: e.orbRoundId,
    });
  }
  return out;
}

function candidateEvents(
  tx: any,
  claimedWallet: string,
): { events: ClassifiedIndex[]; signers: string[]; touchesOrbProgram: boolean } {
  const { keys, signers } = resolveKeys(tx);
  const events: ClassifiedIndex[] = [];

  // ── 1. inner instructions: ORE Log-carried DeployEvents (R4) ──
  // AUDIT R-4: ORE's DeployEvent is a self-CPI to its own `Log`
  // instruction, so a genuine one always sits under a TOP-LEVEL ORE
  // instruction (the Deploy). A `Log` CPI issued from inside any other
  // program's instruction is not a deploy, whatever its bytes say.
  const innerGroups = (tx.meta?.innerInstructions ?? []) as Array<{
    index: number;
    instructions: Array<Record<string, unknown>>;
  }>;
  for (const group of innerGroups) {
    if (topLevelProgramId(tx, keys, group.index) !== ORE_PROGRAM_ID) continue;
    for (const ix of group.instructions) {
      if (innerProgramId(ix, keys) !== ORE_PROGRAM_ID) continue;
      const data = typeof ix.data === "string" ? bs58.decode(ix.data) : undefined;
      if (!data) continue;
      const deploy = decodeOreLogInstruction(Buffer.from(data));
      if (deploy === null) continue;
      const solLamports = deploySpendLamports(deploy);
      if (solLamports <= 0n) continue; // zero-square deploy — nothing spent
      events.push({
        source: "ore_mining",
        wallet: deploy.authority, // R4: authority, never signer
        solLamports,
        viaSignerOrBeneficiary: deploy.authority === claimedWallet,
      });
    }
  }

  // ── 2. program log lines: ORB emit! events ──
  let touchesOrbProgram = keys.includes(ORB_PROGRAM_ID);
  const LOG_PREFIX = "Program data: ";
  const logs = (tx.meta?.logMessages ?? []) as string[];
  const owners = attributeLogLines(logs) ?? logs.map(() => null);
  for (let i = 0; i < logs.length; i += 1) {
    const line = logs[i]!;
    if (!line.startsWith(LOG_PREFIX)) continue;
    // AUDIT R-1: only lines emitted while the ORB program is the
    // innermost executing frame are ORB events.
    if (owners[i] !== ORB_PROGRAM_ID) continue;
    let event: ReturnType<typeof parseEventLog>;
    try {
      event = parseEventLog(Buffer.from(line.slice(LOG_PREFIX.length), "base64"));
    } catch {
      continue; // malformed foreign payload — never fatal
    }
    if (event === null) continue;
    if (event.name === "Deposited") {
      events.push({
        source: "orb_game",
        wallet: event.data.player,
        solLamports: event.data.amountLamports,
        orbRoundId: event.data.roundId,
        viaSignerOrBeneficiary: true, // the depositor signs the deposit
      });
    } else if (event.name === "AutoDeposited") {
      events.push({
        source: "orb_game",
        wallet: event.data.owner, // §6.1.1: owner, NOT escrow
        solLamports: event.data.amountLamports,
        orbRoundId: event.data.roundId,
        viaSignerOrBeneficiary: event.data.owner === claimedWallet,
      });
    }
  }

  return { events, signers, touchesOrbProgram };
}

function authorizeAndFilter(
  events: ClassifiedIndex[],
  signers: string[],
  touchesOrbProgram: boolean,
  claimedWallet: string,
): ClassifyOutcome {
  // ── authorization (R2 step 3): signer OR attributed beneficiary ──
  const authorized =
    signers.includes(claimedWallet) ||
    events.some((e) => e.viaSignerOrBeneficiary && e.wallet === claimedWallet);
  if (!authorized) {
    return { events: [], signers, touchesOrbProgram };
  }

  // Keep only the claimed wallet's events. AUDIT R-10: the canonical
  // index is the event's position among ALL candidate events in the
  // transaction, not among the claimed wallet's — a batched auto-deposit
  // carries several owners, and per-wallet numbering gave each of them
  // index 0, so (signature, event_index) dedup dropped every owner but
  // the first to claim.
  const qualifying: ClassifiedEvent[] = [];
  for (const [txIndex, e] of events.entries()) {
    if (e.wallet !== claimedWallet) continue;
    qualifying.push({
      eventIndex: txIndex,
      source: e.source,
      wallet: e.wallet,
      solLamports: e.solLamports,
      orbRoundId: e.orbRoundId,
    });
  }
  return { events: qualifying, signers, touchesOrbProgram };
}

interface ClassifiedIndex extends Omit<ClassifiedEvent, "eventIndex"> {
  viaSignerOrBeneficiary: boolean;
}
