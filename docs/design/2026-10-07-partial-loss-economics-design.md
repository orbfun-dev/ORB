# Partial-Loss / Soft-Jackpot Economics — Design

**Status:** approved; both open decisions resolved (§9). Ready for
the implementation plan `2026-10-07-phase-11-partial-loss-glm-directive.md` (not published)
**Supersedes:** the 98/1/1 winner-take-all split of roadmap §2
**Introduces:** ADR-11 (one-shot economics migration), I18–I22
**Scope:** `programs/orbit_jackpot`, `packages/sdk`, `apps/crank`, `apps/web`
**Verified:** every number below is checked by
`2026-10-07-partial-loss-economics-verify.py` (`python3` it; design-time only —
the Rust property tests in Phase 11.1 are the shipped home for these proofs)

---

## 1. Summary

The founder's proposal is sound in intent and has one exploitable hole and
one runaway in its literal form. Both are fixable, and the fixed version is
a **smaller** diff than the literal version — it reuses the existing
three-way split machinery, needs no new instruction, and is zero-migration
on both account layouts.

Three findings drive the design:

1. **The pivot is a variance reduction at constant RTP, not a fee change.**
   Today: 98% winner / 1% admin / 1% mega. Proposed: 9% winner / 89% refunds
   / 1% admin / 1% mega. Both take 2% of every lamport staked, of which 1%
   returns to players through the Mega-Pot. RTP is 99.0% before and after.
   What changes is entirely the shape of the distribution.

2. **"Losers lose 11%" must be implemented as "every entry is docked 11%,"
   not "every non-winning entry is docked 11%."** The literal reading makes
   the house edge vanish for a player who is most of the pot, which is the
   whale hole. The uniform reading makes the edge a flat −2% of stake for
   everyone, independent of pot composition and of how capital is split
   across wallets. It is also the only version that can be computed at
   settle time, because `fulfill_settle` does not know who the winner is
   (ADR-2: settlement records a *ticket*; claiming proves membership).

3. **The Mega-Pot needs a payout cap proportional to the round's own pot.**
   Without one, a 1-in-625 pop is farmable in low-volume rounds — and this
   is already true of the deployed 1-in-6,767 configuration, so the cap
   closes a latent issue rather than only a new one.

---

## 2. The literal proposal, and why the whale hole appears

Let pot `P`, player `i` stakes `s_i`, win probability `p_i = s_i / P`
(pari-mutuel by lamport-weight, I9). Under the literal spec — only
*non-winning* entries are docked 11%, of which 9 points go to the winner:

```
EV_i = p_i · [0.09 · (P − s_i)]  −  (1 − p_i) · [0.11 · s_i]
     = 0.09 · s_i(P − s_i)/P     −  0.11 · s_i(P − s_i)/P
     = −0.02 · s_i · (P − s_i) / P
```

The rake is 2% not of stake but of **contested volume** `s_i(P − s_i)/P`,
which → 0 as `s_i → P`. A player who is nearly the whole pot pays nearly
nothing and still collects the jackpot roll with near-certainty. Their
expected per-round take is `≈ 0.9·M/N` against a cost of `≈ 0`.

Splitting capital does not help the attacker — aggregate rake is
`0.02·[a − Σs_i²/P]`, which *increases* with the number of wallets — so the
attack is concentration, and concentration is exactly what the formula
rewards. Mitigating it with participation or concentration gates means
tracking `max_entry_stake` and `unique_depositors` on `Round`, spending
bytes and deposit-path CU, and the gates are still beatable by splitting
into just above the threshold.

## 3. The fix: a four-way split of the pot

Dock **every** lamport in the pot, winner included. The pot splits four ways
instead of three; the new slice is paid pro-rata to every entry:

| Slice | bps | Paid by | Paid to |
|---|---|---|---|
| `winner_bps` | 900 | `claim_winnings` | the winning entry's player |
| `refund_bps` | 8900 | `close_entry` | every entry, pro-rata by `amount` |
| `fee_bps_admin` | 100 | `fulfill_settle` | treasury (less keeper tip) |
| `fee_bps_mega` | 100 | `fulfill_settle` | Mega-Pot |

`fee_bps_admin` and `fee_bps_mega` are **already 100 each** — 1% of the pot
in both models. Only `winner_bps` changes (9800 → 900) and only
`refund_bps` is new. I14 generalizes to
`winner_bps + refund_bps + fee_bps_admin + fee_bps_mega == 10_000`.

Now:

```
EV_i = 0.89·s_i  +  (s_i/P)·0.09·P  −  s_i
     = 0.89·s_i  +  0.09·s_i        −  s_i
     = −0.02 · s_i
```

**A flat −2% of stake, for every player, at every pot share, under every
wallet-splitting strategy.** The `(P − s_i)/P` term is gone. Equivalently:
`−(fee_bps_admin + fee_bps_mega)/10_000`, and since the mega slice returns
to players, the true house edge is `fee_bps_admin` = **1%**, RTP **99.0%**.

Worked example — 10 entries of 1 SOL, pot 10 SOL:

```
winner_payout = floor(10e9 × 900/10000)   = 0.9  SOL
admin_cut     = floor(10e9 × 100/10000)   = 0.1  SOL
mega_cut      = floor(10e9 × 100/10000)   = 0.1  SOL
refund_pool   = 10 − 0.9 − 0.1 − 0.1      = 8.9  SOL   (residual, exact)
per entry     = floor(1e9 × 8.9e9 / 10e9) = 0.89 SOL   (×10 = 8.9, exact)

winner nets   0.89 + 0.9 = 1.79 SOL on 1 staked   (+0.79)
each loser    0.89 SOL on 1 staked                (−0.11)
EV            0.1(+0.79) + 0.9(−0.11) = −0.02     (−2%)
```

### What this costs, stated plainly

The winner's headline multiple collapses. On a 100 SOL pot a 1 SOL stake
paid ~98 SOL before and pays ~9.9 SOL now — an 11× reduction in the dream.
**The Mega-Pot is now load-bearing for the product, not a bonus.** Against
that, time-to-ruin stretches from 1 round to ~6 rounds to lose half a
bankroll (`ln 0.5 / ln 0.89 = 5.95`) and ~20 rounds to lose 90%. That
trade — kill the dream in normal rounds, move it entirely into the
jackpot — is the actual decision being made here, and it is the founder's
to make.

### Deviation from the brief

The brief says the winner receives 9% *of the losers' stakes* and is not
docked. The design above gives the winner 9% *of the whole pot* and docks
them 11% of their own stake. For a small winner the two are within a
rounding error of each other (`0.09(P − s) ≈ 0.09P − 0.11s` when
`s ≪ P`); they diverge only for a winner who is a large share of the pot,
where the brief's version pays out ~0 edge and this one charges the full
2%. The uniform version is also the only one expressible at settle time
without breaking ADR-2.

---

## 4. Mega-Pot farming, and the payout cap

With the flat rake, the attacker's whole position reduces to one scalar
inequality. Attacker holds fraction `θ` of pot `P`; `N = mega_trigger_modulus`;
`r = (fee_bps_admin + fee_bps_mega)/10_000`; `payable` is what the pot pays
out when it pops. On a pop the attacker captures the winner share with
probability θ and θ of the pro-rata field share with certainty, so their
expected capture is **exactly** `θ · payable`:

```
EV_attack = θ·payable/N  −  r·θ·P  =  θ·P·(payable/P/N  −  r)
```

θ cancels. The attack is non-positive-EV for every θ, every `P` and every
`M` **iff** `payable ≤ r·N·P`.

### A multiplicative *eligibility gate* would run away — rejected

Blocking the pop unless `P ≥ k·M` satisfies the inequality but creates a
feedback loop: while pops are blocked `M` grows, which raises the
threshold, which blocks more rounds. Solving the steady state
`0.01·P = (1/N)·Pr[P ≥ kM]·0.9·M` shows `M` diverging as `Pr → 0`. The
pot would grow until it could never pop.

### A payout cap — adopted

Cap what the pop pays, never whether it pops:

```rust
let g        = mega_award_bps + mega_field_bps;                  // 9000
let nominal  = floor(accrued × g / 10_000);                      // 0.9·M
let cap      = floor(total_lamports × mega_payout_cap_bps / 10_000);
let payable  = if mega_payout_cap_bps == 0 { nominal }           // v1: uncapped
               else { min(nominal, cap) };
let awarded  = floor(payable × mega_award_bps / g);              // 5/9 of payable
let field    = payable − awarded;                                // 4/9, residual
let retained = accrued − payable;                                // stays in the pot
```

Uncapped, `awarded/field/retained` = 50/40/10 of `M`, exactly as specified.
Capped, the ratio between winner and field is preserved and the unpaid
remainder simply stays in the pot, so pops always happen on schedule and
`M` equilibrates. The safety condition becomes a pure integer check on
config:

> **I21.** `mega_payout_cap_bps ≤ mega_trigger_modulus × (fee_bps_admin + fee_bps_mega)`

At `N = 625`: the bound is `625 × 200 = 125_000` bps (12.5× the pot).
**Recommended `mega_payout_cap_bps = 80_000`** (8× the pot, 1.56× margin).

Liveness: at steady state `M* ≈ 6.94·P̄`, so `nominal ≈ 6.25·P̄` and the cap
binds only in rounds below ~0.78× the average pot — where it reduces, never
cancels, the payout. It also gives the right incentive: a bigger round
unlocks a bigger jackpot.

### This closes a latent issue in the deployed program

The deployed v1 config has the same structure (`EV = −0.02·s` there too,
since 98/1/1 is also a flat 2% rake) and no cap, so the required bound is
`6767 × 200 = 1_353_400` bps — i.e. a round must be ≥ 0.665% of the
Mega-Pot, which at `M* ≈ 75·P̄` is ~0.5·P̄. A round below half the average
pot is farmable today. Severity is low — the edge per round is a fraction
of `0.9M/6767` against a 2%-of-stake cost, so it is a slow leak needing a
large pot and persistent low-volume rounds — but the cap closes it, and
`migrate_economics_v2` is the moment to set it.

### Mega-Pot sizing — the `N` decision

Steady state `M*/P̄ = (fee_bps_mega/10_000)·N / (g/10_000) = N/90`:

| `N` | `M*/P̄` | winner's 5/9 | pops/day @180s rounds |
|---|---|---|---|
| 625 (proposed) | 6.9× | 3.9× pot | 0.77 (every ~1.3 d) |
| 2 500 | 27.8× | 15.4× pot | 0.19 (every ~5 d) |
| 6 767 (deployed) | 75.2× | 41.8× pot | 0.07 (every ~14 d) |

Moving 6,767 → 625 shrinks the steady-state jackpot **10.8×**, and the
50% winner share (vs 90%) shrinks the winner's prize a further 1.8× —
**~19× smaller headline jackpot**, at the same moment normal-round upside
drops 11×. If the Mega-Pot is carrying the dream, 625 may be too frequent.
`N ≈ 2500` keeps a weekly-ish pop with a ~15× jackpot. Flagged as open
decision D2 (§9); the implementation takes `N` from config either way.

The account-open fee is a meaningful bootstrap on top of this: at 0.01 SOL
each, 10 000 sign-ups seed ~82 SOL (net of rent), which dominates the 1%
drip in the growth phase.

---

## 5. Claim ergonomics — already solved, no new instruction

The brief asks whether N losers manually claiming 89% is too friction-heavy
versus auto-crediting `PlayerEscrow`. **The existing architecture already
auto-credits and needs no new instruction.** `close_entry` is permissionless,
pays `entry.player` and never the caller (I13), and per Phase 10 R1 the
minted entry's `player` **is the escrow PDA** for auto-deposit players. So:

- Attach the refund to `close_entry`. Escrow players are credited to escrow,
  where `auto_reinvest` rolls it into the next round. Direct-wallet players
  are credited to their wallet. The retention flywheel is already wired.
- `close_entry` being permissionless *is* the manual claim — a player can
  call it themselves if the keeper is down. There is no second code path to
  write, test or keep consistent.
- No refund deadline, and there must not be one. A lapsed *prize* sweeps to
  the Mega-Pot (`sweep_unclaimed_prize`); a refund is the player's principal
  and is never swept.

Cost, measured against the existing account list: `CloseEntry` gains
`round_vault` and `rent`, giving 4 shared accounts and 2 per entry
(`entry`, `player`). At 32 bytes per key within the 1232-byte transaction,
that is **~11 entries per transaction**; CU is ~5k per entry, so size binds
first. Batching follows the existing `buildCrankAutoDepositBatchTx`
precedent. For a 100-entry round: 9 transactions × 5 000 lamports =
**0.000045 SOL**, against an admin cut of 1% of the pot. Any pot above
~0.005 SOL pays for its own cleanup, ~1000× over at realistic sizes.

---

## 6. Dust and rounding — the exact scheme

Two rules make stranded lamports impossible rather than unlikely, matching
the existing I6 philosophy that rounding favours the player:

**Rule 1 — every player-facing amount is floored; one slice is the residual.**
At settle, `refund_pool = total − winner_payout − admin_cut − mega_cut`.
Taking the *refund* slice as the residual (rather than the winner's, as in
v1) means `refund_pool ≥ floor(total × refund_bps/10_000)`, overshooting by
at most 3 lamports — the rounding goes to the many, not the one, and never
to the treasury.

**Rule 2 — per-entry shares are pro-rata of the pool, never a re-derived
percentage.**

```
refund_i = mul_div_floor(entry.amount, round.refund_pool,      round.total_lamports)
field_i  = mul_div_floor(entry.amount, round.mega_field_pool,  round.total_lamports)
```

Since `Σ amount_i == total_lamports` exactly (I9), the sum-of-floors lemma
gives `Σ refund_i ≤ refund_pool` **always**, with a deficit of at most
`entry_count − 1` lamports. The vault can never be overdrawn.

### The formula that must not be used

`refund_i = amount_i − floor(amount_i × 1100/10_000)` looks equivalent and
is not. With `total = 100` and 100 entries of 1 lamport,
`floor(0.11 × 1) = 0`, so each entry claims its full 1 lamport —
`Σ = 100 > refund_pool = 89`. The last entries' `sub_lamports` fails, those
entries can never close, `close_round` can never run, and the round's
lamports are locked forever. This is a liveness bug, not an accounting one.
It is a mandatory test vector (§8).

### Dust disposal

`close_round` becomes the single residual sink: once
`entries_closed == entry_count` and the prize is resolved, whatever remains
in `vault_owed` is dust and sweeps to the Mega-Pot. Bounded by
**I22: `vault_owed ≤ 2 × entry_count`** at that point — one lamport per
entry from each of the two pools — so an accounting error is loud rather
than a silent donation. At 1000 entries the bound is ~2000 lamports
(0.000002 SOL).

`min_deposit_lamports` bounds the *relative* rounding loss per entry at
`1 / min_deposit_lamports`; at 0.001 SOL that is one part per million.

### Overflow

Every product above exceeds `u64`. `amount × refund_pool` reaches ~10³⁰ and
`total × mega_payout_cap_bps` reaches ~10²⁴, against a `u64` ceiling of
1.8×10¹⁹. **All of it must go through `u128`**, as `split_round_pot` already
does. `mega_payout_cap_bps = 80_000` also exceeds `u16::MAX` (65 535) and
must be **`u32`**.

---

## 7. On-chain architecture

### 7.1 Layouts — zero migration on both accounts

The Phase 10 trick applies twice. New fields go **immediately before
`reserved`**, and `reserved` shrinks by exactly the same byte count, so every
pre-existing field keeps its offset and both size locks stay green.

**`GlobalConfig` — stays 340 bytes**, `reserved: [u8; 47] → [u8; 30]`:

| Field | Type | Bytes | v2 value |
|---|---|---|---|
| `refund_bps` | `u16` | 2 | 8 900 |
| `mega_field_bps` | `u16` | 2 | 4 000 |
| `mega_payout_cap_bps` | `u32` | 4 | 80 000 |
| `account_open_fee_lamports` | `u64` | 8 | 10 000 000 |
| `economics_version` | `u8` | 1 | 2 |

**`Round` — stays 302 bytes**, `reserved: [u8; 64] → [u8; 32]`:

| Field | Type | Bytes |
|---|---|---|
| `refund_pool` | `u64` | 8 |
| `refunds_paid` | `u64` | 8 |
| `mega_field_pool` | `u64` | 8 |
| `mega_field_paid` | `u64` | 8 |

`PlayerEntry` (109), `PlayerEscrow` (122) and all three vaults are
untouched. `ROUND_ENTRY_COUNT_OFFSET = 65` is unaffected.

**The upgrade is behaviour-identical for in-flight rounds.** An existing
`Round`'s reserved bytes are zero, so `refund_pool = 0` and
`mega_field_pool = 0`; `close_entry` pays nothing and the round drains
exactly as it does today. An existing `GlobalConfig` reads
`refund_bps = 0`, `mega_field_bps = 0`, `mega_payout_cap_bps = 0` — which
feed the new formulas to produce *precisely* v1 arithmetic (98% winner
residual, uncapped 90% mega award). **No version branches in any handler.**

### 7.2 ADR-11 — one-shot economics migration

`winner_bps`, `fee_bps_admin`, `fee_bps_mega`, `mega_award_bps` and
`mega_trigger_modulus` are immutable by construction (ADR-10) — absent from
`UpdateConfigArgs`, so they cannot be expressed, let alone accepted. There
is therefore **no path today to change `winner_bps` from 9800 to 900, or
`mega_award_bps` from 9000 to 5000.** The pivot is blocked until one is
added.

`migrate_economics_v2(args)` — admin-signed, one-way latch:

- refuses unless `config.economics_version < 2`, sets it to 2 at the end;
- writes `winner_bps`, `refund_bps`, `mega_award_bps`, `mega_field_bps`,
  `mega_trigger_modulus`, `mega_payout_cap_bps`, `account_open_fee_lamports`;
- asserts the new I14 and I21 on the *effective* values;
- **requires `mega_pot.accrued_lamports == 0`.** Retuning jackpot odds while
  the pot holds lamports contributed under the old odds is the exact rug
  ADR-10 exists to prevent; the Mega-Pot must be drained (settle a triggered
  round, or sweep to treasury) before the cutover. Only honestly satisfiable
  pre-launch, which is where this deployment is.
- requires no round in `Open`/`Locked`/`AwaitingRandomness`, so no round
  straddles the two rule sets;
- emits `EconomicsMigrated` with every before/after value.

After the latch, economics are immutable again. `update_config` remains
structurally incapable of touching them.

### 7.3 Instruction deltas

| Instruction | Change |
|---|---|
| `fulfill_settle` | four-way split; cap the mega payout; move `awarded + field` into the vault (ADR-8 snapshot); set `refund_pool`, `mega_field_pool`; `vault_owed = winner_payout + refund_pool + mega_awarded + mega_field_pool` |
| `close_entry` | **+`round_vault`, +`rent` accounts** (no `config` — the formula needs only `Round` fields, which keeps the batch wide).** Pays `refund_i + field_i` to `entry.player`, accumulates `refunds_paid` / `mega_field_paid`, decrements `vault_owed`, then closes as today. Still refuses the winning entry before `prize_claimed`. |
| `sweep_unclaimed_prize` | **CRITICAL.** Today it sweeps `amount = round.vault_owed` and sets `vault_owed = 0`. `vault_owed` now includes **unpaid player refunds** — as written it would confiscate every loser's 89%. Must sweep exactly `round.winner_payout + round.mega_awarded` and *decrement* `vault_owed`. |
| `close_round` | **+`mega_pot`, +`rent`.** Sweep residual `vault_owed` (dust) to the Mega-Pot under I22, then require 0. |
| `claim_winnings` | unchanged in shape; `winner_payout` now means the 9% cut, not the 98% residual |
| `init_or_deposit_escrow` | **+`mega_pot`.** On the fresh branch (`escrow.owner == Pubkey::default()`), charge `account_open_fee_lamports` to the Mega-Pot. |
| `deposit` | open decision D1 (§9) — whether to require the profile here too |
| `refund_entry`, `cancel_round`, `lock_round`, randomness instructions | unchanged (no fees taken on a cancel) |

`split_round_pot` gains a `refund_bps` input and a `refund_pool` output, with
the refund slice as the residual. `split_mega_pot` gains `field_bps` and
`cap_lamports`. Both stay in `src/math/`, pure and property-tested.

### 7.4 New invariants

- **I18** `total_lamports == winner_payout + refund_pool + admin_cut + mega_cut`
- **I19** `accrued == mega_awarded + mega_field_pool + mega_retained`
- **I20** `refunds_paid ≤ refund_pool` and `mega_field_paid ≤ mega_field_pool`
- **I21** `mega_payout_cap_bps ≤ mega_trigger_modulus × (fee_bps_admin + fee_bps_mega)`, asserted when `mega_payout_cap_bps > 0`, and required `> 0` at `economics_version ≥ 2`
- **I22** at `close_round`, `vault_owed ≤ 2 × entry_count`

I14 generalizes to the four-way sum. I6 is subsumed by I18.

### 7.5 The account-open fee

`PlayerEscrow` is 122 bytes, so rent-exemption is
`(128 + 122) × 3480 × 2 = 1_740_000` lamports ≈ **0.00174 SOL**. (The
doc-comment in `invariants.rs` says ~0.00127 SOL, which does not match that
arithmetic — worth correcting; the code itself reads the Rent sysvar and is
right.)

**Charge the fee on top of rent, not netted out of it.** Netting makes the
player's effective cost depend on Solana's rent schedule. So a first-time
player pays `0.00174` refundable rent + `0.01` non-refundable fee, and the
UI must say so in those words. The full fee goes to the Mega-Pot with
`lifetime_contributed` incremented (I3/I4).

The fee is an onboarding cost, not a jackpot-odds lever, so unlike the bps
fields it stays admin-mutable — under a compile-time ceiling
`MAX_ACCOUNT_OPEN_FEE_LAMPORTS = 50_000_000` (0.05 SOL), exactly mirroring
`MAX_AUTO_DEPOSIT_TIP_LAMPORTS`. It is a money-in path and so is
pause-gated like `deposit`.

As a sybil gate it is weak on its own, but it composes well: splitting
capital across wallets already fails to reduce the flat 2% rake, and now
costs 0.01 SOL per wallet on top.

---

## 8. Test obligations

Non-negotiable vectors, in the existing property-test style:

1. **Conservation (property, full `u64` × `u16` domain).** I18 and I19
   reassemble exactly; no panic at any input.
2. **No overdraw (property).** For any partition of `total` into 1..200
   entries, `Σ mul_div_floor(amount_i, pool, total) ≤ pool`.
3. **The 100 × 1-lamport round.** `total = 100`, 100 entries of 1 lamport:
   `refund_pool = 89`, every `refund_i = 0`, dust = 89 → Mega-Pot, round
   closes. Proves the naive formula's overdraw cannot regress in.
4. **Flat-rake invariance.** For a fixed total stake `a`, simulated EV is
   `−0.02a` whether `a` is 1 wallet or 50 — the property that kills the
   whale hole.
5. **I21 boundary.** `cap = N × (admin + mega)` accepted;
   `cap = N × (admin + mega) + 1` rejected by `migrate_economics_v2`.
6. **Capped pop.** `M` large, `total` small: `payable == cap`,
   `retained == accrued − cap`, winner/field ratio still 5:4.
7. **`sweep_unclaimed_prize` leaves refunds alone.** Sweep a lapsed prize,
   then close every entry and assert each player received their full
   `refund_i`.
8. **Single-entry round** (`entry_count == 1`): no division by zero, dust 0.
   (Note `lock_round` already cancels sole-depositor rounds, so this is a
   belt.)
9. **Zero Mega-Pot pop.** `accrued == 0` and triggered: all zeros, event
   still emitted, statistics stay honest.
10. **v1 compatibility.** With `economics_version == 0` and zeroed new
    config fields, `fulfill_settle` reproduces the v1 98/1/1 numbers
    bit-for-bit against the committed `entropy_kat.json` vectors.
11. **Layout locks.** `GlobalConfig` 340, `Round` 302, `PlayerEntry` 109,
    `PlayerEscrow` 122 unchanged; `account_layouts.json` regenerated and the
    SDK decoder suite green.

---

## 9. Decisions (resolved)

**D1 — the account-open fee is universal.** `PlayerEscrow` becomes *the
player profile*: `deposit` gains `init_if_needed` on it, so a first-time
direct depositor creates their profile and pays the fee in the same
transaction, and the fee is charged exactly once per wallet across both
entry paths (both use the same `escrow.owner == Pubkey::default()`
detector). Consequences accepted: `deposit` gains two accounts — a breaking
change for the SDK and web — and a first-ever bet costs
`stake + 0.01 + ~0.00174` SOL instead of `stake`.

Two things this must not do, both silent if wrong:

- a profile created by `deposit` is **dormant** (`rounds_remaining = 0`), so
  no direct depositor is ever silently enrolled into auto-deposit;
- `entry.player` for a direct deposit **stays the wallet**. The
  escrow-as-`entry.player` rule (Phase 10 R1) is specific to
  `crank_auto_deposit`; routing a wallet bet's refund into an unopted escrow
  would surprise the player and break the web claim flow.

**D2 — `mega_trigger_modulus` stays 625, as originally specified.** The
founder chose frequency over size with the trade-off on the table: a pop
roughly every 1.3 days at 180-second rounds, against a steady-state pot of
only ~6.9× the average round pot and a winner's share of ~3.9× a pot. Taken
together with normal-round upside dropping ~11×, **ORB's headline prize
shrinks by roughly 19× relative to today.** That is a deliberate product
bet on cadence and on the 40% field share — more players touching a jackpot
more often — rather than on a single large number, and it is reversible only
through a `migrate_economics_v3`. The corresponding I21 bound is
`625 × 200 = 125_000` bps; the shipped cap of 80 000 sits 1.56× inside it.

The account-open fee materially changes the early-life picture for D2: at
0.01 SOL each, 10 000 sign-ups seed ~82 SOL into the pot, which dominates
the 1% drip during growth and makes the first jackpots much larger than the
6.9× steady state suggests. Worth revisiting `N` once that inflow flattens.

## 10. Risks

| Risk | Mitigation |
|---|---|
| `sweep_unclaimed_prize` confiscating refunds | Called out as critical; dedicated test (§8.7) |
| Naive per-entry refund formula locking a round | §8.3 test vector; the only sanctioned formula is pro-rata of the pool |
| `u64` overflow in `amount × pool` | `u128` throughout; property tests at `u64::MAX` |
| `mega_payout_cap_bps` in a `u16` | Typed `u32`; 80 000 > 65 535 |
| Migration while the Mega-Pot holds old-odds lamports | `migrate_economics_v2` requires `accrued_lamports == 0` |
| Keeper cannot keep up with per-entry closes | ~11 per transaction batched; 0.000045 SOL per 100-entry round; monitor rounds un-pruned > 1 h |
| Winner's upside drops 11× and the jackpot drops ~19× | **Accepted** (D2): a deliberate bet on cadence + the 40% field share over a single large number. The real product risk in this phase, not a code risk — instrument pop-day retention and revisit `N` once sign-up inflow flattens |
| Indexers reading `winner_payout` as "98% of pot" | Semantics change; bump the IDL and say so in release notes |
| First-ever bet costs 6× the old minimum and may deter trial | **Accepted** (D1). Show the three-line breakdown before the wallet prompt; watch first-deposit drop-off and reduce `account_open_fee_lamports` (admin-mutable under a 0.05 SOL ceiling) if it bites |
