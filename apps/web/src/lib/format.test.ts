import { describe, expect, it } from "vitest";
import {
  basisPointsPercent,
  formatLamports,
  formatSolCompact,
  formatSolReward,
  LAMPORTS_PER_SOL,
  parseSolToLamports,
  shortAddress,
} from "./format";

describe("parseSolToLamports (string → bigint, never Number)", () => {
  it("parses exact decimals", () => {
    expect(parseSolToLamports("0.1")).toBe(100_000_000n);
    expect(parseSolToLamports("1.5")).toBe(1_500_000_000n);
    expect(parseSolToLamports("1")).toBe(LAMPORTS_PER_SOL);
    expect(parseSolToLamports("0.000000001")).toBe(1n); // the lamport floor
  });

  it("round-trips above MAX_SAFE_INTEGER without precision loss", () => {
    const lamports = 123_456_789_012_345_678n;
    const parsed = parseSolToLamports("123456789.012345678");
    expect(parsed).toBe(lamports);
  });

  it("rejects malformed input with null", () => {
    for (const bad of [
      "", " 1", "1 ", "-1", "+1", "1,5", "0x10", "1e9",
      ".5", "1.", "0.0000000001", "١٢٣", "12.34.56",
    ]) {
      expect(parseSolToLamports(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("formatLamports (integer math both ways)", () => {
  it("formats with fixed decimals", () => {
    expect(formatLamports(1_234_567_890n)).toBe("1.2345");
    expect(formatLamports(1n)).toBe("0.0000");
    expect(formatLamports(0n)).toBe("0.0000");
    expect(formatLamports(1_500_000_000n, 3)).toBe("1.500");
    expect(formatLamports(9n, 9)).toBe("0.000000009");
  });

  it("handles the mega-pot scale without float drift", () => {
    expect(formatLamports(123_456_789_012_345_678n, 6)).toBe(
      "123456789.012345",
    );
  });

  it("compacts trailing zeros", () => {
    expect(formatSolCompact(1_500_000_000n)).toBe("1.5");
    expect(formatSolCompact(500_000_000n)).toBe("0.5");
    expect(formatSolCompact(0n)).toBe("0");
  });
});

describe("basisPointsPercent", () => {
  it("computes two-decimal shares in integer bps", () => {
    expect(basisPointsPercent(1n, 4n)).toBe("25.00");
    expect(basisPointsPercent(1n, 3n)).toBe("33.33");
    expect(basisPointsPercent(2n, 3n)).toBe("66.66");
    expect(basisPointsPercent(0n, 5n)).toBe("0.00");
    expect(basisPointsPercent(5n, 5n)).toBe("100.00");
  });

  it("returns 0.00 for an empty pot rather than dividing by zero", () => {
    expect(basisPointsPercent(1n, 0n)).toBe("0.00");
  });
});

describe("shortAddress", () => {
  it("elides the middle", () => {
    const addr = "G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R";
    expect(shortAddress(addr)).toBe("G5yN…C48R");
    expect(shortAddress("short")).toBe("short");
  });
});

describe("formatSolReward — the rewards card figure", () => {
  it("shows up to four decimals, never fewer than two", () => {
    expect(formatSolReward(89_100_000n)).toBe("0.0891");
    expect(formatSolReward(89_000_000n)).toBe("0.089");
    expect(formatSolReward(80_000_000n)).toBe("0.08");
    expect(formatSolReward(1_500_000_000n)).toBe("1.50");
    expect(formatSolReward(2_000_000_000n)).toBe("2.00");
    expect(formatSolReward(0n)).toBe("0.00");
  });

  it("truncates, and widens rather than show a non-zero amount as zero", () => {
    expect(formatSolReward(89_199_999n)).toBe("0.0891");
    expect(formatSolReward(20_000n)).toBe("0.00002");
  });
});

describe("formatSolCompact — small non-zero amounts (live 2026-10-07 card bug)", () => {
  it("never renders a non-zero amount as 0", () => {
    // Entry rent, keeper tip and the escrow floor all round to nothing at
    // two decimals; the auto-play card showed "+ 0 entry rent ... 0 SOL
    // account rent" because of it.
    expect(formatSolCompact(1_203_960n)).toBe("0.0012");
    expect(formatSolCompact(200_000n)).toBe("0.0002");
    // Truncating, never rounding — the house rule (0.00127 → 0.0012).
    expect(formatSolCompact(1_270_000n)).toBe("0.0012");
    expect(formatSolCompact(1n)).toBe("0.000000001");
  });

  it("keeps the two-decimal house style for ordinary amounts", () => {
    expect(formatSolCompact(1_500_000_000n)).toBe("1.5");
    expect(formatSolCompact(10_000_000n)).toBe("0.01");
    expect(formatSolCompact(0n)).toBe("0");
  });
});
