# Raffle & Referral Engine — Ops Runbook

Operating the off-chain entry ledger: deployment, the three background
jobs, epoch rollover, draw verification, and the failures worth knowing
in advance.

- **Design rationale:** [`../design/2026-10-07-raffle-referral-engine-design.md`](../design/2026-10-07-raffle-referral-engine-design.md)
- **Code:** `packages/raffle/` (engine + SQL), `api/raffle/` (Vercel functions), `scripts/raffle/` (migrate, verify-draw)

> **The one-line summary of the security model.** The browser holds no
> database credential of any kind. It POSTs a transaction signature to
> `/api/raffle/*`; the server fetches that transaction at `finalized`
> commitment and derives every number from the chain. A request that
> merely *carries* an `amount` or `entries` field is rejected with 400
> before anything else happens.

---

## 1. First deployment

### 1.1 Database

Migrations live in `packages/raffle/sql/` and are applied by a runner
that tracks what it has applied:

```bash
# Supabase: Project Settings → Database → Connection string → URI.
# Use the DIRECT connection, not the pooler — these are DDL.
export DATABASE_URL='postgresql://postgres:…@db.….supabase.co:5432/postgres'

npx tsx scripts/raffle/migrate.ts --dry-run   # what would run
npx tsx scripts/raffle/migrate.ts             # run it
```

| file | what it does |
|---|---|
| `001_tables.sql` | the tables, the one-open-epoch index, the `(signature, event_index)` dedup key |
| `002_functions.sql` | `raffle_award` and friends — the `FOR UPDATE` award, accrual with carry, the caps |
| `003_lockdown.sql` | revokes everything from `anon` and `authenticated`; grants to `service_role` only |
| `004_draw.sql` | draw commitment, the reveal, the empty-epoch resolver |
| `005_cron.sql` | `raffle_ops_config` + the three `pg_cron` schedules |
| `006_status.sql` | the public reads behind `/api/raffle/status` |
| `007_function_lockdown.sql` | revokes `EXECUTE` on every `raffle_` function from `PUBLIC` (which 003 missed — on Supabase `anon` could call `raffle_ops_endpoint` and read the cron secret); RLS on every `raffle_` table |

**The runner never re-runs an applied file, and refuses to run at all if
an applied file has changed on disk.** That check exists because editing
an applied migration is the one mistake nothing else in the stack would
catch — the database and the repo would simply disagree, silently. To
change shipped SQL, add a new numbered file.

### 1.2 Extensions

`005_cron.sql` needs `pg_cron` and `pg_net`. Without them it prints a
notice and schedules nothing — which is exactly what happens on the
local test database, deliberately, and is also what happens on Supabase
if you forget. Enable both under Database → Extensions, then re-run the
scheduling block:

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;
-- WITH SCHEMA: without it pg_net registers under public and the
-- Supabase security advisor flags it (lint 0014). Its functions live
-- in `net` either way.
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
```

Because `005` will already be recorded as applied, re-run its DO block by
hand or add a new numbered file. Confirm:

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'raffle-%';
```

### 1.3 Function environment

Set everything in `api/.env.example` in the Vercel project. Three of
them will stop the raffle dead if wrong:

- `SUPABASE_SERVICE_ROLE_KEY` — bypasses RLS by design; the lockdown
  grants the tables to `service_role` and nobody else.
- `SOLANA_RPC_URL` — a dedicated mainnet endpoint. Every claim is a
  `getTransaction` at `finalized`.
- `RAFFLE_CRON_SECRET` — must match `raffle_ops_config.cron_secret`.
- `RAFFLE_ORE_FEE_RECIPIENT` — the web app's `VITE_ORE_FEE_RECIPIENT`,
  exactly. Its history is the only source of ORE entries (§2.1); a
  wrong value means nobody earns from ORE, an unset one makes the
  indexer 500. `RAFFLE_ORE_FEE_BPS` / `_MIN_LAMPORTS` / `_MAX_LAMPORTS`
  default to the page's fee and only need setting if the page's
  `PLATFORM_FEE` changes.

### 1.4 Point pg_cron at the deployment

The cron jobs cannot read the Vercel environment, so the base URL and
the secret live in the database:

```sql
INSERT INTO raffle_ops_config (key, value) VALUES
  ('function_base_url', 'https://your-deployment.vercel.app'),
  ('cron_secret',       'the-same-value-as-RAFFLE_CRON_SECRET')
ON CONFLICT (key) DO UPDATE
  SET value = excluded.value, updated_at = now();
```

Until both rows exist the jobs run and do nothing — `raffle_ops_endpoint()`
returns no rows, so each job body is a no-op. That is intentional: an
unconfigured install is quiet rather than logging a failed HTTP post
every 30 seconds.

### 1.5 Open the first epoch

```sql
SELECT raffle_open_epoch((now() + interval '7 days')::timestamptz, 1000);
```

Only one epoch may be open at a time — a unique partial index enforces
it, so a second call fails rather than splitting entries across two.

---

## 2. The jobs

| job | every | endpoint | why it matters |
|---|---|---|---|
| `raffle-round-cache` | 30 s | `/api/raffle/cron/round-cache` | **Time-critical.** `close_round` *deletes* the round account, so a state not cached before then cannot be read from the chain again. |
| `raffle-epoch-lock` | 1 min | `/api/raffle/cron/epoch-lock` | Timer-locks expired epochs, commits each one's draw, opens the next. |
| `raffle-draw` | 1 min | `/api/raffle/cron/draw` | Reveals locked epochs whose target slot has passed. |
| `raffle-ore-indexer` | 30 s | `/api/raffle/cron/ore-indexer` | **The only source of ORE entries.** Walks the fee wallet's history and awards deploys made through playorb (§2.1). Scheduled by `008_ore_indexer.sql`. |

> **`raffle-round-cache` is unscheduled in production (2026-10-08).**
> The server verifies on mainnet (`SOLANA_RPC_URL`), where ORE mining
> and purchases live, but the ORB wheel is still on devnet: the job
> would read a program that does not exist there every 30 s, and no
> wheel claim can be verified anyway (the web app stops offering them —
> `ORB_GAME_CLAIMS_LIVE` in `apps/web/src/features/raffle/claimable.ts`).
> When ORB ships on mainnet, re-run 005's schedule block (it unschedules
> then reschedules, so it is safe to replay) and give ORB rounds a way
> to reach the claim endpoint — the web app's claim card and signature
> shelf were removed on 2026-10-08 along with ORE claims.

### 2.1 ORE entries: the fee-wallet indexer

Owner decision, 2026-10-08: **only ORE deploys made through playorb earn
entries.** A claim cannot prove that, so ORE is not claimable any more —
`POST /api/raffle/claim` with an ORE deploy answers
`200 {awarded: 0, reason: "ore_deploys_are_indexed"}` and writes nothing.

Every deploy the ORE tab builds carries a `SystemProgram.transfer` of the
platform fee to `RAFFLE_ORE_FEE_RECIPIENT` inside the same atomic
transaction. `raffle-ore-indexer` lists that wallet's signatures newer
than its cursor (`raffle_indexer_cursors`, row `ore_fee_payments`),
oldest first, and for each one awards the deploy when:

- the fee payer is the deploy's `authority` (the wallet that earns), and
- the fee paid is at least the page's own fee on that spend (1%, floor
  0.0001 SOL, ceiling 0.05 SOL).

Automation deploys pay no fee and never earn. Deploys older than the
first epoch's `starts_at` are passed over. Awards go to the epoch open
when the deploy is indexed; with none open the run stops and retries.
Up to 40 transactions per run; a replay is a no-op (the ledger dedups on
`(signature, event_index)`), so wiping the cursor is safe — it just
re-reads history back to launch.

The response body says what happened:

```sql
SELECT created, status_code, content::jsonb ->> 'status' AS run,
       content::jsonb -> 'awarded' AS awarded, content::jsonb -> 'skipped' AS skipped
  FROM net._http_response
 WHERE content LIKE '%"processed"%'
 ORDER BY created DESC LIMIT 10;
```

`status: "backlog"` means more than 10 000 fee payments piled up since
the cursor — the job was down a long time. It refuses to skip ahead
(that would lose deploys); move the cursor by hand to a signature you
have accounted for, or index the gap with a one-off run.

All four require the `x-cron-secret` header and 401 without it.
`/api/raffle/cron/buyback` exists on the same guard but is called by
hand, not scheduled (§4.3).

The user-facing endpoints need no secret: `POST /api/raffle/claim`
(ORB rounds only), `/purchase` and `/referral`, plus `GET /api/raffle/status`, which is the
single read the raffle page renders from (epoch progress, leaderboard,
and the connected wallet's entries). All of them reject a body carrying
`amount` or `entries` outright — those are server-derived.

**`pg_net` is fire-and-forget.** `net.http_post` queues the request and
returns an id immediately, so a job that "succeeded" in `cron.job_run_details`
only means the request was *queued*. The actual response is here:

```sql
-- what the jobs actually got back
SELECT id, status_code, left(content, 400) AS body, created
  FROM net._http_response
 ORDER BY created DESC
 LIMIT 20;

-- whether the jobs are firing at all
SELECT jobname, status, return_message, start_time
  FROM cron.job_run_details
 ORDER BY start_time DESC
 LIMIT 20;
```

A persistent `401` means `raffle_ops_config.cron_secret` and
`RAFFLE_CRON_SECRET` have drifted apart.

---

## 3. Epoch rollover

An epoch ends on whichever comes first:

- **cap** — the 1 000th entry. `raffle_award` locks the epoch in the same
  transaction that issues that entry, so the boundary cannot be crossed
  by a race. A claim arriving with 2 entries' worth of spend at 999
  issued gets 1, and the remainder is recorded in
  `raffle_progress.carried_out` rather than vanishing.
- **timer** — `now() >= ends_at`, picked up by `raffle-epoch-lock`.

Then, in the same pass: the merkle root is built over the canonical
entry list (`entry_no` ascending), `target_slot = currentSlot + 1200`
(~8 minutes), the pair is published as an on-chain memo, and the next
epoch opens.

**A quiet epoch — zero entries — is resolved, not drawn.** It goes
straight to `drawn` with no `raffle_draws` row, because there is no root
over an empty list and no `mod 0` to draw with. This used to abort the
whole lock pass before the "open the next epoch" step, which meant one
quiet week stopped the raffle permanently; there is now a test named for
that failure.

Checks:

```sql
SELECT id, status, lock_reason, entries_issued, purchased_issued, ends_at, locked_at
  FROM raffle_epochs ORDER BY id DESC LIMIT 5;

-- exactly one row, always
SELECT count(*) FROM raffle_epochs WHERE status = 'open';
```

If no epoch is open and none is opening, the lock job is failing — check
`net._http_response` first (§2).

---

## 4. The draw

### 4.1 How it is decided

```
winning_no = u64_le(sha256(merkle_root ‖ blockhash)) mod entries_issued + 1
```

`merkle_root` is committed on-chain *before* `target_slot` exists, and
the blockhash of a future slot is not predictable, so neither side can be
chosen to suit the other. The memo transaction's block time is the proof
of ordering.

### 4.2 Verifying it independently

`scripts/raffle/verify-draw.ts` shares no code with the engine — it
re-implements the leaf hash, the tree and the reveal from `node:crypto`.
That independence is the whole point; do not refactor the two together.

```bash
npx tsx scripts/raffle/verify-draw.ts \
  --entries entries.json \
  --root <merkle_root hex> \
  --blockhash <base58 blockhash> \
  --expect <winning_no>
```

`entries.json` is the published list — `[{ "entry_no": 1, "wallet": "…" }, …]`,
`entry_no` ascending:

```sql
SELECT json_agg(json_build_object('entry_no', entry_no, 'wallet', wallet)
                ORDER BY entry_no)
  FROM raffle_entries WHERE epoch_id = $1 AND status <> 'voided';

SELECT encode(merkle_root, 'hex'), target_slot, commit_sig,
       slot_blockhash, winning_no, winner_wallet
  FROM raffle_draws WHERE epoch_id = $1;
```

Run this yourself every epoch before announcing a winner. If it
disagrees with `raffle_draws.winning_no`, **do not announce** — see §5.3.

### 4.3 Recording the buyback (R8)

Purchase proceeds buy ORB, and an unpublished buyback is an
unverifiable claim. Record every one:

```bash
curl -X POST https://your-deployment.vercel.app/api/raffle/cron/buyback \
  -H 'content-type: application/json' \
  -H "x-cron-secret: $RAFFLE_CRON_SECRET" \
  -d '{"epoch_id":1,"signature":"<swap tx signature>","sol_in":50000000,"orb_out":"12345678"}'
```

**The public wording is "100% of proceeds, net of network and swap
costs" — never "100%".** Swap fees, slippage and gas mean 100% of
0.05 SOL cannot physically reach ORB, and the claim is checkable against
these very signatures.

---

## 5. Failures

### 5.1 Claims return `202 pending` and stay there

Expected in two cases, and neither is a bug:

- **Not finalized yet.** The server will not award on `confirmed` (R2).
  Finalization is ~13 seconds; the client re-polls.
- **ORB game claim, round not resolved.** An `orb_game` entry requires
  the round to have reached `settled`, so the response carries
  `unlocks_at_round`. If it never resolves, the round-cache job is
  behind:

```sql
SELECT round_id, state, reason, seen_at FROM raffle_orb_rounds
 ORDER BY round_id DESC LIMIT 20;
```

### 5.2 "A cancelled round paid me nothing"

Working as designed, and worth being able to explain in one sentence: a
round with a single depositor is cancelled with a **100% refund and zero
fees** (invariant I15). The deposit cost the user nothing but gas, so it
mints no entry — otherwise 0.015 SOL of gas would farm a whole
1 000-entry epoch that costs 50 SOL to buy. The event is kept with
`status = 'rejected'`, `reject_reason = 'round_cancelled'`, so the
history is auditable rather than silent.

### 5.3 The verification script disagrees with the stored winner

Stop. Announce nothing. In order:

1. Confirm `entries.json` is the full non-voided list in `entry_no`
   order — a wrong list is the overwhelmingly likely cause.
2. Confirm the root you passed matches `raffle_draws.merkle_root` **and**
   the root inside the on-chain memo at `commit_sig`.
3. If the memo root and the stored root differ, the stored root is not
   the committed one and the draw is void — re-run it from the memo's
   root, and publish what happened.

### 5.4 Entries stopped being issued mid-epoch

Check the cap first — this is almost always a locked epoch, not a fault:

```sql
SELECT id, status, entries_issued, cap, purchased_issued,
       (cap * 3000) / 10000 AS purchase_share_cap
  FROM raffle_epochs WHERE status IN ('open', 'locked') ORDER BY id DESC;
```

`raffle_award` returns 0 rather than erroring once an epoch is locked, so
a locked epoch looks like silence from the client's side. Purchases can
also stop on their own while earned entries continue: that is the R7
aggregate share cap binding at 30% of the pool.

---

## 6. Local development

```bash
npm run test:raffle        # 87 tests against a real local Postgres
npm run typecheck:raffle   # the package and the api/ functions
npm run test:web           # includes the raffle UI and the ORE bridge contract
```

The tests drop and rebuild `orb_raffle_test` from the shipped migration
files on every run, so the concurrency gates exercise the exact DDL and
plpgsql that deploy — including `005_cron.sql`, which must be a clean
no-op without `pg_cron`. Override the connection with
`RAFFLE_TEST_PG_URL`.

All of these are part of `npm run verify:all`.

### 6.1 One duplication worth knowing about

`features/ore-lite/raffle-bridge.ts` holds its own copy of the
localStorage format that `features/raffle/claimable.ts` reads. That is
not an oversight: nothing under `features/ore-lite` may import app code
(a grep test enforces it, so the mainnet tree can never pull in the
devnet stack), and a shared format written independently is how
anything crosses that boundary.

`apps/web/tests/raffle_bridge.test.ts` pins the two sides against each
other. If you change the record shape on one side, change it on both —
the test will tell you if you forget.
