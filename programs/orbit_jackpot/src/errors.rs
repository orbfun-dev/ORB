//! Error surface of the pure-math layer (`math/`, `entropy.rs`).
//!
//! Deliberately framework-free: these variants are mapped one-to-one onto the
//! program error enum in Phase 2, and the math modules must compile and test
//! with no runtime dependencies whatsoever.

use core::fmt;

/// Failures raised by pure integer math (pot splits, ticket ranges, entropy
/// reduction).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    /// A modulo or share was requested against a zero total.
    ZeroTotal,
    /// A ticket range was requested for a zero-lamport deposit.
    ZeroAmount,
    /// A modulo was requested with a zero modulus.
    ZeroModulus,
    /// Basis-point inputs sum to more than [`crate::constants::BPS_DENOMINATOR`].
    BpsOverflow,
    /// A checked arithmetic step does not fit its integer type.
    Overflow,
}

impl fmt::Display for MathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let msg = match self {
            MathError::ZeroTotal => "total must be greater than zero",
            MathError::ZeroAmount => "amount must be greater than zero",
            MathError::ZeroModulus => "modulus must be greater than zero",
            MathError::BpsOverflow => "basis points exceed the 10_000 denominator",
            MathError::Overflow => "checked arithmetic overflowed",
        };
        write!(f, "{msg}")
    }
}

impl std::error::Error for MathError {}

// ──────────────────────────────────────────────────────────────────────────
// Program-level error catalog (roadmap task 2.4)
// ──────────────────────────────────────────────────────────────────────────

use anchor_lang::prelude::*;

/// One variant per rejectable condition in the instruction catalog (§5),
/// plus the invariant-violation receivers (I1–I7) and the targets of the
/// `MathError` mapping. Every variant carries a non-empty `#[msg]`.
#[error_code]
pub enum OrbitError {
    // ── authority & configuration ──
    #[msg("this instruction requires the admin authority")]
    UnauthorizedAdmin,
    #[msg("this instruction requires the pending admin authority")]
    UnauthorizedPendingAdmin,
    #[msg("this instruction requires the treasury authority")]
    UnauthorizedTreasuryAuthority,
    #[msg("the program is paused for this instruction")]
    Paused,
    #[msg("global configuration is already initialized")]
    AlreadyInitialized,
    #[msg("the requested configuration field is immutable after initialize")]
    ImmutableField,
    #[msg("fee basis points must sum to exactly 10_000 (invariant I14)")]
    InvalidFeeSplit,
    #[msg("mega trigger modulus must be at least 1")]
    ZeroModulusConfig,
    #[msg("randomness reveal deadline must be below the 512-slot retention bound")]
    InvalidRevealDeadline,
    #[msg("round durations are inconsistent with their configured ceiling")]
    InvalidDurationConfig,
    #[msg("the oracle queue key must be a real account, never the default pubkey")]
    InvalidOracleQueue,
    #[msg("the mock oracle provider is forbidden in this build")]
    MockOracleForbidden,

    // ── round lifecycle & deposits ──
    #[msg("a round is already open; at most one round may be Open at a time")]
    RoundAlreadyOpen,
    #[msg("the presented previous round does not match the active round id")]
    PreviousRoundMismatch,
    #[msg("the round is not in the Open state")]
    RoundNotOpen,
    #[msg("the deposit window has closed")]
    DepositWindowClosed,
    #[msg("deposit is below the configured minimum")]
    DepositBelowMinimum,
    #[msg("deposit amount must be greater than zero")]
    ZeroDepositAmount,
    #[msg("the round has reached its configured maximum entry count")]
    MaxEntriesReached,
    #[msg("the lock window has not yet elapsed")]
    LockWindowNotElapsed,
    #[msg("the round is not in the Locked state")]
    RoundNotLocked,
    #[msg("the round is not in the AwaitingRandomness state")]
    RoundNotAwaitingRandomness,
    #[msg("the round is not in the Settled state")]
    RoundNotSettled,
    #[msg("the round is not in the Cancelled state")]
    RoundNotCancelled,
    #[msg("the requested state transition is illegal (invariant I12)")]
    IllegalStateTransition,

    // ── randomness (ADR-4) ──
    #[msg("the randomness account is owned by the wrong program")]
    RandomnessOwnerMismatch,
    #[msg("the randomness account authority is not the round PDA")]
    RandomnessAuthorityMismatch,
    #[msg("randomness has already been pinned for this round; no re-rolls")]
    RandomnessAlreadyPinned,
    #[msg("the randomness account key does not match the pinned account")]
    RandomnessAccountMismatch,
    #[msg("the randomness account data failed to parse as a committed account")]
    RandomnessMalformed,
    #[msg("the randomness commit predates the lock; no depositing against a known outcome")]
    StaleRandomness,
    #[msg("the randomness value has not been revealed yet")]
    RandomnessNotRevealed,
    #[msg("the randomness account has already been committed; commits are exactly-once")]
    RandomnessAlreadyCommitted,
    #[msg("the randomness account has already been revealed")]
    RandomnessAlreadyRevealed,
    #[msg("the randomness account has not been committed yet")]
    RandomnessNotCommitted,
    #[msg("the presented oracle is not the one the commit assigned")]
    RandomnessOracleMismatch,
    #[msg("the stats account is not the oracle program's stats PDA for this oracle")]
    RandomnessStatsMismatch,
    #[msg("the value written by the reveal does not match the presented value")]
    RandomnessRevealMismatch,
    #[msg("the switchboard randomness_init invocation failed")]
    RandomnessCreateFailed,
    #[msg("the switchboard randomness_reveal invocation failed")]
    RandomnessRevealFailed,
    #[msg("the queue account key does not match the configured oracle queue")]
    RandomnessQueueMismatch,
    #[msg("the invoked switchboard program id does not match the configured oracle program")]
    RandomnessProgramMismatch,
    #[msg("the switchboard randomness_commit invocation failed")]
    RandomnessCommitFailed,
    #[msg("the randomness reveal deadline has not yet elapsed")]
    RevealDeadlineNotElapsed,

    // ── claims & cleanup ──
    #[msg("the prize has already been claimed")]
    PrizeAlreadyClaimed,
    #[msg("the entry belongs to a different round")]
    EntryRoundMismatch,
    #[msg("the entry's ticket range does not contain the winning ticket")]
    EntryNotWinning,
    #[msg("the entry has already been refunded or closed")]
    EntryAlreadyClosed,
    #[msg("the payout or refund destination must be the entry's player")]
    RefundDestinationMismatch,
    #[msg("the winning entry cannot close before its prize is claimed")]
    WinningEntryNotClaimed,
    #[msg("the claim deadline has not yet elapsed")]
    ClaimDeadlineNotElapsed,
    #[msg("nothing to sweep: accrued lamports are zero")]
    NothingToSweep,
    #[msg("the round vault is not fully drained")]
    VaultNotDrained,
    #[msg("not all entries have been closed yet")]
    EntriesNotClosed,

    // ── math mapping & invariant receivers ──
    #[msg("total lamports must be greater than zero to resolve a ticket")]
    InvalidTicketTotal,
    #[msg("checked arithmetic overflowed")]
    ArithmeticOverflow,
    #[msg("round vault balance violates invariant I1")]
    RoundVaultInvariant,
    #[msg("treasury balances violate invariant I2 or I5")]
    TreasuryInvariant,
    #[msg("mega-pot balances violate invariant I3 or I4")]
    MegaPotInvariant,
    #[msg("the pot split violates invariant I6")]
    SplitInvariant,
    #[msg("the mega-pot split violates invariant I7")]
    MegaSplitInvariant,
    #[msg("the action would push a vault below its rent-exempt minimum")]
    VaultBelowRentExempt,

    // ── auto-deposit escrow (Phase 10) ──
    #[msg("the auto-deposit feature is disabled in the global config")]
    AutoDepositDisabled,
    #[msg("the auto-deposit window has closed for permissionless callers; only the escrow owner may act")]
    AutoDepositWindowClosed,
    #[msg("this escrow has already auto-deposited into this round or a newer one")]
    AutoDepositAlreadyThisRound,
    #[msg("the escrow's budget of rounds is exhausted")]
    EscrowBudgetExhausted,
    #[msg("the escrow's spendable balance cannot cover stake plus entry rent plus tip")]
    EscrowInsufficientBalance,
    #[msg("the escrow belongs to a different owner")]
    EscrowOwnerMismatch,
    #[msg("escrow terms are invalid: max_rounds must be positive and per_round at or above the minimum deposit")]
    InvalidEscrowTerms,
    #[msg("withdrawal amount must be greater than zero")]
    NothingToWithdraw,
    #[msg("the auto-deposit window must be positive and shorter than the round duration")]
    InvalidAutoDepositWindow,
    #[msg("the auto-deposit tip exceeds the compile-time ceiling")]
    AutoDepositTipTooHigh,
    #[msg("escrow balance violates invariant I16 (rent exemption)")]
    EscrowInvariant,
    #[msg("the presented round does not match the instruction's round_id argument")]
    RoundIdMismatch,

    // ── Phase 11 partial-loss economics ──
    #[msg("economics_version is already at 2; the migration is a one-way latch")]
    EconomicsAlreadyMigrated,
    #[msg("the Mega-Pot must be drained before economics can migrate")]
    MegaPotNotDrained,
    #[msg("a round is still in flight; economics can only migrate between rounds")]
    RoundInFlight,
    #[msg("the proposed mega payout cap violates the I21 farming guard")]
    MegaFarmGuardViolated,
    #[msg("refunds_paid would exceed refund_pool (invariant I20)")]
    RefundPoolExhausted,
    #[msg("mega_field_paid would exceed mega_field_pool (invariant I20)")]
    MegaFieldPoolExhausted,
    #[msg("residual vault_owed exceeds the rounding-dust bound (invariant I22)")]
    RoundDustOutOfBounds,
    #[msg("the account-open fee exceeds the compile-time ceiling")]
    AccountOpenFeeTooHigh,
    #[msg("the Mega-Pot holds nothing to drain (accrued_lamports is already 0)")]
    MegaPotAlreadyDrained,
    // ── economics v3 (appended — never insert above) ──
    #[msg("economics v3 settlement needs the winning entry as the first remaining account")]
    WinningEntryRequired,
    #[msg("the supplied entry is not this round's winning entry")]
    WinningEntryMismatch,
    #[msg("economics can only advance to v3 from v2")]
    EconomicsVersionMismatch,
    // ── AUDIT P-3 (appended — never insert above) ──
    #[msg("config value below its safety minimum")]
    ConfigBelowMinimum,
    #[msg("the oracle queue can only change while the protocol is paused")]
    OracleQueueChangeRequiresPause,
    #[msg("close_randomness must reclaim the round's Switchboard accounts before close_round")]
    RandomnessNotClosed,
    // ── randomness fallback: entropy provider (appended — never insert above) ──
    #[msg("this instruction does not match the configured randomness provider")]
    OracleProviderMismatch,
    #[msg("the entropy chain already has a round in flight or an unsettled value")]
    EntropyChainBusy,
    #[msg("the entropy chain has no seeds left; the admin must set a new chain")]
    EntropyChainExhausted,
    #[msg("the entropy commit must be non-zero and the chain length positive")]
    InvalidEntropyCommit,
    #[msg("this round is not the entropy chain's pending round")]
    EntropyNotPending,
    #[msg("sha256(seed) does not match the entropy chain commit")]
    EntropySeedMismatch,
    #[msg("the entropy target slot has no hash yet")]
    EntropyTargetNotReached,
    #[msg("the entropy target slot left SlotHashes; the round can only cancel at its deadline")]
    EntropyTargetExpired,
}

impl From<MathError> for OrbitError {
    fn from(err: MathError) -> Self {
        match err {
            MathError::ZeroTotal => OrbitError::InvalidTicketTotal,
            MathError::ZeroAmount => OrbitError::ZeroDepositAmount,
            MathError::ZeroModulus => OrbitError::ZeroModulusConfig,
            MathError::BpsOverflow => OrbitError::InvalidFeeSplit,
            MathError::Overflow => OrbitError::ArithmeticOverflow,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Phase 2 requires a non-empty message on every program error variant;
    /// hold the math layer to the same bar now.
    #[test]
    fn every_variant_renders_a_non_empty_message() {
        let all = [
            MathError::ZeroTotal,
            MathError::ZeroAmount,
            MathError::ZeroModulus,
            MathError::BpsOverflow,
            MathError::Overflow,
        ];
        for err in all {
            assert!(!err.to_string().is_empty(), "{err:?} rendered empty");
        }
    }

    /// Task 2.4 — the pure-math errors map one-to-one onto program errors.
    #[test]
    fn math_errors_map_one_to_one() {
        use super::OrbitError;
        assert!(matches!(
            OrbitError::from(MathError::ZeroTotal),
            OrbitError::InvalidTicketTotal
        ));
        assert!(matches!(
            OrbitError::from(MathError::ZeroAmount),
            OrbitError::ZeroDepositAmount
        ));
        assert!(matches!(
            OrbitError::from(MathError::ZeroModulus),
            OrbitError::ZeroModulusConfig
        ));
        assert!(matches!(
            OrbitError::from(MathError::BpsOverflow),
            OrbitError::InvalidFeeSplit
        ));
        assert!(matches!(
            OrbitError::from(MathError::Overflow),
            OrbitError::ArithmeticOverflow
        ));
    }
}
