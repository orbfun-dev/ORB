/**
 * P10 GATE — nothing in the raffle schema is reachable without the
 * service role (R1, after the first Supabase apply).
 *
 * 003 revoked by role name and missed PUBLIC, through which every role
 * inherits EXECUTE on a new function; on Supabase that left the
 * SECURITY DEFINER raffle_ops_endpoint — which returns the cron
 * secret — callable with the public anon key. 007 closes it. These
 * checks run against the replayed migrations, so a later file that adds
 * a function or table without the same lockdown fails here, not in
 * production.
 */

import { expect } from "chai";
import { before, beforeEach, describe, it } from "mocha";
import { resetDb, testDb, TestDb } from "./helpers/db";

let db: TestDb;

before(async () => {
  db = await testDb();
});
beforeEach(async () => {
  await resetDb(db);
});

describe("P10 — R1: the raffle schema answers only to service_role", () => {
  it("no raffle_ function is executable through PUBLIC", async () => {
    const rows = await db.q(
      `SELECT p.oid::regprocedure::text AS fn
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname LIKE 'raffle\\_%'
          AND has_function_privilege('public', p.oid, 'EXECUTE')`,
    );
    expect(rows.map((r) => r.fn), "functions PUBLIC can execute").to.deep.equal([]);
  });

  it("service_role can still execute every raffle_ function", async () => {
    const rows = await db.q(
      `SELECT p.oid::regprocedure::text AS fn
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname LIKE 'raffle\\_%'
          AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')`,
    );
    expect(rows.map((r) => r.fn), "functions service_role cannot execute").to.deep.equal([]);
  });

  it("the function that hands out the cron secret is among those locked", async () => {
    const [row] = await db.q(
      `SELECT has_function_privilege('public', 'raffle_ops_endpoint()', 'EXECUTE') AS open`,
    );
    expect(row.open).to.equal(false);
  });

  it("every raffle_ table has row-level security on", async () => {
    const rows = await db.q(
      `SELECT c.relname
         FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relkind = 'r'
          AND c.relname LIKE 'raffle\\_%'
          AND NOT c.relrowsecurity`,
    );
    expect(rows.map((r) => r.relname), "tables without RLS").to.deep.equal([]);
  });
});
