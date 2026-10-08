//! Instruction handlers (roadmap §5) — one file per instruction family.
//!
//! `lib.rs`'s `#[program]` module holds thin entrypoints only; all logic
//! lives here as `process` functions over fully-constrained contexts.

pub mod accept_admin;
pub mod admin_sweep_fees;
pub mod admin_toggle_pause;
pub mod cancel_round;
pub mod claim_winnings;
pub mod close_entry;
pub mod close_round;
pub mod commit_randomness;
pub mod crank_auto_deposit;
pub mod close_randomness;
pub mod create_randomness;
pub mod deposit;
pub mod drain_mega_pot_v1_preflight;
pub mod fulfill_settle;
pub mod init_or_deposit_escrow;
pub mod initialize;
pub mod lock_round;
pub mod migrate_economics;
pub mod migrate_economics_v3;
pub mod open_round;
pub mod request_entropy;
pub mod request_randomness;
pub mod reveal_entropy;
pub mod reveal_randomness;
pub mod set_entropy_chain;
pub mod sweep_unclaimed_prize;
pub mod transfer_admin;
pub mod update_config;
pub mod withdraw_escrow;

pub use accept_admin::AcceptAdmin;
pub use admin_sweep_fees::AdminSweepFees;
pub use admin_toggle_pause::TogglePause;
pub use cancel_round::{CancelRound, RefundEntry};
pub use claim_winnings::ClaimWinnings;
pub use close_entry::CloseEntry;
pub use close_round::CloseRound;
pub use commit_randomness::CommitRandomness;
pub use crank_auto_deposit::CrankAutoDeposit;
pub use close_randomness::CloseRandomness;
pub use create_randomness::CreateRandomness;
pub use deposit::Deposit;
pub use drain_mega_pot_v1_preflight::DrainMegaPotV1Preflight;
pub use fulfill_settle::FulfillSettle;
pub use init_or_deposit_escrow::InitOrDepositEscrow;
pub use initialize::{Initialize, InitializeArgs};
pub use lock_round::LockRound;
pub use migrate_economics::{MigrateEconomicsV2, MigrateEconomicsV2Args};
pub use migrate_economics_v3::MigrateEconomicsV3;
pub use open_round::OpenRound;
pub use request_entropy::RequestEntropy;
pub use request_randomness::RequestRandomness;
pub use reveal_entropy::RevealEntropy;
pub use reveal_randomness::{RevealRandomness, RevealRandomnessArgs};
pub use set_entropy_chain::SetEntropyChain;
pub use sweep_unclaimed_prize::SweepUnclaimedPrize;
pub use transfer_admin::TransferAdmin;
pub use update_config::{UpdateConfig, UpdateConfigArgs};
pub use withdraw_escrow::WithdrawEscrow;
