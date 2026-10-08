-- ORB Raffle & Referral Engine — tables (directive §5, verbatim).
--
-- R9: every table is prefixed `raffle_`; the unit is an "entry", never a
-- "ticket" (`ticket` is load-bearing vocabulary in the on-chain program:
-- Round.winning_ticket, PlayerEntry.ticket_start/ticket_end, math/tickets.rs).
--
-- R6: the dedup ledger keys on (signature, event_index) — one transaction
-- can legitimately carry several qualifying events; UNIQUE (signature)
-- would silently destroy entries users earned.

-- ─── epochs ────────────────────────────────────────────────────────────
CREATE TABLE raffle_epochs (
  id             BIGSERIAL PRIMARY KEY,
  -- Directive §5 omits the default; every lifecycle path (§6.5 step 3,
  -- raffle_open_epoch) inserts a fresh epoch, which must start open.
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','locked','drawn')),
  starts_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at        TIMESTAMPTZ NOT NULL,
  cap            INTEGER NOT NULL DEFAULT 1000,
  entries_issued INTEGER NOT NULL DEFAULT 0,
  purchased_issued INTEGER NOT NULL DEFAULT 0,
  locked_at      TIMESTAMPTZ,
  lock_reason    TEXT CHECK (lock_reason IN ('cap','timer')),
  CONSTRAINT cap_respected CHECK (entries_issued BETWEEN 0 AND cap)
);
CREATE UNIQUE INDEX raffle_one_open_epoch
  ON raffle_epochs (status) WHERE status = 'open';

-- ─── wallets & referral attribution ────────────────────────────────────
CREATE TABLE raffle_wallets (
  pubkey        TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  referred_by   TEXT REFERENCES raffle_wallets(pubkey),
  referred_at   TIMESTAMPTZ,
  CONSTRAINT no_self_referral CHECK (referred_by IS NULL OR referred_by <> pubkey)
);
CREATE INDEX ON raffle_wallets (referred_by);

-- ─── ORB round outcomes (R3's gate; directive §6.2) ─────────────────────
-- `close_round` deletes the round account, so a late claim cannot read
-- `state` from the chain. The cache is filled by the round-outcome job
-- before that happens; claims gate on THIS table, not on the chain.
CREATE TABLE raffle_orb_rounds (
  round_id   BIGINT PRIMARY KEY,
  state      TEXT NOT NULL CHECK (state IN ('open','locked','awaiting','settled','cancelled')),
  reason     SMALLINT,                 -- RoundCancelled.reason: 1 sole depositor, 2 oracle timeout
  decided_at TIMESTAMPTZ,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── the dedup ledger ──────────────────────────────────────────────────
CREATE TABLE raffle_events (
  id           BIGSERIAL PRIMARY KEY,
  signature    TEXT        NOT NULL,
  event_index  SMALLINT    NOT NULL,
  slot         BIGINT      NOT NULL,
  block_time   TIMESTAMPTZ,
  -- 2026-10-07 amendment: the ORB token buy source is retired; entries
  -- come from the game, ORE mining, and manual purchases only.
  source       TEXT        NOT NULL
                 CHECK (source IN ('orb_game','ore_mining','purchase')),
  wallet       TEXT        NOT NULL REFERENCES raffle_wallets(pubkey),
  epoch_id     BIGINT      NOT NULL REFERENCES raffle_epochs(id),
  sol_lamports BIGINT      NOT NULL CHECK (sol_lamports > 0),
  orb_round_id BIGINT,                 -- orb_game only: the R3 gate
  status       TEXT        NOT NULL DEFAULT 'accepted'
                 CHECK (status IN ('accepted','rejected')),
  reject_reason TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (signature, event_index)                               -- R6
);
CREATE INDEX ON raffle_events (epoch_id, wallet, source);

-- ─── accrual carry (R5) ────────────────────────────────────────────────
CREATE TABLE raffle_progress (
  epoch_id            BIGINT  NOT NULL REFERENCES raffle_epochs(id),
  wallet              TEXT    NOT NULL REFERENCES raffle_wallets(pubkey),
  source              TEXT    NOT NULL,
  cumulative_lamports BIGINT  NOT NULL DEFAULT 0,
  entries_awarded     INTEGER NOT NULL DEFAULT 0,
  carried_out         INTEGER NOT NULL DEFAULT 0,   -- owed but the cap was hit
  PRIMARY KEY (epoch_id, wallet, source)
);

-- ─── entries (R9: never "tickets") ─────────────────────────────────────
CREATE TABLE raffle_entries (
  id           BIGSERIAL PRIMARY KEY,
  epoch_id     BIGINT  NOT NULL REFERENCES raffle_epochs(id),
  entry_no     INTEGER NOT NULL,
  wallet       TEXT    NOT NULL REFERENCES raffle_wallets(pubkey),
  source       TEXT    NOT NULL
                 CHECK (source IN ('orb_game','ore_mining','purchase','referral')),
  origin_event BIGINT  REFERENCES raffle_events(id),
  referee      TEXT    REFERENCES raffle_wallets(pubkey),
  status       TEXT    NOT NULL DEFAULT 'confirmed'
                 CHECK (status IN ('provisional','confirmed','voided')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (epoch_id, entry_no)
);
CREATE INDEX ON raffle_entries (epoch_id, wallet);
CREATE INDEX ON raffle_entries (epoch_id, status) WHERE status = 'provisional';

-- ─── buyback transparency (R8) ─────────────────────────────────────────
CREATE TABLE raffle_buybacks (
  id             BIGSERIAL PRIMARY KEY,
  epoch_id       BIGINT NOT NULL REFERENCES raffle_epochs(id),
  signature      TEXT NOT NULL UNIQUE,
  sol_in         BIGINT NOT NULL,
  orb_out        NUMERIC(40,0) NOT NULL,
  executed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── the draw ──────────────────────────────────────────────────────────
CREATE TABLE raffle_draws (
  epoch_id       BIGINT PRIMARY KEY REFERENCES raffle_epochs(id),
  merkle_root    BYTEA  NOT NULL,
  target_slot    BIGINT NOT NULL,
  commit_sig     TEXT   NOT NULL,
  slot_blockhash TEXT,
  winning_no     INTEGER,
  winner_wallet  TEXT REFERENCES raffle_wallets(pubkey),
  drawn_at       TIMESTAMPTZ
);
