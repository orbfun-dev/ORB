// Orbit Jackpot — program root.
//
// Per the roadmap (§2) this file holds only the program id, the `#[program]`
// module of thin instruction entrypoints (empty until Phase 3), and the pure
// module tree. All logic lives in the leaf modules.

pub mod constants;
pub mod entropy;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod invariants;
pub mod math;
pub mod oracle;
pub mod state;

// Test-only: generates/verifies the cross-language layout fixture consumed
// by the TypeScript SDK decoder suite (Phase 7.0).
#[cfg(test)]
mod layout_fixture;

use anchor_lang::prelude::*;

use instructions::{
    accept_admin, admin_sweep_fees, admin_toggle_pause, cancel_round, claim_winnings, close_entry,
    close_randomness, close_round, commit_randomness, crank_auto_deposit, create_randomness, deposit,
    drain_mega_pot_v1_preflight, fulfill_settle, init_or_deposit_escrow, initialize, lock_round,
    migrate_economics, migrate_economics_v3, open_round, request_entropy, request_randomness, reveal_entropy, reveal_randomness, set_entropy_chain, sweep_unclaimed_prize,
    transfer_admin, update_config, withdraw_escrow, AcceptAdmin, AdminSweepFees, CancelRound,
    ClaimWinnings, CloseEntry, CloseRandomness, CloseRound, CommitRandomness, CrankAutoDeposit, CreateRandomness,
    Deposit, DrainMegaPotV1Preflight, FulfillSettle, InitOrDepositEscrow, Initialize,
    InitializeArgs, LockRound, MigrateEconomicsV2, MigrateEconomicsV2Args, MigrateEconomicsV3, OpenRound, RefundEntry,
    RequestEntropy, RequestRandomness, RevealEntropy, RevealRandomness, RevealRandomnessArgs, SetEntropyChain, SweepUnclaimedPrize, TogglePause,
    TransferAdmin, UpdateConfig, UpdateConfigArgs, WithdrawEscrow,
};
// Anchor's #[program] codegen references the macro-generated client-account
// modules via absolute crate-root paths (`pub use crate::__client_accounts_x::*`)
// regardless of where the contexts live, so they must be imported here.
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::accept_admin::__client_accounts_accept_admin;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::admin_sweep_fees::__client_accounts_admin_sweep_fees;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::admin_toggle_pause::__client_accounts_toggle_pause;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::cancel_round::__client_accounts_cancel_round;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::cancel_round::__client_accounts_refund_entry;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::claim_winnings::__client_accounts_claim_winnings;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::close_entry::__client_accounts_close_entry;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::close_round::__client_accounts_close_round;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::commit_randomness::__client_accounts_commit_randomness;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::crank_auto_deposit::__client_accounts_crank_auto_deposit;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::create_randomness::__client_accounts_create_randomness;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::deposit::__client_accounts_deposit;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::drain_mega_pot_v1_preflight::__client_accounts_drain_mega_pot_v1_preflight;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::fulfill_settle::__client_accounts_fulfill_settle;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::init_or_deposit_escrow::__client_accounts_init_or_deposit_escrow;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::initialize::__client_accounts_initialize;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::lock_round::__client_accounts_lock_round;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::migrate_economics::__client_accounts_migrate_economics_v2;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::open_round::__client_accounts_open_round;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::request_randomness::__client_accounts_request_randomness;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::reveal_randomness::__client_accounts_reveal_randomness;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::close_randomness::__client_accounts_close_randomness;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::migrate_economics_v3::__client_accounts_migrate_economics_v3;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::sweep_unclaimed_prize::__client_accounts_sweep_unclaimed_prize;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::transfer_admin::__client_accounts_transfer_admin;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::update_config::__client_accounts_update_config;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::withdraw_escrow::__client_accounts_withdraw_escrow;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::request_entropy::__client_accounts_request_entropy;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::reveal_entropy::__client_accounts_reveal_entropy;
#[allow(unused_imports)] // macro-generated, consumed by #[program] codegen
use instructions::set_entropy_chain::__client_accounts_set_entropy_chain;

// One codebase, two deployments. The default build is the devnet program
// (staging + every test); `--features mainnet` builds the mainnet one:
//   anchor build -- --features mainnet
// The mainnet address is the `orb-program` keypair generated 2026-10-08
// (~/.config/orb/mainnet/orb-program.json, never committed).
#[cfg(feature = "mainnet")]
declare_id!("ETMqujXHndqa3SfGHFhNMPwb4w43NhV96Majv3xbC3bH");
#[cfg(not(feature = "mainnet"))]
declare_id!("G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R");

#[program]
pub mod orbit_jackpot {
    use super::*;

    /// One-time program setup; a second call cannot reach the handler.
    pub fn initialize(ctx: Context<Initialize>, args: InitializeArgs) -> Result<()> {
        initialize::process(ctx, args)
    }

    /// Permissionless: opens round `next_round_id` once no round is `Open`.
    pub fn open_round(ctx: Context<OpenRound>) -> Result<()> {
        open_round::process(ctx)
    }

    /// The hot path: escrow native SOL, mint one entry and its ticket range.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        deposit::process(ctx, amount)
    }

    /// Player: funds (or re-funds) their escrow and declares its
    /// auto-deposit terms; `amount == 0` changes terms only.
    pub fn init_or_deposit_escrow(
        ctx: Context<InitOrDepositEscrow>,
        amount: u64,
        per_round_lamports: u64,
        max_rounds: u32,
        auto_reinvest: bool,
    ) -> Result<()> {
        init_or_deposit_escrow::process(ctx, amount, per_round_lamports, max_rounds, auto_reinvest)
    }

    /// Player: withdraws spendable escrow lamports to their wallet. Not
    /// pause-gated — a fund exit keeps maximum liveness.
    pub fn withdraw_escrow(ctx: Context<WithdrawEscrow>, amount: u64) -> Result<()> {
        withdraw_escrow::process(ctx, amount)
    }

    /// Permissionless: enters a funded escrow into an open round, paying
    /// the stake (to the vault), the entry rent and the crank tip (to the
    /// caller) all out of the escrow. The minted entry's `player` is the
    /// escrow PDA.
    pub fn crank_auto_deposit(ctx: Context<CrankAutoDeposit>, round_id: u64) -> Result<()> {
        crank_auto_deposit::process(ctx, round_id)
    }

    /// Permissionless crank: closes the deposit window (or auto-cancels).
    pub fn lock_round(ctx: Context<LockRound>) -> Result<()> {
        lock_round::process(ctx)
    }

    /// Permissionless: cancels a round whose randomness reveal timed out.
    pub fn cancel_round(ctx: Context<CancelRound>) -> Result<()> {
        cancel_round::process(ctx)
    }

    /// Permissionless: refunds one entry of a cancelled round in full.
    pub fn refund_entry(ctx: Context<RefundEntry>, entry_index: u32) -> Result<()> {
        cancel_round::refund(ctx, entry_index)
    }

    /// Permissionless: pins the round's randomness account (write-once).
    pub fn request_randomness(ctx: Context<RequestRandomness>) -> Result<()> {
        request_randomness::process(ctx)
    }

    /// Permissionless: births the round's Switchboard randomness account
    /// via CPI — the round PDA signs as the account authority (the
    /// deployed `randomness_init` demands the authority's signature).
    pub fn create_randomness(ctx: Context<CreateRandomness>, recent_slot: u64) -> Result<()> {
        create_randomness::process(ctx, recent_slot)
    }

    /// Permissionless: the round PDA commits its pinned randomness account
    /// via the Switchboard `randomness_commit` CPI (exactly-once).
    pub fn commit_randomness(ctx: Context<CommitRandomness>) -> Result<()> {
        commit_randomness::process(ctx)
    }

    /// Permissionless: publishes the oracle gateway's TEE-signed reveal
    /// via the `randomness_reveal` CPI (round PDA signs; exactly-once).
    pub fn reveal_randomness(
        ctx: Context<RevealRandomness>,
        args: RevealRandomnessArgs,
    ) -> Result<()> {
        reveal_randomness::process(ctx, args)
    }

    /// Permissionless: once a round is terminal, closes its Switchboard
    /// randomness account + reward escrow (round PDA signs) so the rent
    /// rides `close_round` back to the opener instead of stranding.
    pub fn close_randomness(ctx: Context<CloseRandomness>) -> Result<()> {
        close_randomness::process(ctx)
    }

    /// Admin: create or rotate the self-hosted entropy hash chain
    /// (randomness fallback). Refused while a round is in flight on it.
    pub fn set_entropy_chain(
        ctx: Context<SetEntropyChain>,
        commit: [u8; 32],
        length: u64,
    ) -> Result<()> {
        set_entropy_chain::process(ctx, commit, length)
    }

    /// Permissionless: pins a Locked round to the entropy chain and fixes
    /// its target slot (only while the configured provider is Entropy).
    pub fn request_entropy(ctx: Context<RequestEntropy>) -> Result<()> {
        request_entropy::process(ctx)
    }

    /// Reveals the next hash-chain seed for the pending entropy round and
    /// fixes its value from the target slot's hash.
    pub fn reveal_entropy(ctx: Context<RevealEntropy>, seed: [u8; 32]) -> Result<()> {
        reveal_entropy::process(ctx, seed)
    }

    /// Admin, one-way: v2 → v3 settlement (the rake falls on the losers'
    /// money only; `fulfill_settle` then requires the winning entry).
    pub fn migrate_economics_v3(ctx: Context<MigrateEconomicsV3>) -> Result<()> {
        migrate_economics_v3::process(ctx)
    }

    /// Permissionless crank: resolves the winning ticket and moves the cuts.
    pub fn fulfill_settle(ctx: Context<FulfillSettle>) -> Result<()> {
        fulfill_settle::process(ctx)
    }

    /// Permissionless: O(1) membership proof; pays `entry.player`.
    pub fn claim_winnings(ctx: Context<ClaimWinnings>, entry_index: u32) -> Result<()> {
        claim_winnings::process(ctx, entry_index)
    }

    /// Treasury authority: sweeps accrued fees to a destination wallet.
    pub fn admin_sweep_fees(ctx: Context<AdminSweepFees>) -> Result<()> {
        admin_sweep_fees::process(ctx)
    }

    /// Admin: toggles the pause brake (blocks deposit/open_round only).
    pub fn toggle_pause(ctx: Context<TogglePause>) -> Result<()> {
        admin_toggle_pause::process(ctx)
    }

    /// Permissionless: routes a lapsed unclaimed prize into the Mega-Pot.
    pub fn sweep_unclaimed_prize(ctx: Context<SweepUnclaimedPrize>) -> Result<()> {
        sweep_unclaimed_prize::process(ctx)
    }

    /// Permissionless: reclaims a settled round's entry rent for its player.
    pub fn close_entry(ctx: Context<CloseEntry>, entry_index: u32) -> Result<()> {
        close_entry::process(ctx, entry_index)
    }

    /// Permissionless: closes a fully drained and pruned round.
    pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
        close_round::process(ctx)
    }

    /// Admin: updates operational parameters; economics are structurally
    /// absent from the args (ADR-10).
    pub fn update_config(ctx: Context<UpdateConfig>, args: UpdateConfigArgs) -> Result<()> {
        update_config::process(ctx, args)
    }

    /// Admin: stages a successor admin (step one of two).
    pub fn transfer_admin(ctx: Context<TransferAdmin>, new_admin: Pubkey) -> Result<()> {
        transfer_admin::process(ctx, new_admin)
    }

    /// Admin, one-shot preflight: pays the pre-v2 Mega-Pot out to the
    /// treasury so the migration's `accrued_lamports == 0` guard is
    /// satisfied honestly (under v1 odds the pot can never reach 0 by
    /// itself). Refuses once `economics_version >= 2` or any round is in
    /// flight.
    pub fn drain_mega_pot_v1_preflight(ctx: Context<DrainMegaPotV1Preflight>) -> Result<()> {
        drain_mega_pot_v1_preflight::process(ctx)
    }

    /// Admin, one-way: retunes the economics to the v2 partial-loss model
    /// (ADR-11). Refuses while the Mega-Pot holds lamports or any round is
    /// in flight; after the latch, economics are immutable again.
    pub fn migrate_economics_v2(
        ctx: Context<MigrateEconomicsV2>,
        args: MigrateEconomicsV2Args,
    ) -> Result<()> {
        migrate_economics::process(ctx, args)
    }

    /// Pending admin: accepts the seat and clears the staging slot.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        accept_admin::process(ctx)
    }
}
