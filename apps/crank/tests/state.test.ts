/**
 * State-store gates: randomness keypairs persist before first use,
 * quarantine + failure streaks survive, the audit log appends, and paths
 * stay inside the state directory.
 */

import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log";
import { StateStore } from "../src/state";

function tmpStore(): { store: StateStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "crank-state-"));
  return { store: new StateStore(dir, createLogger("silent")), dir };
}

describe("state store", () => {
  it("persists per-round randomness keypairs and reloads them identically", () => {
    const { store, dir } = tmpStore();
    const first = store.randomnessKeypair(7n);
    const again = store.randomnessKeypair(7n);
    expect(again.secretKey).to.deep.equal(first.secretKey);
    // A fresh store over the same dir sees the same keypair.
    const reopened = new StateStore(dir, createLogger("silent"));
    expect(reopened.randomnessKeypair(7n).publicKey.toString()).to.equal(first.publicKey.toString());
    // Written before first use, mode 0600.
    const file = join(dir, "keys", "randomness-7.json");
    expect(existsSync(file)).to.equal(true);
    expect(readFileSync(file).toString()).to.equal(JSON.stringify(Array.from(first.secretKey)));
  });

  it("remembers pending lookup tables across restarts, and forgets them on request", () => {
    const { store, dir } = tmpStore();
    store.rememberLut(12n, "Rand12", 900n);
    store.rememberLut(3n, "Rand3", 5n);
    store.rememberLut(12n, "Rand12", 900n); // idempotent
    const reopened = new StateStore(dir, createLogger("silent"));
    expect(reopened.pendingLuts()).to.deep.equal([
      { roundId: 3n, randomness: "Rand3", lutSlot: 5n },
      { roundId: 12n, randomness: "Rand12", lutSlot: 900n },
    ]);
    reopened.forgetLut(3n);
    expect(new StateStore(dir, createLogger("silent")).pendingLuts().map((p) => p.roundId)).to.deep.equal([12n]);
  });

  it("starts each store from its own empty state", () => {
    const a = tmpStore().store;
    a.quarantine(1n, "x");
    expect(tmpStore().store.isQuarantined(1n)).to.equal(null);
  });

  it("quarantines once, persists across restarts, and reports the reason", () => {
    const { store, dir } = tmpStore();
    store.quarantine(3n, "commit stale");
    store.quarantine(3n, "ignored — first reason wins");
    expect(store.isQuarantined(3n)).to.equal("commit stale");
    expect(store.isQuarantined(4n)).to.equal(null);
    const reopened = new StateStore(dir, createLogger("silent"));
    expect(reopened.isQuarantined(3n)).to.equal("commit stale");
  });

  it("tracks failure streaks and resets them", () => {
    const { store } = tmpStore();
    expect(store.recordFailure("lock_round:2")).to.equal(1);
    expect(store.recordFailure("lock_round:2")).to.equal(2);
    store.resetFailures("lock_round:2");
    expect(store.recordFailure("lock_round:2")).to.equal(1);
  });

  it("appends an audit line per action", () => {
    const { store, dir } = tmpStore();
    store.recordAction({ kind: "lock_round", roundId: "2", sig: "sig1" });
    store.recordAction({ kind: "sweep_unclaimed_prize", roundId: "1", dryRun: true });
    const lines = readFileSync(join(dir, "actions.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).to.equal(2);
    expect(JSON.parse(lines[0]!).kind).to.equal("lock_round");
    expect(JSON.parse(lines[1]!).dryRun).to.equal(true);
  });

  it("keeps the state dir free of stray files", () => {
    const { store, dir } = tmpStore();
    store.randomnessKeypair(1n);
    store.quarantine(1n, "x");
    store.recordAction({ kind: "open_round" });
    const entries = readdirSync(dir).sort();
    expect(entries).to.deep.equal(["actions.jsonl", "keys", "state.json"]);
  });
});
