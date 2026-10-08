//! Account state: the seven PDAs from the roadmap §3 seed/size table.
//!
//! Layouts are frozen by the size-lock tests — every field addition, reorder
//! or type change is an immediate, named failure instead of a confusing
//! deploy-time serialization error. No instruction logic lives here (that
//! boundary is what lets Phase 3 be reviewed as pure wiring).

pub mod entropy_chain;
pub mod global_config;
pub mod player_entry;
pub mod player_escrow;
pub mod round;
pub mod vaults;

pub use entropy_chain::{EntropyChain, ENTROPY_NONE};
pub use global_config::{GlobalConfig, OracleProvider};
pub use player_entry::PlayerEntry;
pub use player_escrow::PlayerEscrow;
pub use round::{Round, RoundState};
pub use vaults::{MegaPotVault, RoundVault, TreasuryVault};
