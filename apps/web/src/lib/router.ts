/**
 * Minimal hash router for every page (Play / ORE / Raffle / Docs / raffle
 * rules). Hash-based on purpose: static hosting on Vercel needs no SPA
 * rewrites, and a five-page app doesn't justify a router dependency.
 *
 * Routes: "" | "#/" | "#/play" → play; "#/ore" → ORE mining;
 * "#/raffle" → raffle; "#/docs" → docs; "#/raffle-rules" → the
 * entry-draw rules. Anything else falls back to play so a stale hash can
 * never blank the page.
 *
 * The rules page is linkable on its own (it gets shared outside the app)
 * but navigationally it belongs under Docs — see `navGroup`.
 *
 * The ORE page is an ordinary tab inside the shared shell. It talks to
 * mainnet, so it scopes its own mainnet connection around its content
 * (src/pages/OrePage.tsx); the legacy /ore-lite path is redirected to
 * "#/ore" by main.tsx so old links keep working.
 */

import { useEffect, useState } from "react";

export type Route = "play" | "docs" | "ore" | "raffle" | "raffle-rules";

export const PLAY_HREF = "#/";
export const DOCS_HREF = "#/docs";
export const ORE_HREF = "#/ore";
export const RAFFLE_HREF = "#/raffle";
export const RAFFLE_RULES_HREF = "#/raffle-rules";

function routeFromHash(): Route {
  const hash = window.location.hash;
  // Checked before "#/docs" would be, though they don't overlap — the
  // order is what keeps adding a "#/docs-something" route from silently
  // matching the wrong branch later.
  // "#/raffle-rules" first: it is a prefix match, so "#/raffle" would
  // otherwise swallow it and the rules page would never render.
  if (hash.startsWith("#/raffle-rules")) return "raffle-rules";
  if (hash.startsWith("#/raffle")) return "raffle";
  if (hash.startsWith("#/ore")) return "ore";
  return hash.startsWith("#/docs") ? "docs" : "play";
}

/**
 * Which nav item lights up for a route. The rules page has no tab of
 * its own — it is reached from Docs and from the raffle page — so it
 * lights Docs rather than leaving the whole navigator looking inactive.
 */
export function navGroup(route: Route): Route {
  return route === "raffle-rules" ? "docs" : route;
}

/** Subscribes to hashchange; scrolls to top on every navigation. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(routeFromHash);
  useEffect(() => {
    const onHash = (): void => {
      setRoute(routeFromHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}
