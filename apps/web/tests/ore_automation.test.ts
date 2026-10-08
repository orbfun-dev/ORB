/**
 * Auto-join P1 tests (directive §7 cases 1, 2, 6, 8): the Automate V2 wire
 * format, the A3 zeroed-conditions guard, the §2 automation-active blocker
 * for BOTH executor populations, and the Automation account decoder against
 * a real live mainnet fixture.
 *
 * instructions.ts imports config.ts, which throws at module load when
 * VITE_ORE_FEE_RECIPIENT is unset — stubbed before the dynamic import,
 * same pattern as ore_golden.test.ts.
 */

import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { OreAutomation } from "../src/features/ore-lite/codec";

vi.stubEnv(
  "VITE_ORE_FEE_RECIPIENT",
  Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey.toBase58(),
);

const {
  DEFAULT_AUTOMATION_CONDITIONS,
  ORE_AUTOMATION_STRATEGIES,
  buildAutomateIx,
  decodeAutomateData,
  encodeAutomateData,
} = await import("../src/features/ore-lite/instructions");
const { decodeOreAutomation } = await import("../src/features/ore-lite/codec");
const { ORE_PERMISSIONLESS_EXECUTOR, PLATFORM_FEE_RECIPIENT } = await import(
  "../src/features/ore-lite/config"
);
const {
  AUTOMATION_RENT_LAMPORTS,
  AUTOMATION_EXECUTOR_FEE_LAMPORTS,
  MINER_RENT_LAMPORTS,
  automationPerRound,
  planAutomation,
  planDeploy,
  popcount25,
  roundsRemaining,
} = await import("../src/features/ore-lite/planner");

const SOL = 1_000_000_000n;
const wallet: PublicKey = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
const PERMISSIONLESS_EXECUTOR = new PublicKey(
  "executor11111111111111111111111111111111112",
);

function automation(overrides: Partial<OreAutomation> = {}): OreAutomation {
  return {
    amount: 40_000n,
    authority: wallet,
    balance: 10_000_000n,
    executor: PERMISSIONLESS_EXECUTOR,
    fee: 12_000n,
    strategy: 1n,
    mask: 0x01ff_ffffn,
    reload: 0n,
    totalSolSpent: 0n,
    totalOreEarned: 0n,
    conditions: DEFAULT_AUTOMATION_CONDITIONS,
    ...overrides,
  };
}

describe("case 1 — encodeAutomateData: Automate V2 is exactly 66 bytes at the §3.1 offsets", () => {
  const data = encodeAutomateData({
    amountPerSquare: 40_000n,
    deposit: 2_002_000n,
    fee: 1_000n,
    mask: 0x01ff_ffff,
    strategy: ORE_AUTOMATION_STRATEGIES.Preferred,
    reload: 0n,
  });

  it("is 66 bytes, disc 0, every field at its documented offset", () => {
    expect(data.length).toBe(66);
    expect(data[0]).toBe(0);
    expect(data.readBigUInt64LE(1)).toBe(40_000n); // amount
    expect(data.readBigUInt64LE(9)).toBe(2_002_000n); // deposit
    expect(data.readBigUInt64LE(17)).toBe(1_000n); // fee
    expect(data.readBigUInt64LE(25)).toBe(0x01ff_ffffn); // mask
    expect(data[33]).toBe(1); // strategy u8
    expect(data.readBigUInt64LE(34)).toBe(0n); // reload
    expect(data.subarray(42, 66).equals(DEFAULT_AUTOMATION_CONDITIONS)).toBe(true);
  });

  it("round-trips through decodeAutomateData", () => {
    const back = decodeAutomateData(data);
    expect(back.amountPerSquare).toBe(40_000n);
    expect(back.deposit).toBe(2_002_000n);
    expect(back.fee).toBe(1_000n);
    expect(back.mask).toBe(0x01ff_ffffn);
    expect(back.strategy).toBe(1);
    expect(back.reload).toBe(0n);
    expect(back.conditions.equals(DEFAULT_AUTOMATION_CONDITIONS)).toBe(true);
  });
});

describe("case 2 — DEFAULT_AUTOMATION_CONDITIONS and the A3 zero guard", () => {
  it("is 24 bytes matching AutomationConditions::default()", () => {
    expect(DEFAULT_AUTOMATION_CONDITIONS.length).toBe(24);
    // ff×8 | min_motherlode 00 00 | max_motherlode ff ff | splits 00 00 | solos 00 00 | buffer 00×8
    expect(DEFAULT_AUTOMATION_CONDITIONS.toString("hex")).toBe(
      "ffffffffffffffff0000ffff00000000" + "0000000000000000",
    );
  });

  it("rejects an all-zero blob with a message naming the silent no-op", () => {
    expect(() =>
      encodeAutomateData({
        amountPerSquare: 40_000n,
        deposit: 2_002_000n,
        fee: 1_000n,
        mask: 1,
        strategy: ORE_AUTOMATION_STRATEGIES.Preferred,
        reload: 0n,
        conditions: Buffer.alloc(24),
      }),
    ).toThrowError(/silent no-op/);
  });
});

describe("case 6 — an existing automation blocks the manual deploy for ANY executor (§2)", () => {
  const base = {
    board: {
      roundId: 1000n,
      startSlot: 900_000n,
      endSlot: 900_240n,
      productionCostEma: 0n,
    },
    miner: {
      authority: wallet,
      autoReturn: 0n,
      checkpointId: 1000n,
      checkpointFee: 10_000n,
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
    },
    currentSlot: 900_100n,
    requestedTotalLamports: SOL / 10n,
    walletBalanceLamports: SOL,
    fee: { kind: "bps", bps: 100, minLamports: 100_000n, maxLamports: 50_000_000n } as const,
    networkFeeLamports: 5_000n,
  } as const;

  it("blocks a CUSTOM-executor automation (the hard-fail population)", () => {
    const plan = planDeploy({
      ...base,
      automation: automation({
        executor: Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey,
        strategy: 2n,
        mask: 0x7fffn,
      }),
    });
    expect(plan.blocker).toBe("automation-active");
    expect(plan.platformFee).toBe(0n);
  });

  it("blocks a PERMISSIONLESS automation with a 25-square mask — the silent-wrong population the K-count guard cannot catch", () => {
    const plan = planDeploy({ ...base, automation: automation() });
    expect(plan.blocker).toBe("automation-active");
    expect(plan.platformFee).toBe(0n);
  });

  it("does not block when no automation exists", () => {
    const plan = planDeploy({ ...base, automation: null });
    expect(plan.blocker).toBeNull();
    expect(plan.platformFee).toBeGreaterThan(0n);
  });
});

describe("cases 3–5 — planAutomation commitment math (no-keeper design)", () => {
  const FEE = { kind: "bps", bps: 100, minLamports: 100_000n, maxLamports: 50_000_000n } as const;

  const plan = (overrides: Partial<Parameters<typeof planAutomation>[0]> = {}) =>
    planAutomation({
      requestedTotalPerRound: SOL,
      rounds: 5,
      minerExists: true,
      minerCheckpointFee: 10_000n,
      fee: FEE,
      ...overrides,
    });

  it("case 3: 1 SOL/round × 5 rounds on 25 squares — exact commitment figures", () => {
    const p = plan();
    expect(p.amountPerSquare).toBe(40_000_000n);
    expect(p.perRoundTotal).toBe(1_000_000_000n);
    expect(p.executorFeePerRound).toBe(AUTOMATION_EXECUTOR_FEE_LAMPORTS); // 7 000 to the bot fleet
    expect(p.deposit).toBe(5_000_035_000n); // 5 × (1 SOL + 7 000)
    // 1% of the deposit is 50 000 350 — the 0.05 SOL CEILING clamps to
    // 50 000 000. Large commitments cap our fee; that is the policy.
    expect(p.setupFee).toBe(50_000_000n);
    expect(p.blocker).toBeNull();
    // New miner: both rents (live-verified rates — see planner constants;
    // the directive's 6 124 800 / 2 004 480 were the pre-reduction rates)
    // plus the 10k checkpoint top-up.
    const first = plan({ minerExists: false, minerCheckpointFee: 0n });
    expect(first.minerRent).toBe(MINER_RENT_LAMPORTS);
    expect(first.automationRent).toBe(AUTOMATION_RENT_LAMPORTS);
    expect(first.checkpointTopUp).toBe(10_000n);
    expect(first.walletDebit).toBe(
      5_000_035_000n + 50_000_000n + AUTOMATION_RENT_LAMPORTS + MINER_RENT_LAMPORTS + 10_000n,
    );
    expect(first.refundable).toBe(AUTOMATION_RENT_LAMPORTS);
    // Existing topped-up miner: deposit + setup fee + automation rent only.
    expect(p.minerRent).toBe(0n);
    expect(p.checkpointTopUp).toBe(0n);
    expect(p.walletDebit).toBe(5_000_035_000n + 50_000_000n + AUTOMATION_RENT_LAMPORTS);
  });

  it("case 4: the fee floor binds ONCE on tiny deposits — clamped fee, no blocker", () => {
    // 2 rounds at the product minimum: deposit 2 × 1 007 000 = 2 014 000,
    // 1% = 20 140 < the 100 000 floor → one clamped charge, disclosed.
    const dust = plan({ requestedTotalPerRound: 1_000_000n, rounds: 2 });
    expect(dust.setupFee).toBe(100_000n);
    expect(dust.blocker).toBeNull();
    // The researcher's median row: 10 rounds × 0.0012 SOL → 1% clears the
    // floor → ~1.0% effective (the keeper design charged 8.3% here).
    const median = plan({ requestedTotalPerRound: 1_200_000n, rounds: 10 });
    expect(median.deposit).toBe(12_070_000n);
    expect(median.setupFee).toBe(120_700n);
    expect(median.blocker).toBeNull();
  });

  it("case 5: rounds 0 and 501 are out of range", () => {
    expect(plan({ rounds: 0 }).blocker).toBe("rounds-out-of-range");
    expect(plan({ rounds: 501 }).blocker).toBe("rounds-out-of-range");
    expect(plan({ rounds: 500 }).blocker).toBeNull();
  });

  it("an existing automation blocks new setups until the top-up flow exists (§4.2)", () => {
    expect(plan({ automation: automation() }).blocker).toBe("automation-active");
    expect(plan({ automation: null }).blocker).toBeNull();
  });

  it("requiredBalance = walletDebit + the wallet rent floor, and it blocks before simulation", () => {
    const p = plan();
    expect(p.walletRentFloor).toBe(650_240n);
    expect(p.requiredBalance).toBe(p.walletDebit + 650_240n);
    // Funded to exactly the debit (old failure mode) → blocked with a number.
    expect(plan({ walletBalanceLamports: p.walletDebit }).blocker).toBe("insufficient-balance");
    // Funded to the full requirement → clear.
    expect(plan({ walletBalanceLamports: p.requiredBalance }).blocker).toBeNull();
  });

  it("an unfunded fee recipient blocks a floor-sized setup fee (same treasury as manual)", () => {
    // The setup transaction bundles the identical SystemProgram.transfer,
    // so the 2026-10-07 bootstrap failure hits auto-join too — and only
    // where the fee is small enough not to create the account itself.
    const dust = plan({ requestedTotalPerRound: 1_000_000n, rounds: 2, feeRecipientExists: false });
    expect(dust.setupFee).toBe(100_000n); // the floor — below rent-exemption
    expect(dust.blocker).toBe("fee-recipient-uninitialized");
    // The default 5 × 1 SOL commitment pays the 0.05 SOL ceiling, which
    // creates the account outright: no blocker even while it is unfunded.
    expect(plan({ feeRecipientExists: false }).setupFee).toBe(50_000_000n);
    expect(plan({ feeRecipientExists: false }).blocker).toBeNull();
    // Funded, or unknown: untouched.
    expect(plan({ requestedTotalPerRound: 1_000_000n, rounds: 2, feeRecipientExists: true }).blocker).toBeNull();
    expect(plan({ requestedTotalPerRound: 1_000_000n, rounds: 2 }).blocker).toBeNull();
  });

  it("truncation remainder is never committed: 25 squares keep 0–24 lamports in the wallet", () => {
    const p = plan({ requestedTotalPerRound: 1_000_000_024n });
    expect(p.amountPerSquare).toBe(40_000_000n);
    expect(p.perRoundTotal).toBe(1_000_000_000n);
    expect(p.remainder).toBe(24n);
    expect(p.deposit).toBe(5n * (1_000_000_000n + p.executorFeePerRound));
  });

  it("golden setup shape: [CB, CB, transfer(setupFee), Automate] — the revenue-critical bundle", async () => {
    const { ComputeBudgetProgram, SystemProgram, TransactionMessage, VersionedTransaction } =
      await import("@solana/web3.js");
    const { buildAutomateIx } = await import("../src/features/ore-lite/instructions");
    const p = plan();
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2_000 }),
      SystemProgram.transfer({
        fromPubkey: wallet,
        toPubkey: PLATFORM_FEE_RECIPIENT,
        lamports: p.setupFee,
      }),
      buildAutomateIx({
        authority: wallet,
        executor: ORE_PERMISSIONLESS_EXECUTOR,
        amountPerSquare: p.amountPerSquare,
        deposit: p.deposit,
        fee: p.executorFeePerRound,
        mask: 0x01ff_ffff,
        strategy: ORE_AUTOMATION_STRATEGIES.Preferred,
        reload: 0n,
      }),
    ];
    const message = new TransactionMessage({
      payerKey: wallet,
      recentBlockhash: Keypair.fromSeed(new Uint8Array(32).fill(6)).publicKey.toBase58(),
      instructions: ixs,
    }).compileToV0Message();
    expect(message.compiledInstructions).toHaveLength(4);
    const programOf = (ix: (typeof message.compiledInstructions)[number]) =>
      message.staticAccountKeys[ix.programIdIndex]!.toBase58();
    expect(message.compiledInstructions.map(programOf)).toEqual([
      ComputeBudgetProgram.programId.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
      SystemProgram.programId.toBase58(),
      "oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv",
    ]);
    expect(message.compiledInstructions.map((ix) => ix.data.length)).toEqual([5, 9, 12, 66]);
    // discriminants: CU-limit=2, CU-price=3, transfer=2 (u32!), Automate=0
    expect(message.compiledInstructions.map((ix) => ix.data[0])).toEqual([2, 3, 2, 0]);
    const transfer = ixs[2]!;
    expect(transfer.data.readUInt32LE(0)).toBe(2);
    expect(transfer.data.readBigUInt64LE(4)).toBe(p.setupFee);
    // The executor meta is the permissionless sentinel, read-only (A1).
    expect(ixs[3]!.keys[2]).toMatchObject({
      pubkey: ORE_PERMISSIONLESS_EXECUTOR,
      isSigner: false,
      isWritable: false,
    });
    expect(new VersionedTransaction(message).version).toBe(0);
  });
});

describe("case 7 — stop encoding: Automate(executor = Pubkey.default) (A1, §3.1)", () => {
  it("is 5 metas with the executor READ-ONLY, 66-byte disc-0 data", () => {
    const SYSTEM = new PublicKey("11111111111111111111111111111111");
    const ix = buildAutomateIx({
      authority: wallet,
      executor: PublicKey.default,
      amountPerSquare: 40_000n,
      deposit: 2_002_000n,
      fee: 1_000n,
      mask: 0x01ff_ffff,
      strategy: ORE_AUTOMATION_STRATEGIES.Preferred,
      reload: 0n,
    });
    expect(ix.keys).toHaveLength(5);
    expect(ix.data.length).toBe(66);
    expect(ix.data[0]).toBe(0);
    // Meta 2 — the executor — is read-only ON PURPOSE even though the Rust
    // SDK marks it writable: on the stop path executor == Pubkey.default ==
    // the System program, and a writable meta there would collide with
    // meta 4 and request a write lock on a native program.
    expect(ix.keys[2]).toMatchObject({
      pubkey: SYSTEM,
      isSigner: false,
      isWritable: false,
    });
    // ...and meta 4 (System program) is read-only too — both may appear.
    expect(ix.keys[4]).toMatchObject({ pubkey: SYSTEM, isSigner: false, isWritable: false });
    expect(ix.keys[0]).toMatchObject({ pubkey: wallet, isSigner: true, isWritable: true });
    expect(ix.keys[1]!.isWritable).toBe(true); // automation PDA
    expect(ix.keys[3]!.isWritable).toBe(true); // miner PDA
  });
});

describe("case 8 — decodeOreAutomation against the live mainnet fixture (§3.3)", () => {
  // getAccountInfo("EKB2KUcKcZVeqKfWobjDTvP1YaC4zFypNzCGgzG8MjbZ") on
  // 2026-10-07: 160 bytes, owner oreV3EG1i…, one of the competitor's
  // Discretionary customers under executor 5Hdaug… (12 000-lamport fee).
  const FIXTURE_B64 =
    "ZAAAAAAAAACKXRQAAAAAALT/MTnjTy/I6mccRmycJ4A44NO8Vv5sVo2KM0P2f1cboKT4dgAAAAA/sWgyYdmdNobLgVZnwPetSClaVxvV8glPwopGqeFZiOAuAAAAAAAAAgAAAAAAAAD/fwAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//////////AQA8AAAAAAAAAAAAAAAAAA==";

  it("decodes the documented field values", () => {
    const decoded = decodeOreAutomation(Buffer.from(FIXTURE_B64, "base64"));
    expect(decoded.amount).toBe(1_334_666n);
    expect(decoded.balance).toBe(1_996_006_560n);
    expect(decoded.fee).toBe(12_000n);
    expect(decoded.strategy).toBe(2n);
    expect(decoded.mask).toBe(0x7fffn);
    expect(decoded.reload).toBe(1n);
    expect(decoded.authority.equals(
      new PublicKey("DBY5abQ7hd9adfB6RTMQTsk3HDUSL5wLDAxS5d8Fh6Dp"),
    )).toBe(true);
    expect(decoded.executor.equals(
      new PublicKey("5HdaugVSYWp5ALSb1JzX2DgmsNpa5MWatFg1zCyympi3"),
    )).toBe(true);
    expect(decoded.conditions.length).toBe(24);
  });

  it("rejects data with the wrong discriminator", () => {
    const wrong = Buffer.from(FIXTURE_B64, "base64");
    wrong.writeBigUInt64LE(109n, 0); // Round disc
    expect(() => decodeOreAutomation(wrong)).toThrowError(/Automation/);
  });
});

describe("P3 — live-automation views (§5.3)", () => {
  it("popcount25 counts set bits across the mask range", () => {
    expect(popcount25(0x01ff_ffffn)).toBe(25);
    expect(popcount25(0x7fffn)).toBe(15); // 2^15 − 1: fifteen ones
    expect(popcount25(1n)).toBe(1);
    expect(popcount25(0n)).toBe(0);
  });

  it("automationPerRound is amount × occupied squares", () => {
    expect(automationPerRound(automation())).toBe(40_000n * 25n); // deploy-all default
    expect(
      automationPerRound(automation({ amount: 1_334_666n, mask: 0x7fffn, strategy: 2n })),
    ).toBe(1_334_666n * 15n); // the live fixture's terms: 15 occupied squares
  });

  it("roundsRemaining floors whole funded rounds and treats 0 per-round as 0", () => {
    // 25 squares × 40k + 1k fee = 1_001_000 per round; balance 2_050_000 → 2
    expect(roundsRemaining(automation({ balance: 2_050_000n, fee: 1_000n }))).toBe(2n);
    // Exactly one round's worth → 1, not 2.
    expect(roundsRemaining(automation({ balance: 1_001_000n, fee: 1_000n }))).toBe(1n);
    // Under one round → 0 (the executor's next attempt self-closes + refunds).
    expect(roundsRemaining(automation({ balance: 999_999n, fee: 1_000n }))).toBe(0n);
  });
});
