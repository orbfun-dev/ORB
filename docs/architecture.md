# ORB — Orbit Jackpot Architecture & Mechanics (playorb.fun)

*Updated 2026-10-07 — Phase 11, the soft-jackpot economics.*

## The game in one paragraph

ORB is a pari-mutuel jackpot wheel on Solana: players stake SOL into a
timed round, every lamport mints one ticket, and Switchboard On-Demand
randomness picks one ticket when the window closes. Under the **v2
soft-jackpot economics** nobody loses their stake to the house: every
entry is docked a uniform 11% (9 points fund the winner, 2 points are
protocol fees), the remaining **89% is refunded to every player pro-rata
the moment the round settles**, and a progressive Mega-Pot pops roughly
every 1-in-625 rounds to pay a bonus on top.

## The four-way split (per settled round)

| Slice | Share | Where it goes |
|---|---|---|
| Winner | 9% (`winner_bps 900`) | `claim_winnings` — the winning ticket's player |
| Refunds | 89% (`refund_bps 8_900`) | `close_entry` — **every** entry pro-rata by stake, winner included |
| Admin | 1% (`fee_bps_admin 100`) | treasury (keeper tip paid out of it) |
| Mega-Pot | 1% (`fee_bps_mega 100`) | the progressive pot |

Expected value is a **flat −2% of stake** for every player at every pot
share and under every wallet-splitting strategy (−1% true house edge once
the Mega slice returns to players; RTP 99.0%). The pro-rata denominator is
always the whole pot — the uniform dock is what makes whale concentration
and sybil splitting worthless, and it is the only version computable at
settle time (settlement records a *ticket*, never a winner — ADR-2).

## The Mega-Pot (the dream carrier)

- Trigger odds **1-in-625** per round (`mega_trigger_modulus`), carved
  from the second half of the settle randomness.
- On a pop the pot pays **50% to the round winner, 40% pro-rata to every
  entry in the round** (the field share — the winner's stake included),
  **10% carries over** as the next cycle's seed.
- The payout is **capped at 8× the round's own pot** (`mega_payout_cap_bps
  80_000`): a pop can never pay more than the rake the round could have
  been charged over 625 rounds, so farming the trigger in low-volume
  rounds is non-positive-EV at every attacker share (invariant I21). The
  UI shows both numbers when the cap binds — a bigger round unlocks a
  bigger jackpot.

## Player profiles & the first bet

`PlayerEscrow` is the player profile (one per wallet, created on the
first-ever bet through whichever path the player arrives by). A first bet
costs `stake + 0.01 SOL account fee (seeds the Mega-Pot, one-time,
non-refundable) + ~0.00174 SOL refundable rent` — shown as three separate
lines before the wallet prompt. Direct depositors' entries stay owned by
their wallet (refunds land there); auto-play entries are owned by the
escrow (refunds land in its spendable balance and auto-reinvest if
enabled).

## Refunds, claims and cleanup — all permissionless

- `claim_winnings` pays the 9% slice + the winner's Mega share to
  `entry.player` — anyone can submit the winning entry.
- `close_entry` delivers each entry's 89% refund (+ field share on a pop)
  plus its reclaimed rent — the keeper batches ~11 per transaction, and a
  player can run it themselves at any time. **A refund is principal: no
  deadline, no sweep path, ever** (a lapsed *prize* sweeps to the pot;
  refunds never do).
- `close_round` sweeps the two pro-rata pools' rounding dust (bounded by
  I22: ≤ 2 lamports per entry) to the Mega-Pot — never the treasury.

## Economics immutability

The bps fields, the trigger modulus and the payout cap are structurally
absent from `update_config` (ADR-10); they moved once, ever, through the
one-way `migrate_economics_v2` latch (ADR-11) which requires a drained
Mega-Pot and no round in flight. Account-open fee is the single
economics-adjacent admin knob, bounded on-chain at 0.05 SOL.

## Where the code lives

`programs/orbit_jackpot` (Anchor 0.32) · `packages/sdk` (decoders,
builders, the BigInt economics mirror) · `apps/crank` (autonomous keeper)
· `apps/web` (playorb.fun UI) · `docs/runbooks/economics-migration.md`
(the cutover record). Money is `u64`/`u128`/`bigint` end to end — no
floats, on either side of the boundary.
