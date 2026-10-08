# Idle-burn elimination — before/after measurement (Phase 12.7)

The claim Phase 12 makes is measurable to the lamport: **while no round
holds player money, the keeper's balance does not move.** This report
records the measurement protocol and the baseline; the post-deploy row is
filled the day the Phase 12 program ships (it is built, not yet
deployed — see `Anchor.toml`'s deploy comment).

## Baseline (pre-Phase-12, measured on devnet)

Diagnosis of the 2026-10-07 keeper drift (`GKbSgDBNJJfxEucFbzMVwHnt7YuVDFCeyHBNxH3LMwrA`,
the retired 9.6-era keeper): **1.000 → 0.843 SOL with zero player bets**,
tripping `/healthz` degraded. The chain-attributed cause, per the
per-cycle economics:

| per empty 120 s cycle | lamports | share |
|---|---|---|
| `Round` rent-exemption (302 B @ 5 080/byte) | 2 992 800 | 72.5 % |
| `RoundVault` rent-exemption (33 B) | 1 120 560 | 27.1 % |
| base fees, 3 tx × 5 000 | 15 000 | 0.4 % |
| **total** | **4 128 360** | |

At 30 cycles/hour: **0.1239 SOL/hour ≈ 2.97 SOL/day** burned on rounds
nobody played, with both rents landing on `config.admin` — an
unreciprocated keeper → admin transfer of 4 113 360 lamports per round
even on productive ones (the 1 000 000-lamport settled-round tip never
covered it).

## Post-Phase-12 (expected, to be measured after the upgrade ships)

| per empty cycle | lamports |
|---|---|
| window roll (default config: none — the keeper sends nothing) | 0 |
| window roll (`CRANK_IDLE_ROLL_SECS` armed) | 5 000 |
| productive round: rents out at open, back at close | ±0 (round-trip) |

## Measurement protocol (3-hour idle window, run after deploy)

1. Note the active round id and the keeper balance:
   `solana --url devnet balance <KEEPER>`.
2. Leave the daemon alone for 3 hours with nobody betting
   (`/healthz` should read `"status": "ok", "idle": true` throughout).
3. Re-read the balance. **Expected: the delta is exactly 0 lamports**
   (or a small negative equal to `5 000 × N` if `CRANK_IDLE_ROLL_SECS`
   is armed, N = rolls observed in `journalctl`).
4. Record the figures here:

| | keeper balance before | keeper balance after | delta |
|---|---|---|---|
| pre-deploy baseline (directive diagnosis, 2026-10-07) | 1.000 SOL | 0.843 SOL | **−0.157 SOL** |
| post-deploy 3 h idle window (pending) | — | — | — |

A post-deploy idle drift below zero beyond armed-roll gas is a paging
bug: see `docs/runbooks/crank-ops.md` §12.
