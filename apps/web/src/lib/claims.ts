/**
 * Wallet-scoped persistence for unclaimed winnings (audit fix, claim CTA
 * persistence). The chain gives a winner a 30-day claim window
 * (`claim_deadline_secs`), but the live UI only tracks the ACTIVE round —
 * the instant round N+1 opens, round N's account is no longer in the state
 * tree. The reducer keeps a session map of claimable rounds
 * (RoundDataProvider); this module mirrors it to localStorage keyed by the
 * winner's pubkey so the banner survives reloads and reconnects.
 *
 * Records are HYDRATED CONSERVATIVELY: on wallet connect each stored
 * round is re-fetched and kept only if the chain still shows it settled,
 * unclaimed, and won by this wallet — the account is the authority, the
 * cache only points at round ids worth checking.
 */

import type { ClaimableRound } from "../context/RoundDataProvider";

const KEY_PREFIX = "orbit:claims:v1:";

const keyFor = (wallet: string): string => `${KEY_PREFIX}${wallet}`;

interface StoredClaimableRound {
  roundId: string;
  winner: string;
  entryIndex: number;
  winningTicket: string;
  totalLamports: string;
  winnerPayout: string;
  megaAwarded: string;
  megaTriggered: boolean;
  settleTs: string;
  prizeClaimed: boolean;
}

/** Safe under private mode / quota errors / SSR — persistence is best-effort. */
function readRaw(wallet: string): StoredClaimableRound[] {
  try {
    const raw = window.localStorage.getItem(keyFor(wallet));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is StoredClaimableRound =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as StoredClaimableRound).roundId === "string" &&
        typeof (r as StoredClaimableRound).winner === "string",
    );
  } catch {
    return [];
  }
}

export function loadClaimables(wallet: string): ClaimableRound[] {
  return readRaw(wallet).flatMap((r) => {
    try {
      return [
        {
          roundId: BigInt(r.roundId),
          winner: r.winner,
          entryIndex: r.entryIndex,
          winningTicket: BigInt(r.winningTicket),
          totalLamports: BigInt(r.totalLamports),
          winnerPayout: BigInt(r.winnerPayout),
          megaAwarded: BigInt(r.megaAwarded),
          megaTriggered: r.megaTriggered,
          settleTs: BigInt(r.settleTs),
          prizeClaimed: r.prizeClaimed,
        },
      ];
    } catch {
      return []; // corrupt record — drop, never crash the banner
    }
  });
}

export function saveClaimables(wallet: string, records: readonly ClaimableRound[]): void {
  try {
    const stored: StoredClaimableRound[] = records.map((r) => ({
      roundId: r.roundId.toString(),
      winner: r.winner,
      entryIndex: r.entryIndex,
      winningTicket: r.winningTicket.toString(),
      totalLamports: r.totalLamports.toString(),
      winnerPayout: r.winnerPayout.toString(),
      megaAwarded: r.megaAwarded.toString(),
      megaTriggered: r.megaTriggered,
      settleTs: r.settleTs.toString(),
      prizeClaimed: r.prizeClaimed,
    }));
    window.localStorage.setItem(keyFor(wallet), JSON.stringify(stored));
  } catch {
    // best-effort only
  }
}

export function clearClaimables(wallet: string): void {
  try {
    window.localStorage.removeItem(keyFor(wallet));
  } catch {
    // best-effort only
  }
}
