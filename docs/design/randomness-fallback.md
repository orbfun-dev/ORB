# Randomness fallback: design and risks

Status: **option F IMPLEMENTED and live on mainnet, 2026-10-08** (main
104c910). ORAO was dropped on cost: ~0.0023 SOL per round, ~0.0018 of it
rent on request accounts ORAO provides no way to close. Sections 4–7 below
describe the ORAO variant that was NOT built; the shipped design is §2.2
with these specifics:

- `EntropyChain` PDA ["entropy_chain"]; `set_entropy_chain` (admin),
  `request_entropy`, `reveal_entropy`; provider switch via `update_config`.
- Target slot = request slot + 2; hash = first produced slot at or after
  it, refused once the target leaves `SlotHashes` (no re-targeting).
- `value = sha256("orb-entropy-v1" ‖ round_id ‖ slot_hash ‖ seed)`.
- Withheld reveal: cancel only after 216,000 slots (~24 h); the chain
  stays busy meanwhile, so no later round can draw.
- Every pinned-account check classifies the pinned account itself
  (Switchboard / entropy chain / System-owned = closed), never config —
  the P-1 hazard in §4.3 applies to any switchable provider.
- Operations: `scripts/mainnet/entropy-chain.ts`; crank
  `CRANK_ENTROPY_SEED_FILE`.

Original proposal text follows.

## 0. Summary

- **Recommendation.** Add ORAO VRF as a second provider, chosen **per round
  at pin time from an admin-set config value**, never by the keeper and never
  inside a round. During an outage the admin flips the config; rounds already
  waiting on the dead provider cancel and refund exactly as today.
- **Do not build an in-round fallback.** "Try Switchboard, and if it times out
  use ORAO for the same round" hands the keeper a re-roll: it sees the
  Switchboard reveal off-chain and can withhold it to force the ORAO path.
  The chain cannot tell a withheld reveal from a dead oracle. Section 3.
- **Hazard in the obvious implementation.** Every randomness check today
  compares the account owner to `config.oracle_program_id`. If that value is
  made mutable, `cancel_round` treats a revealed Switchboard account as
  "closed" (owner no longer matches) and lets a loser cancel a round whose
  winner is already public. That reopens AUDIT P-1. The design below keys
  every later check on the **pinned account's own owner**, not on config.
  Section 4.3.
- **Self-hosted alternative.** ORE runs its own randomness: a hash chain held
  by the operator, combined with a future slot hash. It kept working through
  this outage. ORB can do the same (section 2.2) if a missed reveal halts the game
  instead of cancelling the round. Otherwise we could abort rounds for free.
- **Size of the change.** Program: one new oracle adapter, one new
  instruction, five handlers made provider-aware, one config field made
  mutable. No account reallocation. Crank: one new pipeline branch. Needs a
  focused re-audit of the oracle layer, not of the economics.
- **What was not verified.** Switchboard's outage history, ORAO's exact fee,
  ORAO's account rent and whether it can be reclaimed, and ORAO's worst-case
  fulfilment time. Research was cut short. Each item is listed in section 8
  with the command or check that settles it.

## 1. The problem

Switchboard On-Demand randomness on mainnet stopped working around
2026-10-07. Evidence from `scripts/mainnet/sb-health.ts` on 2026-10-08:

- No successful `RandomnessReveal` by anyone on `SBondMDr…` for about 18 h.
- Every gateway of the oracles on queue `A43Dy…` returns HTTP 503.
- The SDK's oracle selection throws "No eligible randomness oracle candidates".
- Devnet Switchboard still works.

Our program handles this safely. A round pins its randomness account, the
commit never lands, and after `randomness_reveal_deadline_slots` (400 on
mainnet) the crank calls `cancel_round` and every entry refunds in full
(crank fix be0f71e). Nobody loses money, but no round can settle, so mainnet
cannot launch.

## 2. Options considered

| Option | Who can bias | Who can abort | Work | Verdict |
|---|---|---|---|---|
| A. Wait for Switchboard | Oracle TEE only | Nobody unilaterally, see 3.1 | None | Fine if outages are rare. Unknown ETA today. |
| B. ORAO as config-selected second provider | ORAO fulfillers only | ORAO only, by not fulfilling | Medium | **Recommended.** |
| C. In-round timeout fallback, SB then ORAO | Keeper, by withholding the SB reveal | Keeper | Medium | **Rejected.** Re-roll hole. |
| D. XOR of SB and ORAO outputs | Whichever reveals last can abort | Either oracle or keeper | Medium | Rejected. Worse liveness, same abort hole. |
| E. Keeper-run ECVRF, proof verified on chain | Nobody | Keeper, after seeing the value | Medium-high | Not for a public launch. Fairness then rests on our own key. |
| F. Two-party commit-reveal, our hash chain plus a future slot hash | Our seed holder and a slot leader together | Us, unless a missed reveal halts the game, see 2.2 | Medium | Viable. ORE runs this in production. No third party, but trust moves to us. |
| G. Slot hash alone | Slot leader | Slot leader by skipping | Low | Rejected for a jackpot. |
| H. drand beacon verified on chain | Nobody | Nobody | High | Rejected. Needs BLS12-381 pairing checks, which Solana has no syscall for. |

Pyth Entropy and Chainlink VRF were EVM-only as of my knowledge; neither was
checked live. MagicBlock offers a VRF on Solana but has a shorter track record
than ORAO.

### 2.1 How ORE avoids this (verified 2026-10-08)

ORE does not use Switchboard. Checked in source and on chain:

- `regolith-labs/ore` master (pushed 2026-10-02) depends on `entropy-api`
  0.1.4. Its `reset` instruction reads one entropy variable whose authority is
  ORE's board PDA, and refuses to run until that variable has a value.
- The entropy program (`regolith-labs/entropy`, id `3jSkUuYB…`) and ORE
  (`oreV3EG1…`) each processed about 200 mainnet transactions in the
  five to seven minutes before 06:31 UTC on 2026-10-08. Switchboard was down
  at the time. Whether the deployed binaries match master was not checked.

How the entropy program works:

1. The provider makes a hash chain off chain and commits its last link on
   chain. The variable also records a future `end_at` slot.
2. After `end_at`, anyone calls `Sample`, which copies that slot's hash from
   `SlotHashes`.
3. The provider calls `Reveal` with the next seed. The program checks
   `keccak(seed) == commit` and sets
   `value = keccak(slot_hash || seed || samples)`.
4. `Next` makes the revealed seed the new commit, so every future seed is
   fixed in advance.

The provider cannot predict the slot hash. The slot leader cannot predict the
seed. Bias needs both together, which is why the README says the provider must
not run a validator.

Two weaknesses matter for a jackpot:

- **Missing slot hash falls back to a predictable value.** If `end_at` was
  skipped or more than 512 slots have passed, `Sample` uses
  `keccak(end_at)`, which the provider can compute in advance. A provider who
  is also the only sampler can choose between the real hash and the fallback
  after seeing both outcomes. Our version must cancel instead.
- **The provider can withhold a reveal.** ORE has no timeout, so the game
  stalls until the provider reveals. That also prevents selective abort,
  because a stalled game is visible and the chain cannot advance without the
  missing seed. If we cancel and refund at a short deadline, as we do for
  Switchboard, the provider can abort any round it dislikes and reveal later
  at no cost.

### 2.2 What option F would look like for ORB

Option F is viable. It needs no third party, it costs only transaction fees,
and the pattern runs in production. The design must close both gaps above:

- **Commit before deposits close.** The round records the chain commit at
  `open_round` and sets `end_at = lock_slot + k`. Nobody knows the slot hash
  while deposits are open.
- **No fallback hash.** `Sample` is permissionless and must land within 512
  slots. The crank and the web app's manual crank both call it. If the hash
  is gone, that round cancels.
- **Make abort expensive instead of free.** A missed reveal does not cancel
  at the usual 400-slot deadline. The round waits, and `open_round` refuses
  new rounds until that seed is revealed. A late reveal settles the round
  with its original outcome. Only after a long deadline, such as 7 days, can
  anyone cancel and refund. Withholding a reveal therefore halts the whole
  game in public and does not change who wins.
- **Operational rules.** The seed server never runs a validator, the keeper
  never plays (P-7), and the chain is generated offline and backed up.

What F still cannot give is independence. We hold the seeds, so players trust
our key handling instead of Switchboard's or ORAO's hardware. A leaked chain
plus a colluding slot leader is enough to bias outcomes. For a public jackpot
that matters more than for ORE's mining rewards.

## 3. Threat model

Goal: once a round locks, no single party can choose between two outcomes.

### 3.1 Bias versus abort

There are two ways to cheat a lottery:

1. **Bias.** Influence the value itself. All schemes above except G resist
   this unless two parties collude.
2. **Selective abort.** See the value first, then stop the round when you
   dislike it. On cancel everyone is refunded, so an aborting player who would
   have lost gets a free option.

Today's Switchboard flow has a useful property. The reveal payload comes from
the oracle's public gateway, and anyone can fetch it and submit it. Our keeper
sees the value before sending `reveal_and_settle`, but withholding it does not
abort the round, because a winner or anyone else can fetch the same payload
and settle. Abort needs the keeper to censor every other submitter until the
deadline, which is not practical.

Any scheme where only we can produce the value (E, F) loses that property.
Operator rule P-7, "the keeper never plays", then becomes the only defence,
and it is a policy, not a proof.

### 3.2 Why the in-round fallback (option C) fails

Say round N pins a Switchboard account. The oracle commits and the gateway
serves a reveal. Under option C the keeper fetches the value, sees that a
friendly wallet loses, and simply waits. At the deadline the program switches
round N to ORAO and the keeper gets a second draw. On chain this looks
identical to a real outage. Requiring "the SB account was never committed" as
the trigger does not help much either, because the keeper chooses which oracle
to commit with and when. The only safe rule is **one provider per round, fixed
before anything about the outcome is knowable, and no second draw**. That is
the existing ADR-4 "no re-roll, ever" rule applied to providers.

### 3.3 Why an admin-level switch is safe

The provider is read from config when the round pins its randomness, which is
after lock. At that moment no value exists under either provider, so choosing
one gives the admin no information to act on. A flip affects only rounds
pinned afterwards. A round already pinned keeps its provider until it settles
or cancels.

Flipping back and forth cannot force cancels either, because a flip never
touches a pinned round. The admin's only lever over a pinned round is
`pause`, which never blocks fund exits.

## 4. Program design

### 4.1 Provider selection

- Make `GlobalConfig.oracle_provider` admin-mutable through `update_config`.
  It is documented as immutable today (ADR-10 and the header of
  `update_config.rs`). The provider does not change odds, fees or payouts, so
  it is operational, like `oracle_queue`. Update ADR-10's wording.
- Keep `oracle_program_id` immutable and Switchboard-only. Pin ORAO's program
  id as a compile-time constant from the ORAO crate. It is the same id on
  devnet and mainnet: `VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y`.
- Emit a `ConfigUpdated` event that includes the provider, as other fields do.
- No `Round` field is added. `Round` is 302 bytes with no padding left, and a
  reallocation would need every live round drained first. The provider of a
  pinned round is recoverable from the pinned account's owner, see 4.3.

### 4.2 The ORAO path

Switchboard needs four steps: create, pin, commit, reveal. ORAO needs two.

1. **`request_randomness_orao`** (new instruction; permissionless):
   - Requires `round.state == Locked`, an unpinned round and
     `config.oracle_provider == Orao`.
   - Derives `seed = sha256("orb-orao-v1" || program_id || round_id_le ||
     slot_hash)`, where `slot_hash` is the newest entry of the `SlotHashes`
     sysvar read inside the instruction. The keeper never supplies the seed.
   - CPIs ORAO's request instruction with that seed. The keeper pays the fee
     and rent.
   - Pins `round.randomness_account` to ORAO's request PDA for that seed,
     sets `randomness_commit_slot`, and moves the round to
     `AwaitingRandomness`, exactly like `request_randomness`.
2. **ORAO fulfils** on its own. No keeper step.
3. **`fulfill_settle`** reads the ORAO account through a new adapter and
   settles as today.

The slot hash in the seed matters. Without it the seed is known before the
round opens, and an ORAO insider could pre-compute values and steer the total
through deposits. With it, the seed exists only after lock. The keeper can
pick which slot to request in, which changes the seed, but it cannot compute
ORAO's output, so this gives it nothing unless it colludes with ORAO.

### 4.3 Owner-keyed checks, the P-1 hazard

Today `cancel_round` does this:

```rust
if *randomness_info.owner == ctx.accounts.config.oracle_program_id {
    // parse and refuse if revealed
}
// otherwise the account is treated as closed and cancel proceeds
```

If the provider changes and this kept reading config, a revealed account of
the other provider would skip the "already revealed" check, and any loser
could cancel a settled-in-waiting round. Rule for every handler that touches
the pinned account:

- Determine the provider from the **pinned account's owner**: the
  Switchboard program, the ORAO program, or the System program (closed).
- Any other owner is an error, never "closed".
- "Closed" means owner is the System program **and** lamports are zero, the
  same test `close_randomness` already uses.

Handlers affected: `fulfill_settle`, `cancel_round`, `close_randomness`,
`commit_randomness` and `reveal_randomness` (both must refuse ORAO accounts),
and `request_randomness` (must refuse when config says ORAO).

### 4.4 Oracle adapter

Extend `oracle::RandomnessSource` with an ORAO implementation:

| Trait method | Switchboard | ORAO |
|---|---|---|
| binding to round | `authority == round PDA` | key equals the pin, which our own instruction derived from the seed |
| freshness | `seed_slot > lock_slot` | request slot `> lock_slot`, from `randomness_commit_slot` |
| `is_revealed` | `reveal_slot > 0` | ORAO account reports fulfilled |
| `value` | 32 bytes | first 32 of ORAO's 64 bytes |

The ORAO binding needs no stored seed. `request_randomness_orao` derives the
seed and the PDA itself and writes the PDA into the write-once pin, so no
caller can ever pin a different account. Later steps only check that the
presented account equals the pin and is owned by ORAO.

Do **not** re-derive the seed from `SlotHashes` at settle. A value fulfilled
late can still settle after the deadline (P-1 forbids cancelling it), and by
then the slot may have left the 512-slot `SlotHashes` window. That round could
then neither settle nor cancel.

If the ORAO account stores its seed, the adapter should also compare it to the
pinned PDA as a belt check. Section 8 lists this as an open question.

`entropy.rs` and the cross-language fixture do not change. Only the source of
the 32 bytes changes.

### 4.5 Deadlines

- Reuse `randomness_reveal_deadline_slots` for both providers, measured from
  `randomness_commit_slot` as today. 400 slots is about 2.5 to 3 minutes.
- ORAO usually fulfils in seconds, by its own claims. If devnet measurement
  shows that, a shorter ORAO deadline would refund faster in an ORAO outage.
  Adding a separate field costs 8 of the 30 reserved config bytes. Decide
  after measuring; it is not needed for correctness.
- `cancel_round` keeps its P-1 rule for both providers: a fulfilled ORAO
  account can never be cancelled.

### 4.6 Rent reclaim

- Switchboard: unchanged. `close_randomness` reclaims about 0.006 SOL per
  round, and `close_round` requires the pin cleared (P-4).
- ORAO: unknown whether a consumer can close a fulfilled request account.
  - If it can, add the ORAO branch to `close_randomness` with the same
    pin-clearing rule.
  - If it cannot, `close_randomness` on an ORAO round only clears the pin. The
    rent is a per-round cost the keeper pays, like the request fee, and the
    tips must cover it. This was the devnet rent-leak lesson: measure it
    before setting tips.

### 4.7 New invariants

- **O1.** A pinned round's provider never changes. Enforced by the write-once
  pin plus owner-keyed checks.
- **O2.** The provider used is `config.oracle_provider` at pin time. No
  instruction accepts a provider argument from the caller.
- **O3.** At most one randomness request per round, across both providers.
  The write-once pin covers it.
- **O4.** A revealed or fulfilled value, from either provider, can never be
  cancelled. Extends P-1.
- **O5.** An account owned by anything other than Switchboard, ORAO or the
  System program, with zero lamports, is never treated as closed.
- **O6.** The ORAO seed is derived on chain and includes a slot hash newer
  than `lock_slot`.
- Existing I1 (vault solvency), I12 (state machine) and ADR-4 hold unchanged.
  No new state transitions.

## 5. SDK changes

- Builder for `request_randomness_orao`, deriving the ORAO PDA, network state
  and treasury accounts.
- `fulfill_settle`, `cancel_round` and `close_randomness` builders accept
  ORAO accounts.
- Decoder for ORAO request accounts and a provider helper that reads an
  account's owner.
- `update_config` arg for `oracle_provider`.
- IDL regenerated. The ORAO crate must stay out of the IDL feature graph, as
  Switchboard is today.
- Web: `ManualCrankButton` and `useManualCrank` drive the Switchboard steps.
  They need the ORAO branch, or must hide themselves on ORAO rounds.

## 6. Crank changes

- In `handlers/settle.ts`, branch on the round's state and the pinned
  account's owner:
  - Locked and config says ORAO: send `request_randomness_orao`.
  - Pinned to ORAO, not fulfilled, before the deadline: wait. No keeper
    action exists.
  - Pinned to ORAO and fulfilled: send `fulfill_settle`.
  - Past the deadline and unfulfilled: `cancel_round`, unchanged.
- The Switchboard branch is unchanged, but must refuse to create or commit
  when config says ORAO. A half-done Switchboard round in flight during a flip
  simply runs to settle or cancel on Switchboard.
- Health: extend `sb-health.ts` into a provider probe that also checks ORAO's
  recent fulfilments, and expose both on the crank's health endpoint.
- Never give the crank the admin key. The flip stays a manual admin action,
  scripted as `scripts/mainnet/set-oracle-provider.ts` with a dry run by
  default, like the other config scripts.

## 7. Tests required before a mainnet upgrade

Program, unit:
- ORAO adapter parses a byte-exact fabricated fulfilled and unfulfilled
  account, and rejects malformed data.
- Seed derivation known-answer test with fixed inputs.
- Owner classification table: Switchboard, ORAO, System with zero lamports,
  System with lamports, any other owner. Only the third counts as closed.

Program, integration (`tests/integration.rs`):
- Full ORAO round: lock, request, fulfil, settle, claim, close entries,
  `close_randomness`, `close_round`.
- `request_randomness` refuses when config says ORAO, and
  `request_randomness_orao` refuses when config says Switchboard.
- Second request on a pinned round is refused, for every provider pairing.
- **P-1 regression across a flip.** Pin on Switchboard, reveal, flip config to
  ORAO, then `cancel_round` must fail with `RandomnessAlreadyRevealed`. Same
  test in the other direction.
- In-flight round survives a flip: pin on Switchboard, flip to ORAO, commit,
  reveal and settle on Switchboard all still succeed.
- ORAO timeout: past the deadline and unfulfilled, cancel succeeds and every
  entry refunds in full.
- Fulfilled ORAO after the deadline still settles, and cancel is refused.
  Include a case more than 512 slots after the request.
- `commit_randomness` and `reveal_randomness` refuse an ORAO pin.
- `fulfill_settle` refuses an ORAO account whose seed belongs to another
  round.
- Freshness: an ORAO request whose slot is not after `lock_slot` is refused.
- Vault solvency (I1) asserted after every step of both paths.
- Config layout test still reports 340 bytes, and `Round` still 302.

Crank:
- Unit tests for each new branch in the settle handler, including the
  in-flight flip case.
- Devnet soak: at least 50 ORAO rounds, recording fulfilment latency, fee,
  rent, and how much rent is reclaimed.

Rehearsal:
- Deploy the mainnet build to devnet as in phase 2, flip providers both ways
  with rounds in flight, and confirm no round is stranded.

## 8. Open questions to settle before building

| Question | How to settle it |
|---|---|
| How often has Switchboard randomness gone down before? | Ask in Switchboard's Discord; scan `SBondMDr…` history for gaps between `RandomnessReveal` instructions. |
| ORAO request fee on mainnet and devnet | Read ORAO's network-state account and decode its fee field. |
| ORAO request account size, and can a consumer close it? | Read the ORAO crate source; try a close on devnet. |
| Does the ORAO account store its seed? | ORAO crate source. Enables the belt check in 4.4. |
| ORAO fulfilment latency, typical and worst | Devnet soak; on mainnet, timestamp request and fulfil pairs from recent ORAO transactions. |
| ORAO's fulfiller set and trust model | ORAO docs and audits. |

One data point was observed during research on 2026-10-08: ORAO's mainnet
program was processing requests in regular bursts every few minutes with no
failed transactions, while Switchboard was down.

## 9. Risks

- **Audit scope.** New CPI to a new program, new account parser, and changed
  owner checks in five handlers. The owner-check change is the riskiest part
  because it touches cancel and settle. Budget a focused re-audit.
- **Upgrade timing.** Mainnet has no open round and the crank is stopped,
  which is the safest moment to upgrade. Devnet has live rounds, so flip there
  only with rounds in flight on purpose, as a test.
- **ORAO is also a third party.** It can go down too. The design limits that
  to the same outcome as today: cancel and refund.
- **Trust disclosure.** Players must be told which provider a round used.
  Emit the provider in the `RandomnessRequested` event and show it on the
  round page.
- **Cost.** Two fee schedules and two rent profiles mean tips must cover the
  more expensive provider, or be adjusted at each flip.
- **Docs drift.** ADR-10, the `update_config` header, `architecture.md`, the
  runbooks and the rules page all say the provider is fixed. Update them in
  the same change.
