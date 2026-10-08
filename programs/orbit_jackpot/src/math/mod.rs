//! Pure integer math: pot splits (and, in later Phase 1 tasks, ticket ranges
//! and the Mega-Pot trigger).
//!
//! This module — like `entropy.rs` — must stay free of every runtime and
//! framework import, which is what makes the whole phase verifiable with
//! plain `cargo test -p orbit_jackpot --lib`: no validator, no build step,
//! no deploy.
#![forbid(unsafe_code)]

pub mod mega;
pub mod split;
pub mod tickets;

pub use mega::{mega_triggered, split_mega_pot, MegaSplit};
pub use split::{entry_share, split_round_pot, split_round_pot_v3, PotSplit};
pub use tickets::{next_range, range_contains, ticket_from_entropy, TicketRange};
