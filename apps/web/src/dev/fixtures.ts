/**
 * Offline fixture mode (roadmap 7.2): synthesizes valid decoded state
 * snapshots for the whole UI without a validator.
 *
 - Entry books are built by integer partition of the round total — the
 * exact invariant the chain guarantees (I9) and `calculateWheelSlices`
 * asserts — so wheel rendering in fixture mode exercises the SAME math
 * path as live data. Settled scenarios reuse real vectors from the
 * committed entropy KAT fixture (ADR-9: Rust generates, TS only reads).
 *
 * Scenarios are pure functions of `nowSec` (deterministic in tests) and
 * are enabled only in development builds (`?fixture=<name>`).
 */

import katJson from "../../../../programs/orbit_jackpot/tests/fixtures/entropy_kat.json";
import { PublicKey } from "@solana/web3.js";
import { escrowKey } from "@orbit-jackpot/sdk";
import type {
  GlobalConfigData,
  MegaPotTriggeredEvent,
  MegaPotVaultData,
  PlayerEntryAccountData,
  RoundData,
  RoundSettledEvent,
} from "@orbit-jackpot/sdk";

/** One vector of `entropy_kat.json` (all wide ints as decimal strings). */
export interface KatVector {
  raw_seed_hex: string;
  ticket_seed_u128: string;
  mega_seed_u128: string;
  sample_total_lamports: string;
  winning_ticket: string;
  expected_theta_degrees: string;
  mega_triggered: boolean;
  expected_admin_cut: string;
  expected_mega_cut: string;
  expected_winner_payout: string;
}

export const KAT_VECTORS = katJson as readonly KatVector[];

/** First vector satisfying `pred` (deterministic order), else undefined. */
export function pickKatVector(pred: (v: KatVector) => boolean): KatVector | undefined {
  return KAT_VECTORS.find(pred);
}

/**
 * The Mega-triggering vector used by the megaSettled scenario. The KAT
 * set deliberately includes degenerate totals (1 lamport … u64::MAX) for
 * math coverage; the fixture needs a pot that can actually be partitioned
 * across players, so the first trigger vector with ≥ 1 SOL is pinned.
 */
export const MEGA_KAT_VECTOR =
  pickKatVector((v) => v.mega_triggered && BigInt(v.sample_total_lamports) >= 1_000_000_000n) ??
  pickKatVector((v) => v.mega_triggered) ??
  KAT_VECTORS[0]!;

/** A vector whose total exceeds 2^53 — the highStakes scenario. */
export const HIGH_STAKES_KAT_VECTOR =
  pickKatVector((v) => BigInt(v.sample_total_lamports) > 2n ** 53n) ?? KAT_VECTORS[0]!;

const key = (byte: number): string => new PublicKey(Buffer.alloc(32, byte)).toString();

const DEFAULT_PUBKEY = PublicKey.default.toString();

function fixtureConfig(activeRoundId: bigint): GlobalConfigData {
  return {
    admin: key(0x11),
    pendingAdmin: null,
    treasuryAuthority: key(0x33),
    oracleProgramId: key(0x44),
    oracleQueue: key(0x45),
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
    minDepositLamports: 10_000_000n, // 0.01 SOL
    antiSnipeMinDepositLamports: 100_000_000n, // 0.1 SOL
    keeperTipLamports: 1_000_000n,
    randomnessRevealDeadlineSlots: 400n,
    activeRoundId,
    nextRoundId: activeRoundId + 1n,
    oracleProvider: "switchboard",
    paused: false,
    bump: 254,
    // Phase 10 fields — off in the fixtures (the pre-upgrade deployed
    // state); the Phase 10.6 escrow scenario will enable them.
    autoDepositWindowSecs: 0n,
    autoDepositTipLamports: 0n,
    autoDepositEnabled: false,
  };
}

/**
 * The v2 four-way split of a settled fixture pot — mirrors
 * `math/economics.ts` exactly (refund = residual, I18 by construction).
 */
function splitFixturePot(total: bigint): {
  winnerPayout: bigint;
  refundPool: bigint;
  adminCut: bigint;
  megaCut: bigint;
} {
  const winnerPayout = (total * 900n) / 10_000n;
  const adminCut = (total * 100n) / 10_000n;
  const megaCut = (total * 100n) / 10_000n;
  return { winnerPayout, refundPool: total - winnerPayout - adminCut - megaCut, adminCut, megaCut };
}

interface BaseRoundInput {
  roundId: bigint;
  state: RoundData["state"];
  startTs: bigint;
  endTs: bigint;
  total: bigint;
  entryCount: number;
  settle?: {
    winningTicket: bigint;
    winnerPayout: bigint;
    adminCut: bigint;
    megaCut: bigint;
    megaTriggered: boolean;
    megaAwarded: bigint;
    /** The trigger's every-entry share (0 when not triggered). */
    megaFieldPool?: bigint;
    settleTs: bigint;
  };
}

function baseRound(input: BaseRoundInput): RoundData {
  return {
    roundId: input.roundId,
    state: input.state,
    startTs: input.startTs,
    endTs: input.endTs,
    lockTs: input.state === "open" ? 0n : input.endTs,
    lockSlot: input.state === "open" ? 0n : 2_700_000_004n,
    settleTs: input.settle?.settleTs ?? 0n,
    totalLamports: input.total,
    entryCount: input.entryCount,
    entriesClosed: input.state === "settled" || input.state === "cancelled" ? 0 : 0,
    firstDepositor: key(0x55),
    // Phase 12 rent-payer reciprocity (display-only for fixtures).
    rentPayer: key(0x55),
    singleDepositor: input.entryCount === 1,
    randomnessAccount:
      input.state === "awaitingRandomness" || input.state === "settled"
        ? key(0x66)
        : DEFAULT_PUBKEY,
    randomnessCommitSlot: input.state === "open" ? 0n : 2_700_000_006n,
    randomnessSeedSlot: input.state === "settled" ? 2_700_000_007n : 0n,
    winningTicket: input.settle?.winningTicket ?? 0n,
    winner: input.settle ? key(0x77) : DEFAULT_PUBKEY,
    winnerPayout: input.settle?.winnerPayout ?? 0n,
    adminCut: input.settle?.adminCut ?? 0n,
    megaCut: input.settle?.megaCut ?? 0n,
    megaAwarded: input.settle?.megaAwarded ?? 0n,
    // Phase 11 pool accounting: the four-way split's refund slice + the
    // trigger's field share; vault_owed = all four obligations (I18/I19).
    refundPool: input.settle === undefined ? 0n : input.total - input.settle.winnerPayout - input.settle.adminCut - input.settle.megaCut,
    refundsPaid: 0n,
    megaFieldPool: input.settle?.megaFieldPool ?? 0n,
    megaFieldPaid: 0n,
    vaultOwed:
      input.settle === undefined
        ? input.total
        : input.settle.winnerPayout +
          (input.total - input.settle.winnerPayout - input.settle.adminCut - input.settle.megaCut) +
          input.settle.megaAwarded +
          (input.settle?.megaFieldPool ?? 0n),
    megaTriggered: input.settle?.megaTriggered ?? false,
    prizeClaimed: false,
    vaultBump: 253,
    bump: 255,
  };
}

/**
 * Integer partition of `total` by `weights` (residual to the last slice),
 * telescoping half-open ranges — the I9 book shape, exact by construction.
 * Every range is non-empty (an empty range would break the partition the
 * wheel math asserts).
 */
function partitionEntries(
  roundId: bigint,
  total: bigint,
  weights: readonly number[],
  playerKeys: readonly number[],
  depositTs: bigint,
): PlayerEntryAccountData[] {
  const n = weights.length;
  if (total < BigInt(n)) {
    throw new RangeError(`cannot partition ${total} lamports across ${n} entries`);
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  const amounts = weights.map((w) => (total * BigInt(w)) / BigInt(sum));
  let remainder = total - amounts.reduce((a, b) => a + b, 0n);
  for (let i = 0; i < n && remainder > 0n; i += 1) {
    if (amounts[i] === 0n) {
      amounts[i]! += 1n;
      remainder -= 1n;
    }
  }
  amounts[n - 1]! += remainder;
  if (amounts.some((a) => a <= 0n) || amounts.reduce((a, b) => a + b, 0n) !== total) {
    throw new RangeError(
      `weights [${weights.join(",")}] cannot partition ${total} lamports into ${n} non-empty ranges`,
    );
  }
  let cursor = 0n;
  return amounts.map((amount, i) => {
    const entry: PlayerEntryAccountData = {
      roundId,
      entryIndex: i,
      player: key(playerKeys[i % playerKeys.length]!),
      amountLamports: amount,
      ticketStart: cursor,
      ticketEnd: cursor + amount,
      depositTs,
      depositSlot: 2_700_000_011n,
      bump: 252,
    };
    cursor += amount;
    return entry;
  });
}

function megaPot(accrued: bigint): MegaPotVaultData {
  return {
    accruedLamports: accrued,
    lifetimeContributed: accrued * 7n,
    lifetimeAwarded: accrued / 3n,
    triggerCount: 3n,
    lastTriggerRoundId: 5n,
    cycleIndex: 2n,
    bump: 251,
  };
}

function settleEventFromKat(
  roundId: bigint,
  v: KatVector,
  megaPotBefore: bigint,
): RoundSettledEvent {
  const total = BigInt(v.sample_total_lamports);
  const split = splitFixturePot(total);
  // Phase 11 trigger split: the payable (capped at 8× the round pot) pays
  // 5/9 to the winner, 4/9 to the field pro-rata, the rest is retained.
  const payable = v.mega_triggered
    ? ((megaPotBefore * 9_000n) / 10_000n) /* nominal */
    : 0n;
  const cap = (total * 80_000n) / 10_000n;
  const effPayable = payable < cap ? payable : cap;
  const megaAwarded = v.mega_triggered ? (effPayable * 5_000n) / 9_000n : 0n;
  const megaFieldPool = v.mega_triggered ? effPayable - megaAwarded : 0n;
  return {
    roundId,
    winningTicket: BigInt(v.winning_ticket),
    totalLamports: total,
    winnerPayout: BigInt(v.expected_winner_payout),
    refundPool: split.refundPool,
    adminCut: BigInt(v.expected_admin_cut),
    megaCut: BigInt(v.expected_mega_cut),
    megaTriggered: v.mega_triggered,
    megaAwarded,
    megaFieldPool,
    megaPotRemaining: megaPotBefore - effPayable,
    randomnessSeedSlot: 2_700_000_007n,
    randomnessValue: Buffer.from(v.raw_seed_hex.padStart(64, "0").slice(0, 64), "hex"),
  };
}

export interface FixtureSnapshot {
  name: string;
  description: string;
  config: GlobalConfigData;
  round: RoundData;
  entries: readonly PlayerEntryAccountData[];
  megaPot: MegaPotVaultData;
  /** Present for settled scenarios — the wheel's spin target. */
  settled?: { event: RoundSettledEvent; mega?: MegaPotTriggeredEvent };
}

/** 42.678 SOL progressive pot. */
const MEGA_ACCRUED = 42_678_000_000n;

const builders: Record<string, (nowSec: number) => FixtureSnapshot> = {
  standard: (now) => {
    const total = 12_500_000_000n; // 12.5 SOL
    const entries = partitionEntries(7n, total, [3, 2, 4, 1], [0x81, 0x82, 0x83, 0x84], BigInt(now - 60));
    return {
      name: "standard",
      description: "4 players, 12.5 SOL pot, round open with ~2 minutes left",
      config: fixtureConfig(7n),
      round: baseRound({
        roundId: 7n,
        state: "open",
        startTs: BigInt(now - 180),
        endTs: BigInt(now + 120),
        total,
        entryCount: entries.length,
      }),
      entries,
      megaPot: megaPot(MEGA_ACCRUED),
    };
  },

  whale: (now) => {
    const total = 10_000_000_000n; // 10 SOL
    // One 95% whale (weights [76,1,1,1,1] over sum 80) + four dust entries
    // — exercises the label-fit threshold: dust arcs are too thin for a
    // curved label, the whale arc is nearly the full ring.
    const entries = partitionEntries(
      21n,
      total,
      [76, 1, 1, 1, 1],
      [0x91, 0x92, 0x93, 0x94, 0x95],
      BigInt(now - 60),
    );
    return {
      name: "whale",
      description: "one whale took 95% of a 10 SOL pot · four dust entries",
      config: fixtureConfig(21n),
      round: baseRound({
        roundId: 21n,
        state: "open",
        startTs: BigInt(now - 180),
        endTs: BigInt(now + 120),
        total,
        entryCount: entries.length,
      }),
      entries,
      megaPot: megaPot(MEGA_ACCRUED),
    };
  },

  highStakes: (now) => {
    const v = HIGH_STAKES_KAT_VECTOR;
    const total = BigInt(v.sample_total_lamports); // > 2^53 lamports
    const entries = partitionEntries(8n, total, [2, 1, 1], [0x91, 0x92, 0x93], BigInt(now - 30));
    return {
      name: "highStakes",
      description: "pot above Number.MAX_SAFE_INTEGER lamports — BigInt display stress",
      config: fixtureConfig(8n),
      round: baseRound({
        roundId: 8n,
        state: "open",
        startTs: BigInt(now - 210),
        endTs: BigInt(now + 90),
        total,
        entryCount: entries.length,
      }),
      entries,
      megaPot: megaPot(MEGA_ACCRUED * 10n),
    };
  },

  soleDepositor: (now) => {
    const total = 5_000_000_000n; // 5 SOL
    const entries = partitionEntries(9n, total, [1], [0x95], BigInt(now - 10));
    return {
      name: "soleDepositor",
      description: "single depositor, window locked — the O(1) cancel path",
      config: fixtureConfig(9n),
      round: baseRound({
        roundId: 9n,
        state: "locked",
        startTs: BigInt(now - 300),
        endTs: BigInt(now - 5),
        total,
        entryCount: 1,
      }),
      entries,
      megaPot: megaPot(MEGA_ACCRUED),
    };
  },

  awaitingRandomness: (now) => {
    const total = 8_800_000_000n;
    const entries = partitionEntries(10n, total, [1, 1, 1], [0xa1, 0xa2, 0xa3], BigInt(now - 120));
    return {
      name: "awaitingRandomness",
      description: "randomness pinned (ADR-4), awaiting the settle crank",
      config: fixtureConfig(10n),
      round: baseRound({
        roundId: 10n,
        state: "awaitingRandomness",
        startTs: BigInt(now - 320),
        endTs: BigInt(now - 20),
        total,
        entryCount: entries.length,
      }),
      entries,
      megaPot: megaPot(MEGA_ACCRUED + 88_000_000n),
    };
  },

  megaSettled: (now) => {
    const v = MEGA_KAT_VECTOR;
    const total = BigInt(v.sample_total_lamports);
    const entries = partitionEntries(11n, total, [1, 3, 1], [0xb1, 0xb2, 0xb3], BigInt(now - 400));
    const event = settleEventFromKat(11n, v, MEGA_ACCRUED);
    const round = baseRound({
      roundId: 11n,
      state: "settled",
      startTs: BigInt(now - 320),
      endTs: BigInt(now - 20),
      total,
      entryCount: entries.length,
      settle: {
        winningTicket: event.winningTicket,
        winnerPayout: event.winnerPayout,
        adminCut: event.adminCut,
        megaCut: event.megaCut,
        megaTriggered: true,
        megaAwarded: event.megaAwarded,
        megaFieldPool: event.megaFieldPool,
        settleTs: BigInt(now - 10),
      },
    });
    return {
      name: "megaSettled",
      description: "settled with the 1-in-625 Mega-Pot triggered — spin + celebration target",
      config: fixtureConfig(11n),
      round,
      entries,
      megaPot: megaPot(event.megaPotRemaining),
      settled: {
        event,
        mega: {
          roundId: 11n,
          cycleIndex: 3n,
          awarded: event.megaAwarded,
          fieldPool: event.megaFieldPool,
          retained: event.megaPotRemaining,
        },
      },
    };
  },

  cancelled: (now) => {
    const total = 3_300_000_000n;
    const entries = partitionEntries(12n, total, [2, 1], [0xc1, 0xc2], BigInt(now - 200));
    return {
      name: "cancelled",
      description: "oracle timeout — terminal refund state (refund UI target)",
      config: fixtureConfig(12n),
      round: baseRound({
        roundId: 12n,
        state: "cancelled",
        startTs: BigInt(now - 400),
        endTs: BigInt(now - 100),
        total,
        entryCount: entries.length,
      }),
      entries,
      megaPot: megaPot(MEGA_ACCRUED),
    };
  },

  escrowAutoPlay: (now) => {
    // Phase 10: entry #1 is escrow-funded — its `player` IS the escrow
    // PDA of fixture owner key(0xd2). View with ?wallet=<ESCROW_OWNER>
    // to see the dual identity (YOU) and AUTO badges without a wallet,
    // and the EscrowPanel's unfunded state.
    const total = 1_200_000_000n; // 1.2 SOL
    const entries = partitionEntries(13n, total, [4, 5, 3], [0xd1, 0xd2, 0xd3], BigInt(now - 30));
    entries[1] = { ...entries[1]!, player: ESCROW_FIXTURE_PDA };
    return {
      name: "escrowAutoPlay",
      description: `auto-play round — entry #1 funded by an escrow PDA (view with ?wallet=${ESCROW_FIXTURE_OWNER.slice(0, 8)}…)`,
      config: {
        ...fixtureConfig(13n),
        autoDepositWindowSecs: 20n,
        autoDepositTipLamports: 200_000n,
        autoDepositEnabled: true,
      },
      round: baseRound({
        roundId: 13n,
        state: "open",
        startTs: BigInt(now - 40),
        endTs: BigInt(now + 80),
        total,
        entryCount: entries.length,
      }),
      entries,
      megaPot: megaPot(MEGA_ACCRUED),
    };
  },
};

export const FIXTURE_SCENARIO_NAMES: readonly string[] = Object.keys(builders);

/** The escrowAutoPlay scenario's escrow owner wallet (fixture key 0xd2). */
export const ESCROW_FIXTURE_OWNER = key(0xd2);
/** The escrow PDA of {@link ESCROW_FIXTURE_OWNER} — entry #1's `player`. */
export const ESCROW_FIXTURE_PDA = escrowKey(new PublicKey(ESCROW_FIXTURE_OWNER)).toString();

/** Builds a scenario deterministically; `nowSec` defaults to wall clock. */
export function buildFixtureSnapshot(name: string, nowSec?: number): FixtureSnapshot | null {
  const build = builders[name];
  if (build === undefined) return null;
  return build(nowSec ?? Math.floor(Date.now() / 1000));
}
