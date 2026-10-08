/**
 * The rewards card must list EVERY round that still owes this wallet
 * money — not only the rounds the page happened to watch settle.
 *
 * Owner report, 2026-10-08: an auto-play escrow played rounds 283–288
 * against another escrow (a new round every ~70 s). All six settled with
 * 0.606 SOL owed to `chumAA…`'s escrow (six refunds + four prizes), and
 * the card showed none of it: after a reload the page only re-reads the
 * previous round, and the per-wallet localStorage book had been written
 * while the OTHER wallet was connected.
 *
 * The fix asks the chain directly — every still-open PlayerEntry whose
 * `player` is the wallet or its escrow — and builds the card's records
 * from that. These gates pin the pure half: chain rows → records.
 */

import { describe, expect, it } from "vitest";
import type { PlayerEntryAccountData, RoundData } from "@orbit-jackpot/sdk";
import { recordsFromOpenEntries } from "../src/lib/openPositions";
import { liveInitialState, roundDataReducer } from "../src/context/RoundDataProvider";

const SOL = 1_000_000_000n;
const ESCROW = "BnLRyp" + "1".repeat(38);
const OTHER_ESCROW = "Other" + "1".repeat(39);

function round(roundId: bigint, over: Partial<RoundData> = {}): RoundData {
  return {
    roundId,
    state: "settled",
    startTs: 1_791_413_000n,
    endTs: 1_791_413_060n,
    lockTs: 1_791_413_061n,
    lockSlot: 1n,
    settleTs: 1_791_413_100n + roundId,
    totalLamports: 200_000_000n,
    entryCount: 2,
    entriesClosed: 0,
    rentPayer: "11111111111111111111111111111111",
    firstDepositor: "11111111111111111111111111111111",
    singleDepositor: false,
    randomnessAccount: "11111111111111111111111111111111",
    randomnessCommitSlot: 0n,
    randomnessSeedSlot: 0n,
    winningTicket: 15_000_000n, // inside entry 0
    winner: "11111111111111111111111111111111",
    winnerPayout: 18_000_000n,
    adminCut: 2_000_000n,
    megaCut: 2_000_000n,
    megaAwarded: 0n,
    refundPool: 178_000_000n,
    refundsPaid: 0n,
    megaFieldPool: 0n,
    megaFieldPaid: 0n,
    vaultOwed: 196_000_000n,
    megaTriggered: false,
    prizeClaimed: false,
    vaultBump: 0,
    bump: 0,
    ...over,
  };
}

function entry(roundId: bigint, entryIndex: number, player: string): PlayerEntryAccountData {
  const amount = SOL / 10n;
  const ticketStart = BigInt(entryIndex) * amount;
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

describe("recordsFromOpenEntries — chain rows to card records", () => {
  it("rebuilds the 283–288 shape: a refund per round, a claim per round won", () => {
    // chum's escrow is entry 0 (the winner) in 283/284/287/288, entry 1
    // (the loser) in 285/286.
    const ids = [283n, 284n, 285n, 286n, 287n, 288n];
    const wins = new Set([283n, 284n, 287n, 288n]);
    const rounds = new Map(ids.map((id) => [id, round(id)]));
    const mine = ids.map((id) => entry(id, wins.has(id) ? 0 : 1, ESCROW));

    const { refunds, claims, cancelled } = recordsFromOpenEntries(rounds, mine);
    expect(refunds.map((r) => r.roundId)).toEqual(ids);
    expect(refunds.every((r) => r.entries.length === 1 && r.entries[0]!.player === ESCROW)).toBe(true);
    expect(claims.map((c) => c.roundId)).toEqual([283n, 284n, 287n, 288n]);
    expect(claims[0]).toMatchObject({ winner: ESCROW, entryIndex: 0, winnerPayout: 18_000_000n });
    expect(cancelled).toEqual([]);
  });

  it("an already-claimed prize yields the refund but no claim", () => {
    const rounds = new Map([[283n, round(283n, { prizeClaimed: true })]]);
    const { refunds, claims } = recordsFromOpenEntries(rounds, [entry(283n, 0, ESCROW)]);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.prizeClaimed).toBe(true);
    expect(claims).toEqual([]);
  });

  it("a cancelled round owes its full stake back", () => {
    const rounds = new Map([[289n, round(289n, { state: "cancelled" })]]);
    const { cancelled, refunds } = recordsFromOpenEntries(rounds, [entry(289n, 0, ESCROW)]);
    expect(refunds).toEqual([]);
    expect(cancelled).toEqual([
      { roundId: 289n, endTs: 1_791_413_060n, entries: [entry(289n, 0, ESCROW)], refunded: [], receiptAt: null },
    ]);
  });

  it("skips rounds still in play, and entries whose round account is gone", () => {
    const rounds = new Map([
      [296n, round(296n, { state: "open" })],
      [297n, round(297n, { state: "awaitingRandomness" })],
    ]);
    const { refunds, claims, cancelled } = recordsFromOpenEntries(rounds, [
      entry(296n, 0, ESCROW),
      entry(297n, 0, ESCROW),
      entry(250n, 0, ESCROW), // round closed — nothing to read
    ]);
    expect([...refunds, ...claims, ...cancelled]).toEqual([]);
  });

  it("never claims for a round whose winner is someone else", () => {
    const rounds = new Map([[285n, round(285n)]]);
    // Winning ticket sits in entry 0 = the other escrow; mine is entry 1.
    const { claims } = recordsFromOpenEntries(rounds, [entry(285n, 1, ESCROW)]);
    expect(claims).toEqual([]);
    void OTHER_ESCROW;
  });
});

describe("the card's book holds a full auto-play run", () => {
  it("keeps every hydrated settled round — the old cap of 8 dropped the oldest", () => {
    const ids = Array.from({ length: 30 }, (_, i) => BigInt(300 + i));
    const { refunds } = recordsFromOpenEntries(
      new Map(ids.map((id) => [id, round(id)])),
      ids.map((id) => entry(id, 1, ESCROW)),
    );
    const s = roundDataReducer(liveInitialState(0), { type: "HYDRATE_REFUNDS", records: refunds });
    expect(s.refundRounds.size).toBe(30);
  });
});
