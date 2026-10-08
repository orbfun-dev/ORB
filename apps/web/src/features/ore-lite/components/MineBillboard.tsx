/**
 * The billboard between the headline readouts and the deploy card: an
 * ASCII miner swinging at an ore rock beside three rotating slogans, all
 * in brass. Purely promotional — it reads no chain state.
 */

import { useEffect, useState } from "react";

/** 22 × 6 frames: wind-up, overhead, strike, sparks. */
const FRAMES = [
  [
    " .-^-.                ",
    "   \\                  ",
    "    \\ o               ",
    "     \\|\\       .--.   ",
    "     / \\     _/#$##\\_ ",
    "======================",
  ],
  [
    "       .-^-.          ",
    "        /             ",
    "     \\o/              ",
    "      |        .--.   ",
    "     / \\     _/#$##\\_ ",
    "======================",
  ],
  [
    "            *  .      ",
    "         .  + '  *    ",
    "      o     .         ",
    "     /|\\_____) .--.   ",
    "     / \\     '/#$##\\_ ",
    "======================",
  ],
  [
    "          .   $   +   ",
    "       *    '   .     ",
    "      o   +    *      ",
    "     /|\\_____) .--.   ",
    "     / \\     '/#$##\\_ ",
    "======================",
  ],
].map((rows) => rows.join("\n"));

/** One swing: hold the wind-up, snap down, let the sparks hang, recover. */
const SWING = [0, 0, 1, 2, 3, 3, 1];
const FRAME_MS = 140;
/** The frame shown when motion is reduced — the strike reads on its own. */
const STILL_FRAME = 3;

const SLIDES: { lines: React.ReactNode[] }[] = [
  { lines: ["Mine ORE"] },
  { lines: ["Earn tickets"] },
  {
    lines: [
      "Join to win",
      <>
        <span className="text-orbit-gold-bright">$1,000</span> weekly
      </>,
    ],
  },
];
const SLIDE_MS = 2_800;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (mq === undefined) return;
    const onChange = (): void => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function useTicker(count: number, ms: number, enabled = true): number {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setI((n) => (n + 1) % count), ms);
    return () => clearInterval(id);
  }, [count, ms, enabled]);
  return i;
}

export function MineBillboard({ className = "" }: { className?: string }) {
  const reduced = usePrefersReducedMotion();
  const step = useTicker(SWING.length, FRAME_MS, !reduced);
  const frame = reduced ? STILL_FRAME : SWING[step]!;
  // Slogans rotate even with reduced motion — the global rule just makes
  // the change instant instead of a slide.
  const active = useTicker(SLIDES.length, SLIDE_MS);

  return (
    <section
      aria-label="Mine ORE. Earn tickets. Join to win $1,000 weekly."
      className={`panel relative overflow-hidden !border-orbit-gold/25 ${className}`}
    >
      {/* brass glow under the miner + an LED scanline field */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(22rem 10rem at 18% 60%, rgb(242 181 68 / 0.12) 0%, rgb(242 181 68 / 0) 70%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgb(255 208 122 / 0.035) 0 1px, transparent 1px 3px)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 animate-sheen bg-[linear-gradient(105deg,transparent_40%,rgb(255_208_122/0.07)_50%,transparent_60%)]"
      />

      <div className="relative flex h-28 items-center gap-3 px-3 sm:h-36 sm:gap-5 sm:px-6">
        <pre
          aria-hidden
          className="shrink-0 font-mono text-[8.5px] leading-[1.2] text-orbit-gold select-none sm:text-[13px]"
          style={{ textShadow: "0 0 10px rgb(242 181 68 / 0.45)" }}
        >
          {FRAMES[frame]}
        </pre>

        <div aria-hidden className="h-3/5 w-px shrink-0 bg-orbit-gold/25" />

        <div aria-hidden className="relative h-full min-w-0 flex-1 overflow-hidden">
          {SLIDES.map((slide, i) => {
            const offset = (i - active + SLIDES.length) % SLIDES.length;
            const position =
              offset === 0
                ? "translate-y-0 opacity-100"
                : offset === SLIDES.length - 1
                  ? "-translate-y-full opacity-0"
                  : "translate-y-full opacity-0";
            return (
              <div
                key={i}
                className={`absolute inset-0 flex flex-col justify-center transition-[transform,opacity] duration-700 ease-[cubic-bezier(0.22,1,0.36,1)] ${position}`}
              >
                <span className="num mb-1 text-[9px] tracking-[0.3em] text-orbit-gold/70 sm:text-[10px]">
                  {String(i + 1).padStart(2, "0")} / {String(SLIDES.length).padStart(2, "0")}
                </span>
                {slide.lines.map((line, j) => (
                  <span
                    key={j}
                    className="block font-display text-xl leading-[1.05] font-extrabold tracking-tight text-orbit-gold uppercase sm:text-[2.1rem]"
                    style={{ textShadow: "0 0 22px rgb(242 181 68 / 0.35)" }}
                  >
                    {line}
                  </span>
                ))}
              </div>
            );
          })}
        </div>

        <div aria-hidden className="flex shrink-0 flex-col gap-1.5">
          {SLIDES.map((_, i) => (
            <span
              key={i}
              className={`w-1 rounded-full transition-all duration-500 ${
                i === active ? "h-4 bg-orbit-gold" : "h-1 bg-orbit-gold/30"
              }`}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
