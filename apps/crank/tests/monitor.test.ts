/**
 * Monitor gates: reconcile builds the tracked set from chain (gaps
 * tolerated — closed rounds vanish), refresh drops rounds that closed
 * under our feet, and randomness views follow the pipeline states.
 *
 * Account bytes come from the SDK's committed Rust-generated layout
 * fixture, patched at the offset-verified fields, so the monitor's decode
 * path is exercised against authentic wire bytes.
 */

import { expect } from "chai";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  configKey,
  decodeGlobalConfig,
  decodeRound,
  roundKey,
  type GlobalConfigData,
  type RoundData,
} from "@orbit-jackpot/sdk";
import { RoundMonitor } from "../src/monitor";
import type { ChainReader } from "../src/reader";
import type { RandomnessView } from "../src/randomness";
import fixture from "../../../packages/sdk/tests/fixtures/account_layouts.json";

const CONFIG_HEX: string = fixture.accounts.GlobalConfig.hex;
const ROUND_HEX: string = fixture.accounts.Round.hex;

// Offset-verified write helpers (layouts pinned by the SDK decoder suite).
function writeU64(buf: Buffer, offset: number, value: bigint): void {
  buf.writeBigUInt64LE(value, offset);
}
function writeU8(buf: Buffer, offset: number, value: number): void {
  buf.writeUInt8(value, offset);
}
function writeKey(buf: Buffer, offset: number, key: PublicKey | null): void {
  const bytes = key === null ? Buffer.alloc(32) : key.toBuffer();
  bytes.copy(buf, offset);
}

// Round field offsets (accounts.ts: disc 8 · roundId 8 · state 1 · …).
const R = {
  roundId: 8,
  state: 16,
  randomnessAccount: 106,
} as const;
// Config field offsets (sequential decode order; trailing 64 B reserved).
const C = { activeRoundId: 257, nextRoundId: 265 } as const;

const STATE_INDEX: Record<string, number> = {
  open: 0,
  locked: 1,
  awaitingRandomness: 2,
  settled: 3,
  cancelled: 4,
};

function configBuffer(active: bigint, next: bigint): Buffer {
  const buf = Buffer.from(CONFIG_HEX, "hex");
  writeU64(buf, C.activeRoundId, active);
  writeU64(buf, C.nextRoundId, next);
  return buf;
}

function roundBuffer(id: bigint, state: string, pinned: PublicKey | null): Buffer {
  const buf = Buffer.from(ROUND_HEX, "hex");
  writeU64(buf, R.roundId, id);
  writeU8(buf, R.state, STATE_INDEX[state]!);
  writeKey(buf, R.randomnessAccount, pinned);
  return buf;
}

class FakeReader {
  readonly roundsById = new Map<string, Buffer | null>();
  configBuf: Buffer | null = null;

  config(): Promise<GlobalConfigData | null> {
    return Promise.resolve(this.configBuf === null ? null : decodeGlobalConfig(this.configBuf));
  }

  round(roundId: bigint): Promise<RoundData | null> {
    const data = this.roundsById.get(roundId.toString()) ?? null;
    return Promise.resolve(data === null ? null : decodeRound(data));
  }

  roundRange(fromId: bigint, count: number): Promise<Map<bigint, RoundData | null>> {
    const out = new Map<bigint, RoundData | null>();
    for (let i = 0n; i < BigInt(count) && fromId - i >= 0n; i += 1n) {
      const data = this.roundsById.get((fromId - i).toString()) ?? null;
      out.set(fromId - i, data === null ? null : decodeRound(data));
    }
    return Promise.resolve(out);
  }

  randomness(): Promise<RandomnessView | null> {
    return Promise.resolve(null);
  }

  /** Batch read: config key + round keys, resolved by reverse-PDA lookup. */
  accounts(keys: PublicKey[]): Promise<Map<string, Buffer | null>> {
    const out = new Map<string, Buffer | null>();
    for (const key of keys) {
      if (key.equals(configKey())) {
        out.set(key.toBase58(), this.configBuf);
        continue;
      }
      let resolved: Buffer | null | undefined;
      for (const [id, buf] of this.roundsById) {
        if (roundKey(BigInt(id)).equals(key)) {
          resolved = buf;
          break;
        }
      }
      out.set(key.toBase58(), resolved ?? null);
    }
    return Promise.resolve(out);
  }
}

function makeMonitor(
  reader: FakeReader,
  views = new Map<string, RandomnessView | null>(),
): RoundMonitor {
  return new RoundMonitor(
    reader as unknown as ChainReader,
    {
      windowSize: 8,
      wsEnabled: false,
      connection: new Connection("http://127.0.0.1:1"),
      commitment: "confirmed",
    },
    async (key) => views.get(key.toBase58()) ?? null,
    () => undefined,
  );
}

describe("round monitor", () => {
  it("reconciles the tracked set from chain, tolerating closed-round gaps", async () => {
    const pinned = PublicKey.unique();
    const reader = new FakeReader();
    reader.configBuf = configBuffer(5n, 6n);
    reader.roundsById.set("5", roundBuffer(5n, "settled", null));
    reader.roundsById.set("4", null); // closed and gone — the walk continues past it
    reader.roundsById.set("3", roundBuffer(3n, "awaitingRandomness", pinned));
    const monitor = makeMonitor(reader);
    await monitor.bootstrap();

    expect(monitor.trackedIds().map(String)).to.deep.equal(["5", "3"]); // newest first
    expect(monitor.config?.activeRoundId).to.equal(5n);
    expect(monitor.config?.nextRoundId).to.equal(6n);
    const rows = monitor.statusRows(() => null);
    expect(rows).to.deep.equal([
      { roundId: "5", state: "settled" },
      { roundId: "3", state: "awaitingRandomness" },
    ]);
  });

  it("refresh drops rounds that closed and updates the rest", async () => {
    const reader = new FakeReader();
    reader.configBuf = configBuffer(5n, 6n);
    reader.roundsById.set("5", roundBuffer(5n, "settled", null));
    const monitor = makeMonitor(reader);
    await monitor.bootstrap();
    expect(monitor.trackedIds().map(String)).to.deep.equal(["5"]);

    // Round 5 gets fully closed on chain; refresh must drop it.
    reader.roundsById.set("5", null);
    await monitor.refresh();
    expect(monitor.trackedIds()).to.deep.equal([]);
  });

  it("self-heals tracking when config advances to an unseen round", async () => {
    const reader = new FakeReader();
    reader.configBuf = configBuffer(1n, 2n);
    reader.roundsById.set("1", roundBuffer(1n, "settled", null));
    const monitor = makeMonitor(reader);
    await monitor.bootstrap();
    expect(monitor.trackedIds().map(String)).to.deep.equal(["1"]);

    // open_round 2 lands elsewhere; refreshRound(2) reads the new config
    // (active=2, next=3) and must pull the unseen round 2 into tracking.
    reader.configBuf = configBuffer(2n, 3n);
    reader.roundsById.set("2", roundBuffer(2n, "open", null));
    await monitor.refreshRound(2n);
    expect(monitor.trackedIds().map(String)).to.deep.equal(["2", "1"]);
    expect(monitor.round(2n)?.state).to.equal("open");
  });

  it("keeps randomness views only for rounds mid-pipeline", async () => {
    const pinned = PublicKey.unique();
    const view: RandomnessView = {
      authority: pinned,
      queue: pinned,
      seedSlothash: new Uint8Array(32),
      seedSlot: 42n,
      oracle: pinned,
      revealSlot: 0n,
      value: new Uint8Array(32),
      lutSlot: 0n,
    };
    const views = new Map<string, RandomnessView | null>([[pinned.toBase58(), view]]);
    const reader = new FakeReader();
    reader.configBuf = configBuffer(3n, 4n);
    reader.roundsById.set("3", roundBuffer(3n, "awaitingRandomness", pinned));
    const monitor = makeMonitor(reader, views);
    await monitor.bootstrap();

    expect(monitor.view(monitor.round(3n)!)?.seedSlot).to.equal(42n);

    // Settled rounds no longer need the view.
    reader.roundsById.set("3", roundBuffer(3n, "settled", pinned));
    await monitor.refresh();
    expect(monitor.view(monitor.round(3n)!)).to.equal(null);
  });
});
