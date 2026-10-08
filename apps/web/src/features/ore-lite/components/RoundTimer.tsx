/**
 * Slot-derived round countdown (R5/R6/R7). Round timing is SLOTS, not
 * timestamps: the round ends at `end_slot`, and the time left is when the
 * fitted slot clock (liveSlot.ts) says that slot lands, minus now. The
 * display slews toward each new fit instead of jumping, so it ticks once
 * a second through the polls' ±2-slot wobble.
 */

import { useLayoutEffect, useRef, useState } from "react";
import type { OreBoard, OreConfig } from "../codec";
import { U64_MAX } from "../codec";
import { formatCountdown } from "../format";
import {
  countdownTargetSlot,
  holdMonotonic,
  slewDeadline,
  slewedDeadlineAt,
  slotDeadlineMs,
  type SlewedDeadline,
  type SlotClock,
} from "../liveSlot";

/** Display refresh; the shown second flips within this of the true edge. */
const DISPLAY_TICK_MS = 100;

export type RoundPhase = "waiting-first-deploy" | "open" | "intermission";

export interface RoundTimerProps {
  board: OreBoard;
  config: OreConfig | null;
  /** Whole slot now (estimated) — drives the phase. */
  slot: bigint | null;
  /** The fitted slot clock — drives the sub-second countdown. */
  clock: SlotClock | null;
}

export function roundPhase(board: OreBoard, slot: bigint | null): RoundPhase {
  if (board.endSlot === U64_MAX) return "waiting-first-deploy";
  if (slot === null) return "open"; // unknown slot — optimistically open until the poll lands
  if (slot >= board.endSlot) return "intermission";
  return "open";
}

/**
 * Whole seconds left to the target slot. Each new fit moves the deadline
 * through a slew (never a jump); a new target — the round ended, or a new
 * round began — starts a fresh deadline. Held so it never ticks back up.
 */
function useCountdownSeconds(target: bigint | null, clock: SlotClock | null): number | null {
  const [seconds, setSeconds] = useState<number | null>(null);
  const deadline = useRef<{ target: bigint; d: SlewedDeadline } | null>(null);
  const held = useRef<{ key: string; shown: number } | null>(null);

  // Layout effect: when a new round's board lands, the first count is set
  // before paint — otherwise "00:00" from the old target flashes for a
  // frame under the new round's label.
  useLayoutEffect(() => {
    if (target === null || clock === null) {
      deadline.current = null;
      setSeconds(null);
      return;
    }
    const now = Date.now();
    const at = slotDeadlineMs(clock, target);
    const prev = deadline.current?.target === target ? deadline.current.d : null;
    deadline.current = { target, d: slewDeadline(prev, at, now) };

    const key = target.toString();
    const read = (): void => {
      const d = deadline.current;
      if (d === null) return;
      const now = Date.now();
      const left = Math.max(0, slewedDeadlineAt(d.d, now) - now);
      held.current = holdMonotonic(held.current, key, Math.floor(left / 1_000));
      setSeconds(held.current.shown);
    };
    read();
    const id = setInterval(read, DISPLAY_TICK_MS);
    return () => clearInterval(id);
  }, [target, clock]);

  return seconds;
}

export function RoundTimer({ board, config, slot, clock }: RoundTimerProps) {
  const phase = roundPhase(board, slot);
  const target = slot === null ? null : countdownTargetSlot(board, config, slot);
  const seconds = useCountdownSeconds(target, clock);
  return (
    <div className="flex flex-col items-center">
      <span
        className={`num text-lg font-semibold tabular-nums sm:text-2xl ${
          phase === "intermission" ? "text-orbit-gold" : "text-orbit-text"
        }`}
      >
        {phase === "waiting-first-deploy"
          ? "—:—"
          : seconds === null
            ? "…"
            : formatCountdown(seconds)}
      </span>
      <span className="mt-1 text-[9px] uppercase tracking-[0.14em] text-orbit-muted sm:text-[10px] sm:tracking-[0.2em]">
        {phase === "waiting-first-deploy" ? (
          <>
            <span className="sm:hidden">Waiting</span>
            <span className="hidden sm:inline">Waiting for first deploy</span>
          </>
        ) : phase === "intermission" ? (
          <>
            <span className="sm:hidden">Intermission</span>
            <span className="hidden sm:inline">Intermission — next round</span>
          </>
        ) : (
          "Time remaining"
        )}
      </span>
    </div>
  );
}
