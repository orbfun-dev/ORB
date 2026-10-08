/**
 * The play page's announcement strip: a slow, endless ticker between the
 * header and the game. Two composition decisions:
 *
 *  · the track holds the message set TWICE and slides by exactly -50%,
 *    so the loop seam is invisible — the second copy lands where the
 *    first began. The copy is aria-hidden; screen readers get one pass;
 *  · it pauses under the pointer (a moving line you are trying to read
 *    is hostile) and fades out at both edges so text enters and leaves
 *    rather than being clipped by a hard box.
 *
 * "Entry", never "ticket": a round already has a winning ticket, so the
 * promo unit keeps the raffle rules' vocabulary (RaffleRulesPage).
 */

import type { ComponentType } from "react";
import { Gift, RefreshCcw } from "lucide-react";
import { RAFFLE_HREF } from "../../lib/router";

type Announcement = {
  icon: ComponentType<{ className?: string }>;
  tint: string;
  lead: string;
  rest: string;
  href?: string;
};

const ANNOUNCEMENTS: readonly Announcement[] = [
  {
    icon: RefreshCcw,
    tint: "text-orbit-cyan",
    lead: "50% of protocol revenue",
    rest: "buys back ORB on the open market",
  },
  {
    icon: Gift,
    tint: "text-orbit-gold",
    lead: "Every 1 SOL of volume",
    rest: "earns 1 entry into the weekly $1,000 draw",
    href: RAFFLE_HREF,
  },
];

/** One pass of the messages; repeated so a single pass outruns a wide viewport. */
function Pass({ hidden = false }: { hidden?: boolean }) {
  const items = [...ANNOUNCEMENTS, ...ANNOUNCEMENTS];
  return (
    <ul className="flex shrink-0 items-center" aria-hidden={hidden || undefined}>
      {items.map(({ icon: Icon, tint, lead, rest, href }, i) => {
        const body = (
          <>
            <Icon className={`size-3.5 shrink-0 ${tint}`} />
            <span className="font-bold text-orbit-text">{lead}</span>
            <span className="text-orbit-text-mid">{rest}</span>
          </>
        );
        return (
          <li key={i} className="flex items-center">
            {href ? (
              <a
                href={href}
                tabIndex={hidden ? -1 : undefined}
                className="flex items-center gap-2 whitespace-nowrap rounded-full px-1 hover:underline hover:decoration-orbit-gold/60 hover:underline-offset-4"
              >
                {body}
              </a>
            ) : (
              <span className="flex items-center gap-2 whitespace-nowrap px-1">{body}</span>
            )}
            {/* Brass bead between messages. */}
            <span aria-hidden className="mx-6 size-1 shrink-0 rounded-full bg-orbit-gold/60 sm:mx-8" />
          </li>
        );
      })}
    </ul>
  );
}

export function AnnouncementTicker() {
  return (
    <section
      aria-label="Announcements"
      className="group relative overflow-hidden rounded-full border border-orbit-line bg-orbit-panel/70 py-2 text-[12px] backdrop-blur sm:text-[13px]"
      style={{
        maskImage: "linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent)",
        WebkitMaskImage: "linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent)",
      }}
      data-testid="announcement-ticker"
    >
      <div className="flex w-max animate-marquee group-hover:[animation-play-state:paused]">
        <Pass />
        <Pass hidden />
      </div>
    </section>
  );
}
