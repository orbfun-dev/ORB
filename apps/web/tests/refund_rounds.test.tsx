// @vitest-environment happy-dom
/**
 * Refund-row persistence gates: the 89% pool shares a settled round owes
 * must stay VISIBLE and claimable after the wheel rolls on — the card used
 * to read only the current round's entries, so a loser's refund row
 * vanished the instant round N+1 opened (and on every reload), even though
 * the chain still owed the money until `close_entry` paid it.
 *
 * Covered end to end at the pure seams the feature lives on:
 *  - the reducer's `refundRounds` book (snapshot → rollover → live prune),
 *  - `refundRowsOf` (the card's per-round gates, wallet + escrow),
 *  - `refundStore` (the localStorage mirror that survives reloads),
 *  - the mounted card on a ROLLED-OVER state (the regression itself).
 */

import { StrictMode, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { findWinningEntry, type PlayerEntryAccountData } from "@orbit-jackpot/sdk";
import { YourRewardsCard, refundRowsOf } from "../src/components/claim/YourRewardsCard";
import { ToastProvider } from "../src/context/ToastProvider";
import { OrbitClientProvider } from "../src/context/OrbitClientProvider";
import {
  RoundDataContext,
  liveInitialState,
  roundDataReducer,
  type RefundRound,
  type RoundDataState,
} from "../src/context/RoundDataProvider";
import { buildFixtureSnapshot } from "../src/dev/fixtures";
import { loadRefundRounds, saveRefundRounds } from "../src/lib/refundStore";

const NOW_MS = 1_700_000_000_000;
const WALLET_A = "A".repeat(44);
const WALLET_B = "B".repeat(44);
const SOL = 1_000_000_000n;

/** A minimal entry account — only the gates' fields carry meaning. */
function entry(
  roundId: bigint,
  entryIndex: number,
  player: string,
  amountLamports: bigint,
  ticketStart: bigint,
): PlayerEntryAccountData {
  return {
    roundId,
    entryIndex,
    player,
    amountLamports,
    ticketStart,
    ticketEnd: ticketStart + amountLamports,
    depositTs: 0n,
    depositSlot: 0n,
    bump: 0,
  };
}

function refundPaid(roundId: bigint, e: { entryIndex: number; player: string }) {
  return {
    type: "ENTRY_REFUND_PAID" as const,
    event: {
      roundId,
      entryIndex: e.entryIndex,
      player: e.player,
      amountLamports: 0n,
      refundLamports: 0n,
      megaFieldLamports: 0n,
    },
  };
}

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

/** Sets the dev `?wallet=` param BEFORE any mount. */
function setWalletParam(wallet: string): void {
  const happy = (window as unknown as { happyDOM?: { setURL: (url: string) => void } }).happyDOM;
  happy?.setURL(`http://localhost:5173/?wallet=${wallet}`);
}

function mountCard(state: RoundDataState): void {
  render(
    <StrictMode>
      <Providers>
        <RoundDataContext.Provider
          value={{ state, loadFixture: () => {}, fixtureScenarioNames: [] }}
        >
          <YourRewardsCard />
        </RoundDataContext.Provider>
      </Providers>
    </StrictMode>,
  );
}

afterEach(cleanup);

/** This happy-dom/vitest pairing exposes no `window.localStorage` — the
 *  browser API stands in as an in-memory Storage (the store module itself
 *  is browser-targeted, same as `lib/claims.ts`). */
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

describe("refundRounds — the rollover-persistent refund book", () => {
  const settled = roundDataReducer(liveInitialState(NOW_MS), {
    type: "LOAD_FIXTURE",
    name: "megaSettled",
    nowMs: NOW_MS,
  });

  it("a settled fixture seeds the refund record (whole book, prize unresolved)", () => {
    expect(settled.refundRounds.size).toBe(1);
    const record = settled.refundRounds.get(11n)!;
    expect(record.entries).toHaveLength(3);
    expect(record.prizeClaimed).toBe(false);
    expect(record.megaFieldPool).toBeGreaterThan(0n);
  });

  it("ROUND_OPENED rolls the wheel but keeps the refund records — the regression", () => {
    const opened = roundDataReducer(settled, {
      type: "ROUND_OPENED",
      event: {
        roundId: 12n,
        startTs: BigInt(Math.floor(NOW_MS / 1000)),
        endTs: BigInt(Math.floor(NOW_MS / 1000) + 300),
      },
    });
    expect(opened.entries).toHaveLength(0); // the old book is gone…
    expect(opened.round?.roundId).toBe(12n);
    expect(opened.refundRounds.get(11n)).toBeDefined(); // …the refund record is not
  });

  it("ENTRY_REFUND_PAID prunes the closed entry and drops an emptied record", () => {
    const opened = roundDataReducer(settled, {
      type: "ROUND_OPENED",
      event: { roundId: 12n, startTs: 0n, endTs: 0n },
    });
    const first = opened.refundRounds.get(11n)!.entries[0]!;
    const pruned = roundDataReducer(opened, refundPaid(11n, first));
    expect(pruned.refundRounds.get(11n)!.entries).toHaveLength(2);

    let drained = pruned;
    for (const e of [...pruned.refundRounds.get(11n)!.entries]) {
      drained = roundDataReducer(drained, refundPaid(11n, e));
    }
    expect(drained.refundRounds.has(11n)).toBe(false); // fully paid → gone
  });

  it("a stale or unknown refund event leaves the refund book untouched", () => {
    // Logged as a payout for the history, but the book (same map object)
    // must not move.
    const stale = roundDataReducer(settled, refundPaid(11n, { entryIndex: 99, player: WALLET_A }));
    expect(stale.refundRounds).toBe(settled.refundRounds);
    const otherRound = roundDataReducer(
      settled,
      refundPaid(999n, { entryIndex: 0, player: WALLET_A }),
    );
    expect(otherRound.refundRounds).toBe(settled.refundRounds);
  });

  it("PRIZE_CLAIMED flips the record's prizeClaimed — the winning entry unlocks", () => {
    const claimed = roundDataReducer(settled, {
      type: "PRIZE_CLAIMED",
      event: {
        roundId: 11n,
        entryIndex: 0,
        winner: WALLET_A,
        winningTicket: 0n,
        winnerPayout: 0n,
        megaAwarded: 0n,
      },
    });
    expect(claimed.refundRounds.get(11n)!.prizeClaimed).toBe(true);
  });

  it("HYDRATE_REFUNDS merges UNDER the session map — stored wallet-filtered books never replace it", () => {
    const session = settled.refundRounds.get(11n)!;
    const stored: RefundRound = {
      ...session,
      entries: [session.entries[0]!], // what a wallet-filtered save looks like
    };
    const hydrated = roundDataReducer(settled, { type: "HYDRATE_REFUNDS", records: [stored] });
    expect(hydrated.refundRounds.get(11n)!.entries).toHaveLength(3); // session book wins
    expect(hydrated.refundRounds.size).toBe(1); // no duplicate round added
  });
});

describe("refundRowsOf — the card's per-round gates", () => {
  // Round 10: loser L (2 SOL) + winner W (8 SOL), prize claimed.
  // Round 11: loser L (1 SOL) + winner W (9 SOL), prize UNCLAIMED.
  const round10: RefundRound = {
    roundId: 10n,
    refundPool: (89n * SOL) / 10n * 10n, // 8.9 SOL
    megaFieldPool: 0n,
    totalLamports: 10n * SOL,
    winningTicket: 2n * SOL, // inside W's range
    prizeClaimed: true,
    settleTs: 100n,
    entries: [entry(10n, 0, WALLET_A, 2n * SOL, 0n), entry(10n, 1, WALLET_B, 8n * SOL, 2n * SOL)],
  };
  const round11: RefundRound = {
    ...round10,
    roundId: 11n,
    prizeClaimed: false,
    settleTs: 200n,
    entries: [entry(11n, 0, WALLET_A, 1n * SOL, 0n), entry(11n, 1, WALLET_B, 9n * SOL, 1n * SOL)],
  };

  it("the loser sees one row per round, newest first, winner-held entries excluded until the prize resolves", () => {
    const rows = refundRowsOf([round10, round11], WALLET_A);
    expect(rows.map((r) => r.record.roundId)).toEqual([11n, 10n]); // newest first
    // Round 11's prize is unclaimed but L's entry is not the winner — closable now.
    expect(rows[0]!.payouts).toHaveLength(1);
    expect(rows[0]!.closable).toHaveLength(1);
    expect(rows[0]!.total).toBe((89n * SOL) / 10n); // 1 SOL × 89%
  });

  it("the WINNER's own entry is not closable while the prize is unclaimed, then unlocks", () => {
    const before = refundRowsOf([round11], WALLET_B);
    expect(before[0]!.payouts).toHaveLength(1);
    expect(before[0]!.closable).toHaveLength(0); // WinningEntryNotClaimed guard
    const after = refundRowsOf([{ ...round11, prizeClaimed: true }], WALLET_B);
    expect(after[0]!.closable).toHaveLength(1);
  });

  it("a round with none of the wallet's entries renders no row", () => {
    expect(refundRowsOf([round10, round11], "C".repeat(44))).toEqual([]);
  });
});

describe("refundStore — the localStorage mirror", () => {
  it("round-trips bigint money fields and rehydrates accounts with zeroed rent fields", () => {
    const round: RefundRound = {
      roundId: 42n,
      refundPool: 8_900_000_000n,
      megaFieldPool: 1n,
      totalLamports: 10n * SOL,
      winningTicket: 3n,
      prizeClaimed: false,
      settleTs: 1_700_000_100n,
      entries: [entry(42n, 0, WALLET_A, SOL, 0n)],
    };
    saveRefundRounds(WALLET_A, [round]);
    const loaded = loadRefundRounds(WALLET_A);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.roundId).toBe(42n);
    expect(loaded[0]!.refundPool).toBe(8_900_000_000n);
    expect(loaded[0]!.megaFieldPool).toBe(1n);
    expect(loaded[0]!.entries[0]!.amountLamports).toBe(SOL);
    expect(loaded[0]!.entries[0]!.ticketEnd).toBe(SOL);
    expect(loaded[0]!.entries[0]!.depositTs).toBe(0n);
    // Wallet-scoped: another wallet's store stays empty.
    expect(loadRefundRounds(WALLET_B)).toEqual([]);
  });

  it("drops corrupt records instead of crashing the card", () => {
    window.localStorage.setItem(`orbit:refunds:v1:${WALLET_A}`, '[{"roundId":"x"}]');
    expect(loadRefundRounds(WALLET_A)).toEqual([]);
    window.localStorage.setItem(`orbit:refunds:v1:${WALLET_A}`, "not json");
    expect(loadRefundRounds(WALLET_A)).toEqual([]);
  });
});

describe("mount — the rewards card on a ROLLED-OVER round (the owner's report)", () => {
  it("a loser's 89% refund row and CTA survive the rollover", async () => {
    const settled = roundDataReducer(liveInitialState(NOW_MS), {
      type: "LOAD_FIXTURE",
      name: "megaSettled",
      nowMs: NOW_MS,
    });
    const snapshot = buildFixtureSnapshot("megaSettled", NOW_MS / 1000)!;
    const winner = findWinningEntry(snapshot.entries, snapshot.round.winningTicket)!;
    const loser = snapshot.entries.find((e) => e.player !== winner.player)!;

    const rolled = roundDataReducer(settled, {
      type: "ROUND_OPENED",
      event: {
        roundId: settled.round!.roundId + 1n,
        startTs: BigInt(Math.floor(NOW_MS / 1000)),
        endTs: BigInt(Math.floor(NOW_MS / 1000) + 300),
      },
    });
    // Preconditions: the old book is gone, the current round is open —
    // exactly the state that used to hide the refund.
    expect(rolled.entries).toHaveLength(0);
    expect(rolled.round!.state).toBe("open");

    setWalletParam(loser.player);
    mountCard(rolled);
    await waitFor(() => {
      expect(screen.getByText("Claimable")).toBeTruthy();
    });
    // No signing wallet in the harness — the CTA says so (and is enabled
    // for a signer): the row is ALIVE, not vanished.
    expect(screen.getByRole("button", { name: "CONNECT TO CLAIM" })).toBeTruthy();
    // Refunds render as ONE combined row now (the owner's "show it
    // combined, not separately" note), so the sub-line counts entries and
    // rounds instead of naming the round.
    expect(screen.getByText(/1 entry across 1 round/)).toBeTruthy();
  });

  it("the keeper's close_entry sweep empties the row live (EntryRefundPaid prune)", async () => {
    const settled = roundDataReducer(liveInitialState(NOW_MS), {
      type: "LOAD_FIXTURE",
      name: "megaSettled",
      nowMs: NOW_MS,
    });
    const snapshot = buildFixtureSnapshot("megaSettled", NOW_MS / 1000)!;
    const winner = findWinningEntry(snapshot.entries, snapshot.round.winningTicket)!;
    const loser = snapshot.entries.find((e) => e.player !== winner.player)!;

    let state: RoundDataState = roundDataReducer(settled, {
      type: "ROUND_OPENED",
      event: { roundId: 12n, startTs: 0n, endTs: 0n },
    });
    // The keeper closes every entry of round 11 (the winner claimed first).
    state = roundDataReducer(state, {
      type: "PRIZE_CLAIMED",
      event: {
        roundId: 11n,
        entryIndex: winner.entryIndex,
        winner: winner.player,
        winningTicket: 0n,
        winnerPayout: 0n,
        megaAwarded: 0n,
      },
    });
    for (const e of snapshot.entries) {
      state = roundDataReducer(state, refundPaid(11n, e));
    }

    setWalletParam(loser.player);
    mountCard(state);
    await waitFor(() => {
      expect(screen.getByText(/Nothing to claim right now/)).toBeTruthy();
    });
  });
});
