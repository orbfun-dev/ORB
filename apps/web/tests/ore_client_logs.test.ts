/**
 * Simulation-log deploy-count parser + zero-op abort guard (fix directive
 * Item B). `client.ts` imports `config.ts`, which throws at module load
 * when VITE_ORE_FEE_RECIPIENT is unset — stubbed env + dynamic import run
 * before the module evaluates, exercising the production path.
 *
 * The log format is pinned to ore commit 48c203b, deploy.rs:
 *   sol_log(format!("Round #{}: deploying {} SOL to {} squares",
 *                  round.id, lamports_to_sol(amount), total_squares))
 * — emitted even when every square was skipped (K = 0), which is exactly
 * the sniped-squares case the guard exists to catch.
 */

import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

vi.stubEnv(
  "VITE_ORE_FEE_RECIPIENT",
  Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58(),
);
const { parseDeployedSquareCount, verifySimulationDeployCount } = await import(
  "../src/features/ore-lite/client"
);

const NOISE = [
  "Program ComputeBudget111111111111111111111111111111 invoke [1]",
  "Program ComputeBudget111111111111111111111111111111 success",
  "Program 11111111111111111111111111111111 invoke [1]",
  "Program 11111111111111111111111111111111 success",
  "Program oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv invoke [1]",
  "Program log: Instruction: Deploy",
];

const LOG_2_SQUARES = [
  ...NOISE,
  "Program log: Round #431030: deploying 0.000601562 SOL to 2 squares",
  "Program oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv consumed 26164 of 300000 compute units",
  "Program oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv success",
];

describe("parseDeployedSquareCount", () => {
  it("parses K from a realistic successful-deploy simulation log", () => {
    expect(parseDeployedSquareCount(LOG_2_SQUARES)).toBe(2);
  });

  it("parses the zero-op case K = 0 (every square sniped — log still emitted)", () => {
    expect(
      parseDeployedSquareCount([
        ...NOISE,
        "Program log: Round #431030: deploying 0.000601562 SOL to 0 squares",
        "Program oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv success",
      ]),
    ).toBe(0);
  });

  it("parses whole-SOL amounts without a decimal point", () => {
    expect(parseDeployedSquareCount(["Round #1: deploying 1 SOL to 3 squares"])).toBe(3);
  });

  it("parses sub-lamport-free tiny amounts (9 fractional digits)", () => {
    expect(parseDeployedSquareCount(["Round #999999: deploying 0.000000001 SOL to 25 squares"])).toBe(25);
  });

  it("returns null when no deploy line exists (empty or noise-only logs)", () => {
    expect(parseDeployedSquareCount([])).toBeNull();
    expect(parseDeployedSquareCount(NOISE)).toBeNull();
  });

  it("ignores lookalike lines that are not the deploy summary", () => {
    expect(
      parseDeployedSquareCount([
        "Program log: Instruction: Deploy",
        "Program log: Miner has not checkpointed",
        "Round #abc: deploying x SOL to y squares",
      ]),
    ).toBeNull();
  });
});

describe("verifySimulationDeployCount — zero-op fee guard", () => {
  it("passes when the on-chain count matches the plan", () => {
    expect(() => verifySimulationDeployCount(LOG_2_SQUARES, 2)).not.toThrow();
    const zeroOp = [
      ...NOISE,
      "Program log: Round #431030: deploying 0.000601562 SOL to 0 squares",
    ];
    // A zero-op log only passes when the plan itself is empty — and the
    // planner blocks empty plans before the client is ever reached.
    expect(() => verifySimulationDeployCount(zeroOp, 0)).not.toThrow();
  });

  it("aborts with the snipe message when the counts disagree", () => {
    expect(() => verifySimulationDeployCount(LOG_2_SQUARES, 5)).toThrow(
      /Squares occupied by competing transaction; deploy aborted to save platform fee/,
    );
    expect(() => verifySimulationDeployCount(LOG_2_SQUARES, 5)).toThrow(/planned 5 squares, simulation reached 2/);
  });

  it("aborts on the zero-op case (K = 0 vs a non-empty plan)", () => {
    const logs = [
      ...NOISE,
      "Program log: Round #431030: deploying 0.000601562 SOL to 0 squares",
    ];
    expect(() => verifySimulationDeployCount(logs, 2)).toThrow(
      /Squares occupied by competing transaction/,
    );
  });

  it("aborts when the deploy log is missing entirely (cannot rule out a zero-op)", () => {
    expect(() => verifySimulationDeployCount(NOISE, 2)).toThrow(/deploy log line not found/);
    expect(() => verifySimulationDeployCount([], 2)).toThrow(/deploy log line not found/);
  });

  it("agrees for a single square (singular copy)", () => {
    const logs = ["Program log: Round #431030: deploying 0.001 SOL to 1 squares"];
    expect(() => verifySimulationDeployCount(logs, 1)).not.toThrow();
    expect(() => verifySimulationDeployCount(logs, 2)).toThrow(/planned 2 squares, simulation reached 1/);
  });
});
