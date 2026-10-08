# Documentation index

| Document | What it is |
|---|---|
| [`architecture.md`](architecture.md) | The game, the pot split, the Mega-Pot, player profiles, and why the economics are immutable. Start here. |
| [`AUDIT_REPORT.md`](AUDIT_REPORT.md) | Internal pre-mainnet security review: findings and the fixes that shipped. Not a third-party audit. |

## Runbooks

Operational procedures for the people running the deployment.

| Runbook | Covers |
|---|---|
| [`runbooks/crank-ops.md`](runbooks/crank-ops.md) | Installing, funding, monitoring and upgrading the keeper on a host (systemd or Docker); auto-deposit enablement; refund cleanup; idle behaviour. |
| [`runbooks/mainnet-launch.md`](runbooks/mainnet-launch.md) | The mainnet launch phases, readiness checks and rollback. |
| [`runbooks/economics-migration.md`](runbooks/economics-migration.md) | The exact cutover order for the one-way economics latches. |
| [`runbooks/raffle-ops.md`](runbooks/raffle-ops.md) | Deploying and operating the off-chain raffle: database, cron jobs, epochs, draw verification. |

## Reports

Measured results, kept so numbers in the code have a source.

| Report | Covers |
|---|---|
| [`reports/cu_profile.md`](reports/cu_profile.md) | Compute-unit profile per instruction; the basis for batch sizes. |
| [`reports/switchboard-rent.md`](reports/switchboard-rent.md) | Where Switchboard randomness rent goes and how `close_randomness` reclaims it. |
| [`reports/idle-burn.md`](reports/idle-burn.md) | Keeper cost per empty round before and after the window-roll design. |
| [`reports/local-demo.md`](reports/local-demo.md) | End-to-end run against a local validator with deterministic randomness. |
| [`reports/devnet-demo.md`](reports/devnet-demo.md) | The devnet deployment record and protocol walkthrough. |

## Design

`design/` holds the design documents the code was built from:
[`randomness-fallback.md`](design/randomness-fallback.md) (the self-hosted
entropy source and its threat model), auto-deposit escrows, the
partial-loss economics with a verification script, and the raffle and
referral engine. They are historical: where they disagree with the code,
the code and `architecture.md` win.
