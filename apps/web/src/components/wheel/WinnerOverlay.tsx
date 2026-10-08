/**
 * Settlement banner: winning player, payout, and — when the 1-in-N (Phase 11: 625)
 * fired — the Mega-Pot celebration. The winner is decided by the SDK's
 * integer range lookup on the entry book (`findWinningEntry`); angles
 * never pick a winner, they only animated the needle onto it.
 *
 * This is the emotional payoff of the entire product and it used to be a
 * bordered box with five grey lines in it. It is now staged: the field
 * darkens, light blooms out of the centre, the card pops, and its contents
 * arrive in reading order — label, winner, payout, provenance. A Mega-Pot
 * hit additionally gets rotating rays, because the one-in-625 event should
 * not look like the other 624.
 *
 * Every figure, including `θ`, is unchanged; the staging is presentation
 * only. `prefers-reduced-motion` flattens all of it (styles.css) and the
 * overlay still reads correctly as a static card.
 */

import { PartyPopper, Trophy, X, Zap } from "lucide-react";
import { thetaDegrees, type PlayerEntryData } from "@orbit-jackpot/sdk";
import type { SettlementOutcome } from "../../context/RoundDataProvider";
import { formatLamports, shortAddress } from "../../lib/format";

interface WinnerOverlayProps {
  /** The SETTLED round's id — the live round may already have rolled. */
  roundId: bigint;
  settlement: SettlementOutcome;
  /** `findWinningEntry` over the round's frozen book — null while it refetches. */
  winner: PlayerEntryData | null;
  onDismiss: () => void;
}

/** Radiating light for a Mega-Pot hit — 18 tapered spokes, turning slowly. */
function MegaRays() {
  return (
    <svg
      viewBox="0 0 200 200"
      className="pointer-events-none absolute inset-0 h-full w-full animate-drift"
      style={{ transformOrigin: "50% 50%" }}
      aria-hidden
    >
      <defs>
        <linearGradient id="rayFade" gradientUnits="objectBoundingBox" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#ffd07a" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#ffd07a" stopOpacity="0" />
        </linearGradient>
      </defs>
      {Array.from({ length: 18 }, (_, i) => (
        <path
          key={i}
          d="M100 100 L96.5 2 L103.5 2 Z"
          fill="url(#rayFade)"
          transform={`rotate(${i * 20} 100 100)`}
        />
      ))}
    </svg>
  );
}

export function WinnerOverlay({ roundId, settlement, winner, onDismiss }: WinnerOverlayProps) {
  const mega = settlement.mega !== null && settlement.event.megaTriggered;
  const theta = thetaDegrees(settlement.event.winningTicket, settlement.event.totalLamports);
  const payout = settlement.event.winnerPayout + settlement.event.megaAwarded;

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center overflow-hidden rounded-full bg-orbit-void/75 p-5 backdrop-blur-[5px]">
      {/* Light blooming out of the dial's centre. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: mega
            ? "radial-gradient(circle at 50% 50%, rgb(255 208 122 / 0.34) 0%, rgb(242 181 68 / 0.12) 34%, rgb(6 9 15 / 0) 68%)"
            : "radial-gradient(circle at 50% 50%, rgb(242 181 68 / 0.18) 0%, rgb(6 9 15 / 0) 60%)",
        }}
      />
      {mega && <MegaRays />}

      <div
        className="animate-pop relative flex max-w-[19rem] flex-col items-center gap-1.5 rounded-2xl border border-orbit-line-2 bg-orbit-panel/95 px-5 py-4 text-center shadow-[0_30px_70px_-24px_rgba(0,0,0,0.95)]"
        style={{
          backgroundImage: mega
            ? "linear-gradient(180deg, rgb(242 181 68 / 0.14) 0%, rgb(242 181 68 / 0) 55%)"
            : "linear-gradient(180deg, rgb(255 255 255 / 0.04) 0%, rgb(255 255 255 / 0) 45%)",
        }}
      >
        {mega && (
          <span className="stagger absolute -top-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-orbit-gold/60 bg-orbit-gold px-3 py-0.5 text-[10px] font-extrabold tracking-[0.14em] text-orbit-void shadow-[0_6px_18px_-6px_rgba(242,181,68,0.9)]">
            <Zap className="size-3" /> MEGA-POT HIT · 90% AWARDED
          </span>
        )}

        <span
          className="stagger grid size-11 place-items-center rounded-full border border-orbit-gold/35 bg-orbit-gold/12"
          style={{ "--d": "60ms" } as React.CSSProperties}
        >
          {mega ? (
            <PartyPopper className="size-5 text-orbit-gold-bright" />
          ) : (
            <Trophy className="size-5 text-orbit-gold" />
          )}
        </span>

        <span
          className="stagger text-[10px] font-bold tracking-[0.28em] text-orbit-muted"
          style={{ "--d": "120ms" } as React.CSSProperties}
        >
          ROUND <span className="num text-orbit-text-mid">{roundId.toString()}</span> WINNER
        </span>

        {winner !== null ? (
          <span
            className="stagger num rounded-md bg-orbit-bg/60 px-2 py-0.5 text-xs font-semibold text-orbit-text"
            style={{ "--d": "180ms" } as React.CSSProperties}
          >
            {shortAddress(winner.player, 6, 6)}
          </span>
        ) : (
          <span className="text-xs text-orbit-muted">resolving winner…</span>
        )}

        {/* The payout — the largest figure in the overlay, and the only
            thing a winner is actually looking for. */}
        <span
          className="stagger num mt-0.5 text-[2rem] font-semibold leading-none text-orbit-gold-bright [text-shadow:0_0_26px_rgba(255,208,122,0.45)]"
          style={{ "--d": "240ms" } as React.CSSProperties}
        >
          {formatLamports(payout)}
          <span className="ml-1 align-baseline text-xs font-normal text-orbit-gold/60">SOL</span>
        </span>

        <span
          className="stagger num text-[10px] text-orbit-muted"
          style={{ "--d": "300ms" } as React.CSSProperties}
        >
          ticket {settlement.event.winningTicket.toString()} · θ {theta.toFixed(2)}°
        </span>

        {mega && settlement.mega !== null && (
          <span
            className="stagger num text-[10px] text-orbit-muted"
            style={{ "--d": "340ms" } as React.CSSProperties}
          >
            mega awarded {formatLamports(settlement.mega.awarded, 3)} · pot keeps{" "}
            {formatLamports(settlement.mega.retained, 3)}
          </span>
        )}

        <button
          type="button"
          onClick={onDismiss}
          className="stagger pressable mt-1.5 flex items-center gap-1 rounded-full border border-orbit-line bg-orbit-panel-2 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-orbit-muted hover:border-orbit-line-2 hover:text-orbit-text"
          style={{ "--d": "400ms" } as React.CSSProperties}
        >
          <X className="size-3" /> dismiss
        </button>
      </div>
    </div>
  );
}
