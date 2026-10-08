/**
 * The pipelined settle — the keeper opens round N+1 about two seconds
 * after locking N (`open_round` only needs N to have left Open), while
 * N's randomness pipeline takes ~30 s to land `fulfill_settle`. Live
 * trace, 2026-10-07:
 *
 *   21:53:01  lock_round 279
 *   21:53:03  open_round 280      ← the page rolls to 280 here
 *   21:53:31  fulfill_settle 279  ← RoundSettled for a NON-current round
 *
 * The reducer used to honour a settlement only for the current round, so
 * round 279's prize and refunds were never recorded (two wallets in, no
 * reward on the card) and the wheel spun 279's ticket over 280's arcs.
 * These gates pin the fix: the superseded round is kept as `previous`
 * with its frozen book, its settle credits the records, and an older
 * round's account push can never drag `state.round` backwards.
 */

import { describe, expect, it } from "vitest";
import type { PlayerEntryAccountData, RoundData, RoundSettledEvent } from "@orbit-jackpot/sdk";
import {
  liveInitialState,
  roundDataReducer,
  type RoundDataAction,
  type RoundDataState,
} from "../src/context/RoundDataProvider";

const T0 = 1_791_409_980_000;
const SOL = 1_000_000_000n;
const WALLET_A = "A".repeat(44);
const WALLET_B = "B".repeat(44);

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

function entry(
  roundId: bigint,
  entryIndex: number,
  player: string,
  ticketStart: bigint,
  amount = SOL / 10n,
): PlayerEntryAccountData {
  return {
    roundId,
    entryIndex,
    player,
    amountLamports: amount,
    ticketStart,
    ticketEnd: ticketStart + amount,
    depositTs: 0n,
    depositSlot: 0n,
    bump: 0,
  };
}

/** Round 279's real shape: two wallets, 0.1 SOL each, entry 0 wins. */
const BOOK_279 = [entry(279n, 0, WALLET_A, 0n), entry(279n, 1, WALLET_B, SOL / 10n)];

function settled279(over: Partial<RoundSettledEvent> = {}): RoundSettledEvent {
  return {
    roundId: 279n,
    winningTicket: 15_273_074n,
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
    ...over,
  };
}

const reduce = (state: RoundDataState, ...actions: RoundDataAction[]): RoundDataState =>
  actions.reduce(roundDataReducer, state);

/** The page watching round 279 with its book loaded, deposit window open. */
function watching279(): RoundDataState {
  return reduce(liveInitialState(T0), {
    type: "ACCOUNTS_UPDATED",
    round: round(279n, { totalLamports: 200_000_000n, entryCount: 2 }),
    entries: BOOK_279,
  });
}

/** …and then the keeper's real order: lock 279, open 280. */
function rolledTo280(): RoundDataState {
  return reduce(
    watching279(),
    {
      type: "ROUND_LOCKED",
      event: { roundId: 279n, lockTs: 1_791_409_981n, lockSlot: 9n, totalLamports: 200_000_000n, entryCount: 2 },
    },
    { type: "ROUND_OPENED", event: { roundId: 280n, startTs: 1_791_409_983n, endTs: 1_791_410_043n } },
  );
}

describe("previous — the round still drawing behind the next one", () => {
  it("a rollover keeps the superseded round and its book frozen", () => {
    const s = rolledTo280();
    expect(s.round?.roundId).toBe(280n);
    expect(s.entries).toEqual([]);
    expect(s.previous?.round.roundId).toBe(279n);
    expect(s.previous?.round.state).toBe("locked");
    expect(s.previous?.entries).toBe(BOOK_279);
  });

  it("an account-path rollover (poll / config push) keeps it too", () => {
    const s = reduce(watching279(), {
      type: "ACCOUNTS_UPDATED",
      round: round(280n),
    });
    expect(s.round?.roundId).toBe(280n);
    expect(s.previous?.round.roundId).toBe(279n);
    // The chain cannot open N+1 while N is Open — a missed lock event
    // still means N is drawing.
    expect(s.previous?.round.state).toBe("locked");
  });

  it("an empty superseded round is not kept (nothing to draw)", () => {
    const s = reduce(
      liveInitialState(T0),
      { type: "ACCOUNTS_UPDATED", round: round(279n) },
      { type: "ACCOUNTS_UPDATED", round: round(280n) },
    );
    expect(s.previous).toBeNull();
  });
});

describe("ROUND_SETTLED for the previous round — the missing credit", () => {
  it("records the winner's claim and every refund from the frozen book", () => {
    const s = reduce(rolledTo280(), { type: "ROUND_SETTLED", event: settled279() });
    expect(s.round?.roundId).toBe(280n); // the live round never moves
    expect(s.previous?.round.state).toBe("settled");
    expect(s.previous?.round.winningTicket).toBe(15_273_074n);

    const claim = s.claimableRounds.get(279n);
    expect(claim?.winner).toBe(WALLET_A);
    expect(claim?.entryIndex).toBe(0);
    expect(claim?.winnerPayout).toBe(18_000_000n);

    const refund = s.refundRounds.get(279n);
    expect(refund?.refundPool).toBe(178_000_000n);
    expect(refund?.entries.map((e) => e.player)).toEqual([WALLET_A, WALLET_B]);
  });

  it("still drives the wheel: lastSettlement names round 279", () => {
    const s = reduce(rolledTo280(), { type: "ROUND_SETTLED", event: settled279() });
    expect(s.lastSettlement?.event.roundId).toBe(279n);
  });

  it("a settle for a round the page never saw records nothing (no book to read)", () => {
    const s = reduce(rolledTo280(), {
      type: "ROUND_SETTLED",
      event: settled279({ roundId: 250n }),
    });
    expect(s.claimableRounds.has(250n)).toBe(false);
    expect(s.refundRounds.has(250n)).toBe(false);
  });

  it("a cancel of the previous round books the full refund", () => {
    const s = reduce(rolledTo280(), {
      type: "ROUND_CANCELLED",
      event: { roundId: 279n, reason: 1 },
    });
    expect(s.previous?.round.state).toBe("cancelled");
    expect(s.cancelledRounds.get(279n)?.entries).toHaveLength(2);
  });
});

describe("an older round's account push never drags the page backwards", () => {
  it("routes a settled round-279 push into previous + records, round stays 280", () => {
    const s = reduce(rolledTo280(), {
      type: "ACCOUNTS_UPDATED",
      round: round(279n, {
        state: "settled",
        totalLamports: 200_000_000n,
        entryCount: 2,
        winningTicket: 15_273_074n,
        winnerPayout: 18_000_000n,
        refundPool: 178_000_000n,
        settleTs: 1_791_410_011n,
      }),
    });
    expect(s.round?.roundId).toBe(280n);
    expect(s.entriesVersion).toBe(rolledTo280().entriesVersion); // no refetch churn
    expect(s.previous?.round.state).toBe("settled");
    expect(s.claimableRounds.get(279n)?.winner).toBe(WALLET_A);
    expect(s.refundRounds.get(279n)?.entries).toHaveLength(2);
  });
});

describe("PREVIOUS_ROUND_UPDATED — the reload-mid-draw path", () => {
  it("a bootstrap read of the previous round plus its book credits the settle", () => {
    const fresh = reduce(liveInitialState(T0), { type: "ACCOUNTS_UPDATED", round: round(280n) });
    const s = reduce(
      fresh,
      {
        type: "PREVIOUS_ROUND_UPDATED",
        round: round(279n, { state: "awaitingRandomness", totalLamports: 200_000_000n, entryCount: 2 }),
      },
      { type: "PREVIOUS_ROUND_UPDATED", entries: BOOK_279 },
      { type: "ROUND_SETTLED", event: settled279() },
    );
    expect(s.previous?.entries).toHaveLength(2);
    expect(s.claimableRounds.get(279n)?.winner).toBe(WALLET_A);
    expect(s.refundRounds.get(279n)?.entries).toHaveLength(2);
  });

  it("ignores a 'previous' that is actually the live round or newer", () => {
    const fresh = reduce(liveInitialState(T0), { type: "ACCOUNTS_UPDATED", round: round(280n) });
    const s = reduce(fresh, {
      type: "PREVIOUS_ROUND_UPDATED",
      round: round(280n, { totalLamports: 1n }),
    });
    expect(s.previous).toBeNull();
  });

  it("re-deriving a settled record never resurrects an entry the keeper paid", () => {
    const settledState = reduce(rolledTo280(), { type: "ROUND_SETTLED", event: settled279() });
    const paid = reduce(settledState, {
      type: "ENTRY_REFUND_PAID",
      event: {
        roundId: 279n,
        entryIndex: 1,
        player: WALLET_B,
        amountLamports: SOL / 10n,
        refundLamports: 89_000_000n,
        megaFieldLamports: 0n,
      },
    });
    expect(paid.refundRounds.get(279n)?.entries.map((e) => e.entryIndex)).toEqual([0]);
    // The keeper's close bumps entries_closed → the account pushes again.
    const pushed = reduce(paid, {
      type: "PREVIOUS_ROUND_UPDATED",
      round: { ...paid.previous!.round, entriesClosed: 1 },
    });
    expect(pushed.refundRounds.get(279n)?.entries.map((e) => e.entryIndex)).toEqual([0]);
  });
});

describe("payouts — the session log the history ledger reads", () => {
  it("logs prizes, settled refunds and cancel refunds once each", () => {
    const s = reduce(
      rolledTo280(),
      { type: "ROUND_SETTLED", event: settled279() },
      {
        type: "PRIZE_CLAIMED",
        event: {
          roundId: 279n,
          entryIndex: 0,
          winner: WALLET_A,
          winningTicket: 15_273_074n,
          winnerPayout: 18_000_000n,
          megaAwarded: 0n,
        },
      },
      {
        type: "ENTRY_REFUND_PAID",
        event: {
          roundId: 279n,
          entryIndex: 0,
          player: WALLET_A,
          amountLamports: SOL / 10n,
          refundLamports: 89_000_000n,
          megaFieldLamports: 0n,
        },
      },
      {
        type: "ENTRY_REFUNDED",
        event: { roundId: 277n, entryIndex: 0, player: WALLET_A, amountLamports: SOL / 10n },
        nowMs: T0 + 5,
      },
      // A replayed event (websocket reconnect) must not double-log.
      {
        type: "ENTRY_REFUNDED",
        event: { roundId: 277n, entryIndex: 0, player: WALLET_A, amountLamports: SOL / 10n },
        nowMs: T0 + 9,
      },
    );
    expect(s.payouts.map((p) => [p.kind, p.roundId, p.lamports])).toEqual([
      ["prize", 279n, 18_000_000n],
      ["settledRefund", 279n, 89_000_000n],
      ["refund", 277n, SOL / 10n],
    ]);
  });
});

describe("the reveal does not depend on event arrival order", () => {
  const settledAccount = (): RoundData =>
    round(279n, {
      state: "settled",
      totalLamports: 200_000_000n,
      entryCount: 2,
      lockTs: 1_791_409_981n,
      winningTicket: 15_273_074n,
      winnerPayout: 18_000_000n,
      refundPool: 178_000_000n,
      settleTs: 1_791_410_011n,
    });

  it("a watched drawing→settled account push reveals the outcome by itself", () => {
    const s = reduce(rolledTo280(), { type: "PREVIOUS_ROUND_UPDATED", round: settledAccount() });
    expect(s.lastSettlement?.event.roundId).toBe(279n);
    expect(s.lastSettlement?.event.winningTicket).toBe(15_273_074n);
    expect(s.claimableRounds.get(279n)?.winner).toBe(WALLET_A);
  });

  it("the real event arriving afterwards keeps the same round on the wheel", () => {
    const s = reduce(
      rolledTo280(),
      { type: "PREVIOUS_ROUND_UPDATED", round: settledAccount() },
      { type: "ROUND_SETTLED", event: settled279() },
    );
    expect(s.lastSettlement?.event.roundId).toBe(279n);
    expect(s.refundRounds.get(279n)?.entries).toHaveLength(2);
  });

  it("an ALREADY-settled previous round read after a reload reveals nothing", () => {
    const fresh = reduce(liveInitialState(T0), { type: "ACCOUNTS_UPDATED", round: round(280n) });
    const s = reduce(fresh, { type: "PREVIOUS_ROUND_UPDATED", round: settledAccount() });
    expect(s.lastSettlement).toBeNull();
  });
});

describe("mega survives the account-first ordering", () => {
  it("push → MegaPotTriggered → RoundSettled keeps the celebration attached", () => {
    const mega = { roundId: 279n, cycleIndex: 1n, awarded: 5n, fieldPool: 4n, retained: 3n };
    const s = reduce(
      rolledTo280(),
      {
        type: "PREVIOUS_ROUND_UPDATED",
        round: round(279n, {
          state: "settled",
          totalLamports: 200_000_000n,
          entryCount: 2,
          winningTicket: 15_273_074n,
          megaTriggered: true,
        }),
      },
      { type: "MEGA_POT_TRIGGERED", event: mega },
      { type: "ROUND_SETTLED", event: settled279({ megaTriggered: true, megaAwarded: 5n }) },
    );
    expect(s.lastSettlement?.mega).toEqual(mega);
  });
});
