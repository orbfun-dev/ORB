//! `reveal_randomness` — publish the oracle's TEE-signed value via CPI
//! (phase 8.3, live-protocol completion).
//!
//! In the live Switchboard protocol the reveal payload (`signature`,
//! `recovery_id`, `value`) is produced by the assigned oracle's HTTPS
//! gateway over the committed slothash. The crank fetches it off-chain and
//! submits it THROUGH this instruction; the round PDA signs the
//! `randomness_reveal` CPI (the deployed program requires the authority
//! for writes on the account it owns). The oracle's secp256k1 signature is
//! verified by the SWITCHBOARD program inside the CPI — never by us — so
//! the crank cannot forge or bias a value; our guards only pin WHAT is
//! revealed onto WHICH round, and the value must match what the CPI wrote.

use crate::constants::{CONFIG_SEED, ROUND_SEED};
use crate::errors::OrbitError;
use crate::oracle::switchboard::SwitchboardRandomness;
use crate::oracle::RandomnessSource;
use crate::state::{GlobalConfig, Round, RoundState};
use anchor_lang::prelude::*;

/// sha256("global:randomness_reveal")[..8] — probed from the devnet IDL.
const RANDOMNESS_REVEAL_DISC: [u8; 8] = [0xc5, 0xb5, 0xbb, 0x0a, 0x1e, 0x3a, 0x14, 0x49];

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct RevealRandomnessArgs {
    /// The oracle gateway's secp256k1 signature over the committed slothash.
    pub signature: [u8; 64],
    pub recovery_id: u8,
    /// The revealed value — belt-checked against what the CPI wrote.
    pub value: [u8; 32],
}

#[derive(Accounts)]
pub struct RevealRandomness<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        seeds = [ROUND_SEED, round.round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,
    /// The exact account pinned by `request_randomness`. Its owner is
    /// constrained to the configured oracle program; key equality, pin
    /// binding, commit state and reveal-once are checked in the handler.
    ///
    /// CHECK: owner constrained above; every semantic property verified in
    /// the handler against the round's write-once pin.
    #[account(mut, owner = config.oracle_program_id @ OrbitError::RandomnessOwnerMismatch)]
    pub randomness_account: UncheckedAccount<'info>,
    /// CHECK: owner-constrained; must equal the oracle assigned by the
    /// commit (handler, against the parsed account).
    #[account(owner = config.oracle_program_id @ OrbitError::RandomnessOwnerMismatch)]
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: owner-constrained; key pinned to `config.oracle_queue` in the
    /// handler.
    #[account(owner = config.oracle_program_id @ OrbitError::RandomnessOwnerMismatch)]
    pub queue: UncheckedAccount<'info>,
    /// CHECK: the ["OracleRandomnessStats", oracle] PDA — re-derived and
    /// key-checked in the handler.
    #[account(mut)]
    pub stats: UncheckedAccount<'info>,
    /// Permissionless crank caller; pays the reveal reward (I13).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: address-constrained to the SlotHashes sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub recent_slothashes: UncheckedAccount<'info>,
    /// CHECK: forwarded to the CPI; the oracle program drives them.
    #[account(executable)]
    pub system_program: UncheckedAccount<'info>,
    /// CHECK: the account's wSOL reward escrow ATA; debited inside the CPI.
    #[account(mut)]
    pub reward_escrow: UncheckedAccount<'info>,
    /// CHECK: forwarded to the CPI.
    #[account(executable)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: wrapped SOL mint, forwarded to the CPI.
    pub wrapped_sol_mint: UncheckedAccount<'info>,
    /// CHECK: the oracle program's state PDA; owner-constrained.
    #[account(owner = config.oracle_program_id @ OrbitError::RandomnessOwnerMismatch)]
    pub program_state: UncheckedAccount<'info>,
    /// CHECK: executable; must equal `config.oracle_program_id` (handler).
    #[account(executable)]
    pub switchboard_program: UncheckedAccount<'info>,
}

pub fn process(ctx: Context<RevealRandomness>, args: RevealRandomnessArgs) -> Result<()> {
    let round = &ctx.accounts.round;
    require!(
        round.state == RoundState::AwaitingRandomness,
        OrbitError::RoundNotAwaitingRandomness
    );
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

    // Pre-CPI state: committed (seeded), not yet revealed, still bound to
    // this round PDA, and the presented oracle is the one the commit
    // assigned. The parse borrows the data, so scope it before the CPI.
    let randomness_info = ctx.accounts.randomness_account.to_account_info();
    {
        let randomness = SwitchboardRandomness::parse(&randomness_info)?;
        require_keys_eq!(
            randomness.authority(),
            round.key(),
            OrbitError::RandomnessAuthorityMismatch
        );
        require_keys_eq!(
            randomness.oracle(),
            ctx.accounts.oracle.key(),
            OrbitError::RandomnessOracleMismatch
        );
        require!(
            randomness.seed_slot() > round.lock_slot,
            OrbitError::RandomnessNotCommitted
        );
        require!(
            !randomness.is_revealed(),
            OrbitError::RandomnessAlreadyRevealed
        );
    }
    // The stats account is the oracle program's own PDA over the oracle key.
    let derived_stats = Pubkey::find_program_address(
        &[b"OracleRandomnessStats", ctx.accounts.oracle.key().as_ref()],
        &ctx.accounts.config.oracle_program_id,
    )
    .0;
    require_keys_eq!(
        ctx.accounts.stats.key(),
        derived_stats,
        OrbitError::RandomnessStatsMismatch
    );

    // ── the reveal CPI: authority = the round PDA, signing via seeds ──
    let round_id_le = round.round_id.to_le_bytes();
    let bump = [round.bump];
    let seeds: &[&[&[u8]]] = &[&[ROUND_SEED, round_id_le.as_ref(), bump.as_ref()]];
    let mut data = RANDOMNESS_REVEAL_DISC.to_vec();
    data.extend_from_slice(&args.signature);
    data.push(args.recovery_id);
    data.extend_from_slice(&args.value);
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: ctx.accounts.switchboard_program.key(),
        // Meta order probed from the deployed program.
        accounts: vec![
            anchor_lang::solana_program::instruction::AccountMeta::new(
                ctx.accounts.randomness_account.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                ctx.accounts.oracle.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                ctx.accounts.queue.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new(
                ctx.accounts.stats.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                round.key(),
                true, // the round PDA — signed through the seeds below
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new(
                ctx.accounts.payer.key(),
                true,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                ctx.accounts.recent_slothashes.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                ctx.accounts.system_program.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new(
                ctx.accounts.reward_escrow.key(),
                false,
            ),
            anchor_lang::solana_program::instruction::AccountMeta::new_readonly(
                ctx.accounts.token_program.key(),
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
        ],
        data,
    };
    let account_infos = [
        ctx.accounts.randomness_account.to_account_info(),
        ctx.accounts.oracle.to_account_info(),
        ctx.accounts.queue.to_account_info(),
        ctx.accounts.stats.to_account_info(),
        ctx.accounts.round.to_account_info(),
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.recent_slothashes.to_account_info(),
        ctx.accounts.system_program.to_account_info(),
        ctx.accounts.reward_escrow.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        ctx.accounts.wrapped_sol_mint.to_account_info(),
        ctx.accounts.program_state.to_account_info(),
    ];
    anchor_lang::solana_program::program::invoke_signed(&ix, &account_infos, seeds)
        .map_err(|_| anchor_lang::error::Error::from(OrbitError::RandomnessRevealFailed))?;

    // Post-CPI belt: the account now carries exactly the value the gateway
    // signed and the crank presented — settlement will read the same bytes.
    let revealed = SwitchboardRandomness::parse(&randomness_info)?;
    require!(revealed.is_revealed(), OrbitError::RandomnessNotRevealed);
    require!(
        revealed.value() == args.value,
        OrbitError::RandomnessRevealMismatch
    );
    Ok(())
}
