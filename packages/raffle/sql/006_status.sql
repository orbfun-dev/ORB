-- ORB Raffle & Referral Engine — public read surface (directive §7 P9).
--
-- The directive's §6 specifies four write endpoints and no read ones,
-- but P9 asks for a leaderboard and an epoch progress bar, which have
-- nothing to call. These are those reads.
--
-- All three are STABLE and take only an epoch id, a wallet, or a limit
-- — the browser reaches them through /api/raffle/status, never
-- directly (R1), and they expose nothing a draw does not already
-- publish: entry counts and the wallets holding them.
--
-- The purchase ceiling is derived with the SAME expression
-- raffle_award enforces it with, GUC and fallback included. If the two
-- ever drift, the UI advertises a cap the database does not apply,
-- which is worse than showing no cap at all.

-- The epoch the UI should be showing. Prefers the open epoch; falls
-- back to the most recent one so the page can say "drawing" during the
-- gap between a lock and the next open, instead of rendering empty.
CREATE FUNCTION raffle_epoch_status()
RETURNS TABLE (
  epoch_id         BIGINT,
  status           TEXT,
  cap              INT,
  entries_issued   INT,
  purchased_issued INT,
  purchase_cap     INT,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ
) LANGUAGE sql STABLE AS $$
  SELECT e.id, e.status, e.cap, e.entries_issued, e.purchased_issued,
         (e.cap * COALESCE(
            NULLIF(current_setting('raffle.purchase_cap_bps', true), '')::INT,
            3000)) / 10000,
         e.starts_at, e.ends_at
    FROM raffle_epochs e
   ORDER BY (e.status = 'open') DESC, e.id DESC
   LIMIT 1
$$;

-- Entries per wallet for one epoch, biggest first. Ties break on the
-- earliest entry, so the order is total and never reshuffles between
-- polls for wallets sitting on the same count.
CREATE FUNCTION raffle_leaderboard(p_epoch BIGINT, p_limit INT DEFAULT 10)
RETURNS TABLE (wallet TEXT, entries BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT e.wallet, count(*)
    FROM raffle_entries e
   WHERE e.epoch_id = p_epoch AND e.status <> 'voided'
   GROUP BY e.wallet
   ORDER BY count(*) DESC, min(e.entry_no)
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 100)
$$;

-- One wallet's entries for an epoch, split by how they were earned —
-- the "your entries" panel. Returns no rows for a wallet with none.
CREATE FUNCTION raffle_wallet_summary(p_epoch BIGINT, p_wallet TEXT)
RETURNS TABLE (source TEXT, entries BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT e.source, count(*)
    FROM raffle_entries e
   WHERE e.epoch_id = p_epoch AND e.wallet = p_wallet AND e.status <> 'voided'
   GROUP BY e.source
   ORDER BY e.source
$$;

-- 003 granted what existed when it ran; these came later.
DO $grants$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION raffle_epoch_status() TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION raffle_leaderboard(BIGINT, INT) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION raffle_wallet_summary(BIGINT, TEXT) TO service_role';
  END IF;
END $grants$;
