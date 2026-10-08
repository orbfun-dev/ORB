/**
 * The Mega-Pot card (Phase 11 HUD), parked ABOVE the wheel: the FULL
 * accrued pot — no payable/cap math on the card (user directive: players
 * who want the payout rules read the docs page).
 *
 * This is the one surface in the app allowed to be brass all the way
 * through, because it is the one surface whose entire subject is
 * accumulating value. It previously rendered as an identical twin of the
 * clock beside it — same frame, same type, same size — which flattened the
 * single most exciting number in the product into a second timer. Now it
 * reads as metal: a lit crown, a breathing halo whose intensity tracks
 * what the pot is actually holding, and a specular pass travelling across
 * the face. The breathing stops when the pot is empty; a card that
 * celebrates nothing is noise.
 */

import { CookingPot } from "lucide-react";
import type { MegaPotVaultData } from "@orbit-jackpot/sdk";
import { formatSolCompact } from "../../lib/format";
import { Figure } from "../common/Figure";

/** 5 SOL accrued is "fully lit" — above that the glow stops growing so a
 *  long cycle without a trigger doesn't bloom into the rest of the page. */
const GLOW_FULL_LAMPORTS = 5_000_000_000n;

export function MegaPotCard({ megaPot }: { megaPot: MegaPotVaultData }) {
  const loaded = megaPot.accruedLamports > 0n;
  // Integer ratio, then one float at the render boundary — the same
  // discipline every other derived number in this app follows.
  const fillBps =
    megaPot.accruedLamports >= GLOW_FULL_LAMPORTS
      ? 10_000n
      : (megaPot.accruedLamports * 10_000n) / GLOW_FULL_LAMPORTS;
  const intensity = 0.3 + (Number(fillBps) / 10_000) * 0.7;

  return (
    <section
      title="the progressive pot — pays 90% (50% winner / 40% field) if it pops this round · rules in the docs"
      className="group relative flex flex-col justify-center gap-1 overflow-hidden rounded-2xl border border-orbit-gold/45 p-4 text-center transition-colors duration-300 hover:border-orbit-gold/70 sm:p-5"
      style={{
        background:
          "linear-gradient(180deg, rgb(242 181 68 / 0.17) 0%, rgb(242 181 68 / 0.05) 48%, rgb(16 21 31 / 0.85) 100%)",
        boxShadow: `inset 0 1px 0 0 rgb(255 232 180 / 0.28), 0 20px 46px -26px rgb(242 181 68 / ${0.55 * intensity})`,
      }}
    >
      {/* The halo, breathing only while the pot holds something. */}
      {loaded && (
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-10 animate-breathe rounded-full blur-2xl"
          style={{
            background: `radial-gradient(circle at 50% 50%, rgb(242 181 68 / ${0.3 * intensity}) 0%, rgb(242 181 68 / 0) 68%)`,
          }}
        />
      )}

      {/* Specular pass — what makes brass read as metal rather than as a
          yellow rectangle. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 animate-sheen bg-[linear-gradient(105deg,transparent_38%,rgb(255_255_255/0.12)_50%,transparent_62%)]"
      />

      <span className="relative flex items-center justify-center gap-2 text-xs font-bold tracking-[0.2em] text-orbit-gold-bright sm:text-[13px]">
        <CookingPot
          className={`size-4 transition-transform duration-500 group-hover:scale-110 sm:size-[1.15rem] ${
            loaded ? "animate-pulse" : "opacity-60"
          }`}
        />
        MEGA-POT
      </span>

      {/* The number itself is the centered element — SOL is absolutely
          offset to its right so the figure doesn't sit left of mid. */}
      <div className="relative self-center">
        <Figure
          value={megaPot.accruedLamports}
          className="num text-[1.6rem] font-semibold leading-tight tabular-nums text-orbit-gold-bright [text-shadow:0_0_22px_rgba(255,208,122,0.35)] sm:text-[2rem]"
        >
          {formatSolCompact(megaPot.accruedLamports)}
        </Figure>
        <span className="absolute -right-7 bottom-1 text-xs font-semibold text-orbit-gold/70">
          SOL
        </span>
      </div>

      <span className="relative text-[9px] font-semibold tracking-[0.22em] text-orbit-gold/55">
        {loaded ? "PROGRESSIVE" : "ACCRUING"}
      </span>
    </section>
  );
}
