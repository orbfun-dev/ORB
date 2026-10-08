//! Integration suite — roadmap Phase 3 gates, executed against the real SBF
//! build via the `solana-program-test` banks client (the Rust-side
//! alternative this workspace's `Anchor.toml` wires into `anchor test`).
//!
//! The Switchboard randomness account is a **byte-exact fabricated mock**
//! (roadmap task 0.4's primary approach): the oracle's signature is verified
//! by the Switchboard program at reveal time, so a consumer reading a
//! committed account needs no signature check — the on-chain parser accepts
//! the fabricated layout, which is exactly what these tests prove.
//!
//! Every scenario asserts the balance invariants (I1–I5) and the split
//! exactness (I6, I7) with exact lamport arithmetic.

use borsh::BorshDeserialize;
use orbit_jackpot::instructions::initialize::InitializeArgs;
use orbit_jackpot::instructions::update_config::UpdateConfigArgs;
use orbit_jackpot::state::{
    EntropyChain, GlobalConfig, MegaPotVault, OracleProvider, PlayerEntry, PlayerEscrow, Round, RoundState,
    RoundVault, TreasuryVault,
};

use solana_program_test::{ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    clock::Clock,
    hash::hashv,
    instruction::{AccountMeta, Instruction},
    pubkey,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use std::time::Instant;

const PROGRAM_ID: Pubkey = pubkey!("G5yNWmzSPVozbXSj2Muv4pV8AbVwTHhJfL6nfWyAC48R");
const SOL: u64 = 1_000_000_000;
const ROUND_DURATION_SECS: i64 = 5;
/// Phase 10 test parameters: the design's devnet recommendation (20 s
/// window / 200_000 tip) scaled to the 5 s test rounds. The window must
/// stay positive and strictly below `ROUND_DURATION_SECS` (validation).
const AUTO_DEPOSIT_WINDOW_SECS: i64 = 2;
const AUTO_DEPOSIT_TIP_LAMPORTS: u64 = 200_000;
/// Slot stamped into the mock randomness account. Any value above the
/// round's `lock_slot` satisfies ADR-4 freshness; tests run at low slots.
const MOCK_SEED_SLOT: u64 = 10_000_000;

// ─── keys ─────────────────────────────────────────────────────────────────

fn config_key() -> Pubkey {
    Pubkey::find_program_address(&[b"config"], &PROGRAM_ID).0
}
fn treasury_key() -> Pubkey {
    Pubkey::find_program_address(&[b"treasury"], &PROGRAM_ID).0
}
fn mega_pot_key() -> Pubkey {
    Pubkey::find_program_address(&[b"mega_pot"], &PROGRAM_ID).0
}
fn round_key(round_id: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"round", &round_id.to_le_bytes()], &PROGRAM_ID).0
}
fn round_vault_key(round_id: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"round_vault", &round_id.to_le_bytes()], &PROGRAM_ID).0
}
fn entry_key(round_id: u64, entry_index: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"entry",
            &round_id.to_le_bytes(),
            &entry_index.to_le_bytes(),
        ],
        &PROGRAM_ID,
    )
    .0
}
fn event_authority_key() -> Pubkey {
    Pubkey::find_program_address(&[b"__event_authority"], &PROGRAM_ID).0
}
fn escrow_key(owner: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"escrow", owner.as_ref()], &PROGRAM_ID).0
}

/// A raw System `Transfer` — the crate's `system_instruction::transfer` is
/// deprecated under `-D warnings`; the wire form is the 4-byte LE ordinal
/// (2) ++ borsh u64 lamports.
fn sol_transfer(from: Pubkey, to: Pubkey, lamports: u64) -> Instruction {
    let mut data = Vec::with_capacity(12);
    data.extend_from_slice(&2u32.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: solana_sdk::system_program::ID,
        accounts: vec![AccountMeta::new(from, true), AccountMeta::new(to, false)],
        data,
    }
}

// ─── instruction encoding ─────────────────────────────────────────────────

fn anchor_account_disc(type_name: &str) -> Vec<u8> {
    hashv(&[format!("account:{type_name}").as_bytes()]).to_bytes()[..8].to_vec()
}

fn sighash(name: &str) -> [u8; 8] {
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hashv(&[format!("global:{name}").as_bytes()]).to_bytes()[..8]);
    disc
}

/// Anchor event discriminator for `RoundWindowRolled`:
/// sha256("event:RoundWindowRolled")[..8] — the same scheme
/// `anchor_account_disc` uses for accounts.
fn round_window_rolled_disc() -> [u8; 8] {
    let mut disc = [0u8; 8];
    disc.copy_from_slice(&hashv(&[b"event:RoundWindowRolled"]).to_bytes()[..8]);
    disc
}

/// Decodes every `RoundWindowRolled` emission out of raw program logs
/// (`Program data: <base64(disc ++ borsh)>` — anchor's `emit!` rides
/// `sol_log_data`, whose payload is base64, the same scheme the SDK's
/// parseEventLog reads on live chains) as
/// `(round_id, start_ts, end_ts, reason)` — the Phase 12 battery asserts
/// the event, not just the account-state effects it mirrors.
fn round_window_rolls(logs: &[String]) -> Vec<(u64, i64, i64, u8)> {
    use base64::Engine as _;
    let disc = round_window_rolled_disc();
    logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|encoded| {
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .ok()
        })
        .filter(|bytes| bytes.len() == 8 + 8 + 8 + 8 + 1 && bytes[..8] == disc)
        .map(|bytes| {
            let le =
                |off: usize| i64::from_le_bytes(bytes[off..off + 8].try_into().expect("i64 slice"));
            (
                u64::from_le_bytes(bytes[8..16].try_into().expect("u64 slice")),
                le(16),
                le(24),
                bytes[32],
            )
        })
        .collect()
}

fn instruction(name: &str, args: &[u8], metas: Vec<AccountMeta>) -> Instruction {
    let mut data = sighash(name).to_vec();
    data.extend_from_slice(args);
    Instruction {
        program_id: PROGRAM_ID,
        accounts: metas,
        data,
    }
}

fn default_args() -> InitializeArgs {
    InitializeArgs {
        treasury_authority: Pubkey::new_unique(),
        oracle_program_id: Pubkey::new_unique(),
        // Overridden by every setup to the boot's fake queue account;
        // `initialize` rejects the default key.
        oracle_queue: Pubkey::default(),
        oracle_provider: OracleProvider::Switchboard,
        max_entries_per_round: 0,
        round_duration_secs: ROUND_DURATION_SECS,
        max_round_duration_secs: 300,
        anti_snipe_window_secs: 0,
        anti_snipe_extension_secs: 0,
        claim_deadline_secs: 2_592_000,
        min_deposit_lamports: SOL / 100,
        anti_snipe_min_deposit_lamports: SOL / 20,
        keeper_tip_lamports: 0,
        randomness_reveal_deadline_slots: 400,
        // Zeroes replicate the deployed config's post-upgrade read of the
        // former reserved bytes: auto-deposit stays off (Phase 10 design
        // §3.2) until a test deliberately enables it.
        auto_deposit_window_secs: 0,
        auto_deposit_tip_lamports: 0,
        auto_deposit_enabled: false,
        account_open_fee_lamports: 0,
    }
}

fn initialize_ix(admin: &Keypair, args: &InitializeArgs) -> Instruction {
    use borsh::BorshSerialize;
    let mut data = Vec::new();
    args.serialize(&mut data).expect("borsh args in test");
    instruction(
        "initialize",
        &data,
        vec![
            AccountMeta::new(config_key(), false),
            AccountMeta::new(treasury_key(), false),
            AccountMeta::new(mega_pot_key(), false),
            AccountMeta::new(admin.pubkey(), true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
    )
}

fn open_round_ix(payer: Pubkey, round_id: u64, previous: Option<Pubkey>) -> Instruction {
    // `previous_round` is the trailing Option slot: the program-id sentinel
    // means `None` (anchor's convention); an unclosed predecessor must be
    // presented so the at-most-one-Open-round gate can inspect it.
    let previous_meta = AccountMeta::new_readonly(previous.unwrap_or(PROGRAM_ID), false);
    instruction(
        "open_round",
        &[],
        vec![
            AccountMeta::new(config_key(), false),
            AccountMeta::new(round_key(round_id), false),
            AccountMeta::new(round_vault_key(round_id), false),
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
            previous_meta,
        ],
    )
}

fn deposit_ix(player: Pubkey, round_id: u64, entry_index: u32, amount: u64) -> Instruction {
    // Phase 11.6: the player profile escrow (init_if_needed) + the fee
    // sink ride along on every deposit.
    instruction(
        "deposit",
        &amount.to_le_bytes(),
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new(round_key(round_id), false),
            AccountMeta::new(entry_key(round_id, entry_index), false),
            AccountMeta::new(round_vault_key(round_id), false),
            AccountMeta::new(escrow_key(player), false),
            AccountMeta::new(mega_pot_key(), false),
            AccountMeta::new(player, true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
        ],
    )
}

fn lock_round_ix(round_id: u64, crank: Pubkey) -> Instruction {
    instruction(
        "lock_round",
        &[],
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new(round_key(round_id), false),
            AccountMeta::new_readonly(round_vault_key(round_id), false),
            AccountMeta::new_readonly(crank, true),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
        ],
    )
}

fn request_randomness_ix(round_id: u64, randomness: Pubkey, crank: Pubkey) -> Instruction {
    instruction(
        "request_randomness",
        &[],
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new(round_key(round_id), false),
            AccountMeta::new_readonly(round_vault_key(round_id), false),
            AccountMeta::new_readonly(randomness, false),
            AccountMeta::new_readonly(crank, true),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
        ],
    )
}

/// `commit_randomness`: the round PDA signs the `randomness_commit` CPI into
/// the (fake) switchboard program. `randomness` is MUTABLE — the oracle
/// program writes the reveal through the CPI.
fn commit_randomness_ix(
    round_id: u64,
    randomness: Pubkey,
    queue: Pubkey,
    oracle: Pubkey,
    switchboard_program: Pubkey,
    crank: Pubkey,
) -> Instruction {
    instruction(
        "commit_randomness",
        &[],
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new_readonly(round_key(round_id), false),
            AccountMeta::new(randomness, false),
            AccountMeta::new_readonly(queue, false),
            // Writable: `randomness_commit` bumps the oracle's stats —
            // pinned by `cpi_metas_match_the_context_mut_set`.
            AccountMeta::new(oracle, false),
            AccountMeta::new_readonly(solana_sdk::sysvar::slot_hashes::ID, false),
            AccountMeta::new_readonly(switchboard_program, false),
            AccountMeta::new_readonly(crank, true),
        ],
    )
}

/// The crank-submitted `randomness_reveal` THROUGH our program: the round
/// PDA signs the CPI (the deployed program demands the authority for
/// account writes), the crank pays. Args are the gateway payload.
#[allow(clippy::too_many_arguments)]
fn reveal_randomness_ix(
    round_id: u64,
    randomness: Pubkey,
    oracle: Pubkey,
    queue: Pubkey,
    stats: Pubkey,
    program_state: Pubkey,
    switchboard_program: Pubkey,
    crank: Pubkey,
    value: [u8; 32],
) -> Instruction {
    // sighash ++ borsh RevealRandomnessArgs { signature [u8;64],
    // recovery_id u8, value [u8;32] } — fixed-width, 97 bytes.
    let mut args = vec![0u8; 64];
    args.push(0); // recovery_id
    args.extend_from_slice(&value);
    instruction(
        "reveal_randomness",
        &args,
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new_readonly(round_key(round_id), false),
            AccountMeta::new(randomness, false),
            AccountMeta::new_readonly(oracle, false),
            AccountMeta::new_readonly(queue, false),
            AccountMeta::new(stats, false),
            AccountMeta::new(crank, true),
            AccountMeta::new_readonly(solana_sdk::sysvar::slot_hashes::ID, false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            AccountMeta::new(Pubkey::new_unique(), false), // reward escrow
            AccountMeta::new_readonly(
                solana_sdk::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
                false,
            ),
            AccountMeta::new_readonly(Pubkey::new_unique(), false), // wrapped SOL mint
            AccountMeta::new_readonly(program_state, false),
            AccountMeta::new_readonly(switchboard_program, false),
        ],
    )
}

/// `create_randomness`: the round PDA signs the `randomness_init` CPI with
/// the fresh account keypair signing the transaction.
#[allow(clippy::too_many_arguments)]
fn create_randomness_ix(
    round_id: u64,
    randomness: Pubkey,
    queue: Pubkey,
    payer: Pubkey,
    program_state: Pubkey,
    lut_signer: Pubkey,
    switchboard_program: Pubkey,
    recent_slot: u64,
) -> Instruction {
    instruction(
        "create_randomness",
        &recent_slot.to_le_bytes(),
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new_readonly(round_key(round_id), false),
            AccountMeta::new(randomness, true),
            // Writable: the live `randomness_init` metas carry the queue
            // writable (probed) — the CPI would escalate otherwise.
            AccountMeta::new(queue, false),
            AccountMeta::new(payer, true),
            AccountMeta::new(Pubkey::new_unique(), false), // reward escrow
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            AccountMeta::new_readonly(
                solana_sdk::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
                false,
            ),
            AccountMeta::new_readonly(
                solana_sdk::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
                false,
            ),
            AccountMeta::new_readonly(Pubkey::new_unique(), false), // wrapped SOL mint
            AccountMeta::new_readonly(program_state, false),
            AccountMeta::new_readonly(lut_signer, false),
            AccountMeta::new(Pubkey::new_unique(), false), // lut
            AccountMeta::new_readonly(
                solana_sdk::pubkey!("AddressLookupTab1e1111111111111111111111111"),
                false,
            ),
            AccountMeta::new_readonly(switchboard_program, false),
        ],
    )
}

fn fulfill_settle_ix(round_id: u64, randomness: Pubkey, crank: Pubkey) -> Instruction {
    instruction(
        "fulfill_settle",
        &[],
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new(round_key(round_id), false),
            AccountMeta::new(round_vault_key(round_id), false),
            AccountMeta::new(treasury_key(), false),
            AccountMeta::new(mega_pot_key(), false),
            AccountMeta::new(randomness, false),
            AccountMeta::new(crank, true),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
            // Appended by #[event_cpi] on the context.
            AccountMeta::new_readonly(event_authority_key(), false),
            AccountMeta::new_readonly(PROGRAM_ID, false),
        ],
    )
}

/// `close_randomness`: once a round is terminal, the round PDA signs the
/// Switchboard `randomness_close` CPI; the reclaimed rent lands in the
/// round account. `program_state` must be owned by the oracle program.
fn close_randomness_ix(
    round_id: u64,
    randomness: Pubkey,
    program_state: Pubkey,
    switchboard_program: Pubkey,
    crank: Pubkey,
) -> Instruction {
    instruction(
        "close_randomness",
        &[],
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new(round_key(round_id), false),
            AccountMeta::new(randomness, false),
            AccountMeta::new(Pubkey::new_unique(), false), // reward escrow
            AccountMeta::new_readonly(program_state, false),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            AccountMeta::new_readonly(
                solana_sdk::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
                false,
            ),
            AccountMeta::new_readonly(Pubkey::new_unique(), false), // wrapped SOL mint
            AccountMeta::new(Pubkey::new_unique(), false),          // lut
            AccountMeta::new_readonly(Pubkey::new_unique(), false), // lut signer
            AccountMeta::new_readonly(
                solana_sdk::pubkey!("AddressLookupTab1e1111111111111111111111111"),
                false,
            ),
            AccountMeta::new_readonly(switchboard_program, false),
            AccountMeta::new_readonly(crank, true),
        ],
    )
}

fn claim_winnings_ix(
    round_id: u64,
    entry_index: u32,
    player: Pubkey,
    crank: Pubkey,
) -> Instruction {
    instruction(
        "claim_winnings",
        &entry_index.to_le_bytes(),
        vec![
            AccountMeta::new(round_key(round_id), false),
            AccountMeta::new(round_vault_key(round_id), false),
            AccountMeta::new_readonly(entry_key(round_id, entry_index), false),
            AccountMeta::new(player, false),
            AccountMeta::new_readonly(crank, true),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
            AccountMeta::new_readonly(event_authority_key(), false),
            AccountMeta::new_readonly(PROGRAM_ID, false),
        ],
    )
}

fn admin_sweep_fees_ix(authority: Pubkey, destination: Pubkey) -> Instruction {
    instruction(
        "admin_sweep_fees",
        &[],
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new(treasury_key(), false),
            AccountMeta::new_readonly(authority, true),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
        ],
    )
}

fn update_config_ix(admin: Pubkey, args: &UpdateConfigArgs) -> Instruction {
    use borsh::BorshSerialize;
    let mut data = Vec::new();
    args.serialize(&mut data).expect("borsh args in test");
    instruction(
        "update_config",
        &data,
        vec![
            AccountMeta::new(config_key(), false),
            AccountMeta::new_readonly(admin, true),
        ],
    )
}

fn transfer_admin_ix(admin: Pubkey, new_admin: Pubkey) -> Instruction {
    use borsh::BorshSerialize;
    let mut data = Vec::new();
    new_admin.serialize(&mut data).expect("borsh in test");
    instruction(
        "transfer_admin",
        &data,
        vec![
            AccountMeta::new(config_key(), false),
            AccountMeta::new_readonly(admin, true),
        ],
    )
}

fn accept_admin_ix(pending: Pubkey) -> Instruction {
    instruction(
        "accept_admin",
        &[],
        vec![
            AccountMeta::new(config_key(), false),
            AccountMeta::new_readonly(pending, true),
        ],
    )
}

/// `cancel_round` with the round's pinned randomness account (AUDIT P-1).
fn cancel_round_ix(round_id: u64, crank: Pubkey) -> Instruction {
    cancel_round_with_randomness_ix(round_id, round_randomness_key(round_id), crank)
}

fn sweep_unclaimed_prize_ix(round_id: u64, crank: Pubkey) -> Instruction {
    instruction(
        "sweep_unclaimed_prize",
        &[],
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new(round_key(round_id), false),
            AccountMeta::new(round_vault_key(round_id), false),
            AccountMeta::new(mega_pot_key(), false),
            AccountMeta::new_readonly(crank, true),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
        ],
    )
}

fn close_entry_ix(round_id: u64, entry_index: u32, player: Pubkey, crank: Pubkey) -> Instruction {
    instruction(
        "close_entry",
        &entry_index.to_le_bytes(),
        vec![
            AccountMeta::new(round_key(round_id), false),
            AccountMeta::new(round_vault_key(round_id), false),
            AccountMeta::new(entry_key(round_id, entry_index), false),
            AccountMeta::new(player, false),
            AccountMeta::new_readonly(crank, true),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
        ],
    )
}

fn close_round_ix(round_id: u64, destination: Pubkey, crank: Pubkey) -> Instruction {
    instruction(
        "close_round",
        &[],
        vec![
            AccountMeta::new(config_key(), false),
            AccountMeta::new(round_key(round_id), false),
            AccountMeta::new(round_vault_key(round_id), false),
            AccountMeta::new(mega_pot_key(), false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(crank, true),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
        ],
    )
}

/// `migrate_economics_v2(MigrateEconomicsV2Args)` — borsh args: seven
/// fixed-width fields (u16, u16, u16, u16, u32, u32, u64) = 22 bytes.
#[allow(clippy::too_many_arguments)] // one flat args tuple, exactly the on-chain shape
fn migrate_economics_v2_ix(
    admin: Pubkey,
    winner_bps: u16,
    refund_bps: u16,
    mega_award_bps: u16,
    mega_field_bps: u16,
    mega_trigger_modulus: u32,
    mega_payout_cap_bps: u32,
    account_open_fee_lamports: u64,
) -> Instruction {
    let mut args = Vec::with_capacity(22);
    args.extend_from_slice(&winner_bps.to_le_bytes());
    args.extend_from_slice(&refund_bps.to_le_bytes());
    args.extend_from_slice(&mega_award_bps.to_le_bytes());
    args.extend_from_slice(&mega_field_bps.to_le_bytes());
    args.extend_from_slice(&mega_trigger_modulus.to_le_bytes());
    args.extend_from_slice(&mega_payout_cap_bps.to_le_bytes());
    args.extend_from_slice(&account_open_fee_lamports.to_le_bytes());
    instruction(
        "migrate_economics_v2",
        &args,
        vec![
            AccountMeta::new(config_key(), false),
            AccountMeta::new_readonly(mega_pot_key(), false),
            AccountMeta::new_readonly(admin, true),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
        ],
    )
}

/// `drain_mega_pot_v1_preflight()` — no args; discriminator only. Accounts
/// in the Rust context order: config (ro), mega_pot (w), treasury (w),
/// admin signer, rent.
fn drain_mega_pot_v1_preflight_ix(admin: Pubkey) -> Instruction {
    instruction(
        "drain_mega_pot_v1_preflight",
        &[],
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new(mega_pot_key(), false),
            AccountMeta::new(treasury_key(), false),
            AccountMeta::new_readonly(admin, true),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
        ],
    )
}

fn toggle_pause_ix(admin: Pubkey) -> Instruction {
    instruction(
        "toggle_pause",
        &[],
        vec![
            AccountMeta::new(config_key(), false),
            AccountMeta::new_readonly(admin, true),
        ],
    )
}

fn refund_entry_ix(round_id: u64, entry_index: u32, player: Pubkey, crank: Pubkey) -> Instruction {
    instruction(
        "refund_entry",
        &entry_index.to_le_bytes(),
        vec![
            AccountMeta::new(round_key(round_id), false),
            AccountMeta::new(round_vault_key(round_id), false),
            AccountMeta::new(entry_key(round_id, entry_index), false),
            AccountMeta::new(player, false),
            AccountMeta::new_readonly(crank, true),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
        ],
    )
}

// ─── Phase 10: escrow auto-deposit instruction encoding ────────────────────

/// `init_or_deposit_escrow(amount, per_round_lamports, max_rounds,
/// auto_reinvest)` — sighash ++ borsh (u64, u64, u32, bool), 21 bytes.
fn init_or_deposit_escrow_ix(
    owner: Pubkey,
    amount: u64,
    per_round_lamports: u64,
    max_rounds: u32,
    auto_reinvest: bool,
) -> Instruction {
    let mut args = Vec::with_capacity(21);
    args.extend_from_slice(&amount.to_le_bytes());
    args.extend_from_slice(&per_round_lamports.to_le_bytes());
    args.extend_from_slice(&max_rounds.to_le_bytes());
    args.push(u8::from(auto_reinvest));
    instruction(
        "init_or_deposit_escrow",
        &args,
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new(escrow_key(owner), false),
            AccountMeta::new(mega_pot_key(), false),
            AccountMeta::new(owner, true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
        ],
    )
}

fn withdraw_escrow_ix(owner: Pubkey, amount: u64) -> Instruction {
    instruction(
        "withdraw_escrow",
        &amount.to_le_bytes(),
        vec![
            AccountMeta::new(escrow_key(owner), false),
            AccountMeta::new(owner, true),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
        ],
    )
}

/// `crank_auto_deposit(round_id)` — entry index rides the PDA seed exactly
/// as in `deposit`; `crank` is signer AND writable (it pays the entry
/// `init`, reimbursed inside the instruction).
fn crank_auto_deposit_ix(
    round_id: u64,
    entry_index: u32,
    escrow: Pubkey,
    crank: Pubkey,
) -> Instruction {
    instruction(
        "crank_auto_deposit",
        &round_id.to_le_bytes(),
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new(round_key(round_id), false),
            AccountMeta::new(entry_key(round_id, entry_index), false),
            AccountMeta::new(round_vault_key(round_id), false),
            AccountMeta::new(escrow, false),
            AccountMeta::new(crank, true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
        ],
    )
}

// ─── Switchboard mock (roadmap 0.4) ───────────────────────────────────────

/// Builds a byte-exact `RandomnessAccountData` layout (repr(C), 8-byte
/// Switchboard discriminator, then authority/queue/seed_slothash/seed_slot/
/// oracle/reveal_slot/value/ebufs, all little-endian) so the program's real
/// parser accepts it. Total data length: 408 bytes.
fn mock_randomness_account(owner: Pubkey, authority: Pubkey, value: [u8; 32]) -> Account {
    mock_randomness_with_slots(owner, authority, value, MOCK_SEED_SLOT, MOCK_SEED_SLOT)
}

/// The full-control variant used by the adversarial battery (stale commits,
/// forged authorities, spoofed keys — all distinguished by their slots and
/// keys, exactly as on-chain).
fn mock_randomness_with_slots(
    owner: Pubkey,
    authority: Pubkey,
    value: [u8; 32],
    seed_slot: u64,
    reveal_slot: u64,
) -> Account {
    let mut data = Vec::with_capacity(408);
    data.extend_from_slice(&[10, 66, 229, 135, 220, 239, 217, 114]); // discriminator
    data.extend_from_slice(authority.as_ref());
    data.extend_from_slice(Pubkey::default().as_ref()); // queue
    data.extend_from_slice(&[0u8; 32]); // seed_slothash
    data.extend_from_slice(&seed_slot.to_le_bytes());
    data.extend_from_slice(Pubkey::default().as_ref()); // oracle
    data.extend_from_slice(&reveal_slot.to_le_bytes()); // > 0 ⇒ revealed
    data.extend_from_slice(&value);
    data.extend_from_slice(&[0u8; 96]); // _ebuf2
    data.extend_from_slice(&[0u8; 128]); // _ebuf1
    Account {
        lamports: 100 * SOL,
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    }
}

/// Assembles the 32-byte randomness value from its two entropy halves,
/// mirroring `split_entropy` (little-endian, `[0..16]` ticket, `[16..32]` mega).
fn mock_value(ticket_seed: u128, mega_seed: u128) -> [u8; 32] {
    let mut value = [0u8; 32];
    value[..16].copy_from_slice(&ticket_seed.to_le_bytes());
    value[16..].copy_from_slice(&mega_seed.to_le_bytes());
    value
}

/// An unrevealed randomness mock (`seed_slot == reveal_slot == 0`): what a
/// crank-created Switchboard account looks like before `commit_randomness`.
fn mock_randomness_unrevealed(owner: Pubkey, authority: Pubkey) -> Account {
    mock_randomness_with_slots(owner, authority, [0u8; 32], 0, 0)
}

// ─── fake Switchboard On-Demand (the commit-transport double) ──────────────

/// Native builtins emulating the LIVE two-phase randomness protocol
/// (probed from the devnet program's own IDL):
/// - `Commit` (authority SIGNS — our program's CPI): seeds the account —
///   seed_slothash, `seed_slot`, oracle assignment — but does NOT reveal.
/// - `Reveal` (authority NOT a signer — any crank submits directly, with
///   the oracle-gateway payload as args): writes `value` + `reveal_slot`.
///
/// Registered at the per-boot fake oracle program id so both paths execute
/// with the real account order, discriminators, and PDA signing; only the
/// TEE is simulated. The commit's seed value is deterministic —
/// `H(authority ‖ oracle ‖ slot)` — and the reveal writes the value it is
/// handed, so tests recompute outcomes from the committed account bytes.
mod fake_switchboard {
    use solana_program_runtime::declare_process_instruction;
    use solana_sdk::hash::hashv;
    use solana_sdk::instruction::InstructionError;

    // One builtin = one process fn: dispatch on the instruction discriminator.
    declare_process_instruction!(FakeSwitchboard, 2_000, |invoke_context| {
        // sha256("global:randomness_init")[..8] — probed live.
        const INIT_DISC: [u8; 8] = [0x09, 0x09, 0xcc, 0x21, 0x32, 0x74, 0x71, 0x0f];
        // sha256("global:randomness_commit")[..8] (switchboard-on-demand 0.13)
        const COMMIT_DISC: [u8; 8] = [52, 170, 152, 201, 179, 133, 242, 141];
        // sha256("global:randomness_reveal")[..8] (probed from the devnet IDL)
        const REVEAL_DISC: [u8; 8] = [0xc5, 0xb5, 0xbb, 0x0a, 0x1e, 0x3a, 0x14, 0x49];
        // sha256("global:randomness_close")[..8] (simulated live 2026-10-08)
        const CLOSE_DISC: [u8; 8] = [0x92, 0x65, 0x0e, 0x4a, 0xe1, 0xf6, 0x00, 0x9c];
        let transaction_context = &invoke_context.transaction_context;
        let instruction_context = transaction_context.get_current_instruction_context()?;
        let data = instruction_context.get_instruction_data();
        if data.len() == 16 && data[..8] == INIT_DISC {
            init(transaction_context, instruction_context)
        } else if data.len() >= 8 && data[..8] == COMMIT_DISC {
            commit(invoke_context, transaction_context, instruction_context)
        } else if data.len() == 8 + 97 && data[..8] == REVEAL_DISC {
            reveal(
                invoke_context,
                transaction_context,
                instruction_context,
                data,
            )
        } else if data.len() == 8 && data[..8] == CLOSE_DISC {
            close(transaction_context, instruction_context)
        } else {
            Err(InstructionError::InvalidInstructionData)
        }
    });

    /// `randomness_close` — the stored AUTHORITY must sign (the round PDA,
    /// through our program). Mirrors the live effect that matters: the
    /// randomness account's lamports go to the authority and the account
    /// is emptied. Order: randomness, rewardEscrow, authority, programState,
    /// system, token, wSOL mint, lut, lutSigner, ALT program.
    fn close(
        transaction_context: &solana_transaction_context::TransactionContext,
        instruction_context: &solana_transaction_context::InstructionContext,
    ) -> Result<(), InstructionError> {
        let authority_key = {
            let authority =
                instruction_context.try_borrow_instruction_account(transaction_context, 2)?;
            if !authority.is_signer() || !authority.is_writable() {
                return Err(InstructionError::MissingRequiredSignature);
            }
            *authority.get_key()
        };
        let reclaimed = {
            let mut randomness =
                instruction_context.try_borrow_instruction_account(transaction_context, 0)?;
            if randomness.get_data().len() < 40 || randomness.get_data()[8..40] != authority_key.to_bytes() {
                return Err(InstructionError::InvalidAccountData);
            }
            let lamports = randomness.get_lamports();
            randomness.set_lamports(0)?;
            randomness.set_data_length(0)?;
            lamports
        };
        let mut authority =
            instruction_context.try_borrow_instruction_account(transaction_context, 2)?;
        authority.checked_add_lamports(reclaimed)?;
        Ok(())
    }

    /// `randomness_init` — the deployed program requires the AUTHORITY's
    /// signature (probed live: error 3010 AccountNotSigner); account order
    /// probed: randomness, rewardEscrow, authority, queue, payer, programs…
    fn init(
        transaction_context: &solana_transaction_context::TransactionContext,
        instruction_context: &solana_transaction_context::InstructionContext,
    ) -> Result<(), InstructionError> {
        {
            let authority =
                instruction_context.try_borrow_instruction_account(transaction_context, 2)?;
            if !authority.is_signer() {
                return Err(InstructionError::MissingRequiredSignature);
            }
        }
        {
            let randomness =
                instruction_context.try_borrow_instruction_account(transaction_context, 0)?;
            if !randomness.is_signer() {
                return Err(InstructionError::MissingRequiredSignature);
            }
        }
        let authority_key = *instruction_context
            .try_borrow_instruction_account(transaction_context, 2)?
            .get_key();
        let queue_key = *instruction_context
            .try_borrow_instruction_account(transaction_context, 3)?
            .get_key();
        let mut randomness =
            instruction_context.try_borrow_instruction_account(transaction_context, 0)?;
        let data = randomness.get_data_mut()?;
        // Write the account: authority + queue (the discriminator and the
        // 408-byte layout already sit in the genesis-seeded mock).
        data[8..40].copy_from_slice(authority_key.as_ref());
        data[40..72].copy_from_slice(queue_key.as_ref());
        Ok(())
    }

    /// `randomness_commit` — authority SIGNS (our program's CPI): seeds
    /// seed_slothash, `seed_slot` (next slot, as live), oracle assignment.
    /// Does NOT reveal — reveal is a separate crank-submitted instruction.
    fn commit(
        invoke_context: &solana_program_runtime::invoke_context::InvokeContext,
        transaction_context: &solana_transaction_context::TransactionContext,
        instruction_context: &solana_transaction_context::InstructionContext,
    ) -> Result<(), InstructionError> {
        // Account order mirrors the real instruction: randomness, queue,
        // oracle, recent_slothashes, authority(signer).
        let authority_key = {
            let authority =
                instruction_context.try_borrow_instruction_account(transaction_context, 4)?;
            if !authority.is_signer() {
                return Err(InstructionError::MissingRequiredSignature);
            }
            *authority.get_key()
        };
        let oracle_key = *instruction_context
            .try_borrow_instruction_account(transaction_context, 2)?
            .get_key();
        let slot = invoke_context.get_sysvar_cache().get_clock()?.slot;
        // The live commit seeds with the NEXT slot's slothash.
        let seed_slot = slot + 1;
        let seed_slothash = hashv(&[
            authority_key.as_ref(),
            oracle_key.as_ref(),
            &seed_slot.to_le_bytes(),
        ]);
        let mut randomness =
            instruction_context.try_borrow_instruction_account(transaction_context, 0)?;
        let data = randomness.get_data_mut()?;
        // RandomnessAccountData (repr(C)): disc 8 ‖ authority 32 ‖ queue 32 ‖
        // seed_slothash 32 ‖ seed_slot 8 ‖ oracle 32 ‖ reveal_slot 8 ‖ value 32.
        data[72..104].copy_from_slice(seed_slothash.as_ref());
        data[104..112].copy_from_slice(&seed_slot.to_le_bytes());
        data[112..144].copy_from_slice(oracle_key.as_ref());
        // reveal_slot and value stay ZERO until the reveal.
        Ok(())
    }

    /// `randomness_reveal` — the authority is NOT a signer live; any crank
    /// submits with the oracle-gateway payload as args. Writes value +
    /// reveal_slot; data = disc ++ borsh { signature [u8;64], recoveryId
    /// u8, value [u8;32] } (all fixed-width, 97 bytes).
    fn reveal(
        invoke_context: &solana_program_runtime::invoke_context::InvokeContext,
        transaction_context: &solana_transaction_context::TransactionContext,
        instruction_context: &solana_transaction_context::InstructionContext,
        data: &[u8],
    ) -> Result<(), InstructionError> {
        // Account order: randomness, oracle, queue, stats, authority (NOT a
        // signer live), payer, slothashes, … — only randomness is written.
        let slot = invoke_context.get_sysvar_cache().get_clock()?.slot;
        let mut randomness =
            instruction_context.try_borrow_instruction_account(transaction_context, 0)?;
        let account = randomness.get_data_mut()?;
        account[144..152].copy_from_slice(&slot.to_le_bytes()); // reveal_slot
        account[152..184].copy_from_slice(&data[8 + 65..8 + 65 + 32]); // value
        Ok(())
    }
}

// ─── harness ──────────────────────────────────────────────────────────────

struct Env {
    banks: solana_program_test::BanksClient,
    payer: Keypair,
    admin: Keypair,
    context: ProgramTestContext,
    oracle_id: Pubkey,
    /// The fake queue account key (owned by `oracle_id`), pinned in config.
    queue_id: Pubkey,
    /// The fake queue-oracle account key (owned by `oracle_id`), passed to
    /// the commit CPI.
    oracle_key: Pubkey,
    players: Vec<Keypair>,
    /// Pays for the automatic `close_randomness` before a `close_round`
    /// (AUDIT P-4), so no balance a test asserts on moves by its fee.
    reclaimer: Keypair,
    /// Lamports the last automatic reclaim moved into the round account
    /// (they leave with `close_round` to the round's opener).
    last_reclaimed: u64,
}

impl Env {
    /// Boots a fresh runtime and runs `initialize` (fresh singletons).
    async fn setup(players: usize, value: [u8; 32]) -> Self {
        let mut env = Self::boot(players, value, Vec::new(), Pubkey::new_unique()).await;
        let mut args = default_args();
        args.oracle_program_id = env.oracle_id;
        args.oracle_queue = env.queue_id;
        args.treasury_authority = env.payer.pubkey();
        let admin = env.admin.insecure_clone();
        env.send(initialize_ix(&admin, &args), &[&admin]).await;
        env
    }

    /// Setup with an overridden claim deadline — the sweep gate reads
    /// `config.claim_deadline_secs`, so a short deadline exercises the exact
    /// production logic without a multi-million-slot warp (program-test
    /// fills every tick between slots, so 30 real days would take minutes).
    async fn setup_short_claim_deadline(players: usize, value: [u8; 32]) -> Self {
        let mut env = Self::boot(players, value, Vec::new(), Pubkey::new_unique()).await;
        let mut args = default_args();
        args.oracle_program_id = env.oracle_id;
        args.oracle_queue = env.queue_id;
        args.treasury_authority = env.payer.pubkey();
        args.claim_deadline_secs = ROUND_DURATION_SECS + 10;
        let admin = env.admin.insecure_clone();
        env.send(initialize_ix(&admin, &args), &[&admin]).await;
        env
    }

    /// Setup with round 0's randomness account UNREVEALED at `mock_key`
    /// (authority = round 0 PDA): the full live pipeline — lock → pin →
    /// COMMIT via the fake oracle builtin → settle on the committed value.
    async fn setup_commit_flow(players: usize, mock_key: Pubkey) -> Self {
        let oracle_id = Pubkey::new_unique();
        let extra = vec![(
            mock_key,
            mock_randomness_unrevealed(oracle_id, round_key(0)),
        )];
        let mut env = Self::boot(players, [0u8; 32], extra, oracle_id).await;
        let mut args = default_args();
        args.oracle_program_id = oracle_id;
        args.oracle_queue = env.queue_id;
        args.treasury_authority = env.payer.pubkey();
        let admin = env.admin.insecure_clone();
        env.send(initialize_ix(&admin, &args), &[&admin]).await;
        env
    }

    /// The CREATE-pipeline variant: the randomness account is a FRESH
    /// keypair with NO authority yet (exactly what a crank generates
    /// live); `create_randomness`'s CPI writes the round PDA in. Also
    /// seeds the oracle-program-owned program_state and lut_signer
    /// accounts the create context owner-constrains.
    async fn setup_create_flow(players: usize) -> (Self, Keypair, Pubkey, Pubkey) {
        let oracle_id = Pubkey::new_unique();
        let random_kp = Keypair::new();
        let program_state = Pubkey::new_unique();
        let lut_signer = Pubkey::new_unique();
        let mut extra = vec![(
            random_kp.pubkey(),
            mock_randomness_unrevealed(oracle_id, Pubkey::default()),
        )];
        for key in [program_state, lut_signer] {
            extra.push((
                key,
                Account {
                    lamports: 1_000_000,
                    data: vec![0u8; 128],
                    owner: oracle_id,
                    executable: false,
                    rent_epoch: 0,
                },
            ));
        }
        let mut env = Self::boot(players, [0u8; 32], extra, oracle_id).await;
        let mut args = default_args();
        args.oracle_program_id = oracle_id;
        args.oracle_queue = env.queue_id;
        args.treasury_authority = env.payer.pubkey();
        let admin = env.admin.insecure_clone();
        env.send(initialize_ix(&admin, &args), &[&admin]).await;
        (env, random_kp, program_state, lut_signer)
    }

    /// Boots a fresh runtime with the SBF program, funded players, a
    /// fabricated randomness account owned by a fake oracle id, and any
    /// extra genesis accounts (mid-test `set_account` trips the bank's
    /// accounts-hash verification, so pre-seeded state must be crafted at
    /// genesis time).
    async fn boot(
        players: usize,
        value: [u8; 32],
        extra: Vec<(Pubkey, Account)>,
        oracle_id: Pubkey,
    ) -> Self {
        let so_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/deploy/orbit_jackpot.so");
        let program_bytes = std::fs::read(&so_path).unwrap_or_else(|_| {
            panic!(
                "orbit_jackpot.so missing at {} — run `cargo build-sbf` first",
                so_path.display()
            )
        });
        // Register the ELF as an executable bpf_loader account — what
        // `add_program`'s internal `add_bpf` does, without its
        // cwd-dependent file discovery.
        let mut pt = ProgramTest::default();
        pt.add_account(
            PROGRAM_ID,
            Account {
                lamports: solana_sdk::rent::Rent::default()
                    .minimum_balance(program_bytes.len())
                    .max(1),
                data: program_bytes,
                owner: solana_sdk::bpf_loader::id(),
                executable: true,
                rent_epoch: 0,
            },
        );
        // The fake Switchboard On-Demand oracle program: a native builtin
        // registered at `oracle_id`, emulating `randomness_commit` (writes
        // the reveal, checks the authority signature). Its queue and oracle
        // accounts are seeded at genesis, owned by the fake program exactly
        // as the real ones are owned by the switchboard program.
        let queue_id = Pubkey::new_unique();
        let oracle_key = Pubkey::new_unique();
        pt.add_builtin_program(
            "fake_switchboard",
            oracle_id,
            fake_switchboard::FakeSwitchboard::vm,
        );
        for key in [queue_id, oracle_key] {
            pt.add_account(
                key,
                Account {
                    lamports: 1_000_000,
                    data: vec![0u8; 128],
                    owner: oracle_id,
                    executable: false,
                    rent_epoch: 0,
                },
            );
        }
        // Round 0's randomness mock, pre-seeded: authority = round 0 PDA.
        pt.add_account(
            round_randomness_key(0),
            mock_randomness_account(oracle_id, round_key(0), value),
        );
        let player_keys: Vec<Keypair> = (0..players).map(|_| Keypair::new()).collect();
        let admin = Keypair::new();
        let reclaimer = Keypair::new();
        pt.add_account(
            reclaimer.pubkey(),
            Account {
                lamports: 10 * SOL,
                data: Vec::new(),
                owner: solana_sdk::system_program::ID,
                executable: false,
                rent_epoch: 0,
            },
        );
        pt.add_account(
            admin.pubkey(),
            Account {
                lamports: 1_000 * SOL,
                data: Vec::new(),
                owner: solana_sdk::system_program::ID,
                executable: false,
                rent_epoch: 0,
            },
        );
        for player in &player_keys {
            pt.add_account(
                player.pubkey(),
                Account {
                    lamports: 1_000 * SOL,
                    data: Vec::new(),
                    owner: solana_sdk::system_program::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            );
        }
        for (key, account) in extra {
            pt.add_account(key, account);
        }

        let context = pt.start_with_context().await;
        Env {
            banks: context.banks_client.clone(),
            payer: context.payer.insecure_clone(),
            admin,
            context,
            oracle_id,
            queue_id,
            oracle_key,
            players: player_keys,
            reclaimer,
            last_reclaimed: 0,
        }
    }

    /// AUDIT P-4: `close_round` requires the round's Switchboard accounts
    /// reclaimed first — the crank's order. A test about something else
    /// gets that step done for it (paid by `reclaimer`); the reclaimed rent
    /// lands in the round account and rides `close_round` to its opener.
    /// Tests that exercise the ordering itself use `send_raw`.
    async fn reclaim_before_close(&mut self, ix: &Instruction) {
        if ix.program_id != PROGRAM_ID || ix.data.len() < 8 || ix.data[..8] != sighash("close_round") {
            return;
        }
        let Some(account) = self.account(ix.accounts[1].pubkey).await else { return };
        let round = Round::deserialize(&mut &account.data[8..]).expect("round decode");
        if round.randomness_account == Pubkey::default()
            || !matches!(round.state, RoundState::Settled | RoundState::Cancelled)
        {
            return;
        }
        self.last_reclaimed = self
            .account(round.randomness_account)
            .await
            .map(|a| a.lamports)
            .unwrap_or(0);
        let reclaim = close_randomness_ix(
            round.round_id,
            round.randomness_account,
            self.queue_id,
            self.oracle_id,
            self.reclaimer.pubkey(),
        );
        let mut tx = Transaction::new_with_payer(&[reclaim], Some(&self.reclaimer.pubkey()));
        let blockhash = self.banks.get_latest_blockhash().await.expect("blockhash");
        tx.sign(&[&self.reclaimer], blockhash);
        self.banks
            .process_transaction_with_preflight(tx)
            .await
            .expect("close_randomness before close_round");
    }

    /// `send` without the automatic P-4 reclaim.
    async fn send_raw_fails_with(&mut self, ix: Instruction, code: &str) {
        let mut tx = Transaction::new_with_payer(&[ix], Some(&self.payer.pubkey()));
        let blockhash = self.banks.get_latest_blockhash().await.expect("blockhash");
        tx.sign(&[&self.payer], blockhash);
        let err = self
            .banks
            .process_transaction_with_preflight(tx)
            .await
            .expect_err("transaction was expected to fail");
        let dump = format!("{err:?}");
        assert!(dump.contains(&format!("Error Code: {code}.")), "expected error {code}, got: {dump}");
    }

    /// Boots with all three singletons pre-crafted (no `initialize`, which
    /// would collide with existing accounts) and the Mega-Pot seeded.
    /// Layouts are borsh-serialized with canonical bumps, exactly as the
    /// program itself would write them. The crafted `admin` is a fresh,
    /// genesis-funded keypair — returned so `close_round` (whose
    /// destination is constrained to `config.admin`) can be exercised.
    async fn setup_seeded_mega(
        players: usize,
        value: [u8; 32],
        mega_lamports: u64,
    ) -> (Self, Keypair) {
        use borsh::BorshSerialize;
        let oracle_id = Pubkey::new_unique();
        let rent = solana_sdk::rent::Rent::default();

        let mut args = default_args();
        args.oracle_program_id = oracle_id;

        let admin = Keypair::new();
        let config_bump = Pubkey::find_program_address(&[b"config"], &PROGRAM_ID).1;
        let config = GlobalConfig {
            admin: admin.pubkey(),
            pending_admin: None,
            treasury_authority: Pubkey::new_unique(),
            oracle_program_id: args.oracle_program_id,
            oracle_queue: Pubkey::new_unique(),
            fee_bps_admin: 100,
            fee_bps_mega: 100,
            winner_bps: 9_800,
            mega_award_bps: 9_000,
            mega_trigger_modulus: 6_767,
            max_entries_per_round: args.max_entries_per_round,
            round_duration_secs: args.round_duration_secs,
            max_round_duration_secs: args.max_round_duration_secs,
            anti_snipe_window_secs: args.anti_snipe_window_secs,
            anti_snipe_extension_secs: args.anti_snipe_extension_secs,
            claim_deadline_secs: args.claim_deadline_secs,
            min_deposit_lamports: args.min_deposit_lamports,
            anti_snipe_min_deposit_lamports: args.anti_snipe_min_deposit_lamports,
            keeper_tip_lamports: args.keeper_tip_lamports,
            randomness_reveal_deadline_slots: args.randomness_reveal_deadline_slots,
            active_round_id: 0,
            next_round_id: 0,
            oracle_provider: OracleProvider::Switchboard,
            paused: false,
            bump: config_bump,
            auto_deposit_window_secs: 0,
            auto_deposit_tip_lamports: 0,
            auto_deposit_enabled: false,
            // Phase 11 fields zeroed: this crafted config reproduces the
            // deployed v1 economics (R6) — refund 0, uncapped mega award.
            refund_bps: 0,
            mega_field_bps: 0,
            mega_payout_cap_bps: 0,
            account_open_fee_lamports: 0,
            economics_version: 0,
            reserved: [0; 30],
        };
        let mut config_data = anchor_account_disc("GlobalConfig");
        config.serialize(&mut config_data).expect("config encode");

        let treasury_bump = Pubkey::find_program_address(&[b"treasury"], &PROGRAM_ID).1;
        let treasury = TreasuryVault {
            accrued_lamports: 0,
            lifetime_accrued: 0,
            lifetime_swept: 0,
            bump: treasury_bump,
            reserved: [0; 32],
        };
        let mut treasury_data = anchor_account_disc("TreasuryVault");
        treasury
            .serialize(&mut treasury_data)
            .expect("treasury encode");

        let mega_bump = Pubkey::find_program_address(&[b"mega_pot"], &PROGRAM_ID).1;
        let mega = MegaPotVault {
            accrued_lamports: mega_lamports,
            lifetime_contributed: mega_lamports,
            lifetime_awarded: 0,
            trigger_count: 0,
            last_trigger_round_id: 0,
            cycle_index: 0,
            bump: mega_bump,
            reserved: [0; 32],
        };
        let mut mega_data = anchor_account_disc("MegaPotVault");
        mega.serialize(&mut mega_data).expect("mega encode");

        let owned = |data: Vec<u8>, extra_lamports: u64| Account {
            lamports: rent
                .minimum_balance(data.len())
                .checked_add(extra_lamports)
                .expect("seed lamports"),
            data,
            owner: PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        };
        let extra = vec![
            (config_key(), owned(config_data, 0)),
            (treasury_key(), owned(treasury_data, 0)),
            (mega_pot_key(), owned(mega_data, mega_lamports)),
            (
                admin.pubkey(),
                Account {
                    lamports: 1_000 * SOL,
                    data: Vec::new(),
                    owner: solana_sdk::system_program::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            ),
        ];
        let env = Self::boot(players, value, extra, oracle_id).await;
        (env, admin)
    }

    /// The Phase 11 counterpart of `setup_seeded_mega`: singletons crafted
    /// with the canonical **v2** economics (9/89/1/1, 50/40/10 mega split,
    /// 1-in-625, 80_000 bps cap) and the Mega-Pot seeded — the harness for
    /// triggered-round tests, where the accrual must predate the round.
    async fn setup_seeded_mega_v2(
        players: usize,
        value: [u8; 32],
        mega_lamports: u64,
    ) -> (Self, Keypair) {
        use borsh::BorshSerialize;
        let oracle_id = Pubkey::new_unique();
        let rent = solana_sdk::rent::Rent::default();

        let mut args = default_args();
        args.oracle_program_id = oracle_id;

        let admin = Keypair::new();
        let config_bump = Pubkey::find_program_address(&[b"config"], &PROGRAM_ID).1;
        let config = GlobalConfig {
            admin: admin.pubkey(),
            pending_admin: None,
            treasury_authority: Pubkey::new_unique(),
            oracle_program_id: args.oracle_program_id,
            oracle_queue: Pubkey::new_unique(),
            fee_bps_admin: 100,
            fee_bps_mega: 100,
            winner_bps: 900,
            refund_bps: 8_900,
            mega_award_bps: 5_000,
            mega_field_bps: 4_000,
            mega_trigger_modulus: 625,
            mega_payout_cap_bps: 80_000,
            account_open_fee_lamports: 0,
            economics_version: 2,
            max_entries_per_round: args.max_entries_per_round,
            round_duration_secs: args.round_duration_secs,
            max_round_duration_secs: args.max_round_duration_secs,
            anti_snipe_window_secs: args.anti_snipe_window_secs,
            anti_snipe_extension_secs: args.anti_snipe_extension_secs,
            claim_deadline_secs: args.claim_deadline_secs,
            min_deposit_lamports: args.min_deposit_lamports,
            anti_snipe_min_deposit_lamports: args.anti_snipe_min_deposit_lamports,
            keeper_tip_lamports: args.keeper_tip_lamports,
            randomness_reveal_deadline_slots: args.randomness_reveal_deadline_slots,
            active_round_id: 0,
            next_round_id: 0,
            oracle_provider: OracleProvider::Switchboard,
            paused: false,
            bump: config_bump,
            auto_deposit_window_secs: 0,
            auto_deposit_tip_lamports: 0,
            auto_deposit_enabled: false,
            reserved: [0; 30],
        };
        let mut config_data = anchor_account_disc("GlobalConfig");
        config.serialize(&mut config_data).expect("config encode");

        let treasury_bump = Pubkey::find_program_address(&[b"treasury"], &PROGRAM_ID).1;
        let mut treasury_data = anchor_account_disc("TreasuryVault");
        TreasuryVault {
            accrued_lamports: 0,
            lifetime_accrued: 0,
            lifetime_swept: 0,
            bump: treasury_bump,
            reserved: [0; 32],
        }
        .serialize(&mut treasury_data)
        .expect("treasury encode");

        let mega_bump = Pubkey::find_program_address(&[b"mega_pot"], &PROGRAM_ID).1;
        let mut mega_data = anchor_account_disc("MegaPotVault");
        MegaPotVault {
            accrued_lamports: mega_lamports,
            lifetime_contributed: mega_lamports,
            lifetime_awarded: 0,
            trigger_count: 0,
            last_trigger_round_id: 0,
            cycle_index: 0,
            bump: mega_bump,
            reserved: [0; 32],
        }
        .serialize(&mut mega_data)
        .expect("mega encode");

        let owned = |data: Vec<u8>, extra_lamports: u64| Account {
            lamports: rent
                .minimum_balance(data.len())
                .checked_add(extra_lamports)
                .expect("seed lamports"),
            data,
            owner: PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        };
        let extra = vec![
            (config_key(), owned(config_data, 0)),
            (treasury_key(), owned(treasury_data, 0)),
            (mega_pot_key(), owned(mega_data, mega_lamports)),
            (
                admin.pubkey(),
                Account {
                    lamports: 1_000 * SOL,
                    data: Vec::new(),
                    owner: solana_sdk::system_program::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            ),
        ];
        let env = Self::boot(players, value, extra, oracle_id).await;
        (env, admin)
    }

    async fn send(&mut self, ix: Instruction, extra_signers: &[&Keypair]) {
        self.reclaim_before_close(&ix).await;
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend(extra_signers.iter());
        let mut tx = Transaction::new_with_payer(&[ix], Some(&self.payer.pubkey()));
        let blockhash = self.banks.get_latest_blockhash().await.expect("blockhash");
        tx.sign(&signers, blockhash);
        self.banks
            .process_transaction_with_preflight(tx)
            .await
            .expect("transaction succeeded");
    }

    /// Sends a transaction that must fail with a SPECIFIC named error
    /// (roadmap 5.x: an adversarial test that accepts any error passes for
    /// the wrong reason the day a signature changes). Anchor logs
    /// `Error Code: <Name>.` — the Debug dump of SimulationError carries it.
    async fn send_fails_with(&mut self, ix: Instruction, extra_signers: &[&Keypair], code: &str) {
        self.reclaim_before_close(&ix).await;
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend(extra_signers.iter());
        let mut tx = Transaction::new_with_payer(&[ix], Some(&self.payer.pubkey()));
        let blockhash = self.banks.get_latest_blockhash().await.expect("blockhash");
        tx.sign(&signers, blockhash);
        let err = self
            .banks
            .process_transaction_with_preflight(tx)
            .await
            .expect_err("transaction was expected to fail");
        let dump = format!("{err:?}");
        assert!(
            dump.contains(&format!("Error Code: {code}.")),
            "expected error {code}, got: {dump}"
        );
    }

    async fn config(&mut self) -> GlobalConfig {
        let data = self.account(config_key()).await.expect("config").data;
        GlobalConfig::deserialize(&mut &data[8..]).expect("config decode")
    }

    /// Boot with additional oracle-owned mock randomness accounts, built by
    /// a closure that sees the (fresh) oracle program id.
    async fn setup_adv(
        players: usize,
        value: [u8; 32],
        extra_mocks: Box<dyn Fn(Pubkey) -> Vec<(Pubkey, Account)>>,
    ) -> Self {
        let oracle_id = Pubkey::new_unique();
        let extra = extra_mocks(oracle_id);
        let mut env = Self::boot(players, value, extra, oracle_id).await;
        let mut args = default_args();
        args.oracle_program_id = oracle_id;
        args.oracle_queue = env.queue_id;
        args.treasury_authority = env.payer.pubkey();
        let admin = env.admin.insecure_clone();
        env.send(initialize_ix(&admin, &args), &[&admin]).await;
        env
    }

    /// Sends a transaction that must fail (guards and refusals).
    async fn send_fails(&mut self, ix: Instruction, extra_signers: &[&Keypair]) {
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend(extra_signers.iter());
        let mut tx = Transaction::new_with_payer(&[ix], Some(&self.payer.pubkey()));
        let blockhash = self.banks.get_latest_blockhash().await.expect("blockhash");
        tx.sign(&signers, blockhash);
        assert!(
            self.banks
                .process_transaction_with_preflight(tx)
                .await
                .is_err(),
            "transaction was expected to fail"
        );
    }

    /// Warps until strictly past this round's (possibly extended) end.
    async fn advance_past_end(&mut self, round_id: u64) {
        let end_ts = self.round(round_id).await.end_ts;
        let now = self.clock().await.unix_timestamp;
        if now < end_ts {
            self.advance_seconds(end_ts - now + 1).await;
        }
    }

    async fn clock(&mut self) -> Clock {
        self.banks.get_sysvar().await.expect("clock sysvar")
    }

    /// Warps slots forward until the wall clock advances at least `secs`.
    /// Probes the timestamp-per-slot rate first so multi-month jumps (the
    /// claim deadline) need a single big warp instead of thousands.
    async fn advance_seconds(&mut self, secs: i64) {
        let start = self.clock().await;
        let target = start.unix_timestamp + secs;
        let _ = self.context.warp_to_slot(start.slot + 100);
        let probe = self.clock().await;
        let gained = probe.unix_timestamp - start.unix_timestamp;
        if gained > 0 {
            let still_needed = target - probe.unix_timestamp;
            let slots = still_needed.saturating_mul(100) / gained + 200;
            if slots > 0 {
                let _ = self.context.warp_to_slot(probe.slot + slots as u64);
            }
        }
        let mut slot = self.clock().await.slot;
        for _ in 0..100_000 {
            if self.clock().await.unix_timestamp >= target {
                return;
            }
            slot += 50;
            let _ = self.context.warp_to_slot(slot);
        }
        panic!("test clock did not advance to {target}");
    }

    async fn account(&mut self, key: Pubkey) -> Option<solana_sdk::account::Account> {
        self.banks.get_account(key).await.expect("account fetch")
    }

    async fn round(&mut self, round_id: u64) -> Round {
        let data = self.account(round_key(round_id)).await.expect("round").data;
        Round::deserialize(&mut &data[8..]).expect("round decode")
    }

    async fn entry(&mut self, round_id: u64, entry_index: u32) -> PlayerEntry {
        let data = self.entry_account(round_id, entry_index).await.data;
        PlayerEntry::deserialize(&mut &data[8..]).expect("entry decode")
    }

    async fn entry_account(
        &mut self,
        round_id: u64,
        entry_index: u32,
    ) -> solana_sdk::account::Account {
        self.account(entry_key(round_id, entry_index))
            .await
            .expect("entry exists")
    }

    async fn treasury(&mut self) -> TreasuryVault {
        let data = self.account(treasury_key()).await.expect("treasury").data;
        TreasuryVault::deserialize(&mut &data[8..]).expect("treasury decode")
    }

    async fn mega_pot(&mut self) -> MegaPotVault {
        let data = self.account(mega_pot_key()).await.expect("mega pot").data;
        MegaPotVault::deserialize(&mut &data[8..]).expect("mega decode")
    }

    async fn balance(&mut self, key: Pubkey) -> u64 {
        self.banks.get_balance(key).await.expect("balance")
    }

    async fn rent_minimum(&mut self, data_len: usize) -> u64 {
        self.banks
            .get_sysvar::<solana_sdk::rent::Rent>()
            .await
            .expect("rent sysvar")
            .minimum_balance(data_len)
    }

    /// I1: `round_vault.lamports() == rent_minimum + round.vault_owed`.
    async fn assert_round_vault_solvent(&mut self, round_id: u64) {
        let round = self.round(round_id).await;
        let vault = self
            .account(round_vault_key(round_id))
            .await
            .expect("vault");
        let rent_min = self.rent_minimum(vault.data.len()).await;
        assert_eq!(
            vault.lamports,
            rent_min.checked_add(round.vault_owed).expect("I1 sum"),
            "I1 violated: vault {} lamports, rent {rent_min}, owed {}",
            vault.lamports,
            round.vault_owed
        );
    }

    /// Runs the standard multi-player pre-lock lifecycle: open + deposits.
    async fn open_and_deposit(&mut self, amounts: &[u64]) {
        let payer = self.payer.pubkey();
        self.send(open_round_ix(payer, 0, None), &[]).await;
        for (i, &amount) in amounts.iter().enumerate() {
            let player = self.players[i].insecure_clone();
            self.send(deposit_ix(player.pubkey(), 0, i as u32, amount), &[&player])
                .await;
        }
    }

    async fn lock_request_and_settle(&mut self) {
        let payer = self.payer.pubkey();
        self.advance_seconds(ROUND_DURATION_SECS + 1).await;
        self.send(lock_round_ix(0, payer), &[]).await;
        self.send(
            request_randomness_ix(0, round_randomness_key(0), payer),
            &[],
        )
        .await;
        self.send(fulfill_settle_ix(0, round_randomness_key(0), payer), &[])
            .await;
    }

    // ── Phase 10: escrow auto-deposit harness ──

    /// Boots with the auto-deposit feature ENABLED (window/tip per the
    /// constants above) and `tweak` applied to the base args — the
    /// disabled-by-default path keeps using `Env::setup`, whose config
    /// reads exactly what the deployed post-upgrade state does (0/0/false).
    async fn setup_auto_deposit(
        players: usize,
        value: [u8; 32],
        extra_mocks: impl FnOnce(Pubkey) -> Vec<(Pubkey, Account)>,
        tweak: impl FnOnce(&mut InitializeArgs),
    ) -> Self {
        let oracle_id = Pubkey::new_unique();
        let extra = extra_mocks(oracle_id);
        let mut env = Self::boot(players, value, extra, oracle_id).await;
        let mut args = default_args();
        args.oracle_program_id = oracle_id;
        args.oracle_queue = env.queue_id;
        args.treasury_authority = env.payer.pubkey();
        args.auto_deposit_window_secs = AUTO_DEPOSIT_WINDOW_SECS;
        args.auto_deposit_tip_lamports = AUTO_DEPOSIT_TIP_LAMPORTS;
        args.auto_deposit_enabled = true;
        tweak(&mut args);
        let admin = env.admin.insecure_clone();
        env.send(initialize_ix(&admin, &args), &[&admin]).await;
        env
    }

    async fn escrow(&mut self, owner: Pubkey) -> PlayerEscrow {
        let data = self.account(escrow_key(owner)).await.expect("escrow").data;
        PlayerEscrow::deserialize(&mut &data[8..]).expect("escrow decode")
    }

    /// Funds (or re-funds) `owner`'s escrow with the given terms.
    async fn fund_escrow(
        &mut self,
        owner: &Keypair,
        amount: u64,
        per_round: u64,
        max_rounds: u32,
        auto_reinvest: bool,
    ) {
        self.send(
            init_or_deposit_escrow_ix(owner.pubkey(), amount, per_round, max_rounds, auto_reinvest),
            &[owner],
        )
        .await;
    }

    /// Opens round `round_id` presenting the unclosed predecessor (the
    /// fail-closed gate). Sequential ids only — exactly what the escrow
    /// tests need.
    async fn open_round_at(&mut self, round_id: u64) {
        let payer = self.payer.pubkey();
        let previous = if round_id == 0 {
            None
        } else {
            Some(round_key(round_id - 1))
        };
        self.send(open_round_ix(payer, round_id, previous), &[])
            .await;
    }

    /// The per-round settle pipeline (warp → lock → pin → settle). The
    /// round's revealed mock must exist: round 0's comes from boot's
    /// `value`, later rounds from `setup_auto_deposit`'s `extra_mocks`.
    /// Only valid when the round will NOT auto-cancel at lock — a sole
    /// depositor round goes to `Cancelled` and must use `lock_only`.
    async fn lock_and_settle(&mut self, round_id: u64) {
        let payer = self.payer.pubkey();
        self.advance_past_end(round_id).await;
        self.send(lock_round_ix(round_id, payer), &[]).await;
        self.send(
            request_randomness_ix(round_id, round_randomness_key(round_id), payer),
            &[],
        )
        .await;
        self.send(
            fulfill_settle_ix(round_id, round_randomness_key(round_id), payer),
            &[],
        )
        .await;
    }

    /// Warp past the round's end and lock it — no randomness pipeline.
    /// For sole-depositor rounds this is the auto-cancel path.
    async fn lock_only(&mut self, round_id: u64) {
        let payer = self.payer.pubkey();
        self.advance_past_end(round_id).await;
        self.send(lock_round_ix(round_id, payer), &[]).await;
    }

    /// Sends one transaction carrying several instructions — the batching
    /// shape `crank_auto_deposit` is sent in live (§5.4).
    async fn send_batch(&mut self, ixs: &[Instruction], extra_signers: &[&Keypair]) {
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend(extra_signers.iter());
        let mut tx = Transaction::new_with_payer(ixs, Some(&self.payer.pubkey()));
        let blockhash = self.banks.get_latest_blockhash().await.expect("blockhash");
        tx.sign(&signers, blockhash);
        self.banks
            .process_transaction_with_preflight(tx)
            .await
            .expect("batch transaction succeeded");
    }

    /// Simulates (nothing lands) and returns the program logs — the only
    /// way to read `emit!` events off a SUCCESSFUL instruction in
    /// program-test. Call BEFORE the real send so the logs describe the
    /// transaction that is about to land.
    async fn simulate_logs(&mut self, ix: Instruction, extra_signers: &[&Keypair]) -> Vec<String> {
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend(extra_signers.iter());
        let mut tx = Transaction::new_with_payer(&[ix], Some(&self.payer.pubkey()));
        let blockhash = self.banks.get_latest_blockhash().await.expect("blockhash");
        tx.sign(&signers, blockhash);
        let sim = self.banks.simulate_transaction(tx).await.expect("simulate");
        sim.simulation_details.expect("simulation details").logs
    }

    /// Sends with `wallet` as the fee payer — the keeper-net accounting
    /// tests need the crank itself to bear the gas. Returns the fee charged
    /// so callers can sum the exact cost of a whole cycle.
    async fn send_paying_fee(&mut self, ix: Instruction, wallet: &Keypair) -> u64 {
        self.reclaim_before_close(&ix).await;
        let mut tx = Transaction::new_with_payer(&[ix], Some(&wallet.pubkey()));
        let blockhash = self.banks.get_latest_blockhash().await.expect("blockhash");
        tx.sign(&[wallet], blockhash);
        let fee = self
            .banks
            .get_fee_for_message(tx.message().clone())
            .await
            .expect("fee lookup")
            .expect("a nonzero fee");
        self.banks
            .process_transaction_with_preflight(tx)
            .await
            .expect("transaction succeeded");
        fee
    }

    /// Genesis-extra wallet funding by plain transfer (the payer eats the
    /// funding fee) — used to give a dedicated keeper/opener wallet its
    /// rent stake without making it the harness fee payer.
    async fn fund_wallet(&mut self, wallet: &Keypair, lamports: u64) {
        self.send(
            sol_transfer(self.payer.pubkey(), wallet.pubkey(), lamports),
            &[],
        )
        .await;
    }
}

/// Deterministic per-round randomness key (the mock lives at a fixed
/// well-known address per round; the program only checks owner/authority).
fn round_randomness_key(round_id: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"mock_randomness", &round_id.to_le_bytes()], &PROGRAM_ID).0
}

// ─── scenario 1: happy path, no Mega trigger ──────────────────────────────

#[tokio::test]
async fn scenario_1_happy_path_no_mega_trigger() {
    let started = Instant::now();
    // ticket 2_000_000_002 ∈ [1 SOL, 4 SOL) ⇒ player 2 (30% slice) wins;
    // mega_seed 1 is not a multiple of 6,767 ⇒ no trigger.
    let value = mock_value(2_000_000_002, 1);
    let mut env = Env::setup(3, value).await;

    env.open_and_deposit(&[SOL, 3 * SOL, 6 * SOL]).await;

    let round = env.round(0).await;
    assert_eq!(round.total_lamports, 10 * SOL);
    assert_eq!(round.entry_count, 3);
    assert!(!round.single_depositor);
    env.assert_round_vault_solvent(0).await;

    env.lock_request_and_settle().await;

    // ── settlement assertions (Phase 11 four-way split) ──
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::Settled);
    assert_eq!(round.winning_ticket, 2_000_000_002);
    assert_eq!(round.admin_cut, SOL / 10, "1% of 10 SOL");
    assert_eq!(round.mega_cut, SOL / 10, "1% of 10 SOL");
    assert_eq!(round.winner_payout, 9 * SOL / 10, "the 9% winner slice");
    assert_eq!(round.refund_pool, 89 * SOL / 10, "the 89% refund pool");
    assert_eq!(round.refunds_paid, 0, "nothing drawn yet");
    assert_eq!(round.mega_field_pool, 0, "no trigger, no field share");
    assert!(!round.mega_triggered);
    assert_eq!(round.mega_awarded, 0);
    assert!(!round.prize_claimed);
    // I18 — the four-way split reassembles the pot, to the lamport.
    let reassembled = round.winner_payout + round.refund_pool + round.admin_cut + round.mega_cut;
    assert_eq!(reassembled, round.total_lamports, "I18");
    // vault_owed = winner slice + refund pool (+ zero trigger slices).
    assert_eq!(round.vault_owed, 98 * SOL / 10);

    // I1: round vault holds rent + 9.8 SOL.
    env.assert_round_vault_solvent(0).await;

    // I2 + I5: treasury holds rent + 0.1 SOL (keeper tip 0 ⇒ full cut).
    let treasury = env.treasury().await;
    assert_eq!(treasury.accrued_lamports, SOL / 10);
    assert_eq!(treasury.lifetime_accrued, SOL / 10);
    assert_eq!(treasury.lifetime_swept, 0);
    let treasury_account = env.account(treasury_key()).await.expect("treasury");
    let treasury_rent = env.rent_minimum(treasury_account.data.len()).await;
    assert_eq!(treasury_account.lamports, treasury_rent + SOL / 10, "I2");

    // I3 + I4: mega pot holds rent + 0.1 SOL, books balanced.
    let mega = env.mega_pot().await;
    assert_eq!(mega.accrued_lamports, SOL / 10);
    assert_eq!(mega.lifetime_contributed, SOL / 10);
    assert_eq!(mega.lifetime_awarded, 0);
    assert_eq!(mega.trigger_count, 0);
    let mega_account = env.account(mega_pot_key()).await.expect("mega");
    let mega_rent = env.rent_minimum(mega_account.data.len()).await;
    assert_eq!(mega_account.lamports, mega_rent + SOL / 10, "I3");
    assert_eq!(
        mega.lifetime_contributed - mega.lifetime_awarded,
        mega.accrued_lamports,
        "I4"
    );

    // ── claim: player 2's entry proves membership, collects the 9% slice ──
    let entry = env.entry(0, 1).await;
    assert_eq!(entry.player, env.players[1].pubkey());
    assert_eq!(entry.ticket_start, SOL);
    assert_eq!(entry.ticket_end, 4 * SOL);

    let player2_before = env.balance(env.players[1].pubkey()).await;
    env.send(
        claim_winnings_ix(0, 1, env.players[1].pubkey(), env.payer.pubkey()),
        &[],
    )
    .await;
    let player2_after = env.balance(env.players[1].pubkey()).await;
    assert_eq!(
        player2_after - player2_before,
        9 * SOL / 10,
        "exact winner slice"
    );

    let round = env.round(0).await;
    assert!(round.prize_claimed);
    assert_eq!(round.winner, env.players[1].pubkey());
    // The vault still owes the field its whole refund pool (R4 isolation).
    assert_eq!(round.vault_owed, 89 * SOL / 10);
    env.assert_round_vault_solvent(0).await;

    // ── closes: every entry draws its exact pro-rata refund ──
    let amounts = [SOL, 3 * SOL, 6 * SOL];
    let mut refunds_paid_running = 0u64;
    for (i, &amount) in amounts.iter().enumerate() {
        let entry_len = env.entry_account(0, i as u32).await.data.len();
        let entry_rent = env.rent_minimum(entry_len).await;
        let expected_refund =
            orbit_jackpot::math::entry_share(amount, 89 * SOL / 10, 10 * SOL).unwrap();
        let before = env.balance(env.players[i].pubkey()).await;
        let payer = env.payer.pubkey();
        env.send(
            close_entry_ix(0, i as u32, env.players[i].pubkey(), payer),
            &[],
        )
        .await;
        let after = env.balance(env.players[i].pubkey()).await;
        assert_eq!(
            after - before,
            expected_refund + entry_rent,
            "entry {i}: pro-rata refund + rent"
        );
        refunds_paid_running += expected_refund;
        assert_eq!(env.round(0).await.refunds_paid, refunds_paid_running);
    }
    let round = env.round(0).await;
    assert_eq!(round.entries_closed, 3);
    assert_eq!(round.refunds_paid, round.refund_pool, "pool fully drawn");
    assert_eq!(round.vault_owed, 0);
    env.assert_round_vault_solvent(0).await;
    let vault = env.account(round_vault_key(0)).await.expect("vault");
    let vault_rent = env.rent_minimum(vault.data.len()).await;
    assert_eq!(vault.lamports, vault_rent, "drained to rent floor");

    // ── sweep: treasury authority collects 0.1 SOL ──
    // Destination is a funded non-payer wallet: the fee payer pays tx fees,
    // so only a third-party wallet shows an exact delta.
    let dest = env.players[2].pubkey();
    let dest_before = env.balance(dest).await;
    env.send(admin_sweep_fees_ix(env.payer.pubkey(), dest), &[])
        .await;
    let dest_after = env.balance(dest).await;
    assert_eq!(dest_after - dest_before, SOL / 10, "exact fee sweep");

    let treasury = env.treasury().await;
    assert_eq!(treasury.accrued_lamports, 0, "I5: fully swept");
    let treasury_account = env.account(treasury_key()).await.expect("treasury");
    let treasury_rent = env.rent_minimum(treasury_account.data.len()).await;
    assert_eq!(
        treasury_account.lamports, treasury_rent,
        "rent floor preserved"
    );
    println!("scenario_1 finished in {:?}", started.elapsed());
}

// ─── scenario 2: Mega-Pot pop, v2 uncapped (50/40/10) ─────────────────────

#[tokio::test]
async fn scenario_2_mega_pot_pop() {
    let started = Instant::now();
    // mega_seed = 625 ⇒ trigger under v2; ticket 3 ∈ [0, 1 SOL) ⇒ player 1.
    // Seeded pot 50 SOL against a 10 SOL round: nominal 45 SOL sits inside
    // the 80 SOL cap, so this is the UNCAPPED branch — 50/40/10 of the
    // pre-contribution accrual.
    let value = mock_value(3, 625);
    let (mut env, crafted_admin) = Env::setup_seeded_mega_v2(3, value, 50 * SOL).await;

    env.open_and_deposit(&[SOL, 3 * SOL, 6 * SOL]).await;
    env.lock_request_and_settle().await;

    // ── settlement: the four-way pot split plus the 50/40/10 trigger ──
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::Settled);
    assert!(round.mega_triggered, "the 1-in-625 fired");
    assert_eq!(round.winning_ticket, 3);
    assert_eq!(round.mega_awarded, 25 * SOL, "5/9 of the 45 SOL payable");
    assert_eq!(
        round.mega_field_pool,
        20 * SOL,
        "4/9 of the payable, pro-rata"
    );
    assert_eq!(round.winner_payout, 9 * SOL / 10);
    assert_eq!(round.refund_pool, 89 * SOL / 10);
    assert_eq!(round.admin_cut, SOL / 10);
    assert_eq!(round.mega_cut, SOL / 10);
    let reassembled = round.winner_payout + round.refund_pool + round.admin_cut + round.mega_cut;
    assert_eq!(reassembled, round.total_lamports, "I18");
    assert_eq!(
        round.vault_owed,
        98 * SOL / 10 + 45 * SOL,
        "ADR-6: slices + the full trigger snapshot"
    );

    let mega = env.mega_pot().await;
    assert_eq!(mega.trigger_count, 1);
    assert_eq!(mega.cycle_index, 1);
    assert_eq!(mega.last_trigger_round_id, 0);
    assert_eq!(mega.lifetime_contributed, 50 * SOL + SOL / 10);
    assert_eq!(mega.lifetime_awarded, 45 * SOL);
    // 10% retained + this round's fresh 1%: 5 + 0.1 SOL.
    assert_eq!(
        mega.accrued_lamports,
        5 * SOL + SOL / 10,
        "I19: retained 10%"
    );
    assert_eq!(
        mega.lifetime_contributed - mega.lifetime_awarded,
        mega.accrued_lamports,
        "I4"
    );
    let mega_account = env.account(mega_pot_key()).await.expect("mega");
    let mega_rent = env.rent_minimum(mega_account.data.len()).await;
    assert_eq!(
        mega_account.lamports,
        mega_rent + 5 * SOL + SOL / 10,
        "I3: rent + accrual"
    );
    env.assert_round_vault_solvent(0).await;

    // ── claim: the 9% slice + the winner's 5/9 of the pop, in full ──
    let player1_before = env.balance(env.players[0].pubkey()).await;
    let payer = env.payer.pubkey();
    env.send(claim_winnings_ix(0, 0, env.players[0].pubkey(), payer), &[])
        .await;
    let player1_after = env.balance(env.players[0].pubkey()).await;
    assert_eq!(
        player1_after - player1_before,
        9 * SOL / 10 + 25 * SOL,
        "winner slice + winner share of the pop"
    );
    let round = env.round(0).await;
    assert!(round.prize_claimed);
    // Refund pool AND field pool remain owed to the field.
    assert_eq!(round.vault_owed, 89 * SOL / 10 + 20 * SOL);
    env.assert_round_vault_solvent(0).await;

    // ── closes: each entry draws refund_i + field_i (2 SOL per SOL staked) ──
    let amounts = [SOL, 3 * SOL, 6 * SOL];
    for (i, &amount) in amounts.iter().enumerate() {
        let entry_len = env.entry_account(0, i as u32).await.data.len();
        let entry_rent = env.rent_minimum(entry_len).await;
        let expected_refund =
            orbit_jackpot::math::entry_share(amount, 89 * SOL / 10, 10 * SOL).unwrap();
        let expected_field = orbit_jackpot::math::entry_share(amount, 20 * SOL, 10 * SOL).unwrap();
        let before = env.balance(env.players[i].pubkey()).await;
        let payer = env.payer.pubkey();
        env.send(
            close_entry_ix(0, i as u32, env.players[i].pubkey(), payer),
            &[],
        )
        .await;
        let after = env.balance(env.players[i].pubkey()).await;
        assert_eq!(
            after - before,
            expected_refund + expected_field + entry_rent,
            "entry {i}: refund + field share + rent"
        );
    }
    let round = env.round(0).await;
    assert_eq!(round.vault_owed, 0, "both pools fully drawn");
    assert_eq!(round.refunds_paid, round.refund_pool);
    assert_eq!(round.mega_field_paid, round.mega_field_pool);

    // close_round: SOL-round totals divide cleanly — no dust, no sweep.
    let round_account = env.account(round_key(0)).await.expect("round");
    let vault_account = env.account(round_vault_key(0)).await.expect("vault");
    let _round_rent = env.rent_minimum(round_account.data.len()).await;
    let _vault_rent = env.rent_minimum(vault_account.data.len()).await;
    // Phase 12: the opener (the harness payer) reclaims both rents; the
    // crafted config admin receives nothing. The exact no-fee round-trip
    // proof lives in p12_rent_round_trips_to_the_opener (the payer here is
    // also the tx fee payer, so its delta is rents − fee by construction).
    let admin_before = env.balance(crafted_admin.pubkey()).await;
    let payer = env.payer.pubkey();
    env.send(close_round_ix(0, payer, payer), &[]).await;
    assert_eq!(
        env.balance(crafted_admin.pubkey()).await,
        admin_before,
        "the config admin receives nothing"
    );
    assert!(env.account(round_key(0)).await.is_none(), "round closed");
    let mega = env.mega_pot().await;
    assert_eq!(mega.accrued_lamports, 5 * SOL + SOL / 10, "dust was zero");
    println!("scenario_2 finished in {:?}", started.elapsed());
}

// ─── scenario 3: sole depositor auto-cancellation ─────────────────────────

#[tokio::test]
async fn scenario_3_sole_depositor_auto_cancel_and_refund() {
    let started = Instant::now();
    let value = mock_value(0, 0);
    let mut env = Env::setup(1, value).await;

    env.open_and_deposit(&[2 * SOL]).await;
    let round = env.round(0).await;
    assert!(round.single_depositor, "one player, O(1) detection");
    env.assert_round_vault_solvent(0).await;

    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    let payer = env.payer.pubkey();
    env.send(lock_round_ix(0, payer), &[]).await;

    // Directly Cancelled — never Locked, no randomness ever pinned.
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::Cancelled);
    assert_eq!(round.randomness_account, Pubkey::default(), "no pin");
    // I15: a cancelled round never moved a lamport to fees or the pot.
    assert_eq!(round.admin_cut, 0);
    assert_eq!(round.mega_cut, 0);
    assert_eq!(round.mega_awarded, 0);
    assert_eq!(round.vault_owed, 2 * SOL, "still owes the full deposit");
    env.assert_round_vault_solvent(0).await;
    let treasury = env.treasury().await;
    assert_eq!(treasury.accrued_lamports, 0);
    let mega = env.mega_pot().await;
    assert_eq!(mega.accrued_lamports, 0);

    // Refund: 100% of principal (zero fees) plus the entry's reclaimed
    // rent — the roadmap's refund path deliberately returns both.
    let entry_len = env.entry_account(0, 0).await.data.len();
    let entry_rent = env.rent_minimum(entry_len).await;
    let player1_before = env.balance(env.players[0].pubkey()).await;
    let payer = env.payer.pubkey();
    env.send(refund_entry_ix(0, 0, env.players[0].pubkey(), payer), &[])
        .await;
    let player1_after = env.balance(env.players[0].pubkey()).await;
    assert_eq!(
        player1_after - player1_before,
        2 * SOL + entry_rent,
        "principal + rent, exactly whole"
    );

    let round = env.round(0).await;
    assert_eq!(round.vault_owed, 0);
    assert_eq!(round.entries_closed, 1);
    env.assert_round_vault_solvent(0).await;
    let vault = env.account(round_vault_key(0)).await.expect("vault");
    let vault_rent = env.rent_minimum(vault.data.len()).await;
    assert_eq!(vault.lamports, vault_rent, "vault drained to rent floor");
    // The entry PDA is closed and its rent returned.
    assert!(env.account(entry_key(0, 0)).await.is_none(), "entry closed");
    println!("scenario_3 finished in {:?}", started.elapsed());
}

// ─── scenario 4: oracle timeout → cancel → full refunds ───────────────────

#[tokio::test]
async fn scenario_4_oracle_timeout_cancel_and_refunds() {
    let started = Instant::now();
    let value = mock_value(5_000_000_000, 1);
    let mut env = Env::setup(3, value).await;

    env.open_and_deposit(&[SOL, 3 * SOL, 6 * SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    let payer = env.payer.pubkey();
    env.send(lock_round_ix(0, payer), &[]).await;
    env.send(
        request_randomness_ix(0, round_randomness_key(0), payer),
        &[],
    )
    .await;
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::AwaitingRandomness);
    let commit_slot = round.randomness_commit_slot;

    // No reveal is ever fulfilled; the deadline lapses. Strictly past
    // commit + 400 slots, anyone may cancel — no re-roll, ever (ADR-4).
    let deadline = commit_slot + 400;
    // The oracle never revealed: the pinned account is still unrevealed
    // (Env::setup pre-seeds a revealed mock, so swap it — AUDIT P-1 makes
    // cancelling a REVEALED round impossible).
    let oracle = env.oracle_id;
    env.context.set_account(
        &round_randomness_key(0),
        &mock_randomness_unrevealed(oracle, round_key(0)).into(),
    );
    let _ = env.context.warp_to_slot(deadline + 1);
    let payer = env.payer.pubkey();
    env.send(cancel_round_ix(0, payer), &[]).await;

    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::Cancelled);
    assert_eq!(round.vault_owed, 10 * SOL, "still owes every deposit");
    assert_eq!(round.admin_cut, 0, "I15");
    assert_eq!(round.mega_cut, 0, "I15");
    assert_eq!(round.mega_awarded, 0, "I15");
    env.assert_round_vault_solvent(0).await;
    let treasury = env.treasury().await;
    assert_eq!(treasury.accrued_lamports, 0, "no fees on cancellation");
    let mega = env.mega_pot().await;
    assert_eq!(mega.accrued_lamports, 0, "no pot contribution either");

    // Every player reclaims principal + rent, exactly whole, in any order.
    let amounts = [SOL, 3 * SOL, 6 * SOL];
    for (i, &amount) in amounts.iter().enumerate() {
        let entry_len = env.entry_account(0, i as u32).await.data.len();
        let entry_rent = env.rent_minimum(entry_len).await;
        let before = env.balance(env.players[i].pubkey()).await;
        let payer = env.payer.pubkey();
        env.send(
            refund_entry_ix(0, i as u32, env.players[i].pubkey(), payer),
            &[],
        )
        .await;
        let after = env.balance(env.players[i].pubkey()).await;
        assert_eq!(
            after - before,
            amount + entry_rent,
            "player {i} made exactly whole"
        );
    }

    let round = env.round(0).await;
    assert_eq!(round.vault_owed, 0, "fully drained");
    assert_eq!(round.entries_closed, 3);
    env.assert_round_vault_solvent(0).await;
    let vault = env.account(round_vault_key(0)).await.expect("vault");
    let vault_rent = env.rent_minimum(vault.data.len()).await;
    assert_eq!(vault.lamports, vault_rent, "conservation: nothing stranded");

    // A cancelled round reaches close_round owing zero (refund_entry pays
    // exact amounts): the I22 dust sweep is a no-op and the round closes
    // without touching the Mega-Pot. Phase 12: the rents return to the
    // round's recorded rent payer (the opener), not the admin.
    let payer = env.payer.pubkey();
    env.send(close_round_ix(0, payer, payer), &[]).await;
    assert!(env.account(round_key(0)).await.is_none(), "round closed");
    let mega = env.mega_pot().await;
    assert_eq!(mega.accrued_lamports, 0, "no dust, no contribution");
    println!("scenario_4 finished in {:?}", started.elapsed());
}

// ─── scenario 5: unclaimed prize sweeps into the Mega-Pot ─────────────────

#[tokio::test]
async fn scenario_5_unclaimed_prize_sweeps_to_mega_pot() {
    let started = Instant::now();
    // No trigger; winner is player 2 — who never claims.
    let value = mock_value(2_000_000_002, 1);
    let mut env = Env::setup_short_claim_deadline(3, value).await;

    env.open_and_deposit(&[SOL, 3 * SOL, 6 * SOL]).await;
    env.lock_request_and_settle().await;
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::Settled);
    assert_eq!(round.vault_owed, 98 * SOL / 10);

    // Before the deadline the sweep is refused.
    let payer = env.payer.pubkey();
    env.send_fails(sweep_unclaimed_prize_ix(0, payer), &[])
        .await;

    // The claim deadline lapses (config-driven; see setup helper); the
    // PRIZE reroutes to the pot — and only the prize (R4): the 8.9 SOL
    // refund pool stays owed to the field.
    env.advance_seconds(ROUND_DURATION_SECS + 11).await;
    let payer = env.payer.pubkey();
    env.send(sweep_unclaimed_prize_ix(0, payer), &[]).await;

    let round = env.round(0).await;
    assert!(round.prize_claimed, "sweep consumes the claim");
    assert_eq!(
        round.vault_owed,
        round.refund_pool + round.mega_field_pool,
        "R4: exactly the field's pools survive the sweep"
    );
    assert_eq!(round.vault_owed, 89 * SOL / 10, "which is the 8.9 SOL pool");
    assert_eq!(round.winner, Pubkey::default(), "nobody established");
    env.assert_round_vault_solvent(0).await;

    let mega = env.mega_pot().await;
    assert_eq!(
        mega.accrued_lamports,
        SOL / 10 + 9 * SOL / 10,
        "1% contribution + the swept 9% prize — never the refunds"
    );
    assert_eq!(mega.lifetime_contributed, SOL / 10 + 9 * SOL / 10, "I4");
    assert_eq!(mega.lifetime_awarded, 0);
    let mega_account = env.account(mega_pot_key()).await.expect("mega");
    let mega_rent = env.rent_minimum(mega_account.data.len()).await;
    assert_eq!(
        mega_account.lamports,
        mega_rent + SOL / 10 + 9 * SOL / 10,
        "I3: rent + full accrual"
    );
    // Treasury untouched — value stayed in the game.
    let treasury = env.treasury().await;
    assert_eq!(treasury.accrued_lamports, SOL / 10);

    // The absent winner can no longer claim what was swept.
    let payer = env.payer.pubkey();
    env.send_fails(claim_winnings_ix(0, 1, env.players[1].pubkey(), payer), &[])
        .await;

    // ── the losers' principal survives the sweep, claimable in full: the
    // permissionless closes pay every refund_i to the lamport ──
    let amounts = [SOL, 3 * SOL, 6 * SOL];
    for (i, &amount) in amounts.iter().enumerate() {
        let entry_len = env.entry_account(0, i as u32).await.data.len();
        let entry_rent = env.rent_minimum(entry_len).await;
        let expected_refund =
            orbit_jackpot::math::entry_share(amount, 89 * SOL / 10, 10 * SOL).unwrap();
        let before = env.balance(env.players[i].pubkey()).await;
        let payer = env.payer.pubkey();
        env.send(
            close_entry_ix(0, i as u32, env.players[i].pubkey(), payer),
            &[],
        )
        .await;
        let after = env.balance(env.players[i].pubkey()).await;
        assert_eq!(
            after - before,
            expected_refund + entry_rent,
            "player {i} recovered principal + rent after the sweep"
        );
    }
    let round = env.round(0).await;
    assert_eq!(round.entries_closed, 3);
    assert_eq!(round.vault_owed, 0);
    // Phase 12: rents return to the opener (the harness payer).
    let payer = env.payer.pubkey();
    env.send(close_round_ix(0, payer, payer), &[]).await;
    assert!(env.account(round_key(0)).await.is_none(), "round closed");
    println!("scenario_5 finished in {:?}", started.elapsed());
}

// ─── scenario 6: cleanup lifecycle + pause semantics ───────────────────────

#[tokio::test]
async fn scenario_6_cleanup_lifecycle_and_pause() {
    let started = Instant::now();
    let value = mock_value(2_000_000_002, 1);
    let mut env = Env::setup(3, value).await;

    // Phase 12: a dedicated KEEPER wallet opens the round — the two
    // rent-exemptions are its capital now, and the close below must hand
    // them back to it (not the admin). The harness payer stays the fee
    // payer so the keeper's deltas stay exactly readable.
    let keeper = Keypair::new();
    env.fund_wallet(&keeper, 10 * SOL).await;
    env.send(open_round_ix(keeper.pubkey(), 0, None), &[&keeper])
        .await;
    for (i, &amount) in [SOL, 3 * SOL, 6 * SOL].iter().enumerate() {
        let player = env.players[i].insecure_clone();
        env.send(deposit_ix(player.pubkey(), 0, i as u32, amount), &[&player])
            .await;
    }
    env.lock_request_and_settle().await;

    // The winning entry (player 2, entry 1) refuses to close before claim —
    // that would destroy the membership proof.
    let payer = env.payer.pubkey();
    env.send_fails(close_entry_ix(0, 1, env.players[1].pubkey(), payer), &[])
        .await;

    // Claim, then close all three entries: each draws its pro-rata refund
    // of the 8.9 SOL pool plus the reclaimed rent.
    let amounts = [SOL, 3 * SOL, 6 * SOL];
    let mut entry_rents = Vec::new();
    for i in 0..3usize {
        let len = env.entry_account(0, i as u32).await.data.len();
        entry_rents.push(env.rent_minimum(len).await);
    }
    let player2_before = env.balance(env.players[1].pubkey()).await;
    let payer = env.payer.pubkey();
    env.send(claim_winnings_ix(0, 1, env.players[1].pubkey(), payer), &[])
        .await;
    let player2_after = env.balance(env.players[1].pubkey()).await;
    assert_eq!(player2_after - player2_before, 9 * SOL / 10, "the 9% slice");

    for (i, (&amount, &entry_rent)) in amounts.iter().zip(entry_rents.iter()).enumerate() {
        let expected_refund =
            orbit_jackpot::math::entry_share(amount, 89 * SOL / 10, 10 * SOL).unwrap();
        let before = env.balance(env.players[i].pubkey()).await;
        let payer = env.payer.pubkey();
        env.send(
            close_entry_ix(0, i as u32, env.players[i].pubkey(), payer),
            &[],
        )
        .await;
        let after = env.balance(env.players[i].pubkey()).await;
        assert_eq!(
            after - before,
            expected_refund + entry_rent,
            "entry {i}: refund + rent to entry.player"
        );
        assert!(env.account(entry_key(0, i as u32)).await.is_none());
    }
    let round = env.round(0).await;
    assert_eq!(round.entries_closed, 3, "I11 bookkeeping");
    assert_eq!(round.refunds_paid, round.refund_pool, "I20 complete");

    // close_round: both PDAs vanish, and the rents land on the KEEPER that
    // opened the round exactly (Phase 12 reciprocity) — the admin, who is
    // not the fee payer and touches nothing here, sees no lamports at all.
    let round_account = env.account(round_key(0)).await.expect("round");
    let vault_account = env.account(round_vault_key(0)).await.expect("vault");
    let round_rent = env.rent_minimum(round_account.data.len()).await;
    let vault_rent = env.rent_minimum(vault_account.data.len()).await;
    let keeper_before = env.balance(keeper.pubkey()).await;
    let admin_before = env.balance(env.admin.pubkey()).await;
    let payer = env.payer.pubkey();
    env.send(close_round_ix(0, keeper.pubkey(), payer), &[])
        .await;
    let keeper_after = env.balance(keeper.pubkey()).await;
    let admin_after = env.balance(env.admin.pubkey()).await;
    assert_eq!(
        keeper_after - keeper_before,
        // + the randomness rent close_randomness reclaimed into the round
        // (AUDIT P-4 ordering); the harness's mock is genesis-funded, on
        // chain the keeper paid it at create time.
        round_rent + vault_rent + env.last_reclaimed,
        "keeper reclaims both rents exactly"
    );
    assert_eq!(admin_after, admin_before, "the admin receives nothing");
    assert!(env.account(round_key(0)).await.is_none(), "round closed");
    assert!(
        env.account(round_vault_key(0)).await.is_none(),
        "vault closed"
    );

    // A fresh round can open after the newest round closed.
    let payer = env.payer.pubkey();
    env.send(open_round_ix(payer, 1, None), &[]).await;
    let round = env.round(1).await;
    assert_eq!(round.state, RoundState::Open);

    // ── pause semantics: blocks deposit + open_round only, never exits ──
    // Round 1 is Open right now: pause and prove both entries are blocked.
    let admin = env.admin.insecure_clone();
    env.send(toggle_pause_ix(admin.pubkey()), &[&admin]).await;

    let player0 = env.players[0].insecure_clone();
    env.send_fails(deposit_ix(player0.pubkey(), 1, 0, SOL), &[&player0])
        .await;
    // A second open is refused while paused (round 1 still Open, and the
    // paused gate fires first in the handler either way).
    let payer = env.payer.pubkey();
    env.send_fails(open_round_ix(payer, 2, Some(round_key(1))), &[])
        .await;

    // Fund-exit paths stay live under pause: lock still works — and on an
    // EMPTY round it now ROLLS the window (Phase 12 R1–R4) instead of
    // cancelling: no teardown, no fresh rent for anyone to farm.
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    let now = env.clock().await.unix_timestamp;
    let payer = env.payer.pubkey();
    env.send(lock_round_ix(1, payer), &[]).await;
    let round = env.round(1).await;
    assert_eq!(round.state, RoundState::Open, "rolled, not cancelled");
    assert_eq!(round.start_ts, now, "R2: start moved to the lock time");
    assert_eq!(round.end_ts, now + ROUND_DURATION_SECS, "R2: end moved");
    assert!(round.total_lamports == 0, "still holds no money");

    // Unpause: the rolled window is a real window — the round accepts a
    // deposit directly (the Phase 12 revival), no reopen needed.
    let admin = env.admin.insecure_clone();
    env.send(toggle_pause_ix(admin.pubkey()), &[&admin]).await;
    let player0 = env.players[0].insecure_clone();
    env.send(deposit_ix(player0.pubkey(), 1, 0, SOL), &[&player0])
        .await;
    let round = env.round(1).await;
    assert_eq!(round.state, RoundState::Open);
    assert_eq!(round.total_lamports, SOL);
    println!("scenario_6 finished in {:?}", started.elapsed());
}

// ─── governance: 2-step admin transfer + ADR-10 config guardrails ─────────

#[tokio::test]
async fn governance_two_step_transfer_and_config_guards() {
    let started = Instant::now();
    let value = mock_value(0, 1);
    let mut env = Env::setup(2, value).await;
    let attacker = env.players[0].insecure_clone();
    let successor = env.players[1].insecure_clone();

    // Non-admin cannot update config or stage a transfer.
    let bad_args = UpdateConfigArgs {
        min_deposit_lamports: Some(SOL / 20),
        ..UpdateConfigArgs::default()
    };
    env.send_fails_with(
        update_config_ix(attacker.pubkey(), &bad_args),
        &[&attacker],
        "UnauthorizedAdmin",
    )
    .await;
    env.send_fails_with(
        transfer_admin_ix(attacker.pubkey(), attacker.pubkey()),
        &[&attacker],
        "UnauthorizedAdmin",
    )
    .await;

    // Admin updates an operational field; economics are unchanged. Phase 11
    // note (case 11 of the 11.5 battery): `UpdateConfigArgs` is
    // compile-level incapable of expressing economics — it has no bps
    // field, no modulus, no cap (ADR-10); `UpdateConfigArgs::default()`
    // is an all-`None` struct over purely operational fields. There is
    // nothing runtime-testable beyond that, by construction.
    let admin = env.admin.insecure_clone();
    env.send(update_config_ix(admin.pubkey(), &bad_args), &[&admin])
        .await;
    let config = env.config().await;
    assert_eq!(config.min_deposit_lamports, SOL / 20);
    assert_eq!(config.fee_bps_admin, 100, "immutable");
    assert_eq!(config.fee_bps_mega, 100, "immutable");
    assert_eq!(config.winner_bps, 900, "immutable (Phase 11 canonical)");
    assert_eq!(config.refund_bps, 8_900, "immutable");
    assert_eq!(config.mega_award_bps, 5_000, "immutable");
    assert_eq!(config.mega_field_bps, 4_000, "immutable");
    assert_eq!(config.mega_trigger_modulus, 625, "immutable");
    assert_eq!(config.mega_payout_cap_bps, 80_000, "immutable");
    assert_eq!(config.economics_version, 2, "fresh boots start at v2");

    // Invalid operational combos are rejected even for the admin.
    let bad_deadline = UpdateConfigArgs {
        randomness_reveal_deadline_slots: Some(600),
        ..UpdateConfigArgs::default()
    };
    let admin = env.admin.insecure_clone();
    env.send_fails_with(
        update_config_ix(admin.pubkey(), &bad_deadline),
        &[&admin],
        "InvalidRevealDeadline",
    )
    .await;

    // Two-step handoff: stage, wrong-key rejection, accept, seat flip.
    let admin = env.admin.insecure_clone();
    env.send(
        transfer_admin_ix(admin.pubkey(), successor.pubkey()),
        &[&admin],
    )
    .await;
    let config = env.config().await;
    assert_eq!(config.pending_admin, Some(successor.pubkey()));

    env.send_fails_with(
        accept_admin_ix(attacker.pubkey()),
        &[&attacker],
        "UnauthorizedPendingAdmin",
    )
    .await;

    env.send(accept_admin_ix(successor.pubkey()), &[&successor])
        .await;
    let config = env.config().await;
    assert_eq!(config.admin, successor.pubkey());
    assert_eq!(config.pending_admin, None);

    // The old admin is deposed; the successor rules.
    let old_admin = env.admin.insecure_clone();
    let noop = UpdateConfigArgs::default();
    env.send_fails_with(
        update_config_ix(old_admin.pubkey(), &noop),
        &[&old_admin],
        "UnauthorizedAdmin",
    )
    .await;
    let args = UpdateConfigArgs {
        keeper_tip_lamports: Some(SOL / 1_000),
        ..UpdateConfigArgs::default()
    };
    env.send(update_config_ix(successor.pubkey(), &args), &[&successor])
        .await;
    assert_eq!(env.config().await.keeper_tip_lamports, SOL / 1_000);
    println!("governance finished in {:?}", started.elapsed());
}

// ─── attacks 1 & 4: oracle spoofing, forged authority, re-pin, stale seed ─

#[tokio::test]
async fn adversarial_randomness_battery() {
    let started = Instant::now();
    // The round will pin the STALE mock (benign-looking value), exposing:
    // forged authority and wrong owner at request; spoofed key and stale
    // seed at settle; and the write-once pin in between.
    let stale_value = mock_value(9_000_000_000, 1);
    let mut env = Env::setup_adv(
        2,
        stale_value,
        Box::new(move |oracle_id| {
            let attacker = Pubkey::new_unique();
            vec![
                // Favorable-value account with the RIGHT authority and owner
                // but a different key — settlement only accepts the pin.
                (
                    spoof_key(),
                    mock_randomness_account(oracle_id, round_key(0), mock_value(1, 1)),
                ),
                // Right owner, wrong authority (attacker-held): could be
                // re-committed after seeing an unfavorable value.
                (
                    forged_key(),
                    mock_randomness_with_slots(
                        oracle_id,
                        attacker,
                        mock_value(1, 1),
                        10_000_000,
                        10_000_000,
                    ),
                ),
                // Right authority, wrong owner (attacker's fake program).
                (
                    wrong_owner_key(),
                    mock_randomness_account(Pubkey::new_unique(), round_key(0), mock_value(1, 1)),
                ),
                // Committed at or before the lock slot — the front-running
                // vector (ADR-4 freshness check).
                (
                    round_randomness_key(0),
                    mock_randomness_with_slots(oracle_id, round_key(0), stale_value, 0, 1),
                ),
            ]
        }),
    )
    .await;

    env.open_and_deposit(&[SOL, 3 * SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    let payer = env.payer.pubkey();
    env.send(lock_round_ix(0, payer), &[]).await;

    // Forged authority: rejected at request (the critical ADR-4 check).
    let payer = env.payer.pubkey();
    env.send_fails_with(
        request_randomness_ix(0, forged_key(), payer),
        &[],
        "RandomnessAuthorityMismatch",
    )
    .await;
    // Wrong owner: rejected by the context constraint.
    let payer = env.payer.pubkey();
    env.send_fails_with(
        request_randomness_ix(0, wrong_owner_key(), payer),
        &[],
        "RandomnessOwnerMismatch",
    )
    .await;
    // The legitimate (stale) account pins fine…
    let payer = env.payer.pubkey();
    env.send(
        request_randomness_ix(0, round_randomness_key(0), payer),
        &[],
    )
    .await;
    // …exactly once: no re-roll, ever.
    let payer = env.payer.pubkey();
    env.send_fails_with(
        request_randomness_ix(0, round_randomness_key(0), payer),
        &[],
        "RandomnessAlreadyPinned",
    )
    .await;

    // Spoofed key with a favorable value: rejected against the pin.
    let payer = env.payer.pubkey();
    env.send_fails_with(
        fulfill_settle_ix(0, spoof_key(), payer),
        &[],
        "RandomnessAccountMismatch",
    )
    .await;
    // Stale seed (seed_slot <= lock_slot): rejected at settle.
    let payer = env.payer.pubkey();
    env.send_fails_with(
        fulfill_settle_ix(0, round_randomness_key(0), payer),
        &[],
        "StaleRandomness",
    )
    .await;

    // Nothing moved under attack: the round still owes everything (I1).
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::AwaitingRandomness);
    assert_eq!(round.winning_ticket, 0, "no outcome was written");
    env.assert_round_vault_solvent(0).await;
    println!("adversarial_randomness finished in {:?}", started.elapsed());
}

// ─── attacks 2 & 3: double claim, diverted payout, false winner ───────────

#[tokio::test]
async fn adversarial_claim_battery() {
    let started = Instant::now();
    // Winner is player 2 (entry 1, range [1 SOL, 4 SOL)); attacker = p1.
    let value = mock_value(2_000_000_002, 1);
    let mut env = Env::setup(3, value).await;
    env.open_and_deposit(&[SOL, 3 * SOL, 6 * SOL]).await;
    env.lock_request_and_settle().await;

    let attacker = env.players[0].insecure_clone();
    let payer = env.payer.pubkey();

    // False winner: player 1's range does not contain the ticket.
    env.send_fails_with(
        claim_winnings_ix(0, 0, env.players[0].pubkey(), payer),
        &[],
        "EntryNotWinning",
    )
    .await;

    // Diverted payout: the winning entry presented with the attacker's
    // wallet as destination.
    env.send_fails_with(
        claim_winnings_ix(0, 1, attacker.pubkey(), payer),
        &[],
        "RefundDestinationMismatch",
    )
    .await;

    // Attacker-cranked claim for the TRUE winner still succeeds and pays
    // exactly the winner — outcome independence (I13).
    let winner_before = env.balance(env.players[1].pubkey()).await;
    let payer = env.payer.pubkey();
    env.send(claim_winnings_ix(0, 1, env.players[1].pubkey(), payer), &[])
        .await;
    let winner_after = env.balance(env.players[1].pubkey()).await;
    assert_eq!(winner_after - winner_before, 9 * SOL / 10);

    // Double claim: the prize is spent.
    let payer = env.payer.pubkey();
    env.send_fails_with(
        claim_winnings_ix(0, 1, env.players[1].pubkey(), payer),
        &[],
        "PrizeAlreadyClaimed",
    )
    .await;

    // The vault drained only of the prize — the refund pool stays owed
    // (I1 against the remainder, not against zero).
    env.assert_round_vault_solvent(0).await;
    let round = env.round(0).await;
    assert_eq!(round.vault_owed, 89 * SOL / 10);
    let vault = env.account(round_vault_key(0)).await.expect("vault");
    let vault_rent = env.rent_minimum(vault.data.len()).await;
    assert_eq!(vault.lamports, vault_rent + 89 * SOL / 10);
    println!("adversarial_claim finished in {:?}", started.elapsed());
}

// ─── attack 5: drain and closure guards ────────────────────────────────────

#[tokio::test]
async fn adversarial_drain_guards() {
    let started = Instant::now();
    let value = mock_value(2_000_000_002, 1);
    let mut env = Env::setup_short_claim_deadline(2, value).await;
    env.open_and_deposit(&[SOL, 3 * SOL]).await;
    env.lock_request_and_settle().await;

    let payer = env.payer.pubkey();

    // The entries are not closed yet: closure is refused on the pruning
    // guard (which now precedes the drain check — a half-pruned round
    // cannot be torn down even if it somehow owed nothing). The
    // destination is the opener (Phase 12) so the ONLY rejection reason
    // left is the pruning guard itself.
    env.send_fails_with(close_round_ix(0, payer, payer), &[], "EntriesNotClosed")
        .await;

    // Refunds are for Cancelled rounds only — no exit but the claim here.
    // (The crank signs alone: refunds are permissionless.)
    env.send_fails_with(
        refund_entry_ix(0, 0, env.players[0].pubkey(), payer),
        &[],
        "RoundNotCancelled",
    )
    .await;

    // Let the prize lapse into the pot: the refunds stay owed, but the
    // entries still block closure.
    env.advance_seconds(ROUND_DURATION_SECS + 11).await;
    let payer = env.payer.pubkey();
    env.send(sweep_unclaimed_prize_ix(0, payer), &[]).await;
    let round = env.round(0).await;
    assert_eq!(
        round.vault_owed,
        89 * SOL / 25,
        "R4: the 3.56 SOL refund pool survives the sweep"
    );
    env.send_fails_with(close_round_ix(0, payer, payer), &[], "EntriesNotClosed")
        .await;

    // Solvency held across every refused attempt (I1 + I3). Pot = this
    // round's 1% cut (4 SOL pot ⇒ 0.04) + the swept 9% prize (0.36).
    env.assert_round_vault_solvent(0).await;
    let mega = env.mega_pot().await;
    assert_eq!(mega.accrued_lamports, SOL / 25 + 9 * SOL / 25);

    // Prune the two entries (the winner's is closable: the sweep claimed
    // the prize), then the round closes with zero dust — refund shares of
    // a 1/3+1 SOL pot divide cleanly.
    let payer = env.payer.pubkey();
    env.send(close_entry_ix(0, 0, env.players[0].pubkey(), payer), &[])
        .await;
    env.send(close_entry_ix(0, 1, env.players[1].pubkey(), payer), &[])
        .await;
    assert_eq!(env.round(0).await.vault_owed, 0);
    // Phase 12: rents return to the opener.
    env.send(close_round_ix(0, payer, payer), &[]).await;
    assert!(env.account(round_key(0)).await.is_none(), "round closed");
    println!("adversarial_drain finished in {:?}", started.elapsed());
}

/// Well-known adversarial mock addresses (PDAs of a fake namespace so they
/// can never collide with real program accounts).
fn spoof_key() -> Pubkey {
    Pubkey::find_program_address(&[b"mock_randomness", b"spoof"], &PROGRAM_ID).0
}
fn forged_key() -> Pubkey {
    Pubkey::find_program_address(&[b"mock_randomness", b"forged"], &PROGRAM_ID).0
}
fn wrong_owner_key() -> Pubkey {
    Pubkey::find_program_address(&[b"mock_randomness", b"wrong_owner"], &PROGRAM_ID).0
}

// ─── phase 11.5: the partial-loss battery ──────────────────────────────────

/// Case 1 — the canonical round. Ten entries of 1 SOL; every number to the
/// lamport: the 9/89/1/1 split, 0.89 SOL per close, the winner's 1.79 SOL
/// net across claim + close, the vault at exactly its rent minimum and
/// zero dust.
#[tokio::test]
async fn canonical_ten_entry_round_v2() {
    // Ticket 4.5 SOL ∈ [4 SOL, 5 SOL) ⇒ entry 4 wins.
    let mut env = Env::setup(10, mock_value(4_500_000_000, 1)).await;
    env.open_and_deposit(&[SOL; 10]).await;
    env.lock_request_and_settle().await;

    let round = env.round(0).await;
    assert_eq!(round.winner_payout, 9 * SOL / 10);
    assert_eq!(round.refund_pool, 89 * SOL / 10);
    assert_eq!(round.admin_cut, SOL / 10);
    assert_eq!(round.mega_cut, SOL / 10);
    assert_eq!(
        round.winner_payout + round.refund_pool + round.admin_cut + round.mega_cut,
        10 * SOL,
        "I18"
    );
    assert_eq!(round.vault_owed, 98 * SOL / 10);

    // Claim: the winner takes the 9% slice…
    let winner = env.players[4].insecure_clone();
    let before = env.balance(winner.pubkey()).await;
    let payer = env.payer.pubkey();
    env.send(claim_winnings_ix(0, 4, winner.pubkey(), payer), &[])
        .await;
    let after_claim = env.balance(winner.pubkey()).await;
    assert_eq!(after_claim - before, 9 * SOL / 10);

    // …and the winner's own close adds the 0.89 SOL refund + rent: the
    // Phase 11 headline for the winner is 1.79 SOL on 1 staked.
    let entry_len = env.entry_account(0, 4).await.data.len();
    let entry_rent = env.rent_minimum(entry_len).await;
    env.send(close_entry_ix(0, 4, winner.pubkey(), payer), &[])
        .await;
    let after_close = env.balance(winner.pubkey()).await;
    assert_eq!(
        after_close - after_claim,
        89 * SOL / 100 + entry_rent,
        "winner nets 1.79 SOL + rent across claim + close"
    );

    // Every other close pays exactly 0.89 SOL + rent.
    for i in 0..10u32 {
        if env.account(entry_key(0, i)).await.is_none() {
            continue; // the winner's entry already closed
        }
        let len = env.entry_account(0, i).await.data.len();
        let rent = env.rent_minimum(len).await;
        let player = env.players[i as usize].insecure_clone();
        let b = env.balance(player.pubkey()).await;
        let payer = env.payer.pubkey();
        env.send(close_entry_ix(0, i, player.pubkey(), payer), &[])
            .await;
        let a = env.balance(player.pubkey()).await;
        assert_eq!(a - b, 89 * SOL / 100 + rent, "entry {i}");
    }

    let round = env.round(0).await;
    assert_eq!(round.refunds_paid, round.refund_pool, "pool fully drawn");
    assert_eq!(round.vault_owed, 0);
    let vault = env.account(round_vault_key(0)).await.expect("vault");
    let vault_rent = env.rent_minimum(vault.data.len()).await;
    assert_eq!(vault.lamports, vault_rent, "dust == 0, at the rent floor");

    // close_round: nothing to sweep — the Mega-Pot keeps only its 1%.
    // Phase 12: rents return to the opener.
    env.send(close_round_ix(0, payer, payer), &[]).await;
    assert!(env.account(round_key(0)).await.is_none());
    let mega = env.mega_pot().await;
    assert_eq!(mega.accrued_lamports, SOL / 10, "no dust swept");
}

/// Case 2 — R2's counterexample, the regression guard: 100 entries of ONE
/// LAMPORT. The refund pool holds 89 lamports, every pro-rata share floors
/// to zero, every entry still closes, and the whole 89 sweeps as dust at
/// close_round. The naive `amount − floor(amount × 11%)` formula would
/// claim 100 lamports here and lock the round forever.
#[tokio::test]
async fn r2_one_lamport_round_drains_completely() {
    let mut env = Env::setup(100, mock_value(50, 1)).await; // ticket 50 ∈ entry 50
    let admin = env.admin.insecure_clone();
    env.send(
        update_config_ix(
            admin.pubkey(),
            &UpdateConfigArgs {
                min_deposit_lamports: Some(0),
                ..UpdateConfigArgs::default()
            },
        ),
        &[&admin],
    )
    .await;
    env.send(open_round_ix(env.payer.pubkey(), 0, None), &[])
        .await;
    let wallets: Vec<Keypair> = env.players.iter().map(|k| k.insecure_clone()).collect();
    for (i, kp) in wallets.iter().enumerate() {
        env.send(deposit_ix(kp.pubkey(), 0, i as u32, 1), &[kp])
            .await;
    }
    let round = env.round(0).await;
    assert_eq!(round.entry_count, 100);
    assert_eq!(round.total_lamports, 100);
    env.lock_request_and_settle().await;

    let round = env.round(0).await;
    assert_eq!(round.winner_payout, 9, "floor(100 × 900 bps)");
    assert_eq!(round.admin_cut, 1);
    assert_eq!(round.mega_cut, 1);
    assert_eq!(round.refund_pool, 89, "the residual");
    assert_eq!(round.vault_owed, 98);

    let payer = env.payer.pubkey();
    env.send(
        claim_winnings_ix(0, 50, env.players[50].pubkey(), payer),
        &[],
    )
    .await;
    for i in 0..100u32 {
        let player = env.players[i as usize].insecure_clone();
        env.send(close_entry_ix(0, i, player.pubkey(), payer), &[])
            .await; // every close succeeds: share 0, rent returned
    }
    let round = env.round(0).await;
    assert_eq!(round.entries_closed, 100);
    assert_eq!(round.refunds_paid, 0, "Σ floor(1 × 89/100) == 0");
    assert_eq!(round.vault_owed, 89, "the pool survives as dust");

    // I22: 89 ≤ 2 × 100 — legal dust, swept whole at close_round.
    // Phase 12: rents return to the opener.
    env.send(close_round_ix(0, payer, payer), &[]).await;
    assert!(env.account(round_key(0)).await.is_none(), "round closed");
    let mega = env.mega_pot().await;
    assert_eq!(mega.accrued_lamports, 1 + 89, "1% cut + the 89 dust");
}

/// Case 3 — asymmetric stakes with deliberate remainders: a
/// 7_777_777_777-lamport pot over 7 unequal entries. Σ refund_i + dust ==
/// refund_pool exactly, dust < entry_count, and close_round sweeps it.
#[tokio::test]
async fn asymmetric_stakes_dust_is_bounded() {
    #[rustfmt::skip]
    const AMOUNTS: [u64; 7] = [
        1_111_111_111, 2_222_222_222, 333_333_333, 1_234_567_890,
        987_654_321, 1_000_000_000, 888_888_900,
    ];
    const TOTAL: u64 = 7_777_777_777;
    assert_eq!(AMOUNTS.iter().sum::<u64>(), TOTAL);

    // Ticket 4e9 lands in entry 3's range [3_666_666_666, 4_901_234_556).
    let mut env = Env::setup(7, mock_value(4_000_000_000, 1)).await;
    env.open_and_deposit(&AMOUNTS).await;
    env.lock_request_and_settle().await;

    let split = orbit_jackpot::math::split_round_pot(
        TOTAL,
        orbit_jackpot::constants::WINNER_BPS,
        orbit_jackpot::constants::FEE_BPS_ADMIN,
        orbit_jackpot::constants::FEE_BPS_MEGA,
    )
    .unwrap();
    let round = env.round(0).await;
    assert_eq!(round.winner_payout, split.winner_payout);
    assert_eq!(round.refund_pool, split.refund_pool);
    assert_eq!(round.mega_cut, split.mega_cut);

    let payer = env.payer.pubkey();
    env.send(claim_winnings_ix(0, 3, env.players[3].pubkey(), payer), &[])
        .await;
    let mut refunded: u64 = 0;
    for (i, &amount) in AMOUNTS.iter().enumerate() {
        let expected = orbit_jackpot::math::entry_share(amount, split.refund_pool, TOTAL).unwrap();
        let player = env.players[i].insecure_clone();
        let len = env.entry_account(0, i as u32).await.data.len();
        let rent = env.rent_minimum(len).await;
        let b = env.balance(player.pubkey()).await;
        env.send(close_entry_ix(0, i as u32, player.pubkey(), payer), &[])
            .await;
        let a = env.balance(player.pubkey()).await;
        assert_eq!(a - b, expected + rent, "entry {i} pro-rata");
        refunded += expected;
    }
    let dust = split.refund_pool - refunded;
    assert!(
        dust < AMOUNTS.len() as u64,
        "dust {dust} < 7 (sum-of-floors)"
    );
    assert_eq!(refunded + dust, split.refund_pool, "nothing unaccounted");

    // Phase 12: rents return to the opener.
    env.send(close_round_ix(0, payer, payer), &[]).await;
    assert!(env.account(round_key(0)).await.is_none());
    let mega = env.mega_pot().await;
    assert_eq!(mega.accrued_lamports, split.mega_cut + dust, "cut + dust");
}

/// Case 6 — the capped pop: a 100 SOL pot against a 10 SOL round. The
/// 80_000 bps cap (8× the round pot) binds below the 90 SOL nominal; the
/// winner:field ratio stays 5:4 and I19 holds exactly.
#[tokio::test]
async fn mega_pop_is_capped_by_the_round_pot() {
    let (mut env, _crafted_admin) =
        Env::setup_seeded_mega_v2(3, mock_value(3, 625), 100 * SOL).await;
    env.open_and_deposit(&[SOL, 3 * SOL, 6 * SOL]).await;
    env.lock_request_and_settle().await;

    let round = env.round(0).await;
    assert!(round.mega_triggered);
    // nominal 90 SOL > cap 80 SOL ⇒ payable == cap; 5/9 : 4/9 of it.
    assert_eq!(round.mega_awarded, 44_444_444_444, "floor(80e9 × 5/9)");
    assert_eq!(
        round.mega_field_pool, 35_555_555_556,
        "the payable residual"
    );
    assert_eq!(
        round.mega_awarded + round.mega_field_pool,
        80 * SOL,
        "payable == cap"
    );
    // Ratio preserved to within the single flooring lamport.
    assert!(
        (4 * round.mega_awarded as i128 - 5 * round.mega_field_pool as i128).abs() <= 4,
        "winner:field within rounding of 5:4"
    );
    assert_eq!(round.vault_owed, 98 * SOL / 10 + 80 * SOL);
    let mega = env.mega_pot().await;
    assert_eq!(mega.accrued_lamports, 20 * SOL + SOL / 10, "accrued − cap");
    assert_eq!(mega.lifetime_awarded, 80 * SOL);
    env.assert_round_vault_solvent(0).await;

    // Field shares flow pro-rata at close; conservation to the lamport.
    let payer = env.payer.pubkey();
    env.send(claim_winnings_ix(0, 0, env.players[0].pubkey(), payer), &[])
        .await;
    let amounts = [SOL, 3 * SOL, 6 * SOL];
    let mut field_paid: u64 = 0;
    for (i, &amount) in amounts.iter().enumerate() {
        let expected_field =
            orbit_jackpot::math::entry_share(amount, 35_555_555_556, 10 * SOL).unwrap();
        let expected_refund =
            orbit_jackpot::math::entry_share(amount, 89 * SOL / 10, 10 * SOL).unwrap();
        let player = env.players[i].insecure_clone();
        let len = env.entry_account(0, i as u32).await.data.len();
        let rent = env.rent_minimum(len).await;
        let b = env.balance(player.pubkey()).await;
        env.send(close_entry_ix(0, i as u32, player.pubkey(), payer), &[])
            .await;
        let a = env.balance(player.pubkey()).await;
        assert_eq!(
            a - b,
            expected_refund + expected_field + rent,
            "entry {i} refund + field + rent"
        );
        field_paid += expected_field;
    }
    let field_dust = 35_555_555_556 - field_paid;
    assert!(field_dust < 3, "field dust within the lemma bound");
    env.send(close_round_ix(0, payer, payer), &[]).await;
    let mega = env.mega_pot().await;
    assert_eq!(
        mega.accrued_lamports,
        20 * SOL + SOL / 10 + field_dust,
        "I19 + the field's rounding dust"
    );
}

/// Case 7 — a trigger on a zero balance: every payout is zero but the
/// trigger still fires and is counted, keeping the 1-in-N statistics
/// honest and auditable.
#[tokio::test]
async fn mega_pop_on_zero_accrual_still_emits() {
    let (mut env, _crafted_admin) = Env::setup_seeded_mega_v2(3, mock_value(3, 625), 0).await;
    env.open_and_deposit(&[SOL, 3 * SOL, 6 * SOL]).await;
    env.lock_request_and_settle().await;

    let round = env.round(0).await;
    assert!(round.mega_triggered, "the pop happened");
    assert_eq!(round.mega_awarded, 0);
    assert_eq!(round.mega_field_pool, 0);
    assert_eq!(round.vault_owed, 98 * SOL / 10, "nothing snapshotted");
    let mega = env.mega_pot().await;
    assert_eq!(mega.trigger_count, 1, "counted even at zero");
    assert_eq!(mega.lifetime_awarded, 0);
    assert_eq!(mega.accrued_lamports, SOL / 10, "only the fresh 1%");

    // The round drains normally: claim, closes, no dust.
    let payer = env.payer.pubkey();
    env.send(claim_winnings_ix(0, 0, env.players[0].pubkey(), payer), &[])
        .await;
    for i in 0..3u32 {
        let player = env.players[i as usize].insecure_clone();
        env.send(close_entry_ix(0, i, player.pubkey(), payer), &[])
            .await;
    }
    env.send(close_round_ix(0, payer, payer), &[]).await;
    assert!(env.account(round_key(0)).await.is_none());
    assert_eq!(env.mega_pot().await.accrued_lamports, SOL / 10);
}

/// Case 8 — the single-entry belt: `lock_round` cancels sole-depositor
/// rounds, so this round is crafted at genesis (the KAT-boot technique):
/// one entry owning the whole ticket space. No division by zero anywhere,
/// the one entry draws the whole refund pool exactly, dust 0.
#[tokio::test]
async fn single_entry_round_settles_without_diverging() {
    const TOTAL: u64 = 1_234_567_890;
    // A funded wallet to own the single entry (entry.player); funded at
    // genesis so claim/close can credit a real System-owned account.
    let entry_owner = Pubkey::new_unique();
    let mut env = Env::setup_adv(
        1,
        [0u8; 32],
        Box::new(move |oracle_id| {
            use borsh::BorshSerialize;
            let rent = solana_sdk::rent::Rent::default();
            let owned = |data: Vec<u8>, extra: u64| Account {
                lamports: rent.minimum_balance(data.len()) + extra,
                data,
                owner: PROGRAM_ID,
                executable: false,
                rent_epoch: 0,
            };
            let round_bump =
                Pubkey::find_program_address(&[b"round", &0u64.to_le_bytes()], &PROGRAM_ID).1;
            let vault_bump =
                Pubkey::find_program_address(&[b"round_vault", &0u64.to_le_bytes()], &PROGRAM_ID).1;
            let entry_bump = Pubkey::find_program_address(
                &[b"entry", &0u64.to_le_bytes(), &0u32.to_le_bytes()],
                &PROGRAM_ID,
            )
            .1;
            let mut round_data = anchor_account_disc("Round");
            Round {
                round_id: 0,
                state: RoundState::Locked,
                start_ts: 0,
                end_ts: 0,
                lock_ts: 0,
                lock_slot: 1,
                settle_ts: 0,
                total_lamports: TOTAL,
                entry_count: 1,
                entries_closed: 0,
                first_depositor: Pubkey::default(),
                single_depositor: true,
                randomness_account: Pubkey::default(),
                randomness_commit_slot: 0,
                randomness_seed_slot: 0,
                winning_ticket: 0,
                winner: Pubkey::default(),
                winner_payout: 0,
                admin_cut: 0,
                mega_cut: 0,
                mega_awarded: 0,
                vault_owed: TOTAL,
                mega_triggered: false,
                prize_claimed: false,
                vault_bump,
                bump: round_bump,
                refund_pool: 0,
                refunds_paid: 0,
                mega_field_pool: 0,
                mega_field_paid: 0,
                rent_payer: Pubkey::default(),
            }
            .serialize(&mut round_data)
            .expect("round encode");
            let mut vault_data = anchor_account_disc("RoundVault");
            RoundVault {
                round_id: 0,
                bump: vault_bump,
                reserved: [0; 16],
            }
            .serialize(&mut vault_data)
            .expect("vault encode");
            let mut entry_data = anchor_account_disc("PlayerEntry");
            PlayerEntry {
                round_id: 0,
                entry_index: 0,
                player: entry_owner,
                amount: TOTAL,
                ticket_start: 0,
                ticket_end: TOTAL,
                deposit_ts: 0,
                deposit_slot: 0,
                bump: entry_bump,
                reserved: [0; 16],
            }
            .serialize(&mut entry_data)
            .expect("entry encode");
            vec![
                (round_key(0), owned(round_data, 0)),
                (round_vault_key(0), owned(vault_data, TOTAL)),
                (entry_key(0, 0), owned(entry_data, 0)),
                (
                    entry_owner,
                    Account {
                        lamports: SOL,
                        data: Vec::new(),
                        owner: solana_sdk::system_program::ID,
                        executable: false,
                        rent_epoch: 0,
                    },
                ),
                (
                    round_randomness_key(0),
                    mock_randomness_account(oracle_id, round_key(0), mock_value(777, 1)),
                ),
            ]
        }),
    )
    .await;

    let payer = env.payer.pubkey();
    env.send(
        request_randomness_ix(0, round_randomness_key(0), payer),
        &[],
    )
    .await;
    env.send(fulfill_settle_ix(0, round_randomness_key(0), payer), &[])
        .await;

    let split = orbit_jackpot::math::split_round_pot(
        TOTAL,
        orbit_jackpot::constants::WINNER_BPS,
        orbit_jackpot::constants::FEE_BPS_ADMIN,
        orbit_jackpot::constants::FEE_BPS_MEGA,
    )
    .unwrap();
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::Settled);
    assert_eq!(round.winning_ticket, 777);
    assert_eq!(round.winner_payout, split.winner_payout);
    assert_eq!(round.refund_pool, split.refund_pool);
    assert_eq!(round.vault_owed, split.winner_payout + split.refund_pool);
    env.assert_round_vault_solvent(0).await;

    // Claim pays the entry owner; the single close then draws the WHOLE
    // refund pool — entry_share(TOTAL, pool, TOTAL) == pool, dust 0.
    env.send(claim_winnings_ix(0, 0, entry_owner, payer), &[])
        .await;
    let owner_before = env.balance(entry_owner).await;
    env.send(close_entry_ix(0, 0, entry_owner, payer), &[])
        .await;
    let owner_after = env.balance(entry_owner).await;
    assert_eq!(
        owner_after - owner_before,
        split.refund_pool + env.rent_minimum(109).await,
        "whole pool + entry rent in one close, dust 0"
    );
    assert_eq!(env.round(0).await.vault_owed, 0);
    env.send(close_round_ix(0, env.admin.pubkey(), payer), &[])
        .await;
    assert!(env.account(round_key(0)).await.is_none());
}

/// Case 12 — R6 bit-for-bit: a config with the pre-migration values and
/// zeroed Phase 11 fields settles the v1 98/1/1 numbers on the upgraded
/// program, and the round drains exactly as it did before the upgrade.
#[tokio::test]
async fn v1_config_settles_bit_for_bit_after_upgrade() {
    // setup_seeded_mega crafts the v1 config (9_800/9_000/6_767, zeroed
    // new fields); seed 1 never fires 1-in-6_767.
    let (mut env, _crafted_admin) =
        Env::setup_seeded_mega(3, mock_value(2_000_000_002, 1), 0).await;
    env.open_and_deposit(&[SOL, 3 * SOL, 6 * SOL]).await;
    env.lock_request_and_settle().await;

    let round = env.round(0).await;
    assert_eq!(round.winner_payout, 98 * SOL / 10, "the v1 residual");
    assert_eq!(round.admin_cut, SOL / 10);
    assert_eq!(round.mega_cut, SOL / 10);
    assert_eq!(round.refund_pool, 0, "10 SOL divides cleanly: no v1 dust");
    assert_eq!(round.mega_field_pool, 0);
    assert_eq!(round.vault_owed, 98 * SOL / 10);
    assert_eq!(
        round.winner_payout + round.admin_cut + round.mega_cut,
        10 * SOL
    );

    let payer = env.payer.pubkey();
    env.send(claim_winnings_ix(0, 1, env.players[1].pubkey(), payer), &[])
        .await;
    for i in 0..3u32 {
        let player = env.players[i as usize].insecure_clone();
        let len = env.entry_account(0, i).await.data.len();
        let rent = env.rent_minimum(len).await;
        let b = env.balance(player.pubkey()).await;
        env.send(close_entry_ix(0, i, player.pubkey(), payer), &[])
            .await;
        let a = env.balance(player.pubkey()).await;
        assert_eq!(a - b, rent, "rent-only close: no refund pool exists");
    }
    env.send(close_round_ix(0, payer, payer), &[]).await;
    assert!(env.account(round_key(0)).await.is_none());
    let mega = env.mega_pot().await;
    assert_eq!(mega.accrued_lamports, SOL / 10, "1% only, no dust");
}

/// Boots a migration target: singletons crafted with the v0/v1 economics
/// and `admin` as the authority — the exact state the deployed program
/// will be in when `migrate_economics_v2` runs against it.
async fn boot_migration_env(
    admin: &Keypair,
    mega_lamports: u64,
    active_round_id: u64,
    next_round_id: u64,
) -> Env {
    use borsh::BorshSerialize;
    let oracle_id = Pubkey::new_unique();
    let rent = solana_sdk::rent::Rent::default();
    let mut args = default_args();
    args.oracle_program_id = oracle_id;

    let config_bump = Pubkey::find_program_address(&[b"config"], &PROGRAM_ID).1;
    let config = GlobalConfig {
        admin: admin.pubkey(),
        pending_admin: None,
        treasury_authority: Pubkey::new_unique(),
        oracle_program_id: oracle_id,
        oracle_queue: Pubkey::new_unique(),
        fee_bps_admin: 100,
        fee_bps_mega: 100,
        winner_bps: 9_800,
        mega_award_bps: 9_000,
        mega_trigger_modulus: 6_767,
        max_entries_per_round: args.max_entries_per_round,
        round_duration_secs: args.round_duration_secs,
        max_round_duration_secs: args.max_round_duration_secs,
        anti_snipe_window_secs: args.anti_snipe_window_secs,
        anti_snipe_extension_secs: args.anti_snipe_extension_secs,
        claim_deadline_secs: args.claim_deadline_secs,
        min_deposit_lamports: args.min_deposit_lamports,
        anti_snipe_min_deposit_lamports: args.anti_snipe_min_deposit_lamports,
        keeper_tip_lamports: args.keeper_tip_lamports,
        randomness_reveal_deadline_slots: args.randomness_reveal_deadline_slots,
        active_round_id,
        next_round_id,
        oracle_provider: OracleProvider::Switchboard,
        paused: false,
        bump: config_bump,
        auto_deposit_window_secs: 0,
        auto_deposit_tip_lamports: 0,
        auto_deposit_enabled: false,
        // The pre-migration zeros: refund 0, uncapped, version 0 (R6).
        refund_bps: 0,
        mega_field_bps: 0,
        mega_payout_cap_bps: 0,
        account_open_fee_lamports: 0,
        economics_version: 0,
        reserved: [0; 30],
    };
    let mut config_data = anchor_account_disc("GlobalConfig");
    config.serialize(&mut config_data).expect("config encode");

    let treasury_bump = Pubkey::find_program_address(&[b"treasury"], &PROGRAM_ID).1;
    let mut treasury_data = anchor_account_disc("TreasuryVault");
    TreasuryVault {
        accrued_lamports: 0,
        lifetime_accrued: 0,
        lifetime_swept: 0,
        bump: treasury_bump,
        reserved: [0; 32],
    }
    .serialize(&mut treasury_data)
    .expect("treasury encode");

    let mega_bump = Pubkey::find_program_address(&[b"mega_pot"], &PROGRAM_ID).1;
    let mut mega_data = anchor_account_disc("MegaPotVault");
    MegaPotVault {
        accrued_lamports: mega_lamports,
        lifetime_contributed: mega_lamports,
        lifetime_awarded: 0,
        trigger_count: 0,
        last_trigger_round_id: 0,
        cycle_index: 0,
        bump: mega_bump,
        reserved: [0; 32],
    }
    .serialize(&mut mega_data)
    .expect("mega encode");

    let owned = |data: Vec<u8>, extra: u64| Account {
        lamports: rent.minimum_balance(data.len()) + extra,
        data,
        owner: PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    };
    let extra = vec![
        (config_key(), owned(config_data, 0)),
        (treasury_key(), owned(treasury_data, 0)),
        (mega_pot_key(), owned(mega_data, mega_lamports)),
    ];
    Env::boot(1, [0u8; 32], extra, oracle_id).await
}

/// Case 10 — the migration latch, every guard against its exact error,
/// the I21 boundary accepted exactly, and the one-way lock afterwards.
#[tokio::test]
async fn migrate_economics_v2_guards_and_latch() {
    // The canonical migration args; individual fields perturbed per guard.
    let canonical = |cap: u32, fee: u64| (900u16, 8_900u16, 5_000u16, 4_000u16, 625u32, cap, fee);

    // A fresh initialize boots at version 2: the latch is already closed.
    let mut env = Env::setup(1, mock_value(1, 1)).await;
    let admin = env.admin.insecure_clone();
    let (w, r, a, f, m, cap, fee) = canonical(86_538, 10_000_000);
    env.send_fails_with(
        migrate_economics_v2_ix(admin.pubkey(), w, r, a, f, m, cap, fee),
        &[&admin],
        "EconomicsAlreadyMigrated",
    )
    .await;

    // The drained, quiet, round-less migration target.
    let admin = Keypair::new();
    let mut env = boot_migration_env(&admin, 0, 0, 0).await;

    // Guard 2 — the pot must be empty first.
    let drained_admin = Keypair::new();
    let mut drained = boot_migration_env(&drained_admin, SOL, 0, 0).await;
    let (w, r, a, f, m, cap, fee) = canonical(86_538, 10_000_000);
    drained
        .send_fails_with(
            migrate_economics_v2_ix(drained_admin.pubkey(), w, r, a, f, m, cap, fee),
            &[&drained_admin],
            "MegaPotNotDrained",
        )
        .await;

    // Guard 3 — no round in flight (active < next means one is unclosed).
    let flighty_admin = Keypair::new();
    let mut flighty = boot_migration_env(&flighty_admin, 0, 0, 1).await;
    let (w, r, a, f, m, cap, fee) = canonical(86_538, 10_000_000);
    flighty
        .send_fails_with(
            migrate_economics_v2_ix(flighty_admin.pubkey(), w, r, a, f, m, cap, fee),
            &[&flighty_admin],
            "RoundInFlight",
        )
        .await;

    // Guard 4 — the four-way sum must consume the denominator exactly.
    let (w, _r, a, f, m, cap, fee) = canonical(86_538, 10_000_000);
    env.send_fails_with(
        migrate_economics_v2_ix(admin.pubkey(), w, 8_899, a, f, m, cap, fee),
        &[&admin],
        "InvalidFeeSplit",
    )
    .await;
    // Guard 5 — the pop cannot pay more than one whole pot.
    let (w, r, _a, _f, m, cap, fee) = canonical(86_538, 10_000_000);
    env.send_fails_with(
        migrate_economics_v2_ix(admin.pubkey(), w, r, 6_000, 5_000, m, cap, fee),
        &[&admin],
        "InvalidFeeSplit",
    )
    .await;
    // Guard 6 — a zero modulus is a division by zero at settle.
    let (w, r, a, f, _m, cap, fee) = canonical(86_538, 10_000_000);
    env.send_fails_with(
        migrate_economics_v2_ix(admin.pubkey(), w, r, a, f, 0, cap, fee),
        &[&admin],
        "ZeroModulusConfig",
    )
    .await;
    // Guard 7 — uncapped is the pre-v2 grandfather only.
    let (w, r, a, f, m, _cap, fee) = canonical(86_538, 10_000_000);
    env.send_fails_with(
        migrate_economics_v2_ix(admin.pubkey(), w, r, a, f, m, 0, fee),
        &[&admin],
        "MegaFarmGuardViolated",
    )
    .await;
    // Guard 8 (I21) — one bps beyond the bound is rejected…
    let (w, r, a, f, m, _cap, fee) = canonical(86_539, 10_000_000);
    env.send_fails_with(
        migrate_economics_v2_ix(admin.pubkey(), w, r, a, f, m, 125_001, fee),
        &[&admin],
        "MegaFarmGuardViolated",
    )
    .await;
    // …and guard 9 — the fee ceiling.
    let (w, r, a, f, m, cap, _fee) = canonical(86_538, 50_000_001);
    env.send_fails_with(
        migrate_economics_v2_ix(admin.pubkey(), w, r, a, f, m, cap, 50_000_001),
        &[&admin],
        "AccountOpenFeeTooHigh",
    )
    .await;

    // The accept: AT the I21 bound exactly (625 × 200 = 125_000).
    let (w, r, a, f, m, cap, fee) = canonical(86_538, 10_000_000);
    env.send(
        migrate_economics_v2_ix(admin.pubkey(), w, r, a, f, m, cap, fee),
        &[&admin],
    )
    .await;
    let config = env.config().await;
    assert_eq!(config.economics_version, 2, "the latch closed");
    assert_eq!(config.winner_bps, w);
    assert_eq!(config.refund_bps, r);
    assert_eq!(config.mega_award_bps, a);
    assert_eq!(config.mega_field_bps, f);
    assert_eq!(config.mega_trigger_modulus, m);
    assert_eq!(config.mega_payout_cap_bps, cap);
    assert_eq!(config.account_open_fee_lamports, fee);

    // One-way: the latch can never re-open.
    let (w, r, a, f, m, cap, fee) = canonical(80_000, 10_000_000);
    env.send_fails_with(
        migrate_economics_v2_ix(admin.pubkey(), w, r, a, f, m, cap, fee),
        &[&admin],
        "EconomicsAlreadyMigrated",
    )
    .await;
}

/// Case 13 — the ADR-11 preflight drain: every guard against its exact
/// error, the lamport-exact drain with both vaults' books preserved, and
/// the full live cutover sequence — drain, migrate, latch kills the drain.
#[tokio::test]
async fn drain_mega_pot_v1_preflight_guards_drain_and_cutover() {
    // Guard: non-admin signer — the context constraint fires first.
    let admin = Keypair::new();
    let mut env = boot_migration_env(&admin, 3_069_000_000, 0, 0).await;
    let intruder = Keypair::new();
    env.send_fails_with(
        drain_mega_pot_v1_preflight_ix(intruder.pubkey()),
        &[&intruder],
        "UnauthorizedAdmin",
    )
    .await;

    // Guard: a round in flight (active < next) blocks the drain, the same
    // quiescence condition the migration itself reads.
    let flighty_admin = Keypair::new();
    let mut flighty = boot_migration_env(&flighty_admin, SOL, 0, 1).await;
    flighty
        .send_fails_with(
            drain_mega_pot_v1_preflight_ix(flighty_admin.pubkey()),
            &[&flighty_admin],
            "RoundInFlight",
        )
        .await;

    // Guard: version 2 — a fresh initialize boots with the latch closed,
    // and the preflight path is gone with it.
    let mut fresh = Env::setup(1, mock_value(1, 1)).await;
    let fresh_admin = fresh.admin.insecure_clone();
    fresh
        .send_fails_with(
            drain_mega_pot_v1_preflight_ix(fresh_admin.pubkey()),
            &[&fresh_admin],
            "EconomicsAlreadyMigrated",
        )
        .await;

    // The drain: the live devnet pot shape (3.069 SOL, never triggered).
    let mega_before = env.mega_pot().await;
    assert_eq!(mega_before.accrued_lamports, 3_069_000_000);
    assert_eq!(mega_before.lifetime_awarded, 0);
    let mega_balance_before = env.balance(mega_pot_key()).await;
    let treasury_balance_before = env.balance(treasury_key()).await;

    env.send(drain_mega_pot_v1_preflight_ix(admin.pubkey()), &[&admin])
        .await;

    let mega = env.mega_pot().await;
    assert_eq!(mega.accrued_lamports, 0, "drained to exactly zero");
    assert_eq!(mega.lifetime_contributed, 3_069_000_000, "history stays");
    assert_eq!(
        mega.lifetime_awarded, 3_069_000_000,
        "the payout is booked out of the pot (I3+I4 identity)"
    );
    assert_eq!(
        mega.trigger_count, 0,
        "not a trigger — odds statistics stay honest"
    );
    assert_eq!(mega.cycle_index, 0);
    let treasury = env.treasury().await;
    assert_eq!(treasury.accrued_lamports, 3_069_000_000);
    assert_eq!(treasury.lifetime_accrued, 3_069_000_000, "I2+I5 identity");
    assert_eq!(treasury.lifetime_swept, 0);

    // Lamport-exact balance moves: pot to its rent floor, treasury +amount.
    assert_eq!(
        env.balance(mega_pot_key()).await,
        mega_balance_before - 3_069_000_000
    );
    assert_eq!(
        env.balance(treasury_key()).await,
        treasury_balance_before + 3_069_000_000
    );

    // The pot is empty now: a re-drain refuses instead of a silent no-op.
    env.send_fails_with(
        drain_mega_pot_v1_preflight_ix(admin.pubkey()),
        &[&admin],
        "MegaPotAlreadyDrained",
    )
    .await;

    // THE CUTOVER: with the pot honestly drained, the migration's guard 2
    // passes and the latch closes.
    let (w, r, a, f, m, cap, fee) = (
        900u16,
        8_900u16,
        5_000u16,
        4_000u16,
        625u32,
        80_000u32,
        10_000_000u64,
    );
    env.send(
        migrate_economics_v2_ix(admin.pubkey(), w, r, a, f, m, cap, fee),
        &[&admin],
    )
    .await;
    let config = env.config().await;
    assert_eq!(
        config.economics_version, 2,
        "the live sequence: drain → migrate"
    );
    assert_eq!(config.winner_bps, w);
    assert_eq!(config.refund_bps, r);

    // The latch ate the preflight path: the drain can never run again.
    env.send_fails_with(
        drain_mega_pot_v1_preflight_ix(admin.pubkey()),
        &[&admin],
        "EconomicsAlreadyMigrated",
    )
    .await;
}

/// The whale proof, chain-realized: the same 5 SOL attacking stake, once
/// concentrated in one wallet and once split across five, collects
/// IDENTICAL lamports from identically-shaped rounds — the uniform dock is
/// what makes splitting worthless (R1). With a losing round of the same
/// shape, the realized EV over the two engineered outcomes is exactly −2%
/// of the stake, the flat rake.
#[tokio::test]
async fn whale_split_invariance_is_flat_minus_two_percent() {
    let mut env = Env::setup_adv(
        11,
        mock_value(1_000_000_000, 1), // round 0: ticket 1 SOL ∈ entry 1 (attacker)
        Box::new(|oracle_id| {
            // Round 1: same relative position (an attacker entry wins).
            // Round 2: ticket 6 SOL ∈ entry 6 — an "other" wins.
            vec![
                (
                    round_randomness_key(1),
                    mock_randomness_account(oracle_id, round_key(1), mock_value(1_000_000_000, 1)),
                ),
                (
                    round_randomness_key(2),
                    mock_randomness_account(oracle_id, round_key(2), mock_value(6_000_000_000, 1)),
                ),
            ]
        }),
    )
    .await;
    let aggregate = 5 * SOL;

    // Warm-up (Phase 11.6): every wallet's profile is created up front via
    // a terms-only escrow call, so the one-time escrow rent + fee (both 0
    // here) never pollute the per-round deltas this test measures.
    let wallets: Vec<Keypair> = env.players.iter().map(|k| k.insecure_clone()).collect();
    for wallet in &wallets {
        env.send(
            init_or_deposit_escrow_ix(wallet.pubkey(), 0, SOL / 10, 1, false),
            &[wallet],
        )
        .await;
    }

    // Plays one full round lifecycle: `depositors` (attacker stakes first,
    // then the others — ten 1 SOL entries in a fixed order) while the
    // aggregate delta is measured over `attacker_wallets` (the DISTINCT
    // wallets whose money is at stake — one wallet may own five entries).
    // Returns the net lamport delta of the attacker set (may be negative).
    async fn play_round(
        env: &mut Env,
        round_id: u64,
        depositors: &[Keypair],
        attacker_wallets: &[Pubkey],
    ) -> i128 {
        let payer = env.payer.pubkey();
        // Every prior round was fully closed by the previous call, so the
        // active pointer has retired: no predecessor to present.
        env.send(open_round_ix(payer, round_id, None), &[]).await;
        let mut before: i128 = 0;
        for wallet in attacker_wallets {
            before += i128::from(env.balance(*wallet).await);
        }
        for (index, kp) in depositors.iter().enumerate() {
            let k = kp.insecure_clone();
            env.send(deposit_ix(k.pubkey(), round_id, index as u32, SOL), &[&k])
                .await;
        }
        env.lock_and_settle(round_id).await;
        // Equal 1 SOL stakes partition the space: the winner's entry index
        // is readable straight off the ticket.
        let win_idx = (env.round(round_id).await.winning_ticket / SOL) as u32;
        let winner_kp = depositors[win_idx as usize].insecure_clone();
        env.send(
            claim_winnings_ix(round_id, win_idx, winner_kp.pubkey(), payer),
            &[],
        )
        .await;
        for (i, kp) in depositors.iter().enumerate() {
            let k = kp.insecure_clone();
            env.send(close_entry_ix(round_id, i as u32, k.pubkey(), payer), &[])
                .await;
        }
        // Phase 12: rents return to the opener of each round.
        env.send(close_round_ix(round_id, payer, payer), &[]).await;
        let mut after: i128 = 0;
        for wallet in attacker_wallets {
            after += i128::from(env.balance(*wallet).await);
        }
        after - before
    }

    let whale = env.players[0].insecure_clone();
    let others: Vec<Keypair> = env.players[1..6]
        .iter()
        .map(|k| k.insecure_clone())
        .collect();
    let splitters: Vec<Keypair> = env.players[6..11]
        .iter()
        .map(|k| k.insecure_clone())
        .collect();

    // Round 0 — concentrated: one wallet, five 1 SOL entries, wins.
    let mut depositors_r0: Vec<Keypair> = (0..5).map(|_| whale.insecure_clone()).collect();
    for k in &others {
        depositors_r0.push(k.insecure_clone());
    }
    let concentrated_win = play_round(&mut env, 0, &depositors_r0, &[whale.pubkey()]).await;

    // Round 1 — split: five wallets, one entry each, identical positions.
    let mut depositors_r1: Vec<Keypair> = splitters.iter().map(|k| k.insecure_clone()).collect();
    for k in &others {
        depositors_r1.push(k.insecure_clone());
    }
    let split_wallets: Vec<Pubkey> = splitters.iter().map(|k| k.pubkey()).collect();
    let split_win = play_round(&mut env, 1, &depositors_r1, &split_wallets).await;

    assert_eq!(
        concentrated_win, split_win,
        "R1: the same stake collects the same lamports however it is split"
    );
    assert_eq!(
        concentrated_win,
        i128::from(9 * SOL / 10 + 5 * 89 * SOL / 100) - i128::from(aggregate),
        "net: 0.9 prize + 5 × 0.89 refunds − 5 staked"
    );

    // Round 2 — concentrated but the OTHERS hold the winning range.
    let concentrated_lose = play_round(&mut env, 2, &depositors_r0, &[whale.pubkey()]).await;
    assert_eq!(
        concentrated_lose,
        i128::from(5 * 89 * SOL / 100) - i128::from(aggregate),
        "net: refunds only, −0.55 SOL on 5 staked"
    );

    // The realized EV across the two engineered outcomes (attacker share
    // θ = 1/2 ⇒ each with probability 1/2) is exactly the flat −2% rake.
    let ev = (concentrated_win + concentrated_lose) / 2;
    assert_eq!(
        ev,
        -i128::from(aggregate) / 50,
        "EV == −2% of the aggregate stake, to the lamport"
    );
}

// ─── phase 11.6: the universal account-open fee ────────────────────────────

/// The canonical fee for the battery (0.01 SOL), mirroring
/// `constants::ACCOUNT_OPEN_FEE_LAMPORTS`.
const ACCOUNT_OPEN_FEE: u64 = 10_000_000;

/// Boots with auto-deposit enabled AND the account-open fee live — both
/// halves of D1 in one environment.
async fn setup_with_fee(players: usize, value: [u8; 32]) -> Env {
    Env::setup_auto_deposit(
        players,
        value,
        |_| Vec::new(),
        |args| {
            args.account_open_fee_lamports = ACCOUNT_OPEN_FEE;
        },
    )
    .await
}

/// Case 1 — the escrow path charges on the fresh account only: first fund
/// pays stake-side cost + escrow rent + fee (fee → Mega-Pot, I3/I4 intact);
/// a re-fund pays the amount and nothing else.
#[tokio::test]
async fn account_open_fee_escrow_path_charges_once() {
    let mut env = setup_with_fee(2, mock_value(1, 1)).await;
    let owner = env.players[0].insecure_clone();
    let per_round = SOL / 10;
    let cost = round_cost(&mut env, per_round).await;
    let escrow_rent_min = env.rent_minimum(122).await;

    let before = env.balance(owner.pubkey()).await;
    env.fund_escrow(&owner, cost, per_round, 1, false).await;
    let after = env.balance(owner.pubkey()).await;
    assert_eq!(
        before - after,
        cost + escrow_rent_min + ACCOUNT_OPEN_FEE,
        "stake-side cost + rent + the one-time fee"
    );
    let mega = env.mega_pot().await;
    assert_eq!(
        mega.accrued_lamports, ACCOUNT_OPEN_FEE,
        "the fee seeds the pot"
    );
    assert_eq!(mega.lifetime_contributed, ACCOUNT_OPEN_FEE, "I4");
    let mega_account = env.account(mega_pot_key()).await.expect("mega");
    let mega_rent = env.rent_minimum(mega_account.data.len()).await;
    assert_eq!(mega_account.lamports, mega_rent + ACCOUNT_OPEN_FEE, "I3");

    // The re-fund charges nothing.
    let before = env.balance(owner.pubkey()).await;
    env.fund_escrow(&owner, cost, per_round, 2, false).await;
    let after = env.balance(owner.pubkey()).await;
    assert_eq!(before - after, cost, "amount only — never twice");
    assert_eq!(env.mega_pot().await.accrued_lamports, ACCOUNT_OPEN_FEE);
}

/// Case 2 — the deposit path: a first-ever bet creates a DORMANT profile
/// and charges the fee on top of both rents; the second bet charges
/// nothing and touches no profile term.
#[tokio::test]
async fn first_deposit_creates_dormant_profile_and_charges_the_fee() {
    let mut env = setup_with_fee(2, mock_value(1, 1)).await;
    let player = env.players[0].insecure_clone();
    let escrow_rent_min = env.rent_minimum(122).await;
    let entry_rent = env.rent_minimum(109).await;

    let payer = env.payer.pubkey();
    env.send(open_round_ix(payer, 0, None), &[]).await;
    let before = env.balance(player.pubkey()).await;
    env.send(deposit_ix(player.pubkey(), 0, 0, SOL), &[&player])
        .await;
    let after = env.balance(player.pubkey()).await;
    assert_eq!(
        before - after,
        SOL + entry_rent + escrow_rent_min + ACCOUNT_OPEN_FEE,
        "stake + entry rent + profile rent + one-time fee"
    );
    let esc = env.escrow(player.pubkey()).await;
    assert_eq!(esc.owner, player.pubkey());
    assert_eq!(esc.rounds_remaining, 0, "DORMANT (R5)");
    assert_eq!(esc.per_round_lamports, 0);
    assert_eq!(esc.max_rounds, 0);
    assert!(!esc.auto_reinvest);
    assert_eq!(
        esc.lifetime_deposited, 0,
        "a direct bet is not escrow money"
    );
    assert_eq!(env.mega_pot().await.accrued_lamports, ACCOUNT_OPEN_FEE);

    // The second bet: stake + entry rent, nothing else.
    let before = env.balance(player.pubkey()).await;
    env.send(deposit_ix(player.pubkey(), 0, 1, SOL), &[&player])
        .await;
    let after = env.balance(player.pubkey()).await;
    assert_eq!(before - after, SOL + entry_rent, "repeat bets are free");
    assert_eq!(env.mega_pot().await.accrued_lamports, ACCOUNT_OPEN_FEE);
}

/// Case 3 — once per wallet ACROSS the paths, both directions: whichever
/// instruction births the profile pays the fee; the other never does.
#[tokio::test]
async fn fee_is_once_per_wallet_across_both_paths() {
    let mut env = setup_with_fee(3, mock_value(1, 1)).await;
    let entry_rent = env.rent_minimum(109).await;
    let escrow_rent_min = env.rent_minimum(122).await;
    let per_round = SOL / 10;
    let cost = round_cost(&mut env, per_round).await;
    let payer = env.payer.pubkey();

    // (a) deposit first, escrow later: the fee rides the deposit.
    env.send(open_round_ix(payer, 0, None), &[]).await;
    let depositor = env.players[0].insecure_clone();
    let before = env.balance(depositor.pubkey()).await;
    env.send(deposit_ix(depositor.pubkey(), 0, 0, SOL), &[&depositor])
        .await;
    let after = env.balance(depositor.pubkey()).await;
    assert_eq!(
        before - after,
        SOL + entry_rent + escrow_rent_min + ACCOUNT_OPEN_FEE
    );
    let before = env.balance(depositor.pubkey()).await;
    env.fund_escrow(&depositor, cost, per_round, 1, false).await;
    let after = env.balance(depositor.pubkey()).await;
    assert_eq!(before - after, cost, "the escrow path is not charged again");

    // (b) escrow first, deposit later: the fee rides the escrow path.
    let escrower = env.players[1].insecure_clone();
    let before = env.balance(escrower.pubkey()).await;
    env.fund_escrow(&escrower, cost, per_round, 1, false).await;
    let after = env.balance(escrower.pubkey()).await;
    assert_eq!(before - after, cost + escrow_rent_min + ACCOUNT_OPEN_FEE);
    let before = env.balance(escrower.pubkey()).await;
    env.send(deposit_ix(escrower.pubkey(), 0, 1, SOL), &[&escrower])
        .await;
    let after = env.balance(escrower.pubkey()).await;
    assert_eq!(
        before - after,
        SOL + entry_rent,
        "the deposit path is not charged again"
    );

    // Exactly two charges for two wallets, however they arrived.
    assert_eq!(env.mega_pot().await.accrued_lamports, 2 * ACCOUNT_OPEN_FEE);
}

/// Case 4 — no silent enrolment: `crank_auto_deposit` refuses the dormant
/// profile a direct deposit created, with the exact budget error.
#[tokio::test]
async fn crank_refuses_a_deposit_created_dormant_profile() {
    let mut env = setup_with_fee(2, mock_value(1, 1)).await;
    let player = env.players[0].insecure_clone();
    let payer = env.payer.pubkey();
    env.send(open_round_ix(payer, 0, None), &[]).await;
    env.send(deposit_ix(player.pubkey(), 0, 0, SOL), &[&player])
        .await;

    env.send_fails_with(
        crank_auto_deposit_ix(0, 1, escrow_key(player.pubkey()), payer),
        &[],
        "EscrowBudgetExhausted",
    )
    .await;
    assert_eq!(env.round(0).await.entry_count, 1, "nothing was staked");
}

/// Case 5 — the direct depositor's refund lands in their WALLET (R5:
/// `entry.player` stays the wallet), and the dormant escrow is untouched
/// by the whole lifecycle.
#[tokio::test]
async fn direct_depositors_refund_lands_in_the_wallet() {
    let mut env = setup_with_fee(3, mock_value(2_000_000_002, 1)).await;
    env.open_and_deposit(&[SOL, 3 * SOL, 6 * SOL]).await;
    for i in 0..3u32 {
        let entry = env.entry(0, i).await;
        assert_eq!(
            entry.player,
            env.players[i as usize].pubkey(),
            "entry {i}: the wallet, never the escrow PDA"
        );
    }
    env.lock_request_and_settle().await;

    let payer = env.payer.pubkey();
    env.send(claim_winnings_ix(0, 1, env.players[1].pubkey(), payer), &[])
        .await;
    let wallet = env.players[0].insecure_clone();
    let escrow_addr = escrow_key(wallet.pubkey());
    let escrow_before = env.balance(escrow_addr).await;
    let entry_len = env.entry_account(0, 0).await.data.len();
    let entry_rent = env.rent_minimum(entry_len).await;
    let expected_refund = orbit_jackpot::math::entry_share(SOL, 89 * SOL / 10, 10 * SOL).unwrap();
    let before = env.balance(wallet.pubkey()).await;
    env.send(close_entry_ix(0, 0, wallet.pubkey(), payer), &[])
        .await;
    let after = env.balance(wallet.pubkey()).await;
    assert_eq!(
        after - before,
        expected_refund + entry_rent,
        "wallet, in full"
    );
    assert_eq!(
        env.balance(escrow_addr).await,
        escrow_before,
        "the dormant escrow is untouched by the refund"
    );
    assert_eq!(escrow_before, env.rent_minimum(122).await, "rent only");
}

/// Case 6 — a zero fee charges nothing on either path (the devnet default
/// until the migration sets it).
#[tokio::test]
async fn zero_fee_charges_nothing_on_either_path() {
    // Env::setup initializes with fee 0 (default_args).
    let mut env = Env::setup(3, mock_value(1, 1)).await;
    let entry_rent = env.rent_minimum(109).await;
    let escrow_rent_min = env.rent_minimum(122).await;
    let per_round = SOL / 10;
    let cost = round_cost(&mut env, per_round).await;

    let payer = env.payer.pubkey();
    env.send(open_round_ix(payer, 0, None), &[]).await;
    let player = env.players[0].insecure_clone();
    let before = env.balance(player.pubkey()).await;
    env.send(deposit_ix(player.pubkey(), 0, 0, SOL), &[&player])
        .await;
    let after = env.balance(player.pubkey()).await;
    assert_eq!(
        before - after,
        SOL + entry_rent + escrow_rent_min,
        "no fee on the deposit path"
    );

    let escrower = env.players[1].insecure_clone();
    let before = env.balance(escrower.pubkey()).await;
    env.fund_escrow(&escrower, cost, per_round, 1, false).await;
    let after = env.balance(escrower.pubkey()).await;
    assert_eq!(
        before - after,
        cost + escrow_rent_min,
        "no fee on the escrow path (rent + amount only)"
    );
    assert_eq!(env.mega_pot().await.accrued_lamports, 0, "nothing seeded");
}

// ─── phase 5.13: on-chain KAT replay of the entropy fixture ───────────────

/// One vector of the committed cross-language fixture (ADR-9). Wide
/// integers are decimal strings, exactly as serialized.
#[derive(serde::Deserialize, Clone)]
struct KatVector {
    raw_seed_hex: String,
    #[allow(dead_code)]
    ticket_seed_u128: String,
    #[allow(dead_code)]
    mega_seed_u128: String,
    sample_total_lamports: String,
    winning_ticket: String,
    #[allow(dead_code)]
    expected_theta_degrees: String, // client-side (Phase 6); no chain analog
    mega_triggered: bool,
    expected_admin_cut: String,
    expected_mega_cut: String,
    expected_winner_payout: String,
    expected_refund_pool: String,
    #[allow(dead_code)]
    sample_mega_accrued: String, // pure-math mirror fields; no chain analog
    #[allow(dead_code)]
    expected_mega_payable: String,
    #[allow(dead_code)]
    expected_mega_awarded: String,
    #[allow(dead_code)]
    expected_mega_field_pool: String,
    #[allow(dead_code)]
    expected_mega_retained: String,
}

fn hex32(hex: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).expect("fixture hex");
    }
    out
}

/// Boots ONE runtime hosting one pre-crafted `Locked` round per replayed
/// vector: `total_lamports` is set directly (the settle math is a function
/// of `(value, total)` alone; the deposit path is covered by scenarios 1-6),
/// the vault is funded `rent + total`, and each round's randomness mock
/// carries the fixture's raw seed at the round's own PDA.
///
/// Vectors whose `sample_total_lamports` exceeds the test genesis supply
/// (~10^9 SOL) cannot be vault-funded here; their full-domain math is
/// already discharged by Phase 1's property tests, and every remaining
/// class (tiny, prime, realistic, boundary tickets, triggers) replays.
async fn boot_kat_replay(vectors: &[KatVector]) -> Env {
    use borsh::BorshSerialize;
    let oracle_id = Pubkey::new_unique();
    let rent = solana_sdk::rent::Rent::default();

    let mut extra: Vec<(Pubkey, Account)> = Vec::new();
    let owned = |data: Vec<u8>, extra_lamports: u64| Account {
        lamports: rent
            .minimum_balance(data.len())
            .checked_add(extra_lamports)
            .expect("lamports"),
        data,
        owner: PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    };

    // Singletons: config with the canonical v2 economics, empty treasury
    // and pot — matching the regenerated Phase 11 fixture.
    let config_bump = Pubkey::find_program_address(&[b"config"], &PROGRAM_ID).1;
    let mut args = default_args();
    args.oracle_program_id = oracle_id;
    let config = GlobalConfig {
        admin: Pubkey::new_unique(),
        pending_admin: None,
        treasury_authority: Pubkey::new_unique(),
        oracle_program_id: oracle_id,
        oracle_queue: Pubkey::new_unique(),
        fee_bps_admin: 100,
        fee_bps_mega: 100,
        winner_bps: 900,
        mega_award_bps: 5_000,
        mega_trigger_modulus: 625,
        max_entries_per_round: args.max_entries_per_round,
        round_duration_secs: args.round_duration_secs,
        max_round_duration_secs: args.max_round_duration_secs,
        anti_snipe_window_secs: args.anti_snipe_window_secs,
        anti_snipe_extension_secs: args.anti_snipe_extension_secs,
        claim_deadline_secs: args.claim_deadline_secs,
        min_deposit_lamports: args.min_deposit_lamports,
        anti_snipe_min_deposit_lamports: args.anti_snipe_min_deposit_lamports,
        keeper_tip_lamports: args.keeper_tip_lamports,
        randomness_reveal_deadline_slots: args.randomness_reveal_deadline_slots,
        active_round_id: 0,
        next_round_id: 0,
        oracle_provider: OracleProvider::Switchboard,
        paused: false,
        bump: config_bump,
        auto_deposit_window_secs: 0,
        auto_deposit_tip_lamports: 0,
        auto_deposit_enabled: false,
        // Phase 11 canonical economics — the v2 fixture was regenerated
        // against exactly these constants.
        refund_bps: 8_900,
        mega_field_bps: 4_000,
        mega_payout_cap_bps: 80_000,
        account_open_fee_lamports: 0,
        economics_version: 2,
        reserved: [0; 30],
    };
    let mut config_data = anchor_account_disc("GlobalConfig");
    config.serialize(&mut config_data).expect("config encode");
    extra.push((config_key(), owned(config_data, 0)));

    let treasury_bump = Pubkey::find_program_address(&[b"treasury"], &PROGRAM_ID).1;
    let mut treasury_data = anchor_account_disc("TreasuryVault");
    TreasuryVault {
        accrued_lamports: 0,
        lifetime_accrued: 0,
        lifetime_swept: 0,
        bump: treasury_bump,
        reserved: [0; 32],
    }
    .serialize(&mut treasury_data)
    .expect("treasury encode");
    extra.push((treasury_key(), owned(treasury_data, 0)));

    let mega_bump = Pubkey::find_program_address(&[b"mega_pot"], &PROGRAM_ID).1;
    let mut mega_data = anchor_account_disc("MegaPotVault");
    MegaPotVault {
        accrued_lamports: 0,
        lifetime_contributed: 0,
        lifetime_awarded: 0,
        trigger_count: 0,
        last_trigger_round_id: 0,
        cycle_index: 0,
        bump: mega_bump,
        reserved: [0; 32],
    }
    .serialize(&mut mega_data)
    .expect("mega encode");
    extra.push((mega_pot_key(), owned(mega_data, 0)));

    // One Locked round + funded vault + randomness mock per vector.
    for (i, vector) in vectors.iter().enumerate() {
        let round_id = i as u64;
        let total: u64 = vector.sample_total_lamports.parse().expect("total");
        let value = hex32(&vector.raw_seed_hex);

        let round_bump =
            Pubkey::find_program_address(&[b"round", &round_id.to_le_bytes()], &PROGRAM_ID).1;
        let vault_bump =
            Pubkey::find_program_address(&[b"round_vault", &round_id.to_le_bytes()], &PROGRAM_ID).1;
        let mut round_data = anchor_account_disc("Round");
        Round {
            round_id,
            state: RoundState::Locked,
            start_ts: 0,
            end_ts: 0,
            lock_ts: 0,
            lock_slot: 1,
            settle_ts: 0,
            total_lamports: total,
            entry_count: 1,
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
            vault_owed: total,
            mega_triggered: false,
            prize_claimed: false,
            vault_bump,
            bump: round_bump,
            refund_pool: 0,
            refunds_paid: 0,
            mega_field_pool: 0,
            mega_field_paid: 0,
            rent_payer: Pubkey::default(),
        }
        .serialize(&mut round_data)
        .expect("round encode");
        extra.push((round_key(round_id), owned(round_data, 0)));

        let mut vault_data = anchor_account_disc("RoundVault");
        RoundVault {
            round_id,
            bump: vault_bump,
            reserved: [0; 16],
        }
        .serialize(&mut vault_data)
        .expect("vault encode");
        extra.push((round_vault_key(round_id), owned(vault_data, total)));

        extra.push((
            round_randomness_key(round_id),
            mock_randomness_account(oracle_id, round_key(round_id), value),
        ));
    }

    Env::boot(1, [0u8; 32], extra, oracle_id).await
}

#[tokio::test]
async fn kat_replay_on_chain() {
    let started = Instant::now();
    let fixture_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/entropy_kat.json");
    let fixture = std::fs::read_to_string(&fixture_path)
        .unwrap_or_else(|_| panic!("fixture missing at {}", fixture_path.display()));
    let vectors: Vec<KatVector> = serde_json::from_str(&fixture).expect("fixture is valid JSON");
    assert!(vectors.len() >= 64, "ADR-9 minimum of 64 vectors");

    // Genesis-fundable subset (see boot_kat_replay docs).
    const GENESIS_CAP: u64 = 1_000_000_000_000_000;
    let replayable: Vec<&KatVector> = vectors
        .iter()
        .filter(|v| {
            let total: u64 = v.sample_total_lamports.parse().expect("total");
            total <= GENESIS_CAP
        })
        .collect();
    let skipped = vectors.len() - replayable.len();
    let triggers = replayable.iter().filter(|v| v.mega_triggered).count();
    assert!(triggers >= 3, "triggering vectors must replay");
    assert!(replayable.len() >= 64 - skipped);

    let owned_replayable: Vec<KatVector> = replayable.into_iter().cloned().collect();
    let mut env = boot_kat_replay(&owned_replayable).await;

    // The pot's expected accrual, tracked vector by vector: each settle
    // contributes its mega cut, and a trigger pays out of the balance as
    // it stood BEFORE that contribution (the ADR-8 basis) — computed here
    // through the program's own pure functions, the same ones the fixture
    // was generated from.
    let mut expected_accrual: u64 = 0;
    let mut expected_treasury: u64 = 0;
    let mut expected_triggers: usize = 0;

    for (i, vector) in owned_replayable.iter().enumerate() {
        let round_id = i as u64;
        let expected_total: u64 = vector.sample_total_lamports.parse().expect("total");
        let expected_ticket: u64 = vector.winning_ticket.parse().expect("ticket");
        let expected_admin: u64 = vector.expected_admin_cut.parse().expect("admin");
        let expected_mega: u64 = vector.expected_mega_cut.parse().expect("mega");
        let expected_winner: u64 = vector.expected_winner_payout.parse().expect("winner");
        let expected_refund: u64 = vector.expected_refund_pool.parse().expect("refund");

        let payer = env.payer.pubkey();
        env.send(
            request_randomness_ix(round_id, round_randomness_key(round_id), payer),
            &[],
        )
        .await;
        env.send(
            fulfill_settle_ix(round_id, round_randomness_key(round_id), payer),
            &[],
        )
        .await;

        let round = env.round(round_id).await;
        assert_eq!(round.state, RoundState::Settled, "vector {i}");
        assert_eq!(round.total_lamports, expected_total, "vector {i} total");
        // Bit-for-bit ticket parity with the fixture — the parity that keeps
        // the client wheel and the chain on the same outcome.
        assert_eq!(round.winning_ticket, expected_ticket, "vector {i} ticket");
        assert_eq!(round.admin_cut, expected_admin, "vector {i} admin cut");
        assert_eq!(round.mega_cut, expected_mega, "vector {i} mega cut");
        assert_eq!(round.winner_payout, expected_winner, "vector {i} payout");
        assert_eq!(round.refund_pool, expected_refund, "vector {i} refund pool");
        assert_eq!(
            round.mega_triggered, vector.mega_triggered,
            "vector {i} trigger"
        );
        // I10: a settled ticket is strictly inside the space.
        assert!(
            round.winning_ticket < round.total_lamports,
            "vector {i} I10"
        );
        // I18: the four-way split reassembles the pot to the lamport.
        assert_eq!(
            round.winner_payout + round.refund_pool + round.admin_cut + round.mega_cut,
            round.total_lamports,
            "vector {i} I18"
        );

        // Mega accounting chain across the whole replay (I4/I19 semantics):
        // the split runs against the PRE-contribution accrual.
        let awarded_before = expected_accrual;
        let (awarded, field) = if vector.mega_triggered {
            expected_triggers += 1;
            let split = orbit_jackpot::math::split_mega_pot(
                awarded_before,
                expected_total,
                orbit_jackpot::constants::MEGA_AWARD_BPS,
                orbit_jackpot::constants::MEGA_FIELD_BPS,
                orbit_jackpot::constants::MEGA_PAYOUT_CAP_BPS,
            )
            .expect("canonical mega bps");
            (split.awarded, split.field_pool)
        } else {
            (0, 0)
        };
        expected_accrual = expected_accrual + expected_mega - (awarded + field);
        expected_treasury += expected_admin;
        assert_eq!(round.mega_awarded, awarded, "vector {i} mega award");
        assert_eq!(round.mega_field_pool, field, "vector {i} field pool");
        assert_eq!(
            round.randomness_seed_slot, MOCK_SEED_SLOT,
            "vector {i} audit slot"
        );
    }

    assert_eq!(expected_triggers, triggers);

    // End-of-replay books: I3/I4 on the pot, I2/I5 on the treasury.
    let mega = env.mega_pot().await;
    assert_eq!(mega.accrued_lamports, expected_accrual);
    assert_eq!(mega.trigger_count, triggers as u64);
    assert_eq!(
        mega.lifetime_contributed - mega.lifetime_awarded,
        mega.accrued_lamports
    );
    let treasury = env.treasury().await;
    assert_eq!(treasury.accrued_lamports, expected_treasury);
    assert_eq!(
        treasury.lifetime_accrued - treasury.lifetime_swept,
        treasury.accrued_lamports
    );

    println!(
        "kat_replay: {} of {} vectors replayed on-chain ({} skipped above the genesis-fundable cap, {} Mega triggers) in {:?}",
        owned_replayable.len(),
        vectors.len(),
        skipped,
        triggers,
        started.elapsed()
    );
}

// ─── phase 5.13: compute unit profile ──────────────────────────────────────

impl Env {
    /// Simulates (for `units_consumed`), then executes for real.
    async fn measured_send(
        &mut self,
        ix: Instruction,
        label: &'static str,
        extra_signers: &[&Keypair],
        table: &mut Vec<(&'static str, u64)>,
    ) {
        self.reclaim_before_close(&ix).await;
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend(extra_signers.iter());
        let mut tx = Transaction::new_with_payer(&[ix], Some(&self.payer.pubkey()));
        let blockhash = self.banks.get_latest_blockhash().await.expect("blockhash");
        tx.sign(&signers, blockhash);
        let sim = self
            .banks
            .simulate_transaction(tx.clone())
            .await
            .expect("simulation transport");
        let simulation_ok = matches!(&sim.result, Some(Ok(())));
        assert!(simulation_ok, "{label} simulation failed: {:?}", sim.result);
        let units = sim
            .simulation_details
            .as_ref()
            .map(|details| details.units_consumed)
            .unwrap_or_default();
        self.banks
            .process_transaction_with_preflight(tx)
            .await
            .expect("tx must succeed");
        table.push((label, units));
    }

    /// The multi-instruction counterpart — how the keeper actually sends
    /// `crank_auto_deposit` batches (§5.4): one tx, N instructions.
    async fn measured_send_batch(
        &mut self,
        ixs: &[Instruction],
        label: &'static str,
        extra_signers: &[&Keypair],
        table: &mut Vec<(&'static str, u64)>,
    ) {
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend(extra_signers.iter());
        let mut tx = Transaction::new_with_payer(ixs, Some(&self.payer.pubkey()));
        let blockhash = self.banks.get_latest_blockhash().await.expect("blockhash");
        tx.sign(&signers, blockhash);
        let sim = self
            .banks
            .simulate_transaction(tx.clone())
            .await
            .expect("simulation transport");
        assert!(
            matches!(&sim.result, Some(Ok(()))),
            "{label} simulation failed: {:?}",
            sim.result
        );
        let units = sim
            .simulation_details
            .as_ref()
            .map(|details| details.units_consumed)
            .unwrap_or_default();
        self.banks
            .process_transaction_with_preflight(tx)
            .await
            .expect("tx must succeed");
        table.push((label, units));
    }
}

#[tokio::test]
async fn cu_profile() {
    let started = Instant::now();
    let mut table: Vec<(&'static str, u64)> = Vec::new();

    // Round 0: full happy path with the anti-snipe branch live. Boot is
    // manual so `initialize` itself can be measured.
    let no_trigger = mock_value(2_000_000_002, 1); // winner: player 2
    let trigger = mock_value(3, 625); // winner: player 1, Mega fires (v2 modulus)
    let oracle_id = Pubkey::new_unique();
    let extra = vec![(
        round_randomness_key(1),
        mock_randomness_account(oracle_id, round_key(1), trigger),
    )];
    let mut env = Env::boot(2, no_trigger, extra, oracle_id).await;

    let mut args = default_args();
    args.oracle_program_id = env.oracle_id;
    args.oracle_queue = env.queue_id;
    args.treasury_authority = env.payer.pubkey();
    let admin = env.admin.insecure_clone();
    env.measured_send(
        initialize_ix(&admin, &args),
        "initialize",
        &[&admin],
        &mut table,
    )
    .await;

    // Turn the anti-snipe extension on for the measured deposits.
    let args = UpdateConfigArgs {
        anti_snipe_window_secs: Some(10),
        anti_snipe_extension_secs: Some(10),
        anti_snipe_min_deposit_lamports: Some(SOL / 20),
        ..UpdateConfigArgs::default()
    };
    let admin = env.admin.insecure_clone();
    env.measured_send(
        update_config_ix(admin.pubkey(), &args),
        "update_config",
        &[&admin],
        &mut table,
    )
    .await;

    let payer = env.payer.pubkey();
    env.measured_send(open_round_ix(payer, 0, None), "open_round", &[], &mut table)
        .await;

    let p1 = env.players[0].insecure_clone();
    env.measured_send(
        deposit_ix(p1.pubkey(), 0, 0, SOL),
        "deposit (first)",
        &[&p1],
        &mut table,
    )
    .await;

    // Move inside the last-10-seconds window, then a qualifying deposit —
    // the extension branch must run (and be measured).
    env.advance_seconds(ROUND_DURATION_SECS - 3).await;
    let before_end = env.round(0).await.end_ts;
    let p2 = env.players[1].insecure_clone();
    env.measured_send(
        deposit_ix(p2.pubkey(), 0, 1, 3 * SOL),
        "deposit (anti-snipe ext)",
        &[&p2],
        &mut table,
    )
    .await;
    let after_end = env.round(0).await.end_ts;
    assert!(after_end > before_end, "the extension branch actually ran");

    env.advance_past_end(0).await;
    let payer = env.payer.pubkey();
    env.measured_send(lock_round_ix(0, payer), "lock_round", &[], &mut table)
        .await;
    let payer = env.payer.pubkey();
    env.measured_send(
        request_randomness_ix(0, round_randomness_key(0), payer),
        "request_randomness",
        &[],
        &mut table,
    )
    .await;
    let payer = env.payer.pubkey();
    env.measured_send(
        fulfill_settle_ix(0, round_randomness_key(0), payer),
        "fulfill_settle (no trigger)",
        &[],
        &mut table,
    )
    .await;
    let payer = env.payer.pubkey();
    env.measured_send(
        claim_winnings_ix(0, 1, env.players[1].pubkey(), payer),
        "claim_winnings",
        &[],
        &mut table,
    )
    .await;
    let payer = env.payer.pubkey();
    env.measured_send(
        close_entry_ix(0, 0, env.players[0].pubkey(), payer),
        "close_entry",
        &[],
        &mut table,
    )
    .await;
    let payer = env.payer.pubkey();
    env.measured_send(
        close_entry_ix(0, 1, env.players[1].pubkey(), payer),
        "close_entry (winner)",
        &[],
        &mut table,
    )
    .await;
    let payer = env.payer.pubkey();
    env.measured_send(
        // Phase 12: rents return to the opener (the harness payer).
        close_round_ix(0, payer, payer),
        "close_round",
        &[],
        &mut table,
    )
    .await;

    // Round 1: the Mega-Pot fires (pot already holds round 0's 1%).
    let payer = env.payer.pubkey();
    env.measured_send(
        open_round_ix(payer, 1, None),
        "open_round (second)",
        &[],
        &mut table,
    )
    .await;
    let p1 = env.players[0].insecure_clone();
    let p2 = env.players[1].insecure_clone();
    env.measured_send(
        deposit_ix(p1.pubkey(), 1, 0, SOL),
        "deposit (repeat, profile exists)",
        &[&p1],
        &mut table,
    )
    .await;
    env.send(deposit_ix(p2.pubkey(), 1, 1, SOL), &[&p2]).await;
    env.advance_past_end(1).await;
    let payer = env.payer.pubkey();
    env.send(lock_round_ix(1, payer), &[]).await;
    let payer = env.payer.pubkey();
    env.send(
        request_randomness_ix(1, round_randomness_key(1), payer),
        &[],
    )
    .await;
    let payer = env.payer.pubkey();
    env.measured_send(
        fulfill_settle_ix(1, round_randomness_key(1), payer),
        "fulfill_settle (mega trigger)",
        &[],
        &mut table,
    )
    .await;
    assert!(env.round(1).await.mega_triggered, "trigger branch ran");

    // Round 2: sole depositor — auto-cancel at lock, then a measured refund.
    let payer = env.payer.pubkey();
    env.send(open_round_ix(payer, 2, Some(round_key(1))), &[])
        .await;
    let p1 = env.players[0].insecure_clone();
    env.send(deposit_ix(p1.pubkey(), 2, 0, 2 * SOL), &[&p1])
        .await;
    env.advance_past_end(2).await;
    let payer = env.payer.pubkey();
    env.measured_send(
        lock_round_ix(2, payer),
        "lock_round (auto-cancel)",
        &[],
        &mut table,
    )
    .await;
    let payer = env.payer.pubkey();
    env.measured_send(
        refund_entry_ix(2, 0, env.players[0].pubkey(), payer),
        "refund_entry",
        &[],
        &mut table,
    )
    .await;

    // ── phase 10: escrow auto-deposit (single + the keeper's 6-batch) ──
    // Enable through the production path (update_config); round 3 stays
    // open, so the escrows crank straight into it.
    let admin = env.admin.insecure_clone();
    env.send(
        update_config_ix(
            admin.pubkey(),
            &UpdateConfigArgs {
                auto_deposit_window_secs: Some(AUTO_DEPOSIT_WINDOW_SECS),
                auto_deposit_tip_lamports: Some(AUTO_DEPOSIT_TIP_LAMPORTS),
                auto_deposit_enabled: Some(true),
                ..UpdateConfigArgs::default()
            },
        ),
        &[&admin],
    )
    .await;
    let payer = env.payer.pubkey();
    env.send(open_round_ix(payer, 3, Some(round_key(2))), &[])
        .await;

    let cost = round_cost(&mut env, SOL / 10).await;
    let mut cranks = Vec::with_capacity(7);
    for i in 0..7usize {
        let owner = Keypair::new();
        let payer = env.payer.pubkey();
        env.send(sol_transfer(payer, owner.pubkey(), 10 * SOL), &[])
            .await;
        // Escrow 0 carries an extra SOL/10 of spendable so the withdrawal
        // measurement at the end has something to pay out.
        let amount = cost + u64::from(i == 0) * (SOL / 10);
        let ix = init_or_deposit_escrow_ix(owner.pubkey(), amount, SOL / 10, 1, false);
        if i == 0 {
            env.measured_send(ix, "init_or_deposit_escrow (fund)", &[&owner], &mut table)
                .await;
        } else {
            env.send(ix, &[&owner]).await;
        }
        let escrow_addr = escrow_key(owner.pubkey());
        cranks.push((owner, escrow_addr));
    }
    // The terms-only path (amount == 0) against an existing escrow.
    env.measured_send(
        init_or_deposit_escrow_ix(cranks[0].0.pubkey(), 0, SOL / 10, 1, false),
        "init_or_deposit_escrow (terms only)",
        &[&cranks[0].0],
        &mut table,
    )
    .await;

    // Single crank — entry index 0 of the fresh round; the crank IS the
    // fee payer here, so no extra signer.
    let payer = env.payer.pubkey();
    env.measured_send(
        crank_auto_deposit_ix(3, 0, cranks[0].1, payer),
        "crank_auto_deposit (single)",
        &[],
        &mut table,
    )
    .await;

    // The keeper's batching unit: six escrows, entry indices 1..=6.
    let payer = env.payer.pubkey();
    let batch: Vec<Instruction> = (0..6usize)
        .map(|i| crank_auto_deposit_ix(3, 1 + i as u32, cranks[i + 1].1, payer))
        .collect();
    env.measured_send_batch(&batch, "crank_auto_deposit (6-batch)", &[], &mut table)
        .await;
    assert_eq!(env.round(3).await.entry_count, 7);

    // The fund exit — escrow 0 kept an extra SOL/10 spendable.
    env.measured_send(
        withdraw_escrow_ix(cranks[0].0.pubkey(), SOL / 20),
        "withdraw_escrow",
        &[&cranks[0].0],
        &mut table,
    )
    .await;

    // ── ceilings ──
    for (label, units) in &table {
        assert!(
            *units < 200_000,
            "{label} consumed {units} CU — beyond the default budget"
        );
    }
    for (label, units) in &table {
        if label.starts_with("deposit")
            || label.starts_with("fulfill_settle")
            || label.starts_with("crank_auto_deposit (single)")
        {
            assert!(
                *units < 100_000,
                "hot path {label} consumed {units} CU — beyond the strict ceiling"
            );
        }
    }
    // The 6-batch rides the 200k default budget (checked by the loop
    // above); its measured total is the basis for
    // CRANK_AUTO_DEPOSIT_MAX_PER_TX, reported in docs/reports/cu_profile.md.

    println!("{:<28} {:>8}", "Instruction", "CU");
    for (label, units) in &table {
        println!("{label:<28} {units:>8}");
    }
    println!("cu_profile finished in {:?}", started.elapsed());
}

// ─── phase 8.1: the commit transport ──────────────────────────────────────

/// Deterministic key for round 0's UNREVEALED mock (the commit-pipeline
/// counterpart of `round_randomness_key`).
fn unrevealed_randomness_key() -> Pubkey {
    Pubkey::find_program_address(&[b"mock_unrevealed", &[0]], &PROGRAM_ID).0
}

/// The full live pipeline — lock → CREATE (round PDA signs the
/// `randomness_init` CPI with a fresh keypair) → pin → COMMIT (round PDA
/// signs `randomness_commit`) → settle-refused → REVEAL (round PDA signs
/// `randomness_reveal`, crank presents the gateway payload) → settle. This
/// is the only test where the account is born, committed and revealed
/// ON-CHAIN rather than genesis-preloaded, so it proves every account
/// order, discriminator and PDA-signature semantic end-to-end.
#[tokio::test]
async fn commit_randomness_commits_and_settles_the_live_pipeline() {
    let started = Instant::now();
    let (mut env, random_kp, program_state, lut_signer) = Env::setup_create_flow(3).await;
    let mock_key = random_kp.pubkey();

    env.open_and_deposit(&[SOL, 3 * SOL, 6 * SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    let payer = env.payer.pubkey();
    env.send(lock_round_ix(0, payer), &[]).await;
    let lock_slot = env.round(0).await.lock_slot;

    // ── phase 0: CREATE — the account keypair signs, the round PDA signs
    // the CPI as the authority the deployed program demands ──
    let recent_slot = env.clock().await.slot;
    env.send(
        create_randomness_ix(
            0,
            mock_key,
            env.queue_id,
            payer,
            program_state,
            lut_signer,
            env.oracle_id,
            recent_slot,
        ),
        &[&random_kp],
    )
    .await;
    let data = env.account(mock_key).await.expect("created mock").data;
    assert_eq!(
        &data[8..40],
        round_key(0).as_ref(),
        "the CPI wrote the round PDA as authority"
    );
    assert_eq!(&data[40..72], env.queue_id.as_ref(), "queue written");

    // Pin, then a small warp so the commit lands strictly after the lock
    // slot (ADR-4 check 3 is strict: `seed_slot > lock_slot`).
    env.send(request_randomness_ix(0, mock_key, payer), &[])
        .await;
    let slot = env.clock().await.slot;
    let _ = env.context.warp_to_slot(slot + 32);

    env.send(
        commit_randomness_ix(
            0,
            mock_key,
            env.queue_id,
            env.oracle_key,
            env.oracle_id,
            payer,
        ),
        &[],
    )
    .await;

    // ── phase 1: the commit SEEDED the account; it has NOT revealed ──
    let data = env.account(mock_key).await.expect("committed mock").data;
    let seed_slot = u64::from_le_bytes(data[104..112].try_into().expect("seed slot bytes"));
    let oracle_written: [u8; 32] = data[112..144].try_into().expect("oracle bytes");
    assert!(
        seed_slot > lock_slot,
        "seed {seed_slot} must lead lock {lock_slot}"
    );
    assert_eq!(
        oracle_written,
        env.oracle_key.as_ref(),
        "the oracle assignment landed"
    );
    assert_eq!(&data[144..152], &[0u8; 8], "NOT revealed at commit");
    assert_eq!(&data[152..184], &[0u8; 32], "value absent at commit");

    // Settle before the reveal refuses — the value is not observable yet.
    env.send_fails_with(
        fulfill_settle_ix(0, mock_key, payer),
        &[],
        "RandomnessNotRevealed",
    )
    .await;

    // Exactly-once: a second commit can never re-seed (seed_slot != 0 now).
    env.send_fails_with(
        commit_randomness_ix(
            0,
            mock_key,
            env.queue_id,
            env.oracle_key,
            env.oracle_id,
            payer,
        ),
        &[],
        "RandomnessAlreadyCommitted",
    )
    .await;

    // ── phase 2: the crank presents the gateway payload THROUGH our
    // program — the round PDA signs the reveal CPI (exactly-once) ──
    let value =
        solana_sdk::hash::hashv(&[b"gateway reveal stand-in", &seed_slot.to_le_bytes()]).to_bytes();
    let stats = Pubkey::find_program_address(
        &[b"OracleRandomnessStats", env.oracle_key.as_ref()],
        &env.oracle_id,
    )
    .0;
    env.send(
        reveal_randomness_ix(
            0,
            mock_key,
            env.oracle_key,
            env.queue_id,
            stats,
            program_state,
            env.oracle_id,
            payer,
            value,
        ),
        &[],
    )
    .await;
    // A second reveal is refused — the value is immutable from here on.
    env.send_fails_with(
        reveal_randomness_ix(
            0,
            mock_key,
            env.oracle_key,
            env.queue_id,
            stats,
            program_state,
            env.oracle_id,
            payer,
            value,
        ),
        &[],
        "RandomnessAlreadyRevealed",
    )
    .await;
    let data = env.account(mock_key).await.expect("revealed mock").data;
    let reveal_slot = u64::from_le_bytes(data[144..152].try_into().expect("reveal slot bytes"));
    assert!(
        reveal_slot > 0,
        "reveal_slot > 0 marks the account revealed"
    );
    let committed_value: [u8; 32] = data[152..184].try_into().expect("value bytes");
    assert_eq!(committed_value, value, "the gateway value landed");
    assert_eq!(
        seed_slot,
        u64::from_le_bytes(data[104..112].try_into().expect("seed slot re-read")),
        "the reveal never re-seeds"
    );

    // Settle on the LIVE-committed value — outcome recomputed independently
    // through the program's own (KAT-proven) pure functions.
    env.send(fulfill_settle_ix(0, mock_key, payer), &[]).await;
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::Settled);
    assert_eq!(round.randomness_account, mock_key);
    assert_eq!(round.randomness_seed_slot, seed_slot);
    let (ticket_seed, _mega_seed) = orbit_jackpot::entropy::split_entropy(&committed_value);
    let expected_ticket =
        orbit_jackpot::math::ticket_from_entropy(ticket_seed, 10 * SOL).expect("ticket mirror");
    assert_eq!(round.winning_ticket, expected_ticket);
    // I18 — the four-way split still reassembles the pot exactly.
    assert_eq!(
        round.winner_payout + round.refund_pool + round.admin_cut + round.mega_cut,
        round.total_lamports
    );
    env.assert_round_vault_solvent(0).await;
    println!("commit pipeline finished in {:?}", started.elapsed());
}

/// The commit guards, each against the exact named error (5.x discipline):
/// wrong state, unpinned/different account, wrong queue (owner- and
/// key-level), wrong switchboard program. The commit-time authority
/// re-check is unreachable through valid state — the pin already enforces
/// authority = round PDA — so it is belt-only, same as at settle.
#[tokio::test]
async fn commit_randomness_guard_battery() {
    let mock_key = unrevealed_randomness_key();
    let mut env = Env::setup_commit_flow(2, mock_key).await;

    env.open_and_deposit(&[2 * SOL, 5 * SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    let payer = env.payer.pubkey();
    env.send(lock_round_ix(0, payer), &[]).await;

    // (a) commit while still Locked (no pin yet) — state first, by design.
    env.send_fails_with(
        commit_randomness_ix(
            0,
            mock_key,
            env.queue_id,
            env.oracle_key,
            env.oracle_id,
            payer,
        ),
        &[],
        "RoundNotAwaitingRandomness",
    )
    .await;

    env.send(request_randomness_ix(0, mock_key, payer), &[])
        .await;

    // (b) the genesis-preloaded REVEALED decoy at round_randomness_key(0):
    // right owner, wrong key — the pin refuses substitution.
    env.send_fails_with(
        commit_randomness_ix(
            0,
            round_randomness_key(0),
            env.queue_id,
            env.oracle_key,
            env.oracle_id,
            payer,
        ),
        &[],
        "RandomnessAccountMismatch",
    )
    .await;

    // (c) a queue account owned by the SYSTEM program — the anchor owner
    // constraint fires before the handler.
    env.send_fails_with(
        commit_randomness_ix(
            0,
            mock_key,
            env.players[0].pubkey(),
            env.oracle_key,
            env.oracle_id,
            payer,
        ),
        &[],
        "RandomnessOwnerMismatch",
    )
    .await;

    // (d) oracle-program-owned but the WRONG key (the oracle account posing
    // as the queue) — the config pin refuses it.
    env.send_fails_with(
        commit_randomness_ix(
            0,
            mock_key,
            env.oracle_key,
            env.oracle_key,
            env.oracle_id,
            payer,
        ),
        &[],
        "RandomnessQueueMismatch",
    )
    .await;

    // (e) an executable but different program — the CPI target is pinned.
    env.send_fails_with(
        commit_randomness_ix(0, mock_key, env.queue_id, env.oracle_key, PROGRAM_ID, payer),
        &[],
        "RandomnessProgramMismatch",
    )
    .await;

    // After the battery the round is untouched: still AwaitingRandomness,
    // still solvent, no reveal written.
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::AwaitingRandomness);
    assert_eq!(round.randomness_account, mock_key);
    env.assert_round_vault_solvent(0).await;
    let data = env.account(mock_key).await.expect("mock").data;
    assert_eq!(&data[144..152], &[0u8; 8], "no reveal leaked through");
}

/// `oracle_queue` config surface: initialize refuses the default key,
/// `update_config` rotates it (queue migration is operational), and the
/// effective-value validation refuses to reset it to default.
#[tokio::test]
async fn oracle_queue_config_gates() {
    let mut env = Env::boot(0, [0u8; 32], Vec::new(), Pubkey::new_unique()).await;
    let mut args = default_args();
    args.oracle_program_id = env.oracle_id;
    args.oracle_queue = Pubkey::default();
    args.treasury_authority = env.payer.pubkey();
    let admin = env.admin.insecure_clone();

    env.send_fails_with(
        initialize_ix(&admin, &args),
        &[&admin],
        "InvalidOracleQueue",
    )
    .await;

    args.oracle_queue = env.queue_id;
    env.send(initialize_ix(&admin, &args), &[&admin]).await;
    assert_eq!(env.config().await.oracle_queue, env.queue_id);

    let rotated = Pubkey::new_unique();
    // AUDIT P-3: the queue only rotates while paused.
    env.send(toggle_pause_ix(admin.pubkey()), &[&admin]).await;
    env.send(
        update_config_ix(
            admin.pubkey(),
            &UpdateConfigArgs {
                oracle_queue: Some(rotated),
                ..UpdateConfigArgs::default()
            },
        ),
        &[&admin],
    )
    .await;
    assert_eq!(env.config().await.oracle_queue, rotated);

    env.send_fails_with(
        update_config_ix(
            admin.pubkey(),
            &UpdateConfigArgs {
                oracle_queue: Some(Pubkey::default()),
                ..UpdateConfigArgs::default()
            },
        ),
        &[&admin],
        "InvalidOracleQueue",
    )
    .await;
    assert_eq!(env.config().await.oracle_queue, rotated, "unchanged");
}

// ─── phase 10.3: auto-deposit escrow battery ───────────────────────────────

/// Revealed mocks for rounds 1..=n (round 0's comes from boot's `value`
/// parameter) with per-round chosen ticket seeds — deterministic winner
/// control. `mega_seed` 1 never fires (1 mod 625 ≠ 0): these tests
/// assert escrow economics, not the Mega path.
fn revealed_round_mocks(
    n_rounds: u64,
    ticket_seeds: Vec<u128>,
) -> impl FnOnce(Pubkey) -> Vec<(Pubkey, Account)> {
    move |oracle_id| {
        (1..=n_rounds)
            .zip(ticket_seeds.iter())
            .map(|(round, &seed)| {
                (
                    round_randomness_key(round),
                    mock_randomness_account(oracle_id, round_key(round), mock_value(seed, 1)),
                )
            })
            .collect()
    }
}

/// What one auto-deposited round costs an escrow (design §4.7), computed
/// from the live rent sysvar — never a hardcoded figure (test-genesis rent
/// differs from devnet's).
async fn round_cost(env: &mut Env, per_round: u64) -> u64 {
    per_round
        + env.rent_minimum(109).await // 8 + PlayerEntry::INIT_SPACE
        + AUTO_DEPOSIT_TIP_LAMPORTS
}

#[tokio::test]
async fn auto_deposit_happy_path_across_rounds() {
    // Fund for 3 rounds, auto-deposit rounds 0/1/2, watch the budget run
    // 2 → 1 → 0, then a 4th attempt fails EscrowBudgetExhausted. Each
    // round gets one human deposit so lock does not auto-cancel.
    let mut env = Env::setup_auto_deposit(
        2,
        mock_value(150_000_000, 1), // round 0: ticket in the human's range
        revealed_round_mocks(2, vec![150_000_000, 150_000_000]),
        |_| {},
    )
    .await;

    let owner = env.players[0].insecure_clone();
    let human = env.players[1].insecure_clone();
    let per_round = SOL / 10;
    let cost = round_cost(&mut env, per_round).await;
    env.fund_escrow(&owner, 3 * cost, per_round, 3, false).await;

    let escrow_addr = escrow_key(owner.pubkey());
    for round in 0..3u64 {
        env.open_round_at(round).await;
        let payer = env.payer.pubkey();
        env.send(crank_auto_deposit_ix(round, 0, escrow_addr, payer), &[])
            .await;
        // The human deposits at index 1 so `single_depositor` goes false
        // and the round settles instead of auto-cancelling.
        env.send(deposit_ix(human.pubkey(), round, 1, SOL / 10), &[&human])
            .await;

        let esc = env.escrow(owner.pubkey()).await;
        assert_eq!(esc.rounds_remaining, 2 - round as u32, "round {round}");
        assert_eq!(esc.next_eligible_round_id, round + 1);
        assert_eq!(esc.rounds_funded, round + 1);
        assert_eq!(esc.lifetime_staked, per_round * (round + 1));
        env.assert_round_vault_solvent(round).await;

        // R1 surface: the entry belongs to the escrow PDA, not the owner.
        let entry = env.entry(round, 0).await;
        assert_eq!(entry.player, escrow_addr);
        assert_eq!(entry.amount, per_round);
        assert_eq!(entry.ticket_start, 0);
        assert_eq!(entry.ticket_end, per_round);

        env.lock_and_settle(round).await;
        assert_eq!(env.round(round).await.state, RoundState::Settled);
    }

    // The 4th attempt: budget exhausted, cleanly refused.
    env.open_round_at(3).await;
    let payer = env.payer.pubkey();
    env.send_fails_with(
        crank_auto_deposit_ix(3, 0, escrow_addr, payer),
        &[],
        "EscrowBudgetExhausted",
    )
    .await;
    // The refusal consumed nothing.
    assert_eq!(env.round(3).await.total_lamports, 0);
    assert_eq!(env.round(3).await.entry_count, 0);
}

#[tokio::test]
async fn auto_deposit_is_exactly_once_per_round() {
    let mut env = Env::setup_auto_deposit(2, mock_value(1, 1), |_| Vec::new(), |_| {}).await;
    let owner = env.players[0].insecure_clone();
    let cost = round_cost(&mut env, SOL / 10).await;
    env.fund_escrow(&owner, 2 * cost, SOL / 10, 2, false).await;

    env.open_round_at(0).await;
    let escrow_addr = escrow_key(owner.pubkey());
    let payer = env.payer.pubkey();
    env.send(crank_auto_deposit_ix(0, 0, escrow_addr, payer), &[])
        .await;

    // Second call in the same round — with the now-correct next entry
    // index, so the refusal comes from the guard, not a seed collision.
    env.send_fails_with(
        crank_auto_deposit_ix(0, 1, escrow_addr, payer),
        &[],
        "AutoDepositAlreadyThisRound",
    )
    .await;
    let esc = env.escrow(owner.pubkey()).await;
    assert_eq!(esc.next_eligible_round_id, 1);
    assert_eq!(
        esc.rounds_remaining, 1,
        "the failed attempt consumed nothing"
    );
    assert_eq!(env.round(0).await.entry_count, 1);
}

#[tokio::test]
async fn auto_deposit_window_gates_permissionless_callers() {
    let mut env = Env::setup_auto_deposit(2, mock_value(1, 1), |_| Vec::new(), |_| {}).await;
    let owner = env.players[0].insecure_clone();
    let third_party = env.players[1].insecure_clone();
    let cost = round_cost(&mut env, SOL / 10).await;
    env.fund_escrow(&owner, cost, SOL / 10, 1, false).await;

    env.open_round_at(0).await;
    let round = env.round(0).await;
    let window_end = round.start_ts + AUTO_DEPOSIT_WINDOW_SECS;
    // Past the window (start + 2), still before end_ts (start + 5).
    env.advance_seconds(AUTO_DEPOSIT_WINDOW_SECS + 1).await;
    let now = env.clock().await.unix_timestamp;
    assert!(now > window_end && now < round.end_ts, "inside the gap");

    let escrow_addr = escrow_key(owner.pubkey());
    // A third-party crank is refused…
    env.send_fails_with(
        crank_auto_deposit_ix(0, 0, escrow_addr, third_party.pubkey()),
        &[&third_party],
        "AutoDepositWindowClosed",
    )
    .await;
    // …but the OWNER signing past the window succeeds — the escape hatch.
    env.send(
        crank_auto_deposit_ix(0, 0, escrow_addr, owner.pubkey()),
        &[&owner],
    )
    .await;
    let entry = env.entry(0, 0).await;
    assert_eq!(entry.player, escrow_addr);
    assert_eq!(entry.amount, SOL / 10);
}

#[tokio::test]
async fn auto_deposit_never_extends_the_anti_snipe_timer() {
    // THE critical test (R3): an auto-deposit inside the anti-snipe window
    // with a qualifying amount leaves `end_ts` bit-identical, while a
    // normal deposit of the same amount at the same moment moves it — so
    // the test proves the difference, not a dead parameter.
    let mut env = Env::setup_auto_deposit(
        2,
        mock_value(1, 1),
        |_| Vec::new(),
        |args| {
            args.auto_deposit_window_secs = 4; // in-window at t≈3 (auto side)
            args.anti_snipe_window_secs = 3; // inside when remaining < 3
            args.anti_snipe_extension_secs = 3; // now+3 > end ⇒ visible move
            args.anti_snipe_min_deposit_lamports = 1; // per_round qualifies
        },
    )
    .await;
    let owner = env.players[0].insecure_clone();
    let human = env.players[1].insecure_clone();
    let per_round = SOL / 10; // ≥ anti_snipe_min_deposit_lamports
    let cost = round_cost(&mut env, per_round).await;
    env.fund_escrow(&owner, cost, per_round, 1, false).await;

    env.open_round_at(0).await;
    let round = env.round(0).await;
    let start_ts = round.start_ts;
    let end_before = round.end_ts;

    // Warp to start+3: remaining = 2 < window 3 ⇒ any qualifying deposit
    // here WOULD extend; still inside the auto-deposit window (4).
    env.advance_seconds(3).await;
    assert!(env.clock().await.unix_timestamp <= start_ts + 4);

    let escrow_addr = escrow_key(owner.pubkey());
    let payer = env.payer.pubkey();
    env.send(crank_auto_deposit_ix(0, 0, escrow_addr, payer), &[])
        .await;
    assert_eq!(
        env.round(0).await.end_ts,
        end_before,
        "auto-deposit must not move end_ts (R3)"
    );

    // The control: the SAME amount from a wallet at the SAME moment does
    // extend — min(now + 3, start + 300) = start + 6.
    env.send(deposit_ix(human.pubkey(), 0, 1, per_round), &[&human])
        .await;
    let end_after = env.round(0).await.end_ts;
    assert_eq!(end_after, start_ts + 6, "the deposit-side extension ran");
    assert!(end_after > end_before);
}

#[tokio::test]
async fn auto_deposit_conserves_lamports_exactly() {
    let mut env = Env::setup_auto_deposit(2, mock_value(1, 1), |_| Vec::new(), |_| {}).await;
    let owner = env.players[0].insecure_clone();
    let per_round = SOL / 10;
    let entry_rent = env.rent_minimum(109).await;
    let escrow_rent_min = env.rent_minimum(122).await;
    let cost = round_cost(&mut env, per_round).await;

    // A DEDICATED crank keypair, never env.payer — Env::send always makes
    // env.payer the fee payer, so a distinct crank sees +tip with no
    // signature fee mixed into the delta.
    let crank = Keypair::new();
    let payer = env.payer.pubkey();
    env.send(sol_transfer(payer, crank.pubkey(), 10 * SOL), &[])
        .await;

    env.fund_escrow(&owner, cost, per_round, 1, false).await;
    env.open_round_at(0).await;

    let escrow_addr = escrow_key(owner.pubkey());
    let crank_before = env.balance(crank.pubkey()).await;
    let escrow_before = env.balance(escrow_addr).await;
    let vault_before = env.balance(round_vault_key(0)).await;

    env.send(
        crank_auto_deposit_ix(0, 0, escrow_addr, crank.pubkey()),
        &[&crank],
    )
    .await;

    let crank_after = env.balance(crank.pubkey()).await;
    let escrow_after = env.balance(escrow_addr).await;
    let vault_after = env.balance(round_vault_key(0)).await;
    let entry_account = env.entry_account(0, 0).await;

    // The exact conservation tableau (design §3.4 step 16):
    assert_eq!(
        escrow_before - escrow_after,
        cost,
        "Δescrow = −(amount+rent+tip)"
    );
    assert_eq!(vault_after - vault_before, per_round, "Δvault = +amount");
    assert_eq!(
        entry_account.lamports, entry_rent,
        "entry holds exactly its rent"
    );
    assert_eq!(
        crank_after - crank_before,
        AUTO_DEPOSIT_TIP_LAMPORTS,
        "Δcrank = +tip"
    );
    // I1 + I16.
    env.assert_round_vault_solvent(0).await;
    assert_eq!(
        escrow_after, escrow_rent_min,
        "escrow drained to its rent floor"
    );
    let esc = env.escrow(owner.pubkey()).await;
    assert_eq!(
        esc.rounds_remaining, 0,
        "depleted — exactly one round funded"
    );
    assert_eq!(esc.lifetime_deposited, cost);
    assert_eq!(esc.lifetime_staked, per_round);
}

#[tokio::test]
async fn auto_deposit_refuses_to_break_rent_exemption() {
    let mut env = Env::setup_auto_deposit(2, mock_value(1, 1), |_| Vec::new(), |_| {}).await;
    let owner = env.players[0].insecure_clone();
    let per_round = SOL / 10;
    let escrow_rent_min = env.rent_minimum(122).await;
    let cost = round_cost(&mut env, per_round).await;

    // Spendable = round_cost − 1: one lamport short.
    let funded = cost - 1;
    env.fund_escrow(&owner, funded, per_round, 1, false).await;
    env.open_round_at(0).await;

    let escrow_addr = escrow_key(owner.pubkey());
    let payer = env.payer.pubkey();
    env.send_fails_with(
        crank_auto_deposit_ix(0, 0, escrow_addr, payer),
        &[],
        "EscrowInsufficientBalance",
    )
    .await;
    // Atomic refusal: nothing moved, nothing was created. (The account
    // holds rent + funded — `init` charges the rent to the payer on top
    // of the transferred amount.)
    assert_eq!(env.balance(escrow_addr).await, escrow_rent_min + funded);
    assert!(env.balance(escrow_addr).await >= escrow_rent_min, "I16");
    assert!(env.account(entry_key(0, 0)).await.is_none());
    assert_eq!(env.round(0).await.entry_count, 0);
}

#[tokio::test]
async fn auto_deposit_respects_a_raised_minimum_deposit() {
    let mut env = Env::setup_auto_deposit(2, mock_value(1, 1), |_| Vec::new(), |_| {}).await;
    let owner = env.players[0].insecure_clone();
    let per_round = SOL / 10;
    let cost = round_cost(&mut env, per_round).await;
    env.fund_escrow(&owner, cost, per_round, 1, false).await;
    env.open_round_at(0).await;

    // The admin raises the floor above the escrow's terms.
    let admin = env.admin.insecure_clone();
    env.send(
        update_config_ix(
            admin.pubkey(),
            &UpdateConfigArgs {
                min_deposit_lamports: Some(SOL / 5),
                ..UpdateConfigArgs::default()
            },
        ),
        &[&admin],
    )
    .await;

    let escrow_addr = escrow_key(owner.pubkey());
    let payer = env.payer.pubkey();
    env.send_fails_with(
        crank_auto_deposit_ix(0, 0, escrow_addr, payer),
        &[],
        "DepositBelowMinimum",
    )
    .await;

    // The fund exit is untouched by the raised floor.
    let withdraw_amount = cost / 2;
    let escrow_before = env.balance(escrow_addr).await;
    let owner_before = env.balance(owner.pubkey()).await;
    env.send(
        withdraw_escrow_ix(owner.pubkey(), withdraw_amount),
        &[&owner],
    )
    .await;
    assert_eq!(
        env.balance(escrow_addr).await,
        escrow_before - withdraw_amount
    );
    assert_eq!(
        env.balance(owner.pubkey()).await - owner_before,
        withdraw_amount,
        "exact payout to the owner wallet (not the fee payer)"
    );
}

#[tokio::test]
async fn auto_deposit_pause_semantics() {
    let mut env = Env::setup_auto_deposit(2, mock_value(1, 1), |_| Vec::new(), |_| {}).await;
    let owner = env.players[0].insecure_clone();
    let per_round = SOL / 10;
    let cost = round_cost(&mut env, per_round).await;
    env.fund_escrow(&owner, cost, per_round, 1, false).await;
    env.open_round_at(0).await;

    let admin = env.admin.insecure_clone();
    env.send(toggle_pause_ix(admin.pubkey()), &[&admin]).await;

    let escrow_addr = escrow_key(owner.pubkey());
    let payer = env.payer.pubkey();
    env.send_fails_with(
        crank_auto_deposit_ix(0, 0, escrow_addr, payer),
        &[],
        "Paused",
    )
    .await;
    env.send_fails_with(
        init_or_deposit_escrow_ix(owner.pubkey(), cost, per_round, 1, false),
        &[&owner],
        "Paused",
    )
    .await;

    // The fund exit survives the pause — that is its whole design.
    let escrow_before = env.balance(escrow_addr).await;
    let owner_before = env.balance(owner.pubkey()).await;
    env.send(withdraw_escrow_ix(owner.pubkey(), cost / 2), &[&owner])
        .await;
    assert_eq!(env.balance(escrow_addr).await, escrow_before - cost / 2);
    assert_eq!(env.balance(owner.pubkey()).await - owner_before, cost / 2);
}

#[tokio::test]
async fn auto_deposit_disabled_by_default() {
    // Env::setup initializes with 0/0/false — exactly what the deployed
    // config reads after the program upgrade (zero migration).
    let mut env = Env::setup(2, mock_value(1, 1)).await;
    let owner = env.players[0].insecure_clone();
    let per_round = SOL / 10;
    let cost = round_cost(&mut env, per_round).await;

    // Funding an escrow is NOT gated by the feature flag.
    env.fund_escrow(&owner, cost, per_round, 1, false).await;
    env.open_round_at(0).await;

    let payer = env.payer.pubkey();
    env.send_fails_with(
        crank_auto_deposit_ix(0, 0, escrow_key(owner.pubkey()), payer),
        &[],
        "AutoDepositDisabled",
    )
    .await;
    assert_eq!(env.round(0).await.entry_count, 0);
}

#[tokio::test]
async fn escrow_receives_prize_rent_and_refund() {
    // The heart of R1: all three inbound paths deliver to the escrow PDA
    // with ZERO changes to claim_winnings / close_entry / refund_entry.
    let mut env = Env::setup_auto_deposit(
        3,
        mock_value(u128::from(5 * SOL), 1),
        |_| Vec::new(),
        |_| {},
    )
    .await;
    let owner_a = env.players[0].insecure_clone();
    let owner_b = env.players[1].insecure_clone();
    let entry_rent = env.rent_minimum(109).await;

    // Escrow A: a 10 SOL stake as entry 0 — range [0, 10 SOL).
    let per_round_a = 10 * SOL;
    let cost_a = round_cost(&mut env, per_round_a).await;
    env.fund_escrow(&owner_a, cost_a, per_round_a, 1, false)
        .await;
    // Escrow B: the minimum-qualifying stake as entry 1 — [10, 10.1 SOL).
    let per_round_b = SOL / 10;
    let cost_b = round_cost(&mut env, per_round_b).await;
    env.fund_escrow(&owner_b, cost_b, per_round_b, 1, false)
        .await;

    env.open_round_at(0).await;
    let escrow_a = escrow_key(owner_a.pubkey());
    let escrow_b = escrow_key(owner_b.pubkey());
    let payer = env.payer.pubkey();
    env.send(crank_auto_deposit_ix(0, 0, escrow_a, payer), &[])
        .await;
    env.send(crank_auto_deposit_ix(0, 1, escrow_b, payer), &[])
        .await;
    let round = env.round(0).await;
    assert_eq!(round.total_lamports, 10 * SOL + SOL / 10);
    assert!(!round.single_depositor, "two distinct escrow PDAs");
    assert_eq!(round.first_depositor, escrow_a);

    // Ticket 5 SOL ∈ [0, 10 SOL) ⇒ escrow A wins, deterministically.
    env.lock_and_settle(0).await;
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::Settled);
    assert_eq!(round.winning_ticket, 5 * SOL);
    assert_eq!(
        round.winner,
        Pubkey::default(),
        "winner is zero until the proof"
    );

    // (a) claim_winnings pays the ESCROW PDA — permissionless, payer signs.
    let prize = round.winner_payout + round.mega_awarded;
    let a_before_claim = env.balance(escrow_a).await;
    env.send(claim_winnings_ix(0, 0, escrow_a, payer), &[])
        .await;
    assert_eq!(env.balance(escrow_a).await - a_before_claim, prize);
    let round = env.round(0).await;
    assert_eq!(round.winner, escrow_a, "round.winner is the escrow PDA");
    assert!(round.prize_claimed);
    env.assert_round_vault_solvent(0).await;

    // (b) close_entry pays the LOSING escrow its pro-rata refund of the
    // 89% pool plus the reclaimed entry rent — the retention flywheel's
    // second inbound path, unchanged from Phase 10's shape.
    let refund_pool_r0 = env.round(0).await.refund_pool;
    let expected_refund_b =
        orbit_jackpot::math::entry_share(per_round_b, refund_pool_r0, 10 * SOL + SOL / 10).unwrap();
    let b_before_close = env.balance(escrow_b).await;
    env.send(close_entry_ix(0, 1, escrow_b, payer), &[]).await;
    assert_eq!(
        env.balance(escrow_b).await - b_before_close,
        entry_rent + expected_refund_b,
        "rent + the exact pro-rata refund"
    );
    assert_eq!(env.round(0).await.entries_closed, 1);
    assert_eq!(env.round(0).await.refunds_paid, expected_refund_b);

    // (c) a cancelled round: escrow B (re-funded — it played round 0) is
    // the sole depositor of round 1, lock auto-cancels, refund_entry
    // returns stake + reclaimed entry rent to the escrow.
    env.open_round_at(1).await;
    env.fund_escrow(&owner_b, cost_b, per_round_b, 1, false)
        .await;
    env.send(crank_auto_deposit_ix(1, 0, escrow_b, payer), &[])
        .await;
    env.lock_only(1).await;
    let round = env.round(1).await;
    assert_eq!(round.state, RoundState::Cancelled);
    assert!(round.single_depositor);

    let b_before_refund = env.balance(escrow_b).await;
    env.send(refund_entry_ix(1, 0, escrow_b, payer), &[]).await;
    assert_eq!(
        env.balance(escrow_b).await - b_before_refund,
        per_round_b + entry_rent,
        "stake + reclaimed entry rent, in full (ADR-7)"
    );
    env.assert_round_vault_solvent(1).await;
}

#[tokio::test]
async fn auto_deposit_batches_consecutive_entries() {
    // Three escrows in ONE transaction: entry PDAs must be presented at
    // entry_count + 0/1/2 — the batching shape the keeper sends live.
    let mut env = Env::setup_auto_deposit(3, mock_value(1, 1), |_| Vec::new(), |_| {}).await;
    let per_round = SOL / 10;
    let escrow_rent_min = env.rent_minimum(122).await;
    let cost = round_cost(&mut env, per_round).await;

    let mut escrow_addrs = Vec::with_capacity(3);
    // Cloned out of `env.players` first — the loop body needs `&mut env`.
    let owners: Vec<Keypair> = env.players.iter().map(|k| k.insecure_clone()).collect();
    for owner in &owners {
        env.fund_escrow(owner, cost, per_round, 1, false).await;
        escrow_addrs.push(escrow_key(owner.pubkey()));
    }
    env.open_round_at(0).await;

    let payer = env.payer.pubkey();
    let ixs: Vec<Instruction> = (0..3u32)
        .map(|i| crank_auto_deposit_ix(0, i, escrow_addrs[i as usize], payer))
        .collect();
    env.send_batch(&ixs, &[]).await;

    let round = env.round(0).await;
    assert_eq!(round.entry_count, 3);
    assert_eq!(round.total_lamports, 3 * per_round);
    // Contiguous, non-overlapping, telescoping from zero (I9 over
    // [0, total)) — asserted pairwise, exactly as the deposit tests do.
    let mut prev_end = 0;
    for (i, &escrow_addr) in escrow_addrs.iter().enumerate() {
        let entry = env.entry(0, i as u32).await;
        assert_eq!(entry.player, escrow_addr);
        assert_eq!(entry.ticket_start, prev_end);
        prev_end = entry.ticket_end;
    }
    assert_eq!(prev_end, round.total_lamports, "I9 closure");
    env.assert_round_vault_solvent(0).await;
    for &escrow_addr in &escrow_addrs {
        assert!(env.balance(escrow_addr).await >= escrow_rent_min, "I16");
    }
}

#[tokio::test]
async fn auto_deposit_sole_depositor_round_cancels_and_refunds() {
    let mut env = Env::setup_auto_deposit(2, mock_value(1, 1), |_| Vec::new(), |_| {}).await;
    let owner = env.players[0].insecure_clone();
    let per_round = SOL / 10;
    let entry_rent = env.rent_minimum(109).await;
    let cost = round_cost(&mut env, per_round).await;
    env.fund_escrow(&owner, cost, per_round, 1, false).await;

    env.open_round_at(0).await;
    let escrow_addr = escrow_key(owner.pubkey());
    let payer = env.payer.pubkey();
    env.send(crank_auto_deposit_ix(0, 0, escrow_addr, payer), &[])
        .await;

    // Sole depositor = the escrow PDA (one key, one entry): lock cancels.
    env.lock_only(0).await;
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::Cancelled);
    assert!(round.single_depositor);
    assert_eq!(round.first_depositor, escrow_addr);

    let before = env.balance(escrow_addr).await;
    env.send(refund_entry_ix(0, 0, escrow_addr, payer), &[])
        .await;
    assert_eq!(
        env.balance(escrow_addr).await - before,
        per_round + entry_rent
    );
    env.assert_round_vault_solvent(0).await;
}

#[tokio::test]
async fn auto_deposit_config_validation() {
    let mut env = Env::setup_auto_deposit(1, mock_value(1, 1), |_| Vec::new(), |_| {}).await;
    let admin = env.admin.insecure_clone();
    const MAX_TIP: u64 = 1_000_000; // mirrors constants::MAX_AUTO_DEPOSIT_TIP_LAMPORTS

    // window ≥ round_duration is unusable (anti-selection needs a short
    // window; a window covering the round is no window).
    env.send_fails_with(
        update_config_ix(
            admin.pubkey(),
            &UpdateConfigArgs {
                auto_deposit_window_secs: Some(ROUND_DURATION_SECS),
                ..UpdateConfigArgs::default()
            },
        ),
        &[&admin],
        "InvalidAutoDepositWindow",
    )
    .await;
    // So is a zero window while enabled.
    env.send_fails_with(
        update_config_ix(
            admin.pubkey(),
            &UpdateConfigArgs {
                auto_deposit_window_secs: Some(0),
                ..UpdateConfigArgs::default()
            },
        ),
        &[&admin],
        "InvalidAutoDepositWindow",
    )
    .await;
    // The tip can never move past the compile-time ceiling.
    env.send_fails_with(
        update_config_ix(
            admin.pubkey(),
            &UpdateConfigArgs {
                auto_deposit_tip_lamports: Some(MAX_TIP + 1),
                ..UpdateConfigArgs::default()
            },
        ),
        &[&admin],
        "AutoDepositTipTooHigh",
    )
    .await;
    // Every refusal left the config untouched.
    let config = env.config().await;
    assert_eq!(config.auto_deposit_window_secs, AUTO_DEPOSIT_WINDOW_SECS);
    assert_eq!(config.auto_deposit_tip_lamports, AUTO_DEPOSIT_TIP_LAMPORTS);
    assert!(config.auto_deposit_enabled);

    // A legal rotation lands.
    env.send(
        update_config_ix(
            admin.pubkey(),
            &UpdateConfigArgs {
                auto_deposit_window_secs: Some(1),
                auto_deposit_tip_lamports: Some(MAX_TIP),
                ..UpdateConfigArgs::default()
            },
        ),
        &[&admin],
    )
    .await;
    let config = env.config().await;
    assert_eq!(config.auto_deposit_window_secs, 1);
    assert_eq!(config.auto_deposit_tip_lamports, MAX_TIP);
}

#[tokio::test]
async fn escrow_terms_update_does_not_reset_the_round_guard() {
    let mut env = Env::setup_auto_deposit(2, mock_value(1, 1), |_| Vec::new(), |_| {}).await;
    let owner = env.players[0].insecure_clone();
    let per_round = SOL / 10;
    let cost = round_cost(&mut env, per_round).await;
    env.fund_escrow(&owner, 2 * cost, per_round, 2, false).await;

    env.open_round_at(0).await;
    let escrow_addr = escrow_key(owner.pubkey());
    let payer = env.payer.pubkey();
    env.send(crank_auto_deposit_ix(0, 0, escrow_addr, payer), &[])
        .await;

    // Re-fund: budget re-declared (max_rounds 5), guard MUST survive.
    env.fund_escrow(&owner, cost, per_round, 5, false).await;
    let esc = env.escrow(owner.pubkey()).await;
    assert_eq!(esc.rounds_remaining, 5, "re-fund re-declares the budget");
    assert_eq!(esc.next_eligible_round_id, 1, "…but never the round guard");
    assert_eq!(esc.lifetime_deposited, 3 * cost);

    env.send_fails_with(
        crank_auto_deposit_ix(0, 1, escrow_addr, payer),
        &[],
        "AutoDepositAlreadyThisRound",
    )
    .await;

    // Round 0 must leave Open first — sole depositor, so lock cancels it.
    env.lock_only(0).await;
    // The next round is exactly as eligible as before the re-fund.
    env.open_round_at(1).await;
    env.send(crank_auto_deposit_ix(1, 0, escrow_addr, payer), &[])
        .await;
    let esc = env.escrow(owner.pubkey()).await;
    assert_eq!(esc.next_eligible_round_id, 2);
    assert_eq!(esc.rounds_remaining, 4);
}

#[tokio::test]
async fn escrow_auto_reinvest_extends_the_budget() {
    // Two escrows, identically funded for exactly two rounds; both win a
    // round. `auto_reinvest: true` converts the prize into more rounds
    // (capped at max_rounds); `false` strictly counts down to zero while
    // the prize just sits there, withdrawable.
    let mut env = Env::setup_auto_deposit(
        3,
        mock_value(50_000_000, 1), // round 0: ticket 0.05 SOL ∈ escrow A
        revealed_round_mocks(2, vec![500_000_000, 50_000_000]),
        |_| {},
    )
    .await;
    let owner_a = env.players[0].insecure_clone();
    let owner_b = env.players[1].insecure_clone();
    let human = env.players[2].insecure_clone();
    let per_round = SOL / 10;
    let escrow_rent_min = env.rent_minimum(122).await;
    let cost = round_cost(&mut env, per_round).await;

    env.fund_escrow(&owner_a, 2 * cost, per_round, 10, true)
        .await;
    // B declares a 2-round budget (the amount it funds) with the flag off.
    env.fund_escrow(&owner_b, 2 * cost, per_round, 2, false)
        .await;

    let escrow_a = escrow_key(owner_a.pubkey());
    let escrow_b = escrow_key(owner_b.pubkey());
    let payer = env.payer.pubkey();

    // Round 0: A + a 2 SOL human deposit; A's range [0, 0.1) wins. The
    // bigger pot matters under v2: the prize + refund must exceed one
    // whole round cost AFTER the round-1 play deducts its own cost, or
    // the recompute cannot lift the budget.
    env.open_round_at(0).await;
    env.send(crank_auto_deposit_ix(0, 0, escrow_a, payer), &[])
        .await;
    assert_eq!(env.escrow(owner_a.pubkey()).await.rounds_remaining, 1);
    env.send(deposit_ix(human.pubkey(), 0, 1, 2 * SOL), &[&human])
        .await;
    env.lock_and_settle(0).await;
    let payout_r0 = env.round(0).await.winner_payout;
    // 2.1 SOL pot × 900 bps — the v2 winner slice. Smaller than a round
    // cost on its own; reinvestment only carries when the REFUND rides
    // along (both land in the escrow), which is the point of this test.
    assert_eq!(payout_r0, 189_000_000, "9% of the 2.1 SOL pot");
    let refund_pool_r0 = env.round(0).await.refund_pool;
    let refund_r0 =
        orbit_jackpot::math::entry_share(per_round, refund_pool_r0, 21 * SOL / 10).unwrap();
    env.send(claim_winnings_ix(0, 0, escrow_a, payer), &[])
        .await;
    // The refund path: closing the entry credits the escrow too.
    env.send(close_entry_ix(0, 0, escrow_a, payer), &[]).await;

    // Round 1: A plays again — the recompute must see prize + refund. The
    // plain countdown would say 0 here (funded exactly two rounds, one
    // spent); prize + refund buy a second round outright.
    env.open_round_at(1).await;
    env.send(crank_auto_deposit_ix(1, 0, escrow_a, payer), &[])
        .await;
    let esc_a = env.escrow(owner_a.pubkey()).await;
    let spendable_a = env.balance(escrow_a).await - escrow_rent_min;
    let affordable = (spendable_a / cost).min(10u64);
    assert_eq!(
        esc_a.rounds_remaining as u64, affordable,
        "recompute = what the spendable balance now buys, capped"
    );
    assert_eq!(
        esc_a.rounds_remaining, 2,
        "prize + refund carry it one round past the plain countdown"
    );
    assert!(refund_r0 > 0);
    env.send(deposit_ix(human.pubkey(), 1, 1, SOL), &[&human])
        .await;
    env.lock_and_settle(1).await;

    // Round 2: B (reinvest OFF) + human; B's range [0, 0.1) wins.
    env.open_round_at(2).await;
    env.send(crank_auto_deposit_ix(2, 0, escrow_b, payer), &[])
        .await;
    assert_eq!(env.escrow(owner_b.pubkey()).await.rounds_remaining, 1);
    env.send(deposit_ix(human.pubkey(), 2, 1, SOL), &[&human])
        .await;
    env.lock_and_settle(2).await;
    env.send(claim_winnings_ix(2, 0, escrow_b, payer), &[])
        .await;
    // The refund of round 2 also lands in the escrow (both inbound paths).
    env.send(close_entry_ix(2, 0, escrow_b, payer), &[]).await;

    // Round 3: B's countdown hits zero even though the prize + refund
    // sitting in the escrow buy more rounds — only the flag unlocks
    // reinvestment.
    env.open_round_at(3).await;
    env.send(crank_auto_deposit_ix(3, 0, escrow_b, payer), &[])
        .await;
    let esc_b = env.escrow(owner_b.pubkey()).await;
    assert_eq!(esc_b.rounds_remaining, 0, "countdown only");
    let spendable_b = env.balance(escrow_b).await - escrow_rent_min;
    assert!(
        spendable_b >= cost,
        "the prize is there ({spendable_b} ≥ {cost}) but buys nothing without the flag"
    );
}

// ─── Phase 12: idle-burn elimination — window roll + rent reciprocity ──────

/// Case 1 + 7: locking an expired EMPTY round rolls the window in place —
/// no state change, no teardown, no lamport movement, repeatable at will.
/// The anti-grief invariance (R4): a third party can spend base fee after
/// base fee and never force the keeper into a fresh round of rent.
#[tokio::test]
async fn p12_empty_round_lock_rolls_window_in_place() {
    let mut env = Env::setup(2, mock_value(1, 1)).await;
    env.send(open_round_ix(env.payer.pubkey(), 0, None), &[])
        .await;

    let before = env.round(0).await;
    let round_lamports_before = env.account(round_key(0)).await.expect("round").lamports;
    let vault_lamports_before = env
        .account(round_vault_key(0))
        .await
        .expect("vault")
        .lamports;
    let next_round_id_before = env.config().await.next_round_id;

    // A third-party griefer (not the fee payer, not the keeper) cranks the
    // lock. Event proof first: simulate (nothing lands) and decode the
    // emission the real send is about to produce.
    let griefer = env.players[1].insecure_clone();
    let griefer_before = env.balance(griefer.pubkey()).await;
    env.advance_past_end(0).await;
    let now = env.clock().await.unix_timestamp;
    let logs = env
        .simulate_logs(lock_round_ix(0, griefer.pubkey()), &[&griefer])
        .await;
    let rolls = round_window_rolls(&logs);
    assert_eq!(rolls.len(), 1, "exactly one RoundWindowRolled in the lock");
    assert_eq!(rolls[0].0, 0, "round_id");
    assert_eq!(rolls[0].3, 0, "reason = ROLL_REASON_LOCK_SWEEP");
    env.send(lock_round_ix(0, griefer.pubkey()), &[&griefer])
        .await;

    let after = env.round(0).await;
    assert_eq!(
        after.state,
        RoundState::Open,
        "R1: a roll is not a transition"
    );
    assert_eq!(after.round_id, 0, "same round");
    assert_eq!(after.total_lamports, 0, "still empty");
    assert_eq!(after.start_ts, now, "R2: start moved to the lock time");
    assert_eq!(after.end_ts, now + ROUND_DURATION_SECS, "R2: end moved");
    assert_eq!(rolls[0].1, after.start_ts, "event start == on-chain start");
    assert_eq!(rolls[0].2, after.end_ts, "event end == on-chain end");
    assert!(
        after.start_ts > before.start_ts,
        "the window actually moved"
    );
    // Zero lamport movement: the griefer is not the fee payer, so its
    // balance is exactly unchanged; neither account lost or gained a
    // lamport; no round id was consumed.
    assert_eq!(env.balance(griefer.pubkey()).await, griefer_before);
    assert_eq!(
        env.account(round_key(0))
            .await
            .expect("round alive")
            .lamports,
        round_lamports_before
    );
    assert_eq!(
        env.account(round_vault_key(0))
            .await
            .expect("vault alive")
            .lamports,
        vault_lamports_before
    );
    assert_eq!(env.config().await.next_round_id, next_round_id_before);

    // Repeatable: roll twice more; the window keeps advancing, the ids and
    // accounts stay put. There is no instruction that tears this round down.
    for _ in 0..2 {
        env.advance_past_end(0).await;
        env.send(lock_round_ix(0, env.payer.pubkey()), &[]).await;
    }
    let after_rolls = env.round(0).await;
    assert_eq!(after_rolls.state, RoundState::Open);
    assert!(after_rolls.start_ts > after.start_ts, "each roll advances");
    assert_eq!(env.config().await.next_round_id, next_round_id_before);
    assert!(env.account(round_key(0)).await.is_some());
    assert!(env.account(round_vault_key(0)).await.is_some());
}

/// Case 2: the first bet on an expired empty round revives the window IN
/// the deposit transaction itself (reason ROLL_REASON_FIRST_DEPOSIT) —
/// this is what takes idle burn to zero: nobody needs to crank anything
/// for the round to become playable again.
#[tokio::test]
async fn p12_first_deposit_revives_expired_empty_round() {
    let mut env = Env::setup(2, mock_value(1, 1)).await;
    env.send(open_round_ix(env.payer.pubkey(), 0, None), &[])
        .await;
    env.advance_past_end(0).await;
    let now = env.clock().await.unix_timestamp;

    let player = env.players[0].insecure_clone();
    let logs = env
        .simulate_logs(deposit_ix(player.pubkey(), 0, 0, SOL), &[&player])
        .await;
    let rolls = round_window_rolls(&logs);
    assert_eq!(rolls.len(), 1, "the revival rolls exactly once");
    assert_eq!(rolls[0].3, 1, "reason = ROLL_REASON_FIRST_DEPOSIT");
    env.send(deposit_ix(player.pubkey(), 0, 0, SOL), &[&player])
        .await;

    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::Open);
    assert_eq!(round.start_ts, now, "the deposit rolled the window itself");
    assert_eq!(round.end_ts, now + ROUND_DURATION_SECS);
    assert_eq!(round.total_lamports, SOL);
    assert_eq!(round.entry_count, 1);
    let entry = env.entry(0, 0).await;
    assert_eq!(entry.ticket_start, 0, "minted at index 0 from zero");
    assert_eq!(entry.ticket_end, SOL);
    assert_eq!(entry.player, player.pubkey());
    env.assert_round_vault_solvent(0).await;

    // A deposit into a LIVE window is byte-for-byte unaffected: the second
    // bet neither rolls nor extends (anti-snipe is off in these args).
    let player2 = env.players[1].insecure_clone();
    let (start, end) = (round.start_ts, round.end_ts);
    env.send(deposit_ix(player2.pubkey(), 0, 1, SOL), &[&player2])
        .await;
    let round = env.round(0).await;
    assert_eq!(round.start_ts, start, "no roll on a live window");
    assert_eq!(round.end_ts, end);
    assert_eq!(round.entry_count, 2);
    assert_eq!(round.total_lamports, 2 * SOL);
}

/// The R3 boundary + Case 8: a round with money in it NEVER rolls — the
/// expired window stays closed to deposits, and locking it transitions
/// normally to `Locked` with both timestamps untouched.
#[tokio::test]
async fn p12_non_empty_round_never_rolls() {
    let mut env = Env::setup(2, mock_value(2_000_000_002, 1)).await;
    env.open_and_deposit(&[SOL, 3 * SOL]).await;
    let start_ts = env.round(0).await.start_ts;

    env.advance_past_end(0).await;
    let player = env.players[0].insecure_clone();
    env.send_fails_with(
        deposit_ix(player.pubkey(), 0, 2, SOL),
        &[&player],
        "DepositWindowClosed",
    )
    .await;

    env.send(lock_round_ix(0, env.payer.pubkey()), &[]).await;
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::Locked, "locks, does not roll");
    assert_eq!(round.start_ts, start_ts, "start untouched");
    assert_eq!(
        round.end_ts,
        start_ts + ROUND_DURATION_SECS,
        "end untouched (no anti-snipe here)"
    );
}

/// Directive case 2: a thrice-rolled round is an ordinary round — two
/// players bet in it after three idle rolls and it settles through the
/// normal pipeline with the books exact.
#[tokio::test]
async fn p12_rolled_round_settles_normally() {
    let mut env = Env::setup(2, mock_value(2_000_000_002, 1)).await;
    env.send(open_round_ix(env.payer.pubkey(), 0, None), &[])
        .await;
    for _ in 0..3 {
        env.advance_past_end(0).await;
        env.send(lock_round_ix(0, env.payer.pubkey()), &[]).await;
    }
    let p0 = env.players[0].insecure_clone();
    let p1 = env.players[1].insecure_clone();
    env.send(deposit_ix(p0.pubkey(), 0, 0, SOL), &[&p0]).await;
    env.send(deposit_ix(p1.pubkey(), 0, 1, SOL), &[&p1]).await;
    env.lock_and_settle(0).await;

    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::Settled);
    assert_eq!(round.total_lamports, 2 * SOL);
    env.assert_round_vault_solvent(0).await;
}

/// Case 3 (R2, the load-bearing rule): the auto-deposit window is measured
/// from the ROLLED `start_ts`. After a lock-sweep roll a permissionless
/// crank may spend the escrow immediately; once that rolled window lapses
/// the spend is refused — the exact stale-start shape a roll exists to
/// prevent — and the NEXT roll revives it again.
#[tokio::test]
async fn p12_auto_deposit_window_survives_roll() {
    // 30 s rounds with the 2 s window: a 28 s gap between the auto-window
    // lapse and the deposit-window close, so the "only the auto window
    // lapsed" precondition below is robust to the warp helper's overshoot.
    let mut env = Env::setup_auto_deposit(
        2,
        mock_value(1, 1),
        |_| Vec::new(),
        |args| {
            args.round_duration_secs = 30;
        },
    )
    .await;
    let owner_a = env.players[0].insecure_clone();
    let owner_b = env.players[1].insecure_clone();
    env.fund_escrow(&owner_a, 4 * SOL, SOL, 5, false).await;
    env.fund_escrow(&owner_b, 4 * SOL, SOL, 5, false).await;

    env.open_round_at(0).await;
    // Warp far past end AND past the auto-deposit window: without a roll
    // the escrow cannot enter — the deposit window has simply closed.
    env.advance_past_end(0).await;
    env.advance_seconds(AUTO_DEPOSIT_WINDOW_SECS + 5).await;
    let payer = env.payer.pubkey();
    env.send_fails_with(
        crank_auto_deposit_ix(0, 0, escrow_key(owner_a.pubkey()), payer),
        &[],
        "DepositWindowClosed",
    )
    .await;

    // The roll resets BOTH timestamps: start == now, so the auto-deposit
    // window (now <= start + window) is wide open for escrow A.
    env.send(lock_round_ix(0, payer), &[]).await;
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::Open, "rolled, not cancelled");
    env.send(
        crank_auto_deposit_ix(0, 0, escrow_key(owner_a.pubkey()), payer),
        &[],
    )
    .await;
    let round = env.round(0).await;
    assert_eq!(round.entry_count, 1, "escrow A entered the revived round");
    assert_eq!(round.total_lamports, SOL);

    // The regression half: let the ROLLED window lapse (start + window in
    // the past, end still in the future) — a stranger's spend for escrow B
    // is refused on the window gate alone. Keeping `start_ts` stale would
    // leave the escrow stranded here FOREVER; that is what R2 prevents.
    env.advance_seconds(AUTO_DEPOSIT_WINDOW_SECS + 1).await;
    let end = env.round(0).await.end_ts;
    assert!(
        env.clock().await.unix_timestamp < end,
        "still inside the deposit window — only the auto window lapsed"
    );
    env.send_fails_with(
        crank_auto_deposit_ix(0, 1, escrow_key(owner_b.pubkey()), payer),
        &[],
        "AutoDepositWindowClosed",
    )
    .await;

    // No further roll can revive the permissionless window: the round holds
    // escrow A's money now (R3), so `lock_round` would take the settle
    // path, not roll it. The sanctioned exit for a lapsed window is the
    // owner exemption — escrow B's owner cranks their own spend through.
    env.send(
        crank_auto_deposit_ix(0, 1, escrow_key(owner_b.pubkey()), owner_b.pubkey()),
        &[&owner_b],
    )
    .await;
    let round = env.round(0).await;
    assert_eq!(round.entry_count, 2, "escrow B entered via the owner path");
    env.assert_round_vault_solvent(0).await;
}

/// Case 4 (the directive's rent round-trip): a keeper-opened round,
/// settled and pruned, closes with `destination = keeper` — the keeper's
/// balance rises by exactly rent(302) + rent(33) and the admin's does not
/// move at all. Before Phase 12 this was an unreciprocated transfer.
#[tokio::test]
async fn p12_rent_round_trips_to_the_opener() {
    let mut env = Env::setup(2, mock_value(2_000_000_002, 1)).await;

    let keeper = Keypair::new();
    env.fund_wallet(&keeper, 10 * SOL).await;
    env.send(open_round_ix(keeper.pubkey(), 0, None), &[&keeper])
        .await;
    let round_account = env.account(round_key(0)).await.expect("round");
    let vault_account = env.account(round_vault_key(0)).await.expect("vault");
    let round_rent = env.rent_minimum(round_account.data.len()).await;
    let vault_rent = env.rent_minimum(vault_account.data.len()).await;
    // Test-genesis rent is 6 960 lamports/byte, not devnet's 5 080 — the
    // 2 992 800 + 1 120 560 figures the directive prices are the devnet
    // shape; here the exactness claim is the ROUND-TRIP (deltas below),
    // read from the same Rent sysvar the program reads.

    let p0 = env.players[0].insecure_clone();
    let p1 = env.players[1].insecure_clone();
    env.send(deposit_ix(p0.pubkey(), 0, 0, SOL), &[&p0]).await;
    env.send(deposit_ix(p1.pubkey(), 0, 1, SOL), &[&p1]).await;
    env.lock_and_settle(0).await;

    let winner_idx = (env.round(0).await.winning_ticket / SOL) as u32;
    let winner = env.players[winner_idx as usize].insecure_clone();
    let payer = env.payer.pubkey();
    env.send(
        claim_winnings_ix(0, winner_idx, winner.pubkey(), payer),
        &[],
    )
    .await;
    env.send(close_entry_ix(0, 0, p0.pubkey(), payer), &[])
        .await;
    env.send(close_entry_ix(0, 1, p1.pubkey(), payer), &[])
        .await;

    let keeper_before = env.balance(keeper.pubkey()).await;
    let admin_before = env.balance(env.admin.pubkey()).await;
    env.send(close_round_ix(0, keeper.pubkey(), payer), &[])
        .await;
    assert_eq!(
        env.balance(keeper.pubkey()).await - keeper_before,
        // + the randomness rent close_randomness reclaimed into the round
        // (AUDIT P-4 ordering); the harness's mock is genesis-funded, on
        // chain the keeper paid it at create time.
        round_rent + vault_rent + env.last_reclaimed,
        "the keeper recovers its rent capital exactly"
    );
    assert_eq!(
        env.balance(env.admin.pubkey()).await,
        admin_before,
        "the admin receives nothing"
    );
    assert!(env.account(round_key(0)).await.is_none());
    assert!(env.account(round_vault_key(0)).await.is_none());
}

/// Case 5 + 6, legacy half: a round opened before Phase 12 carries
/// `rent_payer == Pubkey::default()` — close_round must accept exactly
/// `config.admin` (the old behaviour) and refuse every other destination,
/// including the wallet that would have been the payer.
#[tokio::test]
async fn p12_legacy_round_rent_falls_back_to_admin() {
    let mut env = Env::setup_adv(
        1,
        [0u8; 32],
        Box::new(|_oracle_id| {
            use borsh::BorshSerialize;
            let rent = solana_sdk::rent::Rent::default();
            let round_bump =
                Pubkey::find_program_address(&[b"round", &0u64.to_le_bytes()], &PROGRAM_ID).1;
            let vault_bump =
                Pubkey::find_program_address(&[b"round_vault", &0u64.to_le_bytes()], &PROGRAM_ID).1;
            // A terminal, fully-drained, zero-entry round: the only legal
            // crafted shape close_round accepts. rent_payer = the legacy
            // sentinel, exactly as the devnet rounds decode today.
            let mut round_data = anchor_account_disc("Round");
            Round {
                round_id: 0,
                state: RoundState::Settled,
                start_ts: 1,
                end_ts: 2,
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
                vault_bump,
                bump: round_bump,
                refund_pool: 0,
                refunds_paid: 0,
                mega_field_pool: 0,
                mega_field_paid: 0,
                rent_payer: Pubkey::default(),
            }
            .serialize(&mut round_data)
            .expect("round encode");
            let mut vault_data = anchor_account_disc("RoundVault");
            RoundVault {
                round_id: 0,
                bump: vault_bump,
                reserved: [0; 16],
            }
            .serialize(&mut vault_data)
            .expect("vault encode");
            let owned = |data: Vec<u8>| Account {
                lamports: rent.minimum_balance(data.len()),
                data,
                owner: PROGRAM_ID,
                executable: false,
                rent_epoch: 0,
            };
            vec![
                (round_key(0), owned(round_data)),
                (round_vault_key(0), owned(vault_data)),
            ]
        }),
    )
    .await;

    let round_rent = env.rent_minimum(302).await;
    let vault_rent = env.rent_minimum(33).await;
    let attacker = Pubkey::new_unique();
    let payer = env.payer.pubkey();
    env.send_fails_with(close_round_ix(0, attacker, payer), &[], "UnauthorizedAdmin")
        .await;
    // Even the harness payer (which opens every OTHER round in this suite)
    // is refused: the legacy fallback is admin, not "any plausible payer".
    env.send_fails_with(close_round_ix(0, payer, payer), &[], "UnauthorizedAdmin")
        .await;

    let admin_before = env.balance(env.admin.pubkey()).await;
    env.send(close_round_ix(0, env.admin.pubkey(), payer), &[])
        .await;
    assert_eq!(
        env.balance(env.admin.pubkey()).await - admin_before,
        round_rent + vault_rent,
        "legacy fallback: both rents to config.admin exactly"
    );
    assert!(env.account(round_key(0)).await.is_none());
    assert!(env.account(round_vault_key(0)).await.is_none());
}

/// Case 6, Phase-12 half: a round whose rent_payer IS recorded refuses
/// every destination but that payer — admin included. The rent cannot be
/// steered, not even towards the config admin.
#[tokio::test]
async fn p12_recorded_rent_payer_refuses_redirects() {
    let mut env = Env::setup(2, mock_value(2_000_000_002, 1)).await;
    env.open_and_deposit(&[SOL, 3 * SOL]).await;
    env.lock_and_settle(0).await;

    // Unequal stakes [1, 3] SOL: entry 0 holds [0, 1 SOL), entry 1 the
    // rest — map the ticket by containment, not by equal division.
    let ticket = env.round(0).await.winning_ticket;
    let winner_idx = if ticket >= SOL { 1 } else { 0 };
    let winner = env.players[winner_idx].insecure_clone();
    let payer = env.payer.pubkey();
    env.send(
        claim_winnings_ix(0, winner_idx as u32, winner.pubkey(), payer),
        &[],
    )
    .await;
    // Entry i belongs to players[i] regardless of who won (unequal stakes).
    env.send(close_entry_ix(0, 0, env.players[0].pubkey(), payer), &[])
        .await;
    env.send(close_entry_ix(0, 1, env.players[1].pubkey(), payer), &[])
        .await;

    let attacker = Pubkey::new_unique();
    env.send_fails_with(close_round_ix(0, attacker, payer), &[], "UnauthorizedAdmin")
        .await;
    // The admin itself is the WRONG destination for a Phase-12 round.
    env.send_fails_with(
        close_round_ix(0, env.admin.pubkey(), payer),
        &[],
        "UnauthorizedAdmin",
    )
    .await;
    // The recorded payer is the one legal destination.
    env.send(close_round_ix(0, payer, payer), &[]).await;
    assert!(env.account(round_key(0)).await.is_none());
}

/// Case 9: the sole-depositor auto-cancel is RETAINED — a round with
/// exactly one depositor past its lock duration cancels and refunds the
/// single player cleanly (the roll only ever applies to empty rounds).
#[tokio::test]
async fn p12_sole_depositor_still_auto_cancels() {
    let mut env = Env::setup(1, mock_value(1, 1)).await;
    env.send(open_round_ix(env.payer.pubkey(), 0, None), &[])
        .await;
    let player = env.players[0].insecure_clone();
    env.send(deposit_ix(player.pubkey(), 0, 0, SOL), &[&player])
        .await;

    env.advance_past_end(0).await;
    env.send(lock_round_ix(0, env.payer.pubkey()), &[]).await;
    let round = env.round(0).await;
    assert_eq!(
        round.state,
        RoundState::Cancelled,
        "not rolled — money inside"
    );
    assert_eq!(round.vault_owed, SOL);

    let entry_len = env.entry_account(0, 0).await.data.len();
    let entry_rent = env.rent_minimum(entry_len).await;
    let before = env.balance(player.pubkey()).await;
    let payer = env.payer.pubkey();
    env.send(refund_entry_ix(0, 0, player.pubkey(), payer), &[])
        .await;
    assert_eq!(
        env.balance(player.pubkey()).await - before,
        SOL + entry_rent,
        "the sole depositor is made exactly whole"
    );
    assert_eq!(env.round(0).await.vault_owed, 0);
    env.assert_round_vault_solvent(0).await;

    // And the round closes to its opener, exactly as Phase 12 promises.
    env.send(close_round_ix(0, payer, payer), &[]).await;
    assert!(env.account(round_key(0)).await.is_none());
}

/// Case 10: a full keeper-operated settle cycle leaves the keeper at
/// exactly −gas. The two rent-exemptions round-trip (open pays them,
/// close returns them), no tip is configured, and every transaction the
/// keeper signs is paid for out of its own pocket — so the wallet's net
/// across open → lock → pin → settle → prune → close is the fees and
/// NOTHING else. This is the number the idle-burn diagnosis killed.
#[tokio::test]
async fn p12_full_cycle_keeper_net_is_gas_only() {
    let mut env = Env::setup(2, mock_value(2_000_000_002, 1)).await;
    let keeper = Keypair::new();
    env.fund_wallet(&keeper, 10 * SOL).await;
    let keeper_start = env.balance(keeper.pubkey()).await;
    let mut gas = 0u64;

    let crank = keeper.insecure_clone();
    gas += env
        .send_paying_fee(open_round_ix(crank.pubkey(), 0, None), &crank)
        .await;

    let p0 = env.players[0].insecure_clone();
    let p1 = env.players[1].insecure_clone();
    env.send(deposit_ix(p0.pubkey(), 0, 0, SOL), &[&p0]).await;
    env.send(deposit_ix(p1.pubkey(), 0, 1, SOL), &[&p1]).await;

    env.advance_past_end(0).await;
    let crank = keeper.insecure_clone();
    gas += env
        .send_paying_fee(lock_round_ix(0, crank.pubkey()), &crank)
        .await;
    let crank = keeper.insecure_clone();
    gas += env
        .send_paying_fee(
            request_randomness_ix(0, round_randomness_key(0), crank.pubkey()),
            &crank,
        )
        .await;
    let crank = keeper.insecure_clone();
    gas += env
        .send_paying_fee(
            fulfill_settle_ix(0, round_randomness_key(0), crank.pubkey()),
            &crank,
        )
        .await;

    // The winner claims (permissionless; not the keeper's cost), then the
    // keeper prunes both entries and closes the round to ITSELF.
    let winner_idx = (env.round(0).await.winning_ticket / SOL) as u32;
    let winner = env.players[winner_idx as usize].insecure_clone();
    env.send(
        claim_winnings_ix(0, winner_idx, winner.pubkey(), env.payer.pubkey()),
        &[],
    )
    .await;
    let crank = keeper.insecure_clone();
    gas += env
        .send_paying_fee(
            close_entry_ix(0, 0, env.players[0].pubkey(), crank.pubkey()),
            &crank,
        )
        .await;
    let crank = keeper.insecure_clone();
    gas += env
        .send_paying_fee(
            close_entry_ix(0, 1, env.players[1].pubkey(), crank.pubkey()),
            &crank,
        )
        .await;
    let crank = keeper.insecure_clone();
    gas += env
        .send_paying_fee(close_round_ix(0, crank.pubkey(), crank.pubkey()), &crank)
        .await;

    assert_eq!(
        i128::from(env.balance(keeper.pubkey()).await) - i128::from(keeper_start),
        // + the randomness rent close_randomness reclaimed into the round
        // (AUDIT P-4 ordering); the harness's mock is genesis-funded, on
        // chain the keeper paid it at create time.
        -(gas as i128) + i128::from(env.last_reclaimed),
        "the keeper's whole-cycle net is exactly the gas it burned"
    );
    assert!(gas > 0, "the accounting measured real fees");
    assert!(env.account(round_key(0)).await.is_none(), "round closed");
}


// ─── Phase 13: close_randomness reclaims the Switchboard rent ──────────────

/// The whole point: before this instruction every settled round stranded
/// its randomness rent forever (the round PDA — its only authority — dies
/// in close_round). Now the round PDA signs the close while it is alive,
/// the rent lands in the round account, and close_round carries it to the
/// opener with the round's own rent.
#[tokio::test]
async fn p13_close_randomness_returns_rent_to_the_opener() {
    let mut env = Env::setup(3, mock_value(2_000_000_002, 1)).await;
    let payer = env.payer.pubkey();
    let (oracle, queue) = (env.oracle_id, env.queue_id);
    env.open_and_deposit(&[SOL, 3 * SOL, 6 * SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    env.send(lock_round_ix(0, payer), &[]).await;
    env.send(request_randomness_ix(0, round_randomness_key(0), payer), &[])
        .await;

    // Not terminal yet: the value is about to be consumed — refused.
    env.send_fails_with(
        close_randomness_ix(0, round_randomness_key(0), queue, oracle, payer),
        &[],
        "IllegalStateTransition",
    )
    .await;

    env.send(fulfill_settle_ix(0, round_randomness_key(0), payer), &[])
        .await;

    // A key other than the round's pin is refused, even when terminal.
    let stranger = Pubkey::new_unique();
    env.send_fails_with(
        close_randomness_ix(0, stranger, queue, oracle, payer),
        &[],
        "RandomnessAccountMismatch",
    )
    .await;

    let randomness_lamports = env
        .account(round_randomness_key(0))
        .await
        .expect("randomness mock")
        .lamports;
    assert!(randomness_lamports > 0);
    let round_before = env.account(round_key(0)).await.expect("round").lamports;

    env.send(
        close_randomness_ix(0, round_randomness_key(0), queue, oracle, payer),
        &[],
    )
    .await;

    let round_after = env.account(round_key(0)).await.expect("round").lamports;
    assert_eq!(
        round_after - round_before,
        randomness_lamports,
        "the randomness rent lands in the round account"
    );
    assert!(
        env.account(round_randomness_key(0)).await.is_none(),
        "the randomness account is gone"
    );
    // The round's data is untouched — still settled, still owing its field.
    let round = env.round(0).await;
    assert!(matches!(round.state, RoundState::Settled));

    // A second close finds nothing to close.
    env.send_fails(
        close_randomness_ix(0, round_randomness_key(0), queue, oracle, payer),
        &[],
    )
    .await;

    // Drain the round, then close it: everything the round account holds
    // — its rent AND the reclaimed randomness rent — leaves for the opener.
    let winner = env.players[1].insecure_clone();
    env.send(claim_winnings_ix(0, 1, winner.pubkey(), payer), &[]).await;
    for i in 0..3u32 {
        env.send(close_entry_ix(0, i, env.players[i as usize].pubkey(), payer), &[])
            .await;
    }
    let payer_before = env.balance(payer).await;
    let vault_lamports = env.account(round_vault_key(0)).await.expect("vault").lamports;
    let round_lamports = env.account(round_key(0)).await.expect("round").lamports;
    env.send(close_round_ix(0, payer, payer), &[]).await;
    let payer_after = env.balance(payer).await;
    assert_eq!(
        payer_after + 5_000 - payer_before,
        vault_lamports + round_lamports,
        "close_round returns the round's rent, the vault's rent and the reclaimed randomness rent (less the tx fee)"
    );
    assert!(env.account(round_key(0)).await.is_none());
}

// ─── economics v3: the winner's own stake is never raked ──────────────────

fn migrate_economics_v3_ix(admin: Pubkey) -> Instruction {
    instruction(
        "migrate_economics_v3",
        &[],
        vec![
            AccountMeta::new(config_key(), false),
            AccountMeta::new_readonly(admin, true),
        ],
    )
}

/// `fulfill_settle` with the winning entry appended as the first remaining
/// account — what the crank sends under v3.
fn fulfill_settle_v3_ix(round_id: u64, randomness: Pubkey, crank: Pubkey, entry: Pubkey) -> Instruction {
    let mut ix = fulfill_settle_ix(round_id, randomness, crank);
    ix.accounts.push(AccountMeta::new_readonly(entry, false));
    ix
}

#[tokio::test]
async fn v3_migration_is_admin_only_and_one_way() {
    let mut env = Env::setup(1, mock_value(5, 1)).await;
    let stranger = Keypair::new();
    env.send_fails_with(
        migrate_economics_v3_ix(stranger.pubkey()),
        &[&stranger],
        "UnauthorizedAdmin",
    )
    .await;
    let admin = env.admin.insecure_clone();
    env.send(migrate_economics_v3_ix(admin.pubkey()), &[&admin]).await;
    let config: GlobalConfig = env.config().await;
    assert_eq!(config.economics_version, 3);
    assert_eq!((config.winner_bps, config.refund_bps), (900, 8_900), "no bps re-tuned");
    env.send_fails_with(
        migrate_economics_v3_ix(admin.pubkey()),
        &[&admin],
        "EconomicsVersionMismatch",
    )
    .await;
}

/// The owner's case at scale: 10 SOL against 1 SOL. Under v2 the whale
/// "won" 0.99 + 8.9 = 9.89 SOL back on a 10 SOL stake; under v3 they get
/// their 10 SOL plus 9% of the loser's 1 SOL, and the loser is unchanged.
#[tokio::test]
async fn v3_whale_wins_money_and_the_loser_is_unchanged() {
    // ticket 5 ∈ [0, 10 SOL) ⇒ the whale (entry 0) wins.
    let mut env = Env::setup(2, mock_value(5, 1)).await;
    let payer = env.payer.pubkey();
    let admin = env.admin.insecure_clone();
    env.send(migrate_economics_v3_ix(admin.pubkey()), &[&admin]).await;
    env.open_and_deposit(&[10 * SOL, SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    env.send(lock_round_ix(0, payer), &[]).await;
    env.send(request_randomness_ix(0, round_randomness_key(0), payer), &[])
        .await;

    // v3 refuses to settle blind, or against any entry but the winner's.
    env.send_fails_with(
        fulfill_settle_ix(0, round_randomness_key(0), payer),
        &[],
        "WinningEntryRequired",
    )
    .await;
    env.send_fails_with(
        fulfill_settle_v3_ix(0, round_randomness_key(0), payer, entry_key(0, 1)),
        &[],
        "WinningEntryMismatch",
    )
    .await;
    env.send_fails_with(
        fulfill_settle_v3_ix(0, round_randomness_key(0), payer, config_key()),
        &[],
        "WinningEntryMismatch",
    )
    .await;

    let treasury_before = env.treasury().await.accrued_lamports;
    env.send(
        fulfill_settle_v3_ix(0, round_randomness_key(0), payer, entry_key(0, 0)),
        &[],
    )
    .await;
    let round = env.round(0).await;
    assert!(matches!(round.state, RoundState::Settled));
    assert_eq!(round.admin_cut, SOL / 100, "1% of the LOSER's 1 SOL only");
    assert_eq!(round.mega_cut, SOL / 100);
    assert_eq!(round.refund_pool, 89 * 11 * SOL / 100, "v2's refund pool, unchanged");
    assert_eq!(
        env.treasury().await.accrued_lamports - treasury_before,
        SOL / 100, // default_args: keeper_tip_lamports = 0
        "treasury takes the admin cut less the keeper tip"
    );
    env.assert_round_vault_solvent(0).await;

    // The whale: prize + their own pro-rata refund = stake + 9% of 1 SOL.
    let whale = env.players[0].pubkey();
    let before = env.balance(whale).await;
    env.send(claim_winnings_ix(0, 0, whale, payer), &[]).await;
    let entry_len = env.entry_account(0, 0).await.data.len();
    let entry_rent = env.rent_minimum(entry_len).await;
    env.send(close_entry_ix(0, 0, whale, payer), &[]).await;
    assert_eq!(
        env.balance(whale).await - before,
        10 * SOL + 9 * SOL / 100 + entry_rent,
        "the winner gets their whole stake back plus 9% of the losers' money"
    );

    // The loser: 89% back, exactly as under v2.
    let loser = env.players[1].pubkey();
    let before = env.balance(loser).await;
    let entry_len = env.entry_account(0, 1).await.data.len();
    let entry_rent = env.rent_minimum(entry_len).await;
    env.send(close_entry_ix(0, 1, loser, payer), &[]).await;
    assert_eq!(env.balance(loser).await - before, 89 * SOL / 100 + entry_rent);

    let round = env.round(0).await;
    assert_eq!(round.vault_owed, 0, "nothing owed, nothing left over");
    env.send(close_round_ix(0, payer, payer), &[]).await;
}

/// Rounds settled before the latch keep v2 behaviour: a v2 config ignores
/// any remaining account and settles exactly as before.
#[tokio::test]
async fn v2_settlement_is_unchanged_and_ignores_the_extra_account() {
    let mut env = Env::setup(2, mock_value(5, 1)).await;
    let payer = env.payer.pubkey();
    env.open_and_deposit(&[10 * SOL, SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    env.send(lock_round_ix(0, payer), &[]).await;
    env.send(request_randomness_ix(0, round_randomness_key(0), payer), &[])
        .await;
    env.send(
        fulfill_settle_v3_ix(0, round_randomness_key(0), payer, entry_key(0, 1)),
        &[],
    )
    .await;
    let round = env.round(0).await;
    assert_eq!(round.admin_cut, 11 * SOL / 100, "v2: 1% of the whole 11 SOL pot");
    assert_eq!(round.winner_payout, 99 * SOL / 100, "v2: 9% of the whole pot");
}

// ─── audit 2026-10-08: cancel_round must not void a revealed outcome ───────

/// `cancel_round` with the pinned randomness account as a named account, so
/// the handler can refuse to cancel once the oracle has revealed. Today the
/// program ignores the extra account (it is appended after the declared
/// list), so this test documents the bug by failing: a round whose value is
/// already public can still be voided by anyone once the reveal deadline
/// has passed, and every losing player has an incentive to race `settle`.
fn cancel_round_with_randomness_ix(round_id: u64, randomness: Pubkey, crank: Pubkey) -> Instruction {
    instruction(
        "cancel_round",
        &[],
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new(round_key(round_id), false),
            AccountMeta::new_readonly(round_vault_key(round_id), false),
            AccountMeta::new_readonly(crank, true),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::ID, false),
            AccountMeta::new(randomness, false),
        ],
    )
}

#[tokio::test]
async fn audit_cancel_round_refuses_a_revealed_randomness() {
    // The mock pinned at request time is already revealed (reveal_slot > 0),
    // exactly the state after a late `reveal_randomness` lands.
    let value = mock_value(5_000_000_000, 1);
    let mut env = Env::setup(2, value).await;
    env.open_and_deposit(&[SOL, 9 * SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    let payer = env.payer.pubkey();
    env.send(lock_round_ix(0, payer), &[]).await;
    env.send(request_randomness_ix(0, round_randomness_key(0), payer), &[]).await;
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::AwaitingRandomness);
    let _ = env.context.warp_to_slot(round.randomness_commit_slot + 401);

    // The outcome is public: anyone can settle. Nobody may cancel instead.
    env.send_fails_with(
        cancel_round_with_randomness_ix(0, round_randomness_key(0), payer),
        &[],
        "RandomnessAlreadyRevealed",
    )
    .await;
    env.send(fulfill_settle_ix(0, round_randomness_key(0), payer), &[]).await;
    assert_eq!(env.round(0).await.state, RoundState::Settled);
}


/// AUDIT P-1, the other half: a pinned randomness account that no longer
/// exists can never reveal, so the round stays refundable after the
/// deadline.
#[tokio::test]
async fn cancel_round_allows_a_closed_randomness_account() {
    let mut env = Env::setup(2, mock_value(5_000_000_000, 1)).await;
    env.open_and_deposit(&[SOL, 9 * SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    let payer = env.payer.pubkey();
    env.send(lock_round_ix(0, payer), &[]).await;
    env.send(request_randomness_ix(0, round_randomness_key(0), payer), &[]).await;
    let round = env.round(0).await;
    let lamports = env.account(round_randomness_key(0)).await.expect("mock").lamports;
    env.context.set_account(
        &round_randomness_key(0),
        // A closed account reads as a plain system-owned account. Same
        // lamports, so the harness's capitalization check still balances.
        &solana_sdk::account::Account {
            lamports,
            data: vec![],
            owner: solana_sdk::system_program::ID,
            executable: false,
            rent_epoch: 0,
        }
        .into(),
    );
    let _ = env.context.warp_to_slot(round.randomness_commit_slot + 401);
    env.send(cancel_round_ix(0, payer), &[]).await;
    assert_eq!(env.round(0).await.state, RoundState::Cancelled);
}

/// AUDIT P-3: the admin cannot zero the levers that void rounds or prizes,
/// and cannot swap the oracle queue while rounds are live.
#[tokio::test]
async fn p3_update_config_floors_and_queue_freeze() {
    let mut env = Env::setup(1, mock_value(5, 1)).await;
    let admin = env.admin.insecure_clone();
    for (args, what) in [
        (UpdateConfigArgs { claim_deadline_secs: Some(0), ..UpdateConfigArgs::default() }, "claim deadline 0"),
        (UpdateConfigArgs { claim_deadline_secs: Some(86_399), ..UpdateConfigArgs::default() }, "claim deadline < 1 day"),
        (UpdateConfigArgs { randomness_reveal_deadline_slots: Some(0), ..UpdateConfigArgs::default() }, "reveal deadline 0"),
        (UpdateConfigArgs { round_duration_secs: Some(5), ..UpdateConfigArgs::default() }, "round 5 s"),
    ] {
        let _ = what;
        env.send_fails_with(update_config_ix(admin.pubkey(), &args), &[&admin], "ConfigBelowMinimum")
            .await;
    }
    // At the floors: accepted.
    env.send(
        update_config_ix(
            admin.pubkey(),
            &UpdateConfigArgs {
                claim_deadline_secs: Some(86_400),
                randomness_reveal_deadline_slots: Some(150),
                ..UpdateConfigArgs::default()
            },
        ),
        &[&admin],
    )
    .await;

    // Oracle queue: refused while live, accepted while paused.
    let new_queue = Pubkey::new_unique();
    let swap = UpdateConfigArgs { oracle_queue: Some(new_queue), ..UpdateConfigArgs::default() };
    env.send_fails_with(update_config_ix(admin.pubkey(), &swap), &[&admin], "OracleQueueChangeRequiresPause")
        .await;
    env.send(toggle_pause_ix(admin.pubkey()), &[&admin]).await;
    env.send(update_config_ix(admin.pubkey(), &swap), &[&admin]).await;
    let config: GlobalConfig = env.config().await;
    assert_eq!(config.oracle_queue, new_queue);
    // Re-sending the SAME queue unpaused is a no-op, not an error.
    env.send(toggle_pause_ix(admin.pubkey()), &[&admin]).await;
    env.send(update_config_ix(admin.pubkey(), &swap), &[&admin]).await;
}

/// AUDIT P-4: the round PDA is the randomness account's only authority, so
/// `close_round` must never run while Switchboard still holds the rent.
/// `close_randomness` clears the pin, and only then can the round close.
/// (The already-closed branch — pin left set by an older build — needs a
/// zero-lamport account, which program-test's capitalization check cannot
/// fabricate; the devnet upgrade exercises it on the rounds in flight.)
#[tokio::test]
async fn p4_close_round_waits_for_close_randomness() {
    let mut env = Env::setup(2, mock_value(2_000_000_002, 1)).await;
    let payer = env.payer.pubkey();
    let (oracle, queue) = (env.oracle_id, env.queue_id);
    env.open_and_deposit(&[SOL, 3 * SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    env.send(lock_round_ix(0, payer), &[]).await;
    env.send(request_randomness_ix(0, round_randomness_key(0), payer), &[]).await;
    env.send(fulfill_settle_ix(0, round_randomness_key(0), payer), &[]).await;
    let ticket = env.round(0).await.winning_ticket;
    let winner_idx: u32 = if ticket >= SOL { 1 } else { 0 };
    let winner = env.players[winner_idx as usize].pubkey();
    env.send(claim_winnings_ix(0, winner_idx, winner, payer), &[]).await;
    for i in 0..2u32 {
        env.send(close_entry_ix(0, i, env.players[i as usize].pubkey(), payer), &[]).await;
    }

    // Pinned: close_round is refused (send_raw — no automatic reclaim).
    env.send_raw_fails_with(close_round_ix(0, payer, payer), "RandomnessNotClosed").await;

    assert_ne!(env.round(0).await.randomness_account, Pubkey::default());
    env.send(close_randomness_ix(0, round_randomness_key(0), queue, oracle, payer), &[]).await;
    assert_eq!(env.round(0).await.randomness_account, Pubkey::default(), "the close clears the pin");
    // A second close_randomness has nothing left to do and is refused.
    env.send_raw_fails_with(
        close_randomness_ix(0, round_randomness_key(0), queue, oracle, payer),
        "RandomnessAccountMismatch",
    )
    .await;
    env.send(close_round_ix(0, payer, payer), &[]).await;
    assert!(env.account(round_key(0)).await.is_none());
}


// ─── randomness fallback: self-hosted entropy provider (design §2.2) ──────

fn chain_key() -> Pubkey {
    Pubkey::find_program_address(&[b"entropy_chain"], &PROGRAM_ID).0
}

fn sha(bytes: &[u8]) -> [u8; 32] {
    hashv(&[bytes]).to_bytes()
}

/// A hash chain `x_0 .. x_n` with `x_{i+1} = sha256(x_i)`. The commit is
/// `x_n`; reveals go `x_{n-1}`, `x_{n-2}`, …
fn make_chain(n: usize) -> Vec<[u8; 32]> {
    let mut links = vec![[9u8; 32]];
    for _ in 0..n {
        let next = sha(links.last().expect("link"));
        links.push(next);
    }
    links
}

fn set_entropy_chain_ix(admin: Pubkey, commit: [u8; 32], length: u64) -> Instruction {
    let mut data = commit.to_vec();
    data.extend_from_slice(&length.to_le_bytes());
    instruction(
        "set_entropy_chain",
        &data,
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new(chain_key(), false),
            AccountMeta::new(admin, true),
            AccountMeta::new_readonly(solana_sdk::system_program::ID, false),
        ],
    )
}

fn request_entropy_ix(round_id: u64, crank: Pubkey) -> Instruction {
    instruction(
        "request_entropy",
        &[],
        vec![
            AccountMeta::new_readonly(config_key(), false),
            AccountMeta::new(round_key(round_id), false),
            AccountMeta::new(chain_key(), false),
            AccountMeta::new_readonly(crank, true),
        ],
    )
}

fn reveal_entropy_ix(round_id: u64, seed: [u8; 32], crank: Pubkey) -> Instruction {
    instruction(
        "reveal_entropy",
        &seed,
        vec![
            AccountMeta::new_readonly(round_key(round_id), false),
            AccountMeta::new(chain_key(), false),
            AccountMeta::new_readonly(solana_sdk::sysvar::slot_hashes::ID, false),
            AccountMeta::new_readonly(crank, true),
        ],
    )
}

fn provider_args(provider: OracleProvider) -> UpdateConfigArgs {
    UpdateConfigArgs {
        oracle_provider: Some(provider),
        ..Default::default()
    }
}

impl Env {
    async fn chain(&mut self) -> EntropyChain {
        let data = self.account(chain_key()).await.expect("chain").data;
        EntropyChain::deserialize(&mut &data[8..]).expect("chain decode")
    }

    /// Sets a fresh chain and flips NEW rounds to the entropy provider.
    async fn use_entropy(&mut self, links: &[[u8; 32]]) {
        let admin = self.admin.insecure_clone();
        let commit = *links.last().expect("commit");
        self.send(
            set_entropy_chain_ix(admin.pubkey(), commit, (links.len() - 1) as u64),
            &[&admin],
        )
        .await;
        self.send(
            update_config_ix(admin.pubkey(), &provider_args(OracleProvider::Entropy)),
            &[&admin],
        )
        .await;
    }

    /// Warps until SlotHashes holds a produced slot at or after `target`
    /// (each warp creates one bank, i.e. one SlotHashes entry).
    async fn warp_past(&mut self, target: u64) {
        let now = self.clock().await.slot;
        let _ = self.context.warp_to_slot(now.max(target) + 1);
        let now = self.clock().await.slot;
        let _ = self.context.warp_to_slot(now + 1);
    }

    /// The first produced slot at or after `target`, from the live sysvar.
    async fn slot_hash_at_or_after(&mut self, target: u64) -> (u64, [u8; 32]) {
        let data = self
            .account(solana_sdk::sysvar::slot_hashes::ID)
            .await
            .expect("slot hashes")
            .data;
        orbit_jackpot::oracle::entropy::find_slot_hash(&data, target).expect("target hash")
    }
}

#[tokio::test]
async fn entropy_round_settles_from_the_revealed_chain_link() {
    let mut env = Env::setup(3, mock_value(0, 1)).await;
    let links = make_chain(4);
    env.use_entropy(&links).await;
    let payer = env.payer.pubkey();
    env.open_and_deposit(&[SOL, 3 * SOL, 6 * SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    env.send(lock_round_ix(0, payer), &[]).await;

    // Same no-re-roll pin as Switchboard: Locked → AwaitingRandomness.
    env.send(request_entropy_ix(0, payer), &[]).await;
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::AwaitingRandomness);
    assert_eq!(round.randomness_account, chain_key());
    let chain = env.chain().await;
    assert_eq!(chain.pending_round, 0);
    assert_eq!(chain.target_slot, round.randomness_commit_slot + 2);
    assert!(chain.target_slot > round.lock_slot, "target after lock");

    // A second request is a re-roll attempt.
    env.send_fails_with(request_entropy_ix(0, payer), &[], "RandomnessAlreadyPinned")
        .await;
    // Before the target has a hash, nothing can be revealed.
    env.send_fails_with(reveal_entropy_ix(0, links[3], payer), &[], "EntropyTargetNotReached")
        .await;

    let target = chain.target_slot;
    env.warp_past(target).await;
    // Only the committed link opens the chain.
    env.send_fails_with(reveal_entropy_ix(0, links[2], payer), &[], "EntropySeedMismatch")
        .await;
    env.send(reveal_entropy_ix(0, links[3], payer), &[]).await;

    let chain = env.chain().await;
    let (slot, slot_hash) = env.slot_hash_at_or_after(target).await;
    let expected = orbit_jackpot::oracle::entropy::entropy_value(
        b"orb-entropy-v1",
        0,
        &slot_hash,
        &links[3],
    );
    assert_eq!(chain.value, expected, "value recomputable from public inputs");
    assert_eq!(chain.value_slot, slot);
    assert_eq!(chain.value_round, 0);
    assert_eq!(chain.commit, links[3], "next link locked in");
    assert_eq!(chain.remaining, 3);
    assert_eq!(chain.pending_round, u64::MAX);

    env.send(fulfill_settle_ix(0, chain_key(), payer), &[]).await;
    let round = env.round(0).await;
    assert_eq!(round.state, RoundState::Settled);
    let (ticket_seed, _) = orbit_jackpot::entropy::split_entropy(&expected);
    assert_eq!(
        round.winning_ticket,
        orbit_jackpot::math::ticket_from_entropy(ticket_seed, 10 * SOL).expect("ticket")
    );
    assert_eq!(round.randomness_seed_slot, slot);
    env.assert_round_vault_solvent(0).await;
    assert_eq!(env.chain().await.value_round, u64::MAX, "consumed by settle");

    // Terminal: close_randomness only clears the pin (nothing to reclaim).
    let oracle = env.oracle_id;
    let queue = env.queue_id;
    let reclaimer = env.reclaimer.insecure_clone();
    let chain_lamports = env.balance(chain_key()).await;
    env.send(
        close_randomness_ix(0, chain_key(), queue, oracle, reclaimer.pubkey()),
        &[&reclaimer],
    )
    .await;
    assert_eq!(env.round(0).await.randomness_account, Pubkey::default());
    assert_eq!(env.balance(chain_key()).await, chain_lamports, "chain untouched");
}

#[tokio::test]
async fn entropy_provider_gates_both_directions() {
    let mut env = Env::setup(2, mock_value(0, 1)).await;
    let links = make_chain(2);
    let admin = env.admin.insecure_clone();
    env.send(
        set_entropy_chain_ix(admin.pubkey(), links[2], 2),
        &[&admin],
    )
    .await;
    let payer = env.payer.pubkey();
    env.open_and_deposit(&[SOL, SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    env.send(lock_round_ix(0, payer), &[]).await;
    // Provider is Switchboard: the entropy path is refused.
    env.send_fails_with(request_entropy_ix(0, payer), &[], "OracleProviderMismatch")
        .await;
    env.send(
        update_config_ix(admin.pubkey(), &provider_args(OracleProvider::Entropy)),
        &[&admin],
    )
    .await;
    assert_eq!(env.config().await.oracle_provider, OracleProvider::Entropy);
    // Provider is Entropy: the Switchboard pin is refused.
    env.send_fails_with(
        request_randomness_ix(0, round_randomness_key(0), payer),
        &[],
        "OracleProviderMismatch",
    )
    .await;
    // Only the admin can set a chain or flip the provider.
    let rando = env.players[0].insecure_clone();
    env.send_fails_with(
        set_entropy_chain_ix(rando.pubkey(), links[2], 2),
        &[&rando],
        "UnauthorizedAdmin",
    )
    .await;
    env.send_fails_with(
        update_config_ix(rando.pubkey(), &provider_args(OracleProvider::Switchboard)),
        &[&rando],
        "UnauthorizedAdmin",
    )
    .await;
    // A zero commit or empty chain is refused.
    env.send_fails_with(
        set_entropy_chain_ix(admin.pubkey(), [0u8; 32], 2),
        &[&admin],
        "InvalidEntropyCommit",
    )
    .await;
}

#[tokio::test]
async fn entropy_chain_is_busy_while_a_round_is_in_flight() {
    let mut env = Env::setup(2, mock_value(0, 1)).await;
    let links = make_chain(3);
    env.use_entropy(&links).await;
    let admin = env.admin.insecure_clone();
    let payer = env.payer.pubkey();
    env.open_and_deposit(&[SOL, SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    env.send(lock_round_ix(0, payer), &[]).await;
    env.send(request_entropy_ix(0, payer), &[]).await;
    // No rotation while a target slot is pending.
    env.send_fails_with(
        set_entropy_chain_ix(admin.pubkey(), [5u8; 32], 9),
        &[&admin],
        "EntropyChainBusy",
    )
    .await;
    let target = env.chain().await.target_slot;
    env.warp_past(target).await;
    env.send(reveal_entropy_ix(0, links[2], payer), &[]).await;
    // Revealed but unsettled: still busy (the value must be consumed).
    env.send_fails_with(
        set_entropy_chain_ix(admin.pubkey(), [5u8; 32], 9),
        &[&admin],
        "EntropyChainBusy",
    )
    .await;
    env.send(fulfill_settle_ix(0, chain_key(), payer), &[]).await;
    // Free again: rotation is allowed between rounds.
    env.send(
        set_entropy_chain_ix(admin.pubkey(), [5u8; 32], 9),
        &[&admin],
    )
    .await;
    assert_eq!(env.chain().await.remaining, 9);
}

#[tokio::test]
async fn entropy_withheld_reveal_cancels_only_after_the_long_deadline() {
    let mut env = Env::setup(2, mock_value(0, 1)).await;
    let links = make_chain(2);
    env.use_entropy(&links).await;
    let payer = env.payer.pubkey();
    env.open_and_deposit(&[SOL, 2 * SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    env.send(lock_round_ix(0, payer), &[]).await;
    env.send(request_entropy_ix(0, payer), &[]).await;
    let commit_slot = env.round(0).await.randomness_commit_slot;

    // Past the Switchboard deadline (400) but not the entropy one: a
    // withheld reveal must not buy a quick refund.
    let _ = env.context.warp_to_slot(commit_slot + 401);
    env.send_fails_with(
        cancel_round_with_randomness_ix(0, chain_key(), payer),
        &[],
        "RevealDeadlineNotElapsed",
    )
    .await;
    let _ = env.context.warp_to_slot(commit_slot + 216_001);
    env.send(cancel_round_with_randomness_ix(0, chain_key(), payer), &[])
        .await;
    assert_eq!(env.round(0).await.state, RoundState::Cancelled);
    assert_eq!(env.chain().await.pending_round, u64::MAX, "chain released");
    // A late reveal of the cancelled round is refused.
    env.send_fails_with(reveal_entropy_ix(0, links[1], payer), &[], "EntropyNotPending")
        .await;
    env.assert_round_vault_solvent(0).await;
}

#[tokio::test]
async fn entropy_revealed_round_can_never_cancel_and_settles_late() {
    let mut env = Env::setup(2, mock_value(0, 1)).await;
    let links = make_chain(2);
    env.use_entropy(&links).await;
    let payer = env.payer.pubkey();
    env.open_and_deposit(&[SOL, 2 * SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    env.send(lock_round_ix(0, payer), &[]).await;
    env.send(request_entropy_ix(0, payer), &[]).await;
    let round = env.round(0).await;
    let target = env.chain().await.target_slot;
    env.warp_past(target).await;
    env.send(reveal_entropy_ix(0, links[1], payer), &[]).await;

    // AUDIT P-1 for entropy: a public value is never voidable, even long
    // after the deadline (and far outside the SlotHashes window).
    let _ = env.context.warp_to_slot(round.randomness_commit_slot + 216_001);
    env.send_fails_with(
        cancel_round_with_randomness_ix(0, chain_key(), payer),
        &[],
        "RandomnessAlreadyRevealed",
    )
    .await;
    env.send(fulfill_settle_ix(0, chain_key(), payer), &[]).await;
    assert_eq!(env.round(0).await.state, RoundState::Settled);
}

#[tokio::test]
async fn provider_flip_never_reroutes_an_in_flight_switchboard_round() {
    // Round 0 is pinned to a REVEALED Switchboard account (boot's mock).
    let mut env = Env::setup(2, mock_value(0, 1)).await;
    let payer = env.payer.pubkey();
    env.open_and_deposit(&[SOL, 2 * SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    env.send(lock_round_ix(0, payer), &[]).await;
    env.send(request_randomness_ix(0, round_randomness_key(0), payer), &[])
        .await;
    let commit_slot = env.round(0).await.randomness_commit_slot;

    // The admin switches NEW rounds to entropy mid-flight.
    let links = make_chain(2);
    env.use_entropy(&links).await;

    // The flip must not turn the revealed Switchboard account into a
    // cancellable "closed" one (the P-1 hazard in design §4.3).
    let _ = env.context.warp_to_slot(commit_slot + 401);
    env.send_fails_with(cancel_round_ix(0, payer), &[], "RandomnessAlreadyRevealed")
        .await;
    // Nor can the entropy path touch it.
    env.send_fails_with(request_entropy_ix(0, payer), &[], "RandomnessAlreadyPinned")
        .await;
    // It settles on Switchboard exactly as before.
    env.send(fulfill_settle_ix(0, round_randomness_key(0), payer), &[])
        .await;
    assert_eq!(env.round(0).await.state, RoundState::Settled);
    // Presenting the chain for a Switchboard-pinned round is refused.
    env.assert_round_vault_solvent(0).await;
}

#[tokio::test]
async fn entropy_settle_refuses_a_foreign_account_and_an_unrevealed_chain() {
    let mut env = Env::setup(2, mock_value(0, 1)).await;
    let links = make_chain(2);
    env.use_entropy(&links).await;
    let payer = env.payer.pubkey();
    env.open_and_deposit(&[SOL, 2 * SOL]).await;
    env.advance_seconds(ROUND_DURATION_SECS + 1).await;
    env.send(lock_round_ix(0, payer), &[]).await;
    env.send(request_entropy_ix(0, payer), &[]).await;
    // Unrevealed: no settle.
    env.send_fails_with(fulfill_settle_ix(0, chain_key(), payer), &[], "RandomnessNotRevealed")
        .await;
    // A revealed Switchboard mock is not this round's pin.
    env.send_fails_with(
        fulfill_settle_ix(0, round_randomness_key(0), payer),
        &[],
        "RandomnessAccountMismatch",
    )
    .await;
}
