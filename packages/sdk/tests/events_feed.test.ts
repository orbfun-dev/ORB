/**
 * Transport gates (audit CRITICAL fix): `OrbitEventFeed` delivery
 * semantics, exercised against a scripted fake Connection — no network.
 *
 * Locks the guarantees the wheel depends on:
 * - every event in a transaction reaches its listeners, siblings intact;
 * - one signature delivers at most once (seen-ring + in-flight coalescing);
 * - a signature is marked seen only after a successful fetch — an
 *   exhausted fetch surfaces via onError and stays retryable;
 * - `meta === null` is retryable, not terminal;
 * - a malformed payload or a throwing consumer callback is reported via
 *   onError and never aborts sibling delivery;
 * - the feed never rejects.
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import bs58 from "bs58";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  EVENT_IX_TAG,
  OrbitEventFeed,
  OrbitEventErrorContext,
  parseEventInstruction,
  parseEventLog,
} from "../src/events";

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "account_layouts.json"), "utf8"),
) as { events: Record<string, { hex: string }> };

const PROGRAM = new PublicKey("G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R");

/** tag ++ fixture bytes — exactly what an inner instruction carries. */
function wireInstruction(eventName: string): { programId: string; data: string } {
  return {
    programId: PROGRAM.toString(),
    data: bs58.encode(
      Buffer.concat([
        Buffer.from(EVENT_IX_TAG, "hex"),
        Buffer.from(fixture.events[eventName]!.hex, "hex"),
      ]),
    ),
  };
}

type LogsHandler = (logs: { err: unknown; signature: string }, ctx: { slot: number }) => void;

/** Programmed per-signature script of getTransaction outcomes. */
class FakeConnection {
  readonly logsHandlers: LogsHandler[] = [];
  readonly getCalls: string[] = [];
  /** signature → queue of outcomes; last entry repeats when exhausted. */
  script = new Map<string, Array<unknown>>();

  onLogs(_programId: PublicKey, cb: LogsHandler): number {
    this.logsHandlers.push(cb);
    return this.logsHandlers.length;
  }

  async removeOnLogsListener(): Promise<void> {}

  async getTransaction(signature: string): Promise<unknown> {
    this.getCalls.push(signature);
    const queue = this.script.get(signature);
    if (queue === undefined) return null;
    return queue.length > 1 ? queue.shift() : queue[0];
  }

  /** Simulates an onLogs notification for one signature. */
  notify(signature: string, slot = 42): void {
    for (const handler of this.logsHandlers) {
      handler({ err: null, signature }, { slot });
    }
  }

  tx(...instructions: Array<{ programId: string; data: string }>): unknown {
    return { meta: { innerInstructions: [{ index: 0, instructions }] } };
  }

  /**
   * The RAW inner-instruction shape public RPCs (e.g. api.devnet.solana.com)
   * return: `programIdIndex` into the message account keys instead of a
   * `programId` string. Verified against a live devnet settle tx.
   */
  txRaw(eventName: string): unknown {
    return {
      transaction: { message: rawMessage() },
      meta: { innerInstructions: [{ index: 0, instructions: [rawInstruction(eventName)] }] },
    };
  }

  /** A tx whose events ride `emit!` program-log lines (no inner CPIs). */
  txLogs(...eventNames: string[]): unknown {
    return {
      meta: {
        innerInstructions: [],
        logMessages: [
          "Program G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R invoke [1]",
          ...eventNames.map(
            (name) =>
              `Program data: ${Buffer.from(fixture.events[name]!.hex, "hex").toString("base64")}`,
          ),
          "Program G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R success",
        ],
      },
    };
  }
}

function parsed(eventName: string) {
  return parseEventInstruction(
    Buffer.concat([
      Buffer.from(EVENT_IX_TAG, "hex"),
      Buffer.from(fixture.events[eventName]!.hex, "hex"),
    ]),
  );
}

/** Raw-shape inner instruction: index 0 is our program in the keys below. */
function rawInstruction(eventName: string): Record<string, unknown> {
  return {
    accounts: [8],
    programIdIndex: 0,
    stackHeight: 2,
    data: bs58.encode(
      Buffer.concat([
        Buffer.from(EVENT_IX_TAG, "hex"),
        Buffer.from(fixture.events[eventName]!.hex, "hex"),
      ]),
    ),
  };
}

/** Legacy message keys exactly as the raw shape references them. */
function rawMessage(): { accountKeys: string[] } {
  return { accountKeys: [PROGRAM.toString(), "11111111111111111111111111111111"] };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeFeed(
  fake: FakeConnection,
  onError?: (error: Error, context: OrbitEventErrorContext) => void,
): OrbitEventFeed {
  return new OrbitEventFeed(fake as unknown as Connection, PROGRAM, {
    onError,
    retryMs: 1,
  });
}

describe("OrbitEventFeed transport semantics", () => {
  it("delivers every event in a transaction to matching listeners", async () => {
    const fake = new FakeConnection();
    fake.script.set("sig-multi", [fake.tx(wireInstruction("RoundSettled"), wireInstruction("MegaPotTriggered"))]);
    const feed = makeFeed(fake);

    const settled: number[] = [];
    const triggered: number[] = [];
    await feed.on("RoundSettled", ({ event, slot, signature }) => {
      settled.push(slot);
      expect(signature).to.equal("sig-multi");
      expect(event.data).to.deep.equal(parsed("RoundSettled")!.data);
    });
    await feed.on("MegaPotTriggered", ({ slot }) => triggered.push(slot));

    fake.notify("sig-multi", 777);
    await sleep(30);

    expect(settled).to.deep.equal([777]);
    expect(triggered).to.deep.equal([777]);
  });

  it("delivers a signature at most once (seen-ring + in-flight coalescing)", async () => {
    const fake = new FakeConnection();
    fake.script.set("sig-once", [fake.tx(wireInstruction("Deposited"))]);
    const feed = makeFeed(fake);

    let deliveries = 0;
    await feed.on("Deposited", () => {
      deliveries += 1;
    });

    fake.notify("sig-once");
    fake.notify("sig-once"); // replayed notification while fetch pending
    await sleep(30);
    fake.notify("sig-once"); // replay after delivery
    await sleep(30);

    expect(deliveries).to.equal(1);
    expect(fake.getCalls.filter((s) => s === "sig-once").length).to.equal(1);
  });

  it("retries while the transaction is unfetchable or has null meta", async () => {
    const fake = new FakeConnection();
    const tx = fake.tx(wireInstruction("Deposited"));
    fake.script.set("sig-slow", [null, { meta: null }, tx]);
    const feed = makeFeed(fake);

    let deliveries = 0;
    await feed.on("Deposited", () => {
      deliveries += 1;
    });

    fake.notify("sig-slow");
    await sleep(80);

    expect(deliveries).to.equal(1);
    expect(fake.getCalls.length).to.equal(3);
  });

  it("surfaces fetch exhaustion via onError and keeps the signature retryable", async () => {
    const fake = new FakeConnection();
    fake.script.set("sig-drop", [null]); // never available
    const errors: OrbitEventErrorContext[] = [];
    const feed = makeFeed(fake, (_err, ctx) => errors.push(ctx));

    let deliveries = 0;
    await feed.on("Deposited", () => {
      deliveries += 1;
    });

    fake.notify("sig-drop");
    await sleep(50);
    expect(deliveries).to.equal(0);
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]!.signature).to.equal("sig-drop");

    // The exhausted signature was NOT marked seen — a re-drive delivers.
    fake.script.set("sig-drop", [fake.tx(wireInstruction("Deposited"))]);
    fake.notify("sig-drop");
    await sleep(30);
    expect(deliveries).to.equal(1);
  });

  it("continues past a malformed sibling instruction", async () => {
    const fake = new FakeConnection();
    // Known discriminator (RoundSettled) with a truncated body, followed by
    // a well-formed MegaPotTriggered — the settle transaction's shape.
    const truncated = Buffer.concat([
      Buffer.from(EVENT_IX_TAG, "hex"),
      Buffer.from(fixture.events.RoundSettled!.hex, "hex").subarray(0, 16 + 4),
    ]);
    fake.script.set("sig-sib", [
      fake.tx(
        { programId: PROGRAM.toString(), data: bs58.encode(truncated) },
        wireInstruction("MegaPotTriggered"),
      ),
    ]);
    const errors: string[] = [];
    const feed = makeFeed(fake, (err) => errors.push(err.message));

    let triggered = 0;
    let settled = 0;
    await feed.on("RoundSettled", () => {
      settled += 1;
    });
    await feed.on("MegaPotTriggered", () => {
      triggered += 1;
    });

    fake.notify("sig-sib");
    await sleep(30);

    expect(settled).to.equal(0); // the malformed one could not decode
    expect(triggered).to.equal(1); // …but its sibling still delivered
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/borsh: need/);
  });

  it("reports a throwing consumer callback without breaking the feed", async () => {
    const fake = new FakeConnection();
    fake.script.set("sig-throw", [fake.tx(wireInstruction("PrizeClaimed"))]);
    const errors: string[] = [];
    const feed = makeFeed(fake, (err) => errors.push(err.message));

    let second = 0;
    await feed.on("PrizeClaimed", () => {
      throw new Error("consumer bug");
    });
    await feed.on("PrizeClaimed", () => {
      second += 1;
    });

    fake.notify("sig-throw");
    await sleep(30);

    expect(second).to.equal(1); // sibling listener unaffected
    expect(errors).to.have.lengthOf(1);
    expect(errors[0]).to.match(/consumer bug/);
  });

  it("ignores inner instructions from other programs", async () => {
    const fake = new FakeConnection();
    fake.script.set("sig-foreign", [
      fake.tx(
        { programId: PublicKey.default.toString(), data: bs58.encode(Buffer.alloc(32)) },
        wireInstruction("RoundLocked"),
      ),
    ]);
    const errors: string[] = [];
    const feed = makeFeed(fake, (err) => errors.push(err.message));

    let locked = 0;
    await feed.on("RoundLocked", () => {
      locked += 1;
    });

    fake.notify("sig-foreign");
    await sleep(30);

    expect(locked).to.equal(1);
    expect(errors).to.have.lengthOf(0);
  });
});

describe("OrbitEventFeed dual transport (audit fix: emit! logs + emit_cpi! inner ixs)", () => {
  it("delivers emit! events from Program data: log lines", async () => {
    const fake = new FakeConnection();
    // RoundOpened/Deposited/RoundLocked ride program logs on-chain.
    fake.script.set("sig-logs", [fake.txLogs("RoundOpened", "Deposited")]);
    const feed = makeFeed(fake);

    const opened: number[] = [];
    const deposits: number[] = [];
    await feed.on("RoundOpened", ({ event }) => {
      opened.push(1);
      expect(event.data).to.deep.equal(parsed("RoundOpened")!.data);
    });
    await feed.on("Deposited", ({ event }) => {
      deposits.push(1);
      expect(event.data).to.deep.equal(parsed("Deposited")!.data);
    });

    fake.notify("sig-logs", 555);
    await sleep(30);

    expect(opened).to.deep.equal([1]);
    expect(deposits).to.deep.equal([1]);
  });

  it("delivers BOTH transports from one mixed transaction, at most once", async () => {
    const fake = new FakeConnection();
    // A deposit tx (emit!) settling nothing, plus the settle CPI pair —
    // both forms coexist in the same transaction's metadata.
    const mixed = fake.tx(
      wireInstruction("RoundSettled"),
      wireInstruction("MegaPotTriggered"),
    ) as { meta: { logMessages: string[] } };
    mixed.meta.logMessages = [
      `Program data: ${Buffer.from(fixture.events.Deposited!.hex, "hex").toString("base64")}`,
    ];
    fake.script.set("sig-mixed", [mixed]);
    const feed = makeFeed(fake);

    const seen: string[] = [];
    await feed.on("Deposited", () => seen.push("Deposited"));
    await feed.on("RoundSettled", () => seen.push("RoundSettled"));
    await feed.on("MegaPotTriggered", () => seen.push("MegaPotTriggered"));

    fake.notify("sig-mixed");
    await sleep(30);

    expect(seen.sort()).to.deep.equal(["Deposited", "MegaPotTriggered", "RoundSettled"]);
  });

  it("delivers raw-shape inner instructions (programIdIndex) from public RPCs", async () => {
    const fake = new FakeConnection();
    fake.script.set("sig-raw", [fake.txRaw("RoundSettled")]);
    const feed = makeFeed(fake);

    const seen: string[] = [];
    await feed.on("RoundSettled", ({ event }) => seen.push(event.name));

    fake.notify("sig-raw");
    await sleep(30);

    expect(seen).to.deep.equal(["RoundSettled"]);
  });

  it("skips foreign anchor programs' Program data: lines (discriminator filter)", async () => {
    const fake = new FakeConnection();
    fake.script.set("sig-foreign-log", [
      {
        meta: {
          innerInstructions: [],
          logMessages: [
            // A real foreign anchor event (8-byte discriminator not ours)
            `Program data: ${Buffer.concat([Buffer.alloc(8, 0xab), Buffer.alloc(24)]).toString("base64")}`,
            "Program log: ordinary text line",
          ],
        },
      },
    ]);
    const errors: string[] = [];
    const feed = makeFeed(fake, (err) => errors.push(err.message));

    let deliveries = 0;
    await feed.on("RoundOpened", () => {
      deliveries += 1;
    });

    fake.notify("sig-foreign-log");
    await sleep(30);

    expect(deliveries).to.equal(0);
    expect(errors).to.have.lengthOf(0); // skipped, not an error
  });

  it("round-trips every fixture event through the log wire form", () => {
    for (const name of Object.keys(fixture.events)) {
      const bytes = Buffer.from(fixture.events[name]!.hex, "hex");
      const viaCpi = parseEventInstruction(
        Buffer.concat([Buffer.from(EVENT_IX_TAG, "hex"), bytes]),
      );
      const viaLog = parseEventLog(bytes);
      expect(viaLog, name).to.not.equal(null);
      expect(viaLog, name).to.deep.equal(viaCpi); // same event, both wires
    }
  });
});
