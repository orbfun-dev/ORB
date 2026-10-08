-- ORB Raffle — per-IP and per-wallet request limits (AUDIT R-9).
--
-- /claim, /purchase and /referral are unauthenticated and each request
-- costs paid RPC calls (getTransaction; the referral funder lookup costs
-- up to a dozen). Serverless instances share no memory, so the counter
-- lives here: one fixed-window counter per bucket ("ip:…", "wallet:…").
-- A database round trip is far cheaper than the RPC it guards.

CREATE TABLE raffle_rate_hits (
  bucket       TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits         INT         NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

-- Counts one hit in every bucket and answers whether ALL are still
-- within their limit (p_limits[i] bounds p_buckets[i]). Old windows are
-- swept on the way through; the table never holds more than a few
-- minutes of traffic.
CREATE FUNCTION raffle_rate_allow(p_buckets TEXT[], p_limits INT[], p_window_secs INT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  v_window TIMESTAMPTZ :=
    to_timestamp(floor(extract(epoch FROM now()) / p_window_secs) * p_window_secs);
  v_hits INT;
  v_ok BOOLEAN := true;
BEGIN
  IF array_length(p_buckets, 1) IS DISTINCT FROM array_length(p_limits, 1) THEN
    RAISE EXCEPTION 'raffle_rate_allow: buckets and limits differ in length';
  END IF;
  DELETE FROM raffle_rate_hits WHERE window_start < now() - make_interval(secs => p_window_secs * 4);
  FOR i IN 1 .. coalesce(array_length(p_buckets, 1), 0) LOOP
    INSERT INTO raffle_rate_hits AS h (bucket, window_start, hits)
    VALUES (p_buckets[i], v_window, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET hits = h.hits + 1
    RETURNING h.hits INTO v_hits;
    IF v_hits > p_limits[i] THEN
      v_ok := false;
    END IF;
  END LOOP;
  RETURN v_ok;
END $$;

-- ─── R1 lockdown (007's rule) ──────────────────────────────────────────
DO $lockdown$
DECLARE r TEXT;
BEGIN
  REVOKE ALL ON raffle_rate_hits FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION raffle_rate_allow(TEXT[], INT[], INT) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON raffle_rate_hits FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION raffle_rate_allow(TEXT[], INT[], INT) FROM %I', r);
    END IF;
  END LOOP;
  GRANT EXECUTE ON FUNCTION raffle_rate_allow(TEXT[], INT[], INT) TO service_role;
  ALTER TABLE raffle_rate_hits ENABLE ROW LEVEL SECURITY;
END $lockdown$;
