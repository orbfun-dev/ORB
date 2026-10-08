/**
 * Read-only board visualization (Deploy-All mode). Lite deploys to the
 * whole board, so there is nothing to select — this grid is information,
 * not a control: per square it shows the round's total SOL, the connected
 * miner's own stake (current round only — a stale miner's rows belong to
 * round N−1), and the "already yours" lockout treatment that makes the
 * no-eligible-squares blocker self-explaining. No buttons.
 *
 * The squares are shaded as a HEAT MAP against the round's busiest square.
 * Twenty-five cells all printing a number in the same grey tells you
 * nothing until you have read all twenty-five; shading them means the
 * distribution of the round's money is legible at a glance, which is the
 * actual question anyone looks at a board to answer. The figures are
 * unchanged and still authoritative — the shading only ranks them.
 */

import type { CSSProperties } from "react";
import { formatSol } from "../format";

export interface SquareGridProps {
  /** `round.deployed` — total SOL staked on each square this round. */
  roundDeployed: readonly bigint[] | null;
  /** `miner.deployed` when `miner.roundId === board.roundId`, else null. */
  minerDeployed: readonly bigint[] | null;
}

export function SquareGrid({ roundDeployed, minerDeployed }: SquareGridProps) {
  const mine = minerDeployed ?? [];
  const held = mine.filter((v) => v > 0n).length;

  // Busiest square this round, as the heat scale's ceiling. Integer
  // throughout; the single float is the alpha handed to CSS.
  const peak = (roundDeployed ?? []).reduce((max, v) => (v > max ? v : max), 0n);

  return (
    <div aria-hidden="false" role="img" aria-label="ORE board for the current round">
      <div className="grid grid-cols-5 gap-2">
        {Array.from({ length: 25 }, (_, i) => {
          const roundStake = roundDeployed?.[i] ?? null;
          const myStake = minerDeployed?.[i] ?? 0n;
          const isMine = myStake > 0n;
          // Heat ∈ [0, 1] by basis points against the peak square.
          const heat =
            roundStake !== null && peak > 0n
              ? Number((roundStake * 10_000n) / peak) / 10_000
              : 0;

          return (
            <div
              key={i}
              title={
                isMine
                  ? `Square ${i} — yours this round: ${formatSol(myStake, 6)} SOL`
                  : `Square ${i} — round total: ${roundStake !== null ? `${formatSol(roundStake, 6)} SOL` : "…"}`
              }
              style={
                {
                  "--d": `${Math.min(i, 12) * 22}ms`,
                  // Cool for the field, so the brass of an owned square is
                  // never confusable with "a lot of money is here".
                  backgroundColor: `rgb(59 217 203 / ${(heat * 0.17).toFixed(3)})`,
                } as CSSProperties
              }
              className={`num stagger relative grid aspect-square place-items-center rounded-xl border text-[11px] leading-tight shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)] transition-colors ${
                isMine
                  ? "border-orbit-gold/70 text-orbit-gold shadow-[inset_0_1px_0_0_rgba(255,232,180,0.2),0_0_18px_-6px_rgba(242,181,68,0.6)]"
                  : heat > 0.5
                    ? "border-orbit-cyan/40 text-orbit-text-mid"
                    : "border-orbit-line text-orbit-muted"
              }`}
            >
              <span className="text-[10px] text-orbit-disabled">{i}</span>
              <span className="tabular-nums font-medium">
                {roundStake === null ? "…" : formatSol(roundStake, 2)}
              </span>
              {isMine && (
                <span
                  className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-orbit-gold shadow-[0_0_6px_#f2b544]"
                  aria-hidden
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <p className="text-[11px] text-orbit-muted">
          Deploy All targets every square you don&apos;t already hold
          {held > 0 ? ` — you hold ${held} of 25 this round (highlighted).` : " this round."}
        </p>
        {peak > 0n && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.16em] text-orbit-muted">
            Quiet
            <span
              aria-hidden
              className="h-1.5 w-12 rounded-full border border-orbit-line"
              style={{
                background:
                  "linear-gradient(90deg, rgb(59 217 203 / 0) 0%, rgb(59 217 203 / 0.17) 100%)",
              }}
            />
            Busy
          </span>
        )}
      </div>
    </div>
  );
}
