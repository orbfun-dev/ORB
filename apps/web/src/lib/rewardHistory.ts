/**
 * The rewards card's HISTORY — money the chain already paid this wallet,
 * kept for the last {@link HISTORY_MAX_ROUNDS} rounds and shown only when
 * the player asks for it.
 *
 * It replaces the "Refunded" receipt row, which sat in the card's main
 * column for ten minutes after the keeper paid a cancellation — so a
 * player looking at "what can I claim?" kept seeing money that was no
 * longer claimable. Paid things belong in a ledger; the main column is
 * for what is still owed.
 *
 * Inputs, in order of authority:
 *  - the payout EVENTS this session observed (`state.payouts` —
 *    `EntryRefunded`, `EntryRefundPaid`, `PrizeClaimed`), filtered to the
 *    wallet's two identities;
 *  - the reconciliations the reload path already performs (a stored owed
 *    entry that is gone on chain WAS paid — see RoundDataProvider).
 *
 * Wallet-scoped in localStorage, best-effort: private mode or a quota
 * error just means the history starts empty.
 */

import type { PayoutRecord } from "../context/RoundDataProvider";

/** Paid-out rounds kept. Older rounds fall off as new ones arrive. */
export const HISTORY_MAX_ROUNDS = 10;

/** One payout — the same shape the reducer logs. */
export type HistoryItem = PayoutRecord;

/** One history row: everything a round paid this wallet. */
export interface HistoryRound {
  roundId: bigint;
  items: HistoryItem[];
  /** Total paid, across every item. */
  lamports: bigint;
  /** Of `lamports`, the part paid to the escrow PDA (auto-play). */
  escrowLamports: bigint;
  /** Local ms of the newest item — row ordering and the "ago" label. */
  at: number;
}

const KEY_PREFIX = "orbit:history:v1:";
const keyFor = (wallet: string): string => `${KEY_PREFIX}${wallet}`;

const sameItem = (a: HistoryItem, b: HistoryItem): boolean =>
  a.kind === b.kind && a.roundId === b.roundId && a.entryIndex === b.entryIndex;

/**
 * Merges new payouts into the ledger: duplicates dropped (an event replay
 * and a reload reconciliation can describe the same payout), then only
 * the newest {@link HISTORY_MAX_ROUNDS} rounds kept. Returns the SAME
 * array when nothing changed, so callers can skip a write.
 */
export function mergeHistory(
  existing: readonly HistoryItem[],
  incoming: Iterable<HistoryItem>,
): readonly HistoryItem[] {
  const fresh: HistoryItem[] = [];
  for (const item of incoming) {
    if (item.lamports <= 0n) continue;
    if (existing.some((e) => sameItem(e, item)) || fresh.some((e) => sameItem(e, item))) continue;
    fresh.push(item);
  }
  if (fresh.length === 0) return existing;
  const all = [...existing, ...fresh];
  const keep = new Set(
    [...new Set(all.map((i) => i.roundId))]
      .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
      .slice(0, HISTORY_MAX_ROUNDS),
  );
  return all.filter((i) => keep.has(i.roundId));
}

/** One row per round, newest round first. `wallet` splits the escrow part. */
export function groupHistory(
  items: readonly HistoryItem[],
  wallet: string | null,
): HistoryRound[] {
  const byRound = new Map<bigint, HistoryRound>();
  for (const item of items) {
    const row = byRound.get(item.roundId) ?? {
      roundId: item.roundId,
      items: [],
      lamports: 0n,
      escrowLamports: 0n,
      at: 0,
    };
    row.items.push(item);
    row.lamports += item.lamports;
    if (wallet !== null && item.player !== wallet) row.escrowLamports += item.lamports;
    row.at = Math.max(row.at, item.at);
    byRound.set(item.roundId, row);
  }
  return [...byRound.values()].sort((a, b) =>
    a.roundId > b.roundId ? -1 : a.roundId < b.roundId ? 1 : 0,
  );
}

interface StoredItem {
  kind: HistoryItem["kind"];
  roundId: string;
  entryIndex: number;
  player: string;
  lamports: string;
  at: number;
}

const KINDS: ReadonlySet<string> = new Set(["refund", "settledRefund", "prize"]);

export function loadHistory(wallet: string): readonly HistoryItem[] {
  try {
    const raw = window.localStorage.getItem(keyFor(wallet));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((r: StoredItem) => {
      try {
        if (typeof r !== "object" || r === null || !KINDS.has(r.kind)) return [];
        return [
          {
            kind: r.kind,
            roundId: BigInt(r.roundId),
            entryIndex: Number(r.entryIndex),
            player: String(r.player),
            lamports: BigInt(r.lamports),
            at: typeof r.at === "number" ? r.at : 0,
          },
        ];
      } catch {
        return []; // corrupt item — drop it, never crash the card
      }
    });
  } catch {
    return [];
  }
}

export function saveHistory(wallet: string, items: readonly HistoryItem[]): void {
  try {
    const stored: StoredItem[] = items.map((i) => ({
      kind: i.kind,
      roundId: i.roundId.toString(),
      entryIndex: i.entryIndex,
      player: i.player,
      lamports: i.lamports.toString(),
      at: i.at,
    }));
    window.localStorage.setItem(keyFor(wallet), JSON.stringify(stored));
  } catch {
    // best-effort only
  }
}
