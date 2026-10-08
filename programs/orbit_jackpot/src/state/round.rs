//! `Round` — the round PDA at ["round", round_id_le]: its state machine, its
//! escrow accounting (`vault_owed`), and the randomness pin. Data only; the
//! escrowed lamports live in the sibling `RoundVault` PDA (ADR-8).

use crate::errors::OrbitError;
use anchor_lang::prelude::*;

/// Round lifecycle. One-way (invariant I12); `Settled` and `Cancelled` are
/// absorbing terminal states. Note the roadmap's five states — the extra
/// `AwaitingRandomness` between `Locked` and `Settled` is what makes ADR-4's
/// pin/freshness/timeout guarantees expressible at all.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RoundState {
    /// Accepting deposits.
    Open,
    /// Deposit window closed; randomness not yet requested.
    Locked,
    /// Randomness pinned (ADR-4); awaiting reveal and settlement.
    AwaitingRandomness,
    /// Winning ticket resolved; claims and cleanup in progress.
    Settled,
    /// Terminal refund state (zero/sole depositor, or oracle timeout).
    Cancelled,
}

impl RoundState {
    /// The I12 transition guard: exactly the five legal edges of the machine
    /// —
    /// `Open → Locked`, `Open → Cancelled` (zero-deposit or sole-depositor
    /// rounds cancel directly at lock time),
    /// `Locked → AwaitingRandomness`, `AwaitingRandomness → Settled`, and
    /// `AwaitingRandomness → Cancelled` (oracle timeout).
    ///
    /// Self-loops are deliberately absent: instructions that do not change
    /// the state (e.g. `deposit`, `Open → Open`) simply never call this.
    ///
    /// Returns the typed error so tests can match variants directly; Phase 3
    /// handlers compose it with `?` via the generated
    /// `From<OrbitError> for anchor_lang::error::Error`.
    pub fn try_transition(from: RoundState, to: RoundState) -> std::result::Result<(), OrbitError> {
        let legal = matches!(
            (from, to),
            (RoundState::Open, RoundState::Locked)
                | (RoundState::Open, RoundState::Cancelled)
                | (RoundState::Locked, RoundState::AwaitingRandomness)
                | (RoundState::AwaitingRandomness, RoundState::Settled)
                | (RoundState::AwaitingRandomness, RoundState::Cancelled)
        );
        if !legal {
            return Err(OrbitError::IllegalStateTransition);
        }
        Ok(())
    }
}

/// One round of the pari-mutuel pool at ["round", round_id.to_le_bytes()].
///
/// `total_lamports` doubles as the exclusive upper bound of the ticket space;
/// the half-open ranges of the round's entries partition `[0, total)` (I9).
#[account]
#[derive(InitSpace)]
pub struct Round {
    pub round_id: u64,
    pub state: RoundState,
    pub start_ts: i64,
    /// Mutated by anti-snipe extension only.
    pub end_ts: i64,
    pub lock_ts: i64,
    /// Security ordering lives here (slots), not in `lock_ts` (timestamps).
    pub lock_slot: u64,
    /// Start of the claim deadline clock.
    pub settle_ts: i64,
    /// Also the exclusive upper bound of the ticket space.
    pub total_lamports: u64,
    /// Next `entry_index`.
    pub entry_count: u32,
    /// Cleanup progress; the round closes only at `entries_closed == entry_count`.
    pub entries_closed: u32,
    pub first_depositor: Pubkey,
    /// `true` until a *different* player deposits — O(1) sole-depositor detection.
    pub single_depositor: bool,
    /// Pinned once by `request_randomness` (ADR-4, no re-rolls).
    pub randomness_account: Pubkey,
    /// Timeout clock for `cancel_round`.
    pub randomness_commit_slot: u64,
    /// Recorded at settle for public audit.
    pub randomness_seed_slot: u64,
    /// `< total_lamports` whenever `Settled` (I10).
    pub winning_ticket: u64,
    /// Zero until claimed (ADR-2): settle records a ticket, claiming proves
    /// membership. Indexers read `winning_ticket`, not `winner`.
    pub winner: Pubkey,
    pub winner_payout: u64,
    pub admin_cut: u64,
    pub mega_cut: u64,
    /// Mega-Pot award snapshotted at settle time (ADR-8).
    pub mega_awarded: u64,
    /// ADR-6: lamports this round's vault still owes someone. The single
    /// balance invariant — `vault.lamports() == rent_minimum + vault_owed`
    /// holds after every instruction in every state.
    pub vault_owed: u64,
    pub mega_triggered: bool,
    pub prize_claimed: bool,
    pub vault_bump: u8,
    pub bump: u8,
    /// Settle-time obligation to the field: the pot's refund slice, taken
    /// as the exact residual of `total_lamports` so I18 holds to the
    /// lamport. Drawn down pro-rata by `close_entry`.
    pub refund_pool: u64,
    /// Running total actually paid out of `refund_pool` (I20).
    pub refunds_paid: u64,
    /// Mega-Pot field share snapshotted into the vault at settle (ADR-8);
    /// `0` when the trigger did not fire.
    pub mega_field_pool: u64,
    /// Running total actually paid out of `mega_field_pool` (I20).
    pub mega_field_paid: u64,
    /// Who funded this round's two rent-exemptions at `open_round`. The
    /// deterministic reclaim destination at `close_round`, so the crank
    /// recovers its own capital instead of donating it to the admin.
    /// `Pubkey::default()` on rounds opened before Phase 12 — those fall
    /// back to `config.admin`, which is exactly the old behaviour.
    ///
    /// Carved out of the former forward-compat padding in place (Phase 11
    /// had already taken the 32 bytes before it for the refund/mega-field
    /// pools): same offset, same width — `Pubkey` is exactly `[u8; 32]`,
    /// so every pre-existing field keeps its byte offset, the total stays
    /// 302, and the rounds already live on devnet decode the all-zero tail
    /// as the legacy sentinel.
    pub rent_payer: Pubkey,
}

impl Round {
    /// R3: a round may roll its window in place exactly when it is Open
    /// and holds no player money. Pure so the matrix is unit-testable.
    ///
    /// `total_lamports == 0` is the precise statement that nobody has money
    /// at risk, which is what makes re-timing harmless: no pot to re-price,
    /// no ticket partition to disturb, nobody waiting on a result. Any
    /// other round locks exactly as it always did.
    pub fn may_roll_window(state: RoundState, total_lamports: u64) -> bool {
        matches!(state, RoundState::Open) && total_lamports == 0
    }

    /// R2: both timestamps move. Returns `(start_ts, end_ts)` — the new
    /// window is `[now, now + duration_secs]`.
    ///
    /// Resetting `start_ts` (not just `end_ts`) is load-bearing: a round
    /// that kept its original `start_ts` would silently kill
    /// `crank_auto_deposit` for every escrow player forever (the window
    /// gate is `now <= start_ts + auto_deposit_window_secs`), and the
    /// anti-snipe absolute cap (`start_ts + max_round_duration_secs`)
    /// would be pre-exceeded. Rolling both keeps every start-relative
    /// guarantee sane.
    pub fn rolled_window(
        now: i64,
        duration_secs: i64,
    ) -> std::result::Result<(i64, i64), OrbitError> {
        let end = now
            .checked_add(duration_secs)
            .ok_or(OrbitError::ArithmeticOverflow)?;
        Ok((now, end))
    }

    /// The one legal destination for this round's reclaimed rent
    /// (`close_round`). A **value** fallback on the legacy sentinel, not an
    /// `economics_version` branch: rounds opened before Phase 12 carry
    /// `rent_payer == Pubkey::default()` and route to `config.admin` —
    /// exactly the pre-Phase-12 behaviour — while Phase-12 rounds route to
    /// whoever actually paid the rent at `open_round`.
    pub fn rent_reclaim_destination(&self, admin: Pubkey) -> Pubkey {
        if self.rent_payer == Pubkey::default() {
            admin
        } else {
            self.rent_payer
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Size lock (§3): 302 bytes including the 8-byte discriminator.
    #[test]
    fn size_is_exactly_302() {
        assert_eq!(8 + Round::INIT_SPACE, 302);
    }

    /// The enum itself serializes to a single byte (§3). The trait is `Space`
    /// (`InitSpace` is only the derive macro; the prelude exports both).
    #[test]
    fn round_state_occupies_one_byte() {
        assert_eq!(<RoundState as Space>::INIT_SPACE, 1);
    }

    /// Task 2.3 — the full 5×5 transition matrix: exactly the five legal
    /// edges pass, everything else — including every self-loop and every edge
    /// out of the absorbing states — is rejected as `IllegalStateTransition`.
    #[test]
    fn transition_matrix_is_exactly_the_legal_edges() {
        let states = [
            RoundState::Open,
            RoundState::Locked,
            RoundState::AwaitingRandomness,
            RoundState::Settled,
            RoundState::Cancelled,
        ];
        let legal = [
            (RoundState::Open, RoundState::Locked),
            (RoundState::Open, RoundState::Cancelled),
            (RoundState::Locked, RoundState::AwaitingRandomness),
            (RoundState::AwaitingRandomness, RoundState::Settled),
            (RoundState::AwaitingRandomness, RoundState::Cancelled),
        ];
        for &from in &states {
            for &to in &states {
                let result = RoundState::try_transition(from, to);
                if legal.contains(&(from, to)) {
                    assert!(result.is_ok(), "{from:?} -> {to:?} must be legal");
                } else {
                    assert!(
                        matches!(result, Err(OrbitError::IllegalStateTransition)),
                        "{from:?} -> {to:?} must be rejected"
                    );
                }
            }
        }
    }

    /// Phase 12.0 (R3): `may_roll_window` is true for exactly `(Open, 0)`
    /// across the full 5-state × {0, 1, u64::MAX} matrix. Every other cell
    /// — a non-empty Open round, any terminal or in-flight state — must
    /// refuse the roll.
    #[test]
    fn may_roll_window_is_exactly_open_and_empty() {
        let states = [
            RoundState::Open,
            RoundState::Locked,
            RoundState::AwaitingRandomness,
            RoundState::Settled,
            RoundState::Cancelled,
        ];
        for &state in &states {
            for &total in &[0u64, 1u64, u64::MAX] {
                let expected = matches!(state, RoundState::Open) && total == 0;
                assert_eq!(
                    Round::may_roll_window(state, total),
                    expected,
                    "({state:?}, {total}) must {} the roll",
                    if expected { "allow" } else { "refuse" }
                );
            }
        }
    }

    /// Phase 12.0 (R2): both timestamps move — the new window starts at
    /// `now` and ends at `now + duration`.
    #[test]
    fn rolled_window_moves_both_timestamps() {
        assert_eq!(Round::rolled_window(1_000, 120).unwrap(), (1_000, 1_120));
        assert_eq!(Round::rolled_window(-5, 10).unwrap(), (-5, 5));
        assert_eq!(
            Round::rolled_window(1_700_000_000, 0).unwrap(),
            (1_700_000_000, 1_700_000_000)
        );
    }

    /// Phase 12.0: a window that would push `end_ts` past `i64::MAX`
    /// overflows loudly instead of wrapping — same discipline as every
    /// other timestamp arithmetic in the program.
    #[test]
    fn rolled_window_overflows_loudly() {
        assert!(matches!(
            Round::rolled_window(i64::MAX, 1),
            Err(OrbitError::ArithmeticOverflow)
        ));
        assert!(matches!(
            Round::rolled_window(i64::MAX - 5, 10),
            Err(OrbitError::ArithmeticOverflow)
        ));
    }

    /// Minimal round for the resolver tests — only `rent_payer` matters;
    /// every other field is zero and irrelevant to the method under test.
    fn rent_fixture(rent_payer: Pubkey) -> Round {
        Round {
            round_id: 7,
            state: RoundState::Open,
            start_ts: 1_000,
            end_ts: 1_120,
            lock_ts: 0,
            lock_slot: 0,
            settle_ts: 0,
            total_lamports: 0,
            entry_count: 0,
            entries_closed: 0,
            first_depositor: Pubkey::default(),
            single_depositor: false,
            randomness_account: Pubkey::default(),
            randomness_commit_slot: 0,
            randomness_seed_slot: 0,
            winning_ticket: 0,
            winner: Pubkey::default(),
            winner_payout: 0,
            admin_cut: 0,
            mega_cut: 0,
            mega_awarded: 0,
            vault_owed: 0,
            mega_triggered: false,
            prize_claimed: false,
            vault_bump: 253,
            bump: 255,
            refund_pool: 0,
            refunds_paid: 0,
            mega_field_pool: 0,
            mega_field_paid: 0,
            rent_payer,
        }
    }

    /// Phase 12.1 (R5): a Phase-12 round's rent returns to whoever paid it.
    #[test]
    fn rent_reclaim_destination_is_the_payer_when_recorded() {
        let keeper = Pubkey::new_from_array([0x5A; 32]);
        let admin = Pubkey::new_from_array([0x11; 32]);
        assert_eq!(rent_fixture(keeper).rent_reclaim_destination(admin), keeper);
    }

    /// Phase 12.1 (R5): the legacy sentinel — `rent_payer == default()` on
    /// every round opened before Phase 12 — falls back to `config.admin`,
    /// which is exactly the pre-Phase-12 `close_round` behaviour. Also pins
    /// that the fallback is a value comparison, not a key-identity accident:
    /// a round whose payer genuinely IS the admin reclaims to the admin
    /// either way.
    #[test]
    fn rent_reclaim_destination_falls_back_to_admin_on_the_legacy_sentinel() {
        let admin = Pubkey::new_from_array([0x11; 32]);
        assert_eq!(
            rent_fixture(Pubkey::default()).rent_reclaim_destination(admin),
            admin
        );
        assert_eq!(rent_fixture(admin).rent_reclaim_destination(admin), admin);
    }
}
