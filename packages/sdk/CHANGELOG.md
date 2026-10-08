# @orbit-jackpot/sdk — changelog

## 0.3.0 (2026-10-07) — Phase 11 partial-loss economics

**Breaking changes** (account lists; txs built by 0.2.x will fail against
the upgraded program):

- `buildDepositTx` now carries the `PlayerEscrow` profile escrow
  (`init_if_needed`) and the `MegaPotVault` — a first-ever bet creates the
  player's profile and pays the one-time account-open fee (decision D1).
- `buildCloseEntryTx` adds `roundVault` + `rent`: close now PAYS the
  entry's pro-rata refund (+ Mega field share on a trigger) alongside the
  reclaimed rent.
- `buildCloseRoundTx` adds `megaPot` + `rent`: the I22-bounded rounding
  dust sweeps to the Mega-Pot at teardown.
- `buildInitOrDepositEscrowTx` adds `megaPot` (the fee sink).
- `RoundSettled`/`MegaPotTriggered` events extended (`refundPool`,
  `megaFieldPool`, `fieldPool`) — indexers must re-map.

Additions:

- `buildMigrateEconomicsV2Tx` — the ADR-11 one-way economics latch.
- `buildCloseEntryBatchTx` + `CLOSE_ENTRY_MAX_PER_TX = 11` — the keeper's
  batched refund delivery (throws beyond the packet width, never
  truncates).
- `math/economics.ts` — the BigInt mirror of `split_round_pot`,
  `split_mega_pot`, `entryShare`, parity-pinned to `entropy_kat.json`.
- `GlobalConfigData`/`RoundData` decode the nine Phase 11 fields; both
  layouts remain 340/302 bytes (zero migration, asserted in tests).
- Event decoders + subscriptions for `EntryRefundPaid`, `RoundDustSwept`,
  `AccountOpened`, `EconomicsMigrated`.
- `InitializeArgsData.accountOpenFeeLamports?` (optional, defaults 0n).

## 0.2.0 (2026-10-06)

Dual-transport CPI event feed; Phase 10 auto-deposit builders and escrow
decoders; `fetchEntries` GPA-with-fallback.

## 0.1.0 (2026-10-05)

Initial public surface: PDAs, offset-pinned account decoders, wheel math,
transaction builders, layout/event fixtures (ADR-9).
