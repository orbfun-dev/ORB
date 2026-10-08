/**
 * Read-only devnet state probe (ops tooling for the v2 cutover): dumps the
 * config, Mega-Pot, treasury, the newest rounds and every relevant balance
 * without signing anything.
 *
 *   npx tsx scripts/devnet/probe-live-state.ts [roundId]
 */

import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  OrbitJackpotClient,
  configKey,
  megaPotKey,
  roundKey,
  roundVaultKey,
  treasuryKey,
} from "@orbit-jackpot/sdk";

const RPC = (process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com").trim();
const connection = new Connection(RPC, "confirmed");

const sol = (lamports: bigint | number): string =>
  `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(9)} SOL`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(op: () => Promise<T>, label = "rpc"): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= 8; i += 1) {
    try {
      return await op();
    } catch (err) {
      last = err;
      if (!/429|Too many requests/i.test(String(err))) throw err;
      await sleep(i * 1_200);
    }
  }
  throw new Error(`${label} failed: ${String(last).slice(0, 160)}`);
}

async function main(): Promise<void> {
  const client = new OrbitJackpotClient(connection);
  const config = await client.fetchConfig();
  if (config === null) throw new Error("config account missing");
  const mega = await client.fetchMegaPot();

  console.log("== GlobalConfig ==");
  console.log(JSON.stringify(config, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  console.log("\n== MegaPotVault ==");
  console.log(JSON.stringify(mega, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  const focus = process.argv[2] !== undefined ? BigInt(process.argv[2]) : config.activeRoundId;
  for (const id of [focus - 2n, focus - 1n, focus]) {
    const round = await client.fetchRound(id);
    console.log(`\n== Round ${id} ==`);
    console.log(JSON.stringify(round, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  }

  console.log("\n== Balances (account lamports) ==");
  const admin = new PublicKey(config.admin);
  const rows: Array<[string, PublicKey]> = [
    ["admin (vaulted)", admin],
    ["config", configKey()],
    ["mega_pot", megaPotKey()],
    ["treasury", treasuryKey()],
    [`round ${focus}`, roundKey(focus)],
    [`round ${focus} vault`, roundVaultKey(focus)],
  ];
  for (const [label, key] of rows) {
    const lamports = await withRetry(() => connection.getBalance(key, "confirmed"), label);
    console.log(`  ${label.padEnd(20)} ${key.toBase58()}  ${sol(lamports)} (${lamports})`);
  }
}

void main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
