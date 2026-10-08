-- ORB Raffle & Referral Engine — access lockdown (R1).
--
-- The browser never holds a Supabase key: no anon or authenticated role
-- may read or write the raffle tables. All access flows through
-- SECURITY DEFINER functions granted ONLY to service_role, called from
-- the serverless functions holding the service-role key. RLS is left
-- OFF deliberately — with zero grants, `public` has nothing to reach,
-- and default-permissive policies (the classic Supabase incident) cannot
-- exist. Guards keep the file runnable on plain Postgres (local tests),
-- where the Supabase roles do not exist.

DO $$
DECLARE r TEXT;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
  EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role';
END $$;
