# Orbit Jackpot — On-Chain Auto-Deposit Escrow (Phase 10) — Design

Status: **design accepted, unimplemented**. Program live on Devnet at
`G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R`.

Companion: the implementation plan `2026-10-07-phase-10-auto-deposit-glm-directive.md` (not published)
(the implementation directive).

---

## Part 0 — Review of the existing architecture and Phase 9 deliverables

Findings are ordered by consequence. Everything below was read out of the
tree at `045d16f`; nothing is inferred from the roadmap alone.

### 0.1 — BLOCKING for this feature: a permissionless deposit path funded by
the keeper is an unbounded drain

`close_entry` and `refund_entry` both route the `PlayerEntry` rent to
`entry.player`. A naive `crank_auto_deposit` that uses `payer = crank` on
the entry `init` and stops there pays **1,203,960 lamports per
auto-deposit** into someone else's pocket, permissionlessly, with no upper
bound on the number of escrows. An attacker opens 10,000 escrows funded at
the minimum and farms the keeper's wallet.

This is why §3.4 below makes the escrow reimburse the entry rent inside the
same instruction. It is the single most important rule in this document.

### 0.2 — Known, now structural: the keeper is net-negative per round

`open_round` has `payer = payer` (the crank) funding `Round` (2,184,400
lamports) and `RoundVault` (817,880) — **3,002,280 lamports per round** —
while `close_round` returns both rents to `config.admin`
(`constraint = destination.key() == config.admin`). The live devnet config
sets `keeperTipLamports: 1_000_000`, so each round nets the keeper
≈ −0.002 SOL. `apps/crank/.env.example` already states this, so it is
acknowledged rather than discovered; it is listed here because Phase 10
changes its character:

- Each auto-deposit must be made **tip-positive** for the keeper
  (§3.4), otherwise the feature multiplies the bleed by the escrow count.
- The runbook's funding guidance (`CRANK_MIN_KEEPER_BALANCE_SOL=1`) needs a
  per-round burn figure that now depends on escrow volume.

If you want the keeper structurally solvent rather than subsidised, the
one-line fix is in `close_round`: route the two rents to the account that
paid them. That requires storing an `opened_by: Pubkey` on `Round` (there
are 64 reserved bytes), and it is **out of Phase 10's scope** — noted so
the decision is explicit rather than drifting.

### 0.3 — Real defect: a throwing `after` hook marks a landed transaction as
failed

`apps/crank/src/actions.ts:sendOnce` awaits `action.after(sig)` *inside* the
try block that `send` wraps. `settle.ts`'s `after` is
`verifySettlement`, documented as "Non-fatal by design: an alert screams,
the settlement itself stands" — but it calls `ctx.rpc.call(...)`, which
throws after exhausted backoff. On that path a successfully landed
`fulfill_settle` is recorded as a failure, `book.recordFailure` increments,
and the supervisor logs `action_failed`.

Not currently exploitable into a quarantine: after the first landing the
round is `Settled`, so `evalSettle` never re-emits `fulfill_settle:N` and
the streak cannot reach 5. It is still wrong, and Phase 10 adds a second
`after` consumer. Fix: run `after` in its own `try/catch` outside the
send-retry boundary, logging failures without touching the failure book.

### 0.4 — Real hazard for Phase 10: `TxExecutor` quarantines by `roundId`

`send()` quarantines `action.roundId` after `FAILURE_QUARANTINE_THRESHOLD`
(5) consecutive failures of one `(kind, round)` pair. A batched
auto-deposit action naturally carries `roundId`, and auto-deposit failures
are *routine* (entry-index contention with human deposits, an owner
withdrawing mid-flight). Five of those would quarantine the round — and
`evalSettle` and `evalCleanup` both bail on quarantined rounds, so a
cosmetic failure would strand a real pot.

`CrankAction` must gain `quarantineOnFailure?: boolean` (default `true`),
set to `false` for `auto_deposit`. This is non-optional.

### 0.5 — Durability: `state.json` is written non-atomically

`StateStore.persist()` calls `writeFileSync` straight over the live file. A
crash or a full disk mid-write truncates it; the recovery path backs the
file up and **starts clean**, which discards the quarantine list, so the
keeper resumes burning fees on a round a human already decided was broken.
Fix: write to `state.json.tmp`, `fsyncSync`, then `renameSync`.

### 0.6 — Unbounded growth: per-round randomness keypairs are never pruned

`var/keys/randomness-N.json` is created before the first
`create_randomness` send and never deleted. Each holds a signer for an
account whose *authority* is the round PDA, so a leaked file grants nothing
— the exposure is disk growth and a widening blast radius for a host
compromise. Prune files for rounds that are `Settled`/`Cancelled` and no
longer tracked.

### 0.7 — Tracking window can strand old rounds

`RoundMonitor.reconcile()` walks `maxTrackedRounds` (64) ids down from
`config.activeRoundId`. A round that never closed — quarantined, or stuck
behind a missing entry — silently leaves the tracked set once 64 newer
rounds exist, stranding its rent and any unswept prize. At 120 s rounds
that is a ~2 h grace period. Acceptable, but the drop should be *loud*: log
`round_dropped_from_window` with the round's state whenever a non-closed
round falls out.

### 0.8 — Correct and worth keeping intact

These are load-bearing and Phase 10 must not weaken them:

- **ADR-4's three checks** (`request_randomness` pin + authority-bound to
  the round PDA + owner-bound to `config.oracle_program_id`, with freshness
  `seed_slot > lock_slot` re-checked at settle). The `no re-roll, ever`
  posture is right and the quarantine-on-stale-commit belt in `settle.ts`
  is the correct operational complement.
- **ADR-6's single balance invariant** (`vault.lamports() == rent_min +
  vault_owed`, asserted at the tail of every mutating handler). Phase 10
  must leave I1 true by construction: the entry rent and the crank tip never
  pass through `RoundVault`.
- **ADR-10's structural config split.** `UpdateConfigArgs` cannot *express*
  the economics. The three new auto-deposit fields are operational and
  belong there; `MAX_AUTO_DEPOSIT_TIP_LAMPORTS` must be a compile-time
  constant, not an admin knob (§3.6).
- **`#[error_code]` ordering.** Anchor numbers variants positionally from
  6000. New variants append at the end of the enum only — inserting into
  the thematic sections renumbers every deployed code.
- **The zero-GPA posture in `apps/crank/src/reader.ts`.** Phase 10 needs
  enumeration, which GPA is the only primitive for; §5 resolves this with
  an event-sourced registry and GPA strictly as a reconciliation fallback.

### 0.9 — Minor / non-findings checked and cleared

- `close_round`'s `active_round_id` retirement (`if config.next_round_id ==
  round.round_id + 1`) cannot deadlock `open_round`: `active_round_id` is
  always the newest opened round, so the retired pointer is always
  `next_round_id` and the `(None, false)` branch applies.
- `evalCleanup`'s `?? (round.prizeClaimed ? entries[0] : undefined)` is
  unreachable-as-written (the `!prizeClaimed` branch always returns above
  it). Harmless; simplify if touched.
- `deposit`'s anti-snipe guards are sound: the `min(now + ext, cap)` form
  and the qualifying-minimum check make compounding and 1-lamport spam
  impossible, as the unit tests show.
- `urlguard.ts` correctly refuses non-https and private/reserved gateway
  hosts, which matters because the URL comes off an on-chain oracle account.

---

## Part 1 — What the feature is

A player funds a `PlayerEscrow` PDA once and declares terms
("0.1 SOL per round for the next 10 rounds"). Thereafter any permissionless
actor — the keeper, the player's own browser, a third party — calls
`crank_auto_deposit(round_id)` and the escrow enters that round without a
wallet signature.

---

## Part 2 — The pivotal design decision: `entry.player` is the escrow PDA

**`crank_auto_deposit` mints a `PlayerEntry` whose `player` field is the
`PlayerEscrow` PDA, not the owner's wallet.**

This is the whole design. Every existing payout path routes to
`entry.player`, so with no change to any deployed instruction:

| Existing instruction | Effect with `entry.player == escrow` |
|---|---|
| `claim_winnings` | prize → the escrow. **Reinvestment is free.** |
| `close_entry` (`close = player`) | entry rent → the escrow. |
| `refund_entry` (cancelled round) | stake + rent → the escrow. |
| `sweep_unclaimed_prize` | unchanged (prize → Mega-Pot, no `player` account). |

And with no change to the keeper: `cleanup.ts` already builds
`buildCloseEntryTx(new PublicKey(next.player), …)` and
`buildClaimTx(new PublicKey(winner.player), …)` from the decoded entry, so
it passes the escrow PDA automatically. `close = player` and
`add_lamports(player)` are both legal against a program-owned account.

### 2.1 — Consequences that must be accepted explicitly

1. **The escrow has no `balance` field.** Its spendable balance is
   *derived*: `spendable = lamports() − rent_exempt_minimum`. This is
   mandatory, not a shortcut: prizes, refunds and rent rebates arrive via
   `add_lamports` from instructions that know nothing about the escrow, so
   any bookkeeping field would immediately desynchronise. (It does not
   contradict the `MegaPotVault` warning against deriving from `lamports()`
   — that warning exists because the 90 %-award *formula* applied to a
   rent-inclusive balance overshoots. Here the rent floor is subtracted
   before any arithmetic, and the escrow holds nothing but its owner's
   money.)
2. **No `close_escrow` in v1.** A closed escrow that later receives a prize
   via `add_lamports` becomes a System-owned, dataless PDA holding lamports
   that nobody can ever sign for — permanently stranded funds. Proving
   "this escrow has no outstanding entry" on-chain requires either a
   counter that the three inbound instructions would have to decrement (they
   do not know about the escrow) or a terminal-round proof account. Both are
   real options; neither is worth v1. `withdraw_escrow` drains to the rent
   floor and the ~0.00127 SOL account stays alive. **Scope cut, deliberate.**
3. **The web app must treat two keys as "mine."** Entry attribution,
   participant labels and the claim banner all key on `entry.player`, which
   is now a PDA. The mapping is deterministic in one direction
   (`escrowKey(owner)`), so "my entries" is easy; labelling *other*
   people's escrow entries requires reading those escrow accounts. §6.
4. **A one-human round can stop auto-cancelling.** `single_depositor`
   compares pubkeys. A player who deposits from their wallet *and* has an
   escrow enter the same round presents two distinct keys, so
   `single_depositor` goes false and the round settles, taking the 2 % cut
   from a round with one real human in it. Accepted: detecting it would
   require an owner-aware comparison in `deposit`, which means teaching
   `deposit` about escrows.
5. **A cancelled round still consumes a budgeted round.** The stake is
   refunded in full to the escrow, but `rounds_remaining` was already
   decremented and nothing can give it back. With `auto_reinvest = true`
   the recompute in §3.4 step 17 heals it automatically, which is the main
   argument for defaulting that flag on in the UI.

### 2.2 — Variant B, if you reject Part 2

Keep `entry.player = owner`, add `funded_by: u8` to `PlayerEntry` by
shrinking `reserved: [u8; 16]` → `[u8; 15]` (the 109-byte size lock still
passes, and existing accounts read `0 = wallet`), and teach `close_entry`
to route rent to the escrow when `funded_by == 1`. Cost: `close_entry`
grows an optional escrow account and an "escrow already gone" fallback;
prizes and refunds land in the wallet, so reinvestment needs its own
mechanism; the keeper's cleanup builders change. Strictly more work for
strictly less. Recorded so the choice is visible, not to be built.

---

## Part 3 — On-chain specification

### 3.1 — `PlayerEscrow` — 122 bytes

Seed: `["escrow", owner]`. One escrow per wallet (no nonce — a nonce buys
multiple strategies per wallet and costs the trivial escrow↔owner mapping
that the UI and the keeper registry both depend on).

| Field | Type | Bytes | Notes |
|---|---|---|---|
| *(discriminator)* | — | 8 | `sha256("account:PlayerEscrow")[..8]` |
| `owner` | `Pubkey` | 32 | Also the seed. Sole withdrawal authority. |
| `per_round_lamports` | `u64` | 8 | The stake per round. Re-validated against `config.min_deposit_lamports` at **every** auto-deposit. |
| `max_rounds` | `u32` | 4 | Ceiling on `rounds_remaining`; bounds the commitment under `auto_reinvest`. |
| `rounds_remaining` | `u32` | 4 | The budget. `0` ⇒ dormant. |
| `next_eligible_round_id` | `u64` | 8 | Double-entry guard. `0` at open; set to `round_id + 1` after each auto-deposit. |
| `rounds_funded` | `u64` | 8 | Lifetime count of auto-deposited rounds. |
| `lifetime_deposited` | `u64` | 8 | Lifetime lamports funded in by the owner. |
| `lifetime_staked` | `u64` | 8 | Lifetime lamports staked into pots. |
| `auto_reinvest` | `bool` | 1 | §3.4 step 17. |
| `bump` | `u8` | 1 | Canonical bump, stored at init. |
| `reserved` | `[u8; 32]` | 32 | Forward-compat padding. |

`8 + PlayerEscrow::INIT_SPACE == 122`, pinned by a `size_is_exactly_122`
test and a `PlayerEscrow` vector in `layout_fixture.rs`.
Rent-exempt minimum: `(128 + 122) × 5080 = 1,270,000` lamports.

122 is distinct from every existing account size (340, 302, 109, 89, 65,
33), so `{ dataSize: 122 }` alone is an unambiguous GPA filter for escrows.
The registry in §5.1 depends on that; a future account of the same size
would have to add a discriminator `memcmp`.

**Deviation from ADR-8** (escrow lamports live in their own PDA, separate
from data): accepted here. ADR-8 exists so balance assertions do not have
to subtract a rent minimum that varies with data length. For
`PlayerEscrow` the data length is fixed and the rent minimum is computed
from the sysvar at every touch, there is no third-party claim on the
balance, and splitting it would double the per-player rent cost for no
gain. Documented in the module header.

### 3.2 — `GlobalConfig`: three new fields, zero migration

Append **immediately after `bump`**, shrinking `reserved: [u8; 64]` →
`[u8; 47]`:

| Field | Type | Bytes |
|---|---|---|
| `auto_deposit_window_secs` | `i64` | 8 |
| `auto_deposit_tip_lamports` | `u64` | 8 |
| `auto_deposit_enabled` | `bool` | 1 |

`64 − 17 = 47`, so `size_is_exactly_340` still passes and **every existing
field keeps its byte offset**. The deployed config's reserved bytes are
zero, so after the program upgrade the live account reads
`window = 0, tip = 0, enabled = false` — the feature is **off by default
with no migration transaction**. That property is the reason for this exact
placement; do not reorder.

Validation, in `initialize` *and* `update_config`, against the **effective**
post-update values:

```
auto_deposit_tip_lamports <= MAX_AUTO_DEPOSIT_TIP_LAMPORTS   (always)
if auto_deposit_enabled:
    auto_deposit_window_secs >  0
    auto_deposit_window_secs <  round_duration_secs
```

`MAX_AUTO_DEPOSIT_TIP_LAMPORTS = 1_000_000` (0.001 SOL) is a
**compile-time constant in `constants.rs`**, never an argument. It is the
security boundary that stops an admin from setting a tip that siphons
player escrows; `update_config` can move the tip only underneath it.

`UpdateConfigArgs` gains the three fields as `Option<…>`.

### 3.3 — `init_or_deposit_escrow(amount, per_round_lamports, max_rounds, auto_reinvest)`

```
config    Account<GlobalConfig>   seeds=[CONFIG_SEED], ro
escrow    Account<PlayerEscrow>   init_if_needed, seeds=[ESCROW_SEED, owner.key()], payer=owner
owner     Signer                  mut
system_program  Program<System>
rent      Sysvar<Rent>
```

`init_if_needed` is safe **because the seed contains the signer's key**: a
different signer derives a different PDA, so cross-owner reinitialisation
is structurally impossible. Requires
`anchor-lang = { version = "=0.32.2", features = ["event-cpi", "init-if-needed"] }`.
Freshness is detected as `escrow.owner == Pubkey::default()`; an existing
escrow is **updated**, never `set_inner`-ed.

Rules:
- `require!(!config.paused)` — this is a money-*in* path and is gated like
  `deposit`.
- `require!(per_round_lamports >= config.min_deposit_lamports)` and
  `require!(max_rounds > 0)` → `InvalidEscrowTerms`.
- `amount` moves owner → escrow by **System CPI** (the owner's account is
  System-owned). `amount == 0` is legal: it means "change my terms only".
- Fresh escrow: `set_inner` with `rounds_remaining = max_rounds`,
  `next_eligible_round_id = 0`, lifetime counters from this call.
- Existing escrow: `require_keys_eq!(escrow.owner, owner.key())` as a belt
  over the seed; overwrite `per_round_lamports`, `max_rounds`,
  `auto_reinvest`; set `rounds_remaining = max_rounds`;
  `lifetime_deposited += amount`. **`next_eligible_round_id` is never
  reset** — re-funding must not re-open a round already played.
- Tail: assert I16.
- `emit!(EscrowFunded { owner, escrow, amount, per_round_lamports, max_rounds, rounds_remaining, auto_reinvest, total_lamports: escrow.get_lamports() })`.

### 3.4 — `crank_auto_deposit(round_id)` — the core

```
config        Account<GlobalConfig>  seeds=[CONFIG_SEED], ro
round         Account<Round>         mut, seeds=[ROUND_SEED, round.round_id]
entry         Account<PlayerEntry>   init, seeds=[ENTRY_SEED, round.round_id, round.entry_count],
                                     payer=crank, space=8+PlayerEntry::INIT_SPACE
round_vault   Account<RoundVault>    mut, seeds=[ROUND_VAULT_SEED, round.round_id]
escrow        Account<PlayerEscrow>  mut, seeds=[ESCROW_SEED, escrow.owner.as_ref()], bump=escrow.bump
crank         Signer                 mut   — pays entry rent via `init`, reimbursed + tipped
system_program Program<System>
rent          Sysvar<Rent>
```

The escrow is bound by its own `owner` field, exactly as `round` is bound
by its own `round_id` — a forged escrow address cannot be presented.

Handler, in this order:

1. `require!(!config.paused)` → `Paused`.
2. `require!(config.auto_deposit_enabled)` → `AutoDepositDisabled`.
3. `require_eq!(round.round_id, round_id)` → `RoundIdMismatch`, a belt over
   the seed that keeps the caller-supplied argument meaningful.
4. `require!(round.state == Open)`; `require!(now < round.end_ts)`.
5. **Window / authority gate:**
   ```
   let in_window = now <= round.start_ts + config.auto_deposit_window_secs;
   require!(in_window || crank.key() == escrow.owner, AutoDepositWindowClosed);
   ```
6. `require!(round.round_id >= escrow.next_eligible_round_id)` →
   `AutoDepositAlreadyThisRound`. Monotonic round ids make `>=` both a
   same-round guard and a replay-into-older-rounds guard.
7. `require!(escrow.rounds_remaining > 0)` → `EscrowBudgetExhausted`.
8. `let amount = escrow.per_round_lamports;`
   `require!(amount >= config.min_deposit_lamports)` → `DepositBelowMinimum`
   (the admin may have raised the floor since the terms were set).
9. `max_entries_per_round` check, identical to `deposit`.
10. `entry_rent = rent.minimum_balance(8 + PlayerEntry::INIT_SPACE)`;
    `escrow_rent_min = rent.minimum_balance(8 + PlayerEscrow::INIT_SPACE)`;
    `tip = config.auto_deposit_tip_lamports`;
    `round_cost = amount + entry_rent + tip` (checked);
    `spendable = escrow.get_lamports() - escrow_rent_min`;
    `require!(spendable >= round_cost)` → `EscrowInsufficientBalance`.
11. `range = next_range(round.total_lamports, amount)?`;
    `round.total_lamports = range.end`;
    `round.vault_owed += amount`.
12. `entry.set_inner(PlayerEntry { player: escrow.key(), amount, … })`.
13. Sole-depositor tracking, byte-identical to `deposit`, using
    `escrow.key()`.
14. `round.entry_count += 1`.
15. **No anti-snipe extension.** `apply_anti_snipe_extension` is *not*
    called and `round.end_ts` is *not* written. See §4.1.
16. Lamport moves — direct arithmetic only (a System CPI cannot debit a
    program-owned account):
    ```
    escrow.sub_lamports(round_cost)?;
    round_vault.add_lamports(amount)?;
    crank.add_lamports(entry_rent + tip)?;
    ```
    Conservation: the crank already paid `entry_rent` into the entry during
    `init`, so its net delta is `+tip − tx_fee` and the escrow's is
    `−round_cost`. Nothing extra enters `RoundVault`, so **I1 holds with
    `vault_owed` incremented by exactly `amount`.**
17. Escrow bookkeeping:
    ```
    escrow.next_eligible_round_id = round_id + 1;
    escrow.rounds_funded += 1;
    escrow.lifetime_staked += amount;
    let spendable_after = escrow.get_lamports() - escrow_rent_min;
    escrow.rounds_remaining = if escrow.auto_reinvest {
        min(escrow.max_rounds, (spendable_after / round_cost) as u32)
    } else {
        escrow.rounds_remaining - 1
    };
    ```
    **`auto_reinvest` semantics:** winnings, refunds and rent rebates that
    land in the escrow buy more rounds, capped at `max_rounds` so the
    player's exposure stays bounded and knowable. With the flag off,
    `rounds_remaining` strictly counts down and inbound money just
    accumulates until withdrawn.
18. `emit!(AutoDeposited { round_id, entry_index, owner: escrow.owner,
    escrow: escrow.key(), amount, tip, entry_rent, ticket_start,
    ticket_end, round_total, rounds_remaining })`.
    If `rounds_remaining == 0`, also `emit!(EscrowDepleted { owner, escrow,
    last_round_id: round_id })`.
19. Invariant tails: `assert_round_vault_solvent` (I1), the two I8 belts
    (`ticket_start == total_before`, `ticket_end == round.total_lamports`),
    and `assert_escrow_rent_exempt` (I16).

### 3.5 — `withdraw_escrow(amount)`

```
escrow  Account<PlayerEscrow>  mut, seeds=[ESCROW_SEED, owner.key()], bump=escrow.bump
owner   Signer                 mut
rent    Sysvar<Rent>
```

- **Not pause-gated**, and deliberately carries **no `config` account**: a
  fund-exit path must have the fewest possible dependencies and the
  greatest possible liveness. The protocol's existing rule — pause blocks
  `deposit` and `open_round` only, never fund exits — is preserved.
- `require!(amount > 0)` → `NothingToWithdraw`.
- `require!(escrow.get_lamports() - rent_min >= amount)` →
  `EscrowInsufficientBalance`.
- `escrow.sub_lamports(amount)?; owner.add_lamports(amount)?;`
- **`rounds_remaining` is intentionally not recomputed** (that would need
  `config` for `round_cost`). It becomes optimistic, which costs at most one
  failed `crank_auto_deposit`; the keeper's off-chain predicate (§5.3) and
  the on-chain `spendable >= round_cost` guard both catch it.
- Tail: assert I16. `emit!(EscrowWithdrawn { owner, escrow, amount, remaining: escrow.get_lamports() })`.

### 3.6 — New errors (appended at the end of `OrbitError`, in this order)

`AutoDepositDisabled`, `AutoDepositWindowClosed`,
`AutoDepositAlreadyThisRound`, `EscrowBudgetExhausted`,
`EscrowInsufficientBalance`, `EscrowOwnerMismatch`, `InvalidEscrowTerms`,
`NothingToWithdraw`, `InvalidAutoDepositWindow`, `AutoDepositTipTooHigh`,
`EscrowInvariant`, `RoundIdMismatch`.

Appending preserves every deployed 6000-based code.

### 3.7 — New invariants

- **I16** — `player_escrow.lamports() >= player_escrow_rent_minimum` after
  every instruction touching an escrow. Receiver: `EscrowInvariant`.
  Helper: `assert_escrow_rent_exempt(lamports, rent_minimum)` in
  `invariants.rs`.
- **I17** — `crank_auto_deposit` ⇒ `escrow.next_eligible_round_id ==
  round.round_id + 1`, i.e. at most one auto-deposit per (escrow, round).
- **I1 unchanged** — the entry rent and the crank tip never transit
  `RoundVault`.
- **I13 restated** — `crank_auto_deposit` pays its caller a fixed,
  config-capped tip, exactly as `fulfill_settle` does. The caller has zero
  influence on the entry amount, the ticket range, the winning ticket or
  the split; the established reading of I13 ("no instruction's *outcome*
  depends on which key signed") is preserved.

---

## Part 4 — Security boundaries

### 4.1 — Anti-snipe griefing: auto-deposits never move `end_ts`

A permissionless instruction that extends the deposit deadline **using
someone else's lamports** is a free griefing lever: any actor could push a
round's `end_ts` repeatedly to `start_ts + max_round_duration_secs` at no
cost to themselves. `crank_auto_deposit` therefore does not call
`apply_anti_snipe_extension` at all — the extension is structurally absent
from the instruction, not merely disabled by a parameter.

This costs nothing. `deposit`'s own module header already states why the
extension exists: "fairness perception only — in a pari-mutuel pool entry
time does not change EV, and depositing against known randomness is
already closed structurally by `seed_slot > lock_slot`."

Required test: an auto-deposit executed with `now` inside
`anti_snipe_window_secs` of `end_ts` leaves `round.end_ts` bit-identical.

### 4.2 — Front-running / "entered at the worst moment"

State the mechanics precisely, because the obvious framing is wrong. A
player's win probability is `amount / total_lamports_final`. The final
total is the same for every participant regardless of entry order, so
**entry timing is EV-neutral conditional on the final pot**, and
`ticket_start` is irrelevant to the outcome.

The actual vector is narrower and real: a caller who **conditions the
decision to call** on the pot it can observe. Current pot size correlates
with final pot size, so a hostile actor could call `crank_auto_deposit`
only in rounds that already look crowded (lower expected share) and skip
the quiet ones.

**Mitigation — the auto-deposit window (§3.4 step 5).** A permissionless
caller may act only while
`now <= round.start_ts + config.auto_deposit_window_secs`. Inside a short
start-of-round window the observable pot carries almost no information
about the final pot, so the selection channel closes. Three further
properties make this sound:

- **A griefer cannot withhold entry.** The call is permissionless, so the
  keeper, the player's own browser, and any third party can all make it
  inside the window. Denial requires censoring every one of them.
- **The owner is exempt from the window.** `crank.key() == escrow.owner`
  bypasses it, so the owner always has an escape hatch and can spend escrow
  funds at a moment of their own choosing. An owner choosing their own
  timing is not griefing.
- **A skipped round costs nothing.** Only a *successful* auto-deposit
  decrements `rounds_remaining` (step 17). An escrow that is never cranked
  in a round simply plays the next one.

Recommended devnet values against `roundDurationSecs: 120n`:
`auto_deposit_window_secs = 20`, `auto_deposit_tip_lamports = 200_000`.
The window must leave room for the entry-index contention retries of §5.4.

### 4.3 — The escrow-funded entry rent (the §0.1 rule, restated as a boundary)

Every lamport the crank spends on an auto-deposit comes back in the same
transaction: `crank.add_lamports(entry_rent + tip)`. The keeper's net
position per auto-deposit is `+tip − tx_fee` and is **positive** for any
`tip > ~5_000`. There is no configuration in which a permissionless caller
can make the keeper pay for a stranger's entry.

Self-dealing is closed by construction: an owner who cranks their own
escrow pays the tip out of their own escrow and receives it into their own
wallet — net zero minus the fee. An attacker who opens escrows purely to
farm tips pays each tip from the escrow they funded.

### 4.4 — Double entry

One field, `next_eligible_round_id`, initialised to `0` and set to
`round_id + 1` after each auto-deposit, with the gate
`round.round_id >= escrow.next_eligible_round_id`. Round ids are monotonic
and never reused (`close_round` never rewinds `next_round_id`), so this is
simultaneously the same-round guard and the replay guard, needs no sentinel
value, and works for round 0. Re-funding an escrow never resets it (§3.3).

### 4.5 — Rent exemption

Every debit computes `spendable = lamports() − Rent::minimum_balance(len)`
from the sysvar and refuses to cross the floor; I16 re-asserts it at the
tail. The escrow is never closed in v1 (§2.1.2), so the floor is a
permanent ~0.00127 SOL per player — disclosed in the UI as the cost of
keeping the escrow open.

### 4.6 — Depletion

No auto-closure. `rounds_remaining == 0` (or `spendable < round_cost`)
makes the escrow dormant; the account survives, the owner can re-fund or
withdraw. `EscrowDepleted` fires once so the UI and the keeper registry can
demote the escrow without polling it every round.

### 4.7 — Disclosed costs (what the UI must say)

Per auto-deposited round the escrow spends
`per_round_lamports + entry_rent + tip`, where `entry_rent` is 1,203,960
lamports and `tip` is `config.auto_deposit_tip_lamports`
(≤ `MAX_AUTO_DEPOSIT_TIP_LAMPORTS` = 1,000,000). The entry rent returns to
the escrow when the round's entries are closed — but only after that round
settles, so the **up-front** funding must still cover it. The tip never
returns.

At the recommended devnet tip of 200,000 lamports, "10 rounds at 0.1 SOL"
is `10 × (100,000,000 + 1,203,960 + 200,000) = 1,014,039,600` lamports,
plus the one-time 1,270,000-lamport escrow rent floor:
**1,015,309,600 lamports ≈ 1.01531 SOL**, against the naive
`max_rounds × per_round_lamports` of 1.0 SOL. The UI must quote the former
and show the three components separately.

### 4.8 — Rejected mitigations, and why

- **Player-set pot conditions** (`max_total_lamports`, `min_entries`
  guards on the escrow): rejected. They make auto-deposit conditional on
  state the caller cannot control, so every batch becomes failure-prone,
  and a hostile actor could front-run with a large deposit specifically to
  push an escrow over its own ceiling and lock it out of the round.
- **Blocking `withdraw_escrow` inside the auto-deposit window** to stop a
  withdrawal from failing an in-flight batch: rejected. Never block a
  fund-exit path. The keeper absorbs the failure (§5.4).
- **A nonce in the escrow seed** for multiple strategies per wallet:
  rejected as YAGNI; it costs the one-line escrow↔owner mapping that §5 and
  §6 both rely on.

---

## Part 5 — Keeper integration (`apps/crank`)

### 5.1 — Discovery: event-sourced registry, GPA only to reconcile

Escrows are keyed by owner, not by a dense index, so they cannot be
enumerated by PDA derivation the way `reader.ts` enumerates entries.
`getProgramAccounts` is the only enumeration primitive, and the phase-8
lesson is that public RPCs refuse or throttle it. The resolution mirrors
the monitor's own posture — **events accelerate, reconciliation decides**:

1. **Primary — event feed.** Subscribe to `EscrowFunded` through the SDK's
   existing dual transport and add the escrow key to the registry. Covers
   every escrow created while the keeper is up.
2. **Reconcile — bounded GPA.** At boot and every
   `CRANK_ESCROW_RECONCILE_MS` (default 600 000), one
   `getProgramAccounts(programId, { filters: [{ dataSize: 122 }] })` inside
   the same `try/catch` fallback shape `client.fetchEntries` already uses.
   On refusal, log and keep the registry as-is. This is what makes a missed
   log (plain `emit!` truncates under load) a latency problem rather than a
   correctness one.
3. **Seed — manual.** `CRANK_ESCROW_SEED` accepts comma-separated escrow
   or owner pubkeys for recovery and for operators who disable GPA.

Registry persistence: `var/escrows.json`, written with the same
temp-then-rename durability fix as §0.5. Entries carry
`{ key, owner, lastSeenSlot, dormantUntilTick }`.

### 5.2 — Per-round read shape

Eligible-escrow keys are read with chunked `getMultipleAccounts` (100 per
call) through the existing `RpcGateway` — identical pacing and backoff to
every other keeper read. Dormant escrows (`rounds_remaining == 0`, or
`spendable < round_cost`) are re-read on a backoff (`dormantUntilTick`), so
a thousand depleted escrows do not cost a read every round.

### 5.3 — Eligibility predicate (pure, unit-testable, mirrors §3.4)

```
eligible(escrow, round, config, clock, entryRent, escrowRentMin) =
     config.autoDepositEnabled
  && !config.paused
  && round.state === "open"
  && clock.unix <  round.endTs
  && clock.unix <= round.startTs + config.autoDepositWindowSecs
  && round.roundId >= escrow.nextEligibleRoundId
  && escrow.roundsRemaining > 0
  && escrow.perRoundLamports >= config.minDepositLamports
  && (config.maxEntriesPerRound === 0 || round.entryCount < config.maxEntriesPerRound)
  && (escrowLamports - escrowRentMin) >= escrow.perRoundLamports + entryRent + config.autoDepositTipLamports
```

Lives in `apps/crank/src/handlers/auto_deposit.ts` as an exported pure
function and is tested against the Rust guards case by case.

### 5.4 — Batching and the entry-index hazard

Entry PDAs derive from `round.entry_count`, which mutates between
instructions **within** a transaction, so a batch of N auto-deposits must
present entry PDAs for `entry_count + 0 … entry_count + N − 1`. Rules:

- `CRANK_AUTO_DEPOSIT_MAX_PER_TX`, default **6**. Each instruction adds two
  unique account keys (escrow, entry) on top of the shared five; check the
  CU budget against `docs/reports/cu_profile.md` before raising it.
- **Atomicity:** one failing instruction fails the batch. Simulate before
  sending; on simulation or send failure, fall back to one instruction per
  transaction so a single bad escrow cannot block the rest.
- **Contention:** a human `deposit` landing between the read of
  `entry_count` and the batch landing invalidates every entry PDA in it.
  Adopt `useDeposit`'s contract — re-read `entry_count`, rebuild with fresh
  indices, at most 3 attempts, and only retry when the counter verifiably
  moved. `auto_deposit_window_secs` must be wide enough to absorb those
  retries (≥ 15 s).
- **Cap interaction:** treat `MaxEntriesReached` as a soft skip for the
  round, never a failure. On devnet `maxEntriesPerRound: 100`, so a large
  escrow population can crowd out human deposits — surface
  `escrowsEligible` on `/healthz` so that is observable.

### 5.5 — Supervisor wiring

Action priority becomes: **lock → auto_deposit → rollover → settle →
cleanup**. Auto-deposit sits above rollover because its window expires
while nothing else in the chain is window-bound; the `runActions` loop
re-evaluates after each landing, so the tick that opens a round still
reaches auto-deposit within the same tick.

Required changes beyond the new handler:

- `ActionKind` gains `"auto_deposit"`.
- `CrankAction` gains `quarantineOnFailure?: boolean` (default `true`);
  auto-deposit sets `false`. **§0.4 — without this, routine auto-deposit
  failures quarantine a live round and strand its pot.**
- `HandlerCtx` gains the escrow registry behind a structural interface
  (same seam style as `SettleBridge` / `QuarantineBook`) so the handler
  tests run against in-memory fakes.
- `/healthz` gains `escrowsTracked`, `escrowsEligible`,
  `lastAutoDeposit: { roundId, count, at }`.
- New config: `CRANK_AUTO_DEPOSIT_ENABLED` (default 1),
  `CRANK_AUTO_DEPOSIT_MAX_PER_TX` (6), `CRANK_ESCROW_GPA_ENABLED` (1),
  `CRANK_ESCROW_RECONCILE_MS` (600 000), `CRANK_ESCROW_SEED` ("").

---

## Part 6 — Web integration (`apps/web`)

1. **`EscrowPanel`** (new): fund / set terms / withdraw; shows
   `rounds_remaining`, `next_eligible_round_id`, spendable balance, the
   §4.7 cost breakdown, and a "play this round now" button that calls
   `crank_auto_deposit` owner-signed (the §4.2 window exemption).
2. **`DepositPanel`**: an "auto-play the next N rounds" affordance that
   builds `init_or_deposit_escrow` with
   `amount = N × (per_round + entry_rent + tip)`.
3. **Entry attribution** (`useEntries`, `lib/book.ts`, `useViewedWallet`):
   treat both `wallet` and `escrowKey(wallet)` as "mine", and badge
   escrow-funded entries.
4. **`ParticipantsFeed` / `ParticipantRow`**: a participant key that
   decodes as a `PlayerEscrow` resolves to its `owner`. Fetch unknown
   participant keys in one chunked `getMultipleAccounts`, cache the
   escrow→owner map, and show an "auto" badge. Fall back to rendering the
   PDA when the read fails.
5. **`ClaimBanner`**: a prize owed to an escrow is claimable by anyone and
   lands in the escrow. Copy must say "claim → your escrow", followed by a
   withdraw affordance. `RefundBanner` likewise.
6. **`dev/fixtures.ts`**: an escrow-populated scenario so the panel and the
   attribution path are exercised without a wallet.

---

## Part 7 — Deployment order (live Devnet)

1. Build and `anchor upgrade` the program. The config account is untouched;
   `auto_deposit_enabled` reads `false`, so **no behaviour changes**.
2. Regenerate and commit the IDL; rebuild and publish the SDK.
3. Deploy the crank with `CRANK_AUTO_DEPOSIT_ENABLED=0`. Confirm
   `/healthz` is `ok` and settlement is unaffected.
4. `update_config` → `auto_deposit_window_secs = 20`,
   `auto_deposit_tip_lamports = 200_000`, `auto_deposit_enabled = true`.
5. Create one escrow from the web app; verify
   `AutoDeposited` → `claim_winnings`/`refund_entry` → funds land **in the
   escrow** → `withdraw_escrow` reaches the wallet.
6. Set `CRANK_AUTO_DEPOSIT_ENABLED=1`. Watch `escrowsEligible` and the
   keeper balance across at least three rounds before announcing.

Rollback at any point: `update_config` → `auto_deposit_enabled = false`.
Escrows stay funded and withdrawable (§3.5 is not gated on the flag).
