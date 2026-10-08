# Promotional Raffle & Referral Engine — Design

**Status:** proposed. **Scope:** off-chain entry ledger over two live Solana
programs (ORB game `G5yNWmz…`, ORE mining `oreV3EG1…`) plus ORB-token buys,
with a weekly / 1 000-entry epoch and a verifiable draw.

> **AMENDED 2026-10-07 — the ORB-token-buy source is withdrawn.** Owner
> decision. Everything below about buying ORB with SOL (§1, §1.2's
> balance-delta detector, the `orb_buy` source and `orb_raw` column in §4's
> schema, and the ORB-buy phase) is **historical rationale, not the shipped
> design**: there is no ORB SPL mint, so there is no balance to sum and no
> mainnet swap to capture as a fixture. Earned entries come from the ORB
> game, ORE mining, and manual purchases only. The authoritative statement
> of this amendment, with the full downstream list, is at the top of
> `../plans/2026-10-07-raffle-referral-engine-glm-directive.md`.
>
> §2 ("never price ORB") still stands, and is now trivially satisfied: the
> system never reads an ORB balance at all.

---

## 0. Two things to settle before any code

**0.1 Do not call the unit a "ticket".** `ticket` is already load-bearing
vocabulary in this repo: `Round.winning_ticket`, `PlayerEntry.ticket_start` /
`ticket_end`, `math/tickets.rs`, ADR-2 ("settlement records a *ticket*"). A
promo "ticket" table next to that is a guaranteed production incident the
first time someone greps. This document uses **entry** throughout, and the
schema is namespaced `raffle_*`.

**0.2 This is a sweepstakes.** Entries are earned by depositing SOL into
gambling programs and winners are drawn for a prize. That is a regulated
construct in most jurisdictions, and the usual mitigation (a free
alternative method of entry, excluded jurisdictions, published rules) is a
product decision, not an engineering one. Flagging once; the design below
proceeds as specified.

---

## 1. The ORB-price question — don't price anything

The brief asks how to value "0.05 SOL worth of ORB" without an oracle. The
answer is to **never value ORB at all**.

### 1.1 Measure the flow, not the balance

Qualify on the **SOL that left the wallet in a transaction that delivered
ORB**. The amount is already denominated in the unit we care about, at the
price the market actually cleared, inside an atomic transaction.

Every problem in the brief dissolves:

| brief's worry | why it disappears |
|---|---|
| "price moves right after the buy — do they still qualify?" | The qualifying fact is a past transaction. It cannot un-happen. |
| "continuous price lookups invite front-running" | No lookups. |
| "fresh AMM pools have edge cases" | We never read a pool. |
| oracle choice (Jupiter / Raydium / Birdeye) | Moot for qualification. |

**Pricing a balance is strictly worse and actively dangerous.** A balance
snapshot priced at time *T* creates a snapshot-timing attack: acquire ORB
just before *T*, qualify, dump after. That is precisely the flash-buy
problem the brief asks about — created by the pricing scheme, not solved by
it. A raw Raydium pool ratio is worse still: a flash loan moves it for one
slot at negligible cost.

**Fixed ORB quantity per epoch** (option b) is also rejected: it silently
re-denominates a SOL promise into a token promise. If ORB 10×s, the bar
becomes 0.5 SOL and nobody qualifies; if it halves, dust qualifies.

Jupiter's Quote API remains the right choice for **display** ("≈ $X") and
for any future hold-based reward, because it quotes an executable route
with depth rather than a spot ratio. It must never gate an entry.

### 1.2 The detection math — router-agnostic

Do **not** parse swap instructions. There are a dozen routers (Jupiter v6,
Raydium AMM/CLMM/CPMM, Orca Whirlpool, Meteora DLMM, Pump AMM, plus bot
frontends) and each is a separate decoder to maintain. Use the transaction's
**balance deltas**, which every router produces identically.

For wallet `W` in transaction `tx`:

```
i            = index of W in message.accountKeys
nativeDelta  = meta.postBalances[i] − meta.preBalances[i]        // negative when spending
fee          = (W is accountKeys[0]) ? meta.fee : 0              // already inside nativeDelta

wsolDelta    = Σ postTokenBalances[owner=W, mint=WSOL] − Σ preTokenBalances[owner=W, mint=WSOL]
orbDelta     = Σ postTokenBalances[owner=W, mint=ORB]  − Σ preTokenBalances[owner=W, mint=ORB]

solSpent     = −nativeDelta − fee − wsolDelta
```

`−wsolDelta` covers the case where the user swaps pre-existing wSOL, where
`nativeDelta` would only show the fee.

**Qualify when** `orbDelta > 0 AND solSpent ≥ ORB_BUY_MIN_LAMPORTS`.

Two guards:

- **Require an AMM in the transaction.** Assert `message.accountKeys`
  intersects a short allowlist of router program ids. This is presence-only
  — we never decode them — and it excludes a plain OTC transfer that happens
  to move SOL out and ORB in. The allowlist is config, not code.
- **ATA rent is counted as spend.** A first-ever ORB buy creates an ATA
  (1 488 440 lamports at the live 5 080/byte rate). It lands in
  `nativeDelta` and inflates `solSpent` by ~0.0015 SOL. Against a 0.05 SOL
  bar this errs toward the user by ~3% on exactly one transaction per
  wallet. Accept it; subtracting it is more code than it is worth.

**v1 limitation to state publicly:** buying ORB with USDC does not qualify.
The rule is "spent ≥ 0.05 SOL", literally.

### 1.3 The threshold

Raise 0.01 → **0.05 SOL**, as the brief proposes. The reasoning is the spam
ratio: at 0.01 SOL a bot pays ~0.0001 SOL of fees to mint an entry worth
1/1000 of the prize pool — a 100× leverage on dust. At 0.05 SOL, buying the
entire 1 000-entry epoch costs **50 SOL**, which is the real security
parameter. Keep it in config (`ORB_BUY_MIN_LAMPORTS`) so it can move without
a deploy.

---

## 2. Entry math

### 2.1 Cumulative, floor-divided, with carry

"1 SOL deployed = 1 entry" must be **cumulative per (wallet, source,
epoch)**, never per transaction. Per-transaction flooring awards nothing for
0.9 + 0.9 SOL, which users will correctly read as theft.

```
progress.cumulative_lamports += event.sol_lamports
target  = floor(progress.cumulative_lamports / LAMPORTS_PER_ENTRY)
grant   = target − progress.entries_awarded
```

`grant` may be 0 (sub-threshold accumulation) or >1 (a 3 SOL deposit). The
remainder persists in `cumulative_lamports` and carries **within** the epoch.
It does **not** carry across epochs — stated in the rules, reset at lock.

### 2.2 ORE: the per-square trap

`ore_api::Deploy.amount` is **per square**, not the total. The real spend is
`amount × popcount(mask)`. The `DeployEvent` carries both `amount` and
`total_squares`:

```
sol_lamports = event.amount × event.total_squares
```

Indexing `amount` alone **undercounts by up to 25×**. This is the same trap
that bit the ORE Lite planner; it reappears here and must be unit-tested.

Attribute to **`DeployEvent.authority`**, never `signer` — automation
deploys are sent by an executor on the user's behalf, and `signer` is the
executor.

### 2.3 ORB game

`Deposited.amount` and `AutoDeposited.amount` are plain lamports. For
`AutoDeposited`, attribute to the escrow **owner**, not the escrow PDA.

---

## 3. Integration: off-chain indexer, on-chain draw

### 3.1 Why not an on-chain companion

**ORE is a third-party program.** It cannot be made to CPI into our
contract, and we cannot upgrade it. That alone decides Program 2. The only
on-chain alternative is a user-signed "claim my entry" instruction, which
doubles the user's transaction count and makes them pay for our promotion.

Entries are a promotional ledger, not custody — no user funds sit in it.
The trust requirement is "the draw was fair", and that is solved in §3.3
without putting 1 000 rows on chain.

**Decision: off-chain indexer.** Helius webhooks → one Node/TS service →
Postgres.

### 3.2 Finality

Webhooks deliver at `confirmed`. Confirmed transactions can still be
dropped by a fork. **Entries are awarded only on `finalized`.**

- Webhook arrives → insert `raffle_events` row with `status='pending'`.
- A reconciler polls `getSignatureStatuses` for pending rows; on
  `finalized` it promotes to `status='finalized'` **and awards in the same
  database transaction**; on absence past N slots it marks `voided`.

This also gives free replay-safety: the award path runs exactly once, from
one place, guarded by the unique constraint.

### 3.3 A verifiable draw without an oracle

Commit–reveal against a future slot hash. No VRF cost, no trusted RNG:

1. **At lock**: build the canonical entry list ordered by `entry_no`,
   compute `merkle_root`, choose `target_slot = current_slot + 1200`
   (~8 min ahead), and publish `(epoch_id, merkle_root, target_slot)` in a
   **memo transaction on mainnet**. The on-chain timestamp proves the root
   existed before the slot did.
2. **After `target_slot`**: read its blockhash.
   `winner_no = u64_le(sha256(merkle_root ‖ blockhash)) mod entries_issued + 1`.
3. Publish the full entry list; anyone can recompute the root and the index.

The alternative — reusing the Switchboard On-Demand pipeline already wired
into the ORB program — is strictly more expensive (§Phase 12.6 measured
~6.0 M lamports per randomness account, with rent that currently strands)
and buys nothing here, because a once-weekly draw has no settlement-latency
requirement. **Recommend commit–reveal.**

---

## 4. Anti-gaming

### 4.1 Flash-buy-and-dump → hold-through-lock

An ORB-buy entry is **provisional** until the epoch locks. At lock, for every
wallet holding provisional ORB-buy entries, read the current ORB balance in
one batched pass (`getMultipleAccountsInfo`, 100 ATAs per call):

```
if (orb_balance_now < Σ orb_amount bought this epoch)  → void those entries
else                                                    → confirm
```

This is a **quantity** check against what the wallet itself bought — not a
price snapshot — so it has no manipulation surface. Cost at 1 000 entries is
a handful of RPC calls, once a week.

Tradeoff to state in the rules: a user who buys, qualifies, then legitimately
sells before lock loses the entry. The softer alternative (vest after N hours
of continuous holding) needs balance polling for every candidate and is not
worth it at v1 scale.

Game and mining entries need no such check — that SOL is already committed
to a program and at risk.

### 4.2 Referrals are the real sybil surface

Game/mining entries are self-limiting: an attacker buying the epoch pays
1 000 SOL of real deposits. Referral bonuses are where free entries leak.

- Referral bonus fires **only on the referee's first qualifying event**, and
  only when that event is ≥ `REFERRAL_MIN_LAMPORTS` (recommend 1 SOL).
- **Cap referral entries per referrer per epoch** at `REFERRAL_CAP` —
  recommend 25, i.e. 2.5% of the pool.
- Reject `ref == wallet`.
- Reject when the referrer wallet's **first funder** is the referee (or vice
  versa) — one hop, one `getSignaturesForAddress` lookup at attribution
  time. Cheap, and it kills the lazy sybil.
- Attribution is **first-touch and immutable**: `wallets.referred_by` is set
  once and never updated.

### 4.3 Signature deduplication

`UNIQUE (signature, event_index)` — **not** `UNIQUE (signature)`. One
transaction can legitimately carry several qualifying events (an ORB deposit
and an ORE deploy; a batched auto-deposit). Keying on signature alone
silently drops entries users earned.

Award inside the same database transaction as the insert, with
`ON CONFLICT DO NOTHING`, so a redelivered webhook is a no-op.

### 4.4 The 999 race

Serialize on the epoch row. `SELECT … FROM raffle_epochs WHERE id = $1 AND
status='open' FOR UPDATE` before any award; everything else happens inside
that lock. At 1 000 entries/week the contention is irrelevant.

**Partial award is an explicit product decision**: a 3-entry event arriving
at 998 issued grants **2** and the shortfall is recorded in
`raffle_progress.carried_out`, credited to the next epoch. Silently dropping
the third, or overflowing to 1 002, are both worse. The function in §5
implements grant-up-to-cap and locks the epoch in the same statement.

The weekly timer uses the identical lock and is idempotent
(`WHERE status='open'`), so cap-lock and timer-lock cannot both fire.

---

## 5. PostgreSQL schema

```sql
-- ─── epochs ────────────────────────────────────────────────────────────
CREATE TABLE raffle_epochs (
  id               BIGSERIAL PRIMARY KEY,
  status           TEXT NOT NULL CHECK (status IN ('open','locked','drawn')),
  starts_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at          TIMESTAMPTZ NOT NULL,
  cap              INTEGER NOT NULL DEFAULT 1000,
  entries_issued   INTEGER NOT NULL DEFAULT 0,
  locked_at        TIMESTAMPTZ,
  lock_reason      TEXT CHECK (lock_reason IN ('cap','timer')),
  CONSTRAINT cap_respected CHECK (entries_issued BETWEEN 0 AND cap)
);
-- at most one open epoch, enforced by the database
CREATE UNIQUE INDEX raffle_one_open_epoch ON raffle_epochs (status)
  WHERE status = 'open';

-- ─── wallets & referral attribution ────────────────────────────────────
CREATE TABLE raffle_wallets (
  pubkey        TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  referred_by   TEXT REFERENCES raffle_wallets(pubkey),
  referred_at   TIMESTAMPTZ,
  CONSTRAINT no_self_referral CHECK (referred_by IS NULL OR referred_by <> pubkey)
);
CREATE INDEX ON raffle_wallets (referred_by);

-- ─── the dedup ledger ──────────────────────────────────────────────────
CREATE TABLE raffle_events (
  id            BIGSERIAL PRIMARY KEY,
  signature     TEXT        NOT NULL,
  event_index   SMALLINT    NOT NULL,
  slot          BIGINT      NOT NULL,
  block_time    TIMESTAMPTZ,
  source        TEXT        NOT NULL CHECK (source IN ('orb_game','ore_mining','orb_buy')),
  wallet        TEXT        NOT NULL REFERENCES raffle_wallets(pubkey),
  epoch_id      BIGINT      NOT NULL REFERENCES raffle_epochs(id),
  sol_lamports  BIGINT      NOT NULL CHECK (sol_lamports > 0),
  orb_raw       NUMERIC(40,0),                        -- orb_buy only
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','finalized','voided')),
  void_reason   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (signature, event_index)                     -- §4.3
);
CREATE INDEX ON raffle_events (status, slot);
CREATE INDEX ON raffle_events (epoch_id, wallet, source);

-- ─── per-wallet accumulation (the floor-division carry, §2.1) ──────────
CREATE TABLE raffle_progress (
  epoch_id            BIGINT  NOT NULL REFERENCES raffle_epochs(id),
  wallet              TEXT    NOT NULL REFERENCES raffle_wallets(pubkey),
  source              TEXT    NOT NULL,
  cumulative_lamports BIGINT  NOT NULL DEFAULT 0,
  entries_awarded     INTEGER NOT NULL DEFAULT 0,
  carried_out         INTEGER NOT NULL DEFAULT 0,     -- owed, cap was hit
  PRIMARY KEY (epoch_id, wallet, source)
);

-- ─── entries (the raffle unit — never "ticket", §0.1) ──────────────────
CREATE TABLE raffle_entries (
  id           BIGSERIAL PRIMARY KEY,
  epoch_id     BIGINT  NOT NULL REFERENCES raffle_epochs(id),
  entry_no     INTEGER NOT NULL,
  wallet       TEXT    NOT NULL REFERENCES raffle_wallets(pubkey),
  source       TEXT    NOT NULL CHECK (source IN ('orb_game','ore_mining','orb_buy','referral')),
  origin_event BIGINT  REFERENCES raffle_events(id),
  referee      TEXT    REFERENCES raffle_wallets(pubkey),   -- referral rows only
  status       TEXT    NOT NULL DEFAULT 'confirmed'
                       CHECK (status IN ('provisional','confirmed','voided')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (epoch_id, entry_no)
);
CREATE INDEX ON raffle_entries (epoch_id, wallet);
CREATE INDEX ON raffle_entries (epoch_id, status) WHERE status = 'provisional';

-- ─── the draw ──────────────────────────────────────────────────────────
CREATE TABLE raffle_draws (
  epoch_id       BIGINT PRIMARY KEY REFERENCES raffle_epochs(id),
  merkle_root    BYTEA  NOT NULL,
  target_slot    BIGINT NOT NULL,
  commit_sig     TEXT   NOT NULL,          -- the on-chain memo tx
  slot_blockhash TEXT,
  winning_no     INTEGER,
  winner_wallet  TEXT REFERENCES raffle_wallets(pubkey),
  drawn_at       TIMESTAMPTZ
);
```

### 5.1 The award function — §4.4 in one atomic statement

```sql
CREATE FUNCTION raffle_award(
  p_epoch BIGINT, p_wallet TEXT, p_source TEXT,
  p_event BIGINT, p_want INT, p_status TEXT DEFAULT 'confirmed'
) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE v_issued INT; v_cap INT; v_grant INT;
BEGIN
  SELECT entries_issued, cap INTO v_issued, v_cap
    FROM raffle_epochs WHERE id = p_epoch AND status = 'open' FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;                 -- already locked

  v_grant := LEAST(p_want, v_cap - v_issued);
  IF v_grant <= 0 THEN RETURN 0; END IF;

  INSERT INTO raffle_entries (epoch_id, entry_no, wallet, source, origin_event, status)
  SELECT p_epoch, v_issued + g, p_wallet, p_source, p_event, p_status
    FROM generate_series(1, v_grant) AS g;

  UPDATE raffle_epochs SET entries_issued = entries_issued + v_grant
   WHERE id = p_epoch;

  IF v_issued + v_grant >= v_cap THEN
    UPDATE raffle_epochs
       SET status = 'locked', locked_at = now(), lock_reason = 'cap'
     WHERE id = p_epoch;
  END IF;

  RETURN v_grant;                                      -- caller carries p_want − v_grant
END $$;
```

---

## 6. Stack

| concern | choice | why |
|---|---|---|
| ingestion | **Helius webhooks**, one endpoint per program + one for the ORB mint | no polling, no gRPC ops burden at this volume |
| service | **one Node/TS worker** in the existing monorepo (`apps/raffle`) | reuses `@orbit-jackpot/sdk`'s `parseEventInstruction` for ORB events verbatim |
| database | **Postgres** (Neon or Supabase) | the entire design is one `FOR UPDATE` away from correct |
| frontend | existing Vercel app: `/?ref=` capture + leaderboard | no new surface |
| queue / Redis | **none** | 1 000 entries/week. Add only when measurement demands it. |
| oracle / price feed | **none** (Jupiter Quote for display only) | §1 |

Reuse, not rebuild: ORB events decode with the existing SDK. ORE needs one
small `DeployEvent` decoder — the layout is in
the implementation plan `2026-10-07-ore-lite-standalone-glm-directive.md` (not published) §3.

---

## 7. Implementation plan

**P0 — schema + epoch lifecycle.** Tables, `raffle_award`, the open/lock/
timer state machine. Tests: the 999 race under concurrency (two sessions,
one epoch), partial award + carry, timer and cap lock mutual exclusion,
the one-open-epoch index.

**P1 — ORB game indexer.** Helius webhook → `Deposited` / `AutoDeposited`
via the existing SDK decoder → pending rows. Tests: `AutoDeposited`
attributes to the escrow owner; replayed webhook is a no-op.

**P2 — finality reconciler.** Pending → finalized → award, in one database
transaction. Tests: a dropped (never-finalized) signature voids and awards
nothing.

**P3 — ORE mining indexer.** `DeployEvent` decoder. **Test first:**
`sol_lamports == amount × total_squares`, and attribution to `authority`
rather than `signer` on an automation deploy.

**P4 — ORB buy detector.** Balance-delta math (§1.2) + AMM allowlist.
Tests built from **real mainnet transactions** captured as fixtures: a
Jupiter route, a direct Raydium swap, a wSOL-funded swap, a first-buy with
ATA creation, and a plain transfer that must *not* qualify.

**P5 — referrals.** `/?ref=` capture → localStorage → bind on first wallet
connect. First-touch immutable, self-referral and one-hop-funding rejected,
per-referrer cap.

**P6 — hold-through check + lock.** Batched ORB balance read at lock;
provisional → confirmed or voided.

**P7 — draw.** Merkle root, on-chain memo commit, slot-hash reveal, public
verification page.

**P8 — leaderboard + rules page.** Including the §0.2 terms and the §1.3
"SOL-denominated buys only" limitation.

---

## 8. Open decisions for the product owner

1. **Entry carry across epochs** — recommended **no**; sub-threshold
   remainders reset at lock. Cheaper to explain, cheaper to audit.
2. **`REFERRAL_CAP`** — recommended 25 per referrer per epoch.
3. **Hold-through strictness** — recommended void-on-sell at lock; the
   gentler vesting rule costs continuous balance polling.
4. **Free entry method** — required in several jurisdictions (§0.2); the
   schema supports it today as a fourth `source` with no other change.
