/**
 * The ORE tab: mainnet ORE mining, rendered inside the shared shell like
 * Play, Raffle and Docs.
 *
 * The only file outside src/features/ore-lite allowed to import it
 * (tests/ore_isolation.test.ts). Lazy on purpose: the feature's config
 * module throws at load when VITE_ORE_FEE_RECIPIENT is unset, and the
 * error boundary here keeps that throw inside this tab — the header, the
 * nav and every other page stay up.
 */

import { Suspense, lazy } from "react";
import { ErrorBoundary } from "../components/common/ErrorBoundary";

const OreLiteRoot = lazy(() =>
  import("../features/ore-lite/OreLiteRoot").then((m) => ({ default: m.OreLiteRoot })),
);

export function OrePage() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex min-h-[40vh] items-center justify-center">
            <span className="num animate-pulse text-sm tracking-widest text-orbit-muted">
              LOADING ORE…
            </span>
          </div>
        }
      >
        <OreLiteRoot />
      </Suspense>
    </ErrorBoundary>
  );
}
