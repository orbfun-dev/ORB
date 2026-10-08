# ORB

**A provably fair jackpot wheel on Solana.**

Players stake SOL into a timed round. Every lamport mints one ticket.
When the window closes, a random value picks one ticket, and the program pays out according to rules
that are fixed on-chain and cannot be changed by the operator. The winner
keeps their whole stake and takes 9% of everyone else's; every other
player gets 89% of their stake back; 1% funds the protocol and 1% feeds a
progressive Mega-Pot that pops roughly once every 625 rounds.

The program is live on Solana mainnet at
`ETMqujXHndqa3SfGHFhNMPwb4w43NhV96Majv3xbC3bH` (devnet staging:
`G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R`). The live app is
[playorb.fun](https://playorb.fun).

This repository contains the on-chain program, the TypeScript SDK, the
autonomous keeper that drives rounds, the web app, and the off-chain
raffle service. All of it is licensed under Apache-2.0.

## Contents

- [How a round works](#how-a-round-works)
- [Economics](#economics)
- [Repository layout](#repository-layout)
- [Program](#program)
  - [Instructions](#instructions)
  - [State](#state)
  - [Events and errors](#events-and-errors)
  - [Invariants](#invariants)
- [SDK](#sdk)
- [Build and test](#build-and-test)
- [Verifiable build](#verifiable-build)
- [Running the keeper and the app](#running-the-keeper-and-the-app)
- [Security](#security)
- [Documentation](#documentation)
- [License](#license)

## How a round works

```
Open ──lock_round──▶ Locked ──request (pin)──▶ AwaitingRandomness ──reveal + fulfill_settle──▶ Settled
  │                                                   │
  └── (empty at lock: window rolls in place)          └── reveal timeout ──▶ Cancelled (full refunds)
```

1. **Open.** Anyone can open the next round once no round is open. Players
   `deposit` SOL; each deposit mints a `PlayerEntry` holding a contiguous
   ticket range. Funded `PlayerEscrow` accounts can be entered
   permissionlessly by a crank inside a short start-of-round window.
2. **Lock.** When the window expires, `lock_round` closes deposits. A round
   with a single depositor or no deposits never settles: an empty round
   rolls its window forward in place, a sole depositor is refunded in
   full.
3. **Randomness.** The round pins one randomness source, write-once, after
   the lock. The admin chooses which source NEW rounds use; a pinned round
   keeps its source until it settles or cancels.
   - **Entropy (mainnet default).** The operator commits a SHA-256 hash
     chain on chain (`EntropyChain`). `request_entropy` fixes a target slot
     two slots ahead; `reveal_entropy` publishes the next chain seed and
     derives `value = sha256("orb-entropy-v1" ‖ round_id ‖ slot_hash ‖ seed)`
     from the first produced slot at or after the target. The operator
     cannot predict the slot hash; the slot leader never sees the seed. A
     withheld reveal cancels only after ~24 h and blocks every later round
     meanwhile, so it can never be used as a free re-roll. Design and
     threat model: [`docs/design/randomness-fallback.md`](docs/design/randomness-fallback.md).
   - **Switchboard On-Demand.** The round PDA creates, commits and reveals
     a Switchboard randomness account via CPI; if the oracle does not
     reveal within `randomness_reveal_deadline_slots`, anyone can
     `cancel_round` and every entry is refunded in full.
4. **Settle.** `fulfill_settle` derives the winning ticket from the revealed
   randomness, records it on the round, and moves the fee and Mega-Pot
   cuts. It records a ticket, never a wallet, so the settle transaction has
   nothing to gain by lying about who won.
5. **Claim and clean up.** `claim_winnings` pays the owner of the winning
   entry; `close_entry` pays every other entry its refund and reclaims its
   rent; `close_round` tears the round down and returns the rent to
   whoever opened it. Every one of these is permissionless. A refund is
   principal and has no deadline. An unclaimed *prize* sweeps into the
   Mega-Pot after the claim deadline.

Every step after the deposit is permissionless and state-gated on-chain,
so a stalled or malicious keeper can only waste its own fees. The
reference keeper in `apps/crank` is one implementation; anyone can run
another.

## Economics

Economics version 3 is live on mainnet. The rake falls on the losers'
stakes only; the winner's own stake is never charged.

| Slice | Share of the losers' stakes | Paid by |
|---|---|---|
| Winner | 9%, plus the winner's whole stake back | `claim_winnings` |
| Refunds | 89% to every losing entry, pro-rata | `close_entry` |
| Protocol | 1% | `admin_sweep_fees` (treasury authority only) |
| Mega-Pot | 1% | accrues on-chain |

- The refund pool is the exact residual of the pot after the three floored
  slices, so the four shares reassemble the pot to the lamport (invariant
  I18). Rounding dust goes to the field, never to the treasury.
- A Mega-Pot pop pays 50% to the round winner, 40% pro-rata to every entry
  in the round, and keeps 10% as the next seed. The payout is capped at 8x
  the round's own pot (`MEGA_PAYOUT_CAP_BPS`), so farming the trigger in
  small rounds is never positive expected value (invariant I21).
- The split, the trigger odds and the cap are structurally absent from
  `update_config`. They changed through one-way, admin-signed latches
  (`migrate_economics_v2`, `migrate_economics_v3`) that refuse while any
  round is in flight, and cannot be reopened.
- Money is `u64`/`u128` on-chain and `bigint` off-chain. There are no
  floats on either side of the boundary. The SDK's economics mirror is
  pinned to the Rust output by committed known-answer fixtures.

Constants live in
[`programs/orbit_jackpot/src/constants.rs`](programs/orbit_jackpot/src/constants.rs).
The design history is in [`docs/architecture.md`](docs/architecture.md)
and the specs under `docs/design/`.

## Repository layout

| Path | What it is |
|---|---|
| [`programs/orbit_jackpot`](programs/orbit_jackpot) | The Anchor program (Rust). Holds all funds. |
| [`packages/sdk`](packages/sdk) | `@orbit-jackpot/sdk`: PDA derivation, account and event decoders, transaction builders, and a BigInt mirror of the on-chain math. |
| [`apps/crank`](apps/crank) | The reference keeper: opens, locks, settles, refunds and closes rounds unattended. |
| [`apps/web`](apps/web) | The web app (Vite, React, Tailwind). Includes the ORE mining tab, which talks only to the official ORE program on mainnet. |
| [`packages/raffle`](packages/raffle), [`api/raffle`](api/raffle) | Off-chain promotional raffle: an entry ledger over Postgres with a verifiable weekly draw. No program changes. |
| [`scripts`](scripts) | Local-validator demo and devnet operations scripts. |
| [`docs`](docs) | Architecture, runbooks, reports, design specs. See [`docs/README.md`](docs/README.md). |

## Program

Anchor 0.32, Rust 1.91. Program IDs: mainnet
`ETMqujXHndqa3SfGHFhNMPwb4w43NhV96Majv3xbC3bH` (`--features mainnet`),
devnet `G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R` (default build).

- [Constants](programs/orbit_jackpot/src/constants.rs): basis points, PDA seeds, caps.
- [Errors](programs/orbit_jackpot/src/errors.rs): every `OrbitError` and `MathError` variant.
- [Events](programs/orbit_jackpot/src/events.rs): every event the program emits.
- [Invariants](programs/orbit_jackpot/src/invariants.rs): the assertion helpers called at the tail of every mutating instruction.
- [Entrypoints](programs/orbit_jackpot/src/lib.rs): the `#[program]` module.

### Instructions

**Round lifecycle (permissionless)**

| Instruction | Description |
|---|---|
| [`open_round`](programs/orbit_jackpot/src/instructions/open_round.rs) | Opens round `next_round_id` once no round is open. |
| [`deposit`](programs/orbit_jackpot/src/instructions/deposit.rs) | Escrows SOL and mints one entry with its ticket range. Creates the player's profile on first use. |
| [`lock_round`](programs/orbit_jackpot/src/instructions/lock_round.rs) | Closes the deposit window, rolls an empty window, or auto-cancels. |
| [`request_entropy`](programs/orbit_jackpot/src/instructions/request_entropy.rs) | Entropy source: pins the round to the hash chain and fixes its target slot (write-once). |
| [`reveal_entropy`](programs/orbit_jackpot/src/instructions/reveal_entropy.rs) | Entropy source: publishes the next chain seed and fixes the round's value. |
| [`request_randomness`](programs/orbit_jackpot/src/instructions/request_randomness.rs) | Switchboard source: pins the round's randomness account (write-once). |
| [`create_randomness`](programs/orbit_jackpot/src/instructions/create_randomness.rs) | Creates the Switchboard randomness account; the round PDA signs as authority. |
| [`commit_randomness`](programs/orbit_jackpot/src/instructions/commit_randomness.rs) | Commits the pinned account to an oracle (exactly once). |
| [`reveal_randomness`](programs/orbit_jackpot/src/instructions/reveal_randomness.rs) | Publishes the oracle's signed reveal (exactly once). |
| [`fulfill_settle`](programs/orbit_jackpot/src/instructions/fulfill_settle.rs) | Resolves the winning ticket and moves the cuts. |
| [`cancel_round`](programs/orbit_jackpot/src/instructions/cancel_round.rs) | Cancels a round whose reveal timed out; `refund_entry` returns each stake in full. |
| [`claim_winnings`](programs/orbit_jackpot/src/instructions/claim_winnings.rs) | Pays the winning entry's owner. O(1) membership proof. |
| [`close_entry`](programs/orbit_jackpot/src/instructions/close_entry.rs) | Pays an entry's refund (and Mega field share) and reclaims its rent. |
| [`sweep_unclaimed_prize`](programs/orbit_jackpot/src/instructions/sweep_unclaimed_prize.rs) | Routes a lapsed, unclaimed prize into the Mega-Pot. Refunds are never swept. |
| [`close_randomness`](programs/orbit_jackpot/src/instructions/close_randomness.rs) | Reclaims the Switchboard randomness rent of a terminal round (entropy rounds: clears the pin). |
| [`close_round`](programs/orbit_jackpot/src/instructions/close_round.rs) | Closes a drained, pruned round and returns the rent to its opener. |

**Auto-play escrows**

| Instruction | Description |
|---|---|
| [`init_or_deposit_escrow`](programs/orbit_jackpot/src/instructions/init_or_deposit_escrow.rs) | Player funds their escrow and sets auto-deposit terms. |
| [`withdraw_escrow`](programs/orbit_jackpot/src/instructions/withdraw_escrow.rs) | Player withdraws spendable escrow lamports. Never pause-gated. |
| [`crank_auto_deposit`](programs/orbit_jackpot/src/instructions/crank_auto_deposit.rs) | Permissionless: enters a funded escrow into the open round; the escrow pays the stake, the rent and a bounded tip. |

**Admin**

| Instruction | Description |
|---|---|
| [`initialize`](programs/orbit_jackpot/src/instructions/initialize.rs) | One-time setup. |
| [`update_config`](programs/orbit_jackpot/src/instructions/update_config.rs) | Operational parameters only, including the randomness source for new rounds. Economics are not in the argument struct. |
| [`set_entropy_chain`](programs/orbit_jackpot/src/instructions/set_entropy_chain.rs) | Creates or rotates the entropy hash-chain commitment; refused while a round is in flight on it. |
| [`toggle_pause`](programs/orbit_jackpot/src/instructions/admin_toggle_pause.rs) | Blocks `deposit` and `open_round`. Withdrawals, claims and refunds keep working. |
| [`admin_sweep_fees`](programs/orbit_jackpot/src/instructions/admin_sweep_fees.rs) | Treasury authority sweeps accrued protocol fees. |
| [`transfer_admin`](programs/orbit_jackpot/src/instructions/transfer_admin.rs), [`accept_admin`](programs/orbit_jackpot/src/instructions/accept_admin.rs) | Two-step admin handover. |
| [`migrate_economics_v2`](programs/orbit_jackpot/src/instructions/migrate_economics.rs), [`migrate_economics_v3`](programs/orbit_jackpot/src/instructions/migrate_economics_v3.rs) | One-way economics latches. Refuse while any round is in flight. |
| [`drain_mega_pot_v1_preflight`](programs/orbit_jackpot/src/instructions/drain_mega_pot_v1_preflight.rs) | One-shot v1 preflight for the v2 latch. Dead once `economics_version >= 2`. |

### State

Seven PDAs. Layouts are frozen by size-lock tests; any field change fails
a named test before it can fail at deploy time.

| Account | Seeds | Purpose |
|---|---|---|
| [`GlobalConfig`](programs/orbit_jackpot/src/state/global_config.rs) | `["config"]` | Admin keys, oracle, timing, economics version, fee basis points. |
| [`TreasuryVault`](programs/orbit_jackpot/src/state/vaults.rs) | `["treasury"]` | Accrued protocol fees. |
| [`MegaPotVault`](programs/orbit_jackpot/src/state/vaults.rs) | `["mega_pot"]` | The progressive pot. |
| [`Round`](programs/orbit_jackpot/src/state/round.rs) | `["round", round_id]` | State machine, totals, pinned randomness, winning ticket. |
| [`RoundVault`](programs/orbit_jackpot/src/state/vaults.rs) | `["round_vault", round_id]` | The round's stakes. `lamports == rent + vault_owed` at all times (I1). |
| [`PlayerEntry`](programs/orbit_jackpot/src/state/player_entry.rs) | `["entry", round_id, entry_index]` | One deposit: owner, stake, ticket range. |
| [`PlayerEscrow`](programs/orbit_jackpot/src/state/player_escrow.rs) | `["escrow", owner]` | Player profile and auto-play balance. One per wallet. |

Integers in seeds are little-endian. The seed literals are pinned byte-for-byte in `constants.rs` tests.

### Events and errors

The program emits 23 events through `emit_cpi!`, from `RoundOpened` to
`EconomicsMigrated`; the SDK decodes all of them and provides a
subscription transport. There are 86 named error variants. Both files are
the authoritative list:
[`events.rs`](programs/orbit_jackpot/src/events.rs),
[`errors.rs`](programs/orbit_jackpot/src/errors.rs).

### Invariants

The program carries a numbered invariant catalog (I1 up to I22). The
account-level ones are pure assertion helpers in
[`invariants.rs`](programs/orbit_jackpot/src/invariants.rs), unit-tested
in isolation and called at the tail of every mutating handler; the
constant-level ones are pinned by tests in `constants.rs`. The most
important ones:

- **I1** The round vault holds exactly its rent plus what it owes.
- **I14** The four basis-point slices sum to exactly 10,000.
- **I18** The pot split reassembles the pot to the lamport.
- **I21** A Mega-Pot pop can never pay more than the rake the round could have been charged over `MEGA_TRIGGER_MODULUS` rounds.
- **I22** Rounding dust at round close is at most 2 lamports per entry.

Arithmetic is checked everywhere; the release profile keeps
`overflow-checks = true` so the SBF build panics on overflow exactly as the
test build does.

## SDK

`@orbit-jackpot/sdk` is the client mirror of the program: PDA derivation,
offset-pinned account decoders verified against a Rust-generated layout
fixture, event decoders, raw `web3.js` transaction builders with committed
discriminators, and `math/economics` and `math/wheel`, the BigInt mirrors
of the on-chain split and wheel geometry. The committed IDL is at
[`packages/sdk/idl/orbit_jackpot.json`](packages/sdk/idl/orbit_jackpot.json)
and is regenerated by `anchor build`; CI fails if it drifts.

See [`packages/sdk/CHANGELOG.md`](packages/sdk/CHANGELOG.md).

## Build and test

Toolchain: Rust 1.91.1 (pinned in `rust-toolchain.toml`), Solana CLI 3.x
(Agave), Anchor CLI 0.32.1, Node 20 or newer.

```bash
npm ci
anchor build                                   # program .so + IDL into target/
cargo test -p orbit_jackpot --lib              # unit and property tests
cargo test -p orbit_jackpot --test integration # banks-client suite; needs the .so from anchor build
npm run lint                                   # cargo fmt --check + clippy -D warnings
npm run test:sdk && npm run test:crank && npm run test:web
npm run typecheck && npm run typecheck:crank && npm run typecheck:web && npm run typecheck:raffle
```

`npm run verify:all` runs the whole matrix. The raffle tests need a local
Postgres (`DATABASE_URL`); everything else is hermetic.

A local end-to-end demo against `solana-test-validator`, with a
deterministic randomness account, is documented in
[`docs/reports/local-demo.md`](docs/reports/local-demo.md).

## Verifiable build

The mainnet program is built with `--features mainnet` and the workspace
release profile (`opt-level = "s"`):

```bash
cargo install solana-verify
solana-verify verify-from-repo -um \
  --program-id ETMqujXHndqa3SfGHFhNMPwb4w43NhV96Majv3xbC3bH \
  --library-name orbit_jackpot \
  https://github.com/orbfun-dev/ORB -- --features mainnet
```

The binary deployed today was built locally, not inside solana-verify's
pinned container, so this check will not match until the next upgrade is
built reproducibly. Until then, `solana program dump` the live program and
compare it with a local `cargo build-sbf -- --features mainnet` of this
commit on macOS arm64.

## Running the keeper and the app

- Keeper: `apps/crank/.env.example` documents every `CRANK_*` variable;
  [`docs/runbooks/crank-ops.md`](docs/runbooks/crank-ops.md) is the
  production runbook (systemd or Docker). The keeper needs only its own
  hot wallet; it holds no player funds.
- Web: `apps/web/.env.example`, then `npm run dev:web`.
- Raffle: `api/.env.example` and
  [`docs/runbooks/raffle-ops.md`](docs/runbooks/raffle-ops.md).

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

The program has not yet been audited by a third party. An internal review
and its fixes are in [`docs/AUDIT_REPORT.md`](docs/AUDIT_REPORT.md); the
entropy source added after it is covered by
[`docs/design/randomness-fallback.md`](docs/design/randomness-fallback.md)
and its tests.

Known trust assumptions:

- A single admin key controls `update_config`, pause, the economics
  latches, fee sweeps (via the treasury authority) and the upgrade
  authority. Moving the upgrade authority to a multisig is on the mainnet
  launch checklist.
- Mainnet randomness comes from the operator's hash chain plus a future
  slot hash. The operator cannot choose outcomes, but it sees each value
  first and could withhold a reveal; that halts the game publicly for
  ~24 h and never changes the winner. A leaked seed chain combined with a
  colluding slot leader could bias outcomes. Seeds never touch this
  repository.
- The Switchboard source pins the randomness account to the round before
  the reveal, constrains its owner and queue, and bounds the reveal by a
  slot deadline. The oracle's TEE signature is verified by the Switchboard
  program inside the reveal CPI, so the Switchboard program and its
  oracle set are part of the trusted computing base when it is selected.

## Documentation

[`docs/README.md`](docs/README.md) indexes everything under `docs/`:
architecture and economics, operational runbooks, measured reports (CU
profiles, rent, demos), and the design specs the code was built from.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License, Version 2.0. See [LICENSE](LICENSE).
