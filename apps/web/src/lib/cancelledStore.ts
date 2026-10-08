/**
 * Wallet-scoped persistence for CANCELLED-round refund positions — the
 * third sibling of `lib/claims.ts` and `lib/refundStore.ts`.
 *
 * A cancelled round (oracle timeout, or `lock_round`'s sole-depositor
 * routing) owes every entry its full stake back until `refund_entry` pays
 * it. The live UI only tracks the ACTIVE round's book, and on devnet's
 * 60 s rounds the next round opens about a second after the cancel — so
 * the row the player was looking at used to vanish with
 * `state.entries`, money owed and no button left. The reducer keeps a
 * session map of cancel snapshots (RoundDataProvider); this module
 * mirrors it to localStorage keyed by the wallet so both the owed rows
 * and the paid RECEIPT survive reloads and reconnects.
 *
 * Records are HYDRATED CONSERVATIVELY: on wallet connect each stored
 * round is re-fetched and reconciled against the chain — entries that
 * still exist stay owed, entries that are gone became receipts, and a
 * round account that is gone entirely was fully refunded (the program
 * only permits `close_round` once every entry is closed). The account is
 * the authority; the cache only points at rounds worth checking.
 *
 * Stored entries carry exactly the fields the card's gates read
 * (index/player/amount/ticket range); the account-only fields
 * (depositTs/depositSlot/bump) rehydrate as zeros.
 */

import type { PlayerEntryAccountData } from "@orbit-jackpot/sdk";
import type { CancelledRound, RefundedEntry } from "../context/RoundDataProvider";

const KEY_PREFIX = "orbit:cancelled:v1:";

const keyFor = (wallet: string): string => `${KEY_PREFIX}${wallet}`;

interface StoredEntry {
  entryIndex: number;
  player: string;
  amountLamports: string;
  ticketStart: string;
  ticketEnd: string;
}

interface StoredRefunded {
  entryIndex: number;
  player: string;
  amountLamports: string;
}

interface StoredCancelledRound {
  roundId: string;
  endTs: string;
  entries: StoredEntry[];
  refunded: StoredRefunded[];
  /** Local ms — null while money is still owed. */
  receiptAt: number | null;
}

/** Safe under private mode / quota errors / SSR — persistence is best-effort. */
function readRaw(wallet: string): StoredCancelledRound[] {
  try {
    const raw = window.localStorage.getItem(keyFor(wallet));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is StoredCancelledRound =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as StoredCancelledRound).roundId === "string" &&
        Array.isArray((r as StoredCancelledRound).entries) &&
        Array.isArray((r as StoredCancelledRound).refunded),
    );
  } catch {
    return [];
  }
}

export function loadCancelledRounds(wallet: string): CancelledRound[] {
  return readRaw(wallet).flatMap((r) => {
    try {
      const roundId = BigInt(r.roundId);
      const entries: PlayerEntryAccountData[] = r.entries.map((e) => ({
        roundId,
        entryIndex: e.entryIndex,
        player: e.player,
        amountLamports: BigInt(e.amountLamports),
        ticketStart: BigInt(e.ticketStart),
        ticketEnd: BigInt(e.ticketEnd),
        depositTs: 0n,
        depositSlot: 0n,
        bump: 0,
      }));
      const refunded: RefundedEntry[] = r.refunded.map((e) => ({
        entryIndex: e.entryIndex,
        player: e.player,
        amountLamports: BigInt(e.amountLamports),
      }));
      return [
        {
          roundId,
          endTs: BigInt(r.endTs),
          entries,
          refunded,
          receiptAt: typeof r.receiptAt === "number" ? r.receiptAt : null,
        },
      ];
    } catch {
      return []; // corrupt record — drop, never crash the card
    }
  });
}

export function saveCancelledRounds(
  wallet: string,
  records: readonly CancelledRound[],
): void {
  try {
    const stored: StoredCancelledRound[] = records.map((r) => ({
      roundId: r.roundId.toString(),
      endTs: r.endTs.toString(),
      entries: r.entries.map((e) => ({
        entryIndex: e.entryIndex,
        player: e.player,
        amountLamports: e.amountLamports.toString(),
        ticketStart: e.ticketStart.toString(),
        ticketEnd: e.ticketEnd.toString(),
      })),
      refunded: r.refunded.map((e) => ({
        entryIndex: e.entryIndex,
        player: e.player,
        amountLamports: e.amountLamports.toString(),
      })),
      receiptAt: r.receiptAt,
    }));
    window.localStorage.setItem(keyFor(wallet), JSON.stringify(stored));
  } catch {
    // best-effort only
  }
}
