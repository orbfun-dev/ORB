import { useEffect, useState, type ReactNode } from "react";
import { ConnectButton } from "../wallet/ConnectButton";
import { PriceTicker } from "./PriceTicker";
import { BottomNav } from "./BottomNav";
import { DOCS_HREF, ORE_HREF, PLAY_HREF, RAFFLE_HREF, navGroup, type Route } from "../../lib/router";
import logo from "../../assets/orb-logo.png";

const NAV = [
  { route: "play", label: "Play", href: PLAY_HREF },
  { route: "ore", label: "ORE", href: ORE_HREF },
  { route: "raffle", label: "Raffle", href: RAFFLE_HREF },
  { route: "docs", label: "Docs", href: DOCS_HREF },
] as const satisfies ReadonlyArray<{ route: Route; label: string; href: string }>;

/** The ORB token's pump.fun page — where "Buy ORB" sends people. */
const BUY_ORB_HREF = "https://pump.fun/coin/9vRcHZ9gJWSrVFcvVLUuygMaeYhUNNGRHqUT1Fb8pump";

/**
 * Outlined brass, never filled: the wallet button is the header's one
 * primary, and two gold slabs side by side would leave neither reading as
 * the main action. Leaves the site, so it opens a new tab.
 *
 * Its width is paid for by the price tickers: they hide below sm (phones)
 * and again at md (tablet, where the page tabs arrive), mirroring the
 * wordmark subtitle's sm/md/lg dance; SOL waits for xl. The header row has
 * no slack for all of it at once with a real four-digit price.
 */
function BuyOrbButton() {
  return (
    <a
      href={BUY_ORB_HREF}
      target="_blank"
      rel="noopener noreferrer"
      className="pressable inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-orbit-gold/50 bg-orbit-gold/10 px-3 text-[13px] font-bold tracking-[0.02em] text-orbit-gold-bright hover:border-orbit-gold hover:bg-orbit-gold/20 sm:px-4"
      data-testid="buy-orb"
    >
      <img
        src={logo}
        alt=""
        width={128}
        height={128}
        className="hidden size-4 rounded-full ring-1 ring-orbit-gold/40 sm:block"
      />
      Buy ORB
    </a>
  );
}

/**
 * True once the page has scrolled off the top. The header is transparent
 * over the atmosphere at rest and condenses into a solid bar on scroll —
 * a fixed opaque strip would cut a hard line across the glow and flatten
 * the whole composition.
 */
function useScrolled(threshold = 8): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const read = (): void => setScrolled(window.scrollY > threshold);
    read();
    window.addEventListener("scroll", read, { passive: true });
    return () => window.removeEventListener("scroll", read);
  }, [threshold]);
  return scrolled;
}

/**
 * The page's fixed chrome, laid out like ore.supply's: wordmark with the
 * page tabs right beside it on the left; live prices, Buy ORB and the
 * wallet on the right. The tabs are desktop-only (md+) — on phones the
 * fixed BottomNav takes over, and the header keeps just Buy ORB and the
 * wallet (see BuyOrbButton for which widths show which prices).
 */
function Header({ route }: { route: Route }) {
  const scrolled = useScrolled();

  return (
    <header
      className={`sticky top-0 z-30 transition-colors duration-300 ${
        scrolled
          ? "border-b border-orbit-line bg-orbit-bg/85 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent"
      }`}
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-3 sm:h-16 sm:px-6">
        <div className="flex min-w-0 items-center gap-4 lg:gap-8">
          <a
            href={PLAY_HREF}
            className="group flex min-w-0 items-center gap-2.5 sm:gap-3"
            aria-label="ORB — home"
          >
            {/* Seated in a brass collar, like the hub at the wheel's centre:
                the mark and the apparatus are the same object. */}
            <span className="relative grid shrink-0 place-items-center">
              <span
                aria-hidden
                className="absolute -inset-1.5 rounded-full bg-orbit-gold/20 blur-md transition-opacity duration-500 group-hover:opacity-100 sm:-inset-2"
                style={{ opacity: 0.5 }}
              />
              <img
                src={logo}
                alt=""
                className="relative size-8 rounded-full ring-1 ring-orbit-gold/40 transition-transform duration-500 group-hover:scale-105 sm:size-9"
                width={128}
                height={128}
              />
            </span>
            <div className="min-w-0 leading-none">
              <div className="truncate font-display text-base font-extrabold tracking-[0.26em] text-orbit-text sm:text-lg">
                ORB
              </div>
              <div className="mt-1 hidden text-[9px] font-semibold tracking-[0.26em] text-orbit-muted sm:block md:hidden lg:block">
                PARI-MUTUEL WHEEL
              </div>
            </div>
          </a>

          <nav className="hidden items-center gap-1 md:flex" aria-label="pages">
            {NAV.map(({ route: r, label, href }) => {
              const active = navGroup(route) === r;
              return (
                <a
                  key={r}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`pressable relative rounded-full px-4 py-1.5 text-sm font-semibold ${
                    active
                      ? "bg-orbit-panel-2 text-orbit-text shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]"
                      : "text-orbit-muted hover:bg-orbit-panel/60 hover:text-orbit-text"
                  }`}
                >
                  {label}
                  {/* The brass index mark: which page is being read. */}
                  <span
                    aria-hidden
                    className={`absolute inset-x-4 -bottom-px h-[2px] rounded-full bg-orbit-gold transition-opacity duration-300 ${
                      active ? "opacity-100" : "opacity-0"
                    }`}
                  />
                </a>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <div className="hidden items-center gap-4 pr-1 sm:flex md:hidden lg:flex lg:gap-5 lg:pr-2">
            <PriceTicker symbol="ORE" />
            <PriceTicker symbol="SOL" className="hidden xl:inline-flex" />
          </div>
          <BuyOrbButton />
          <ConnectButton />
        </div>
      </div>

      {/* Hairline of brass light along the header's foot — present only
          once the bar is solid, so it reads as the edge of a surface. */}
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 -bottom-px h-px bg-gradient-to-r from-transparent via-orbit-gold/35 to-transparent transition-opacity duration-300 ${
          scrolled ? "opacity-100" : "opacity-0"
        }`}
      />
    </header>
  );
}

export function AppShell({
  route,
  children,
}: {
  route: Route;
  children: ReactNode;
}) {
  return (
    // pb-14 reserves the mobile bottom-nav strip so the footer clears it.
    <div className="flex min-h-full flex-col pb-14 md:pb-0">
      <Header route={route} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-3 py-5 sm:px-6 sm:py-8">
        {children}
      </main>
      <BottomNav route={route} />
    </div>
  );
}
