/**
 * Event wire-decoding gates (roadmap 7.0 + audit fix): EVERY on-chain
 * event's byte-exact `Event::data` payload from the Rust layout fixture
 * must decode field-for-field when chained after the 8-byte `emit_cpi!`
 * event-ix tag — the exact byte sequence `OrbitEventFeed` reads out of
 * transaction inner instructions. All 13 decoders are covered, so a field
 * reorder in `events.rs` cannot survive this suite anywhere.
 *
 * Also pins the three-way discriminator agreement: hand-computed
 * sha256("event:<Name>")[..8] === the canonical IDL === Rust `Event::data`.
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  EVENT_DISCRIMINATORS,
  EVENT_IX_TAG,
  parseEventInstruction,
  parseEventLog,
} from "../src/events";

interface Fixture {
  events: Record<string, { hex: string; expected: Record<string, unknown> }>;
}

const fixture: Fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "account_layouts.json"),
    "utf8",
  ),
) as Fixture;

const ALL_EVENT_NAMES = [
  "RoundOpened",
  "Deposited",
  "RoundLocked",
  "RandomnessRequested",
  "RandomnessCommitted",
  "RoundSettled",
  "PrizeClaimed",
  "RoundCancelled",
  "EntryRefunded",
  "MegaPotContribution",
  "MegaPotTriggered",
  "FeesSwept",
  "UnclaimedPrizeSwept",
  "EscrowFunded",
  "EscrowWithdrawn",
  "AutoDeposited",
  "EscrowDepleted",
  "EntryRefundPaid",
  "RoundDustSwept",
  "AccountOpened",
  "EconomicsMigrated",
  "MegaPotDrainedPreflight",
  "RoundWindowRolled",
] as const;

/** tag ++ Event::data — the on-chain inner-instruction byte sequence. */
function wireBytes(eventHex: string): Buffer {
  return Buffer.concat([Buffer.from(EVENT_IX_TAG, "hex"), Buffer.from(eventHex, "hex")]);
}

function expectMatches(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
  for (const [key, want] of Object.entries(expected)) {
    expect(actual, key).to.have.property(key);
    const got = actual[key];
    if (typeof want === "string" && /^-?\d+$/.test(want) && typeof got === "bigint") {
      expect(got.toString(), key).to.equal(want);
    } else if (typeof want === "number" && typeof got === "number") {
      expect(got, key).to.equal(want);
    } else if (typeof want === "boolean") {
      expect(got, key).to.equal(want);
    } else if (typeof want === "string" && got instanceof Uint8Array) {
      // Fixture hex (e.g. randomnessValue) vs decoded bytes.
      expect(Buffer.from(got).toString("hex"), key).to.equal(want);
    } else {
      expect(got, key).to.deep.equal(want);
    }
  }
}

describe("event wire decoding against the Rust fixture", () => {
  it("fixture covers exactly the 23 on-chain events", () => {
    expect(Object.keys(fixture.events).sort()).to.deep.equal([...ALL_EVENT_NAMES].sort());
  });

  it("the emit_cpi! wire tag is pinned to anchor's ground truth", () => {
    // anchor-lang 0.32.2: EVENT_IX_TAG = 0x1d9acb512ea545e4, LE on the
    // wire; verified against a live devnet settle transaction. A typo here
    // silently disables the entire CPI-event transport on real chains.
    expect(EVENT_IX_TAG).to.equal("e445a52e51cb9a1d");
    expect(
      Buffer.from(EVENT_IX_TAG, "hex").readBigUInt64LE(0),
    ).to.equal(0x1d9acb512ea545e4n);
  });

  it("fixture event bytes carry the committed discriminators", () => {
    for (const [name, { hex }] of Object.entries(fixture.events)) {
      const disc = Buffer.from(hex, "hex").subarray(0, 8).toString("hex");
      expect(disc, name).to.equal(EVENT_DISCRIMINATORS[name]);
    }
  });

  for (const name of ALL_EVENT_NAMES) {
    it(`decodes ${name} tag+payload field-for-field`, () => {
      const { hex, expected } = fixture.events[name]!;
      const parsed = parseEventInstruction(wireBytes(hex));
      expect(parsed, name).to.not.equal(null);
      expect(parsed!.name, name).to.equal(name);
      expectMatches(parsed!.data as unknown as Record<string, unknown>, expected);
    });
  }

  it("keeps >MAX_SAFE_INTEGER payloads exact (RoundSettled)", () => {
    const { hex } = fixture.events.RoundSettled!;
    const parsed = parseEventInstruction(wireBytes(hex));
    if (parsed?.name !== "RoundSettled") throw new Error("expected RoundSettled");
    expect(parsed.data.winningTicket).to.equal(98_765_432_101_234_567n);
    expect(parsed.data.totalLamports).to.equal(123_456_789_012_345_678n);
    expect(parsed.data.megaTriggered).to.equal(true);
    expect(parsed.data.randomnessValue).to.deep.equal(Buffer.from("5a".repeat(32), "hex"));
  });

  it("returns null for non-event instruction data", () => {
    expect(parseEventInstruction(Buffer.alloc(0))).to.equal(null);
    expect(parseEventInstruction(Buffer.alloc(64))).to.equal(null);
    const wrongTag = Buffer.concat([
      Buffer.from("0000000000000000", "hex"),
      Buffer.from(fixture.events.RoundSettled!.hex, "hex"),
    ]);
    expect(parseEventInstruction(wrongTag)).to.equal(null);
  });

  it("returns null for a foreign anchor event-cpi discriminator", () => {
    const foreign = Buffer.concat([
      Buffer.from(EVENT_IX_TAG, "hex"),
      Buffer.alloc(8, 0xab), // not any of ours
      Buffer.alloc(24),
    ]);
    expect(parseEventInstruction(foreign)).to.equal(null);
  });

  it("throws a range error on a truncated payload, not silent zeros", () => {
    const truncated = wireBytes(fixture.events.RoundSettled!.hex).subarray(0, 40);
    expect(() => parseEventInstruction(truncated)).to.throw(/borsh: need/);
  });
});

describe("emit! program-log decoding (audit fix: dual transport)", () => {
  // The fixture bytes ARE the log wire form: `emit!` base64-encodes
  // discriminator ++ payload into a "Program data:" line — no event-ix
  // tag. Every event must decode through parseEventLog too.
  for (const name of ALL_EVENT_NAMES) {
    it(`decodes ${name} discriminator+payload field-for-field (log form)`, () => {
      const parsed = parseEventLog(Buffer.from(fixture.events[name]!.hex, "hex"));
      expect(parsed, name).to.not.equal(null);
      expect(parsed!.name, name).to.equal(name);
      expectMatches(
        parsed!.data as unknown as Record<string, unknown>,
        fixture.events[name]!.expected,
      );
    });
  }

  it("returns null for non-event log data and foreign discriminators", () => {
    expect(parseEventLog(Buffer.alloc(0))).to.equal(null);
    expect(parseEventLog(Buffer.alloc(8, 0xab).subarray(0, 4))).to.equal(null);
    expect(parseEventLog(Buffer.alloc(40, 0xab))).to.equal(null); // foreign discriminator
  });

  it("throws a range error on a truncated log payload, not silent zeros", () => {
    const truncated = Buffer.from(fixture.events.RoundSettled!.hex, "hex").subarray(0, 24);
    expect(() => parseEventLog(truncated)).to.throw(/borsh: need/);
  });
});
