-- ORB Raffle — wheel rounds earn entries automatically (2026-10-08).
--
-- The wheel moved to mainnet the same day, so the owner turned on the
-- rules page's first source: 1 entry per 1 SOL deposited, paid when the
-- round settles; cancelled rounds earn nothing. src/orb-indexer.ts walks
-- the ORB program's transaction history from a cursor (row
-- 'orb_game_deposits' in raffle_indexer_cursors, table and function from
-- 008) and awards through raffle_submit_earned_event like every source.
--
-- No new tables or functions — only the schedule. The old claim-gate
-- cache job (raffle-round-cache, 005) stays unscheduled: the indexer
-- writes raffle_orb_rounds itself. Idempotent; a clean no-op without
-- pg_cron/pg_net (local Postgres).
DO $schedule$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_extension WHERE extname = 'pg_cron')
     OR NOT EXISTS (SELECT FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE
      'raffle: pg_cron/pg_net absent — raffle-orb-indexer not scheduled (expected on local Postgres)';
    RETURN;
  END IF;

  IF EXISTS (SELECT FROM cron.job WHERE jobname = 'raffle-orb-indexer') THEN
    PERFORM cron.unschedule('raffle-orb-indexer');
  END IF;

  PERFORM cron.schedule('raffle-orb-indexer', '30 seconds', $job$
    SELECT net.http_post(
             url     := cfg.base_url || '/api/raffle/cron/orb-indexer',
             headers := jsonb_build_object(
                          'Content-Type',  'application/json',
                          'x-cron-secret', cfg.secret),
             timeout_milliseconds := 25000)
      FROM public.raffle_ops_endpoint() AS cfg;
  $job$);
  RAISE NOTICE 'raffle: scheduled raffle-orb-indexer (30 seconds)';
END $schedule$;
