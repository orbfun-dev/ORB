//! `commit_randomness` — the commit half of ADR-4's transport (phase 8.1).
//!
//! Switchboard On-Demand's randomness protocol is **commit → reveal**, and
//! the live account flags (probed from the devnet IDL) pin who may do what:
//!
//! - `randomness_init` — authority is NOT a signer: any crank can create
//!   the round's account with `authority = round PDA`.
//! - `randomness_commit` — the AUTHORITY must sign: since the pin bound the
//!   authority to the round PDA, only this program can ever precommit —
//!   this instruction is that CPI, signing with the round PDA seeds. The
//!   commit SEEDS the account (seed_slothash, `seed_slot`, oracle
//!   assignment); it does NOT reveal the value.
//! - `randomness_reveal` — the authority is NOT a signer: any crank
//!   submits the oracle-gateway-signed reveal (which writes `value` and
//!   `reveal_slot`) directly to the oracle program. The value is TEE-signed
//!   by the assigned oracle over the committed slothash, so submission is
//!   permissionless without bias.
//!
//! Exactly-once: the account must be unseeded (`seed_slot == 0`) before the
//! CPI — a committed account refuses a second precommit forever. The
//! post-CPI belt asserts the seeded slot is already settle-fresh
//! (`seed_slot > lock_slot`): a commit that could never satisfy ADR-4's
//! freshness check fails HERE, at commit time, instead of stranding the
//! round past its reveal deadline. The reveal's presence (`reveal_slot`)
//! and the value's freshness belong to `fulfill_settle`, where both are
//! observable.

use crate::constants::{CONFIG_SEED, ROUND_SEED};
use crate::errors::OrbitError;
use crate::events::RandomnessCommitted;
use crate::oracle::switchboard::SwitchboardRandomness;
use crate::oracle::RandomnessSource;
use crate::state::{GlobalConfig, Round, RoundState};
use anchor_lang::prelude::*;
use switchboard_on_demand::on_demand::instructions::randomness_commit::RandomnessCommit;

#[derive(Accounts)]
pub struct CommitRandomness<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,
    /// The exact account pinned by `request_randomness`. Its owner is
    /// constrained to the configured oracle program; key equality against
    /// the pin, the authority binding and the unrevealed precondition are
    /// checked in the handler. The oracle program writes the commit below.
    ///
    /// CHECK: owner constrained above; every semantic property is verified
    /// in the handler against the round's write-once pin.
    #[account(mut, owner = config.oracle_program_id @ OrbitError::RandomnessOwnerMismatch)]
    pub randomness_account: UncheckedAccount<'info>,
    /// The queue pinned in `config.oracle_queue`. Switchboard itself
    /// re-verifies the oracle's queue membership inside the CPI; pinning
    /// the key here removes the crank's freedom to aim commits at a
    /// different queue.
    ///
    /// CHECK: owner constrained above; key equality with the configured
    /// queue is verified in the handler.
    #[account(owner = config.oracle_program_id @ OrbitError::RandomnessOwnerMismatch)]
    pub queue: UncheckedAccount<'info>,
    /// CHECK: the queue oracle performing the commit; membership and
    /// liveness are the Switchboard program's own checks inside the CPI.
    /// Writable because `randomness_commit` bumps the oracle's stats — the
    /// vendored crate's metas carry it as `AccountMeta::new`.
    #[account(mut, owner = config.oracle_program_id @ OrbitError::RandomnessOwnerMismatch)]
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: address-constrained to the SlotHashes sysvar the commit reads.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub recent_slothashes: UncheckedAccount<'info>,
    /// CHECK: executable; must equal `config.oracle_program_id` (handler).
    #[account(executable)]
    pub switchboard_program: UncheckedAccount<'info>,
    /// Permissionless crank caller (I13); plays no role in the outcome.
    pub authority: Signer<'info>,
}

pub fn process(ctx: Context<CommitRandomness>) -> Result<()> {
    let round = &ctx.accounts.round;
    require!(
        round.state == RoundState::AwaitingRandomness,
        OrbitError::RoundNotAwaitingRandomness
    );
    // The pin: commits accept exactly the account `request_randomness`
    // recorded — no shopping among accounts for a favorable oracle path.
    require_keys_eq!(
        ctx.accounts.randomness_account.key(),
        round.randomness_account,
        OrbitError::RandomnessAccountMismatch
    );
    require_keys_eq!(
        ctx.accounts.switchboard_program.key(),
        ctx.accounts.config.oracle_program_id,
        OrbitError::RandomnessProgramMismatch
    );
    require_keys_eq!(
        ctx.accounts.queue.key(),
        ctx.accounts.config.oracle_queue,
        OrbitError::RandomnessQueueMismatch
    );

    // Pre-CPI state: unseeded (the exactly-once lock — a fresh account has
    // `seed_slot == 0`; any commit writes a real slot) and still bound to
    // this round PDA. The parse borrows the account data, so it is dropped
    // before the CPI re-borrows it as mutable.
    let randomness_info = ctx.accounts.randomness_account.to_account_info();
    {
        let randomness = SwitchboardRandomness::parse(&randomness_info)?;
        require!(
            randomness.seed_slot() == 0,
            OrbitError::RandomnessAlreadyCommitted
        );
        require_keys_eq!(
            randomness.authority(),
            round.key(),
            OrbitError::RandomnessAuthorityMismatch
        );
    }

    // ── the commit itself: the round PDA signs the CPI ──
    let round_id_le = round.round_id.to_le_bytes();
    let bump = [round.bump];
    let seeds: &[&[&[u8]]] = &[&[ROUND_SEED, round_id_le.as_ref(), bump.as_ref()]];
    RandomnessCommit::invoke(
        ctx.accounts.switchboard_program.to_account_info(),
        ctx.accounts.randomness_account.to_account_info(),
        ctx.accounts.queue.to_account_info(),
        ctx.accounts.oracle.to_account_info(),
        // authority = the round PDA, signing via its derivation seeds
        ctx.accounts.round.to_account_info(),
        ctx.accounts.recent_slothashes.to_account_info(),
        seeds,
    )
    // The callee's own failure text rides in the transaction logs before
    // the CPI error propagates; this named code is what clients match on.
    .map_err(|_| anchor_lang::error::Error::from(OrbitError::RandomnessCommitFailed))?;

    // Post-CPI belt: the account is now SEEDED with a slot that already
    // satisfies ADR-4 freshness — a commit whose seed could never pass
    // settle's `seed_slot > lock_slot` fails here instead of stranding the
    // round. The value itself arrives later, via the permissionless
    // `randomness_reveal` any crank submits; its presence is settle's check.
    let committed = SwitchboardRandomness::parse(&randomness_info)?;
    require!(
        committed.seed_slot() > round.lock_slot,
        OrbitError::StaleRandomness
    );
    emit!(RandomnessCommitted {
        round_id: round.round_id,
        randomness_account: ctx.accounts.randomness_account.key(),
        oracle: ctx.accounts.oracle.key(),
        seed_slot: committed.seed_slot(),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use switchboard_on_demand::anchor_traits::ToAccountMetas;
    use switchboard_on_demand::on_demand::instructions::randomness_commit::RandomnessCommitAccounts;

    /// The CPI's account privileges, pinned against the vendored crate:
    /// randomness and oracle arrive WRITABLE (the commit writes oracle
    /// stats), queue/slothashes/authority are readonly. Our context's
    /// `mut` set must cover exactly this or the runtime rejects the CPI
    /// with PrivilegeEscalation.
    #[test]
    fn cpi_metas_match_the_context_mut_set() {
        let accs = RandomnessCommitAccounts {
            randomness: Pubkey::new_unique(),
            queue: Pubkey::new_unique(),
            oracle: Pubkey::new_unique(),
            recent_slothashes: Pubkey::new_unique(),
            authority: Pubkey::new_unique(),
        };
        let metas = accs.to_account_metas(None);
        assert!(metas[0].is_writable, "randomness is written");
        assert!(!metas[1].is_writable, "queue stays readonly");
        assert!(metas[2].is_writable, "oracle stats are written");
        assert!(!metas[3].is_writable, "slothashes stays readonly");
        assert!(!metas[4].is_writable, "authority stays readonly");
        assert!(metas[4].is_signer, "authority signs the commit");
        // The crate pins the sysvar itself; our address constraint agrees.
        assert_eq!(
            metas[3].pubkey,
            anchor_lang::solana_program::sysvar::slot_hashes::ID
        );
    }
}
