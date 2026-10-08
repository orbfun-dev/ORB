// @vitest-environment happy-dom
/**
 * The wheel and the players feed under the PIPELINED settle (see
 * pipelined_settle.test.ts for the reducer half). Owner report,
 * 2026-10-08: "the winning result isn't shown immediately after the round
 * ended", and "sometimes the arrow is pointing to the winner when the
 * next round is starting".
 *
 * Gates:
 *  - while round N draws behind N+1's open window, the wheel keeps N on
 *    stage (its round number, its book) and says DRAWING;
 *  - N's settlement lands against N's frozen book and names round N;
 *  - a settlement for a round the page has no book for presents nothing
 *    (it used to spin that ticket over the live round's arcs);
 *  - the feed never crowns a live-round row with an older round's ticket.
 */

import { StrictMode, useMemo, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PlayerEntryAccountData, RoundData, RoundSettledEvent } from "@orbit-jackpot/sdk";
import { OrbitWheel } from "../src/components/wheel/OrbitWheel";
import { ParticipantsFeed } from "../src/components/participants/ParticipantsFeed";
import { ToastProvider } from "../src/context/ToastProvider";
import { OrbitClientProvider } from "../src/context/OrbitClientProvider";
import {
  RoundDataContext,
  liveInitialState,
  roundDataReducer,
  type RoundDataAction,
  type RoundDataState,
} from "../src/context/RoundDataProvider";

const T0 = 1_791_409_980_000;
const SOL = 1_000_000_000n;
const WALLET_A = "2sjHXq4BEhXgYpZVgiTAC3oNMc55Wmrz3m2TpdxqnbdD";
const WALLET_B = "chumAA7QjpFzpEtZ2XezM8onHrt8of4w35p3VMS4C6T";
const WALLET_C = "7HQzM3eP3zQh7QhNTxpT2CkFWDkGd3UMTRZSonX34Dsr";

function round(roundId: bigint, over: Partial<RoundData> = {}): RoundData {
  return {
    roundId,
    state: "open",
    startTs: 1_791_409_918n,
    endTs: 1_791_409_978n,
    lockTs: 0n,
    lockSlot: 0n,
    settleTs: 0n,
    totalLamports: 0n,
    entryCount: 0,
    entriesClosed: 0,
    rentPayer: "11111111111111111111111111111111",
    firstDepositor: "11111111111111111111111111111111",
    singleDepositor: false,
    randomnessAccount: "11111111111111111111111111111111",
    randomnessCommitSlot: 0n,
    randomnessSeedSlot: 0n,
    winningTicket: 0n,
    winner: "11111111111111111111111111111111",
    winnerPayout: 0n,
    adminCut: 0n,
    megaCut: 0n,
    megaAwarded: 0n,
    refundPool: 0n,
    refundsPaid: 0n,
    megaFieldPool: 0n,
    megaFieldPaid: 0n,
    vaultOwed: 0n,
    megaTriggered: false,
    prizeClaimed: false,
    vaultBump: 0,
    bump: 0,
    ...over,
  };
}

function entry(roundId: bigint, entryIndex: number, player: string, start: bigint): PlayerEntryAccountData {
  const amount = SOL / 10n;
  return {
    roundId,
    entryIndex,
    player,
    amountLamports: amount,
    ticketStart: start,
    ticketEnd: start + amount,
    depositTs: 0n,
    depositSlot: 0n,
    bump: 0,
  };
}

const settled279: RoundSettledEvent = {
  roundId: 279n,
  winningTicket: 15_273_074n, // entry 0 — WALLET_A
  totalLamports: 200_000_000n,
  winnerPayout: 18_000_000n,
  refundPool: 178_000_000n,
  adminCut: 2_000_000n,
  megaCut: 2_000_000n,
  megaTriggered: false,
  megaAwarded: 0n,
  megaFieldPool: 0n,
  megaPotRemaining: 0n,
  randomnessSeedSlot: 1n,
  randomnessValue: new Uint8Array(32),
};

const reduce = (state: RoundDataState, ...actions: RoundDataAction[]): RoundDataState =>
  actions.reduce(roundDataReducer, state);

/** Round 279 locked with two wallets in; the keeper has opened 280. */
const drawing279 = reduce(
  liveInitialState(T0),
  {
    type: "ACCOUNTS_UPDATED",
    round: round(279n, { totalLamports: 200_000_000n, entryCount: 2 }),
    entries: [entry(279n, 0, WALLET_A, 0n), entry(279n, 1, WALLET_B, SOL / 10n)],
  },
  {
    type: "ROUND_LOCKED",
    event: { roundId: 279n, lockTs: 1_791_409_981n, lockSlot: 9n, totalLamports: 200_000_000n, entryCount: 2 },
  },
  { type: "ROUND_OPENED", event: { roundId: 280n, startTs: 1_791_409_983n, endTs: 1_791_410_043n } },
);

function Providers({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [], []);
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }),
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

function tree(state: RoundDataState, child: ReactNode) {
  return (
    <StrictMode>
      <Providers>
        <RoundDataContext.Provider value={{ state, loadFixture: () => {}, fixtureScenarioNames: [] }}>
          {child}
        </RoundDataContext.Provider>
      </Providers>
    </StrictMode>
  );
}

const tick = () => act(() => new Promise<void>((r) => setTimeout(r, 30)));

afterEach(cleanup);

// Reduced motion: the needle lands on the spot (same presentation, no
// 2.2 s rAF wait), which is what lets these gates see the overlay.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

describe("the wheel during the draw", () => {
  it("keeps the drawing round on stage while the next round's window is open", async () => {
    render(tree(drawing279, <OrbitWheel />));
    await tick();
    expect(screen.getByText("DRAWING")).toBeTruthy();
    // The dial names round 279; the clock above names round 280.
    expect(document.body.textContent).toMatch(/ROUND\s*279/);
    expect(document.body.textContent).toMatch(/ROUND 280 · DEPOSIT WINDOW/);
    expect(screen.queryByText(/WINNER/)).toBeNull();
  });

  it("lands round 279's settlement on round 279's book", async () => {
    const view = render(tree(drawing279, <OrbitWheel />));
    await tick();
    view.rerender(tree(reduce(drawing279, { type: "ROUND_SETTLED", event: settled279 }), <OrbitWheel />));
    await tick();
    const banner = screen.getByText(/WINNER/);
    expect(banner.textContent).toMatch(/ROUND\s*279\s*WINNER/);
  });

  it("presents nothing for a settlement it has no book for", async () => {
    const live280 = reduce(
      drawing279,
      {
        type: "ACCOUNTS_UPDATED",
        round: round(280n, { totalLamports: 200_000_000n, entryCount: 2 }),
        entries: [entry(280n, 0, WALLET_C, 0n), entry(280n, 1, WALLET_B, SOL / 10n)],
      },
      { type: "ROUND_SETTLED", event: { ...settled279, roundId: 250n } },
    );
    render(tree(live280, <OrbitWheel />));
    await tick();
    expect(screen.queryByText(/WINNER/)).toBeNull();
  });
});

describe("the players feed", () => {
  it("never crowns a live-round row with the previous round's ticket", async () => {
    const settledWhile280Fills = reduce(
      drawing279,
      {
        type: "ACCOUNTS_UPDATED",
        round: round(280n, { totalLamports: 200_000_000n, entryCount: 2 }),
        entries: [entry(280n, 0, WALLET_C, 0n), entry(280n, 1, WALLET_B, SOL / 10n)],
      },
      { type: "ROUND_SETTLED", event: settled279 },
    );
    render(tree(settledWhile280Fills, <ParticipantsFeed />));
    await tick();
    expect(screen.queryByLabelText("winner")).toBeNull();
  });
});

describe("a draw that never lands", () => {
  it("hands the stage back to the live round after the stuck-draw cap", async () => {
    // Three minutes on, round 279 still undrawn (quarantined by the keeper).
    const stuck: RoundDataState = { ...drawing279, nowMs: T0 + 180_000 };
    render(tree(stuck, <OrbitWheel />));
    await tick();
    expect(screen.queryByText("DRAWING")).toBeNull();
    expect(screen.getByText("OPEN")).toBeTruthy(); // round 280's own dial
  });
});
