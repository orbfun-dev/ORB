/**
 * The rotating pointer. This component renders ONCE — all motion is the
 * rAF controller writing `style.transform` on the attached wrapper
 * (useWheelSpin). The wrapper is full-size with a centered transform
 * origin; the needle graphic itself points at 0° (12 o'clock).
 *
 * Drawn as an instrument indicator rather than a dart: a brass shaft with
 * a white-hot tip and a counterweight behind the pivot, which is what a
 * real balanced pointer looks like and what makes the thing read as
 * calibrated. The only React-visible state is `boosted` — the glow swells
 * while the needle is travelling, so the reveal builds; nothing per-frame
 * crosses the React boundary.
 */

import type { WheelSpin } from "./useWheelSpin";

export function SpinNeedle({ spin, boosted = false }: { spin: WheelSpin; boosted?: boolean }) {
  return (
    <div
      ref={spin.attach}
      className="pointer-events-none absolute inset-0 will-change-transform"
      style={{ transformOrigin: "50% 50%" }}
      aria-hidden
    >
      <svg viewBox="0 0 400 400" className="h-full w-full">
        <defs>
          <linearGradient id="needleShaft" gradientUnits="userSpaceOnUse" x1="200" y1="18" x2="200" y2="140">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="18%" stopColor="#ffe7bd" />
            <stop offset="55%" stopColor="#f2b544" />
            <stop offset="100%" stopColor="#a9741c" />
          </linearGradient>
          <filter id="needleHalo" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation={boosted ? 4.5 : 2.4} result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g
          filter="url(#needleHalo)"
          style={{
            opacity: boosted ? 1 : 0.95,
            transition: "opacity 0.6s cubic-bezier(0.22,1,0.36,1)",
          }}
        >
          {/* Tip reaching just past the data ring; shaft down toward the
              hub; counterweight on the far side of the pivot. */}
          <path d="M200 14 L204.6 46 L200 40 L195.4 46 Z" fill="#ffffff" />
          <rect x="198.1" y="40" width="3.8" height="94" rx="1.9" fill="url(#needleShaft)" />
          <circle cx="200" cy="43" r="3.2" fill="#ffffff" />
          <rect x="198.8" y="200" width="2.4" height="26" rx="1.2" fill="#a9741c" opacity="0.9" />
          <circle cx="200" cy="228" r="4.6" fill="#2a3443" stroke="#a9741c" strokeWidth="1.2" />
        </g>
      </svg>
    </div>
  );
}

/** Static hub drawn above the rotating layer (visual anchor at dead center). */
export function NeedleHub() {
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <svg viewBox="0 0 400 400" className="h-full w-full">
        <defs>
          <radialGradient id="hubMetal" gradientUnits="userSpaceOnUse" cx="196" cy="195" r="16">
            <stop offset="0%" stopColor="#4f5d74" />
            <stop offset="60%" stopColor="#222c3b" />
            <stop offset="100%" stopColor="#0d121b" />
          </radialGradient>
        </defs>
        {/* A seated pivot: collar, machined body, brass jewel. */}
        <circle cx="200" cy="200" r="13" fill="#0b0f17" opacity="0.9" />
        <circle cx="200" cy="200" r="11" fill="url(#hubMetal)" stroke="#44526a" strokeWidth="1" />
        <circle cx="200" cy="200" r="4.6" fill="#f2b544" />
        <circle cx="200" cy="200" r="1.8" fill="#fff4dd" />
      </svg>
    </div>
  );
}
