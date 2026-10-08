# Security Policy

## Reporting a vulnerability in the ORB program

**Do not open a public GitHub issue for a security problem.**

Report it through GitHub's private vulnerability reporting on this
repository ("Security" tab, then "Report a vulnerability"). Include:

- a clear title,
- a description of the issue and the affected instruction, account or
  code path,
- a proof of concept: a failing test against
  `programs/orbit_jackpot/tests/integration.rs`, a transaction on devnet,
  or a script that reproduces the problem.

Reports without a reproduction are treated as speculative and may be
closed. Please enable two-factor authentication on the GitHub account you
report from.

We aim to acknowledge every report inside the advisory within 72 hours.
If you get no response in that time, open a second advisory that
references the first; never post exploit details anywhere public.

## Scope

In scope:

- `programs/orbit_jackpot`: anything that lets funds be taken, frozen,
  mis-split, or paid to the wrong party; any way to bias or predict the
  winning ticket; any way to bypass an invariant, a pause, or an admin
  gate; any way for a keeper to do more than waste its own fees.
- `packages/sdk`: decoders or builders that produce a transaction the
  program accepts but the user did not intend.
- `apps/crank`: a path by which a third party can make the keeper sign
  something it should not.
- `packages/raffle` and `api/raffle`: any way to earn, duplicate or
  claim entries without the on-chain action that backs them.

Out of scope: denial of service through RPC rate limits, issues in
third-party dependencies that are not reachable from this code, social
engineering, and findings on infrastructure that is not in this
repository.

## Deployments

| Network | Program | Status |
|---|---|---|
| Devnet | `G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R` | live |
| Mainnet | not yet deployed | pending launch |

Mainnet program: `ETMqujXHndqa3SfGHFhNMPwb4w43NhV96Majv3xbC3bH`, upgrade
authority `BR1SL5zDLxnoWiXzs1KShicQbcYLT9Lp2BYGsSgMdJK2` (a single key
today; moving it to a multisig is planned).

## Audits

No third-party audit has been completed yet. The internal pre-mainnet
review is [`docs/AUDIT_REPORT.md`](docs/AUDIT_REPORT.md). Third-party
audit reports will be linked from this file when they are published.
