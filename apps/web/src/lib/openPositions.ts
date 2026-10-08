/**
 * Every round that still owes this wallet money, read straight from the
 * chain — the rewards card's ground truth.
 *
 * The live feed only credits rounds the page WATCHED settle (the active
 * round and the one before it), and the per-wallet localStorage book only
 * remembers what was watched while that wallet was connected. On
 * 2026-10-08 an auto-play escrow played six rounds in seven minutes; all
 * six settled owing 0.606 SOL to `chumAA…`'s escrow, and the card listed
 * none of it.
 *
 * So the card also asks the chain: every still-open `PlayerEntry` whose
 * `player` is the wallet OR its escrow PDA (two filtered program-account
 * reads), then the rounds those entries belong to (one batched read). An
 * entry that still exists in a settled or cancelled round IS money owed —
 * `close_entry` / `refund_entry` delete the account when they pay.
 */

import type { GetProgramAccountsFilter } from "@solana/web3.js";
import {
  ACCOUNT_SIZES,
  decodePlayerEntry,
  decodeRound,
  roundKey,
  type OrbitJackpotClient,
  type PlayerEntryAccountData,
  type RoundData,
} from "@orbit-jackpot/sdk";
import type { CancelledRound, ClaimableRound, RefundRound } from "../context/RoundDataProvider";
import { escrowAddressOf } from "./identity";

/** `player_entry.rs`: discriminator 8 · round_id 8 · entry_index 4 → player. */
const ENTRY_PLAYER_OFFSET = 20;
/** getMultipleAccounts' per-call ceiling. */
const BATCH = 100;

export interface OpenPositions {
  refunds: RefundRound[];
  claims: ClaimableRound[];
  cancelled: CancelledRound[];
}

/**
 * Pure: the card's records implied by this wallet's open entries and their
 * rounds. Rounds still in play are skipped (the live feed owns them), as
 * are entries whose round account is gone.
 */
export function recordsFromOpenEntries(
  rounds: ReadonlyMap<bigint, RoundData>,
  entries: readonly PlayerEntryAccountData[],
): OpenPositions {
  const byRound = new Map<bigint, PlayerEntryAccountData[]>();
  for (const e of entries) {
    const list = byRound.get(e.roundId) ?? [];
    list.push(e);
    byRound.set(e.roundId, list);
  }
  const out: OpenPositions = { refunds: [], claims: [], cancelled: [] };
  const ids = [...byRound.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const id of ids) {
    const round = rounds.get(id);
    if (round === undefined) continue;
    const mine = byRound.get(id)!.sort((a, b) => a.entryIndex - b.entryIndex);
    if (round.state === "settled") {
      out.refunds.push({
        roundId: id,
        refundPool: round.refundPool,
        megaFieldPool: round.megaFieldPool,
        totalLamports: round.totalLamports,
        winningTicket: round.winningTicket,
        prizeClaimed: round.prizeClaimed,
        settleTs: round.settleTs,
        entries: mine,
      });
      const won = mine.find(
        (e) => round.winningTicket >= e.ticketStart && round.winningTicket < e.ticketEnd,
      );
      if (won !== undefined && !round.prizeClaimed) {
        out.claims.push({
          roundId: id,
          winner: won.player,
          entryIndex: won.entryIndex,
          winningTicket: round.winningTicket,
          totalLamports: round.totalLamports,
          winnerPayout: round.winnerPayout,
          megaAwarded: round.megaAwarded,
          megaTriggered: round.megaTriggered,
          settleTs: round.settleTs,
          prizeClaimed: false,
        });
      }
    } else if (round.state === "cancelled") {
      out.cancelled.push({ roundId: id, endTs: round.endTs, entries: mine, refunded: [], receiptAt: null });
    }
  }
  return out;
}

async function openEntriesOf(
  client: OrbitJackpotClient,
  player: string,
): Promise<PlayerEntryAccountData[]> {
  const filters: GetProgramAccountsFilter[] = [
    { dataSize: ACCOUNT_SIZES.PlayerEntry! },
    { memcmp: { offset: ENTRY_PLAYER_OFFSET, bytes: player } },
  ];
  const accounts = await client.connection.getProgramAccounts(client.programId, {
    filters,
    commitment: "confirmed",
  });
  return accounts.map(({ account }) => decodePlayerEntry(account.data));
}

/**
 * Reads this wallet's open positions from the chain. Throws when the RPC
 * refuses (some public endpoints reject program-account scans) — the
 * caller keeps whatever the live feed and storage already know.
 */
export async function scanOpenPositions(
  client: OrbitJackpotClient,
  wallet: string,
): Promise<OpenPositions> {
  const [direct, escrow] = await Promise.all([
    openEntriesOf(client, wallet),
    openEntriesOf(client, escrowAddressOf(wallet)),
  ]);
  const entries = [...direct, ...escrow];
  const ids = [...new Set(entries.map((e) => e.roundId))];
  const rounds = new Map<bigint, RoundData>();
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const infos = await client.connection.getMultipleAccountsInfo(
      chunk.map((id) => roundKey(id)),
      "confirmed",
    );
    infos.forEach((info, j) => {
      if (info !== null) rounds.set(chunk[j]!, decodeRound(info.data));
    });
  }
  return recordsFromOpenEntries(rounds, entries);
}

