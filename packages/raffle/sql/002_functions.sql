-- ORB Raffle & Referral Engine — SQL functions (directive §5.1, §6.1, §6.5).
--
-- Every award runs inside the `raffle_epochs` row lock taken by
-- `raffle_award` (R6): callers reach it only through the atomic wrappers
-- below, so the event insert and the award share one transaction and one
-- lock. All caller inputs arrive as function parameters (bound), never as
-- concatenated SQL.
--
-- Caps read per-transaction GUCs with the directive defaults baked in as
-- fallbacks, so PostgREST rpc calls (which cannot `set_config` across
-- statements) behave identically to tests that set them explicitly:
--   raffle.purchase_cap_bps    (default 3000 = 30% of the pool, R7)
--   raffle.purchase_cap_wallet (default 25, R7)
--   raffle.referral_cap_epoch  (default 25, R7)

-- ─── helpers ───────────────────────────────────────────────────────────

CREATE FUNCTION raffle_current_epoch() RETURNS BIGINT LANGUAGE sql STABLE AS $$
  SELECT id FROM raffle_epochs WHERE status = 'open' ORDER BY id DESC LIMIT 1
$$;

-- ─── the award primitive — R6 + R7 in one atomic statement ─────────────

CREATE FUNCTION raffle_award(
  p_epoch BIGINT, p_wallet TEXT, p_source TEXT,
  p_event BIGINT, p_want INT, p_status TEXT DEFAULT 'confirmed',
  p_referee TEXT DEFAULT NULL
) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_issued INT; v_cap INT; v_grant INT; v_purch INT; v_share INT; v_wallet_purch INT;
BEGIN
  SELECT entries_issued, cap, purchased_issued
    INTO v_issued, v_cap, v_purch
    FROM raffle_epochs WHERE id = p_epoch AND status = 'open' FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;                 -- already locked

  v_grant := LEAST(p_want, v_cap - v_issued);

  -- R7: purchased entries are capped per wallet AND as a share of the pool.
  IF p_source = 'purchase' THEN
    v_share := (v_cap * COALESCE(
                  NULLIF(current_setting('raffle.purchase_cap_bps', true), '')::INT,
                  3000)) / 10000;
    v_grant := LEAST(v_grant, v_share - v_purch);

    SELECT count(*)::INT INTO v_wallet_purch
      FROM raffle_entries
     WHERE epoch_id = p_epoch AND wallet = p_wallet AND source = 'purchase';
    v_grant := LEAST(v_grant,
                     COALESCE(NULLIF(
                       current_setting('raffle.purchase_cap_wallet', true), '')::INT,
                       25) - v_wallet_purch);
  END IF;

  IF v_grant <= 0 THEN RETURN 0; END IF;

  INSERT INTO raffle_entries (epoch_id, entry_no, wallet, source, origin_event, status, referee)
  SELECT p_epoch, v_issued + g, p_wallet, p_source, p_event, p_status, p_referee
    FROM generate_series(1, v_grant) AS g;

  UPDATE raffle_epochs
     SET entries_issued   = entries_issued + v_grant,
         purchased_issued = purchased_issued + CASE WHEN p_source='purchase' THEN v_grant ELSE 0 END
   WHERE id = p_epoch;

  IF v_issued + v_grant >= v_cap THEN
    UPDATE raffle_epochs
       SET status='locked', locked_at=now(), lock_reason='cap'
     WHERE id = p_epoch;
  END IF;

  RETURN v_grant;    -- the caller records (p_want − v_grant) in carried_out
END $$;

-- ─── atomic earned-event submit — R5 accrual + R6 dedup + award ────────
--
-- One call = one database transaction = the epoch row lock. `p_status =
-- 'rejected'` (e.g. an ORB round that ended Cancelled, R3) records the
-- ledger row for transparency and awards nothing, ever. When the epoch
-- locked between the caller's epoch lookup and this call, the event stays
-- accepted with the shortfall in carried_out — the cost was real.

CREATE FUNCTION raffle_submit_earned_event(
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

  INSERT INTO raffle_wallets (pubkey) VALUES (p_wallet)
    ON CONFLICT (pubkey) DO NOTHING;

  INSERT INTO raffle_events
      (signature, event_index, slot, block_time, source, wallet, epoch_id,
       sol_lamports, orb_round_id, status, reject_reason)
  VALUES
      (p_signature, p_event_index, p_slot, p_block_time, p_source, p_wallet, p_epoch,
       GREATEST(p_sol_lamports, 1),  -- ledger CHECK is > 0; only a rejected
                                     -- zero-amount row (pathological) floors to 1
       p_orb_round_id, p_status, p_reject_reason)
  ON CONFLICT (signature, event_index) DO NOTHING          -- R6: replay is a no-op
  RETURNING id INTO v_event;

  IF v_event IS NULL THEN RETURN 0; END IF;                -- dedup hit
  IF p_status = 'rejected' THEN RETURN 0; END IF;          -- recorded, never awarded

  -- R5: accumulate lamports per (wallet, source, epoch), then floor-divide
  -- with carry. The progress row lock serialises accrual for the wallet.
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

  -- Referral bonus (§6.3): fires in the SAME locked transaction when
  -- this is the referee's first accepted event and it clears the
  -- referral minimum — subject to the per-referrer epoch cap.
  v_referral := raffle_maybe_award_referral(v_event, p_referral_min_lamports, p_referral_cap);

  RETURN v_grant;
END $$;

-- ─── referral attribution (§6.3) — first touch, immutable ──────────────

-- Binds `p_wallet → p_ref` once. Returns:
--   1 = newly bound   0 = already bound (first touch wins)   -1 = self-referral
CREATE FUNCTION raffle_bind_referral(p_wallet TEXT, p_ref TEXT) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE v_updated INT;
BEGIN
  IF p_wallet = p_ref THEN RETURN -1; END IF;   -- also enforced by no_self_referral

  INSERT INTO raffle_wallets (pubkey) VALUES (p_wallet), (p_ref)
    ON CONFLICT (pubkey) DO NOTHING;

  UPDATE raffle_wallets
     SET referred_by = p_ref, referred_at = now()
   WHERE pubkey = p_wallet AND referred_by IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN RETURN 0; END IF;
  RETURN 1;
END $$;

-- The bonus award — called from raffle_submit_earned_event with the
-- epoch row lock already held (same database transaction, R6).
CREATE FUNCTION raffle_maybe_award_referral(
  p_event BIGINT, p_min_lamports BIGINT, p_cap INT
) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
  v_wallet TEXT; v_epoch BIGINT; v_ref TEXT; v_first BIGINT; v_min BIGINT; v_count INT;
BEGIN
  SELECT wallet, epoch_id, sol_lamports INTO v_wallet, v_epoch, v_min
    FROM raffle_events WHERE id = p_event;
  IF v_wallet IS NULL THEN RETURN 0; END IF;
  IF v_min < p_min_lamports THEN RETURN 0; END IF;

  -- Strict first-event reading: only the referee's first accepted event
  -- can pay a bonus (stated in the public rules).
  SELECT min(id) INTO v_first FROM raffle_events WHERE wallet = v_wallet AND status = 'accepted';
  IF v_first IS NULL OR v_first <> p_event THEN RETURN 0; END IF;

  SELECT referred_by INTO v_ref FROM raffle_wallets WHERE pubkey = v_wallet;
  IF v_ref IS NULL THEN RETURN 0; END IF;

  SELECT count(*) INTO v_count FROM raffle_entries
   WHERE epoch_id = v_epoch AND wallet = v_ref AND source = 'referral';
  IF v_count >= p_cap THEN RETURN 0; END IF;

  -- p_referee = the wallet whose qualifying event paid for the bonus.
  RETURN raffle_award(v_epoch, v_ref, 'referral', p_event, 1, 'confirmed', v_wallet);
END $$;

-- ─── epoch lifecycle — timer lock (§6.5 step 1) + next epoch ───────────

-- Idempotent: the WHERE status='open' guard shares the row lock with
-- raffle_award — a concurrent cap-lock commit wins and the timer's row
-- recheck finds nothing left to lock (and vice versa).
CREATE FUNCTION raffle_lock_expired_epochs() RETURNS INT LANGUAGE plpgsql AS $$
DECLARE v_locked INT;
BEGIN
  UPDATE raffle_epochs
     SET status = 'locked', locked_at = now(), lock_reason = 'timer'
   WHERE status = 'open' AND now() >= ends_at;
  GET DIAGNOSTICS v_locked = ROW_COUNT;
  RETURN v_locked;
END $$;

CREATE FUNCTION raffle_open_epoch(p_ends_at TIMESTAMPTZ, p_cap INT DEFAULT 1000)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE v_id BIGINT;
BEGIN
  INSERT INTO raffle_epochs (ends_at, cap) VALUES (p_ends_at, p_cap)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
