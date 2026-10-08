// @vitest-environment happy-dom
/**
 * Cancelled-round refund persistence: the full stake a cancelled round
 * owes must stay VISIBLE and claimable after the wheel rolls on, and must
 * leave a RECEIPT once the keeper pays it.
 *
 * `d126f12` gave SETTLED rounds a rollover-persistent refund book; the
 * cancelled path was left reading `state.round.state === "cancelled"` and
 * `state.entries` — the CURRENT round only. On devnet that is a row the
 * player sees for about a second: `lock_round` cancels a sole-depositor
 * round and the keeper opens the next one immediately. Observed live on
 * 2026-10-07:
 *
 *   20:40:13  LockRound    → cancelled (sole depositor) → row appears
 *   20:40:14  OpenRound    → row disappears
 *   20:40:17  RefundEntry  → the keeper pays anyway
 *
 * Covered at the seams the feature lives on:
 *  - the reducer's `cancelledRounds` book (snapshot → rollover → receipt),
 *  - `cancelledRowsOf` / `combineCancelledRows` (the card's gates),
 *  - `cancelledStore` (the localStorage mirror that survives reloads),
 *  - the mounted card on a ROLLED-OVER state (the regression itself).
 */

import { StrictMode, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EntryRefundedEvent, PlayerEntryAccountData, RoundData } from "@orbit-jackpot/sdk";
import {
  YourRewardsCard,
  cancelledRowsOf,
  combineCancelledRows,
} from "../src/components/claim/YourRewardsCard";
import { ToastProvider } from "../src/context/ToastProvider";
import { OrbitClientProvider } from "../src/context/OrbitClientProvider";
import {
  CANCELLED_RECEIPT_TTL_MS,
  RoundDataContext,
  liveInitialState,
  roundDataReducer,
  type CancelledRound,
  type RoundDataState,
} from "../src/context/RoundDataProvider";
import { buildFixtureSnapshot } from "../src/dev/fixtures";
import { escrowAddressOf } from "../src/lib/identity";
import { loadCancelledRounds, saveCancelledRounds } from "../src/lib/cancelledStore";

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = BigInt(Math.floor(NOW_MS / 1000));

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

const snapshot = buildFixtureSnapshot("cancelled", Number(NOW_SEC))!;
const PLAYER = snapshot.entries[0]!.player;
const ROUND_ID = snapshot.round.roundId;
const cancelledRound: RoundData = { ...snapshot.round, state: "cancelled" };
const cancelledEntries: PlayerEntryAccountData[] = [...snapshot.entries];

/** The state a player is in the instant their round cancelled. */
const atCancel: RoundDataState = roundDataReducer(
  roundDataReducer(liveInitialState(NOW_MS), {
    type: "ACCOUNTS_UPDATED",
    config: snapshot.config,
    round: { ...snapshot.round, state: "locked" },
    entries: cancelledEntries,
  }),
  { type: "ROUND_CANCELLED", event: { roundId: ROUND_ID, reason: 1 } },
);

/** …and one second later, when the keeper opens the next round. */
const afterRollover: RoundDataState = roundDataReducer(atCancel, {
  type: "ROUND_OPENED",
  event: { roundId: ROUND_ID + 1n, startTs: NOW_SEC, endTs: NOW_SEC + 60n },
});

function refunded(entryIndex: number, player: string, amountLamports: bigint): EntryRefundedEvent {
  return { roundId: ROUND_ID, entryIndex, player, amountLamports };
}

describe("cancelledRounds — the rollover-persistent cancel book", () => {
  it("ROUND_CANCELLED snapshots the whole book, nothing paid yet", () => {
    expect(atCancel.round?.state).toBe("cancelled");
    const record = atCancel.cancelledRounds.get(ROUND_ID)!;
    expect(record.entries).toHaveLength(cancelledEntries.length);
    expect(record.refunded).toHaveLength(0);
    expect(record.receiptAt).toBeNull();
    expect(record.endTs).toBe(cancelledRound.endTs);
  });

  it("ROUND_OPENED rolls the wheel but keeps the cancel record — the regression", () => {
    expect(afterRollover.entries).toHaveLength(0); // the old book is gone…
    expect(afterRollover.round?.roundId).toBe(ROUND_ID + 1n);
    expect(afterRollover.cancelledRounds.get(ROUND_ID)).toBeDefined(); // …the record is not
  });

  it("ENTRY_REFUNDED moves each paid entry to the receipt, the last one stamps it", () => {
    let state = afterRollover;
    const book = [...afterRollover.cancelledRounds.get(ROUND_ID)!.entries];
    state = roundDataReducer(state, {
      type: "ENTRY_REFUNDED",
      event: refunded(book[0]!.entryIndex, book[0]!.player, book[0]!.amountLamports),
      nowMs: NOW_MS,
    });
    let record = state.cancelledRounds.get(ROUND_ID)!;
    expect(record.entries).toHaveLength(book.length - 1);
    expect(record.refunded).toHaveLength(1);
    expect(record.receiptAt).toBeNull(); // money still owed

    for (const e of book.slice(1)) {
      state = roundDataReducer(state, {
        type: "ENTRY_REFUNDED",
        event: refunded(e.entryIndex, e.player, e.amountLamports),
        nowMs: NOW_MS,
      });
    }
    record = state.cancelledRounds.get(ROUND_ID)!;
    expect(record.entries).toHaveLength(0);
    expect(record.refunded).toHaveLength(book.length);
    expect(record.receiptAt).toBe(NOW_MS); // fully paid → a receipt, not a deletion
  });

  it("a stale or unknown refund event leaves the cancel book untouched", () => {
    // The payout itself is still real chain money, so it reaches the
    // history log — but the book (same map object) must not move.
    expect(
      roundDataReducer(afterRollover, {
        type: "ENTRY_REFUNDED",
        event: refunded(99, PLAYER, 1n),
        nowMs: NOW_MS,
      }).cancelledRounds,
    ).toBe(afterRollover.cancelledRounds);
    expect(
      roundDataReducer(afterRollover, {
        type: "ENTRY_REFUNDED",
        event: { roundId: 999n, entryIndex: 0, player: PLAYER, amountLamports: 1n },
        nowMs: NOW_MS,
      }).cancelledRounds,
    ).toBe(afterRollover.cancelledRounds);
  });

  it("the account poll never resurrects a paid entry as owed", () => {
    // The on-chain book shrinks as the keeper pays; re-deriving from it
    // must reconcile DOWNWARD only, and must not drop the receipt.
    const first = cancelledEntries[0]!;
    const paid = roundDataReducer(atCancel, {
      type: "ENTRY_REFUNDED",
      event: refunded(first.entryIndex, first.player, first.amountLamports),
      nowMs: NOW_MS,
    });
    const repolled = roundDataReducer(paid, {
      type: "ACCOUNTS_UPDATED",
      round: cancelledRound,
      entries: cancelledEntries, // a stale full book, as a poll may return
    });
    const record = repolled.cancelledRounds.get(ROUND_ID)!;
    expect(record.entries.some((e) => e.entryIndex === first.entryIndex)).toBe(false);
    expect(record.refunded).toHaveLength(1);
  });

  it("CLOCK_TICK retires an expired receipt and churns nothing otherwise", () => {
    let state = atCancel;
    for (const e of cancelledEntries) {
      state = roundDataReducer(state, {
        type: "ENTRY_REFUNDED",
        event: refunded(e.entryIndex, e.player, e.amountLamports),
        nowMs: NOW_MS,
      });
    }
    const ticked = roundDataReducer(state, { type: "CLOCK_TICK", nowMs: NOW_MS + 1_000 });
    expect(ticked.cancelledRounds).toBe(state.cancelledRounds); // same map, no churn
    const expired = roundDataReducer(state, {
      type: "CLOCK_TICK",
      nowMs: NOW_MS + CANCELLED_RECEIPT_TTL_MS + 1,
    });
    expect(expired.cancelledRounds.has(ROUND_ID)).toBe(false);
  });

  it("HYDRATE_CANCELLED merges UNDER the session map", () => {
    const session = atCancel.cancelledRounds.get(ROUND_ID)!;
    const stored: CancelledRound = { ...session, entries: [session.entries[0]!] };
    const hydrated = roundDataReducer(atCancel, {
      type: "HYDRATE_CANCELLED",
      records: [stored],
    });
    expect(hydrated.cancelledRounds.get(ROUND_ID)!.entries).toHaveLength(
      cancelledEntries.length,
    ); // the session book wins
    expect(hydrated.cancelledRounds.size).toBe(1);
  });
});

describe("cancelledRowsOf / combineCancelledRows — the card's gates", () => {
  const record = atCancel.cancelledRounds.get(ROUND_ID)!;

  it("one row per round the wallet has money in; other players' entries never count", () => {
    const mine = cancelledRowsOf([record], PLAYER);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.owed.every((e) => e.player === PLAYER)).toBe(true);
    expect(cancelledRowsOf([record], "Z".repeat(44))).toHaveLength(0);
  });

  it("combines the owed side into one figure and one target list", () => {
    const combined = combineCancelledRows(cancelledRowsOf([record], PLAYER), PLAYER);
    const expected = record.entries
      .filter((e) => e.player === PLAYER)
      .reduce((sum, e) => sum + e.amountLamports, 0n);
    expect(combined.owedLamports).toBe(expected);
    expect(combined.owedTargets.every((t) => t.roundId === ROUND_ID)).toBe(true);
    expect(combined.owedEscrowLamports).toBe(0n); // a plain wallet entry
    expect(combined.paidLamports).toBe(0n);
  });

  it("the receipt side names the round and the destination", () => {
    const player = record.entries.find((e) => e.player === PLAYER)!;
    const paid = roundDataReducer(atCancel, {
      type: "ENTRY_REFUNDED",
      event: refunded(player.entryIndex, player.player, player.amountLamports),
      nowMs: NOW_MS,
    }).cancelledRounds.get(ROUND_ID)!;
    const combined = combineCancelledRows(cancelledRowsOf([paid], PLAYER), PLAYER);
    expect(combined.paidLamports).toBe(player.amountLamports);
    expect(combined.paidRoundIds).toEqual([ROUND_ID]);
    expect(combined.paidEscrowLamports).toBe(0n);
    expect(combined.owedTargets).toHaveLength(0);
  });

  it("an auto-play entry is mine via the escrow PDA, and is counted as escrow-bound", () => {
    // The dual-identity rule: an auto-played entry's `player` IS the
    // viewer's escrow PDA, and `refund_entry` pays THAT, not the wallet.
    // The row has to claim it and the copy has to say where it lands.
    const escrow = escrowAddressOf(PLAYER);
    const autoEntry = record.entries.find((e) => e.player !== PLAYER)!;
    const escrowRecord: CancelledRound = {
      ...record,
      entries: record.entries.map((e) =>
        e.entryIndex === autoEntry.entryIndex ? { ...e, player: escrow } : e,
      ),
    };
    const rows = cancelledRowsOf([escrowRecord], PLAYER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owed).toHaveLength(2); // the wallet entry AND the escrow one
    const combined = combineCancelledRows(rows, PLAYER);
    expect(combined.owedEscrowLamports).toBe(autoEntry.amountLamports);
    expect(combined.owedLamports).toBe(
      escrowRecord.entries.reduce((sum, e) => sum + e.amountLamports, 0n),
    );
    expect(combined.owedTargets.some((t) => t.player === escrow)).toBe(true);
    // A stranger shares neither identity, so the round is not theirs.
    expect(cancelledRowsOf([escrowRecord], "Z".repeat(43))).toHaveLength(0);
  });
});

describe("cancelledStore — the reload mirror", () => {
  it("round-trips a record through localStorage, receipt and all", () => {
    const session = atCancel.cancelledRounds.get(ROUND_ID)!;
    const withReceipt: CancelledRound = {
      ...session,
      entries: [session.entries[0]!],
      refunded: [
        {
          entryIndex: session.entries[1]!.entryIndex,
          player: session.entries[1]!.player,
          amountLamports: session.entries[1]!.amountLamports,
        },
      ],
      receiptAt: null,
    };
    saveCancelledRounds(PLAYER, [withReceipt]);
    const [loaded] = loadCancelledRounds(PLAYER);
    expect(loaded).toBeDefined();
    expect(loaded!.roundId).toBe(ROUND_ID);
    expect(loaded!.endTs).toBe(withReceipt.endTs);
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.entries[0]!.amountLamports).toBe(session.entries[0]!.amountLamports);
    expect(loaded!.refunded).toHaveLength(1);
    expect(loaded!.refunded[0]!.amountLamports).toBe(session.entries[1]!.amountLamports);
    expect(loaded!.receiptAt).toBeNull();
  });

  it("a corrupt payload yields no records rather than throwing", () => {
    window.localStorage.setItem(`orbit:cancelled:v1:${PLAYER}`, "{not json");
    expect(loadCancelledRounds(PLAYER)).toEqual([]);
  });
});

describe("the mounted card", () => {
  it("shows the Refund row while the cancelled round is still current", async () => {
    setWalletParam(PLAYER);
    mountCard(atCancel);
    await waitFor(() => {
      expect(screen.getByText("Refund")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: /CONNECT TO REFUND/ })).toBeTruthy();
  });

  it("keeps the Refund row after the next round opens — the regression", async () => {
    setWalletParam(PLAYER);
    mountCard(afterRollover);
    await waitFor(() => {
      expect(screen.getByText("Refund")).toBeTruthy();
    });
  });

  it("once the keeper pays, the refund leaves the claim column for History", async () => {
    let state = afterRollover;
    for (const e of cancelledEntries) {
      state = roundDataReducer(state, {
        type: "ENTRY_REFUNDED",
        event: refunded(e.entryIndex, e.player, e.amountLamports),
        nowMs: NOW_MS,
      });
    }
    setWalletParam(PLAYER);
    mountCard(state);
    // Paid money is not claimable: no Refund button, no lingering receipt
    // row in the main column (the 2026-10-08 report — "refunded are still
    // showing even after refunded").
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /history/i })).toBeTruthy();
    });
    expect(screen.queryByText("Refund")).toBeNull();
    expect(screen.queryByText("Refunded")).toBeNull();
    expect(screen.queryByText(new RegExp(`Round ${ROUND_ID}`))).toBeNull(); // collapsed
    fireEvent.click(screen.getByRole("button", { name: /history/i }));
    expect(screen.getByText(new RegExp(`Round ${ROUND_ID}`))).toBeTruthy();
    expect(screen.getByText(/refunded in full/i)).toBeTruthy();
  });
});
