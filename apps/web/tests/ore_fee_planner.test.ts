/**
 * Fee engine + deploy planner gates (directive Phase 2 / GATE 2).
 *
 * These are the revenue-critical cases: R2 (fee on `amount × squares`,
 * never on `amount` alone), R3 (fee is zero when nothing can deploy),
 * the floor/ceiling clamps, MAX inversion, and rent/checkpoint one-time
 * costs. planner.ts and fee.ts are pure — no env, no network.
 */

import { describe, expect, it } from "vitest";
import { Keypair, type PublicKey } from "@solana/web3.js";
import type { OreBoard, OreMiner } from "../src/features/ore-lite/codec";
import { U64_MAX } from "../src/features/ore-lite/codec";
import { type PlatformFee, platformFeeLamports } from "../src/features/ore-lite/fee";
import {
  ALL_SQUARES_MASK,
  CHECKPOINT_FEE_LAMPORTS,
  computeMaxTotalLamports,
  type DeployPlan,
  MINER_RENT_LAMPORTS,
  MIN_DEPLOY_TOTAL_LAMPORTS,
  planDeploy,
  type PlanDeployInput,
  SAFETY_BUFFER_LAMPORTS,
  WALLET_RENT_FLOOR_LAMPORTS,
} from "../src/features/ore-lite/planner";

const SOL = 1_000_000_000n;
const wallet: PublicKey = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey;

const BPS_FEE: PlatformFee = {
  kind: "bps",
  bps: 100, // 1.00%
  minLamports: 100_000n, // 0.0001 SOL floor
  maxLamports: 50_000_000n, // 0.05 SOL ceiling
};

function board(overrides: Partial<OreBoard> = {}): OreBoard {
  return {
    roundId: 1000n,
    startSlot: 900_000n,
    endSlot: 900_240n,
    productionCostEma: 0n,
    ...overrides,
  };
}

function miner(overrides: Partial<OreMiner> & { deployed?: readonly bigint[] } = {}): OreMiner {
  return {
    authority: wallet,
    autoReturn: 0n,
    checkpointId: 1000n,
    checkpointFee: 10_000n, // already paid by default
    deployed: new Array<bigint>(25).fill(0n),
    mass: new Array<bigint>(25).fill(0n),
    cumulative: new Array<bigint>(25).fill(0n),
    roundId: 1000n,
    rewardsFactor: 0n,
    rewardsSol: 0n,
    refinedOre: 0n,
    rewardsOre: 0n,
    lastClaimOreAt: 0n,
    lastClaimSolAt: 0n,
    lifetimeRewardsOre: 0n,
    lifetimeDeployed: 0n,
    lifetimeRewardsSol: 0n,
    ...overrides,
  };
}

function plan(overrides: Partial<Parameters<typeof planDeploy>[0]> = {}): DeployPlan {
  return planDeploy({
    board: board(),
    miner: miner(),
    currentSlot: 900_100n,
    selectedSquares: [0, 1, 2, 3, 4],
    requestedTotalLamports: SOL / 10n,
    walletBalanceLamports: SOL,
    fee: BPS_FEE,
    networkFeeLamports: 5_000n,
    ...overrides,
  });
}

// ── R2: the fee is computed on amount × popcount(mask) ─────────────────

describe("GATE 2 — R2: fee on the filtered total, not the per-square amount", () => {
  it("20 squares at 0.000601562 SOL each → totalDeploy 12_031_240n and 1% fee on that", () => {
    // Live mainnet shape: amount=601_562 lamports, 20-square mask moved
    // 0.01203124 SOL (directive R2).
    const squares = Array.from({ length: 20 }, (_, i) => i);
    const p = plan({
      selectedSquares: squares,
      requestedTotalLamports: 12_031_240n,
    });
    expect(p.eligibleSquares).toHaveLength(20);
    expect(p.amountPerSquare).toBe(601_562n);
    expect(p.totalDeploy).toBe(12_031_240n);
    // 1% of 12_031_240 = 120_312 (floor) — NOT 1% of 601_562 = 6_015.
    expect(p.platformFee).toBe(120_312n);
    expect(p.platformFee).not.toBe(6_015n);
  });

  it("fee engine alone: bps on the total, floor and ceiling both bind", () => {
    // 1% of 5_000_000 = 50_000 < floor 100_000 → floor binds
    expect(platformFeeLamports(BPS_FEE, 5_000_000n)).toBe(100_000n);
    // 1% of 6_000_000_000 = 60_000_000 > ceiling 50_000_000 → ceiling binds
    expect(platformFeeLamports(BPS_FEE, 6_000_000_000n)).toBe(50_000_000n);
    // exactly at the floor/ceiling crossing points
    expect(platformFeeLamports(BPS_FEE, 10_000_000n)).toBe(100_000n);
    expect(platformFeeLamports(BPS_FEE, 5_000_000_000n)).toBe(50_000_000n);
    // R3: zero (or negative) deploy ⇒ zero fee, even under a floor
    expect(platformFeeLamports(BPS_FEE, 0n)).toBe(0n);
    // flat fee passes through
    expect(platformFeeLamports({ kind: "flat", lamports: 1_234n }, 999n)).toBe(1_234n);
  });
});

// ── R3: squares already occupied this round ────────────────────────────

describe("GATE 2 — R3: occupied-square filtering", () => {
  it("miner on 3 of 5 selected squares → 2 eligible, totalDeploy reflects 2", () => {
    const m = miner({ deployed: [1n, 0n, 1n, 0n, 1n, ...new Array<bigint>(20).fill(0n)] });
    const p = plan({
      miner: m,
      selectedSquares: [0, 1, 2, 3, 4],
      requestedTotalLamports: 10_000_000n,
    });
    expect(p.eligibleSquares).toEqual([1, 3]);
    expect(p.mask).toBe(0b01010);
    expect(p.amountPerSquare).toBe(5_000_000n);
    expect(p.totalDeploy).toBe(p.amountPerSquare * 2n);
    expect(p.blocker).toBeNull();
  });

  it("floor division never deploys dust: 10_000_001n over 2 squares deploys 10_000_000n", () => {
    const m = miner({ deployed: [1n, 0n, 1n, 0n, 1n, ...new Array<bigint>(20).fill(0n)] });
    const p = plan({ miner: m, requestedTotalLamports: 10_000_001n });
    expect(p.amountPerSquare).toBe(5_000_000n);
    expect(p.totalDeploy).toBe(10_000_000n);
  });

  it("every selected square occupied ⇒ blocker no-eligible-squares AND platformFee 0n", () => {
    const m = miner({ deployed: [1n, 1n, 1n, 1n, 1n, ...new Array<bigint>(20).fill(0n)] });
    const p = plan({ miner: m, selectedSquares: [0, 1, 2, 3, 4] });
    expect(p.blocker).toBe("no-eligible-squares");
    expect(p.platformFee).toBe(0n);
    expect(p.totalDeploy).toBe(0n);
    expect(p.mask).toBe(0);
    expect(p.requiredBalance).toBe(5_000n + WALLET_RENT_FLOOR_LAMPORTS); // network fee + the wallet's own post-tx rent floor — nothing else chargeable
  });

  it("a null miner (first deploy ever) leaves every square eligible", () => {
    const p = plan({ miner: null });
    expect(p.eligibleSquares).toHaveLength(5);
  });

  it("REGRESSION (stale round): miner parked on round N−1 never locks squares in round N", () => {
    // deploy.rs zeroes `miner.deployed` on the round-mismatch path, so
    // these rows belong to the OLD round — every selected square must
    // stay eligible even with all of them non-zero.
    const stale = miner({
      roundId: 1000n, // board() is on 1001n
      deployed: Array.from({ length: 25 }, () => 5_000_000n),
    });
    const p = plan({ board: board({ roundId: 1001n }), miner: stale });
    expect(p.eligibleSquares).toEqual([0, 1, 2, 3, 4]);
    expect(p.mask).toBe(0b11111);
    expect(p.blocker).toBeNull();
    expect(p.totalDeploy).toBe(p.amountPerSquare * 5n);
  });

  it("REGRESSION (stale round): same miner on the SAME round keeps the R3 filter", () => {
    const current = miner({
      roundId: 1001n, // matches board
      deployed: [1n, 1n, 1n, 1n, 1n, ...new Array<bigint>(20).fill(0n)],
    });
    const p = plan({ board: board({ roundId: 1001n }), miner: current });
    expect(p.blocker).toBe("no-eligible-squares");
    expect(p.platformFee).toBe(0n);
  });
});

// ── one-time costs, required balance, blockers ─────────────────────────

describe("GATE 2 — required balance & one-time costs", () => {
  it("miner rent is included exactly when the miner is absent", () => {
    const first = plan({ miner: null });
    expect(first.minerRent).toBe(MINER_RENT_LAMPORTS);
    expect(first.checkpointFee).toBe(CHECKPOINT_FEE_LAMPORTS);
    const second = plan({});
    expect(second.minerRent).toBe(0n);
    expect(second.checkpointFee).toBe(0n); // checkpoint_fee already non-zero
  });

  it("REGRESSION (fresh miner): deploy.rs charges CHECKPOINT_FEE whenever checkpoint_fee == 0, zeroed fresh accounts included", () => {
    // The account created inside the first deploy starts zeroed, so the
    // `if miner.checkpoint_fee == 0` top-up in deploy.rs fires on the very
    // first deploy too — required balance must include the 10k lamports.
    const p = plan({ miner: null, selectedSquares: [7], requestedTotalLamports: 1_000_000n });
    expect(p.checkpointFee).toBe(CHECKPOINT_FEE_LAMPORTS);
    expect(p.minerRent).toBe(MINER_RENT_LAMPORTS);
    expect(p.requiredBalance).toBe(
      p.totalDeploy +
        p.platformFee +
        CHECKPOINT_FEE_LAMPORTS +
        MINER_RENT_LAMPORTS +
        p.networkFee +
        WALLET_RENT_FLOOR_LAMPORTS,
    );
  });

  it("checkpoint fee applies when an existing miner has never checkpointed", () => {
    const p = plan({ miner: miner({ checkpointFee: 0n }) });
    expect(p.checkpointFee).toBe(CHECKPOINT_FEE_LAMPORTS);
    expect(p.minerRent).toBe(0n);
  });

  it("requiredBalance is the full sum and flags insufficient balance", () => {
    const p = plan({ requestedTotalLamports: 500_000_000n, walletBalanceLamports: 400_000_000n });
    expect(p.requiredBalance).toBe(
      p.totalDeploy + p.platformFee + p.checkpointFee + p.minerRent + p.networkFee + WALLET_RENT_FLOOR_LAMPORTS,
    );
    expect(p.blocker).toBe("insufficient-balance");
  });

  it("a wallet funded to exactly the debit — but not the rent floor — is blocked, not simulation-failed", () => {
    // The live 2026-10-07 incident: 0.010 SOL deploy from a wallet holding
    // precisely the old requiredBalance died at simulation with
    // InsufficientFundsForRent on the wallet account. The floor must be in
    // the plan so the UI blocks with a number instead.
    const p = plan({ requestedTotalLamports: 10_000_000n, walletBalanceLamports: 10_000_000n });
    expect(p.totalDeploy).toBe(10_000_000n);
    // Without the floor the old sum is <= balance; the floor tips it over.
    expect(p.requiredBalance).toBeGreaterThan(10_000_000n);
    expect(p.blocker).toBe("insufficient-balance");
  });

  it("per-square rounding to zero is blocked as amount-too-small", () => {
    const p = plan({ requestedTotalLamports: 4n, selectedSquares: [0, 1, 2, 3, 4] });
    expect(p.amountPerSquare).toBe(0n);
    expect(p.blocker).toBe("amount-too-small");
  });

  it("slot >= end_slot is intermission; slot < start_slot is round-not-open; u64::MAX end is deployable", () => {
    expect(plan({ currentSlot: 900_240n }).blocker).toBe("intermission");
    expect(plan({ currentSlot: 899_999n }).blocker).toBe("round-not-open");
    const waiting = plan({ board: board({ endSlot: U64_MAX, startSlot: 0n }), currentSlot: 42n });
    expect(waiting.blocker).toBeNull(); // WAITING_FIRST_DEPLOY starts the clock
  });
});

// ── Deploy-All: board-default planning (2026-10-07 directive) ──────────

describe("Deploy-All — board-default square set, totals, truncation", () => {
  /** planDeploy WITHOUT selectedSquares — Lite's whole-board default. */
  function boardPlan(overrides: Partial<PlanDeployInput> = {}): DeployPlan {
    return planDeploy({
      board: board(),
      miner: miner(),
      currentSlot: 900_100n,
      requestedTotalLamports: 25_000_000n,
      walletBalanceLamports: SOL,
      fee: BPS_FEE,
      networkFeeLamports: 5_000n,
      ...overrides,
    });
  }

  it("1. defaults to the whole board: fresh miner ⇒ 25 eligible, full mask", () => {
    const p = boardPlan({ miner: null });
    expect(p.eligibleSquares).toHaveLength(25);
    expect(p.mask).toBe(ALL_SQUARES_MASK);
    expect(p.mask).toBe(0x01ff_ffff);
  });

  it("2. even split: 25_000_000 lamports over 25 squares, zero remainder", () => {
    const p = boardPlan({ miner: null, requestedTotalLamports: 25_000_000n });
    expect(p.amountPerSquare).toBe(1_000_000n);
    expect(p.totalDeploy).toBe(25_000_000n);
    expect(p.remainder).toBe(0n);
  });

  it("3. truncation: 25_000_024 ⇒ 1M per square, remainder 24n, fee on the DEPLOYED total", () => {
    const p = boardPlan({ miner: null, requestedTotalLamports: 25_000_024n });
    expect(p.amountPerSquare).toBe(1_000_000n);
    expect(p.totalDeploy).toBe(25_000_000n);
    expect(p.remainder).toBe(24n);
    // Fee is computed on totalDeploy (R2), never on the raw request.
    expect(p.platformFee).toBe(platformFeeLamports(BPS_FEE, 25_000_000n));
    expect(p.platformFee).toBe(platformFeeLamports(BPS_FEE, p.totalDeploy));
  });

  it("4. partial occupancy reduces the board, not the budget: 5 held ⇒ 20 squares × total/20", () => {
    const p = boardPlan({
      miner: miner({ deployed: [1n, 1n, 1n, 1n, 1n, ...new Array<bigint>(20).fill(0n)] }),
      requestedTotalLamports: 25_000_000n,
    });
    expect(p.eligibleSquares).toHaveLength(20);
    expect(p.amountPerSquare).toBe(25_000_000n / 20n);
    expect(p.totalDeploy).toBe(p.amountPerSquare * 20n);
  });

  it("5. stale round still means a full board: all 25 marked occupied but roundId mismatched", () => {
    const p = boardPlan({
      board: board({ roundId: 1001n }),
      miner: miner({ roundId: 1000n, deployed: Array.from({ length: 25 }, () => 5_000_000n) }),
    });
    expect(p.eligibleSquares).toHaveLength(25);
    expect(p.blocker).toBeNull();
  });

  it("6. dust floor: 999_999 lamports ⇒ amount-too-small and no fee charged", () => {
    const p = boardPlan({ miner: null, requestedTotalLamports: 999_999n });
    expect(p.blocker).toBe("amount-too-small");
    expect(p.platformFee).toBe(0n);
    // Just above the floor is fine.
    expect(boardPlan({ miner: null, requestedTotalLamports: MIN_DEPLOY_TOTAL_LAMPORTS }).blocker).toBeNull();
  });

  it("7. full occupancy in the CURRENT round ⇒ no-eligible-squares and no fee", () => {
    const p = boardPlan({
      miner: miner({ deployed: Array.from({ length: 25 }, () => 5_000_000n) }),
    });
    expect(p.blocker).toBe("no-eligible-squares");
    expect(p.platformFee).toBe(0n);
  });
});

// ── MAX inversion ──────────────────────────────────────────────────────

describe("GATE 2 — MAX inversion", () => {
  const fixed = {
    fee: BPS_FEE,
    checkpointFee: CHECKPOINT_FEE_LAMPORTS, // worst case: first deploy (fresh or unpaid)
    minerRent: MINER_RENT_LAMPORTS, // worst case: first deploy
    networkFeeLamports: 5_000n,
  };

  it("never leaves less than the safety buffer and never overcommits", () => {
    for (const balance of [SOL, SOL / 2n, 50_000_000n, MINER_RENT_LAMPORTS + SAFETY_BUFFER_LAMPORTS, 1_000n]) {
      const maxTotal = computeMaxTotalLamports({ ...fixed, walletBalanceLamports: balance });
      if (maxTotal > 0n) {
        // The re-planned deploy at MAX must be affordable and leave the buffer.
        const p = plan({
          miner: null,
          requestedTotalLamports: maxTotal,
          selectedSquares: [0],
          walletBalanceLamports: balance,
          networkFeeLamports: fixed.networkFeeLamports,
        });
        expect(p.blocker).toBeNull();
        expect(balance - p.requiredBalance >= SAFETY_BUFFER_LAMPORTS).toBe(true);
      } else {
        // Even zero must never overcommit.
        expect(maxTotal).toBe(0n);
      }
    }
  });

  it("returns 0 when the balance cannot cover fixed costs + buffer", () => {
    expect(
      computeMaxTotalLamports({
        ...fixed,
        walletBalanceLamports: MINER_RENT_LAMPORTS + SAFETY_BUFFER_LAMPORTS - 1n,
      }),
    ).toBe(0n);
  });

  it("the fee at MAX is evaluated on the un-reduced total (capped fee case)", () => {
    // 10 SOL balance, 1% capped at 0.05 SOL: MAX should be nearly the whole
    // balance minus fixed costs (rent + checkpoint + network + the wallet's
    // own rent floor + buffer) and the capped fee.
    const maxTotal = computeMaxTotalLamports({ ...fixed, walletBalanceLamports: 10n * SOL });
    expect(maxTotal).toBe(
      10n * SOL -
        MINER_RENT_LAMPORTS -
        CHECKPOINT_FEE_LAMPORTS -
        5_000n -
        WALLET_RENT_FLOOR_LAMPORTS -
        SAFETY_BUFFER_LAMPORTS -
        50_000_000n,
    );
  });
});

// ── fee-recipient bootstrap (live 2026-10-07 incident #2) ──────────────

describe("the fee recipient must exist before a floor-sized fee can be charged", () => {
  it("an unfunded recipient blocks a floor-sized fee instead of failing at simulation", () => {
    // The live failure: 7HQzM3eP…4Dsr had never been funded, so the
    // bundled SystemProgram.transfer tried to CREATE it with 100 000
    // lamports — below the 650 240 rent-exempt minimum for a 0-byte
    // system account. The runtime answered
    // {"InsufficientFundsForRent":{"account_index":1}}, index 1 of the
    // TRANSFER being the recipient. The planner must name it.
    const p = plan({ requestedTotalLamports: 10_000_000n, feeRecipientExists: false });
    expect(p.platformFee).toBe(100_000n); // 1% of 0.01 SOL = exactly the floor
    expect(p.platformFee).toBeLessThan(WALLET_RENT_FLOOR_LAMPORTS);
    expect(p.blocker).toBe("fee-recipient-uninitialized");
  });

  it("a fee at or above the rent minimum creates the recipient — not blocked", () => {
    // Why the failure looked erratic: deploys ≥ ~0.065 SOL carry a 1% fee
    // ≥ 650 240, which successfully creates the account. Only the small
    // ones died, and the first big one would have fixed every later one.
    const p = plan({ requestedTotalLamports: 65_024_000n, feeRecipientExists: false });
    expect(p.platformFee).toBe(WALLET_RENT_FLOOR_LAMPORTS);
    expect(p.blocker).toBeNull();
  });

  it("a funded recipient and an omitted flag both leave the plan untouched", () => {
    expect(plan({ requestedTotalLamports: 10_000_000n, feeRecipientExists: true }).blocker).toBeNull();
    expect(plan({ requestedTotalLamports: 10_000_000n }).blocker).toBeNull();
  });

  it("an earlier blocker zeroes the fee, so the recipient is never the complaint", () => {
    // No fee is transferred at all on a blocked plan — emitting
    // "fee wallet not initialized" there would misdirect the user.
    const p = plan({ requestedTotalLamports: 4n, selectedSquares: [0, 1], feeRecipientExists: false });
    expect(p.platformFee).toBe(0n);
    expect(p.blocker).toBe("amount-too-small");
  });
});
