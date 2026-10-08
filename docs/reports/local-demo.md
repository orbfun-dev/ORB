# Local Demo Environment — Runbook

Phase 7.5 deliverable: a one-command local validator running the real
Orbit Jackpot program, a seeded live round, and the web frontend playing
the full game — deposit → wheel → settle → spin → claim — against real
chain state. No fixture mode involved.

## Prerequisites (already wired in this workspace)

- `cargo build-sbf --manifest-path programs/orbit_jackpot/Cargo.toml`
  produces `target/deploy/orbit_jackpot.so` (program id
  `G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R`).
- `solana-test-validator` (Agave) 3.x on PATH.
- The genesis randomness fixture `scripts/local-demo/randomness-account.json`
  is committed; regenerate deterministically with
  `npm run demo:gen-randomness` (never edits by hand — it is single-writer).

## The demo, in order

```bash
# 0) build the program (skip if .so is current)
cargo build-sbf --manifest-path programs/orbit_jackpot/Cargo.toml

# 1) boot the validator: program + genesis-preloaded randomness account.
#    Terminal A (it runs in the foreground; Ctrl-C to stop):
npm run demo:validator

# 2) seed: initialize (idempotent), open round 0, three bot deposits
#    (1.0 / 2.5 / 4.0 SOL), fund the demo-player keypair (10 SOL).
#    DEMO_ROUND_SECS controls the deposit window (default 45s).
DEMO_ROUND_SECS=120 npm run demo:seed

# 3) open the web app — LIVE, no ?fixture:
open http://localhost:5173/
#    You should see the 3 bot slices on the wheel, the countdown ticking
#    on the chain clock (getBlockTime-corrected), and the participants feed.

# 4) optional live deposit without a browser wallet (exact SDK path the
#    UI's useDeposit hook runs; the wheel appends the slice via websocket):
npm run demo:player-deposit -- 0.5

# 5) settle: waits out the window on the CHAIN clock, then runs the
#    permissionless crank  lock_round → request_randomness → fulfill_settle
#    against the preloaded randomness account.
npm run demo:settle
#    The browser needle spins (5s quartic ease-out, ≥4 laps) and stops on
#    the winning arc; the winner overlay appears — with the MEGA-POT HIT
#    celebration when the trigger fires.
```

### Playing with a real wallet (the full manual flow)

The seed funds `scripts/local-demo/keys/demo-player.json` (10 SOL,
generated on first run, git-ignored). Import its secret key into Phantom
(or Solflare) as a new account, connect at `http://localhost:5173/`, and
deposit through the UI — balance drops, the slice appears live, and if
that wallet wins, the CLAIM banner appears for one-click claiming.

## How the randomness mock works (the Phase 3 constraint, honored)

Real validators reject mid-test `set_account` mutations (bank-hash
verification), so the mock Switchboard account must exist **at genesis**:

- `gen-randomness-account.ts` writes the byte-exact 408-byte
  `RandomnessAccountData` (discriminator `10,66,229,135,220,239,217,114`;
  `authority = roundKey(0)`; `seed_slot = 1e9` ⇒ always fresh vs
  `lock_slot`; `reveal_slot = 1` ⇒ revealed) with owner =
  `DEMO_ORACLE_PROGRAM_ID` — the same id `seed-round.ts` pins into
  `config.oracle_program_id` at initialize, so the on-chain owner check
  passes.
- `start-validator.sh` preloads it via
  `--account <pubkey> scripts/local-demo/randomness-account.json`
  (Agave 3.x JSON: `{pubkey, account:{lamports,data:[base64,"base64"],
  owner, executable, rentEpoch}}`).
- The account's `value` is not arbitrary: the generator searches (pure TS
  mirror of `entropy.rs`/`tickets.rs`) for entropy whose outcome, against
  the scripted bot book, **fires the Mega-Pot** (mega half ≡ 0 mod 6767 —
  total-independent) and originally lands the ticket in the last bot's
  range. Extra deposits re-roll the winner (ticket = seed mod total) but
  the Mega celebration is guaranteed. In the recorded run the demo
  player's own 0.5 SOL deposit won 8.33 SOL.

## Script inventory

| Script | What it does |
| --- | --- |
| `demo:gen-randomness` | regenerates the deterministic randomness fixture JSON |
| `demo:validator` | boots solana-test-validator (program + genesis account) |
| `demo:seed` | initialize (idempotent) → open round → 3 bot deposits → fund demo player |
| `demo:player-deposit` | one deposit from the demo-player keypair (SDK path identical to the UI hook, incl. fresh-index retry) |
| `demo:settle` | waits out the window on chain time → lock → request → fulfill; prints the chain-derived outcome |

Notes:

- Everything is idempotent except the settle: the randomness fixture's
  authority is round 0's PDA, so the scripted settle targets round 0 —
  restart the validator (`demo:validator` resets the ledger) and re-seed
  for another full run.
- The demo keys under `scripts/local-demo/keys/` are generated on first
  use and git-ignored.
- `DEMO_RPC_URL` (default `http://127.0.0.1:8899`) points the scripts at
  another cluster; the web app's endpoint comes from
  `apps/web/.env.local` (`VITE_SOLANA_RPC_URL`), defaulting to the same.

## Recorded verification (2026-10-06)

- `demo:seed`: initialize ✓, open round 0 ✓, deposits 1.0/2.5/4.0 SOL ✓
  with telescoping ticket ranges `[0,1e9) [1e9,3.5e9) [3.5e9,7.5e9)`.
- `demo:player-deposit`: balance 10 → 9.498 SOL (deposit + entry rent),
  slice #3 appeared in the open browser via websocket.
- `demo:settle`: lock → request_randomness → fulfill_settle clean; winning
  ticket 7,877,552,896 / 8.5e9; winner entry #3 (demo player, 0.5 SOL);
  payout 8.33 SOL; Mega trigger fired (first-round accrual zero — the
  documented honest edge; the 1% cut contributed 0.085 SOL after).
- Browser: needle landed at 333.638° against SDK θ 333.64° (same value),
  winner arc gold + siblings dimmed, overlay with exact economics,
  MEGA-POT HIT badge on the reconnect path.
