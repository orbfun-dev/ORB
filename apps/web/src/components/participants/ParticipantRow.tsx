/**
 * One entry card: player identity, stake, exact ticket interval
 * `[start, end)`, and share — colored by the SAME slice the wheel renders
 * for this entry (color arrives from `calculateWheelSlices` in the feed,
 * so the two views can never disagree).
 */

import { memo } from "react";
import { Bot, Crown, HandCoins } from "lucide-react";
import { entryShare, type PlayerEntryAccountData } from "@orbit-jackpot/sdk";
import { basisPointsPercent, formatSolCompact, groupDigits, shortAddress } from "../../lib/format";

interface ParticipantRowProps {
  entry: PlayerEntryAccountData;
  color: string;
  totalLamports: bigint;
  isYou: boolean;
  /** Entry funded by a `PlayerEscrow` (labelled with the owner wallet). */
  isAuto?: boolean;
  /** Resolved display identity — the owner wallet for escrow entries. */
  label?: string | null;
  isWinner: boolean;
  /** Phase 11: a settled round's pools — when present, every row shows
   *  its exact pro-rata refund (+ Mega field share on a trigger). */
  refundPool?: bigint;
  megaFieldPool?: bigint;
  /** Staggered entrance offset, assigned by the feed. */
  delayMs?: number;
}

export const ParticipantRow = memo(function ParticipantRow({
  entry,
  color,
  totalLamports,
  isYou,
  isAuto = false,
  label = null,
  isWinner,
  refundPool,
  megaFieldPool,
  delayMs = 0,
}: ParticipantRowProps) {
  const settled = refundPool !== undefined && totalLamports > 0n;
  const refund = settled ? entryShare(entry.amountLamports, refundPool!, totalLamports) : 0n;
  const field =
    settled && megaFieldPool !== undefined
      ? entryShare(entry.amountLamports, megaFieldPool, totalLamports)
      : 0n;
  // Share of the pot, as a bar behind the row — the same number the
  // percentage states, in a form the eye reads without parsing digits. The
  // float is confined to this width, exactly as in WinProbability.
  const sharePct =
    totalLamports > 0n
      ? Math.min(100, Number((entry.amountLamports * 10_000n) / totalLamports) / 100)
      : 0;

  return (
    <li
      data-entry-index={entry.entryIndex}
      style={{ "--d": `${delayMs}ms` } as React.CSSProperties}
      className={`animate-row-in pressable relative flex items-center gap-3 overflow-hidden rounded-xl border px-3 py-2 [animation-delay:var(--d)] ${
        isYou
          ? "border-orbit-gold/40 bg-orbit-panel-2 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]"
          : "border-orbit-line bg-orbit-panel/40 hover:border-orbit-line-2 hover:bg-orbit-panel-2/70"
      } ${isWinner ? "ring-1 ring-orbit-gold shadow-[0_0_22px_-6px_rgba(242,181,68,0.55)]" : ""}`}
    >
      {/* Stake-share fill, tinted with this entry's own wheel colour, so
          the row and its arc are unmistakably the same thing. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 transition-[width] duration-500 ease-out"
        style={{
          width: `${sharePct}%`,
          background: `linear-gradient(90deg, ${color}26 0%, ${color}08 100%)`,
        }}
      />
      {/* The colour key, as a seated jewel rather than a flat dot. */}
      <span
        className="relative size-3.5 shrink-0 rounded-full ring-1 ring-inset ring-white/25"
        style={{ backgroundColor: color, boxShadow: `0 0 10px ${color}80` }}
        aria-hidden
      />
      <div className="relative min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="num truncate text-xs font-semibold text-orbit-text">
            {shortAddress(label ?? entry.player)}
          </span>
          {isAuto && (
            <span
              className="flex shrink-0 items-center gap-0.5 rounded-full border border-orbit-blue/35 bg-orbit-blue/15 px-1.5 py-px text-[9px] font-bold tracking-wider text-orbit-blue"
              title="funded by an auto-play escrow"
            >
              <Bot className="size-2.5" /> AUTO
            </span>
          )}
          {isYou && (
            <span className="shrink-0 rounded-full border border-orbit-gold/40 bg-orbit-gold/15 px-1.5 py-px text-[9px] font-bold tracking-wider text-orbit-gold">
              YOU
            </span>
          )}
          {isWinner && (
            <Crown className="size-3.5 shrink-0 text-orbit-gold" aria-label="winner" />
          )}
        </div>
        <div className="num mt-0.5 text-[10px] text-orbit-muted">
          tickets [{groupDigits(entry.ticketStart)}, {groupDigits(entry.ticketEnd)})
        </div>
        {settled && (
          <div className="num mt-1 flex items-center gap-1 text-[10px] font-semibold text-orbit-blue">
            <HandCoins className="size-2.5" aria-hidden />
            {formatSolCompact(refund + field)} SOL back
            {field > 0n && " incl. Mega field share"}
          </div>
        )}
      </div>
      <div className="relative shrink-0 text-right">
        <div className="num text-[13px] font-semibold text-orbit-text">
          {formatSolCompact(entry.amountLamports)}
          <span className="ml-0.5 text-[9px] font-normal text-orbit-muted">SOL</span>
        </div>
        <div className="num text-[10px] font-medium text-orbit-muted">
          {basisPointsPercent(entry.amountLamports, totalLamports)}
        </div>
      </div>
    </li>
  );
});
