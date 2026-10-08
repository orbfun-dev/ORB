/**
 * SOL and ORE marks for the headline cards. Copies of the header ticker's
 * (components/layout/PriceTicker.tsx) — the isolation boundary keeps this
 * feature from importing app code, so it carries its own.
 */

import { useId } from "react";
import oreToken from "../assets/ore-token.png";

/** The three-bar SOL mark in its own gradient — recognisable at 16px. */
export function SolMark({ className }: { className?: string }) {
  const gradient = useId();
  return (
    <svg viewBox="0 0 24 20" className={className} aria-hidden>
      <defs>
        <linearGradient id={gradient} x1="0" y1="20" x2="24" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9945FF" />
          <stop offset="1" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <g fill={`url(#${gradient})`}>
        <polygon points="5,1.5 23,1.5 19,6 1,6" />
        <polygon points="1,8 19,8 23,12.5 5,12.5" />
        <polygon points="5,14.5 23,14.5 19,19 1,19" />
      </g>
    </svg>
  );
}

/**
 * The official ORE token disc (black, white mark). The hairline ring keeps
 * its black edge from dissolving into the dark card.
 */
export function OreMark({ className }: { className?: string }) {
  return (
    <img
      src={oreToken}
      alt=""
      width={350}
      height={350}
      className={`${className ?? ""} rounded-full ring-1 ring-white/15`}
    />
  );
}
