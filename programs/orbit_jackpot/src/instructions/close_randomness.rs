//! `close_randomness` — reclaim a finished round's Switchboard rent
//! (Phase 13, docs/reports/switchboard-rent.md option A).
//!
//! `create_randomness` pays for three accounts per round: the randomness
//! account (480 B), its wSOL reward-escrow ATA, and an address lookup
//! table — ≈ 0.006 SOL. Their authority is the ROUND PDA, and
//! `close_round` deletes that PDA, so before this instruction nobody could
//! ever close them: every settled round stranded the rent for good.
//!
//! This CPIs Switchboard's `randomness_close` with the round PDA signing,
//! inside the only window that works: after the round is terminal
//! (`Settled` / `Cancelled` — the value is consumed or will never be), and
//! before `close_round`. Switchboard closes the randomness account and the
//! escrow and credits their lamports to the AUTHORITY — the round account
//! itself. `close_round` then sweeps everything the round holds to
//! `round.rent_payer`, so the rent returns to whoever opened the round
//! (normally the keeper) with no new transfer logic here. The lookup table
//! is only deactivated by this call; the crank reclaims it after the
//! address-lookup-table cooldown with `randomness_close_lut`, which the
//! randomness KEYPAIR signs (the crank persisted it at create time).
//!
//! Permissionless and harmless to call early or twice: a non-terminal
//! round is refused and an unpinned round is refused.
//!
//! AUDIT P-4: a successful close CLEARS `round.randomness_account`, and
//! `close_round` requires it cleared — so the round PDA (the randomness
//! account's only authority) can never be deleted while Switchboard still
//! holds its rent. If the pinned account is already gone (closed by an
//! earlier build that did not clear the pin), the call only clears it.

use crate::constants::{CONFIG_SEED, ROUND_SEED};
use crate::errors::OrbitError;
use crate::oracle::{classify_pinned, PinnedSource};
use crate::state::{GlobalConfig, Round, RoundState};
use anchor_lang::prelude::*;

/// sha256("global:randomness_close")[..8] — confirmed on the deployed
/// devnet Switchboard program (simulation logs "Instruction:
/// RandomnessClose"). `RandomnessCloseParams` has no fields.
pub const RANDOMNESS_CLOSE_DISC: [u8; 8] = [0x92, 0x65, 0x0e, 0x4a, 0xe1, 0xf6, 0x00, 0x9c];

const ADDRESS_LOOKUP_TABLE_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey::Pubkey::new_from_array([
        0x02, 0x77, 0xa6, 0xaf, 0x97, 0x33, 0x9b, 0x7a, 0xc8, 0x8d, 0x18, 0x92, 0xc9, 0x04, 0x46,
        0xf5, 0x00, 0x02, 0x30, 0x92, 0x66, 0xf6, 0x2e, 0x53, 0xc1, 0x18, 0x24, 0x49, 0x82, 0x00,
        0x00, 0x00,
    ]);

#[derive(Accounts)]
pub struct CloseRandomness<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    /// The authority of the randomness account; receives the reclaimed
    /// lamports, which `close_round` later forwards to `rent_payer`.
    #[account(
        mut,
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,
    /// CHECK: must equal the round's write-once pin (handler) and be owned
    /// by the configured oracle program — or already closed (handler).
    #[account(mut)]
    pub randomness_account: UncheckedAccount<'info>,
    /// CHECK: the account's wSOL reward-escrow ATA; Switchboard verifies
    /// and closes it inside the CPI.
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    /// CHECK: the oracle program's state PDA; owner-constrained.
    #[account(owner = config.oracle_program_id @ OrbitError::RandomnessOwnerMismatch)]
    pub program_state: UncheckedAccount<'info>,
    /// CHECK: forwarded to the CPI.
    #[account(executable)]
    pub system_program: UncheckedAccount<'info>,
    /// CHECK: forwarded to the CPI.
    #[account(executable)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: wrapped SOL mint, forwarded to the CPI.
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    /// CHECK: the account's lookup table; Switchboard derives and checks
    /// it from the randomness account's stored `lut_slot`.
    #[account(mut)]
    pub lut: UncheckedAccount<'info>,
    /// CHECK: Switchboard's LUT signer PDA for this randomness account.
    pub lut_signer: UncheckedAccount<'info>,
    /// CHECK: address-constrained.
    #[account(address = ADDRESS_LOOKUP_TABLE_PROGRAM_ID)]
    pub address_lookup_table_program: UncheckedAccount<'info>,
    /// CHECK: executable; must equal `config.oracle_program_id` (handler).
    #[account(executable)]
    pub switchboard_program: UncheckedAccount<'info>,
    /// Permissionless caller; pays only the transaction fee.
    pub crank: Signer<'info>,
}

pub fn process(ctx: Context<CloseRandomness>) -> Result<()> {
    let round = &ctx.accounts.round;
    require!(
        matches!(round.state, RoundState::Settled | RoundState::Cancelled),
        OrbitError::IllegalStateTransition
    );
    require!(
        round.randomness_account != Pubkey::default(),
        OrbitError::RandomnessAccountMismatch
    );
    require_keys_eq!(
        ctx.accounts.randomness_account.key(),
        round.randomness_account,
        OrbitError::RandomnessAccountMismatch
    );
    // Randomness fallback: an entropy round pins the shared chain account,
    // which is never closed — there is no rent to reclaim, only the pin to
    // clear so `close_round` can run.
    if ctx.accounts.randomness_account.owner == &crate::ID {
        let info = ctx.accounts.randomness_account.to_account_info();
        require!(
            classify_pinned(&info, &ctx.accounts.config.oracle_program_id)?
                == PinnedSource::Entropy,
            OrbitError::RandomnessAccountMismatch
        );
        ctx.accounts.round.randomness_account = Pubkey::default();
        return Ok(());
    }
    require_keys_eq!(
        ctx.accounts.switchboard_program.key(),
        ctx.accounts.config.oracle_program_id,
        OrbitError::RandomnessProgramMismatch
    );

    let randomness = &ctx.accounts.randomness_account;
    if randomness.lamports() == 0 && randomness.owner == &anchor_lang::system_program::ID {
        // Already closed: nothing to reclaim, only the pin to clear.
        ctx.accounts.round.randomness_account = Pubkey::default();
        msg!("close_randomness: round {} randomness already closed; pin cleared", ctx.accounts.round.round_id);
        return Ok(());
    }
    require_keys_eq!(
        *randomness.owner,
        ctx.accounts.config.oracle_program_id,
        OrbitError::RandomnessOwnerMismatch
    );

    let round = &ctx.accounts.round;
    let metas = close_metas(
        ctx.accounts.randomness_account.key(),
        ctx.accounts.reward_escrow.key(),
        round.key(),
        ctx.accounts.program_state.key(),
        ctx.accounts.system_program.key(),
        ctx.accounts.token_program.key(),
        ctx.accounts.wrapped_sol_mint.key(),
        ctx.accounts.lut.key(),
        ctx.accounts.lut_signer.key(),
        ctx.accounts.address_lookup_table_program.key(),
    );
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: ctx.accounts.switchboard_program.key(),
        accounts: metas,
        data: RANDOMNESS_CLOSE_DISC.to_vec(),
    };

    let round_id_le = round.round_id.to_le_bytes();
    let bump = [round.bump];
    let seeds: &[&[&[u8]]] = &[&[ROUND_SEED, round_id_le.as_ref(), bump.as_ref()]];
    let before = ctx.accounts.round.get_lamports();
    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            ctx.accounts.randomness_account.to_account_info(),
            ctx.accounts.reward_escrow.to_account_info(),
            ctx.accounts.round.to_account_info(),
            ctx.accounts.program_state.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.wrapped_sol_mint.to_account_info(),
            ctx.accounts.lut.to_account_info(),
            ctx.accounts.lut_signer.to_account_info(),
            ctx.accounts.address_lookup_table_program.to_account_info(),
            ctx.accounts.switchboard_program.to_account_info(),
        ],
        seeds,
    )?;
    let reclaimed = ctx.accounts.round.get_lamports().saturating_sub(before);
    ctx.accounts.round.randomness_account = Pubkey::default();
    msg!(
        "close_randomness: round {} reclaimed {} lamports into the round account",
        ctx.accounts.round.round_id,
        reclaimed
    );
    Ok(())
}

/// The `randomness_close` account list, in the deployed IDL's order:
/// randomness (w), rewardEscrow (w), authority (w, signer — the round
/// PDA), programState, systemProgram, tokenProgram, wrappedSolMint,
/// lut (w), lutSigner, addressLookupTableProgram.
#[allow(clippy::too_many_arguments)]
pub fn close_metas(
    randomness: Pubkey,
    reward_escrow: Pubkey,
    round: Pubkey,
    program_state: Pubkey,
    system_program: Pubkey,
    token_program: Pubkey,
    wrapped_sol_mint: Pubkey,
    lut: Pubkey,
    lut_signer: Pubkey,
    alt_program: Pubkey,
) -> Vec<anchor_lang::solana_program::instruction::AccountMeta> {
    use anchor_lang::solana_program::instruction::AccountMeta;
    vec![
        AccountMeta::new(randomness, false),
        AccountMeta::new(reward_escrow, false),
        AccountMeta::new(round, true),
        AccountMeta::new_readonly(program_state, false),
        AccountMeta::new_readonly(system_program, false),
        AccountMeta::new_readonly(token_program, false),
        AccountMeta::new_readonly(wrapped_sol_mint, false),
        AccountMeta::new(lut, false),
        AccountMeta::new_readonly(lut_signer, false),
        AccountMeta::new_readonly(alt_program, false),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminator_is_the_anchor_sighash() {
        let hash = solana_sdk::hash::hashv(&[b"global:randomness_close"]);
        assert_eq!(&hash.to_bytes()[..8], &RANDOMNESS_CLOSE_DISC);
    }

    #[test]
    fn metas_match_the_deployed_idl_mutability() {
        let k = |n: u8| Pubkey::new_from_array([n; 32]);
        let metas = close_metas(k(1), k(2), k(3), k(4), k(5), k(6), k(7), k(8), k(9), k(10));
        let shape: Vec<(bool, bool)> = metas.iter().map(|m| (m.is_writable, m.is_signer)).collect();
        assert_eq!(
            shape,
            vec![
                (true, false),  // randomness
                (true, false),  // rewardEscrow
                (true, true),   // authority = round PDA
                (false, false), // programState
                (false, false), // systemProgram
                (false, false), // tokenProgram
                (false, false), // wrappedSolMint
                (true, false),  // lut
                (false, false), // lutSigner
                (false, false), // addressLookupTableProgram
            ]
        );
        assert_eq!(metas[2].pubkey, k(3));
    }
}
