-- ORB Raffle & Referral Engine — function lockdown + RLS (R1).
--
-- Found on the first Supabase apply (2026-10-08). 003 revoked EXECUTE
-- from anon and authenticated by name, but Postgres grants EXECUTE on
-- every new function to PUBLIC, and every role — anon included —
-- inherits PUBLIC. Functions created after 003 also pick up Supabase's
-- default privileges. Net effect on the live project: every raffle_
-- function was callable by anon through PostgREST rpc.
--
-- For the invoker-rights functions that was inert: anon holds no table
-- grant, so each body fails on its first read. raffle_ops_endpoint is
-- SECURITY DEFINER and returns the cron secret — anyone holding the
-- project's anon key, which Supabase treats as public, could read it.
--
-- So: revoke EXECUTE from PUBLIC, anon and authenticated on every
-- raffle_ function and grant it to service_role alone. The loop reads
-- the catalog instead of naming functions, so replaying this file after
-- a later migration adds one is safe — and that later migration must do
-- the same (tests/p10_grants.test.ts fails until it does). The owner
-- (postgres, which also runs the pg_cron jobs) keeps EXECUTE as owner.
--
-- RLS: enabled on every raffle_ table, with no policies. 003 left it off
-- because nothing is granted; RLS on top means a future accidental
-- GRANT (a dashboard toggle, a default privilege) still reads zero
-- rows. service_role has BYPASSRLS and the owner is not forced, so the
-- server functions, the cron jobs and the local tests are unaffected.

DO $$
DECLARE
  f REGPROCEDURE;
  t REGCLASS;
  r TEXT;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname LIKE 'raffle\_%'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', f, r);
      END IF;
    END LOOP;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;

  FOR t IN
    SELECT c.oid::regclass
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind = 'r'
       AND c.relname LIKE 'raffle\_%'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
