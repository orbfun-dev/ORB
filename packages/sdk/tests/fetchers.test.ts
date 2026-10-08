/**
 * `fetchEntries` transport gates: the memcmp-filtered `getProgramAccounts`
 * primary, and the chunked `getMultipleAccounts` fallback public RPCs
 * force when they reject GPA. Account bytes come from the Rust layout
 * fixture, so the decoders run on real serialization.
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { entryKey, PROGRAM_ID, roundKey } from "../src/pda";
import { OrbitJackpotClient } from "../src/client";

interface Fixture {
  accounts: Record<string, { hex: string }>;
}

const fixture: Fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "account_layouts.json"), "utf8"),
) as Fixture;

const ROUND_ID = 7n; // the fixture's round
const ROUND_DATA = Buffer.from(fixture.accounts.Round!.hex, "hex");
const ENTRY_DATA = Buffer.from(fixture.accounts.PlayerEntry!.hex, "hex");

type AccountInfoLike = { data: Buffer; lamports: number; owner: PublicKey; executable: boolean };

function entryInfo(index: number): AccountInfoLike {
  const data = Buffer.from(ENTRY_DATA);
  data.writeUInt32LE(index, 8 + 8); // round_id (u64) then entry_index (u32)
  return { data, lamports: 1, owner: PROGRAM_ID, executable: false };
}

/**
 * Minimal scripted connection over just the surface `fetchEntries` and
 * `fetchRound` touch. `gpa` either resolves with the given accounts or
 * rejects the way public RPCs reject `getProgramAccounts`.
 */
function fakeConnection(
  gpa: "ok" | "throw",
  accounts: Map<string, AccountInfoLike>,
): Connection {
  return {
    getProgramAccounts: (_p: PublicKey) =>
      gpa === "throw"
        ? Promise.reject(new Error("429 Too many requests: getProgramAccounts"))
        : Promise.resolve(
            [...accounts.entries()]
              .filter(([key]) => key !== roundKey(ROUND_ID).toBase58())
              .map(([pubkey, info]) => ({ pubkey: new PublicKey(pubkey), account: info })),
          ),
    getAccountInfo: (key: PublicKey) =>
      Promise.resolve(accounts.get(key.toBase58()) ?? null),
    getMultipleAccountsInfo: (keys: PublicKey[]) =>
      Promise.resolve(
        keys.map((k) => {
          const info = accounts.get(k.toBase58());
          return info === undefined ? null : { ...info, data: Buffer.from(info.data) };
        }),
      ),
  } as unknown as Connection;
}

describe("fetchEntries", () => {
  it("uses memcmp getProgramAccounts when the RPC allows it", async () => {
    const accounts = new Map([
      [roundKey(ROUND_ID).toBase58(), { data: Buffer.from(ROUND_DATA), lamports: 1, owner: PROGRAM_ID, executable: false }],
      [entryKey(ROUND_ID, 0).toBase58(), entryInfo(0)],
      [entryKey(ROUND_ID, 2).toBase58(), entryInfo(2)],
    ]);
    const client = new OrbitJackpotClient(fakeConnection("ok", accounts));
    const entries = await client.fetchEntries(ROUND_ID);
    expect(entries.map((e) => e.entryIndex)).to.deep.equal([0, 2]);
  });

  it("falls back to chunked getMultipleAccounts when GPA is rejected", async () => {
    // The fixture round's entry_count is 3; entry 1 is closed (absent) —
    // the sparse book the sanitizer repairs downstream.
    const accounts = new Map([
      [roundKey(ROUND_ID).toBase58(), { data: Buffer.from(ROUND_DATA), lamports: 1, owner: PROGRAM_ID, executable: false }],
      [entryKey(ROUND_ID, 0).toBase58(), entryInfo(0)],
      [entryKey(ROUND_ID, 2).toBase58(), entryInfo(2)],
    ]);
    const client = new OrbitJackpotClient(fakeConnection("throw", accounts));
    const entries = await client.fetchEntries(ROUND_ID);
    expect(entries.map((e) => e.entryIndex)).to.deep.equal([0, 2]);
  });

  it("an empty round degrades to an empty book without GPA", async () => {
    const fresh = Buffer.from(ROUND_DATA);
    fresh.writeBigUInt64LE(9n, 8); // round 9
    fresh.writeUInt32LE(0, 65); // entry_count = 0
    const accounts = new Map([
      [roundKey(9n).toBase58(), { data: fresh, lamports: 1, owner: PROGRAM_ID, executable: false }],
    ]);
    const client = new OrbitJackpotClient(fakeConnection("throw", accounts));
    expect(await client.fetchEntries(9n)).to.deep.equal([]);
  });
});
