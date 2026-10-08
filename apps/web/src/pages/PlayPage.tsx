/**
 * The game itself: fixture switcher (dev only), the wheel, and the right
 * rail — the single play card (manual/auto tabs), the Your-Rewards claim
 * card, participants. Everything round-state driven; the status strip renders
 * around it from App (claim actions live in the rail, not in popups).
 *
 * Two composition decisions beyond the stack order:
 *
 *  · the wheel column is STICKY from lg up. The apparatus is the thing
 *    the player is watching, and scrolling a long players feed used to
 *    scroll the wheel off the screen — the one element that must never
 *    leave it;
 *  · the page arrives in sequence (`stagger` + a per-child delay) rather
 *    than all at once. One orchestrated load reads as a product; four
 *    cards popping in simultaneously reads as a render.
 */

import type { CSSProperties } from "react";
import { FixtureBar } from "../dev/FixtureBar";
import { OrbitWheel } from "../components/wheel/OrbitWheel";
import { PlayCard } from "../components/play/PlayCard";
import { YourRewardsCard } from "../components/claim/YourRewardsCard";
import { ParticipantsFeed } from "../components/participants/ParticipantsFeed";
import { AnnouncementTicker } from "../components/play/AnnouncementTicker";

/** `--d` is read by the `stagger` utility (styles.css). */
const delay = (ms: number): CSSProperties => ({ "--d": `${ms}ms` }) as CSSProperties;

export function PlayPage() {
  return (
    <>
      <FixtureBar />
      <div className="stagger mb-5 lg:mb-6" style={delay(0)}>
        <AnnouncementTicker />
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-6">
        <div className="stagger lg:sticky lg:top-24 lg:self-start" style={delay(0)}>
          <OrbitWheel />
        </div>
        <div className="space-y-5">
          <div className="stagger" style={delay(90)}>
            <PlayCard />
          </div>
          {/* The single claim surface (prize / refunds) — ORE-ClaimPanel
              style, parked above the players feed. No popup banners. */}
          <div className="stagger" style={delay(170)}>
            <YourRewardsCard />
          </div>
          <div className="stagger" style={delay(250)}>
            <ParticipantsFeed />
          </div>
        </div>
      </div>
    </>
  );
}
