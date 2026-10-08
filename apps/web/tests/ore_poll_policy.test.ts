/**
 * The shared ORE Lite poll policy (2026-10-07 429-flood incident): 429s
 * are never retried within a cycle, and the refetch interval backs off
 * exponentially per consecutive failure while snapping back to base on
 * success. These are pure functions — no env stubbing needed.
 */

import { describe, expect, it } from "vitest";
import {
  ORE_POLL_BASE_MS,
  ORE_POLL_CAP_MS,
  isRateLimitError,
  orePollInterval,
  oreRetry,
  oreRetryDelay,
} from "../src/features/ore-lite/hooks/pollPolicy";

const query = (status: "success" | "error", fetchFailureCount: number) => ({
  state: { status, fetchFailureCount },
});

describe("isRateLimitError", () => {
  it("matches web3.js 429 messages in their common shapes", () => {
    expect(isRateLimitError(new Error("429 Too Many Requests: {\"error\":\"Too many requests\"}"))).toBe(true);
    expect(isRateLimitError(new Error("HTTP status 429 - rate limited"))).toBe(true);
    expect(isRateLimitError(new Error("Too many requests for this resource"))).toBe(true);
    expect(isRateLimitError("Error: 429 ")).toBe(true);
  });

  it("does not match ordinary failures", () => {
    expect(isRateLimitError(new Error("failed to get info about account"))).toBe(false);
    expect(isRateLimitError(new Error("fetch failed"))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });
});

describe("oreRetry", () => {
  it("never retries a rate limit — backing off is the only answer to a 429", () => {
    expect(oreRetry(0, new Error("429 Too Many Requests"))).toBe(false);
    expect(oreRetry(3, new Error("429 Too Many Requests"))).toBe(false);
  });

  it("allows exactly one retry for genuine failures", () => {
    expect(oreRetry(0, new Error("fetch failed"))).toBe(true);
    expect(oreRetry(1, new Error("fetch failed"))).toBe(false);
  });
});

describe("orePollInterval", () => {
  it("returns the base cadence on success or a pending query", () => {
    expect(orePollInterval()(query("success", 0))).toBe(ORE_POLL_BASE_MS);
  });

  it("doubles per consecutive failure and caps at the ceiling", () => {
    const interval = orePollInterval(5_000);
    expect(interval(query("error", 1))).toBe(10_000);
    expect(interval(query("error", 2))).toBe(20_000);
    expect(interval(query("error", 3))).toBe(40_000);
    expect(interval(query("error", 9))).toBe(ORE_POLL_CAP_MS);
  });

  it("honours a custom base while keeping the shared cap", () => {
    const interval = orePollInterval(10_000);
    expect(interval(query("success", 0))).toBe(10_000);
    expect(interval(query("error", 4))).toBe(ORE_POLL_CAP_MS);
  });

  it("never polls faster than the base, even mid-backoff reset", () => {
    const interval = orePollInterval();
    expect(interval(query("error", 0))).toBeGreaterThanOrEqual(ORE_POLL_BASE_MS);
  });
});

describe("oreRetryDelay", () => {
  it("keeps at least a 3 s gap before the single retry", () => {
    expect(oreRetryDelay()).toBeGreaterThanOrEqual(3_000);
  });
});
