/**
 * The single claim surface on the play page — replaces the three fixed
 * bottom banners (ClaimBanner / RefundBanner / SettledRefundBanner) with
 * one ORE-ClaimPanel-style "Your rewards" card parked above the players
 * feed. One row per claimable thing, each driving its permissionless
 * instruction directly, no popups:
 *   · Winner prize   — a settled, unclaimed round this wallet won
 *                      (persists across rollovers for the claim window);
 *   · Settled refund — EVERY settled round's pro-rata refund (+ Mega
 *                      field share), not just the current one: rows come
 *                      from the persistent `refundRounds` records, so a
 *                      rollover never hides money the chain still owes;
 *                      delivered by the keeper or triggered here via
 *                      close_entry;
 *   · Full refund    — a cancelled round's stake back, from the same kind
 *                      of persistent record as the settled rows (a
 *                      cancelled round rolls over in about a second, so
 *                      reading the current round's entries showed the row
 *                      for about a second).
 * Money already PAID never sits in the claim column: it goes to the
 * collapsed History at the foot of the card (last 10 rounds). The old
 * "Refunded" receipt row lingered there for ten minutes after the keeper
 * paid, and read as money still to collect.
 * Claims carry NO platform fee — the header tag says so. The pure gates
 * below are the same math the old banners (and the tests) used.
 */

import { useMemo, useState } from "react";
import { ChevronDown, HandCoins, History, Trophy } from "lucide-react";
import { entryShare, findWinningEntry, type PlayerEntryData } from "@orbit-jackpot/sdk";
import {
  useRoundData,
  type CancelledRound,
  type ClaimableRound,
  type RefundRound,
  type RefundedEntry,
} from "../../context/RoundDataProvider";
import { useViewedWallet } from "../../hooks/useViewedWallet";
import { useClaim } from "../../hooks/useClaim";
import { useClaimAll } from "../../hooks/useClaimAll";
import { planClaimAll } from "../../lib/claimAll";
import { escrowAddressOf } from "../../lib/identity";
import { PublicKey } from "@solana/web3.js";
import { useRefund, type RefundTarget } from "../../hooks/useRefund";
import { useCloseEntry } from "../../hooks/useCloseEntry";
import { useToast } from "../../context/ToastProvider";
import { shortSignature } from "../../lib/tx";
import { formatSolCompact, formatSolReward } from "../../lib/format";
import { isMyKey, myEntriesOf } from "../../lib/identity";
import { groupHistory, mergeHistory, type HistoryRound } from "../../lib/rewardHistory";

/** Pure: the wallet's refund + field share per entry of a settled round. */
export function mySettledPayouts(
  entries: readonly { entryIndex: number; player: string; amountLamports: bigint }[],
  wallet: string | null,
  refundPool: bigint,
  megaFieldPool: bigint,
  totalLamports: bigint,
): Array<{ entryIndex: number; refund: bigint; megaField: bigint; player: string }> {
  if (totalLamports === 0n) return [];
  return myEntriesOf(entries, wallet).map((e) => ({
    entryIndex: e.entryIndex,
    player: e.player,
    refund: entryShare(e.amountLamports, refundPool, totalLamports),
    megaField: entryShare(e.amountLamports, megaFieldPool, totalLamports),
  }));
}

/** One rendered refund row's worth of state, derived from a record. */
export interface RefundRowData {
  record: RefundRound;
  /** The wallet's (or its escrow's) payouts among the record's entries. */
  payouts: ReturnType<typeof mySettledPayouts>;
  /** The subset `close_entry` will accept right now. */
  closable: ReturnType<typeof mySettledPayouts>;
  /** refund + Mega field, summed. */
  total: bigint;
}

/**
 * Pure gate for the card: one row per settled-round record the wallet (or
 * its escrow) still holds entries in — newest settle first. Rounds with
 * nothing of mine render no row; entries already closed by the keeper are
 * pruned from the records upstream (the EntryRefundPaid feed), so a row
 * here is live money the chain still owes.
 */
export function refundRowsOf(
  records: Iterable<RefundRound>,
  wallet: string | null,
): RefundRowData[] {
  const rows: RefundRowData[] = [];
  for (const record of records) {
    const payouts = mySettledPayouts(
      record.entries,
      wallet,
      record.refundPool,
      record.megaFieldPool,
      record.totalLamports,
    );
    if (payouts.length === 0) continue;
    // The winning entry is refused on-chain until its prize resolved —
    // never offer a close that would fail with WinningEntryNotClaimed.
    const closable = payouts.filter((p) => {
      const e = record.entries.find((x) => x.entryIndex === p.entryIndex);
      if (e === undefined) return false; // already closed and paid
      if (record.prizeClaimed) return true;
      return !(record.winningTicket >= e.ticketStart && record.winningTicket < e.ticketEnd);
    });
    rows.push({
      record,
      payouts,
      closable,
      total: payouts.reduce((sum, p) => sum + p.refund + p.megaField, 0n),
    });
  }
  return rows.sort((a, b) =>
    a.record.settleTs > b.record.settleTs ? -1 : a.record.settleTs < b.record.settleTs ? 1 : 0,
  );
}

/** Pure gate: the entry the wallet (or its escrow) may claim right now. */
export function myClaimableEntry(
  entries: readonly PlayerEntryData[],
  winningTicket: bigint,
  prizeClaimed: boolean,
  wallet: string | null,
): PlayerEntryData | null {
  if (wallet === null || prizeClaimed) return null;
  const winner = findWinningEntry(entries, winningTicket);
  return winner !== null && isMyKey(winner.player, wallet) ? winner : null;
}

/**
 * Pure gate for the card: the wallet's most recent unclaimed winning
 * round, or null. Expired records are still returned — the row shows
 * the "window expired — swept" state rather than vanishing silently.
 * `record.winner` may be the ESCROW PDA (R1: payouts route there).
 */
export function pickClaimableRound(
  records: Iterable<ClaimableRound>,
  wallet: string | null,
): ClaimableRound | null {
  if (wallet === null) return null;
  let best: ClaimableRound | null = null;
  for (const record of records) {
    if (record.prizeClaimed || !isMyKey(record.winner, wallet)) continue;
    if (best === null || record.settleTs > best.settleTs) best = record;
  }
  return best;
}

/** Pure: the wallet's (or its escrow's) entries in a cancelled round. */
export function myRefundableEntries<T extends { player: string }>(
  entries: readonly T[],
  wallet: string | null,
): T[] {
  return myEntriesOf(entries, wallet);
}

/** One rendered cancelled-round row: what is still owed, what was paid. */
export interface CancelledRowData {
  record: CancelledRound;
  /** This wallet's entries the chain still owes in full. */
  owed: Array<{ entryIndex: number; player: string; amountLamports: bigint }>;
  /** This wallet's entries `refund_entry` already paid. */
  paid: RefundedEntry[];
  owedLamports: bigint;
  paidLamports: bigint;
}

/**
 * Pure gate: one row per cancelled-round record this wallet (or its
 * escrow) has money in — newest round first. Rounds with nothing of mine
 * render nothing, exactly like {@link refundRowsOf}.
 */
export function cancelledRowsOf(
  records: Iterable<CancelledRound>,
  wallet: string | null,
): CancelledRowData[] {
  const rows: CancelledRowData[] = [];
  for (const record of records) {
    const owed = myEntriesOf(record.entries, wallet);
    const paid = myEntriesOf(record.refunded, wallet);
    if (owed.length === 0 && paid.length === 0) continue;
    rows.push({
      record,
      owed,
      paid,
      owedLamports: owed.reduce((sum, e) => sum + e.amountLamports, 0n),
      paidLamports: paid.reduce((sum, e) => sum + e.amountLamports, 0n),
    });
  }
  return rows.sort((a, b) =>
    a.record.endTs > b.record.endTs ? -1 : a.record.endTs < b.record.endTs ? 1 : 0,
  );
}

/**
 * Cancelled refunds as ONE figure per side — the same reasoning as
 * `combineRefundRows`: the money is fungible, the claim is a batch, and a
 * column of near-identical rows is not information.
 */
export interface CombinedCancelled {
  /** Still owed, and the `refund_entry` targets that would pay it. */
  owedLamports: bigint;
  owedTargets: RefundTarget[];
  owedRoundCount: number;
  /** Of `owedLamports`, the part that will land in the escrow. */
  owedEscrowLamports: bigint;
  /** Already paid — the receipt. */
  paidLamports: bigint;
  paidRoundIds: bigint[];
  paidEscrowLamports: bigint;
}

export function combineCancelledRows(
  rows: readonly CancelledRowData[],
  wallet: string | null,
): CombinedCancelled {
  const combined: CombinedCancelled = {
    owedLamports: 0n,
    owedTargets: [],
    owedRoundCount: 0,
    owedEscrowLamports: 0n,
    paidLamports: 0n,
    paidRoundIds: [],
    paidEscrowLamports: 0n,
  };
  const isEscrow = (player: string): boolean => wallet !== null && player !== wallet;
  for (const row of rows) {
    if (row.owed.length > 0) {
      combined.owedRoundCount += 1;
      combined.owedLamports += row.owedLamports;
      for (const e of row.owed) {
        combined.owedTargets.push({
          roundId: row.record.roundId,
          entryIndex: e.entryIndex,
          player: e.player,
        });
        if (isEscrow(e.player)) combined.owedEscrowLamports += e.amountLamports;
      }
    }
    if (row.paid.length > 0) {
      combined.paidLamports += row.paidLamports;
      combined.paidRoundIds.push(row.record.roundId);
      for (const e of row.paid) {
        if (isEscrow(e.player)) combined.paidEscrowLamports += e.amountLamports;
      }
    }
  }
  return combined;
}

/**
 * Every settled-round refund the wallet is owed, as ONE figure.
 *
 * One row per round turned a quiet week into a wall of near-identical
 * cards — the live card showed "0.0089 SOL · round 267" directly above
 * "0.0089 SOL · round 266", each with its own button. The money is
 * fungible and the claim is a batch either way, so the card states the
 * total and claims the lot.
 */
export interface CombinedRefunds {
  /** Every owed lamport across every settled round. */
  total: bigint;
  /** Rounds contributing at least one owed entry. */
  roundCount: number;
  /** Entries owed, closable or not. */
  entryCount: number;
  /** The entries `close_entry` accepts right now, flattened across rounds. */
  closable: Array<{ roundId: bigint; entryIndex: number; player: string }>;
  /** Lamports in the closable set — what CLAIM ALL actually pays now. */
  closableLamports: bigint;
  /** The closable split by destination: the wallet vs the escrow PDA. */
  closableWalletLamports: bigint;
  closableEscrowLamports: bigint;
  /** Owed lamports still withheld behind an unresolved winning prize. */
  lockedLamports: bigint;
  /** Some round pays a Mega-field share on top of the 89%. */
  anyFieldShare: boolean;
  /** Some payout lands in the escrow rather than the wallet. */
  anyEscrow: boolean;
}

export function combineRefundRows(
  rows: readonly RefundRowData[],
  wallet: string | null,
): CombinedRefunds {
  const combined: CombinedRefunds = {
    total: 0n,
    roundCount: 0,
    entryCount: 0,
    closable: [],
    closableLamports: 0n,
    closableWalletLamports: 0n,
    closableEscrowLamports: 0n,
    lockedLamports: 0n,
    anyFieldShare: false,
    anyEscrow: false,
  };
  for (const row of rows) {
    combined.roundCount += 1;
    combined.entryCount += row.payouts.length;
    combined.total += row.total;
    if (row.record.megaFieldPool > 0n) combined.anyFieldShare = true;
    for (const p of row.payouts) {
      const open = row.closable.some((c) => c.entryIndex === p.entryIndex);
      const lamports = p.refund + p.megaField;
      if (open) {
        combined.closable.push({
          roundId: row.record.roundId,
          entryIndex: p.entryIndex,
          player: p.player,
        });
        combined.closableLamports += lamports;
        if (wallet !== null && p.player === wallet) {
          combined.closableWalletLamports += lamports;
        } else {
          combined.closableEscrowLamports += lamports;
        }
      } else {
        combined.lockedLamports += lamports;
      }
      if (wallet !== null && p.player !== wallet) combined.anyEscrow = true;
    }
  }
  return combined;
}

/** What a history row paid, in the player's words. */
function historyWhat(row: HistoryRound): string {
  const kinds = new Set(row.items.map((i) => i.kind));
  if (kinds.has("prize") && kinds.has("settledRefund")) return "prize + refund";
  if (kinds.has("prize")) return "prize";
  if (kinds.has("refund")) return "refunded in full";
  return "refund";
}

function historyWhere(row: HistoryRound): string {
  if (row.escrowLamports === 0n) return "to your wallet";
  if (row.escrowLamports === row.lamports) return "to your escrow";
  return "to wallet + escrow";
}

function ago(atMs: number, nowMs: number): string | null {
  if (atMs <= 0) return null;
  const secs = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3_600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3_600)}h ago`;
  return `${Math.floor(secs / 86_400)}d ago`;
}

/** The collapsed ledger at the foot of the card — opens on request only. */
function RewardHistory({ rows, nowMs }: { rows: HistoryRound[]; nowMs: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4 border-t border-orbit-line/50 pt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="reward-history"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-orbit-muted transition-colors hover:text-orbit-text-mid"
      >
        <span className="flex items-center gap-1.5">
          <History className="size-3.5" aria-hidden />
          History
        </span>
        <ChevronDown
          className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open && (
        <ul id="reward-history" className="mt-3 space-y-2.5">
          {rows.length === 0 ? (
            <li className="text-[11px] leading-relaxed text-orbit-muted">
              Nothing paid out yet — refunds and prizes land here once they are paid.
            </li>
          ) : (
            rows.map((row) => {
              const when = ago(row.at, nowMs);
              return (
                <li key={row.roundId.toString()} className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <div className="num text-[11px] font-semibold text-orbit-text-mid">
                      Round {row.roundId.toString()}
                    </div>
                    <div className="num mt-0.5 text-[10px] text-orbit-muted">
                      {historyWhat(row)} · {historyWhere(row)}
                      {when !== null ? ` · ${when}` : ""}
                    </div>
                  </div>
                  <div className="num shrink-0 text-[12px] font-semibold tabular-nums text-orbit-gold">
                    +{formatSolReward(row.lamports)} SOL
                  </div>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}

const BUTTON =
  "pressable shrink-0 rounded-xl px-5 py-2.5 text-sm font-bold shadow-[inset_0_1px_0_0_rgba(255,255,255,0.35),0_12px_26px_-14px_rgba(0,0,0,0.9)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:hover:brightness-100";

function RewardRow({
  amount,
  win,
  label,
  sub,
  note,
  button,
}: {
  /** Bare SOL figure — the row sets the unit. */
  amount: string;
  /** The prize part of `amount`, set only when the claim includes a win. */
  win?: string;
  label: string;
  sub?: string;
  note?: string;
  button?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        {/* The figure leads; the label explains it. It used to be set at
            the same weight as its own caption, so neither won. */}
        <div className="num whitespace-nowrap text-[1.4rem] font-semibold leading-none tabular-nums text-orbit-gold">
          {amount}
          <span className="ml-1 text-[0.8rem] font-medium text-orbit-gold/70">SOL</span>
        </div>
        {win !== undefined && (
          <div
            className="num mt-2 inline-flex items-center gap-1 rounded-md border border-orbit-green/30 bg-orbit-green/10 px-1.5 py-0.5 text-[11px] font-semibold leading-none tabular-nums text-orbit-green"
            data-testid="reward-win"
          >
            <Trophy className="size-3" aria-hidden />+{win} SOL won
          </div>
        )}
        <div className="mt-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-orbit-text-mid">
          {label}
        </div>
        {sub !== undefined && <div className="num mt-1 text-[10px] text-orbit-muted">{sub}</div>}
        {note !== undefined && (
          <div className="mt-1 text-[11px] leading-relaxed text-orbit-muted">{note}</div>
        )}
      </div>
      {button}
    </div>
  );
}

export function YourRewardsCard() {
  const { state, history: storedHistory } = useRoundData();
  const { round, entries, config, claimableRounds, refundRounds, cancelledRounds, nowMs, clockOffsetMs } =
    state;
  const viewed = useViewedWallet();
  const wallet = viewed.publicKey?.toString() ?? null;
  const { claim, pending: prizePending } = useClaim();
  const { claimAll, pending: claimAllPending } = useClaimAll();
  const { refundAll, pending: refundPending } = useRefund();
  const { closeAll, pending: closePending } = useCloseEntry();
  const toast = useToast();

  // Winner prize: the most recent unclaimed winning round (30-day window,
  // chain-clock corrected), expired means swept back to the pot.
  const claimable = useMemo(
    () => pickClaimableRound(claimableRounds.values(), wallet),
    [claimableRounds, wallet],
  );
  const expired =
    claimable !== null &&
    config !== null &&
    claimable.settleTs +
      config.claimDeadlineSecs -
      BigInt(Math.floor((nowMs + clockOffsetMs) / 1000)) <=
      0n;
  const days =
    claimable !== null && !expired
      ? (
          (claimable.settleTs +
            (config?.claimDeadlineSecs ?? 0n) -
            BigInt(Math.floor((nowMs + clockOffsetMs) / 1000))) /
          86_400n
        ).toString()
      : "0";

  // Settled-round refunds: one row per record — the CURRENT settled round
  // and every rolled-over round whose entries the chain has not closed
  // yet. Records prune live off the EntryRefundPaid feed, so a row is
  // always money still owed.
  const refundRows = useMemo(
    () => refundRowsOf(refundRounds.values(), wallet),
    [refundRounds, wallet],
  );
  // ONE row for the lot: see `combineRefundRows`.
  const combined = useMemo(() => combineRefundRows(refundRows, wallet), [refundRows, wallet]);
  // ONE transaction for the lot: prizes first (they unlock the closes),
  // then the closes, then the sweep to the player's own address.
  const escrowKeyOfViewer = useMemo(
    () => (wallet === null ? null : escrowAddressOf(wallet)),
    [wallet],
  );
  const plan = useMemo(
    () =>
      planClaimAll(
        [...refundRounds.values()].map((r) => {
          // The prize is exact on chain; the figure here is display-only.
          // Prefer the settled round's own winner_payout + Mega award —
          // the estimate below left the Mega-Pot out, so a 22 SOL Mega win
          // read as "+0.70 SOL won".
          const won = claimableRounds.get(r.roundId);
          return {
            roundId: r.roundId,
            refundPool: r.refundPool,
            megaFieldPool: r.megaFieldPool,
            totalLamports: r.totalLamports,
            winningTicket: r.winningTicket,
            prizeClaimed: r.prizeClaimed,
            entries: r.entries,
            // Fallback matches `calculate_fees` (winner_bps of the pot).
            winnerPayout:
              won?.winnerPayout ??
              (config === null ? 0n : (r.totalLamports * BigInt(config.winnerBps)) / 10_000n),
            megaAwarded: won?.megaAwarded ?? 0n,
          };
        }),
        wallet,
        escrowKeyOfViewer,
      ),
    [refundRounds, claimableRounds, wallet, escrowKeyOfViewer, config],
  );

  // Cancelled rounds: every entry refunds in full (ADR-7). Read from the
  // PERSISTENT book, not `state.entries` — a sole-depositor round cancels
  // at lock and the keeper opens the next one about a second later, which
  // is exactly how long this row used to last.
  const cancelledRows = useMemo(
    () => cancelledRowsOf(cancelledRounds.values(), wallet),
    [cancelledRounds, wallet],
  );
  const cancelled = useMemo(
    () => combineCancelledRows(cancelledRows, wallet),
    [cancelledRows, wallet],
  );

  // The combined claim already carries the prizes for every round it
  // covers, so the standalone prize row would double-count them — and
  // give the card two buttons for one action, which is the thing the
  // single claim exists to remove. It stays only for a prize the plan
  // cannot reach (a round whose entries the keeper already closed, so no
  // refund record survives to hang the claim on).
  const prizeCoveredByPlan = useMemo(() => {
    if (claimable === null) return false;
    return plan.prizes.some((p) => p.roundId === claimable.roundId);
  }, [claimable, plan]);
  const showPrizeRow = claimable !== null && !prizeCoveredByPlan;
  // The won part of the combined claim — shown as its own "+X won" line
  // under the total, and only when there is a win in it.
  const prizeLamports = plan.prizes.reduce((sum, p) => sum + p.lamports, 0n);

  // Paid receipts are NOT rows any more — they live in the History.
  const hasRows = showPrizeRow || plan.refunds.length > 0 || cancelled.owedTargets.length > 0;

  // History: the stored ledger plus this session's payouts, this wallet's
  // two identities only, newest round first.
  const historyRows = useMemo(
    () =>
      groupHistory(
        mergeHistory(
          storedHistory ?? [],
          state.payouts.filter((p) => isMyKey(p.player, wallet)),
        ),
        wallet,
      ),
    [storedHistory, state.payouts, wallet],
  );

  // ONE batch per click: every closable entry across every round packs
  // into single close_entry transactions (≤11 instructions each — the
  // chain's packet ceiling), so the wallet signs once per chunk, not
  // once per entry. The payout lands per entry.player: the wallet for
  // direct deposits, the escrow for auto-play — the toast states the
  // split so "claimed but my wallet didn't move" never happens silently.
  const runCloseBatch = async (): Promise<void> => {
    const signature = await closeAll(combined.closable);
    if (signature === null) return; // the hook already toasted the failure
    const walletPart = formatSolCompact(combined.closableWalletLamports);
    const escrowPart = formatSolCompact(combined.closableEscrowLamports);
    toast.push(
      "success",
      combined.closableEscrowLamports > 0n
        ? `refund delivered — ${walletPart} SOL to your wallet · ${escrowPart} SOL to your escrow (spend it on the play card)`
        : `refund delivered — ${walletPart} SOL to your wallet`,
      shortSignature(signature),
    );
  };

  const runRefundBatch = async (): Promise<void> => {
    const total = cancelled.owedLamports;
    const escrowPart = cancelled.owedEscrowLamports;
    const signature = await refundAll(cancelled.owedTargets);
    if (signature === null) return; // the hook already toasted the failure
    toast.push(
      "success",
      escrowPart > 0n
        ? `refund delivered — ${formatSolCompact(
            total - escrowPart,
          )} SOL to your wallet · ${formatSolCompact(
            escrowPart,
          )} SOL to your escrow (spend it on the play card)`
        : `refund delivered — ${formatSolCompact(total)} SOL to your wallet`,
      shortSignature(signature),
    );
  };

  return (
    <section className="panel p-5" data-testid="your-rewards">
      <div className="mb-3.5 flex items-center gap-2 border-b border-orbit-line/70 pb-3">
        <HandCoins className="size-4 text-orbit-gold" aria-hidden />
        <h2 className="text-[13px] font-bold tracking-[0.1em] uppercase text-orbit-text">
          Your rewards
        </h2>
        <span className="ml-auto shrink-0 rounded-full border border-orbit-green/35 bg-orbit-green/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-orbit-green">
          No ORB fee
        </span>
      </div>

      {!hasRows ? (
        <p className="rounded-xl border border-dashed border-orbit-line bg-orbit-bg/30 px-3.5 py-5 text-xs leading-relaxed text-orbit-muted">
          {wallet === null
            ? "Connect your wallet to view claimable prizes and refunds."
            : "Nothing to claim right now — prizes and refunds appear here when a round settles."}
        </p>
      ) : (
        <div className="space-y-4">
          {showPrizeRow && claimable !== null && (
            <RewardRow
              amount={formatSolReward(claimable.winnerPayout + claimable.megaAwarded)}
              label="Winner prize"
              sub={
                expired
                  ? "claim window expired — prize swept"
                  : `${claimable.megaTriggered ? "incl. Mega-Pot · " : ""}claimable for ~${days}d`
              }
              note={
                wallet !== null && claimable.winner !== wallet
                  ? "claims into your escrow — withdraw or keep it auto-playing from the play card"
                  : undefined
              }
              button={
                <button
                  type="button"
                  disabled={prizePending || expired || !viewed.canSign}
                  onClick={() =>
                    void claim({
                      roundId: claimable.roundId,
                      entryIndex: claimable.entryIndex,
                      winnerPayout: claimable.winnerPayout,
                      megaAwarded: claimable.megaAwarded,
                    })
                  }
                  title={viewed.canSign ? undefined : "connect a signing wallet to claim"}
                  className={`${BUTTON} bg-orbit-gold text-orbit-bg`}
                >
                  {prizePending ? "CLAIMING…" : expired ? "WINDOW EXPIRED" : viewed.canSign ? "CLAIM" : "CONNECT TO CLAIM"}
                </button>
              }
            />
          )}

          {plan.refunds.length > 0 && (
            <RewardRow
              amount={formatSolReward(plan.total)}
              win={plan.wonProfit > 0n ? formatSolReward(plan.wonProfit) : undefined}
              label="Claimable"
              sub={`${plan.refunds.length} ${
                plan.refunds.length === 1 ? "entry" : "entries"
              } across ${combined.roundCount} ${
                combined.roundCount === 1 ? "round" : "rounds"
              }${prizeLamports > 0n ? "" : " · 89% pro-rata"}`}
              note={
                plan.escrowRefundCredit > 0n
                  ? `one signature — ${formatSolCompact(plan.escrowRefundCredit)} SOL lands in your wallet, the rest in your escrow`
                  : undefined
              }
              button={
                <button
                  type="button"
                  disabled={claimAllPending || !viewed.canSign}
                  onClick={() =>
                    void claimAll(
                      plan,
                      escrowKeyOfViewer === null ? null : new PublicKey(escrowKeyOfViewer),
                    )
                  }
                  title={
                    viewed.canSign
                      ? "every prize and refund, one wallet approval; payouts go to entry.player"
                      : "connect a signing wallet to claim"
                  }
                  className={`${BUTTON} bg-orbit-blue text-orbit-bg`}
                >
                  {claimAllPending
                    ? "CLAIMING…"
                    : viewed.canSign
                      ? "CLAIM ALL"
                      : "CONNECT TO CLAIM"}
                </button>
              }
            />
          )}

          {cancelled.owedTargets.length > 0 && (
            <RewardRow
              amount={formatSolReward(cancelled.owedLamports)}
              label="Refund"
              sub={`${cancelled.owedTargets.length} ${
                cancelled.owedTargets.length === 1 ? "entry" : "entries"
              }${
                cancelled.owedRoundCount > 1 ? ` across ${cancelled.owedRoundCount} rounds` : ""
              } · returned in full`}
              note={
                cancelled.owedEscrowLamports > 0n
                  ? "auto-play entries refund into your escrow, not your wallet"
                  : undefined
              }
              button={
                <button
                  type="button"
                  disabled={closePending || refundPending || prizePending || !viewed.canSign}
                  onClick={() => void runRefundBatch()}
                  title={
                    viewed.canSign
                      ? "permissionless — one signature refunds the lot"
                      : "connect a signing wallet to refund"
                  }
                  className={`${BUTTON} bg-orbit-blue text-orbit-bg`}
                >
                  {refundPending
                    ? "REFUNDING…"
                    : viewed.canSign
                      ? `REFUND ${cancelled.owedTargets.length}`
                      : "CONNECT TO REFUND"}
                </button>
              }
            />
          )}
        </div>
      )}

      {wallet !== null && <RewardHistory rows={historyRows} nowMs={nowMs} />}
    </section>
  );
}
