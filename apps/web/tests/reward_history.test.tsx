// @vitest-environment happy-dom
/**
 * The rewards card's History — paid-out money, the last 10 rounds, shown
 * only on request. It replaced a "Refunded" receipt row that sat in the
 * claim column for ten minutes after the keeper paid, which read as money
 * still to collect (owner report, 2026-10-08).
 */

import { StrictMode, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { YourRewardsCard } from "../src/components/claim/YourRewardsCard";
import { ToastProvider } from "../src/context/ToastProvider";
import { OrbitClientProvider } from "../src/context/OrbitClientProvider";
import {
  RoundDataContext,
  liveInitialState,
  type PayoutRecord,
  type RoundDataState,
} from "../src/context/RoundDataProvider";
import {
  HISTORY_MAX_ROUNDS,
  groupHistory,
  loadHistory,
  mergeHistory,
  saveHistory,
  type HistoryItem,
} from "../src/lib/rewardHistory";
import { escrowAddressOf } from "../src/lib/identity";

const NOW_MS = 1_791_410_000_000;
const SOL = 1_000_000_000n;
// A real on-curve key, so the escrow PDA derivation works.
const WALLET = "2sjHXq4BEhXgYpZVgiTAC3oNMc55Wmrz3m2TpdxqnbdD";
const OTHER = "chumAA7QjpFzpEtZ2XezM8onHrt8of4w35p3VMS4C6T";

function payout(
  kind: PayoutRecord["kind"],
  roundId: bigint,
  lamports: bigint,
  player = WALLET,
  entryIndex = 0,
): HistoryItem {
  return { kind, roundId, entryIndex, player, lamports, at: NOW_MS };
}

describe("mergeHistory / groupHistory — the ledger's gates", () => {
  it("drops duplicates and returns the SAME array when nothing is new", () => {
    const base = mergeHistory([], [payout("refund", 277n, SOL / 10n)]);
    expect(base).toHaveLength(1);
    expect(mergeHistory(base, [payout("refund", 277n, SOL / 10n)])).toBe(base);
  });

  it(`keeps only the newest ${HISTORY_MAX_ROUNDS} rounds`, () => {
    const items = Array.from({ length: 14 }, (_, i) => payout("refund", BigInt(260 + i), SOL));
    const merged = mergeHistory([], items);
    const rounds = [...new Set(merged.map((i) => i.roundId))];
    expect(rounds).toHaveLength(HISTORY_MAX_ROUNDS);
    expect(rounds).not.toContain(260n);
    expect(rounds).toContain(273n);
  });

  it("groups a round's prize + refund into one row, newest round first, escrow split out", () => {
    const escrow = escrowAddressOf(WALLET);
    const rows = groupHistory(
      [
        payout("refund", 277n, SOL / 10n),
        payout("prize", 279n, 18_000_000n, escrow),
        payout("settledRefund", 279n, 89_000_000n, escrow),
      ],
      WALLET,
    );
    expect(rows.map((r) => r.roundId)).toEqual([279n, 277n]);
    expect(rows[0]!.lamports).toBe(107_000_000n);
    expect(rows[0]!.escrowLamports).toBe(107_000_000n);
    expect(rows[1]!.escrowLamports).toBe(0n);
  });

  it("ignores zero-lamport payouts (nothing was paid)", () => {
    expect(mergeHistory([], [payout("settledRefund", 279n, 0n)])).toHaveLength(0);
  });
});

describe("history store — the reload mirror", () => {
  it("round-trips through localStorage and survives a corrupt payload", () => {
    saveHistory(WALLET, [payout("prize", 279n, 18_000_000n)]);
    expect(loadHistory(WALLET)).toEqual([payout("prize", 279n, 18_000_000n)]);
    window.localStorage.setItem(`orbit:history:v1:${WALLET}`, "{not json");
    expect(loadHistory(WALLET)).toEqual([]);
  });
});

/** The main.tsx provider stack (minus RoundDataProvider — states are crafted). */
function Providers({ children }: { children: ReactNode }) {
  const wallets: never[] = [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
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

function setWalletParam(wallet: string): void {
  const happy = (window as unknown as { happyDOM?: { setURL: (url: string) => void } }).happyDOM;
  happy?.setURL(`http://localhost:5173/?wallet=${wallet}`);
}

function mountCard(state: RoundDataState, history: readonly HistoryItem[] = []): void {
  render(
    <StrictMode>
      <Providers>
        <RoundDataContext.Provider
          value={{ state, history, loadFixture: () => {}, fixtureScenarioNames: [] }}
        >
          <YourRewardsCard />
        </RoundDataContext.Provider>
      </Providers>
    </StrictMode>,
  );
}

afterEach(cleanup);

beforeAll(() => {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
});

describe("the mounted card", () => {
  it("History is collapsed until clicked, then lists each paid round", async () => {
    setWalletParam(WALLET);
    const state: RoundDataState = {
      ...liveInitialState(NOW_MS),
      payouts: [payout("prize", 279n, 18_000_000n), payout("settledRefund", 279n, 89_000_000n)],
    };
    mountCard(state, [payout("refund", 277n, SOL / 10n)]);
    const toggle = await screen.findByRole("button", { name: /history/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/Round 279/)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/Round 279/)).toBeTruthy();
    expect(screen.getByText(/prize \+ refund/i)).toBeTruthy();
    expect(screen.getByText(/Round 277/)).toBeTruthy();
    expect(screen.getByText(/refunded in full/i)).toBeTruthy();
  });

  it("another player's payouts never reach this wallet's History", async () => {
    setWalletParam(WALLET);
    const state: RoundDataState = {
      ...liveInitialState(NOW_MS),
      payouts: [payout("settledRefund", 279n, 89_000_000n, OTHER, 1)],
    };
    mountCard(state);
    fireEvent.click(await screen.findByRole("button", { name: /history/i }));
    expect(screen.queryByText(/Round 279/)).toBeNull();
    expect(screen.getByText(/nothing paid out yet/i)).toBeTruthy();
  });
});
