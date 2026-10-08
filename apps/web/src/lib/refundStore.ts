/**
 * Wallet-scoped persistence for settled-round refund positions — the
 * refund twin of `lib/claims.ts`. The chain owes a refund until an entry's
 * `close_entry` pays it, but the live UI only tracks the ACTIVE round's
 * book: the instant round N+1 opens, round N's entries leave the state
 * tree and its refund row used to vanish with them. The reducer keeps a
 * session map of refund snapshots (RoundDataProvider); this module mirrors
 * it to localStorage keyed by the wallet so the rows survive reloads and
 * reconnects.
 *
 * Records are HYDRATED CONSERVATIVELY: on wallet connect each stored round
 * is re-fetched and kept only while the round account still exists, is
 * still settled, and still holds unclosed entries — the account is the
 * authority, the cache only points at rounds worth checking.
 *
 * Stored entries carry exactly the fields the card's gates read
 * (index/player/amount/ticket range); the account-only fields
 * (depositTs/depositSlot/bump) rehydrate as zeros.
 */

import type { PlayerEntryAccountData } from "@orbit-jackpot/sdk";
import type { RefundRound } from "../context/RoundDataProvider";

const KEY_PREFIX = "orbit:refunds:v1:";

const keyFor = (wallet: string): string => `${KEY_PREFIX}${wallet}`;

interface StoredRefundEntry {
  entryIndex: number;
  player: string;
  amountLamports: string;
  ticketStart: string;
  ticketEnd: string;
}

interface StoredRefundRound {
  roundId: string;
  refundPool: string;
  megaFieldPool: string;
  totalLamports: string;
  winningTicket: string;
  prizeClaimed: boolean;
  settleTs: string;
  entries: StoredRefundEntry[];
}

/** Safe under private mode / quota errors / SSR — persistence is best-effort. */
function readRaw(wallet: string): StoredRefundRound[] {
  try {
    const raw = window.localStorage.getItem(keyFor(wallet));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is StoredRefundRound =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as StoredRefundRound).roundId === "string" &&
        Array.isArray((r as StoredRefundRound).entries),
    );
  } catch {
    return [];
  }
}

export function loadRefundRounds(wallet: string): RefundRound[] {
  return readRaw(wallet).flatMap((r) => {
    try {
      return [
        {
          roundId: BigInt(r.roundId),
          refundPool: BigInt(r.refundPool),
          megaFieldPool: BigInt(r.megaFieldPool),
          totalLamports: BigInt(r.totalLamports),
          winningTicket: BigInt(r.winningTicket),
          prizeClaimed: r.prizeClaimed,
          settleTs: BigInt(r.settleTs),
          entries: r.entries.map((e) => ({
            roundId: BigInt(r.roundId),
            entryIndex: e.entryIndex,
            player: e.player,
            amountLamports: BigInt(e.amountLamports),
            ticketStart: BigInt(e.ticketStart),
            ticketEnd: BigInt(e.ticketEnd),
            depositTs: 0n,
            depositSlot: 0n,
            bump: 0,
          })),
        },
      ];
    } catch {
      return []; // corrupt record — drop, never crash the card
    }
  });
}

export function saveRefundRounds(wallet: string, records: readonly RefundRound[]): void {
  try {
    const stored: StoredRefundRound[] = records.map((r) => ({
      roundId: r.roundId.toString(),
      refundPool: r.refundPool.toString(),
      megaFieldPool: r.megaFieldPool.toString(),
      totalLamports: r.totalLamports.toString(),
      winningTicket: r.winningTicket.toString(),
      prizeClaimed: r.prizeClaimed,
      settleTs: r.settleTs.toString(),
      entries: r.entries.map((e) => ({
        entryIndex: e.entryIndex,
        player: e.player,
        amountLamports: e.amountLamports.toString(),
        ticketStart: e.ticketStart.toString(),
        ticketEnd: e.ticketEnd.toString(),
      })),
    }));
    window.localStorage.setItem(keyFor(wallet), JSON.stringify(stored));
  } catch {
    // best-effort only
  }
}
