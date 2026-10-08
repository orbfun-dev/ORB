/**
 * Countdown gates (roadmap 7.2): pure computation only — remaining time,
 * MM:SS formatting, urgency/expiry flags, and the chain-clock offset
 * measure + sanity clamp. No React, no timers.
 */

import { describe, expect, it } from "vitest";
import {
  clampOffsetMs,
  computeChainOffsetMs,
  computeCountdown,
} from "../src/hooks/useCountdown";

describe("computeCountdown", () => {
  const end = 1_700_000_100n; // chain seconds

  it("formats MM:SS and rounds up to whole seconds", () => {
    const view = computeCountdown(1_700_000_000 * 1000, end, 30);
    expect(view.totalSeconds).toBe(100);
    expect(view.display).toBe("01:40");
    expect(view.isUrgent).toBe(false);
    expect(view.isExpired).toBe(false);
  });

  it("pads minutes and seconds", () => {
    expect(computeCountdown(0, 5n * 60n + 7n, 30).display).toBe("05:07");
    expect(computeCountdown(0, 7n, 30).display).toBe("00:07");
    expect(computeCountdown(0, 0n, 30).display).toBe("00:00");
  });

  it("lets minutes grow past 99 without breaking the format", () => {
    expect(computeCountdown(0, 120n * 60n, 30).display).toBe("120:00");
  });

  it("ceil: 1000 ms remaining is one second, 1 ms remaining is one second", () => {
    const at = 1_700_000_100_000;
    expect(computeCountdown(at - 1_000, end, 30).totalSeconds).toBe(1);
    expect(computeCountdown(at - 1, end, 30).totalSeconds).toBe(1);
    expect(computeCountdown(at, end, 30).totalSeconds).toBe(0);
  });

  it("clamps at zero and flags expiry; urgency only while time remains", () => {
    const expired = computeCountdown(1_700_000_200 * 1000, end, 30);
    expect(expired.remainingMs).toBe(0);
    expect(expired.isExpired).toBe(true);
    expect(expired.isUrgent).toBe(false);

    const urgent = computeCountdown(1_700_000_100_000 - 10_000, end, 30);
    expect(urgent.isUrgent).toBe(true);
    expect(urgent.isExpired).toBe(false);

    const calm = computeCountdown(1_700_000_100_000 - 31_000, end, 30);
    expect(calm.isUrgent).toBe(false);
  });
});

describe("chain clock offset", () => {
  it("measures blockTime − localTime in milliseconds", () => {
    const blockTimeSec = 1_700_000_100;
    const localMs = 1_700_000_000_000;
    expect(computeChainOffsetMs(blockTimeSec, localMs)).toBe(100_000);
    expect(computeChainOffsetMs(blockTimeSec, 1_700_000_150_000)).toBe(-50_000);
  });

  it("clamps pathological skew to ±5 minutes", () => {
    expect(clampOffsetMs(10 * 60 * 1000)).toBe(5 * 60 * 1000);
    expect(clampOffsetMs(-10 * 60 * 1000)).toBe(-5 * 60 * 1000);
    expect(clampOffsetMs(1_234)).toBe(1_234);
    expect(clampOffsetMs(0)).toBe(0);
  });
});
