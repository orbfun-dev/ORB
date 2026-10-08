/**
 * Local test-database bootstrap for the raffle SQL (P0 gate).
 *
 * Runs the production migration files (sql/001..003) against a throwaway
 * local Postgres database, so the concurrency gates exercise the exact
 * DDL and plpgsql that ship. Migration replay goes through `psql -f`
 * (static repo files, ON_ERROR_STOP=1). Override the connection with
 * RAFFLE_TEST_PG_URL (defaults to the local Homebrew Postgres). The test
 * database is dropped and rebuilt on every run; every data query in this
 * repo uses bound parameters.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import bs58 from "bs58";
import { Pool } from "pg";

const ADMIN_URL =
  process.env.RAFFLE_TEST_PG_URL ?? "postgresql://localhost:5432/postgres";
const TEST_DB_NAME = "orb_raffle_test";

function adminUrlForDb(dbName: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = "/" + dbName;
  return url.toString();
}

export function sqlDir(): string {
  return join(__dirname, "..", "..", "sql");
}

function psql(connectionString: string, file: string): void {
  execFileSync(
    "psql",
    ["-v", "ON_ERROR_STOP=1", "--quiet", "--no-psqlrc", connectionString, "-f", file],
    {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" },
    },
  );
}

async function ensureDatabase(): Promise<string> {
  const target = adminUrlForDb(TEST_DB_NAME);
  psql(ADMIN_URL, writeTempSql("DROP DATABASE IF EXISTS " + TEST_DB_NAME + ";"));
  psql(ADMIN_URL, writeTempSql("CREATE DATABASE " + TEST_DB_NAME + ";"));
  return target;
}

/** psql reads migrations from files; tiny one-shot DDL goes through a temp file too. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const tempFiles: string[] = [];
function writeTempSql(sql: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "orb-raffle-")), "one-shot.sql");
  writeFileSync(path, sql);
  tempFiles.push(path);
  return path;
}

async function applyMigrations(connectionString: string): Promise<void> {
  // Clean slate — drop everything the previous run left, then replay the
  // static repo files. One-shot DDL rides a temp file because psql -f is
  // the only execution path here.
  psql(connectionString, writeTempSql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"));
  // 005_cron.sql is included on purpose: on plain Postgres it must be a
  // clean no-op (no pg_cron, no pg_net), and replaying it here is what
  // proves that before it ever reaches Supabase.
  for (const file of [
    "001_tables.sql",
    "002_functions.sql",
    "003_lockdown.sql",
    "004_draw.sql",
    "005_cron.sql",
    "006_status.sql",
    "007_function_lockdown.sql",
    "008_ore_indexer.sql",
    "009_draw_commit.sql",
    "010_rate_limit.sql",
    "011_submit_epoch_closed.sql",
  ]) {
    psql(connectionString, join(sqlDir(), file));
  }
}

export interface TestDb {
  pool: Pool;
  /** One bound-parameter query against the test database. */
  q: (text: string, values?: unknown[]) => Promise<{ [k: string]: any }[]>;
}

let dbPromise: Promise<TestDb> | null = null;

/** Idempotent per-process bootstrap; every test file calls this. */
export function testDb(): Promise<TestDb> {
  if (dbPromise === null) {
    dbPromise = (async () => {
      const url = await ensureDatabase();
      const pool = new Pool({ connectionString: url, max: 10 });
      return {
        pool,
        q: async (text, values = []) => {
          const res = await pool.query(text, values);
          return res.rows;
        },
      };
    })();
  }
  return dbPromise;
}

/** Fresh schema for the next test — replay the production migrations. */
export async function resetDb(db: TestDb): Promise<void> {
  const url = adminUrlForDb(TEST_DB_NAME);
  await applyMigrations(url);
  // pg pools cache catalog state; a lightweight round-trip keeps clients honest.
  await db.q("SELECT 1");
}

/** Unique, REAL base58 Solana pubkey (decodes to 32 bytes) for tests. */
let walletSeq = 0;
export function testWallet(): string {
  walletSeq += 1;
  // Deterministic 32 bytes → valid base58 pubkey, unique per call.
  const seed = Buffer.alloc(32);
  seed.writeUInt32LE(walletSeq, 0);
  seed.write("TestWallet", 4);
  return bs58.encode(seed);
}

let sigSeq = 0;
export function testSignature(): string {
  sigSeq += 1;
  // Deterministic 64 bytes → valid base58 signature, unique per call.
  const seed = Buffer.alloc(64);
  seed.writeUInt32LE(sigSeq, 0);
  seed.write("TestSignature", 4);
  return bs58.encode(seed);
}
