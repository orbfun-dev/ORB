-- ORB Raffle & Referral Engine — the draw (directive §6.5, §6.6).
--
-- The 2026-10-07 amendment retires the ORB token buy, so there are no
-- provisional entries and §6.5's hold-through balance check is vacuous —
-- it is intentionally absent. Lock = mark the epoch + snapshot the draw
-- commitment; the reveal is a pure function of (merkle_root, blockhash).

-- Commit a locked epoch's draw: the merkle root over the canonical
-- entry list, the future reveal slot, and the on-chain memo signature
-- that proves the root predated the slot (R8's publish-or-it-didn't-
-- happen discipline, applied to the draw).
CREATE FUNCTION raffle_record_draw(
  p_epoch BIGINT, p_root BYTEA, p_target_slot BIGINT, p_commit_sig TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO raffle_draws (epoch_id, merkle_root, target_slot, commit_sig)
  VALUES (p_epoch, p_root, p_target_slot, p_commit_sig);
END $$;

-- Locked epochs whose reveal slot has passed and whose winner is not
-- yet computed; `p_now_slot` comes from the chain.
CREATE FUNCTION raffle_draws_pending(p_now_slot BIGINT)
RETURNS TABLE (epoch_id BIGINT, merkle_root BYTEA, target_slot BIGINT,
               commit_sig TEXT, entries_issued INT)
LANGUAGE sql STABLE AS $$
  SELECT d.epoch_id, d.merkle_root, d.target_slot, d.commit_sig, e.entries_issued
    FROM raffle_draws d
    JOIN raffle_epochs e ON e.id = d.epoch_id
   WHERE e.status = 'locked'
     AND d.winning_no IS NULL
     AND d.target_slot <= p_now_slot
$$;

CREATE FUNCTION raffle_set_draw_result(
  p_epoch BIGINT, p_blockhash TEXT, p_winning_no INT, p_winner TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE raffle_draws
     SET slot_blockhash = p_blockhash,
         winning_no     = p_winning_no,
         winner_wallet  = p_winner,
         drawn_at       = now()
   WHERE epoch_id = p_epoch;
END $$;

-- An epoch nobody entered. The timer locks any expired open epoch
-- regardless of entries_issued (raffle_lock_expired_epochs makes no
-- exception), so a quiet week produces a locked epoch with an empty
-- entry list — and there is no merkle root over nothing and no
-- `mod 0` to draw with. Resolve it here instead: 'drawn' with no
-- raffle_draws row is the honest record of "no entries, no winner",
-- and it stops the commit scan from returning the epoch forever.
--
-- Only ever reachable by the timer: a cap-lock implies entries_issued
-- = cap > 0. The entries_issued = 0 predicate is the safety belt.
CREATE FUNCTION raffle_finalize_empty_epoch(p_epoch BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_rows INT;
BEGIN
  UPDATE raffle_epochs
     SET status = 'drawn'
   WHERE id = p_epoch AND status = 'locked' AND entries_issued = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $$;
