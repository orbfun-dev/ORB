// @vitest-environment happy-dom
/**
 * Component mount smoke gates (audit STEP 0): the interactive
 * components mount across ALL six KAT fixture scenarios — React
 * lifecycle bugs (render loops, effect churn, thrown slice math) surface
 * here as mount failures, not in a browser demo.
 *
 * Plus the two audit-specific regressions:
 * - settled-round reconnect (CRITICAL 1): a settled round with NO
 *   settlement event in flight must mount OrbitWheel once, not loop;
 * - sparse-book refund path (CRITICAL 2): a partially-refunded cancelled
 *   round must keep the wheel, the feed, and the refund CTA path alive.
 */

import { StrictMode, useEffect, useMemo, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { afterEach, describe, expect, it } from "vitest";
import { findWinningEntry } from "@orbit-jackpot/sdk";
import { OrbitWheel } from "../src/components/wheel/OrbitWheel";
import { PlayCard } from "../src/components/play/PlayCard";
import { YourRewardsCard } from "../src/components/claim/YourRewardsCard";
import { ParticipantsFeed } from "../src/components/participants/ParticipantsFeed";
import { ToastProvider } from "../src/context/ToastProvider";
import { OrbitClientProvider } from "../src/context/OrbitClientProvider";
import {
  RoundDataContext,
  RoundDataProvider,
  liveInitialState,
  roundDataReducer,
  type RoundDataState,
} from "../src/context/RoundDataProvider";
import { buildFixtureSnapshot, FIXTURE_SCENARIO_NAMES } from "../src/dev/fixtures";
import { useWheelSpin } from "../src/components/wheel/useWheelSpin";

/** Bare hook render (useWheelSpin touches no providers, only refs). */
function useWheelSpinNoop() {
  return useWheelSpin();
}

const NOW_MS = 1_700_000_000_000;

/** The main.tsx provider stack (minus ErrorBoundary — crashes must fail). */
function Providers({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [], []);
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
    [],
  );
  return (
    <ConnectionProvider endpoint={"http://127.0.0.1:8899"} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <OrbitClientProvider>{children}</OrbitClientProvider>
            </ToastProvider>
          </QueryClientProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

/** Sets the dev URL params (`?fixture=` / `?wallet=`) BEFORE any mount. */
function setParams(params: Record<string, string>): void {
  const search = new URLSearchParams(params).toString();
  const happy = (window as unknown as { happyDOM?: { setURL: (url: string) => void } }).happyDOM;
  happy?.setURL(`http://localhost:5173/?${search}`);
}

afterEach(cleanup);

describe("mount smoke — every component across all 6 KAT fixture states", () => {
  for (const name of FIXTURE_SCENARIO_NAMES) {
    it(`${name}: OrbitWheel + PlayCard + YourRewardsCard mount and settle`, async () => {
      setParams({ fixture: name });
      render(
        <StrictMode>
          <Providers>
            <RoundDataProvider>
              <OrbitWheel />
              <PlayCard />
              <YourRewardsCard />
            </RoundDataProvider>
          </Providers>
        </StrictMode>,
      );

      // PlayCard always renders both tabs; the wheel always renders its
      // svg ring. Two raf/effect turns prove the tree settles instead of
      // looping (the loop bug throws "Maximum update depth exceeded").
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "auto" })).toBeTruthy();
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(document.querySelector("svg")).not.toBeNull();
      expect(screen.getByRole("button", { name: "manual" })).toBeTruthy();
      // No silent disables (the 2026-10-07 rule): with no wallet the
      // primary CTA says what to do instead of sitting dead.
      expect(screen.getByRole("button", { name: /connect wallet/i })).toBeTruthy();
    });
  }

  it("megaSettled: the KAT winner's prize rides the ONE combined claim", async () => {
    const snapshot = buildFixtureSnapshot("megaSettled", NOW_MS / 1000)!;
    const winner = findWinningEntry(snapshot.entries, snapshot.round.winningTicket)!;
    setParams({ fixture: "megaSettled", wallet: winner.player });

    render(
      <Providers>
        <RoundDataProvider>
          <YourRewardsCard />
        </RoundDataProvider>
      </Providers>,
    );

    // The prize is no longer its own row with its own button: it is
    // folded into the single claim, because `close_entry` refuses the
    // winning entry until the prize is claimed — the two have to travel in
    // one transaction anyway (see `planClaimAll`).
    await waitFor(() => {
      expect(screen.getByText("Claimable")).toBeTruthy();
    });
    // The win shows as its own "+X SOL won" line under the total.
    expect(screen.getByTestId("reward-win").textContent).toMatch(/^\+\d+\.\d{2,4} SOL won$/);
    // No signing wallet connected in the harness — CTA says so, disabled.
    const ctas = screen.getAllByRole("button", { name: "CONNECT TO CLAIM" });
    expect(ctas).toHaveLength(1);
  });

  it("cancelled: a participant sees the Refund row (dev wallet override)", async () => {
    const snapshot = buildFixtureSnapshot("cancelled", NOW_MS / 1000)!;
    const player = snapshot.entries[0]!.player;
    setParams({ fixture: "cancelled", wallet: player });

    render(
      <Providers>
        <RoundDataProvider>
          <YourRewardsCard />
        </RoundDataProvider>
      </Providers>,
    );

    await waitFor(() => {
      expect(screen.getByText("Refund")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: /CONNECT TO REFUND/ })).toBeTruthy();
  });
});

describe("settled-round reconnect — the render-loop regression (audit CRITICAL 1)", () => {
  it("useWheelSpin returns a referentially stable controller", () => {
    // The other half of the fix: `spin` sits in effect dependency arrays,
    // so the returned object must keep its identity across renders —
    // otherwise every render re-arms every wheel effect.
    const { result, rerender } = renderHook(() => useWheelSpinNoop());
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
  });

  it("mounts OrbitWheel on a settled round with no settlement event without looping", async () => {
    // Exactly the live reconnect state: page loaded on a settled round,
    // account decoded, no ROUND_SETTLED event heard — lastSettlement null.
    const settled = roundDataReducer(liveInitialState(NOW_MS), {
      type: "LOAD_FIXTURE",
      name: "megaSettled",
      nowMs: NOW_MS,
    });
    const reconnectState: RoundDataState = { ...settled, lastSettlement: null };

    const contextValue = {
      state: reconnectState,
      loadFixture: () => {},
      fixtureScenarioNames: [],
    };

    render(
      <StrictMode>
        <Providers>
          <RoundDataContext.Provider value={contextValue}>
            <OrbitWheel />
          </RoundDataContext.Provider>
        </Providers>
      </StrictMode>,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector("svg")).not.toBeNull();
  });
});

describe("sparse-book refund path — no ErrorBoundary trip (audit CRITICAL 2)", () => {
  it("keeps wheel + feed + refund CTA path alive on a partially-refunded book", async () => {
    // Cancelled round, entry 0 already refunded & closed (account gone):
    // the book starts at index 1 — raw calculateWheelSlices throws on it.
    const cancelled = roundDataReducer(liveInitialState(NOW_MS), {
      type: "LOAD_FIXTURE",
      name: "cancelled",
      nowMs: NOW_MS,
    });
    const sparse = roundDataReducer(cancelled, {
      type: "ACCOUNTS_UPDATED",
      entries: cancelled.entries.slice(1),
    });
    expect(sparse.entries[0]!.ticketStart).toBeGreaterThan(0n); // precondition: a real gap

    const contextValue = {
      state: sparse,
      loadFixture: () => {},
      fixtureScenarioNames: [],
    };

    setParams({ wallet: sparse.entries[0]!.player });
    render(
      <StrictMode>
        <Providers>
          <RoundDataContext.Provider value={contextValue}>
            <OrbitWheel />
            <ParticipantsFeed />
            <YourRewardsCard />
          </RoundDataContext.Provider>
        </Providers>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByText("PLAYERS")).toBeTruthy();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The still-unrefunded player's row and their refund CTA both render.
    expect(screen.getByText("Refund")).toBeTruthy();
    expect(screen.getByRole("button", { name: /CONNECT TO REFUND/ })).toBeTruthy();
    expect(document.querySelector("svg")).not.toBeNull();
  });
});
