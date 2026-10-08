#!/usr/bin/env tsx
/**
 * Raffle migration runner — applies packages/raffle/sql/*.sql to a
 * Postgres database exactly once each, in filename order.
 *
 * WHY THIS EXISTS. The SQL files are bare `CREATE TABLE` / `CREATE
 * FUNCTION`, which is correct for a migration that runs once and wrong
 * for anything replayed. Rewriting them as `IF NOT EXISTS` / `OR
 * REPLACE` would make them re-runnable and simultaneously destroy the
 * property that matters: that the schema in the database is the schema
 * in the repo. So the files stay strict and the RUNNER is the
 * idempotent part — re-running it is always safe and applies only what
 * is new.
 *
 * THE GUARANTEE IT ADDS. Every applied file's sha256 is recorded. If a
 * file that has already been applied no longer hashes the same, the run
 * ABORTS and names it. That is the failure this is really for: editing
 * an applied migration silently diverges production from the repo, and
 * nothing else in the stack would notice.
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx tsx scripts/raffle/migrate.ts
 *   npx tsx scripts/raffle/migrate.ts --url postgres://... --dry-run
 *
 * For Supabase, use the connection string from
 * Project Settings → Database → Connection string → URI (the direct
 * connection, not the pooler: migrations run DDL).
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";

const SQL_DIR = resolve(__dirname, "..", "..", "packages", "raffle", "sql");

interface Args {
  url: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let url = process.env.DATABASE_URL ?? "";
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url") {
      url = argv[i + 1] ?? "";
      i++;
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (url === "") {
    throw new Error(
      "no database URL — pass --url or set DATABASE_URL (Supabase: the direct URI, not the pooler)",
    );
  }
  return { url, dryRun };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface Migration {
  filename: string;
  sql: string;
  checksum: string;
}

function loadMigrations(): Migration[] {
  return readdirSync(SQL_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort() // 001_, 002_, … — zero-padded, so lexical order is apply order
    .map((filename) => {
      const sql = readFileSync(join(SQL_DIR, filename), "utf8");
      return { filename, sql, checksum: sha256(sql) };
    });
}

const LEDGER = `
  CREATE TABLE IF NOT EXISTS raffle_migrations (
    filename   TEXT PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const migrations = loadMigrations();
  if (migrations.length === 0) {
    throw new Error(`no .sql files found in ${SQL_DIR}`);
  }

  const client = new Client({ connectionString: args.url });
  await client.connect();

  try {
    await client.query(LEDGER);

    const applied = new Map<string, string>();
    const rows = await client.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM raffle_migrations",
    );
    for (const row of rows.rows) applied.set(row.filename, row.checksum);

    // Drift check across EVERY file before applying anything: a run that
    // would abort halfway is worse than one that refuses to start.
    const drifted = migrations.filter(
      (m) => applied.has(m.filename) && applied.get(m.filename) !== m.checksum,
    );
    if (drifted.length > 0) {
      for (const m of drifted) {
        console.error(`  DRIFT  ${m.filename}`);
        console.error(`         applied: ${applied.get(m.filename)}`);
        console.error(`         on disk: ${m.checksum}`);
      }
      throw new Error(
        `${drifted.length} applied migration(s) changed on disk. An applied file must never be ` +
          `edited — add a new numbered file with the change instead.`,
      );
    }

    const pending = migrations.filter((m) => !applied.has(m.filename));

    for (const m of migrations) {
      if (!applied.has(m.filename)) continue;
      console.log(`  skip   ${m.filename}  (applied, checksum matches)`);
    }

    if (pending.length === 0) {
      console.log("\nnothing to apply — the database is up to date.");
      return;
    }

    if (args.dryRun) {
      console.log(`\nwould apply ${pending.length} migration(s):`);
      for (const m of pending) console.log(`  ${m.filename}`);
      return;
    }

    for (const m of pending) {
      process.stdout.write(`  apply  ${m.filename} … `);
      // One transaction per file: the DDL and its ledger row commit
      // together, so a failure can never record a migration that did
      // not fully run. Dollar-quoted bodies go to the server verbatim —
      // never split a migration on semicolons.
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query(
          "INSERT INTO raffle_migrations (filename, checksum) VALUES ($1, $2)",
          [m.filename, m.checksum],
        );
        await client.query("COMMIT");
        console.log("ok");
      } catch (err) {
        await client.query("ROLLBACK");
        console.log("FAILED");
        throw err;
      }
    }

    console.log(`\napplied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`\nmigrate failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
