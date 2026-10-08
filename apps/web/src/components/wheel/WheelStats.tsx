/**
 * The hollow-center readout: round id, state, pot, entry count. The
 * Mega-Pot HUD and the countdown live in their own cards above the wheel
 * (MegaPotCard / RoundTimerCard) — the center stays the dial's own
 * register. Re-renders at the provider's 250 ms clock tick; the needle and
 * slices are NOT in this subtree (needle is DOM-driven, arcs are memoized
 * siblings).
 *
 * The pot is the largest figure on the page, and it is the one number a
 * player watches, so it gets the flash treatment (see common/Figure) and
 * the only `font-hero` moment inside the apparatus.
 */

import type { RoundData } from "@orbit-jackpot/sdk";
import { formatSolCompact } from "../../lib/format";
import { Figure } from "../common/Figure";

/** Round state → the tone its label is spoken in. */
const STATE_TONE: Record<string, string> = {
  open: "text-orbit-cyan",
  locked: "text-orbit-gold",
  awaitingRandomness: "text-orbit-gold",
  settled: "text-orbit-text-mid",
  cancelled: "text-orbit-red-bright",
};

/** Round state → the word the dial says. The randomness pipeline is one
 *  thing to a player: the winner is being drawn. */
const STATE_LABEL: Record<string, string> = {
  open: "OPEN",
  locked: "DRAWING",
  awaitingRandomness: "DRAWING",
  settled: "SETTLED",
  cancelled: "CANCELLED",
};

export function WheelStats({ round, entryCount }: { round: RoundData; entryCount: number }) {
  const tone = STATE_TONE[round.state] ?? "text-orbit-muted";
  const shown = Math.max(entryCount, round.entryCount);

  return (
    <div className="relative flex aspect-square w-[58%] max-w-[15.5rem] flex-col items-center justify-center gap-1 overflow-hidden rounded-full border border-orbit-line bg-orbit-panel/80 px-3 text-center shadow-[inset_0_2px_30px_rgba(0,0,0,0.75),inset_0_-14px_40px_rgba(0,0,0,0.5)] backdrop-blur-md">
      {/* A ground-glass instrument face: brass warmth above, ink below. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          background:
            "linear-gradient(180deg, rgb(242 181 68 / 0.07) 0%, rgb(255 255 255 / 0.015) 32%, rgb(6 9 15 / 0.35) 100%)",
        }}
      />

      <span className="relative text-[9px] font-semibold tracking-[0.24em] text-orbit-muted sm:text-[10px] sm:tracking-[0.28em]">
        ROUND <span className="num text-orbit-text-mid">{round.roundId.toString()}</span>
      </span>

      <Figure
        value={round.totalLamports}
        className="num relative text-[1.75rem] font-medium leading-none text-orbit-text sm:text-4xl md:text-[2.6rem]"
      >
        {formatSolCompact(round.totalLamports)}
        <span className="ml-1 align-baseline text-xs font-normal text-orbit-muted sm:text-sm">
          SOL
        </span>
      </Figure>

      <span className="relative text-[9px] font-semibold tracking-[0.22em] text-orbit-muted sm:text-[10px]">
        POT
      </span>

      {/* Hairline rule, then the round's own status — the dial's legend. */}
      <span
        aria-hidden
        className="relative mt-0.5 h-px w-10 bg-gradient-to-r from-transparent via-orbit-line-2 to-transparent"
      />
      <span className="relative flex items-center gap-1.5 text-[9px] font-semibold tracking-[0.18em] sm:text-[10px]">
        <span className={tone}>{STATE_LABEL[round.state] ?? round.state.toUpperCase()}</span>
        <span className="text-orbit-line-2">·</span>
        <span className="num text-orbit-muted">
          {shown} {shown === 1 ? "ENTRY" : "ENTRIES"}
        </span>
      </span>
    </div>
  );
}
