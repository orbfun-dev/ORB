/**
 * Health monitor gates: status lifecycle (starting → ok → degraded), the
 * two degradation triggers (error streak, low balance), action/tick
 * bookkeeping, and the HTTP surface (200 ok, 503 degraded, 404 other).
 */

import { expect } from "chai";
import { get } from "node:http";
import { Keypair } from "@solana/web3.js";
import { HealthMonitor } from "../src/health";

const clock = { slot: 123n, unix: 1_700_000_000n, skewSec: 0 };

function monitor(minBalance = 1_000_000_000n): HealthMonitor {
  return new HealthMonitor("0.1.0-test", "KeeperPubkey1111111111111111111111111111111", minBalance, false);
}

async function getJson(port: number, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port, path }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
    }).once("error", reject);
  });
}

describe("health status lifecycle", () => {
  it("starts as `starting` until the first tick completes", () => {
    expect(monitor().snapshot().status).to.equal("starting");
  });

  it("is ok after a successful tick and records clock + balance", () => {
    const m = monitor();
    m.tick(clock, 5n * 1_000_000_000n, null);
    const snap = m.snapshot();
    expect(snap.status).to.equal("ok");
    expect(snap.chainSlot).to.equal("123");
    expect(snap.chainUnix).to.equal("1700000000");
    expect(snap.keeperBalanceLamports).to.equal("5000000000");
    expect(snap.consecutiveErrors).to.equal(0);
    expect(snap.lastTickError).to.equal(null);
  });

  it("degrades on a 3-error streak and recovers on success", () => {
    const m = monitor();
    m.tick(null, null, "boom 1");
    m.tick(null, null, "boom 2");
    expect(m.snapshot().status).to.equal("ok");
    m.tick(null, null, "boom 3");
    const degraded = m.snapshot();
    expect(degraded.status).to.equal("degraded");
    expect(degraded.degradedReasons).to.deep.equal(["3 consecutive tick errors"]);
    m.tick(clock, null, null);
    expect(m.snapshot().status).to.equal("ok");
  });

  it("degrades when the keeper balance drops below the minimum", () => {
    const m = monitor();
    m.tick(clock, 500_000_000n, null);
    const snap = m.snapshot();
    expect(snap.status).to.equal("degraded");
    expect(snap.degradedReasons).to.deep.equal(["keeper balance below minimum"]);
  });

  it("keeps the last known balance when a later tick carries none", () => {
    const m = monitor();
    m.tick(clock, 5_000_000_000n, null);
    m.tick(null, null, "transient");
    expect(m.snapshot().keeperBalanceLamports).to.equal("5000000000");
  });

  it("records actions and tracked rounds", () => {
    const m = monitor();
    m.action("lock_round");
    m.setTrackedRounds([{ roundId: "2", state: "locked" }, { roundId: "1", state: "settled", quarantined: true }]);
    const snap = m.snapshot();
    expect(snap.lastAction).to.equal("lock_round");
    expect(snap.lastActionAt).to.be.a("string");
    expect(snap.trackedRounds).to.deep.equal([
      { roundId: "2", state: "locked" },
      { roundId: "1", state: "settled", quarantined: true },
    ]);
  });
});

describe("healthz HTTP endpoint", () => {
  it("serves 200 + JSON while ok, 503 once degraded, 404 elsewhere", async () => {
    const m = monitor();
    await m.listen("127.0.0.1", 0);
    try {
      const ok = await getJson(m.port, "/healthz");
      expect(ok.status).to.equal(200);
      expect(ok.body.status).to.equal("starting");

      m.tick(clock, 5_000_000_000n, null);
      m.tick(null, null, "e1");
      m.tick(null, null, "e2");
      m.tick(null, null, "e3");
      const degraded = await getJson(m.port, "/healthz");
      expect(degraded.status).to.equal(503);
      expect(degraded.body.status).to.equal("degraded");

      const missing = await getJson(m.port, "/nope");
      expect(missing.status).to.equal(404);
    } finally {
      await m.close();
    }
  });
});

// ── Phase 11.8: cleanup cost metric + stuck-round alert ─────────────────

describe("cleanup metrics and the stuck-round alert (Phase 11.8)", () => {
  function freshMonitor(): HealthMonitor {
    return new HealthMonitor("test", Keypair.generate().publicKey.toBase58(), 1_000_000_000n, false);
  }

  it("books cleanup transactions per round with the fee estimate", () => {
    const health = freshMonitor();
    health.recordCleanupTx(7n, 5_000n);
    health.recordCleanupTx(7n, 5_000n);
    health.recordCleanupTx(8n, 5_000n);
    const snap = health.snapshot();
    expect(snap.cleanupTxsSent).to.equal(3);
    expect(snap.cleanupLamportsSpentEst).to.equal("15000");
    const r7 = snap.cleanupPerRound.find((r) => r.roundId === "7")!;
    expect(r7.txs).to.equal(2);
    expect(r7.lamportsEst).to.equal("10000");
  });

  it("degrades health while settled rounds sit un-pruned, recovers when cleared", () => {
    const health = freshMonitor();
    health.tick(clock, 1_000_000_000n, null); // starting → ok
    expect(health.snapshot().status).to.equal("ok");
    health.setCleanupAlerts(["7", "9"]);
    const degraded = health.snapshot();
    expect(degraded.status).to.equal("degraded");
    expect(degraded.stuckCleanupRounds).to.deep.equal(["7", "9"]);
    expect(degraded.degradedReasons.join(" ")).to.match(/un-pruned/);
    health.setCleanupAlerts([]);
    expect(health.snapshot().status).to.equal("ok");
  });
});
