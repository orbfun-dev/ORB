-- ORB Raffle — an award that races the epoch lock is not burned
-- (AUDIT R-11).
--
-- raffle_submit_earned_event inserted the ledger row first and only then
-- asked raffle_award, which returns 0 for an epoch that is no longer
-- open. The row stayed, so (signature, event_index) dedup refused every
-- retry: a purchase paid for in the seconds around a lock earned nothing,
-- ever. Now the epoch row is locked FOR UPDATE and checked before the
-- ledger insert. Not open: nothing is written and the function returns
-- -1, which callers answer as "pending" and retry against the next epoch.
--
-- Lock order: epoch row, then progress row — raffle_award already locks
-- the epoch FOR UPDATE, so this only moves the first lock earlier in the
-- same transaction. A cap-lock INSIDE raffle_award still leaves a partial
-- grant with the shortfall in carried_out: that award did happen.

CREATE OR REPLACE FUNCTION raffle_submit_earned_event(
  p_signature TEXT, p_event_index SMALLINT, p_slot BIGINT, p_block_time TIMESTAMPTZ,
  p_source TEXT, p_wallet TEXT, p_epoch BIGINT, p_sol_lamports BIGINT,
  p_lamports_per_entry BIGINT,
  p_orb_round_id BIGINT DEFAULT NULL,
  p_status TEXT DEFAULT 'accepted', p_reject_reason TEXT DEFAULT NULL,
  p_entry_status TEXT DEFAULT 'confirmed',
  p_referral_min_lamports BIGINT DEFAULT 1000000000,
  p_referral_cap INT DEFAULT 25
) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_event BIGINT;
  v_cum BIGINT; v_awarded INT; v_want INT; v_grant INT;
  v_referral INT;
BEGIN
  IF p_status <> 'rejected' AND p_sol_lamports <= 0 THEN
    RAISE EXCEPTION 'sol_lamports must be positive for accepted events';
  END IF;

  -- AUDIT R-11: an accepted event is only recorded into an OPEN epoch.
  IF p_status <> 'rejected' THEN
    PERFORM 1 FROM raffle_epochs WHERE id = p_epoch AND status = 'open' FOR UPDATE;
    IF NOT FOUND THEN RETURN -1; END IF;
  END IF;

  INSERT INTO raffle_wallets (pubkey) VALUES (p_wallet)
    ON CONFLICT (pubkey) DO NOTHING;

  INSERT INTO raffle_events
      (signature, event_index, slot, block_time, source, wallet, epoch_id,
       sol_lamports, orb_round_id, status, reject_reason)
  VALUES
      (p_signature, p_event_index, p_slot, p_block_time, p_source, p_wallet, p_epoch,
       GREATEST(p_sol_lamports, 1),
       p_orb_round_id, p_status, p_reject_reason)
  ON CONFLICT (signature, event_index) DO NOTHING          -- R6: replay is a no-op
  RETURNING id INTO v_event;

  IF v_event IS NULL THEN RETURN 0; END IF;                -- dedup hit
  IF p_status = 'rejected' THEN RETURN 0; END IF;          -- recorded, never awarded

  INSERT INTO raffle_progress (epoch_id, wallet, source)
  VALUES (p_epoch, p_wallet, p_source)
  ON CONFLICT (epoch_id, wallet, source) DO NOTHING;

  SELECT cumulative_lamports, entries_awarded
    INTO v_cum, v_awarded
    FROM raffle_progress
   WHERE epoch_id = p_epoch AND wallet = p_wallet AND source = p_source
   FOR UPDATE;

  v_cum := v_cum + p_sol_lamports;
  v_want := (v_cum / p_lamports_per_entry)::INT - v_awarded;

  IF v_want <= 0 THEN
    UPDATE raffle_progress SET cumulative_lamports = v_cum
     WHERE epoch_id = p_epoch AND wallet = p_wallet AND source = p_source;
    RETURN 0;
  END IF;

  v_grant := raffle_award(p_epoch, p_wallet, p_source, v_event, v_want, p_entry_status);

  UPDATE raffle_progress
     SET cumulative_lamports = v_cum,
         entries_awarded     = entries_awarded + v_grant,
         carried_out         = carried_out + (v_want - v_grant)
   WHERE epoch_id = p_epoch AND wallet = p_wallet AND source = p_source;

  v_referral := raffle_maybe_award_referral(v_event, p_referral_min_lamports, p_referral_cap);

  RETURN v_grant;
END $$;

-- CREATE OR REPLACE keeps the grants, but restate 007's posture anyway.
DO $lockdown$
DECLARE r TEXT;
  f TEXT := 'raffle_submit_earned_event(text, smallint, bigint, timestamptz, text, text, bigint, bigint, bigint, bigint, text, text, text, bigint, integer)';
BEGIN
  EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', f, r);
    END IF;
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
END $lockdown$;
