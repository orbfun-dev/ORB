-- ORB Raffle & Referral Engine — scheduling (directive §6.2, §6.5, §6.6).
--
-- The three background jobs are HTTP calls into the Vercel functions,
-- not plpgsql: the work needs @solana/web3.js and the SDK's event
-- decoders, which do not exist inside Postgres. pg_cron fires, pg_net
-- posts, the Node function does the chain work. Supabase is the
-- database and the clock; it is not the runtime.
--
-- Guarded end to end: on plain Postgres (the local test database) the
-- pg_cron and pg_net extensions do not exist, so this file is a clean
-- no-op and 001..005 stay replayable in tests.
--
-- NOTE ON FK INDEXES. An audit for unindexed foreign keys reports four:
-- raffle_entries.origin_event, raffle_entries.referee,
-- raffle_buybacks.epoch_id and raffle_draws.winner_wallet. All four are
-- intentional. The first two are write-only — inserted by raffle_award,
-- never read in a WHERE or JOIN — and raffle_entries takes up to 1 000
-- inserts per epoch inside the FOR UPDATE critical section, where every
-- extra index lengthens the lock. The last two sit on tables holding a
-- handful of rows per epoch. Re-check with:
--   SELECT conrelid::regclass, a.attname FROM pg_constraint c
--     JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
--    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
--      AND NOT EXISTS (SELECT 1 FROM pg_index i
--                       WHERE i.indrelid = c.conrelid AND a.attnum = ANY(i.indkey));

-- ─── where the jobs post, and with what secret ─────────────────────────
-- pg_cron needs the function base URL and the cron secret at call time,
-- and a cron job body cannot read the Vercel environment. They live
-- here instead. This table holds a SECRET: it gets no grants at all, so
-- anon and authenticated cannot reach it (same posture as 003).
CREATE TABLE raffle_ops_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE raffle_ops_config IS
  'Ops-only: function_base_url and cron_secret for the pg_cron jobs. Holds a secret — grant to nobody.';

REVOKE ALL ON raffle_ops_config FROM PUBLIC;

DO $lockdown$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON raffle_ops_config FROM %I', r);
    END IF;
  END LOOP;
END $lockdown$;

/*
 * The job target, or NO ROWS when the raffle is not configured yet.
 *
 * Returning zero rows is the point: each cron body is a SELECT over
 * this function, so an unconfigured install schedules quietly and does
 * nothing, instead of posting to `NULL || '/path'` and logging an error
 * every 30 seconds until someone notices.
 */
CREATE FUNCTION raffle_ops_endpoint()
RETURNS TABLE (base_url TEXT, secret TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT rtrim(u.value, '/'), s.value
    FROM raffle_ops_config u
    JOIN raffle_ops_config s ON s.key = 'cron_secret'
   WHERE u.key = 'function_base_url'
     AND length(u.value) > 0
     AND length(s.value) > 0
$$;

-- ─── the schedules ─────────────────────────────────────────────────────
-- Idempotent: an existing job of the same name is unscheduled first, so
-- replaying this file (or a later one that changes a schedule) leaves
-- exactly one job per name.
--
-- pg_net is fire-and-forget — http_post queues the request and returns
-- an id immediately. Responses land in net._http_response; that table
-- is where a failing job is diagnosed (see docs/runbooks/raffle-ops.md).
DO $schedule$
DECLARE
  j      RECORD;
  v_body TEXT;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_extension WHERE extname = 'pg_cron')
     OR NOT EXISTS (SELECT FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE
      'raffle: pg_cron/pg_net absent — no jobs scheduled (expected on local Postgres)';
    RETURN;
  END IF;

  FOR j IN
    SELECT * FROM (VALUES
      -- §6.2 — the round-outcome cache. Must beat close_round, which
      -- DELETES the round account: a state not cached before that
      -- cannot be read from the chain any more.
      ('raffle-round-cache', '30 seconds', '/api/raffle/cron/round-cache'),
      -- §6.5 — timer-lock, commit the draw, open the next epoch.
      ('raffle-epoch-lock',  '* * * * *',  '/api/raffle/cron/epoch-lock'),
      -- §6.6 — reveal locked epochs whose target slot has passed.
      ('raffle-draw',        '* * * * *',  '/api/raffle/cron/draw')
    ) AS t(jobname, schedule, path)
  LOOP
    IF EXISTS (SELECT FROM cron.job WHERE jobname = j.jobname) THEN
      PERFORM cron.unschedule(j.jobname);
    END IF;

    v_body := format($fmt$
      SELECT net.http_post(
               url     := cfg.base_url || %L,
               headers := jsonb_build_object(
                            'Content-Type',  'application/json',
                            'x-cron-secret', cfg.secret),
               timeout_milliseconds := 25000)
        FROM public.raffle_ops_endpoint() AS cfg;
    $fmt$, j.path);

    PERFORM cron.schedule(j.jobname, j.schedule, v_body);
    RAISE NOTICE 'raffle: scheduled % (%)', j.jobname, j.schedule;
  END LOOP;
END $schedule$;
