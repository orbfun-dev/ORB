/**
 * Reducer gates (roadmap 7.2): every transition of the round state
 * machine, with "now" injected through actions — no wall clock, no
 * network, no React. Money/ticket fields must remain `bigint` after
 * every action.
 */

import { describe, expect, it } from "vitest";
import type {
  AutoDepositedEvent,
  DepositedEvent,
  GlobalConfigData,
  MegaPotVaultData,
  PlayerEntryAccountData,
  RoundData,
  RoundSettledEvent,
} from "@orbit-jackpot/sdk";
import {
  ANTI_SNIPE_CUE_TTL_MS,
  roundDataReducer,
  type RoundDataAction,
  type RoundDataState,
} from "../src/context/RoundDataProvider";

const T0 = 1_700_000_000_000;

const config = (activeRoundId = 7n): GlobalConfigData => ({
  admin: "A".repeat(44),
  pendingAdmin: null,
  treasuryAuthority: "B".repeat(44),
  oracleProgramId: "C".repeat(44),
  oracleQueue: "D".repeat(44),
  feeBpsAdmin: 100,
  feeBpsMega: 100,
  winnerBps: 900,
  refundBps: 8_900,
  megaAwardBps: 5_000,
  megaFieldBps: 4_000,
  megaTriggerModulus: 625,
  megaPayoutCapBps: 80_000,
  accountOpenFeeLamports: 10_000_000n,
  economicsVersion: 2,
  maxEntriesPerRound: 500,
  roundDurationSecs: 300n,
  maxRoundDurationSecs: 600n,
  antiSnipeWindowSecs: 30n,
  antiSnipeExtensionSecs: 15n,
  claimDeadlineSecs: 2_592_000n,
  minDepositLamports: 10_000_000n,
  antiSnipeMinDepositLamports: 100_000_000n,
  keeperTipLamports: 1_000_000n,
  randomnessRevealDeadlineSlots: 400n,
  activeRoundId,
  nextRoundId: activeRoundId + 1n,
  oracleProvider: "switchboard",
  paused: false,
  bump: 254,
  autoDepositWindowSecs: 0n,
  autoDepositTipLamports: 0n,
  autoDepositEnabled: false,
});

const openRound = (overrides: Partial<RoundData> = {}): RoundData => ({
  roundId: 7n,
  state: "open",
  startTs: 1_700_000_000n,
  endTs: 1_700_000_200n,
  lockTs: 0n,
  lockSlot: 0n,
  settleTs: 0n,
  totalLamports: 1_000_000_000n,
  entryCount: 1,
  entriesClosed: 0,
  firstDepositor: "D".repeat(44),
  rentPayer: "11111111111111111111111111111111",
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
  vaultOwed: 1_000_000_000n,
  megaTriggered: false,
  prizeClaimed: false,
  vaultBump: 253,
  bump: 255,
  ...overrides,
});

const entry = (index: number, start: bigint, end: bigint, amount = end - start): PlayerEntryAccountData => ({
  roundId: 7n,
  entryIndex: index,
  player: `${index}`.repeat(44),
  amountLamports: amount,
  ticketStart: start,
  ticketEnd: end,
  depositTs: 0n,
  depositSlot: 0n,
  bump: 0,
});

const deposited = (over: Partial<DepositedEvent> = {}): DepositedEvent => ({
  roundId: 7n,
  entryIndex: 1,
  player: "E".repeat(44),
  amountLamports: 500_000_000n,
  ticketStart: 1_000_000_000n,
  ticketEnd: 1_500_000_000n,
  roundTotalLamports: 1_500_000_000n,
  newEndTs: 1_700_000_200n,
  extended: false,
  ...over,
});

const autoDeposited = (over: Partial<AutoDepositedEvent> = {}): AutoDepositedEvent => ({
  roundId: 7n,
  entryIndex: 1,
  owner: "E".repeat(44),
  escrow: "F".repeat(44),
  amountLamports: 500_000_000n,
  tipLamports: 200_000n,
  entryRentLamports: 1_203_960n,
  ticketStart: 1_000_000_000n,
  ticketEnd: 1_500_000_000n,
  roundTotalLamports: 1_500_000_000n,
  roundsRemaining: 4,
  ...over,
});

const settled = (over: Partial<RoundSettledEvent> = {}): RoundSettledEvent => ({
  roundId: 7n,
  winningTicket: 1_200_000_000n,
  totalLamports: 1_500_000_000n,
  // v2 four-way split of 1.5 SOL: 9% winner, 89% refunds, 1% + 1% cuts.
  winnerPayout: 135_000_000n,
  refundPool: 1_335_000_000n,
  adminCut: 15_000_000n,
  megaCut: 15_000_000n,
  megaTriggered: false,
  megaAwarded: 0n,
  megaFieldPool: 0n,
  megaPotRemaining: 42_678_000_000n,
  randomnessSeedSlot: 2_700_000_007n,
  randomnessValue: new Uint8Array(32),
  ...over,
});

const megaPot = (accrued = 42_678_000_000n): MegaPotVaultData => ({
  accruedLamports: accrued,
  lifetimeContributed: accrued,
  lifetimeAwarded: 0n,
  triggerCount: 0n,
  lastTriggerRoundId: 0n,
  cycleIndex: 0n,
  bump: 251,
});

function liveState(over: Partial<RoundDataState> = {}): RoundDataState {
  return {
    mode: "live",
    fixtureName: null,
    nowMs: T0,
    clockOffsetMs: 0,
    feedStatus: "connecting",
    error: null,
    config: config(),
    round: openRound(),
    megaPot: megaPot(),
    entries: [entry(0, 0n, 1_000_000_000n)],
    entriesVersion: 3,
    antiSnipe: null,
    lastSettlement: null,
    pendingMega: new Map(),
    claimableRounds: new Map(),
    refundRounds: new Map(),
    cancelledRounds: new Map(),
    previous: null,
    payouts: [],
    ...over,
  };
}

const reduce = (state: RoundDataState, ...actions: RoundDataAction[]): RoundDataState =>
  actions.reduce(roundDataReducer, state);

describe("ACCOUNTS_UPDATED", () => {
  it("merges decoded accounts and flags anti-snipe only when end_ts rises while Open", () => {
    const extendedRound = openRound({ endTs: 1_700_000_215n });
    const next = reduce(liveState(), { type: "ACCOUNTS_UPDATED", round: extendedRound });
    expect(next.antiSnipe).to.deep.equal({
      deltaSecs: 15n,
      at: T0,
      source: "account",
    });
  });

  it("no cue when the round is no longer open", () => {
    const locked = openRound({ state: "locked", endTs: 1_700_000_215n });
    const next = reduce(liveState(), { type: "ACCOUNTS_UPDATED", round: locked });
    expect(next.antiSnipe).toBeNull();
  });

  it("round rollover clears the entry book and bumps the fetch version", () => {
    const next = reduce(
      liveState(),
      { type: "ACCOUNTS_UPDATED", round: openRound({ roundId: 8n, entryCount: 0 }) },
    );
    expect(next.entries).to.deep.equal([]);
    expect(next.entriesVersion).toBe(4);
  });

  it("rejects entries fetched for a different round", () => {
    const stale = [entry(0, 0n, 1n), entry(1, 1n, 2n)].map((e) => ({ ...e, roundId: 8n }));
    const next = reduce(liveState(), { type: "ACCOUNTS_UPDATED", entries: stale });
    expect(next.entries).toHaveLength(1); // unchanged
    expect(next.entriesVersion).toBe(3);
  });

  it("replacing entries does not bump the version (no refetch loop)", () => {
    const fresh = [entry(0, 0n, 1_000_000_000n), entry(1, 1_000_000_000n, 1_500_000_000n)];
    const next = reduce(liveState(), { type: "ACCOUNTS_UPDATED", entries: fresh });
    expect(next.entries).toHaveLength(2);
    expect(next.entriesVersion).toBe(3);
  });
});

describe("DEPOSITED", () => {
  it("optimistically appends the entry and patches the pot (bigint end to end)", () => {
    const next = reduce(liveState(), { type: "DEPOSITED", event: deposited() });
    expect(next.entries).toHaveLength(2);
    const appended = next.entries[1]!;
    expect(appended.player).toBe("E".repeat(44));
    expect(appended.amountLamports).toBe(500_000_000n);
    expect(typeof appended.amountLamports).toBe("bigint");
    expect(next.round?.totalLamports).toBe(1_500_000_000n);
    expect(next.round?.entryCount).toBe(2);
    expect(next.entriesVersion).toBe(4);
  });

  it("arms the anti-snipe cue only when the event says extended", () => {
    const extended = reduce(
      liveState(),
      { type: "DEPOSITED", event: deposited({ extended: true, newEndTs: 1_700_000_215n }) },
    );
    expect(extended.antiSnipe?.deltaSecs).toBe(15n);
    expect(extended.antiSnipe?.source).toBe("event");
    expect(extended.round?.endTs).toBe(1_700_000_215n);

    const plain = reduce(liveState(), { type: "DEPOSITED", event: deposited() });
    expect(plain.antiSnipe).toBeNull();
  });

  it("ignores deposits for a different round", () => {
    const next = reduce(liveState(), {
      type: "DEPOSITED",
      event: deposited({ roundId: 99n }),
    });
    expect(next.entries).toHaveLength(1);
    expect(next.entriesVersion).toBe(3);
  });
});

describe("AUTO_DEPOSITED", () => {
  it("optimistically appends with player = the escrow PDA and patches the pot", () => {
    const next = reduce(liveState(), { type: "AUTO_DEPOSITED", event: autoDeposited() });
    expect(next.entries).toHaveLength(2);
    const appended = next.entries[1]!;
    expect(appended.player).toBe("F".repeat(44)); // the ESCROW, not the owner
    expect(appended.amountLamports).toBe(500_000_000n);
    expect(next.round?.totalLamports).toBe(1_500_000_000n);
    expect(next.round?.entryCount).toBe(2);
    expect(next.entriesVersion).toBe(4);
  });

  it("NEVER moves end_ts and arms no anti-snipe cue (the R3 mirror)", () => {
    const before = liveState();
    const next = reduce(before, { type: "AUTO_DEPOSITED", event: autoDeposited() });
    expect(next.round?.endTs).toBe(before.round?.endTs);
    expect(next.antiSnipe).toBeNull();
  });

  it("ignores auto-deposits for a different round", () => {
    const next = reduce(liveState(), {
      type: "AUTO_DEPOSITED",
      event: autoDeposited({ roundId: 99n }),
    });
    expect(next.entries).toHaveLength(1);
    expect(next.entriesVersion).toBe(3);
  });
});

describe("settlement lifecycle", () => {
  it("ROUND_SETTLED stores the spin target and patches the round", () => {
    const next = reduce(
      liveState(),
      { type: "ROUND_SETTLED", event: settled() },
    );
    expect(next.lastSettlement?.event.winningTicket).toBe(1_200_000_000n);
    expect(next.lastSettlement?.mega).toBeNull();
    expect(next.round?.state).toBe("settled");
    expect(next.round?.winningTicket).toBe(1_200_000_000n);
  });

  it("MEGA_POT_TRIGGERED attaches to the same round's settlement and re-syncs the pot", () => {
    const next = reduce(
      liveState(),
      { type: "ROUND_SETTLED", event: settled({ megaTriggered: true, megaAwarded: 9_000_000_000n }) },
      { type: "MEGA_POT_TRIGGERED", event: { roundId: 7n, cycleIndex: 3n, awarded: 5_000_000_000n, fieldPool: 4_000_000_000n, retained: 33_678_000_000n } },
    );
    expect(next.lastSettlement?.mega?.retained).toBe(33_678_000_000n);
    expect(next.megaPot?.accruedLamports).toBe(33_678_000_000n);
  });

  it("mega arriving BEFORE RoundSettled (the emit order) buffers and attaches", () => {
    // fulfill_settle emits MegaPotTriggered first — lastSettlement does
    // not exist when it lands. The buffer must hold it by round id and
    // ROUND_SETTLED must attach it instead of overwriting mega: null.
    const next = reduce(
      liveState(),
      { type: "MEGA_POT_TRIGGERED", event: { roundId: 7n, cycleIndex: 3n, awarded: 5_000_000_000n, fieldPool: 4_000_000_000n, retained: 33_678_000_000n } },
      { type: "ROUND_SETTLED", event: settled({ megaTriggered: true, megaAwarded: 9_000_000_000n }) },
    );
    expect(next.lastSettlement?.mega?.awarded).toBe(5_000_000_000n);
    expect(next.lastSettlement?.mega?.retained).toBe(33_678_000_000n);
    expect(next.pendingMega.size).toBe(0); // consumed, not lingering
  });

  it("a mega for a different round stays buffered until THAT round settles", () => {
    const buffered = reduce(
      liveState(),
      { type: "MEGA_POT_TRIGGERED", event: { roundId: 42n, cycleIndex: 1n, awarded: 1n, fieldPool: 0n, retained: 2n } },
    );
    expect(buffered.pendingMega.get(42n)?.awarded).toBe(1n);
    const after = reduce(buffered, { type: "ROUND_SETTLED", event: settled() }); // round 7
    expect(after.lastSettlement?.mega).toBeNull(); // not round 42's mega
    expect(after.pendingMega.get(42n)).toBeDefined(); // still waiting
  });

  it("PRIZE_CLAIMED flips prize_claimed for the claim banner dismissal", () => {
    const next = reduce(
      liveState(),
      { type: "ROUND_SETTLED", event: settled() },
      { type: "PRIZE_CLAIMED", event: { roundId: 7n, entryIndex: 1, winner: "F".repeat(44), winningTicket: 1_200_000_000n, winnerPayout: 1_470_000_000n, megaAwarded: 0n } },
    );
    expect(next.round?.prizeClaimed).toBe(true);
    expect(next.round?.winner).toBe("F".repeat(44));
  });

  it("ROUND_OPENED resets the wheel: fresh round, no entries, no settlement", () => {
    const next = reduce(
      liveState({ entries: [entry(0, 0n, 1n)] }),
      { type: "ROUND_SETTLED", event: settled() },
      {
        type: "ROUND_OPENED",
        event: { roundId: 8n, startTs: 1_700_000_300n, endTs: 1_700_000_600n },
      },
    );
    expect(next.round?.roundId).toBe(8n);
    expect(next.round?.state).toBe("open");
    expect(next.round?.totalLamports).toBe(0n);
    expect(next.entries).to.deep.equal([]);
    expect(next.lastSettlement).toBeNull();
  });
});

describe("claimable rounds map (audit fix: the claim CTA survives rollover)", () => {
  // Two entries; settled()'s ticket 1.2 SOL lands in entry #1 ([1.0, 1.5)).
  const winnerBook = [entry(0, 0n, 1_000_000_000n), entry(1, 1_000_000_000n, 1_500_000_000n)];
  const WINNER = "1".repeat(44);

  it("ROUND_SETTLED records the claim with the integer-derived winner and entry index", () => {
    const next = reduce(
      liveState({ entries: winnerBook }),
      { type: "ROUND_SETTLED", event: settled() },
    );
    const record = next.claimableRounds.get(7n)!;
    expect(record.winner).toBe(WINNER);
    expect(record.entryIndex).toBe(1);
    expect(record.winnerPayout).toBe(135_000_000n);
    expect(record.settleTs).toBe(BigInt(T0 / 1000));
    expect(record.prizeClaimed).toBe(false);
  });

  it("the record survives ROUND_OPENED — round N+1 does not erase round N's claim", () => {
    const next = reduce(
      liveState({ entries: winnerBook }),
      { type: "ROUND_SETTLED", event: settled() },
      { type: "ROUND_OPENED", event: { roundId: 8n, startTs: 1_700_000_300n, endTs: 1_700_000_600n } },
    );
    expect(next.lastSettlement).toBeNull(); // fresh wheel for the new round
    expect(next.claimableRounds.get(7n)?.winner).toBe(WINNER); // claim kept
  });

  it("PRIZE_CLAIMED after the rollover marks the OLD round's record claimed", () => {
    const next = reduce(
      liveState({ entries: winnerBook }),
      { type: "ROUND_SETTLED", event: settled() },
      { type: "ROUND_OPENED", event: { roundId: 8n, startTs: 1_700_000_300n, endTs: 1_700_000_600n } },
      {
        type: "PRIZE_CLAIMED",
        event: { roundId: 7n, entryIndex: 1, winner: WINNER, winningTicket: 1_200_000_000n, winnerPayout: 135_000_000n, megaAwarded: 0n },
      },
    );
    expect(next.claimableRounds.get(7n)?.prizeClaimed).toBe(true);
    expect(next.round?.prizeClaimed).toBe(false); // round 8 untouched
  });

  it("ACCOUNTS_UPDATED derives the record for a settled round (reconnect) and clears it when claimed", () => {
    const settledRound = openRound({
      state: "settled",
      totalLamports: 1_500_000_000n,
      winningTicket: 1_200_000_000n,
      winnerPayout: 135_000_000n,
      settleTs: 1_700_000_250n,
    });
    const next = reduce(
      liveState({ entries: winnerBook }),
      { type: "ACCOUNTS_UPDATED", round: settledRound },
    );
    expect(next.claimableRounds.get(7n)?.entryIndex).toBe(1);
    expect(next.claimableRounds.get(7n)?.settleTs).toBe(1_700_000_250n);

    const claimed = reduce(next, {
      type: "ACCOUNTS_UPDATED",
      round: { ...settledRound, prizeClaimed: true },
    });
    expect(claimed.claimableRounds.get(7n)?.prizeClaimed).toBe(true);
  });

  it("HYDRATE_CLAIMS merges storage-validated records into the session map", () => {
    const stored = {
      roundId: 5n,
      winner: "Z".repeat(44),
      entryIndex: 0,
      winningTicket: 0n,
      totalLamports: 1_000_000_000n,
      winnerPayout: 90_000_000n,
      megaAwarded: 0n,
      megaTriggered: false,
      settleTs: 1_699_000_000n,
      prizeClaimed: false,
    };
    const next = reduce(liveState(), { type: "HYDRATE_CLAIMS", records: [stored] });
    expect(next.claimableRounds.get(5n)?.winner).toBe("Z".repeat(44));
  });

  it("LOAD_FIXTURE seeds the claim record for settled scenarios", () => {
    const next = reduce(liveState(), { type: "LOAD_FIXTURE", name: "megaSettled", nowMs: T0 });
    const record = next.claimableRounds.get(11n);
    expect(record).toBeDefined();
    expect(record!.winner).not.toBe("11111111111111111111111111111111");
    expect(record!.megaTriggered).toBe(true);
  });
});

describe("clock", () => {
  it("CLOCK_TICK advances now and expires the anti-snipe cue after its TTL", () => {
    const armed = reduce(
      liveState(),
      { type: "DEPOSITED", event: deposited({ extended: true, newEndTs: 1_700_000_215n }) },
    );
    const stillOn = reduce(armed, { type: "CLOCK_TICK", nowMs: T0 + ANTI_SNIPE_CUE_TTL_MS - 1 });
    expect(stillOn.antiSnipe).not.toBeNull();
    const faded = reduce(armed, { type: "CLOCK_TICK", nowMs: T0 + ANTI_SNIPE_CUE_TTL_MS + 1 });
    expect(faded.antiSnipe).toBeNull();
  });

  it("CLOCK_SYNC stores the offset; FEED_STATUS no-ops when unchanged", () => {
    const synced = reduce(liveState(), { type: "CLOCK_SYNC", offsetMs: -1_234 });
    expect(synced.clockOffsetMs).toBe(-1_234);
    const same = reduce(synced, { type: "FEED_STATUS", status: "connecting" });
    expect(same).toBe(synced); // referentially identical — no re-render
  });
});

describe("fixture mode", () => {
  it("LOAD_FIXTURE swaps in a populated, deterministic state tree", () => {
    const next = reduce(liveState({ config: null, round: null, entries: [] }), {
      type: "LOAD_FIXTURE",
      name: "standard",
      nowMs: T0,
    });
    expect(next.mode).toBe("fixture");
    expect(next.fixtureName).toBe("standard");
    expect(next.config?.activeRoundId).toBe(7n);
    expect(next.round?.state).toBe("open");
    expect(next.entries).toHaveLength(4);
    // Deterministic: same now, same book.
    const again = reduce(liveState(), { type: "LOAD_FIXTURE", name: "standard", nowMs: T0 });
    expect(again.entries.map((e) => e.ticketEnd)).to.deep.equal(
      next.entries.map((e) => e.ticketEnd),
    );
  });

  it("megaSettled loads with the settlement attached", () => {
    const next = reduce(liveState(), {
      type: "LOAD_FIXTURE",
      name: "megaSettled",
      nowMs: T0,
    });
    expect(next.round?.state).toBe("settled");
    expect(next.round?.megaTriggered).toBe(true);
    expect(next.lastSettlement?.event.megaTriggered).toBe(true);
    expect(next.lastSettlement?.mega).not.toBeNull();
  });
});
