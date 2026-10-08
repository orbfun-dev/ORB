/**
 * Mobile-only fixed bottom navigation (Play / ORE / Raffle / Docs). Shown below
 * md — the header tabs hide at the same breakpoint, so exactly one
 * navigator is visible per viewport. Safe-area inset keeps it clear of
 * home bars.
 *
 * The active tab is marked three ways at once — brass index bar, brass
 * glyph, lit label — because on a phone, in daylight, a 1-shade text
 * difference between "current page" and "other page" is no difference at
 * all.
 */

import { BookOpen, Gamepad2, Pickaxe, Ticket } from "lucide-react";
import { DOCS_HREF, ORE_HREF, PLAY_HREF, RAFFLE_HREF, navGroup, type Route } from "../../lib/router";

const ITEMS = [
  { route: "play" as Route, label: "Play", href: PLAY_HREF, icon: Gamepad2 },
  { route: "ore" as Route, label: "ORE", href: ORE_HREF, icon: Pickaxe },
  { route: "raffle" as Route, label: "Raffle", href: RAFFLE_HREF, icon: Ticket },
  { route: "docs" as Route, label: "Docs", href: DOCS_HREF, icon: BookOpen },
];

export function BottomNav({ route }: { route: Route }) {
  return (
    <nav
      aria-label="pages"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-orbit-line bg-orbit-bg/92 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
    >
      {/* Lit top edge, so the bar reads as sitting above the page rather
          than being cut out of it. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-orbit-gold/25 to-transparent"
      />
      <div className="flex h-14 items-stretch">
        {ITEMS.map(({ route: r, label, href, icon: Icon }) => {
          const active = navGroup(route) === r;
          return (
            <a
              key={r}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`pressable relative flex flex-1 flex-col items-center justify-center gap-1 text-[10px] font-bold tracking-[0.12em] uppercase ${
                active ? "text-orbit-gold" : "text-orbit-muted active:text-orbit-text"
              }`}
            >
              <span
                aria-hidden
                className={`absolute top-0 h-[2px] w-9 rounded-full bg-orbit-gold transition-opacity duration-300 ${
                  active ? "opacity-100" : "opacity-0"
                }`}
              />
              <Icon
                className={`size-[1.15rem] transition-transform duration-300 ${
                  active ? "scale-110" : ""
                }`}
                strokeWidth={active ? 2.3 : 1.8}
              />
              {label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}
