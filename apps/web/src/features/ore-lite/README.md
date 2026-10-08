# ORE Lite — standalone mainnet mining feature

The ORE tab (`/#/ore`, rendered in the shared app shell — old `/ore-lite`
links redirect there) deploys SOL into ORE mining rounds on
**Solana mainnet-beta** and bundles a platform fee into the same transaction.
It talks only to the official ORE program
(`oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv`) — no proxy program, no
backend, no crank. The rest of ORB stays on devnet: the tab shares only the
shell and the wallet with it, scopes its own mainnet connection and query
client, and never imports app code (enforced by
`apps/web/tests/ore_isolation.test.ts`).

## Environment

| variable | purpose | default |
|---|---|---|
| `VITE_ORE_FEE_RECIPIENT` | Platform-fee destination (base58). **Required** — the module throws at load when unset so a missing fee can never ship silently. | none — the ORE tab shows the error boundary |
| `VITE_ORE_RPC_URL` | Dedicated mainnet RPC for this page. Set a private endpoint for production traffic. | `https://api.mainnet-beta.solana.com` |
| `VITE_ORE_EXECUTOR_PUBKEY` → **removed** | The keeper design was dropped — see the auto-join bullet below. | — |
| `VITE_ORE_AUTOJOIN_ENABLED` | Any truthy value enables the multi-round (Automate) UI. **Do not enable until the P5 dust run has validated our setup/stop transaction combo** — the execution path itself is already live-proven by 27 permissionless Preferred automations. | unset — auto-join disabled |

Both are read at build time by Vite; configure them in `apps/web/.env.local`
or the Vercel project settings.

## Architecture

Everything lives in this directory:

- `codec.ts` / `pda.ts` / `instructions.ts` / `fee.ts` / `planner.ts` — PURE
  (no React, no `Connection`); the entire test surface lives here.
- `client.ts` — `OreClient`: batched reads, deploy/claim assembly,
  simulate-before-sign, priority-fee estimation, block-hash-expiry handling.
- `hooks/` — snapshot polling (slot 5 s, accounts 5 s + invalidation after
  sends; shared rate-limit-aware backoff in `pollPolicy.ts` — 429s are
  never retried in-cycle and intervals double per consecutive failure) and
  the build → simulate → sign → send → confirm pipeline.
- `OreLiteRoot.tsx` + `components/` — the mainnet connection + query
  client scope and the page, lazy-mounted by `src/pages/OrePage.tsx`.

The deploy transaction is one atomic v0 bundle shaped exactly like a live
ore.com deploy:

```
ComputeBudget.setComputeUnitLimit | ComputeBudget.setComputeUnitPrice |
SystemProgram.transfer(platform fee → recipient) |
Checkpoint | Deploy
```

Atomicity is the fee mechanism: the transfer lands iff the deploy lands.
No wrapper program, no upgrade authority, no audit surface.

## Design decisions recorded by the directive

- **Deploy All, Pro-convention totals.** The typed figure is the ROUND
  TOTAL, split evenly across every square the miner doesn't already hold
  this round (`selectedSquares` defaults to the whole board in the
  planner). This deliberately diverges from ore.com's Lite tab, where the
  typed figure is PER SQUARE — hence the "TOTAL THIS ROUND" label and the
  derived `≈ X SOL per square × N squares` line under the input. Under the
  per-square convention a user typing `1` on a 25-square board would spend
  25 SOL.
- **Deploy-all economics: lower variance, NOT lower cost.** Holding all 25
  squares guarantees you hold the winning square, but `Round::
  calculate_fees` takes 1% admin on every square plus 10% protocol on
  every non-winning square — ≈ `1% + 10% × 24/25 ≈ 10.6%` of deployed
  capital is raked per round. The UI must not imply otherwise.
- **Truncation remainder.** `amountPerSquare = floor(total / count)`;
  the 0–24-lamport remainder is never deployed and never charged (the
  platform fee is computed on `totalDeploy`). Below
  `MIN_DEPLOY_TOTAL_LAMPORTS` (0.001 SOL) the plan blocks as
  `amount-too-small`.
- **No platform fee on claims.** ClaimSOL/ClaimORE move the user's own
  winnings; feeing a withdrawal destroys trust for zero revenue.
- **ROUNDS / auto-join — NO-KEEPER design (supersedes the keeper plan in
  the auto-join directive).** Multi-round uses ORE's **permissionless
  executor** (`executor111…112`): `deploy.rs:76` accepts any signer, and
  a competitive public bot fleet races to execute every round for the
  on-account fee (verified live 2026-10-07: 27 Preferred+permissionless
  automations, the top one `Bsxit5rr…` with 290 SOL pushed through
  automated deploys at ~115 s cadence, multiple same-slot racing
  signatures and a losing bot eating its own fee). The keeper design
  (A11's unproven path) is shelved for a possible future
  `DiscretionaryBps` premium tier. OUR revenue is a **one-time platform
  fee on the setup transaction** — 1% of the deposit (floor/ceiling
  clamped), bundled as a `SystemProgram.transfer` atomic with the
  `Automate` instruction: `[CU, CU, transfer, Automate]`. Charging once
  on the aggregate equals 1% per round summed, and at dust scale it
  dodges the per-round floor that made the keeper 8× the market at the
  median (10 rounds × 0.0012 SOL: 120 700 vs the keeper's 1 000 000).
  The automation's own `fee` field is 7 000 lamports/round — the public
  market rate (`COMPOUND_FEE_PER_TRANSACTION`) that makes the fleet
  bother; it goes to whichever bot wins the round, not to us, and only
  for rounds that run. Rounds are a BUDGET: `deposit = rounds ×
  (perRound + 7 000)`; the program self-closes + refunds when one more
  round can't be covered. Stop is always the user's own one signature
  (`Automate(executor = Pubkey.default())`), fee-free. Gate:
  `VITE_ORE_AUTOJOIN_ENABLED`, dark until the P5 dust run.
- **No Jito.** The official client appends a flat 2 000-lamport transfer
  to a Jito tip account; on a plain RPC that is just 2 000 lamports
  burned (it only does anything when the submitting RPC forwards to a
  Jito block engine). Revisit only if we run a Jito-enabled endpoint.
- **Compute budget from simulation.** CU limit = `unitsConsumed × 1.25`
  (floor 50 000, +100 000 when opening a round for the entropy CPI).
  Priority = 75th percentile of `getRecentPrioritizationFees` over the
  exact writable accounts, clamped to [1 000, 2 000 000] µlamports,
  ×1/×2/×4 by the Normal/Fast/Turbo selector.

## Known residual risk (R3 race)

Deploy silently skips squares the miner already occupies this round. Three
layers of mitigation:

1. **Mask filtering (R3):** the plan drops squares the miner already
   occupies in the CURRENT round — and only the current round, since
   deploy.rs zeroes `miner.deployed` when `miner.round_id != round.id`
   (a stale miner's rows belong to round N−1 and lock nothing).
2. **Pre-sign simulation + log guard:** the simulation is the last
   pre-sign look at chain state. ore's deploy log
   (`Round #<id>: deploying <sol> SOL to <K> squares`, emitted even when
   K = 0) is parsed; a K that disagrees with the plan — including the
   all-squares-sniped K = 0 case, or a missing log line — aborts before
   the wallet is ever asked to sign, so no fee is charged for a zero-op.
3. **Short window:** read → simulate → sign → send is a few seconds.

What remains: a competing transaction landing in the interval AFTER the
simulation passes but BEFORE the deploy executes on-chain can still make
the deploy a no-op while the fee lands. That residual window cannot be
closed client-side; the wrapper-program alternative was rejected by the
standalone constraint. Worst case is bounded by the fee floor (0.0001 SOL)
plus the transaction fee.

## Testing

- `tests/ore_codec.test.ts` — wire format + layouts (GATE 1)
- `tests/ore_fee_planner.test.ts` — R2/R3 fee math, MAX inversion (GATE 2)
- `tests/ore_automation.test.ts` — Automate wire format, A3 guard,
  automation-active blocker, commitment planner, live-fixture decode
- `tests/ore_poll_policy.test.ts` — 429/backoff poll policy
- `tests/ore_isolation.test.ts` — import boundary (GATE 5)
- `tests/ore_golden.test.ts` — full transaction shape vs live mainnet (GATE 6)
