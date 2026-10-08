# ORB mainnet launch plan

Written 2026-10-08 against `main` at `c7a31e9`. Re-check every "verified"
line on launch day; Switchboard and RPC providers change under you.

## Readiness today

| # | Item | State | Notes |
|---|---|---|---|
| 1 | Security audit (Fable 5.1) | **blocker** | Not started. Must review the exact commit that ships (after phase 1). |
| 2 | Program address | done (phase 1) | `--features mainnet` builds `ETMqujXH…` (`declare_id!` in `lib.rs`, `Anchor.toml [programs.mainnet]`); the SDK/web/crank select it with `ORB_CLUSTER=mainnet` / `VITE_ORB_CLUSTER=mainnet`. Default stays devnet. Verified: each binary embeds only its own id. |
| 3 | Fresh init economics | done (phase 1) | No program change: `scripts/mainnet/init-config.ts` sends `initialize` + `migrate_economics_v3` in ONE transaction, so mainnet is never on v2. |
| 4 | Mainnet init script | done (phase 1) | `scripts/mainnet/init-config.ts`: dry-run by default, refuses unless built for mainnet, checks the deployed program and its upgrade authority, simulates, verifies the config after `--send`. `ORB_REHEARSAL=devnet` runs it against devnet for phase 2. |
| 5 | Keeper economics on mainnet | **must measure** | The mainnet oracle queue lists a 900 000-lamport reward per request (devnet's 1 000 000 was never charged to the keeper). Measure in the smoke test before choosing `keeper_tip_lamports`. |
| 6 | Web cluster switch | **decision** | The web app serves one cluster (`VITE_SOLANA_RPC_URL` + the SDK's `PROGRAM_ID`). Pointing playorb.fun at mainnet retires the devnet game there. |
| 7 | Raffle: ORB-game entries | **decision** | The rules page says ORB rounds earn entries "when ORB moves to mainnet". There is no server path for them yet (the ORE indexer pattern would work). |
| — | Switchboard on mainnet | ready | Verified 2026-10-08: all five instructions we CPI (`randomness_init`, `_commit`, `_reveal`, `_close`, `_close_lut`) are recognized by `SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv`, and their account lists and params are identical to devnet's. Queue `A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w`, 12 oracles. |
| — | Mainnet keys | ready | Generated 2026-10-08 and backed up offline by the owner; `~/.config/orb/mainnet/WALLETS.md`. Unfunded. |
| — | Rent reclaim, economics v3 | ready | Both live on devnet since 2026-10-08 and verified on real rounds (358, 382). |
| — | Crank | ready | Fully env-driven (`CRANK_RPC_URL`, `CRANK_SB_CROSSBAR_URL`, `CRANK_PRIORITY_FEE_MICROLAMPORTS`, `CRANK_COMPUTE_UNIT_LIMIT`, …). Only the explorer link in logs says `cluster=devnet`. |
| — | ORE tab and raffle fee wallets | ready | Already on mainnet; unchanged by this launch. |

## Phase 0 — owner decisions

Settle these first; phase 1 encodes them.

1. Mainnet config values. Devnet's are on the left as a reference:

   | Field | Devnet | Proposed mainnet |
   |---|---|---|
   | `round_duration_secs` | 60 | 120 |
   | `max_round_duration_secs` | 600 | 600 |
   | anti-snipe window / extension | off | off |
   | `claim_deadline_secs` | 3 600 (1 h) | 604 800 (7 days) |
   | `min_deposit_lamports` | 0.01 SOL | 0.01 SOL |
   | `max_entries_per_round` | 100 | 500 (AUDIT P-6: raises the cost of filling a round to lock others out) |
   | `keeper_tip_lamports` | 100 000 | set after measuring (item 5) |
   | `auto_deposit_tip_lamports` | 30 000 | ≥ 25 000; set after measuring |
   | `account_open_fee_lamports` | 0.01 SOL | 0.01 SOL |
   | `randomness_reveal_deadline_slots` | 400 | 400 |
   | Mega-Pot: 1-in-625, 8× cap, 50/40/10 | same | same (immutable after init) |

2. Domains: playorb.fun → mainnet at launch; devnet moves to a staging URL (e.g. a Vercel preview alias) or stops.
3. Raffle: do ORB rounds earn entries at launch, or in a follow-up?
4. Who signs mainnet transactions: this machine with the keys in `~/.config/orb/mainnet/`, or a hardware wallet for admin and upgrade authority.

## Phase 1 — code prep (Claude) — DONE 2026-10-08

As built (differs from the original plan where noted):

- Program id per build: `cargo build-sbf --features mainnet` (or `anchor build -- --features mainnet`).
- SDK `PROGRAM_ID` from `ORB_CLUSTER` (Node) / `VITE_ORB_CLUSTER` (web build, via Vite `define`); a typo throws.
- v3 from birth via the combined init transaction instead of an `initialize` change (no audit surface added).
- Crank: `ORB_CLUSTER` in config with startup guards (mainnet requires an explicit non-devnet RPC and a keeper key); explorer links follow the cluster; `apps/crank/.env.mainnet.example` + `apps/crank/orbit-crank-mainnet.service` (separate state dir and health port, so the devnet keeper keeps running).
- Idle keeper cost → zero: the idle window roll fires only while an auto-play escrow is armed.

Original plan:

1. Program id: `declare_id!` → `ETMqujXH…`; `Anchor.toml` `[programs.mainnet]`; SDK `PROGRAM_ID` chosen per cluster at build time (mainnet id for production builds, devnet id kept for staging and the devnet crank).
2. `initialize` births at `economics_version: 3`; integration test that a fresh config settles a whale round under v3 with no migration.
3. `scripts/mainnet/init-config.ts`: loads `~/.config/orb/mainnet/`, Switchboard mainnet program + queue, the phase-0 values, `treasury_authority = orb-treasury-authority`, admin = `orb-admin`. Dry-run by default; prints every arg; `--send` to execute.
4. Crank: `apps/crank/.env.mainnet.example`; explorer cluster from env; a second systemd unit (`orbit-crank-mainnet`) with its own state dir, so the devnet keeper keeps running for staging.
5. Web: production env template for mainnet (`VITE_SOLANA_RPC_URL` = paid mainnet RPC restricted to playorb.fun); remove "devnet" wording from the rules and docs pages.
6. Optional: `solana-security-txt` block in the program; verifiable build (`solana-verify build`) so explorers can match the binary to the source.

## Phase 2 — rehearsal on devnet

Run the exact mainnet procedure against devnet: deploy the MAINNET build (same binary, same `ETMqujXH…` id — a keypair is independent per cluster) with the mainnet keys funded from the devnet admin, then `ORB_CLUSTER=mainnet ORB_REHEARSAL=devnet MAINNET_RPC_URL=<devnet rpc> npx tsx scripts/mainnet/init-config.ts --send`:

1. Deploy, `initialize` (v3 from birth), start a crank on that id.
2. Two test wallets deposit; round settles; `close_randomness` + LUT sweep reclaim; winner claims; fee sweep to the receiver.
3. Record: every transaction's fee, keeper net per settled round, CU per instruction.
4. Close the rehearsal program afterwards (`solana program close`) to reclaim its rent.

### Phase 2 result — DONE 2026-10-08 (devnet, mainnet build `5313e8ec…` sha256, id `ETMqujXH…`)

Everything ran with the real mainnet keys and scripts; only the RPC was devnet.

| Step | Result | Cost |
|---|---|---|
| Deploy (`solana program deploy`, mainnet keys) | ok, 20 s | 3.7786 SOL rent + 0.0045 fees; buffer refunded |
| `scripts/mainnet/init-config.ts --send` | ok; economics v3 from birth, all values verified | 0.0045 SOL |
| Round 0: 0.1 vs 0.01 SOL | winner take-home 0.1009, admin cut 0.0001 (1% of the loser) | — |
| Rent reclaim (close_randomness + LUT sweep) | 5 999 480 lamports back per round | — |
| Fee sweep (`scripts/mainnet/sweep-fees.ts --send`) | exactly 0.0014 SOL to `orb-fee-receiver` | — |
| Auto-play escrow | idle roll fired only once an escrow was armed; auto-deposit; sole-depositor round cancelled + refunded; escrow-won prize claimed via owner signature | — |
| Pause | deposit refused while paused; unpause restores | — |
| Program upgrade with `orb-upgrade-authority` | ok; live bytes = build | 0.0037 SOL |

Keeper per settled round: ~70 000 lamports of fees vs a 100 000 tip →
**+35 000** net. Switchboard's listed queue reward (devnet 1 000 000,
mainnet 900 000) was **not** charged to the keeper on devnet; confirm on
the mainnet smoke round before trusting it.

Findings fixed during the rehearsal (main `0ff4994`):

1. The crank sent its paid RPC URL (API key included) to third-party
   oracle gateways on every reveal → now `CRANK_GATEWAY_RPC_URL`,
   defaulting to the public cluster RPC.
2. The crank's startup log printed the RPC API key into journald → redacted.

Findings for the owner's phase-0 decisions:

- With `keeper_tip_lamports = 100 000`, the treasury earns **nothing** on a
  round whose losing stakes total ≤ 0.01 SOL (the 1% admin cut is all tip).
  It earns on bigger rounds (0.15 SOL losing → 0.0014 to the treasury).
  Lowering the tip toward the measured ~70 000 fee cost moves that line.
- The first sweep into an empty `orb-fee-receiver` must be at least the
  rent-exempt minimum for a system account, or it fails; sweep after fees
  have built up, or pre-fund the receiver with ~0.001 SOL.
- A player's first deposit costs stake + 0.01 SOL profile fee + rent
  (0.0125 SOL extra on devnet's rent); later deposits cost stake + entry
  rent only, and entry rent comes back on close.

The rehearsal deployment stays on devnet (idle, zero keeper cost) for the
audit to reproduce against; `solana program close` it afterwards to
recover the devnet SOL.

## Phase 3 — audit

1. Fable 5.1 audits the phase-1 commit (report: `docs/AUDIT_REPORT.md`).
2. Fix findings; if the program changed, repeat phase 2.
3. Record the audited commit and the `sha256` of its `orbit_jackpot.so`.

## Phase 4 — fund (owner)

| Wallet | Amount | Comes back |
|---|---|---|
| `orb-upgrade-authority` | 8 SOL | ≈ 4.2 SOL after the deploy (buffer refund) |
| `orb-keeper` | 0.5 SOL | working float |
| `orb-admin` | 0.05 SOL | — |
| `orb-treasury-authority` | 0.01 SOL | — |
| two smoke-test wallets | 0.05 SOL each | mostly, via refunds |

Re-check program rent with `solana rent <so-size + 45>` on launch day.

## Phase 5 — mainnet deploy (Claude, ~1 hour)

1. Build from the audited commit in a clean tree; confirm the `.so` sha256 matches phase 3.
2. Deploy: `solana program deploy target/deploy/orbit_jackpot.so --program-id ~/.config/orb/mainnet/orb-program.json --upgrade-authority ~/.config/orb/mainnet/orb-upgrade-authority.json --keypair ~/.config/orb/mainnet/orb-upgrade-authority.json --url <mainnet RPC> --with-compute-unit-price <µlamports>`; then `solana program show` and dump-compare against the build.
3. `npx tsx scripts/mainnet/init-config.ts` (dry run, read every value) then `--send`.
4. Start `orbit-crank-mainnet` with `orb-keeper`; watch `/healthz` and the logs.

## Phase 6 — soft launch (site still on devnet)

1. Smoke round with the two test wallets: deposit, settle, claim, close, reclaim, LUT sweep.
2. Verify: treasury accrued exactly 1% of the losing stake less the tip; Mega-Pot +1%; keeper net per round; then a fee sweep from `orb-treasury-authority` to `orb-fee-receiver`.
3. Set the measured `keeper_tip_lamports` / `auto_deposit_tip_lamports` via `update_config`.

## Phase 7 — public launch

1. Vercel production env → mainnet; deploy `main`; verify the live bundle and a deposit from the site.
2. Devnet to staging per phase 0.
3. Raffle ORB entries if chosen in phase 0.
4. Announce.

## Phase 8 — after launch

- Move the upgrade authority to a Squads multisig.
- Fee sweeps on a schedule (`admin_sweep_fees`, signer `orb-treasury-authority`, destination `orb-fee-receiver`).
- Keeper balance alert (crank `CRANK_MIN_KEEPER_BALANCE_SOL`), healthz monitoring.
- Open-source when ready (private vulnerability reporting needs the repo public).

## Operator rules (AUDIT P-7)

- **The keeper key and the operator never play.** The crank sees each
  oracle value before anyone else does. A keeper holding entries could
  withhold a losing reveal and let the round time out into a full refund.
  The crank now reveals and settles in one transaction, which removes the
  tip race (AUDIT P-5), but only this rule removes the withholding option.
- **Publish the oracle-timeout cancel rate.** Count `RoundCancelled` events
  with reason `oracle_timeout` per week. A rate above the oracle's
  background failure rate is the signal that a keeper is withholding.
- **Follow-up, not built yet:** a "settle now" button in the web app that
  fetches the reveal from the public gateway and submits reveal and settle
  itself, so any player can force the outcome.

## Rollback

- **Pause** (`admin_toggle_pause`): blocks deposits and new rounds; every exit path (claims, refunds, closes, escrow withdrawals) keeps working.
- **Program**: re-deploy the previous audited `.so` (keep every deployed binary).
- **Web**: promote the previous Vercel deployment.
- **Never close the mainnet program** while any round, escrow, treasury or Mega-Pot balance exists — that SOL would be locked forever.
