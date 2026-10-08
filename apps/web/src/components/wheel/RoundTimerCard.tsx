/**
 * The round clock, parked ABOVE the wheel beside the Mega-Pot card: the
 * deposit-window countdown (urgent tint inside the anti-snipe window,
 * brass "+Xs extended" cue when a last-second deposit stretches the
 * round), or the round's non-open state. The wheel's hollow center no
 * longer carries a timer.
 *
 * A bare `MM:SS` string makes the player do the arithmetic of "is that a
 * lot?". The depleting bar along the foot answers it at a glance — and it
 * visibly JUMPS BACK when anti-snipe extends the window, which is the
 * clearest possible way to show that the deadline moved.
 */

import { Flame, Hourglass, Timer } from "lucide-react";
import type { GlobalConfigData, RoundData } from "@orbit-jackpot/sdk";
import { useCountdown } from "../../hooks/useCountdown";
import type { AntiSnipeCue } from "../../context/RoundDataProvider";

interface RoundTimerCardProps {
  round: RoundData;
  config: GlobalConfigData | null;
  antiSnipe: AntiSnipeCue | null;
}

/**
 * How long the countdown reads as CLOSING. It tracked the anti-snipe
 * window, which was fine while that mechanism was armed — but the window
 * is a product lever that can be set to 0 (anti-snipe off), and a 0-second
 * urgency threshold means the clock never changes colour at all. The
 * urgency cue is about the deposit deadline, not the extension rule, so it
 * keeps its own floor.
 */
const URGENT_FLOOR_SECS = 10;

/** Non-open rounds say where they are in the pipeline, not just "closed". */
function statusLabel(state: RoundData["state"]): string {
  switch (state) {
    case "locked":
    case "awaitingRandomness":
      return "AWAITING SETTLEMENT";
    case "settled":
      return "SETTLED";
    default:
      return "REFUNDS OPEN";
  }
}

export function RoundTimerCard({ round, config, antiSnipe }: RoundTimerCardProps) {
  const urgentSecs = Math.max(
    URGENT_FLOOR_SECS,
    config !== null ? Number(config.antiSnipeWindowSecs) : 0,
  );
  const countdown = useCountdown(round.state === "open" ? round.endTs : null, urgentSecs);

  // Both "extended" and "closing" are the same call to attention now that
  // the palette carries no alarm colour, so they share one frame.
  const hot = antiSnipe !== null || countdown?.isUrgent === true;

  // Fraction of the deposit window still left. The window is `endTs -
  // startTs` in chain seconds, so an anti-snipe extension lengthens the
  // denominator AND the remainder — the bar refills, which is the cue.
  const windowMs = Math.max(1, Number(round.endTs - round.startTs) * 1000);
  const remainingPct =
    countdown === null ? 0 : Math.max(0, Math.min(100, (countdown.remainingMs / windowMs) * 100));

  return (
    <section
      className={`panel panel-live relative flex flex-col justify-center gap-1 overflow-hidden p-4 text-center sm:p-5 ${
        hot ? "border-orbit-gold/55" : ""
      }`}
      style={
        hot
          ? {
              boxShadow:
                "inset 0 1px 0 0 rgb(255 232 180 / 0.18), 0 18px 40px -26px rgb(242 181 68 / 0.45)",
            }
          : undefined
      }
    >
      {hot && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgb(242 181 68 / 0.1) 0%, rgb(242 181 68 / 0) 60%)",
          }}
        />
      )}

      <span
        className={`relative flex items-center justify-center gap-2 text-xs font-bold tracking-[0.2em] sm:text-[13px] ${
          hot ? "text-orbit-gold" : "text-orbit-muted"
        }`}
      >
        {countdown !== null ? (
          countdown.isUrgent ? (
            <>
              <Hourglass className="size-4 animate-pulse" /> CLOSING
            </>
          ) : (
            <>
              <Timer className="size-4" /> TIME
            </>
          )
        ) : (
          <>
            <Hourglass className="size-4" /> STATUS
          </>
        )}
      </span>

      {countdown !== null ? (
        <span
          className={`num relative text-[1.6rem] font-semibold leading-tight tabular-nums transition-colors sm:text-[2rem] ${
            countdown.isUrgent
              ? "text-orbit-gold-bright [text-shadow:0_0_20px_rgba(255,208,122,0.35)]"
              : "text-orbit-text"
          }`}
        >
          {countdown.display}
        </span>
      ) : (
        <span className="num relative text-sm font-semibold leading-snug tracking-wide text-orbit-text-mid sm:text-base">
          {statusLabel(round.state)}
        </span>
      )}

      {antiSnipe !== null ? (
        <span className="num relative flex items-center justify-center gap-1 text-[10px] font-bold tracking-wide text-orbit-gold">
          <Flame className="size-3" /> EXTENDED +{antiSnipe.deltaSecs.toString()}s
        </span>
      ) : (
        <span className="relative text-[9px] font-semibold tracking-[0.22em] text-orbit-muted/70">
          {/* Named: while the wheel still draws the previous round, this
              clock already belongs to the next one. */}
          ROUND {round.roundId.toString()} · {countdown !== null ? "DEPOSIT WINDOW" : "THIS ROUND"}
        </span>
      )}

      {/* The window, draining. Transitions on width so an extension reads
          as the bar sliding back open rather than teleporting. */}
      {countdown !== null && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] bg-orbit-line/40"
        >
          <span
            className={`block h-full rounded-r-full transition-[width,background-color] duration-500 ease-linear ${
              countdown.isUrgent
                ? "bg-orbit-gold shadow-[0_0_10px_rgba(242,181,68,0.8)]"
                : "bg-orbit-cyan/70"
            }`}
            style={{ width: `${remainingPct}%` }}
          />
        </span>
      )}
    </section>
  );
}
