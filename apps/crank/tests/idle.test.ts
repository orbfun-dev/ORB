/**
 * Phase 12 idle-behaviour gates: the poll backoff ladder (grows while
 * idle, resets on any wake, never exceeds the ceiling) and the health
 * surface (an idle keeper is HEALTHY — `idle: true` explains the quiet,
 * never a degradedReason).
 */

import { expect } from "chai";
import { HealthMonitor } from "../src/health";
import { IdleBackoff } from "../src/supervisor";

describe("idle poll backoff ladder", () => {
  it("doubles each quiet tick toward the ceiling", () => {
    const ladder = new IdleBackoff(10_000, 120_000);
    expect(ladder.current()).to.equal(10_000);
    expect(ladder.bump()).to.equal(20_000);
    expect(ladder.bump()).to.equal(40_000);
    expect(ladder.bump()).to.equal(80_000);
    expect(ladder.bump()).to.equal(120_000);
  });

  it("never exceeds the ceiling, however long the quiet lasts", () => {
    const ladder = new IdleBackoff(10_000, 30_000);
    for (let i = 0; i < 50; i += 1) ladder.bump();
    expect(ladder.current()).to.equal(30_000);
  });

  it("resets to the active floor the instant the world moves", () => {
    const ladder = new IdleBackoff(10_000, 120_000);
    ladder.bump();
    ladder.bump();
    expect(ladder.current()).to.equal(40_000);
    expect(ladder.reset()).to.equal(10_000);
    // And can climb again after the reset.
    expect(ladder.bump()).to.equal(20_000);
  });

  it("tolerates a ceiling below the floor by clamping at the ceiling", () => {
    const ladder = new IdleBackoff(10_000, 5_000);
    expect(ladder.bump()).to.equal(5_000);
  });
});

describe("idle health surface", () => {
  const clock = { slot: 123n, unix: 1_700_000_000n, skewSec: 0 };

  it("an idle keeper is healthy — the flag explains, never degrades", () => {
    const m = new HealthMonitor(
      "0.1.0-test",
      "KeeperPubkey1111111111111111111111111111111",
      1_000_000_000n,
      false,
    );
    m.tick(clock, 5_000_000_000n, null);
    m.setIdle(true);
    const snap = m.snapshot();
    expect(snap.status).to.equal("ok");
    expect(snap.idle).to.equal(true);
    expect(snap.degradedReasons).to.deep.equal([]);
    m.setIdle(false);
    expect(m.snapshot().idle).to.equal(false);
  });

  it("idle defaults to false before the first tick sets it", () => {
    const m = new HealthMonitor(
      "0.1.0-test",
      "KeeperPubkey1111111111111111111111111111111",
      1_000_000_000n,
      false,
    );
    expect(m.snapshot().idle).to.equal(false);
  });
});
