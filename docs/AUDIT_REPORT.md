# ORB pre-mainnet security audit

Audited commit: `main @ 906e26b` (2026-10-08). Branch with this report and
the failing tests: `claude/orb-mainnet-audit-33e379`. Scope: the Anchor program, the SDK math mirror, the
crank/keeper, the web signing flows and the raffle backend. Nothing on
mainnet was touched; no transaction was sent; the devnet rehearsal
program `ETMqujXH…` was only read.

## Verdict

**Not ready for mainnet yet.** The on-chain program is in good shape: no
critical or high finding, every lamport path reassembles (I18 holds under
v3), the winning-entry account cannot be spoofed, and a dominant player
cannot farm the Mega-Pot at the live configuration. What blocks launch is
around the program:

1. **Raffle backend (R-1, R-2, critical).** Any program can forge the
   `Deposited` log line the claim endpoint trusts, and failed transactions
   are credited by `/claim` and `/purchase`. One wallet can take an entire
   weekly prize for ~0.00001 SOL. Must be fixed before any epoch awards
   ORB-game entries (phase 0 decision 3) and before the next purchase
   epoch regardless.
2. **Keeper liveness (C-1, C-2, high).** Five transport errors in a row
   quarantine a round forever, the crank has no `cancel_round` path, and
   the gateway reveal fetch can hang a tick indefinitely. Under mainnet
   congestion this freezes player deposits with the health check still
   green.
3. **Web (W-1, medium).** A confirmation timeout on a landed deposit is
   read as entry-index contention and the app asks the wallet to deposit
   again. Cheap to fix; do it before real stakes.
4. **Program (P-1, medium).** `cancel_round` can void a round whose
   oracle value is already public. It is a one-line program change plus
   an account; land it before the mainnet deploy so it never needs an
   upgrade.

Fix those, re-run phase 2 for the program change, and the launch can
proceed. Everything else below is hardening and operational.

## Verification performed

| Check | Result |
|---|---|
| `anchor build`, `cargo test -p orbit_jackpot` | 77 unit + 60 integration tests pass at `906e26b` |
| `npm test` in `packages/sdk`, `apps/crank` | pass |
| `npm test` in `packages/raffle` (local Postgres) | 116 pass |
| `npx vitest run` in `apps/web` | 418 pass (33 files) |
| Mainnet-feature build reproducibility | local `cargo build-sbf --features mainnet` → sha256 `5313e8ec…`, byte-identical to `solana program dump` of devnet `ETMqujXH…` (743 640 bytes) |
| Devnet rehearsal config | economics v3, 9/89/1/1, Mega 1-in-625 / 8× cap / 50-40-10, round 120 s, claim deadline 7 d, reveal deadline 400 slots, admin `DTmUBWGJ…`, upgrade authority `BR1SL5zD…` |
| Switchboard `randomness_init` | authority is a required signer (read-only IDL probe), so a third party cannot pin a foreign randomness account on a round |

New failing tests (all fail at `906e26b`, each names the finding):

| Test | Finding |
|---|---|
| `programs/orbit_jackpot/tests/integration.rs::audit_cancel_round_refuses_a_revealed_randomness` | P-1 |
| `programs/orbit_jackpot/src/math/split.rs::i21_guard_boundary_is_still_unfarmable_under_v3` | P-2 |
| `packages/raffle/tests/p11_audit_findings.test.ts` (7 tests) | R-1, R-2, R-3, R-4, R-5 |
| `apps/crank/tests/audit_findings.test.ts` (4 tests) | C-1, C-2 |

Run them with `cargo test -p orbit_jackpot audit_cancel`,
`cargo test -p orbit_jackpot --lib i21_guard`,
`npm --prefix packages/raffle test -- tests/p11_audit_findings.test.ts`,
`npm --prefix apps/crank test -- tests/audit_findings.test.ts`.

## Summary of findings

| ID | Severity | Area | Title |
|---|---|---|---|
| R-1 | Critical | raffle | Forged `Deposited`/`AutoDeposited` log lines award ORB-game entries |
| R-2 | Critical | raffle | Failed transactions are credited by `/claim` and `/purchase` |
| C-1 | High | crank | Transport failures quarantine live rounds; no cancel path; health stays green |
| C-2 | High | crank | Gateway reveal fetch has no timeout and blocks the whole tick |
| R-3 | High | raffle | `/referral` binds any wallet to any referrer without proof of control |
| R-4 | High | raffle | ORE `DeployEvent` accepted from any inner instruction regardless of the calling frame |
| R-5 | High | raffle | Stale ORB deposits claimable into any later epoch |
| P-1 | Medium | program | `cancel_round` can void a round whose randomness is already revealed |
| P-2 | Medium | program | I21 farm guard is derived for v2; its boundary is +EV under v3 |
| P-3 | Medium | program/admin | Single admin key; `oracle_queue`, reveal deadline and claim deadline are hot-mutable with no event |
| C-3 | Medium | crank | Reveal deadline measured from the Switchboard seed slot, not the on-chain pin slot |
| C-4 | Medium | crank | Losers' refunds wait for the winner's claim (up to 3.5 days on mainnet) |
| C-5 | Medium | crank | Rejected Switchboard program handle is cached for the process lifetime |
| C-6 | Medium | crank | LUT cooldown margin too thin; three refusals drop the table permanently |
| C-7 | Medium | crank | Randomness keypair files written non-atomically |
| C-8 | Medium | crank | Static priority fee / CU limit on mainnet |
| R-6 | Medium | raffle | 500 responses leak internal error text including the RPC URL with API key |
| R-7 | Medium | raffle | Draw liveness: a skipped target slot blocks every later draw |
| R-8 | Medium | raffle | Commit retry can publish two on-chain commitments for one epoch |
| R-9 | Medium | raffle | No rate limiting; every unauthenticated request costs a paid RPC call |
| P-4 | Low | program | `close_round` can run before `close_randomness`, stranding keeper rent |
| P-5 | Low | program | Keeper settle tip is snipeable by any caller |
| P-6 | Low | program | 100-entry cap lets an attacker fill a round for ~0.07 SOL |
| P-7 | Low | program | Selective reveal withholding is a free abort for a keeper that also plays |
| P-8 | Info | program | Dead `OracleProvider::Orao` variant; no events on `update_config`/`toggle_pause`; multi-entry wallets are raked on their losing entries |
| C-9…C-18 | Low/Info | crank | See crank section |
| R-10…R-15 | Low/Info | raffle | See raffle section |
| W-1 | Medium | web | Confirmation timeout misread as entry-index contention prompts a second deposit |
| W-2 | Low | web | Claim-all signs every batch against one blockhash, then confirms serially |
| W-3 | Low | web | Raffle purchase destination and price trusted from the API response |
| W-4 | Low | web/sdk | Cluster and RPC pinned independently; no genesis-hash check |
| W-5 | Low | web | Production enables ORE auto-join against the documented gate |
| W-6…W-9 | Info | web | Confirm-error UX, published source maps, dev-only overrides, dependency advisories |

---

## Program (`programs/orbit_jackpot`)

### What was checked and holds

- **Economics v3 math** (`src/math/split.rs:134`). `winner_payout` is the
  exact residual, so I18 holds by construction; it is also never below
  v2's winner payout (the v3 cuts are taken on a smaller base), so the
  checked subtraction cannot fail for any `total ≥ winner_stake`. The
  proptest shows winner take-home ≥ stake and losers' refunds bit-identical
  to v2. Verified by the existing suite and by hand.
- **Winning-entry spoofing** (`src/instructions/fulfill_settle.rs:376-410`).
  The account must be owned by the program, deserialize as `PlayerEntry`
  (discriminator checked), carry this `round_id`, sit at the canonical
  PDA derived from its own `entry_index` and `bump`, and contain the
  winning ticket. Entries are only ever created by `deposit` /
  `crank_auto_deposit` at the canonical bump with `amount == range width`
  (`deposit.rs:117-135`), ranges tile `[0, total)` (I9), and no entry can
  be closed before settlement. There is exactly one qualifying account and
  the crank cannot substitute another. `rake_base = total − winner_stake`
  (`:144`) is non-negative because `split_round_pot_v3` already checked it.
- **Mega-Pot farming under v3** (`fulfill_settle.rs:177-190`, `math/mega.rs`).
  The cap base is now the losers' money, which the attacker does not
  control; adding their own stake no longer raises the cap, which is
  better than v2. Exact expectation for a single attacker entry `a` in a
  pot `P = a + o` with the pot full enough for the cap to bind:
  base-game loss `0.02·a·o/P`, Mega capture
  `(cap/10 000)/modulus · a·o/P · (award + field·θ + field)`, i.e. at the
  live config `0.0128·(0.9 + 0.4θ)` against `0.02`. Ratio ≤ 0.832 for
  every θ, so farming stays negative-EV, with less margin than v2 (0.576).
  A sybil split of the attacker's stake only adds rake. See P-2 for the
  guard.
- **Randomness pinning (ADR-4).** The pin is write-once
  (`request_randomness.rs:56-59`); the only way to create a randomness
  account whose authority is the round PDA is `create_randomness`, which
  pins `oracle_queue` and the program id (`create_randomness.rs:95-104`)
  because Switchboard's `randomness_init` requires the authority to sign
  (verified by IDL probe). Commit is exactly-once and must be strictly
  after `lock_slot` (`commit_randomness.rs:111-114,146-149`); settle
  re-checks authority, reveal state and freshness
  (`fulfill_settle.rs:98-116`). No account shopping, no re-roll by
  re-commit, no queue shopping.
- **Every SOL path** keeps I1 at its tail: deposit, auto-deposit, lock,
  request, settle, claim, close_entry, refund, sweep, close_round. Treasury
  (I2/I5) and Mega-Pot (I3/I4) are re-asserted wherever they move.
  `close_round` requires `vault_owed == 0` after the I22 dust sweep, so
  Anchor's `close` can never strand owed money. `admin_sweep_fees` can only
  move `accrued_lamports` (never rent) and only to the treasury authority's
  chosen destination. Escrow debits never cross rent exemption; the owner
  bypass in `crank_auto_deposit.rs:122` is correct. Account-open fee goes
  to the Mega-Pot, not the house.
- **`close_randomness`** (`close_randomness.rs`). Only for terminal rounds,
  only the pinned account, only into the configured oracle program with a
  fixed discriminator; the round PDA signature therefore cannot be
  replayed into any other Switchboard instruction. Reclaimed rent lands in
  the round account and leaves with `close_round` to `rent_payer`.
- **Admin authorization.** Two-step admin transfer; treasury authority
  separate from admin; migrations latched and admin-only; `initialize`
  validates the I14 bps sum, reveal deadline < 512 slots, and the I21
  guard.

### P-1 — Medium — `cancel_round` can void a round whose randomness is already revealed

- `src/instructions/cancel_round.rs:45-58`: the only gate is
  `slot > randomness_commit_slot + randomness_reveal_deadline_slots`. The
  randomness account is not read. `fulfill_settle` has no deadline, so
  after the deadline both outcomes are legal and whichever lands first
  wins.
- Scenario: the oracle or crank is slow and the reveal lands at
  commit + 401 slots (the dead-crossbar incident on 2026-10-08 cost 11 s
  per round, and C-1/C-2 make a slow reveal more likely on mainnet). The
  value is now public on chain. Every losing player (anyone who can read
  the ticket) has an incentive to send `cancel_round` before the crank's
  `fulfill_settle`; if they win the race the round refunds everybody and
  the winner's 9 % is voided. With the crank measuring the deadline from
  the wrong slot (C-3) it keeps revealing into this window.
- The existing `scenario_4_oracle_timeout_cancel_and_refunds` test
  actually cancels a *revealed* mock, which is why this was never caught.
- **Fix.** Add the pinned randomness account to `CancelRound`
  (owner = oracle program, key = `round.randomness_account`) and
  `require!(!randomness.is_revealed(), RandomnessAlreadyRevealed)`.
  Optionally also allow cancel when the account has been closed (owner is
  the system program) so an orphaned pin can still be refunded.
- Failing test: `audit_cancel_round_refuses_a_revealed_randomness`
  (`tests/integration.rs`, end of file).

### P-2 — Medium — I21 farm guard is a v2 derivation; its boundary is positive-EV under v3

- `src/invariants.rs:162-178` (`assert_mega_farm_safe`) encodes
  `cap_bps ≤ modulus × (admin + mega)`, derived from "the attacker pays
  θ·P·2 % per round". Under v3 the attacker pays `0.02·θ(1−θ)P` (nothing
  when they win) while the 40 % field share pays them `0.4·θ·payable` on
  every trigger, including triggers on rounds other players win. The exact
  v3 condition is
  `cap_bps × (award_bps + 2·field_bps) ≤ modulus × (admin + mega) × 10 000`,
  i.e. `cap_bps ≤ 96 153` at 50/40, not 125 000.
- At the live 80 000 the farmer is still at −0.34 % of the losers' money
  per round in the worst case (99 % dominant, full pot), so **the shipped
  configuration is safe**; the comment and the guard are what is wrong.
  The Mega parameters are not reachable from `update_config`, and mainnet
  is born at v3 with the constants, so this cannot be exploited today.
  It becomes exploitable the day someone re-tunes the cap or the field
  share inside the guard's bound.
- **Fix.** Make `assert_mega_farm_safe` take `award_bps` and `field_bps`
  and check the v3 bound; rewrite the I21 docstring with the v3
  derivation; add the EV simulation as a proptest over the accepted
  config space.
- Failing test: `i21_guard_boundary_is_still_unfarmable_under_v3`
  (`src/math/split.rs`).

### P-3 — Medium — admin powers: one key, three hot levers, no events

- `src/instructions/update_config.rs:70-112` lets the admin, with no
  timelock and no emitted event, change: `oracle_queue` (`:97`, which a
  Switchboard queue authority could in principle populate with its own
  oracles — the guardian attestation makes this hard but it is the single
  config field that touches randomness integrity), `randomness_reveal_deadline_slots`
  (`:94`; set to 0 and every round becomes cancellable the slot after its
  commit, see P-1), `claim_deadline_secs` (`:82`; set to 0 and every
  unclaimed prize is sweepable into the Mega-Pot immediately), and
  `round_duration_secs` with no lower bound (`:70`). `toggle_pause`
  (`admin_toggle_pause.rs:22`) also emits nothing.
- The upgrade authority is a single hot key (`BR1SL5zD…` on the rehearsal)
  and can replace the program outright; the runbook already plans a Squads
  multisig "after launch".
- **Fix.** Freeze `oracle_queue` after init (or require a pause + no round
  in flight); lower-bound the reveal deadline (≥ 150 slots), claim deadline
  (≥ 1 day) and round duration (≥ 30 s); emit a `ConfigUpdated` and a
  `PauseToggled` event; move the upgrade authority to a multisig **before**
  public launch, not after, and publish the admin keys in the docs.

### P-4 — Low — `close_round` before `close_randomness` strands keeper rent

- `close_round.rs:69-73` only requires terminal state and all entries
  closed; `close_randomness.rs` requires the `round` account to exist and
  never clears `round.randomness_account`. If the crank closes the round
  first (or gives up on `close_randomness` after `CLOSE_RANDOMNESS_MAX_FAILURES`,
  which the crank does), ~0.006 SOL of Switchboard rent plus the LUT are
  unreachable forever. Keeper money only.
- **Fix.** `close_randomness` sets `round.randomness_account = default`;
  `close_round` requires it to be default (a round cancelled at lock never
  pinned one, so it already is).

### P-5 — Low — the settle tip is snipeable

- `fulfill_settle.rs:207` pays `min(keeper_tip, admin_cut)` to whoever
  signs. Once the reveal has landed, a bot can insert `fulfill_settle`
  (it only needs the revealed account and the winning entry) ahead of the
  crank and take the 100 000-lamport tip every round; the keeper then runs
  at roughly −70 000 lamports per round. Permissionless-by-design, but the
  economics in the runbook assume the keeper collects it.
- **Fix.** Send `reveal_randomness` and `fulfill_settle` in one
  transaction from the crank (then there is no window), and budget the
  keeper assuming the tip is sometimes lost.

### P-6 — Low — round-filling griefing

- `deposit.rs:137-142`: `max_entries_per_round = 100`. An attacker can
  fill a round with 100 minimum deposits (1 SOL total) for about 0.02 SOL
  of rake plus ~0.05 SOL of fees, blocking everyone else from that round.
  At 120-second rounds that is ~$10 per round of denial.
- **Fix.** Raise the cap (entries are O(1) on chain), or make the cap
  per-player, or let a deposit above a size threshold bypass the cap.

### P-7 — Low — selective reveal is a free abort for a keeper that plays

- The crank fetches the oracle's revealed value off-chain before anyone
  else (`apps/crank/src/randomness.ts:179`). A keeper that also holds
  entries can withhold the reveal when it loses, wait 400 slots, and
  cancel for a full refund (`cancel_round.rs`). Nothing in the repo lets a
  player reveal independently: the on-chain `reveal_randomness` is
  permissionless, but only the crank fetches the gateway payload
  (`useManualCrank` does not reveal).
- **Fix.** Operational rule that the keeper key and the operator never
  play; publish the `RoundCancelled{oracle_timeout}` rate; add a web
  "settle now" that fetches the reveal from the public gateway and submits
  `reveal_randomness` + `fulfill_settle`, so any player can force the
  outcome.

### P-8 — Info

- `OracleProvider::Orao` (`state/global_config.rs:11`) is dead: every
  handler parses Switchboard regardless of the stored provider.
- Under v3 a wallet with two entries in one round (manual + auto-play is
  the common case) is raked on its losing entry even when its other entry
  wins. Correct per the spec ("the winning entry's stake"), but the rules
  page should say so; players will notice.
- `RoundSettled` is `emit_cpi!` (unforgeable) while `Deposited` /
  `AutoDeposited` are plain `emit!` — this is what makes R-1 possible.
  Switching them to `emit_cpi!` is a program change worth bundling with
  P-1.

---

## Crank / keeper (`apps/crank`)

Verified independently: the entropy mirror is bit-identical to the
program (`mirror.ts`, `settle.ts:186-188`); the v3 winning entry is chosen
by half-open range over fresh entry reads and a wrong choice is rejected
on chain; auto-deposit amounts, destinations and replay are fixed on
chain, so a buggy crank can only waste its own fees; the keeper key and
the paid RPC URL are never logged and never sent to oracle gateways; state
file writes are atomic; duplicate sends are neutralised by on-chain
`init` and the in-flight lock; the LUT sweep can only close tables whose
randomness keypair it holds and only after deactivation.

### C-1 — High — transport failures quarantine live rounds; no cancel path; health stays green

- `src/actions.ts:141-167`: every thrown error counts toward the
  per-action streak; at 5 (`FAILURE_QUARANTINE_THRESHOLD`, `:30`) the
  round is quarantined. `TransactionExpiredBlockheightExceeded`, exhausted
  RPC backoff and 429s are indistinguishable from a deterministic program
  error (`rpc.ts:31-32` only governs retries inside `call`).
- `handlers/settle.ts:50` and `handlers/cleanup.ts:63` skip quarantined
  rounds forever. The crank has no `cancel_round` action (`actions.ts:25-41`),
  the SDK has no builder, the web has none either. `health.ts:175-190`
  degrades on tick errors, low balance and stuck *Settled* rounds only; a
  quarantined `AwaitingRandomness` round holding player money leaves
  `/healthz` at 200.
- Scenario: mainnet congestion at the static 10 000 µL priority fee (C-8)
  → five expiries on `reveal_randomness` → round quarantined → deposits
  frozen until someone hand-rolls a `cancel_round` (after 400 slots) or a
  reveal. Nobody is paged.
- **Fix.** Count only on-chain custom errors toward the streak; add
  "quarantined non-terminal rounds > 0" to `degradedReasons`; add a
  `buildCancelRoundTx` and a crank action for `AwaitingRandomness` rounds
  past the on-chain deadline that are not revealed (so refunds flow
  without an operator); auto-expire transport-class quarantines.
- Failing tests: `tests/audit_findings.test.ts` "AUDIT C-1" (three
  transport error shapes).

### C-2 — High — gateway reveal fetch has no timeout and blocks the tick

- `src/randomness.ts:177-194` awaits `Gateway.fetchRandomnessReveal` up
  to ten times with 2 s sleeps. The vendored call
  (`@switchboard-xyz/common/dist/esm/gateway.js:395`) is the one gateway
  method that passes **no `timeout`** to axios, and the client is a bare
  `axios.create()`. A gateway that accepts TCP and never answers blocks
  until the OS socket timeout per attempt. `supervisor.ts:331-377` runs
  the tick sequentially, so lock, auto-deposit (20 s window) and rollover
  all stall behind it.
- **Fix.** Wrap each attempt in `AbortController` / `Promise.race` (~5 s)
  with a per-tick budget, or fetch the reveal off the tick path.
- Failing test: `tests/audit_findings.test.ts` "AUDIT C-2".

### C-3 — Medium — reveal deadline measured from the wrong slot

- `handlers/settle.ts:143` uses `clock.slot − view.seedSlot`; the chain
  uses `round.randomness_commit_slot`, set at the pin
  (`request_randomness.rs:80`), which is earlier. The crank therefore keeps
  trying to reveal after anyone may already cancel (P-1 window), and its
  own "reveal window missed" quarantine fires late and is a dead end (C-1).
- **Fix.** Use `round.randomnessCommitSlot`; past the deadline, settle if
  already revealed on chain, else cancel (C-1 fix).

### C-4 — Medium — losers' refunds wait for the winner's claim

- `handlers/cleanup.ts:90-116` returns `null` while `!prizeClaimed`
  inside the claim window, so no `close_entry` runs for anyone. On chain
  only the *winning* entry is gated (`close_entry.rs:98-104`). On mainnet
  (`claimDeadlineSecs = 604 800`, `CRANK_CLAIM_FOR_WINNERS` at half) the
  89 % refund pool and escrow auto-reinvest freeze for up to 3.5 days
  whenever a winner is slow, and `stuckSettled` (`monitor.ts:216-225`,
  1 h) degrades health on every such round. The file header
  (`cleanup.ts:16-19`) describes the opposite policy.
- **Fix.** Close non-winning entries immediately after settle; keep the
  winner's claim/sweep timing.

### C-5 — Medium — rejected Switchboard program handle is cached forever

- `randomness.ts:130-138`: a rejected `loadProgramFromConnection` promise
  stays in `programPromise`; every later tick rejects, health degrades,
  systemd never restarts a live process. **Fix.** Clear the cache on
  rejection.

### C-6 — Medium — LUT cooldown margin too thin; refusals drop the table

- `handlers/lut.ts:27` waits `deactivationSlot + 513`; with skipped slots
  the SlotHashes window spans more than 512 slot numbers, so the first
  close attempts fail preflight and at `CLOSE_LUT_MAX_FAILURES = 3`
  (`:29,41-44`) the table is forgotten: ~0.0014 SOL per round leaked under
  normal mainnet conditions. **Fix.** Margin ≈ 700 slots or read
  SlotHashes; do not count "not deactivated" as a failure.

### C-7 — Medium — randomness keypair files written non-atomically

- `state.ts:109-111`: `writeFileSync` then `chmodSync(0o600)`, no
  temp-and-rename (unlike `atomicWriteJson`, `:37-47`). A crash mid-write
  leaves a corrupt file; `JSON.parse` throws in `evalSettle` every tick
  with no quarantine and no self-heal. **Fix.** `openSync(tmp,'w',0o600)`
  + fsync + rename; treat an unparsable key file as a quarantine reason.

### C-8 — Medium — static priority fee and CU limit on mainnet

- `actions.ts:200-209`, `.env.mainnet.example:29-30`. Under congestion
  this produces exactly the expiry streaks that trigger C-1. **Fix.**
  `getRecentPrioritizationFees` over the written accounts with a cap, and
  more `sendAttempts` for pipeline stages.

### C-9 … C-18 — Low / Info

- C-9 `escrows.ts:183-185`: `CRANK_ESCROW_SEED` PDA detection compares
  `escrowKey(x)` with `x` (never equal); a seeded PDA is registered as an
  owner and a junk address is read forever.
- C-10 `state.ts:150-161`: `failures` map grows without bound; prune on
  reconcile.
- C-11 `lut.ts:39-61`: one `getAddressLookupTable` per pending table per
  tick, including tables known to be cooling down.
- C-12 `handlers/auto_deposit.ts:63-64`, `handlers/lock.ts:48-49`:
  account sizes 109/122 duplicated from `ACCOUNT_SIZES`; a layout bump
  drifts silently.
- C-13 `urlguard.ts:9-30`: pattern-only; `https://[::1]/`,
  `::ffff:127.0.0.1`, decimal/hex IPv4, 100.64/10 and private-resolving
  DNS names pass. SSRF probe only (attacker must be a queue oracle).
- C-14 `config.ts:220`: `CRANK_GATEWAY_RPC_URL` unvalidated; refuse when
  equal to the paid `CRANK_RPC_URL` or when it carries query params.
- C-15 `/healthz` unauthenticated (loopback by default); exposes keeper
  pubkey, balance, tracked rounds and raw `lastTickError`.
- C-16 `auto_deposit.ts:95-97`: records `batch.length` even when a retry
  sent one escrow.
- C-17 `AnchorUtils.loadProgramFromConnection`, `Oracle.loadMany`,
  `client.nextEntryIndex` bypass `RpcGateway` pacing (cost only).
- C-18 systemd units lack `CapabilityBoundingSet`,
  `RestrictAddressFamilies`, `SystemCallFilter=@system-service`;
  `CRANK_KEYPAIR_BASE58` in process env is readable via `/proc`; prefer
  the key file.

---

## Raffle backend (`packages/raffle`, `api/raffle`)

Verified independently: the ORE indexer only counts top-level System
transfers to the fee recipient whose payer is the `DeployEvent.authority`
(`ore-indexer.ts:159-171,198-203`), handles v0 loaded addresses, reads at
`finalized`, dedups on a DB `UNIQUE(signature, event_index)` with
`ON CONFLICT DO NOTHING`, advances the cursor forward-only, and skips
failed signatures from the signature list. `/claim` no longer awards ORE
(`claim.ts:141-145,204-210`). RLS is on with zero policies, only
`service_role` can execute the functions, every query is parameterised,
caps bind inside a row lock, and the service-role key never reaches the
web bundle (`p1_security` tests).

### R-1 — Critical — forged `Deposited`/`AutoDeposited` log lines award ORB-game entries

- `src/classify.ts:117-146` parses every `Program data:` line in
  `logMessages` and accepts any payload whose discriminator matches
  `Deposited` or `AutoDeposited`. It never checks which program emitted
  the line; `touchesOrbProgram` (`:118,153,168`) is computed and never
  used. ORB emits both events with plain `emit!`
  (`deposit.rs:246`, `crank_auto_deposit.rs:252`), and `sol_log_data` is
  callable by any program.
- `src/endpoints/claim.ts:136-203` then only requires
  `raffle_orb_rounds.state == 'settled'` for the claimed round id
  (`:161-162`) — any historical settled round — and awards
  `floor(amount / 1 SOL)` entries.
- Exploit: a 20-line program that logs
  `disc ++ borsh{roundId: <any settled round>, player: attacker, amountLamports: 1000 SOL}`;
  one transaction, ~5 000 lamports. `raffle_award` grants
  `LEAST(want, cap − issued)` (`sql/002_functions.sql:37`) and cap-locks
  the epoch (`:66-70`), so the attacker takes the whole weekly prize and
  denies everyone else. The suite's own fixture is nothing but a log line
  (`tests/helpers/tx.ts:148-158`), which is why this passes today.
- Reachability: the endpoint is deployed; it awards only when the round
  cache holds a settled round, which is the state the launch plan creates
  (phase 0 decision 3, phase 7 step 3).
- **Fix.** Attribute `Program data:` lines to the runtime's frame lines
  (`Program <id> invoke [n]` … `success`) and accept only lines emitted
  while the ORB program is the innermost frame; additionally require the
  ORB program among the static keys and as the outer instruction's
  program. Longer term, switch the two events to `emit_cpi!` and verify
  the event-authority signer (P-8).
- Failing tests: `p11_audit_findings.test.ts` "AUDIT R-1" (two).

### R-2 — Critical — failed transactions are credited by `/claim` and `/purchase`

- `endpoints/claim.ts:88-119` (`fetchFinalizedTransaction`) returns the
  transaction regardless of `meta.err`; `claim.ts:131-136`,
  `classify.ts:88-169` and `endpoints/purchase.ts:159-170` never check it.
  Only the indexer (`ore-indexer.ts:323`, via the signature list) and the
  referral lookback do.
- Failed Solana transactions are stored with their instructions, logs and
  inner instructions intact; nothing but the fee moved. `/purchase`:
  `[transfer(wallet→treasury, 1.25 SOL), transfer(wallet→x, 10^12)]` with
  `skipPreflight` fails at the second instruction; `sumSystemTransfersTo`
  (`purchase.ts:89-148`) sums the first → 25 entries for 5 000 lamports.
  `/claim`: a real `deposit` followed by a failing instruction leaves the
  `Deposited` log in place with the deposit rolled back.
- **Fix.** `if (tx.meta == null || tx.meta.err !== null) return null`
  in `fetchFinalizedTransaction` (covers claim, purchase and the indexer's
  own fetch); add `meta.err` fixtures to p3 and p7.
- Failing tests: "AUDIT R-2" (claim and purchase).

### R-3 — High — `/referral` binds any wallet to any referrer

- `src/referral.ts:56-83`: body `{wallet, ref}`, regex-checked only; no
  signature, nonce or expiry ties the request to the wallet owner;
  `raffle_bind_referral` is first-touch-immutable
  (`sql/002_functions.sql:160-174`). The lazy-sybil guard
  (`referral.ts:91-125`) looks at the oldest 5 of the newest 20
  signatures and is bypassed by any wallet with more than 20 transactions
  or one hop.
- Exploit: pre-bind every wallet that has not yet had an accepted event
  (leaderboard, fresh ORE wallets) to N attacker referrers; each referee's
  first ≥ 1 SOL event pays the attacker, 25 per referrer per epoch; and
  legitimate referrers are locked out for good. Each request also inserts
  arbitrary keys into `raffle_wallets` and triggers up to 12 paid RPC
  calls.
- **Fix.** Require a wallet signature over a structured message
  (`orb-raffle referral|wallet|ref|nonce|expiry`) verified server-side;
  or bind only when the referee's first on-chain event arrives with a
  signed proof. Rate-limit per IP and wallet.
- Failing test: "AUDIT R-3".

### R-4 — High (conditional) — ORE `DeployEvent` accepted from any inner instruction

- `classify.ts:99-115` accepts any inner instruction whose program is ORE
  and whose data decodes as `Log(8) ++ DeployEvent`, without checking that
  the enclosing top-level instruction is an ORE `Deploy`. If ORE's `Log`
  handler does not require a program-owned signer (the ORE program source
  is not in this repo to confirm; steel's self-CPI pattern usually does),
  an attacker program can CPI `ore::Log` with a fabricated
  `DeployEvent{authority: attacker, amount × total_squares: 10^6 SOL}`,
  pay the capped 0.05 SOL platform fee (`minimumPlatformFee` caps at
  `maxLamports`, `ore-indexer.ts:81-87`, `env.ts:76`), and the indexer
  awards up to the epoch cap for 0.05 SOL.
- **Fix** (independent of ORE internals): require the inner `Log`'s parent
  (`innerInstructions[i].index`) to be a top-level ORE instruction, and
  cross-check `amount × total_squares` against the authority's
  `preBalances − postBalances`; pin ORE's `log.rs` signer check in a
  comment once confirmed.
- Failing test: "AUDIT R-4".

### R-5 — High — stale ORB deposits are claimable into any later epoch

- `claim.ts` never compares `blockTime`/`slot` with the epoch's
  `starts_at`/`ends_at`, nor does `raffle_submit_earned_event`. The
  indexer has a launch floor (`ore-indexer.ts:281-283,322`); the claim
  path has none. Every pre-launch deposit becomes claimable in epoch 1,
  and players can bank deposits for the thinnest epoch or dump them at the
  end to cap-lock it.
- **Fix.** Require `block_time ∈ [epoch.starts_at, epoch.ends_at]` of the
  open epoch, or assign to the epoch open at `block_time` and reject if it
  is locked.
- Failing test: "AUDIT R-5".

### R-6 — Medium — 500 responses leak internal error text, including the RPC URL

- `http.ts:120-126` returns `err.message` verbatim for any non-`HttpError`.
  web3.js/node-fetch connection errors read
  `request to https://<rpc-host>/?api-key=… failed`; `claim.ts:99-101`
  rethrows anything that is not a version error. PostgREST messages leak
  function and constraint names the same way. **Fix.** Log server-side,
  return a generic `internal_error`.

### R-7 — Medium — a skipped target slot blocks every later draw

- `epoch.ts:147-151` expects `blockhashAt` to return `null` for an
  unavailable block, but `endpoints/cron.ts:152-158` calls
  `connection.getBlock`, which throws on skipped slots (2–5 % of mainnet
  slots). `runDraw` then throws every tick and, iterating `pendingDraws`
  sequentially, blocks all later epochs. There is no published rule for
  this case, so any manual fix is an operator's choice of randomness.
  **Fix.** Define the commitment as the first block at or after
  `target_slot` (memo text and `verify-draw.ts`), implement with
  `getBlocks(target, target + 32)`.

### R-8 — Medium — commit retry can publish two commitments for one epoch

- `epoch.ts:113-118`: the memo is sent and finalized (`cron.ts:133-137`)
  before `recordDraw`. A timeout between the two leaves a landed memo and
  no row; the next pass recommits with a new `target_slot`. Two valid
  memos exist; an operator could in principle retry for a favourable slot.
  **Fix.** Insert the draw row first, then send, then update with the
  signature; `verify-draw.ts` treats the earliest memo as canonical.

### R-9 — Medium — no rate limiting; each request costs a paid RPC call

- `/claim` and `/purchase` call `getTransaction` before any ledger lookup
  (`claim.ts:131`, `purchase.ts:159`; the replay check is at `:179`);
  `/referral` costs up to 12 calls. **Fix.** Check `raffle_events` by
  signature first; per-IP/per-wallet limits; brief negative caching.

### R-10 … R-15 — Low / Info

- R-10 `purchase.ts:194` always uses `eventIndex 0`; `classify.ts:160-161`
  numbers per claimed wallet. A transaction carrying an ORE deploy plus a
  treasury transfer makes `/purchase` answer `replay` with the ORE count
  and the purchase is never credited. Key on `(signature, source, wallet, ordinal)`.
- R-11 `sql/002_functions.sql:105-116,140`: the ledger row is inserted
  before `raffle_award` sees a locked epoch and returns 0; the dedup then
  burns the award forever. Return a distinct code and skip the insert.
- R-12 `classify.ts:59`: v0 transactions with lookup tables are
  mis-indexed (`resolveKeys` ignores `loadedAddresses`); third-party
  fee-paying deploys built with LUTs are dropped (no over-award).
- R-13 Validation: pubkeys checked by regex only (`http.ts:90-96`),
  31/33-byte decodes persist and later throw into R-6; buyback cron inputs
  (`cron.ts:188-198`) unchecked; `requireCronSecret` compares with `!==`.
- R-14 `api/.env.example:33,60`: if `RAFFLE_ORE_FEE_RECIPIENT ==
  RAFFLE_TREASURY_PUBKEY`, the ORE platform fee is also a purchase.
  Document that they must differ or exclude recognised fees in `/purchase`.
- R-15 Info: leader of `target_slot` can grind the blockhash (state it in
  the rules); the service-role key can rewrite entries after the commit —
  publish the entry list at lock; cron secret duplicated in
  `raffle_ops_config`; no `maxDuration` in `vercel.json`.

---

## Web app (`apps/web`) and SDK

Verified independently: every transaction is built with the connected
wallet as sole signer and fee payer; claims use a payer-bound
`OrbitJackpotClient` so the signer slot is the wallet even when the payout
slot is the escrow PDA (`packages/sdk/src/client.ts:713`); destinations are
pinned on chain (`claim_winnings.rs:60`, `close_entry.rs:74`,
`refund_entry`, `withdraw_escrow.rs:27-34`), so a lying RPC cannot
redirect funds, only mis-size a claim that the chain then rejects. The
SDK's `splitRoundPot`, `splitRoundPotV3`, `splitMegaPot`, `entryShare`
and `rangeContains` are line-for-line BigInt mirrors of the Rust;
`buildFulfillSettleTx` appends the winning entry (`client.ts:828-865`) and
the crank's `mirror.ts` reproduces `split_entropy` / `ticket_from_entropy`
exactly. Compiled-in env is limited to `VITE_SOLANA_RPC_URL`,
`VITE_ORB_CLUSTER`, `VITE_ORE_RPC_URL`, `VITE_ORE_FEE_RECIPIENT`,
`VITE_ORE_AUTOJOIN_ENABLED`; the built bundle carries no Supabase,
service-role, Jupiter or cron strings (scanned `dist/assets`). The ORE
platform fee destination is a build-time constant, computed once, bundled
atomically with the deploy. No `dangerouslySetInnerHTML`, no open redirect;
`?wallet=` / `?fixture=` overrides are DEV-only and absent from the bundle.

### W-1 — Medium — confirmation timeout misread as contention prompts a second deposit

- `apps/web/src/hooks/useDeposit.ts:49-73`: the inner `try` wraps both
  `sendTransaction` and the 45 s `confirmSignature`. If the deposit lands
  but confirmation times out, the catch re-reads `nextEntryIndex`; the
  user's own deposit advanced it, so `nowIndex > index`, the hook toasts
  "another player grabbed entry #N — retrying" and builds a second deposit
  at the next index. A user who trusts the toast stakes twice; nothing on
  chain prevents it (two distinct entry PDAs). Likely on congested mainnet.
- **Fix.** Retry only when `sendTransaction` itself threw. Once a signature
  exists, treat a timeout as unknown: poll `getSignatureStatus` or read
  `entryKey(roundId, index)` and check `player == publicKey` before any
  retry; never auto-retry after a confirmation timeout. `useEscrow` has no
  such loop.

### W-2 — Low — claim-all signs every batch against one blockhash

- `useClaimAll.ts:167-190`: one `signAllTransactions` for all batches plus
  the trailing escrow sweep, same `recentBlockhash`, then serial 45 s
  confirms. With two or more batches the later ones can exceed blockhash
  validity; the loop aborts, the sweep never goes out, escrow-owned
  refunds and prizes stay in the escrow, and the caller ignores the return
  value (`YourRewardsCard.tsx:697`). No double-claim is possible. **Fix.**
  Confirm with the block-height strategy; sign and send per batch, or send
  independent batches concurrently and the dependent sweep last.

### W-3 — Low — raffle purchase destination and price are trusted from the API

- `features/raffle/usePurchase.ts:202-216` builds the System transfer to
  `freshTerms.treasury` for `priceLamports × count` straight from
  `/api/raffle/status` (`status.ts:141-143`, sourced from Vercel env). A
  mis-set or compromised env redirects real mainnet SOL; the wallet prompt
  is the only check. **Fix.** Ship an allowlist of treasury pubkeys in the
  bundle, bound `priceLamports`, show the destination in the confirm UI.

### W-4 — Low — cluster and RPC pinned independently

- `packages/sdk/src/pda.ts:45-49` picks `PROGRAM_ID` from `ORB_CLUSTER`;
  `apps/web/src/lib/rpc.ts:13-18` picks the endpoint from
  `VITE_SOLANA_RPC_URL`. Nothing asserts they agree. Because the two
  program ids differ a mismatch fails at simulation rather than moving
  value, but it ships a silently broken production build. ORB hooks also
  use adapter `sendTransaction`, so Phantom broadcasts on *its* selected
  network. **Fix.** Compare `getGenesisHash()` with the expected hash for
  `ORB_CLUSTER` at startup and hard-fail; prefer `signTransaction` +
  `sendRawTransaction` on the app connection.

### W-5 — Low — production enables ORE auto-join against the documented gate

- `vercel.json:5` builds with `VITE_ORE_AUTOJOIN_ENABLED=true` while
  `features/ore-lite/README.md:20` and `.env.example` say not to enable it
  until the P5 dust run validated the setup/stop transaction pair. The
  Automate setup transaction carries the 1 % platform fee bundled with the
  deposit (`client.ts:462-475`). Either the docs are stale or production
  runs an unvalidated money path; owner decision.

### W-6 … W-9 — Info

- W-6 `features/ore-lite/client.ts:566-590`, `useOreDeploy.ts:95-98`: a
  non-expiry RPC error during confirm shows "failed" though the deploy may
  land; a re-click builds a second deploy and fee. Poll
  `getSignatureStatus` until `lastValidBlockHeight` passes first.
- W-7 `vite.config.ts:69` `sourcemap: true` publishes six `.map` files
  (no secrets). Fine if open-sourcing; else `hidden`.
- W-8 DEV-only `?wallet=` / `?fixture=` let the rewards card plan for one
  wallet and sign with another; no production impact.
- W-9 `npm audit --omit=dev`: 37 advisories (19 high, 18 moderate, 0
  critical), all transitive: `bigint-buffer` via `@switchboard-xyz/on-demand`
  (crank/root only, not in the web bundle), `braces`/`stream-json`/`toml`/`uuid`
  under `@solflare-wallet/sdk`'s metro dependency (the root `uuid` override
  does not cover it). Wallet-adapter packages are on current lines.

---

## Recommended order of work

1. R-2 (one line, covers three endpoints) and R-1 (frame attribution).
   Re-run `p11_audit_findings`.
2. C-1 + C-3 + C-2: error classification, on-chain deadline, gateway
   timeout, `cancel_round` builder and action, quarantine health signal.
   Re-run `audit_findings`.
3. P-1 and P-4 in the program, P-2's guard and docstring, and
   `emit_cpi!` for the two deposit events (P-8). Rebuild, re-run phase 2,
   record the new sha256.
4. P-3: multisig before public launch; freeze `oracle_queue`; bounds and
   events on `update_config`.
5. R-3, R-5, R-4, then the crank mediums (C-4 policy decision first).
6. Everything low/info as time allows; none of it blocks launch.
