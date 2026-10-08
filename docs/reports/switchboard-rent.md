# Switchboard randomness-account rent lifecycle — Phase 12.6 findings

> **Implemented 2026-10-08 (Phase 13, option A).** New permissionless
> instruction `close_randomness` (round PDA signs Switchboard's
> `randomness_close`; the randomness account + wSOL escrow, ≈ 4.58 M
> lamports, land in the round account and `close_round` carries them to
> `rent_payer`). The crank sends it between the last `close_entry` and
> `close_round`, records the LUT's `lut_slot` first, and a sweep closes
> each deactivated LUT after its 513-slot cooldown with
> `randomness_close_lut` signed by the persisted randomness keypair
> (≈ 1.42 M lamports back to the keeper). Both discriminators were
> confirmed live by simulation. Rounds closed before this shipped keep
> their stranded triple: their authority is gone and their LUTs were
> never deactivated.

**Report-only (Phase 12.6). Nothing here was implemented.** All numbers and
account states below were measured on devnet against the live deployment
(program `G5yNWmz…`, Switchboard On-Demand `Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2`)
on 2026-10-07, unless labelled otherwise. The live evidence round is **132**
(the first v2-economics smoke round), whose full settle pipeline ran
2026-10-07 02:00 UTC.

## Q1 — Does the deployed Switchboard program expose a close/reclaim?

**Yes — `randomness_close` and `randomness_close_lut` exist on the deployed
program family, and our pinned dependency simply predates them.**

Evidence chain:

1. `@switchboard-xyz/on-demand` **3.10.6** (current npm) still pins its
   devnet program id to the exact address our rounds CPI
   (`ON_DEMAND_DEVNET_PID = Aio4gaXj…`), and its `Randomness` class ships:
   - `closeIx()` → `program.instruction.randomnessClose` — *"closes the
     randomness account and returns the rent to the authority"*. Accounts:
     randomness (w), rewardEscrow (w), **authority** (= the account's
     stored authority — for us the round PDA), programState, system/token
     programs, wrapped SOL mint, lut, lutSigner, ALT program.
   - `closeLutIx()` → `program.instruction.randomnessCloseLut` — a
     *"post-cooldown LUT close"*, explicitly documented as *"signed by the
     randomness keypair, or **CPI-invoked by the program that controls the
     randomness PDA**"* — our exact usage shape.
   Since Switchboard upgrades the program in place at a fixed address, the
   binary currently deployed there is the one this SDK targets.
2. Our pinned **Rust crate `switchboard-on-demand = 0.13.0`** (chosen in
   Phase 8 because its `solana-v2` feature compiles against anchor 0.32)
   ships CPI structs for **none of these**: its instruction surface is
   `guardian_quote_verify`, `oracle_*`, `permission_set`, `queue_*`, and
   `randomness_commit` only. That is why `create_randomness` /
   `reveal_randomness` in our program are hand-rolled raw CPIs with
   probed discriminators — and why no close path exists on our side.
3. **Live recognition probe: inconclusive (transport, not evidence).**
   Simulating `sha256("global:randomness_close")[..8] =
   92650e4ae1f6009c` (and `randomness_close_lut =
   ea0585cc372555de`) against round 132's still-live randomness account
   could not complete: devnet's public `simulateTransaction` is currently
   returning `AccountNotFound` for **every** transaction — including a
   trivial self-transfer — reproduced from two different machines (laptop
   and the keeper droplet). Rerun when the endpoint recovers:
   `scripts/devnet/randomness-rent-probe.ts` (read-only).

**The structural finding that dominates everything above:** even with
`randomness_close` available, **the authority of every round's randomness
account is that round's PDA — and `close_round` deletes it.** Verified
live: round 132's round PDA (the stored authority of its randomness
account) no longer exists, while the randomness account still holds
3 088 640 lamports. Nobody — keeper, admin, or the long-gone ephemeral
keypair — can ever authorize a close for it. **The reclaim window is
[reveal, close_round), while the round PDA is alive, and only our program
can act inside it (the PDA's seeds).** Any Phase 13 design must close the
randomness account *before* `close_round` consumes its authority.

## Q2 — Can one randomness account serve many rounds?

**At the Switchboard layer, yes; under ADR-4 as designed, no.**

- The account itself is built for re-commitment: the SDK's own
  `commitAndReveal` flow loops `randomnessCommit` (each commit re-seeds
  `seed_slot` from the then-current slot) and `randomnessReveal` on one
  long-lived account. Nothing in the account forbids it.
- Our program's pin is what forces one account per round:
  `request_randomness` writes `randomness_account` exactly once per round
  and sets the account's authority to the **round PDA**; `commit_randomness`
  is exactly-once per round and demands `seed_slot > lock_slot`
  (freshness); `cancel_round` handles the 400-slot reveal deadline.
  ADR-4's no-re-roll guarantee is exactly this per-round isolation: the
  entropy is committed *after* this round's lock, *before* its settle, by
  an authority that dies with the round.
- What a long-lived (cross-round) authority PDA would cost:
  1. The write-once pin loses its meaning — commitment state crosses round
     boundaries, and a commit racing two rounds' locks could satisfy one
     round's freshness check with a value committed inside *another*
     round's window. The guarantee "this entropy postdates *this* lock"
     stops being per-round-isolable.
  2. The oracle-timeout path changes shape: today a stuck reveal cancels
     one round and the account dies with it; a shared account means one
     timed-out reveal poisons the *next* round, and ADR-4 forbids the
     re-roll that would fix it — cascading cancels.
  3. The per-round pin is also what makes "only this program, only for
     this round" expressible in one constraint.

  Reuse would therefore need a *new* pin design (e.g. binding to a
  commit-slot window rather than account identity) — a new ADR, not a
  patch. **Recommendation: keep per-round accounts and add close (Q1's
  window) instead.**

## Q3 — Measured all-in cost of one settled round's randomness

From the real round-132 settle (`create_randomness` tx
`4g96dUofHGUm6EvAcmwzpDnm9wELL87N8j91HAqczaG1JdpZKrxPpvHhqgcXWp4X7e5SeKUKBpAzbK8un8WbgHF5`,
slot 508 296 751, `solana confirm` → Finalized; balances from
`getTransaction`):

| item | lamports |
|---|---|
| randomness account (480 B — note: the deployed layout is 480 bytes; our parser only reads the 184-byte prefix, which is why we assumed 408) | 3 088 640 |
| wSOL reward-escrow ATA (165 B) | 1 488 440 |
| address lookup table (152 B) | 1 422 400 |
| create tx fee (2 signatures: keeper + ephemeral keypair) | 10 000 |
| **create_randomness total (keeper outflow, exact)** | **6 009 480** |
| request / commit / reveal / fulfill fees (4 × 5 000) | 20 000 |
| **all-in per settled round** | **≈ 6 029 480 lamports ≈ 0.00603 SOL** |

Against the 1 000 000-lamport keeper tip on settled rounds, a productive
round leaves the keeper **≈ −5.03 M lamports** on randomness alone — the
settled-round counterpart of the idle burn Phase 12 just eliminated.

**Stranding verified on-chain today (2026-10-07):** round 132's randomness
account still holds 3 088 640 lamports, its ATA 1 488 440, its LUT
1 422 400 — 5 999 480 lamports parked forever, with the authority (the
round PDA) already deleted. Every settled round since the devnet launch
has left the same triple behind. (Idle/empty rounds spend nothing here —
the burn is per *settled* round only.)

## Options for Phase 13 (recommendations only)

- **A (recommended): close the randomness triple inside the round's
  lifetime.** A new permissionless instruction (or an extension of
  `close_round` ordering) that CPIs `randomness_close` +
  `randomness_close_lut` *before* the round PDA is deleted — the round
  PDA signs both as the account authority. Hand-roll the CPIs exactly
  like `create_randomness`/`reveal_randomness` (discriminators above;
  verify live once simulations recover). Recovers ~5.999 M lamports per
  settled round; the crank's settle pipeline gains one step between
  `fulfill_settle` and `close_round`.
- **B: economics stopgap.** Raise `keeper_tip_lamports` to ≥ ~6.03 M so a
  settled round funds its own randomness, until A ships.
- **C: account reuse via a long-lived authority** — rejected under ADR-4
  (Q2); would require a new ADR and redesign of the freshness/timeout
  guarantees.

Probe tooling committed: `scripts/devnet/randomness-rent-probe.ts`
(read-only; keeper-history walk + created-account economics + the close
recognition simulation).
