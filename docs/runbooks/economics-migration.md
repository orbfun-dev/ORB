# Economics Migration Runbook — v1 → v2 soft-jackpot (ADR-11)

The one-way `migrate_economics_v2` latch retunes the deployed program from
the launch 98/1/1 winner-take-all split to the Phase 11 soft-jackpot
economics (9% winner / 89% refunds / 1% admin / 1% Mega-Pot; pops split
50/40/10 capped at 8× the round pot). This is the exact cutover order —
each step exists because skipping it strands either player money or the
migration itself.

**This can run exactly once, ever.** After the latch closes
(`economics_version == 2`) there is no path back — a revert would be a
`migrate_economics_v3`. Verify every step before `--confirm`.

## 0. Preconditions (the script enforces all of these — it refuses, loudly)

1. **The upgraded program is deployed** (`anchor upgrade`; the account
   layouts are zero-migration — `GlobalConfig` 340, `Round` 302 — so the
   upgrade itself changes no behavior for in-flight rounds).
2. **No round in flight**: `active_round_id == next_round_id` (every round
   terminal and closed). Stop the keeper, drive the last round to
   terminal + closed (an empty round auto-cancels at lock), and confirm
   with the scripts' state dumps.
3. **The Mega-Pot is drained**: `mega_pot.accrued_lamports == 0`. Retuning
   odds while the pot holds lamports contributed under the old odds is the
   exact rug ADR-10 was built to prevent — there is **no override**, by
   design.

   Under the v1 config the pot **cannot reach 0 by itself**: a pop pays
   90% and retains ≥ 10% + the settling round's own 1% cut (and the odds
   are frozen at 1-in-6 767 by ADR-10). The honest resolution is the
   one-shot admin preflight, which pays the whole pot to the **treasury**
   (where it stays behind the separate `treasury_authority` gate) and
   refuses forever once `economics_version >= 2`:

   ```bash
   npm run devnet:drain-mega-pot             # prints state, all guards
   npm run devnet:drain-mega-pot -- --confirm
   ```

4. **The admin signer is the config admin** (`vaulted-admin`).

## 1. Dry run (prints current + proposed + the I14/I21 arithmetic)

```bash
npm run devnet:migrate-economics
```

Output shows both configs, the worked examples (a 10 SOL pot's four-way
split; a 50 SOL pop's 50/40/10), and the guard arithmetic:
`I14: 900 + 8900 + 100 + 100 = 10_000` and
`I21: cap 80_000 ≤ 625 × 200 = 125_000`. Any violation aborts before
signing.

## 2. Send it

```bash
npm run devnet:migrate-economics -- --confirm   # pass the flag through npm
# or: npx tsx scripts/devnet/migrate-economics-v2.ts --confirm
```

## 3. Verify the latch

The script re-reads and asserts; independently confirm:

- `economics_version == 2`, `winner_bps 900`, `refund_bps 8_900`,
  `mega_award_bps 5_000`, `mega_field_bps 4_000`, modulus `625`, cap
  `80_000`, `account_open_fee_lamports 10_000_000`.
- The `EconomicsMigrated` event carries every before/after value
  (explorer → the migration tx logs).
- A second run refuses with `EconomicsAlreadyMigrated` (run the dry run
  again — expect the refusal).

## 4. Open the first v2 round and verify the settlement

Let the keeper open + settle one round (or drive it with the devnet
scripts), then check the settle against the canonical Phase 11.5 numbers —
for a 10-entry × 1 SOL round:

| Quantity | Expected |
|---|---|
| `winner_payout` | 0.9 SOL |
| `refund_pool` | 8.9 SOL |
| `admin_cut` = `mega_cut` | 0.1 SOL each |
| each `close_entry` | pays 0.89 SOL + entry rent |
| winner net (claim + close) | 1.79 SOL |
| vault at close_round | exactly its rent minimum, dust 0 |

On-chain parity is already proven by the integration battery
(`canonical_ten_entry_round_v2`); this step proves the DEPLOYED program,
not the build.

## 5. After the cutover

- The keeper needs no restart (see `crank-ops.md` §11 for its new batched
  refund cleanup and the `stuckCleanupRounds` alert).
- The web app reads the config fields directly — odds, split and cap
  display update on the next poll; the deposit panel starts showing the
  first-bet cost breakdown (0.01 SOL fee + ~0.00174 SOL profile rent).
- Indexers: `winner_payout` changed meaning (9% slice, was the 98%
  residual) and `RoundSettled` grew `refund_pool`/`mega_field_pool` —
  SDK CHANGELOG 0.3.0 lists the full breaking set.
