-- ORB Raffle — one commitment per epoch, and a reveal no skipped slot
-- can stall (AUDIT R-7, R-8).
--
-- R-8: the lock used to send the commit memo, wait for it to finalize,
-- and only then insert the draw row. A timeout between the two left a
-- landed memo and no row, and the next pass committed again with a new
-- target_slot — two valid commitments for one epoch. Now the row is
-- reserved FIRST, carrying the signature of the already-signed memo and
-- the last block height its blockhash is valid for. The memo is sent
-- after the row exists. A later pass either sees that exact signature
-- finalize (confirm), or proves it can never land — not found and the
-- finalized block height is past its last valid height — and only then
-- signs a replacement. At most one memo per epoch ever lands.
--
-- R-7: the reveal is the first block AT OR AFTER target_slot, not the
-- block AT it — a skipped slot (2–5 % of mainnet slots) has no block.
-- block_slot records which block that was.
--
-- Backward compatible on purpose: commit_confirmed defaults to true, so
-- the 4-argument raffle_record_draw (code deployed before this file)
-- still writes a row that draws — it only wrote after finalization.

ALTER TABLE raffle_draws ADD COLUMN commit_confirmed BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE raffle_draws ADD COLUMN commit_last_valid_height BIGINT;
ALTER TABLE raffle_draws ADD COLUMN block_slot BIGINT;

-- Reserve the draw before the memo is sent. False when another pass
-- already reserved this epoch: that pass owns the send, this one must
-- not send anything.
CREATE FUNCTION raffle_reserve_draw(
  p_epoch BIGINT, p_root BYTEA, p_target_slot BIGINT,
  p_commit_sig TEXT, p_last_valid_height BIGINT
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_rows INT;
BEGIN
  INSERT INTO raffle_draws
    (epoch_id, merkle_root, target_slot, commit_sig, commit_confirmed, commit_last_valid_height)
  VALUES (p_epoch, p_root, p_target_slot, p_commit_sig, false, p_last_valid_height)
  ON CONFLICT (epoch_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $$;

-- Reserved draws whose memo has not been seen finalized yet.
CREATE FUNCTION raffle_draws_unconfirmed()
RETURNS TABLE (epoch_id BIGINT, merkle_root BYTEA, target_slot BIGINT,
               commit_sig TEXT, commit_last_valid_height BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT d.epoch_id, d.merkle_root, d.target_slot, d.commit_sig, d.commit_last_valid_height
    FROM raffle_draws d
    JOIN raffle_epochs e ON e.id = d.epoch_id
   WHERE e.status = 'locked' AND NOT d.commit_confirmed
   ORDER BY d.epoch_id
$$;

-- The reserved memo finalized. Matches on the signature, so a stale
-- pass cannot confirm a signature that was since replaced.
CREATE FUNCTION raffle_confirm_draw_commit(p_epoch BIGINT, p_commit_sig TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_rows INT;
BEGIN
  UPDATE raffle_draws SET commit_confirmed = true
   WHERE epoch_id = p_epoch AND commit_sig = p_commit_sig AND NOT commit_confirmed;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $$;

-- The reserved memo provably never landed: swap in a freshly signed
-- one. Compare-and-swap on the old signature; the root never changes.
CREATE FUNCTION raffle_replace_draw_commit(
  p_epoch BIGINT, p_old_sig TEXT, p_new_sig TEXT,
  p_target_slot BIGINT, p_last_valid_height BIGINT
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_rows INT;
BEGIN
  UPDATE raffle_draws
     SET commit_sig = p_new_sig,
         target_slot = p_target_slot,
         commit_last_valid_height = p_last_valid_height
   WHERE epoch_id = p_epoch AND commit_sig = p_old_sig AND NOT commit_confirmed;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $$;

-- A draw is revealable only once its commitment is on chain.
CREATE OR REPLACE FUNCTION raffle_draws_pending(p_now_slot BIGINT)
RETURNS TABLE (epoch_id BIGINT, merkle_root BYTEA, target_slot BIGINT,
               commit_sig TEXT, entries_issued INT)
LANGUAGE sql STABLE AS $$
  SELECT d.epoch_id, d.merkle_root, d.target_slot, d.commit_sig, e.entries_issued
    FROM raffle_draws d
    JOIN raffle_epochs e ON e.id = d.epoch_id
   WHERE e.status = 'locked'
     AND d.commit_confirmed
     AND d.winning_no IS NULL
     AND d.target_slot <= p_now_slot
   ORDER BY d.epoch_id
$$;

-- The reveal, with the slot of the block it used. Writes once: a result
-- already recorded is never overwritten.
CREATE FUNCTION raffle_record_draw_result(
  p_epoch BIGINT, p_block_slot BIGINT, p_blockhash TEXT, p_winning_no INT, p_winner TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_rows INT;
BEGIN
  UPDATE raffle_draws
     SET block_slot     = p_block_slot,
         slot_blockhash = p_blockhash,
         winning_no     = p_winning_no,
         winner_wallet  = p_winner,
         drawn_at       = now()
   WHERE epoch_id = p_epoch AND commit_confirmed AND winning_no IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $$;

-- ─── R1 lockdown (007's rule: every new raffle_ function locks itself) ─
DO $lockdown$
DECLARE
  f REGPROCEDURE;
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
END $lockdown$;
