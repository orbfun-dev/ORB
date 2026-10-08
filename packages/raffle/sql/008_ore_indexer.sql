-- ORB Raffle — ORE entries come from an indexer, not from claims.
--
-- Owner decision 2026-10-08: only ORE deploys made through playorb earn
-- entries. Every such deploy pays the platform fee to one wallet in the
-- same atomic transaction, so the job in src/ore-indexer.ts walks that
-- wallet's history and awards the deploys it finds. The claim endpoint
-- no longer awards ORE at all.
--
-- This file adds the job's cursor, the function that moves it, the
-- R1 lockdown both need (007's rule: every new raffle_ object locks
-- itself), and the schedule. Replayable on plain Postgres like 005.

-- ─── the cursor ────────────────────────────────────────────────────────
-- One row per indexer. `last_signature` is the newest signature the job
-- has moved past; getSignaturesForAddress(until = it) lists what is new.
CREATE TABLE raffle_indexer_cursors (
  name           TEXT PRIMARY KEY,
  last_signature TEXT   NOT NULL,
  last_slot      BIGINT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

/*
 * Move a cursor forward, never back. Two runs can overlap when one is
 * slow (pg_cron fires every 30 s regardless); the slower one finishing
 * last must not rewind the newer one's progress. Rewinding would only
 * cost re-reads — awards dedup on (signature, event_index) — but there
 * is no reason to pay for them.
 */
CREATE FUNCTION raffle_advance_indexer_cursor(
  p_name TEXT, p_signature TEXT, p_slot BIGINT
) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO raffle_indexer_cursors (name, last_signature, last_slot)
  VALUES (p_name, p_signature, p_slot)
  ON CONFLICT (name) DO UPDATE
     SET last_signature = EXCLUDED.last_signature,
         last_slot      = EXCLUDED.last_slot,
         updated_at     = now()
   WHERE raffle_indexer_cursors.last_slot <= EXCLUDED.last_slot
$$;

-- ─── R1 lockdown (same posture as 003 + 007) ───────────────────────────
DO $lockdown$
DECLARE r TEXT;
BEGIN
  REVOKE ALL ON raffle_indexer_cursors FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION raffle_advance_indexer_cursor(TEXT, TEXT, BIGINT) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON raffle_indexer_cursors FROM %I', r);
      EXECUTE format(
        'REVOKE EXECUTE ON FUNCTION raffle_advance_indexer_cursor(TEXT, TEXT, BIGINT) FROM %I', r);
    END IF;
  END LOOP;
  GRANT EXECUTE ON FUNCTION raffle_advance_indexer_cursor(TEXT, TEXT, BIGINT) TO service_role;
  ALTER TABLE raffle_indexer_cursors ENABLE ROW LEVEL SECURITY;
END $lockdown$;

-- ─── the schedule ──────────────────────────────────────────────────────
-- Every 30 s, like the round cache: finalization takes ~13 s, so a
-- deploy shows up as entries within about a minute. Idempotent; a clean
-- no-op without pg_cron/pg_net (local Postgres).
DO $schedule$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_extension WHERE extname = 'pg_cron')
     OR NOT EXISTS (SELECT FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE
      'raffle: pg_cron/pg_net absent — raffle-ore-indexer not scheduled (expected on local Postgres)';
    RETURN;
  END IF;

  IF EXISTS (SELECT FROM cron.job WHERE jobname = 'raffle-ore-indexer') THEN
    PERFORM cron.unschedule('raffle-ore-indexer');
  END IF;

  PERFORM cron.schedule('raffle-ore-indexer', '30 seconds', $job$
    SELECT net.http_post(
             url     := cfg.base_url || '/api/raffle/cron/ore-indexer',
             headers := jsonb_build_object(
                          'Content-Type',  'application/json',
                          'x-cron-secret', cfg.secret),
             timeout_milliseconds := 25000)
      FROM public.raffle_ops_endpoint() AS cfg;
  $job$);
  RAISE NOTICE 'raffle: scheduled raffle-ore-indexer (30 seconds)';
END $schedule$;
