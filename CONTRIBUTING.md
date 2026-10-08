# Contributing to ORB

Thank you for taking the time. This document covers the toolchain, the
test matrix, and the conventions that keep a program holding other
people's money reviewable.

## Toolchain

| Tool | Version | Notes |
|---|---|---|
| Rust | 1.91.1 | pinned by `rust-toolchain.toml` |
| Solana CLI (Agave) | 3.x | `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"` |
| Anchor CLI | 0.32.1 | `npm i -g @coral-xyz/anchor-cli@0.32.1` or `avm` |
| Node | 20 or newer | npm workspaces |
| Postgres | 15 or newer | only for `packages/raffle` tests |

## Setup

```bash
git clone https://github.com/orbfun-dev/ORB.git && cd ORB
npm ci
anchor build
npm run verify:all   # the full matrix; see below for the pieces
```

`anchor build` produces `target/deploy/orbit_jackpot.so`, which the
integration suite loads, and `target/idl/orbit_jackpot.json`, which must
match the committed copy in `packages/sdk/idl/`.

## Test matrix

| Command | What it covers |
|---|---|
| `cargo test -p orbit_jackpot --lib` | Unit and property tests: math, invariants, layouts, seeds, entropy known-answer tests. |
| `cargo test -p orbit_jackpot --test integration` | Banks-client integration suite over the built `.so`: every instruction, every state transition, the economics latches, the Switchboard CPI surface. |
| `npm run lint` | `cargo fmt --check` and `clippy --all-targets -D warnings`. |
| `npm run test:sdk` | Decoders against the Rust layout fixture, builders, economics and wheel parity with the program. |
| `npm run test:crank` | Keeper evaluators and handlers against recorded chain states. |
| `npm run test:web` | Vitest: planners, stores, components. |
| `npm run test:raffle` | Needs `DATABASE_URL`; applies the SQL migrations and exercises the endpoints. |
| `npm run typecheck*` | One per workspace. |

CI runs all of these except the raffle database suite. A pull request
must be green before review.

## Conventions

**Money is integers.** `u64` and `u128` in Rust, `bigint` in TypeScript.
A float anywhere near a lamport amount will be rejected in review.
Arithmetic is checked (`checked_*`, or the `?`-propagating helpers in
`math/`); the release profile keeps `overflow-checks = true` for a reason.

**Every mutating instruction ends with its invariants.** If you add or
change a money path, call the relevant `invariants::*` helper at the tail
of the handler and add a test that would have failed without it. New
invariants get the next number in the catalog and a doc comment that
states the property in one sentence.

**Account layouts are frozen.** The size-lock tests in `state/` and the
layout fixture consumed by the SDK pin every byte. Changing a layout
means a migration plan, a fixture regeneration, and an SDK release; say
so in the pull request.

**The IDL is committed.** After any change to an instruction, account,
event or error, run `anchor build` and copy
`target/idl/orbit_jackpot.json` over `packages/sdk/idl/orbit_jackpot.json`.
CI fails on drift.

**Economics are not configurable.** Basis points, the trigger modulus and
the payout cap are deliberately absent from `update_config`. Do not add
them back. A change to the economics is a new one-way latch with its own
preconditions, tests and runbook.

**The SDK mirrors, it does not reinterpret.** `math/economics.ts` and
`math/wheel.ts` must produce the same integers as the Rust code for the
same inputs; the known-answer fixtures under `tests/fixtures/` are the
contract. Regenerate them from Rust, never by hand.

**Formatting.** `cargo fmt` for Rust. TypeScript follows the existing
style; there is no formatter enforced beyond the typechecker.

## Pull requests

- One logical change per pull request. Keep refactors separate from
  behaviour changes.
- Explain the *why* in the description. For anything touching a money
  path, name the invariant that protects it and the test that proves it.
- Commit messages follow `type(scope): summary`, for example
  `fix(program): refuse close_round while an entry is unpaid`.
- Do not include deployment artifacts, keypairs, `.env` files, or RPC
  URLs with keys. `.gitignore` covers the usual locations; look anyway.

## Security issues

Do not open an issue or a pull request for a vulnerability. Follow
[SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
Apache License, Version 2.0, the same license as the project.
