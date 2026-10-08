/**
 * Generates the genesis-preloaded randomness account for the local demo.
 *
 * Single writer of scripts/local-demo/randomness-account.json — the
 * byte-exact 408-byte Switchboard `RandomnessAccountData` layout the
 * on-chain parser accepts (discriminator, authority=round PDA[0], queue,
 * seed_slothash, seed_slot, oracle, reveal_slot, value, 224B padding),
 * identical to the integration harness's proven mock. Deterministic:
 * rerunning writes the same file.
 *
 * The VALUE is not arbitrary: it is searched (pure mirror of the on-chain
 * math) so that with the scripted 7.5 SOL bot book the round settles with
 * the Mega-Pot FIRED and the winning ticket inside the last bot's range —
 * the runbook's promised spectacle. The chain recomputes everything; this
 * fixture only chooses entropy, exactly like a real oracle draw would.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { roundKey } from "@orbit-jackpot/sdk";
import {
  BOT_DEPOSITS_SOL,
  DEMO_ORACLE_PROGRAM_ID,
  DEMO_RANDOMNESS_ID,
  DEMO_ROUND_ID,
  findDemoFixtureValue,
  ticketFromEntropy,
} from "./common";

// The scripted book: 1.0, 2.5, 4.0 SOL telescoping ranges. The fixture
// makes the 4.0 SOL bot (the last, biggest slice) the winner, so the
// winning range starts at the cumulative sum of every deposit EXCEPT the
// last (1.0 + 2.5 = 3.5 SOL) and ends at the total.
const cumulative = BOT_DEPOSITS_SOL.slice(0, -1).reduce<number[]>((acc, sol, i) => {
  const prior = i === 0 ? 0 : acc[i - 1]!;
  acc.push(prior + sol * LAMPORTS_PER_SOL);
  return acc;
}, []);
const winRange: [bigint, bigint] = [
  BigInt(cumulative[cumulative.length - 1] ?? 0),
  BigInt(BOT_DEPOSITS_SOL.reduce((a, b) => a + b, 0) * LAMPORTS_PER_SOL),
];

const value = findDemoFixtureValue(winRange);
const ticket = ticketFromEntropy(
  BigInt.asUintN(128, value.slice(0, 16).reduce((acc, b, i) => acc | BigInt(b) << BigInt(8 * i), 0n)),
  winRange[1],
);

const data = Buffer.alloc(408);
data.write(
  Buffer.from([10, 66, 229, 135, 220, 239, 217, 114]).toString("binary"),
  0,
  "binary",
);
roundKey(DEMO_ROUND_ID).toBuffer().copy(data, 8); // authority = round PDA
PublicKey.default.toBuffer().copy(data, 40); // queue
// seed_slothash stays zero; seed_slot huge ⇒ always fresh vs lock_slot.
data.writeBigUInt64LE(1_000_000_000n, 104);
PublicKey.default.toBuffer().copy(data, 112); // oracle
data.writeBigUInt64LE(1n, 144); // reveal_slot > 0 ⇒ revealed
Buffer.from(value).copy(data, 152);

const accountFile = {
  pubkey: DEMO_RANDOMNESS_ID.toBase58(),
  account: {
    lamports: 100 * LAMPORTS_PER_SOL,
    data: [data.toString("base64"), "base64"],
    owner: DEMO_ORACLE_PROGRAM_ID.toBase58(),
    executable: false,
    rentEpoch: 0,
  },
};

const outPath = join(import.meta.dirname, "randomness-account.json");
writeFileSync(outPath, JSON.stringify(accountFile, null, 2) + "\n");

console.log(`randomness account : ${DEMO_RANDOMNESS_ID.toBase58()}`);
console.log(`owner (oracle pin) : ${DEMO_ORACLE_PROGRAM_ID.toBase58()}`);
console.log(`authority (round)  : ${roundKey(DEMO_ROUND_ID).toBase58()}`);
console.log(`value (hex)        : ${Buffer.from(value).toString("hex")}`);
console.log(`winning ticket     : ${ticket} / ${winRange[1]} (lands in the last bot's range)`);
console.log(`mega-pot           : FIRES (mega half is a multiple of 6767)`);
console.log(`wrote              : ${outPath}`);
