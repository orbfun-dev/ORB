# Orbit Jackpot — Devnet Live Runbook (phase 8.3–8.5)

Everything here was executed for real on 2026-10-06/07 against Solana
Devnet and the LIVE Switchboard On-Demand deployment. Program:
`G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R`.

## Live pins (verified on-chain)

| Artifact | Key |
| --- | --- |
| Switchboard On-Demand program | `Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2` |
| Default devnet queue | `EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7` (9 oracles) |
| Orbit program upgrade authority | `8Un22cz2zdGu3M5bhahDYiuckmGTY9GzAR6H6n8YdhM` (vaulted-admin) |

## The protocol (what actually runs on-chain)

`randomness_init`, `randomness_commit` and `randomness_reveal` all demand
the randomness account AUTHORITY's signature — our pin binds that
authority to the ROUND PDA, so all three run as CPIs from our program
(`create_randomness`, `commit_randomness`, `reveal_randomness`), the PDA
signing with `[ROUND_SEED, round_id_le, bump]`. The reveal payload
(`{signature[64], recovery_id, value[32]}`) is fetched off-chain from the
assigned oracle's HTTPS gateway (`gatewayUri` on the oracle account) and
presented by any crank; the Switchboard program verifies the TEE
signature inside the CPI. Anti-bias rests on: write-once pin, one
commit (seed_slot==0 lock), strict freshness `seed_slot > lock_slot` at
settle, and the oracle's signature over the committed slothash.

The chain-fetched IDL's isSigner/isMut flags are lossy — if you ever need
the real shape, probe the BUILT instruction (see
`scripts/devnet/probe-switchboard-idl.ts`) or read the live error.

## Full round lifecycle

```bash
# 0) one-time: initialize config with the live pins (idempotent)
npm run devnet:init

# 1) open the next round (presents the unclosed active round as the tail)
npm run devnet:open

# 2) seed 3 bot deposits (0.1 / 0.25 / 0.4 SOL, fresh-index contention retry)
npm run devnet:bots

# 3) settle: waits for end_ts on the CHAIN clock, then
#    lock → create_randomness → pin → commit_randomness →
#    gateway fetch → reveal_randomness → fulfill_settle → verify
npm run devnet:settle
```

The settle script is RESUMABLE at every stage (it re-reads the round
state and the randomness account, and skips what already landed). To
re-run only the verification of an already-settled round:

```bash
SETTLE_SIG=<settle signature> npm run devnet:settle
```

Every step prints its signature + explorer link. The final block asserts
the three-way match: chain `winning_ticket` ≡ `RoundSettled` event ≡
independent entropy mirror (`splitEntropy`/`ticketFromEntropy`).

## Web app against devnet

The app defaults to `https://api.devnet.solana.com` (see
`apps/web/.env.example`; set `VITE_SOLANA_RPC_URL=http://127.0.0.1:8899`
for the local-validator demo). `fetchEntries` falls back from
memcmp-`getProgramAccounts` to chunked `getMultipleAccounts` when a
public RPC refuses GPA. The event feed handles both inner-instruction
shapes (jsonParsed `programId` and raw `programIdIndex`).

To deposit through the UI, set Phantom/Solflare's own network selector
to Devnet, connect, and deposit ≥ 0.01 SOL. (The real wallet signature
is the one step no agent run can perform for you.)

## Recorded live runs

- **Round 0** — 6 entries / 1.5 SOL (two bot batches after a 429
  retry). Settle tx
  [`4DQ9Ygfp…`](https://explorer.solana.com/tx/4DQ9YgfprP8mbjhaaTmYEyETYVWNkbEUqpzzkSw7LAB9smGjKutAPBuMYVUKWoZCsNek56K6L8kkeEknhjXzkcob?cluster=devnet);
  commit tx `3ssd5db4…` (seed_slot 508,112,727), reveal tx `5rDQewPn…`
  (value `8273a264…`). Ticket **943,477,634** — three-way match.
- **Round 1** — 3 bot entries / 0.75 SOL, settled while the web app
  watched: settle tx
  [`3dxcJ2tx…`](https://explorer.solana.com/tx/3dxcJ2txomAa4JsvhMbznAQkjXrv4kF4kwTkcfvZwFooD9UXTAGz5d7u6Q9hnxLYAY757NSL4bW9BLUogvy5uiva?cluster=devnet);
  reveal tx `2qLf6G2w…` (value `e2555575…`). Ticket **657,733,090** —
  three-way match; in the browser the wheel spun and landed at
  1755.71° ≡ 315.71° = θ exactly, crowning the [350M, 750M) entry.

## Ops notes / gotchas

- **Recent-slot window**: the create CPI derives the account's LUT from a
  "recent slot"; use `confirmed` (not `finalized`) and retry with a
  fresh slot on failure — a delayed tx fails ALT CreateLookupTable with
  `… is not a recent slot`.
- **429s**: public devnet RPC rate-limits bursts. The scripts retry
  idempotently (raw re-send is safe by signature) and pace themselves;
  expect `polling` (not `live`) feed status under load.
- **Rent**: each round mints a randomness account + LUT (~0.003 SOL,
  unrecoverable — the authority is the round PDA); program alloc is
  591,384 B (extend needed if the ELF grows past it:
  `solana program extend <id> <extra bytes>`).
- **Upgrades**: `solana program write-buffer … --output json` then
  `solana program deploy --buffer <b> --program-id <id>`; the buffer
  upload is the slow part (~1–2 min for 566 K on public RPC).
