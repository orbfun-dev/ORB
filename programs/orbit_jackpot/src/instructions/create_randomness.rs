//! `create_randomness` — birth the round's Switchboard account via CPI
//! (phase 8.3, live-protocol completion).
//!
//! The DEPLOYED `randomness_init` requires the account's `authority` to
//! SIGN (probed live: AnchorError 3010 `AccountNotSigner` on authority —
//! the chain IDL's flags are lossy and cannot be trusted for this). Since
//! `request_randomness` pins authority = round PDA, only this program can
//! ever create the round's account: this instruction is that CPI, the
//! round PDA signing with its seeds, exactly like the commit.
//!
//! The crank supplies a FRESH randomness keypair (which signs the
//! transaction) and pays creation rent; the switchboard program does the
//! rest (account, reward escrow, LUT). Pinning stays a separate
//! instruction — creation and precommitment are different commitments.

use crate::constants::{CONFIG_SEED, ROUND_SEED};
use crate::errors::OrbitError;
use crate::state::{GlobalConfig, OracleProvider, Round, RoundState};
use anchor_lang::prelude::*;

/// sha256("global:randomness_init")[..8] — the deployed program's sighash.
const RANDOMNESS_INIT_DISC: [u8; 8] = [0x09, 0x09, 0xcc, 0x21, 0x32, 0x74, 0x71, 0x0f];

/// The Address Lookup Table program (forwarded for the account's LUT):
/// `AddressLookupTab1e1111111111111111111111111`, byte-exact.
const ADDRESS_LOOKUP_TABLE_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey::Pubkey::new_from_array([
        0x02, 0x77, 0xa6, 0xaf, 0x97, 0x33, 0x9b, 0x7a, 0xc8, 0x8d, 0x18, 0x92, 0xc9, 0x04, 0x46,
        0xf5, 0x00, 0x02, 0x30, 0x92, 0x66, 0xf6, 0x2e, 0x53, 0xc1, 0x18, 0x24, 0x49, 0x82, 0x00,
        0x00, 0x00,
    ]);

#[derive(Accounts)]
pub struct CreateRandomness<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,
    /// The fresh randomness account keypair — signs the transaction, is
    /// written (created) by the oracle program through the CPI below.
    ///
    /// CHECK: a brand-new keypair; every property is the oracle program's
    /// to establish inside the CPI.
    #[account(mut)]
    pub randomness: Signer<'info>,
    /// CHECK: owner-constrained; key pinned to `config.oracle_queue` in the
    /// handler so a crank cannot aim creation at a foreign queue.
    #[account(owner = config.oracle_program_id @ OrbitError::RandomnessOwnerMismatch)]
    pub queue: UncheckedAccount<'info>,
    /// Permissionless crank caller; pays the account's creation rent (I13).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the account's wSOL reward escrow ATA — created inside the CPI.
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    /// CHECK: forwarded to the CPI; the oracle program drives them.
    #[account(executable)]
    pub system_program: UncheckedAccount<'info>,
    /// CHECK: forwarded to the CPI.
    #[account(executable)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: forwarded to the CPI.
    #[account(executable)]
    pub associated_token_program: UncheckedAccount<'info>,
    /// CHECK: wrapped SOL mint, forwarded to the CPI.
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    /// CHECK: the oracle program's state PDA; owner-constrained.
    #[account(owner = config.oracle_program_id @ OrbitError::RandomnessOwnerMismatch)]
    pub program_state: UncheckedAccount<'info>,
    /// CHECK: the account's LUT signer PDA — may NOT exist yet (the oracle
    /// program creates it inside the CPI; a fresh account's owner is the
    /// System program, so no owner constraint is possible here). The oracle
    /// program validates it inside the CPI.
    pub lut_signer: UncheckedAccount<'info>,
    /// CHECK: the account's LUT; created inside the CPI via `lut_signer`.
    #[account(mut)]
    pub lut: UncheckedAccount<'info>,
    /// CHECK: address-constrained to the Address Lookup Table program.
    #[account(address = ADDRESS_LOOKUP_TABLE_PROGRAM_ID)]
    pub address_lookup_table_program: UncheckedAccount<'info>,
    /// CHECK: executable; must equal `config.oracle_program_id` (handler).
    #[account(executable)]
    pub switchboard_program: UncheckedAccount<'info>,
}

pub fn process(ctx: Context<CreateRandomness>, recent_slot: u64) -> Result<()> {
    // Randomness fallback: new rounds use the configured provider only.
    require!(
        ctx.accounts.config.oracle_provider == OracleProvider::Switchboard,
        OrbitError::OracleProviderMismatch
    );
    let round = &ctx.accounts.round;
    require!(
        round.state == RoundState::Locked,
        OrbitError::RoundNotLocked
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

    // ── the creation CPI: authority = the round PDA, signing via seeds ──
    let round_id_le = round.round_id.to_le_bytes();
    let bump = [round.bump];
    let seeds: &[&[&[u8]]] = &[&[ROUND_SEED, round_id_le.as_ref(), bump.as_ref()]];
    let mut data = RANDOMNESS_INIT_DISC.to_vec();
    data.extend_from_slice(&recent_slot.to_le_bytes());
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: ctx.accounts.switchboard_program.key(),
        // Meta order probed from the deployed program: randomness, escrow,
        // authority, queue, payer, then the program accounts and the LUT.
        accounts: vec![
            anchor_lang::solana_program::instruction::AccountMeta::new(
                ctx.accounts.randomness.key(),
                true,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new(
                ctx.accounts.reward_escrow.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                round.key(),
                true, // the round PDA — signed through the seeds below
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new(
                ctx.accounts.queue.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new(
                ctx.accounts.payer.key(),
                true,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                ctx.accounts.system_program.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                ctx.accounts.token_program.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                ctx.accounts.associated_token_program.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                ctx.accounts.wrapped_sol_mint.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                ctx.accounts.program_state.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                ctx.accounts.lut_signer.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new(
                ctx.accounts.lut.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                ctx.accounts.address_lookup_table_program.key(),
                false,
            ),
        ],
        data,
    };
    let account_infos = [
        ctx.accounts.randomness.to_account_info(),
        ctx.accounts.reward_escrow.to_account_info(),
        ctx.accounts.round.to_account_info(),
        ctx.accounts.queue.to_account_info(),
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.associated_token_program.to_account_info(),
        ctx.accounts.wrapped_sol_mint.to_account_info(),
        ctx.accounts.program_state.to_account_info(),
        ctx.accounts.lut_signer.to_account_info(),
        ctx.accounts.lut.to_account_info(),
        ctx.accounts.address_lookup_table_program.to_account_info(),
    ];
    anchor_lang::solana_program::program::invoke_signed(&ix, &account_infos, seeds)
        .map_err(|_| anchor_lang::error::Error::from(OrbitError::RandomnessCreateFailed))?;
    Ok(())
}
