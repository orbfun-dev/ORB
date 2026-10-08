/**
 * RPC gateway gates: exponential backoff rides out 429s and transient
 * transport faults, business errors rethrow immediately, and the pace
 * gate enforces a minimum gap between call starts.
 */

import { expect } from "chai";
import { Connection } from "@solana/web3.js";
import { createLogger } from "../src/log";
import { RpcGateway } from "../src/rpc";

const silentLogger = createLogger("silent");
const conn = null as unknown as Connection;

function gateway(opts?: { paceMs?: number }): RpcGateway {
  return new RpcGateway(conn, silentLogger, {
    paceMs: opts?.paceMs ?? 0,
    maxBackoffMs: 8,
    maxAttempts: 6,
    baseBackoffMs: 1,
  });
}

describe("rpc backoff", () => {
  it("retries through 429s and transient network errors, then succeeds", async () => {
    const gw = gateway();
    let attempts = 0;
    const result = await gw.call("probe", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("429 Too Many Requests");
      if (attempts === 2) throw new Error("fetch failed: ECONNRESET");
      return "ok";
    });
    expect(result).to.equal("ok");
    expect(attempts).to.equal(3);
  });

  it("rethrows non-retryable business errors immediately", async () => {
    const gw = gateway();
    let attempts = 0;
    let caught: unknown;
    try {
      await gw.call("send", async () => {
        attempts += 1;
        throw new Error("failed to get recent blockhash");
      });
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).to.match(/recent blockhash/);
    expect(attempts).to.equal(1);
  });

  it("gives up after maxAttempts with a labeled error", async () => {
    const gw = gateway();
    let attempts = 0;
    let caught: unknown;
    try {
      await gw.call("getBalance", async () => {
        attempts += 1;
        throw new Error("429");
      });
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).to.match(/getBalance failed after 6 attempts/);
    expect(attempts).to.equal(6);
  });
});

describe("rpc pacing", () => {
  it("spreads call starts at least paceMs apart", async () => {
    const paceMs = 60;
    const gw = gateway({ paceMs });
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        gw.call(`op${i}`, async () => {
          starts.push(Date.now());
          return i;
        }),
      ),
    );
    starts.sort((a, b) => a - b);
    // Three serialized starts: two gaps, each at least paceMs (small
    // timer slop tolerated).
    expect(starts[1]! - starts[0]!).to.be.at.least(paceMs - 5);
    expect(starts[2]! - starts[1]!).to.be.at.least(paceMs - 5);
  });
});
