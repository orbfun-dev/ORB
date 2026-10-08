/**
 * High-level client: account fetchers, transaction builders, and event
 * subscriptions for the Orbit Jackpot program.
 *
 * Transaction builders are raw `@solana/web3.js` instructions — no IDL
 * fetch required. The 8-byte Anchor sighash discriminators are committed
 * constants (sha256("global:<name>")[..8], generated from the program
 * source), and the few borsh arguments (u64 amount, u32 entry index) are
 * encoded inline; nothing here can drift silently because the parity and
 * integration suites exercise the same encodings as the Rust harness.
 *
 * Account fetchers decode raw account data through the offset-pinned
 * decoders in `accounts.ts` (byte-verified against the Rust layout
 * fixture). Event subscriptions use the dual transport in `events.ts` —
 * inner instructions for the `emit_cpi!` trio, program logs for the
 * `emit!` events — anchor 0.32's log-only listener cannot see CPI events.
 */

import {
  Connection,
  GetProgramAccountsFilter,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_SLOT_HASHES_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  ACCOUNT_SIZES,
  decodeEntropyChain,
  decodeGlobalConfig,
  ORACLE_PROVIDERS,
  decodeMegaPotVault,
  decodePlayerEntry,
  decodePlayerEscrow,
  decodeRound,
  ROUND_ENTRY_COUNT_OFFSET,
} from "./accounts";
import type {
  EntropyChainData,
  GlobalConfigData,
  OracleProviderName,
  MegaPotVaultData,
  PlayerEntryAccountData,
  PlayerEscrowData,
  RoundData,
} from "./accounts";
import type {
  AccountOpenedEvent,
  AutoDepositedEvent,
  DepositedEvent,
  EconomicsMigratedEvent,
  EntryRefundPaidEvent,
  EscrowDepletedEvent,
  EscrowFundedEvent,
  EscrowWithdrawnEvent,
  MegaPotDrainedPreflightEvent,
  MegaPotTriggeredEvent,
  OrbitEventName,
  OrbitEventEnvelope,
  OrbitEventFeedOptions,
  PrizeClaimedEvent,
  RoundCancelledEvent,
  RoundDustSweptEvent,
  RoundLockedEvent,
  RoundOpenedEvent,
  RoundWindowRolledEvent,
  RoundSettledEvent,
} from "./events";
import { OrbitEventFeed } from "./events";
import {
  configKey,
  entropyChainKey,
  entryKey,
  escrowKey,
  eventAuthorityKey,
  megaPotKey,
  PROGRAM_ID,
  roundKey,
  roundVaultKey,
  treasuryKey,
  u16Le,
  u32Le,
  u64Le,
} from "./pda";

/** sha256("global:<instruction>")[..8] — Anchor sighash discriminators. */
export const INSTRUCTION_DISCRIMINATORS: Readonly<Record<string, string>> = {
  initialize: "afaf6d1f0d989bed",
  update_config: "1d9efcbf0a53db63",
  transfer_admin: "2af2426ae40a6f9c",
  accept_admin: "702a2d5a74b50daa",
  open_round: "42eb7bf00823b99f",
  deposit: "f223c68952e1f2b6",
  lock_round: "447c2be61e2cf8e3",
  request_randomness: "d505ada625ec1f12",
  create_randomness: "26a26be5984fd017",
  commit_randomness: "9234c3dc4f1e351a",
  reveal_randomness: "1e8255dcd0501ca9",
  fulfill_settle: "78ab73054b43bb43",
  claim_winnings: "a1d7183b0eecf2dd",
  cancel_round: "524686362e609408",
  set_entropy_chain: "bca8c6b629e4bf23",
  request_entropy: "e66c1accaf8ff12b",
  reveal_entropy: "709dae7be95310ee",
  refund_entry: "d6058817fd07e651",
  sweep_unclaimed_prize: "72cea44accc08538",
  close_entry: "841aca91be257243",
  close_round: "950e5158e6e2ea25",
  close_randomness: "f8105307bf85afac",
  migrate_economics_v3: "016c4d3451e5d242",
  admin_sweep_fees: "f682dc94f34f871e",
  toggle_pause: "eeedce1bff5f7be5",
  init_or_deposit_escrow: "aaab2d6f0d3310d5",
  withdraw_escrow: "5154e280f52f6068",
  crank_auto_deposit: "03fadfa27cca71af",
  migrate_economics_v2: "b4c9b6ad6edfef53",
  drain_mega_pot_v1_preflight: "675c522e65fb2472",
} as const;

function providerTag(name: OracleProviderName): number {
  const tag = ORACLE_PROVIDERS.indexOf(name);
  if (tag < 0) throw new RangeError(`unknown oracle provider ${name}`);
  return tag;
}

/** `UpdateConfigArgs` field count before `oracle_provider` (all `Option`s). */
const UPDATE_CONFIG_LEADING_OPTIONS = 15;

function disc(name: keyof typeof INSTRUCTION_DISCRIMINATORS): Buffer {
  return Buffer.from(INSTRUCTION_DISCRIMINATORS[name]!, "hex");
}

/**
 * The close_entry batch width (Phase 11.8): 4 shared + 2-per-entry account
 * keys against the 1232-byte packet, minus signature/blockhash/ix overhead
 * — 11 with a conservative margin (the design's figure; the naive key
 * ceiling would admit 13). Exceeding it throws, never truncates.
 */
export const CLOSE_ENTRY_MAX_PER_TX = 11;

/** `MigrateEconomicsV2Args` — the one-way latch's seven fields (ADR-11). */
export interface MigrateEconomicsV2ArgsData {
  /** With `refundBps` and the immutable fee bps must sum to 10_000 (I14). */
  winnerBps: number;
  refundBps: number;
  /** With `megaFieldBps` at most 10_000. */
  megaAwardBps: number;
  megaFieldBps: number;
  /** 1-in-N trigger odds (decision D2: 625). */
  megaTriggerModulus: number;
  /** Must be > 0 and satisfy I21: ≤ modulus × (admin + mega) bps. */
  megaPayoutCapBps: number;
  /** ≤ MAX_ACCOUNT_OPEN_FEE_LAMPORTS (0.05 SOL) on-chain. */
  accountOpenFeeLamports: bigint;
}

/** Little-endian signed 64-bit (initialize's i64 durations). */
function i64Le(value: bigint): Buffer {
  const buf = u64Le(BigInt.asUintN(64, value));
  return buf;
}

/** `initialize` operational args — the immutable economics are NOT here (ADR-10). */
export interface InitializeArgsData {
  treasuryAuthority: PublicKey;
  oracleProgramId: PublicKey;
  /** Pinned Switchboard On-Demand queue; must not be the default pubkey. */
  oracleQueue: PublicKey;
  oracleProvider: OracleProviderName;
  /** `0` = unlimited entries. */
  maxEntriesPerRound: number;
  roundDurationSecs: bigint;
  maxRoundDurationSecs: bigint;
  antiSnipeWindowSecs: bigint;
  antiSnipeExtensionSecs: bigint;
  claimDeadlineSecs: bigint;
  minDepositLamports: bigint;
  antiSnipeMinDepositLamports: bigint;
  keeperTipLamports: bigint;
  /** Must stay < 512 (SlotHashes retention). */
  randomnessRevealDeadlineSlots: bigint;
  /** Phase 10: pass `0n / 0n / false` to birth with the feature off. */
  autoDepositWindowSecs: bigint;
  autoDepositTipLamports: bigint;
  autoDepositEnabled: boolean;
  /**
   * Phase 11.6: the one-time PlayerEscrow profile fee (seeds the
   * Mega-Pot). Optional and defaults to `0n` — a fresh deployment births
   * at `economicsVersion 2` either way; the fee is the one admin-mutable
   * economics-adjacent field, ceiling-checked on-chain.
   */
  accountOpenFeeLamports?: bigint;
}

/**
 * The one legal `close_round` destination for a round (Phase 12 R5): the
 * account that funded its rent at `open_round`, falling back to the config
 * admin when `rentPayer` is the all-zero legacy sentinel (every round
 * opened before the Phase 12 upgrade) — the value mirror of the program's
 * `Round::rent_reclaim_destination`. Callers must derive the destination
 * from this helper instead of hardcoding the admin.
 */
export function rentReclaimDestination(
  round: RoundData,
  config: GlobalConfigData,
): PublicKey {
  return round.rentPayer === SystemProgram.programId.toBase58()
    ? new PublicKey(config.admin)
    : new PublicKey(round.rentPayer);
}

export class OrbitJackpotClient {
  readonly connection: Connection;
  readonly programId: PublicKey;
  /** Default fee payer / permissionless crank keypair's pubkey, if set. */
  readonly payer?: PublicKey;

  /**
   * Ignored since 0.2.0: event subscriptions run on the dedicated CPI
   * transport (`events.ts`) and no longer need an anchor `Program`.
   * The parameter is retained for source compatibility.
   */
  readonly program?: unknown;

  private readonly feed: OrbitEventFeed;

  /**
   * The CPI-event transport backing every `subscribe*` method. Public so
   * UI state layers can attach `onError` (dropped/undecodable events) and
   * drive their polling fallback — see `OrbitEventFeedOptions`.
   */
  get events(): OrbitEventFeed {
    return this.feed;
  }

  /**
   * `eventOptions` feeds the CPI-event transport: `onError` is the ONLY
   * error surface for dropped/undecodable events (the feed never throws),
   * and `retryMs` tunes its fetch backoff.
   */
  constructor(
    connection: Connection,
    _program?: unknown,
    programId: PublicKey = PROGRAM_ID,
    payer?: PublicKey,
    eventOptions?: OrbitEventFeedOptions,
  ) {
    this.connection = connection;
    this.programId = programId;
    this.program = _program;
    this.payer = payer;
    this.feed = new OrbitEventFeed(connection, programId, eventOptions);
  }

  // ── account fetchers (offset-pinned decoders) ─────────────────────────

  /** The singleton config, or `null` before `initialize`. */
  async fetchConfig(): Promise<GlobalConfigData | null> {
    const info = await this.connection.getAccountInfo(configKey());
    return info === null ? null : decodeGlobalConfig(info.data);
  }

  /** The entropy chain singleton, or `null` before `set_entropy_chain`. */
  async fetchEntropyChain(): Promise<EntropyChainData | null> {
    const info = await this.connection.getAccountInfo(entropyChainKey());
    return info === null ? null : decodeEntropyChain(info.data);
  }

  /** One round by id, or `null` if not yet opened. */
  async fetchRound(roundId: bigint): Promise<RoundData | null> {
    const info = await this.connection.getAccountInfo(roundKey(roundId));
    return info === null ? null : decodeRound(info.data);
  }

  /** The progressive jackpot singleton. */
  async fetchMegaPot(): Promise<MegaPotVaultData | null> {
    const info = await this.connection.getAccountInfo(megaPotKey());
    return info === null ? null : decodeMegaPotVault(info.data);
  }

  /** One entry of a round, or `null`. */
  async fetchEntry(
    roundId: bigint,
    entryIndex: number,
  ): Promise<PlayerEntryAccountData | null> {
    const info = await this.connection.getAccountInfo(
      entryKey(roundId, entryIndex),
    );
    return info === null ? null : decodePlayerEntry(info.data);
  }

  /** The owner's `PlayerEscrow`, or `null` if never funded (Phase 10). */
  async fetchEscrow(owner: PublicKey): Promise<PlayerEscrowData | null> {
    const info = await this.connection.getAccountInfo(escrowKey(owner));
    return info === null ? null : decodePlayerEscrow(info.data);
  }

  /**
   * Every entry of a round, index-ordered — the input
   * `calculateWheelSlices` and `findWinningEntry` expect.
   *
   * Primary path: `getProgramAccounts` with the documented memcmp filter
   * (player_entry.rs: `round_id` at byte offset 8, dataSize 109). Public
   * RPCs reject or rate-limit GPA under load, so on ANY failure this falls
   * back to chunked `getMultipleAccounts` over the derived entry PDAs
   * (`entryKey(roundId, 0..entry_count)` — 100 per chunk). The fallback
   * yields `null`-holes for closed entries, which the caller's sparse-book
   * sanitizer already tolerates.
   */
  async fetchEntries(roundId: bigint): Promise<PlayerEntryAccountData[]> {
    const filters: GetProgramAccountsFilter[] = [
      { dataSize: ACCOUNT_SIZES.PlayerEntry! },
      { memcmp: { offset: 8, bytes: bs58.encode(u64Le(roundId)) } },
    ];
    try {
      const accounts = await this.connection.getProgramAccounts(this.programId, { filters });
      return accounts
        .map(({ account }) => decodePlayerEntry(account.data))
        .sort((a, b) => a.entryIndex - b.entryIndex);
    } catch {
      // GPA refused (public RPC policy / rate limit) — derive the book.
      const round = await this.fetchRound(roundId);
      const count = round?.entryCount ?? 0;
      if (count === 0) return [];
      const indices = Array.from({ length: count }, (_, i) => i);
      const chunks: number[][] = [];
      for (let i = 0; i < indices.length; i += 100) {
        chunks.push(indices.slice(i, i + 100));
      }
      const entries: PlayerEntryAccountData[] = [];
      for (const chunk of chunks) {
        const keys = chunk.map((i) => entryKey(roundId, i));
        const infos = await this.connection.getMultipleAccountsInfo(keys, "confirmed");
        for (const info of infos) {
          if (info === null) continue; // closed entry — sparse-book case
          entries.push(decodePlayerEntry(info.data));
        }
      }
      return entries.sort((a, b) => a.entryIndex - b.entryIndex);
    }
  }

  /**
   * The round's current `entry_count` — the next deposit's index. Read at
   * the layout-pinned offset (`ROUND_ENTRY_COUNT_OFFSET`, verified against
   * the Rust fixture); the caller retries on contention (roadmap 6.7).
   */
  async nextEntryIndex(roundId: bigint): Promise<number> {
    const info = await this.connection.getAccountInfo(roundKey(roundId));
    if (info === null) {
      throw new Error(`round ${roundId} not found`);
    }
    return info.data.readUInt32LE(ROUND_ENTRY_COUNT_OFFSET);
  }

  // ── transaction builders (each returns a ready-to-sign Transaction) ────

  /** The one-time program setup; economics are hardcoded on-chain (ADR-10). */
  buildInitializeTx(admin: PublicKey, args: InitializeArgsData): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: true },
        { pubkey: treasuryKey(), isSigner: false, isWritable: true },
        { pubkey: megaPotKey(), isSigner: false, isWritable: true },
        { pubkey: admin, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: Buffer.concat([
        disc("initialize"),
        args.treasuryAuthority.toBuffer(),
        args.oracleProgramId.toBuffer(),
        args.oracleQueue.toBuffer(),
        Buffer.from([providerTag(args.oracleProvider)]),
        u32Le(args.maxEntriesPerRound),
        i64Le(args.roundDurationSecs),
        i64Le(args.maxRoundDurationSecs),
        i64Le(args.antiSnipeWindowSecs),
        i64Le(args.antiSnipeExtensionSecs),
        i64Le(args.claimDeadlineSecs),
        u64Le(args.minDepositLamports),
        u64Le(args.antiSnipeMinDepositLamports),
        u64Le(args.keeperTipLamports),
        u64Le(args.randomnessRevealDeadlineSlots),
        i64Le(args.autoDepositWindowSecs),
        u64Le(args.autoDepositTipLamports),
        Buffer.from([args.autoDepositEnabled ? 1 : 0]),
        u64Le(args.accountOpenFeeLamports ?? 0n),
      ]),
    });
    return tx;
  }

  /**
   * Open round `nextRoundId` (read from `config.next_round_id` by the
   * caller — both PDAs derive from it). `previousRound` is the ACTIVE
   * round's key when one exists; `undefined` (no round ever opened) is
   * encoded as the program-id sentinel meta — anchor 0.32's wire form for
   * a trailing `Option<Account>` = `None`.
   */
  buildOpenRoundTx(
    payer: PublicKey,
    nextRoundId: bigint,
    previousRound?: PublicKey,
  ): Transaction {
    const keys = [
      { pubkey: configKey(), isSigner: false, isWritable: true },
      { pubkey: roundKey(nextRoundId), isSigner: false, isWritable: true },
      { pubkey: roundVaultKey(nextRoundId), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: previousRound ?? this.programId, isSigner: false, isWritable: false },
    ];
    const tx = new Transaction();
    tx.add({
      keys,
      programId: this.programId,
      data: disc("open_round"),
    });
    return tx;
  }

  /**
   * Pin the randomness account (Locked → AwaitingRandomness). The account's
   * owner must be `config.oracle_program_id` and its embedded authority
   * must be the round PDA — checked on-chain (ADR-4).
   */
  buildRequestRandomnessTx(
    roundId: bigint,
    randomnessAccount: PublicKey,
    authority: PublicKey,
  ): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: false },
        { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
        { pubkey: roundVaultKey(roundId), isSigner: false, isWritable: false },
        { pubkey: randomnessAccount, isSigner: false, isWritable: false },
        { pubkey: authority, isSigner: true, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: disc("request_randomness"),
    });
    return tx;
  }

  /**
   * The commit half of ADR-4: the ROUND PDA signs the Switchboard
   * `randomness_commit` CPI through the program, exactly once (the account
   * must be unrevealed). `queue` must equal `config.oracleQueue` and
   * `oracleProgram` must equal `config.oracleProgramId` — both re-checked
   * on-chain. `oracle` arrives WRITABLE (the oracle program bumps its own
   * stats) — pinned by the Rust `cpi_metas_match_the_context_mut_set` test.
   * Permissionless: any `crank` may send it.
   */
  buildCommitRandomnessTx(
    roundId: bigint,
    randomnessAccount: PublicKey,
    queue: PublicKey,
    oracle: PublicKey,
    oracleProgram: PublicKey,
    crank: PublicKey,
  ): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: false },
        { pubkey: roundKey(roundId), isSigner: false, isWritable: false },
        { pubkey: randomnessAccount, isSigner: false, isWritable: true },
        { pubkey: queue, isSigner: false, isWritable: false },
        { pubkey: oracle, isSigner: false, isWritable: true },
        {
          pubkey: SYSVAR_SLOT_HASHES_PUBKEY,
          isSigner: false,
          isWritable: false,
        },
        { pubkey: oracleProgram, isSigner: false, isWritable: false },
        { pubkey: crank, isSigner: true, isWritable: false },
      ],
      programId: this.programId,
      data: disc("commit_randomness"),
    });
    return tx;
  }

  /**
   * Birth the round's Switchboard randomness account via the program's
   * `randomness_init` CPI — the ROUND PDA signs as the account authority
   * (the deployed program demands the authority's signature, so only the
   * program can create it). `randomness` is a FRESH keypair the caller
   * generated and also signs with; `payer` pays creation rent. The LUT
   * trio and program state are Switchboard-program derivations (see
   * `@switchboard-xyz/on-demand`'s `getLutSigner`/`getLutKey`/`State`).
   * `queue` arrives WRITABLE — the live init metas demand it.
   */
  buildCreateRandomnessTx(
    roundId: bigint,
    randomness: PublicKey,
    recentSlot: bigint,
    queue: PublicKey,
    rewardEscrow: PublicKey,
    programState: PublicKey,
    lutSigner: PublicKey,
    lut: PublicKey,
    oracleProgram: PublicKey,
    crank: PublicKey,
  ): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: false },
        { pubkey: roundKey(roundId), isSigner: false, isWritable: false },
        { pubkey: randomness, isSigner: true, isWritable: true },
        { pubkey: queue, isSigner: false, isWritable: true },
        { pubkey: crank, isSigner: true, isWritable: true },
        { pubkey: rewardEscrow, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        {
          pubkey: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: new PublicKey("So11111111111111111111111111111111111111112"),
          isSigner: false,
          isWritable: false,
        },
        { pubkey: programState, isSigner: false, isWritable: false },
        { pubkey: lutSigner, isSigner: false, isWritable: false },
        { pubkey: lut, isSigner: false, isWritable: true },
        {
          pubkey: new PublicKey("AddressLookupTab1e1111111111111111111111111"),
          isSigner: false,
          isWritable: false,
        },
        { pubkey: oracleProgram, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: Buffer.concat([disc("create_randomness"), u64Le(recentSlot)]),
    });
    return tx;
  }

  /**
   * Phase 13 — reclaim a TERMINAL round's Switchboard rent: the round PDA
   * signs the `randomness_close` CPI, closing the randomness account and
   * its wSOL reward escrow into the ROUND account; `close_round` later
   * carries those lamports to `round.rent_payer`. Must run before
   * `close_round` (which deletes the only authority). The LUT is only
   * deactivated; reclaim it after the cooldown with Switchboard's
   * `randomness_close_lut`, signed by the randomness keypair.
   * Permissionless: `crank` pays the fee only.
   */
  buildCloseRandomnessTx(
    roundId: bigint,
    randomness: PublicKey,
    rewardEscrow: PublicKey,
    programState: PublicKey,
    lutSigner: PublicKey,
    lut: PublicKey,
    oracleProgram: PublicKey,
    crank: PublicKey,
  ): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: false },
        { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
        { pubkey: randomness, isSigner: false, isWritable: true },
        { pubkey: rewardEscrow, isSigner: false, isWritable: true },
        { pubkey: programState, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        {
          pubkey: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: new PublicKey("So11111111111111111111111111111111111111112"),
          isSigner: false,
          isWritable: false,
        },
        { pubkey: lut, isSigner: false, isWritable: true },
        { pubkey: lutSigner, isSigner: false, isWritable: false },
        {
          pubkey: new PublicKey("AddressLookupTab1e1111111111111111111111111"),
          isSigner: false,
          isWritable: false,
        },
        { pubkey: oracleProgram, isSigner: false, isWritable: false },
        { pubkey: crank, isSigner: true, isWritable: false },
      ],
      programId: this.programId,
      data: disc("close_randomness"),
    });
    return tx;
  }

  /**
   * Publish the oracle gateway's TEE-signed reveal via the program's
   * `randomness_reveal` CPI — the round PDA signs; `stats` is the oracle
   * program's ["OracleRandomnessStats", oracle] PDA; the reward escrow is
   * the randomness account's wSOL ATA. Args are the gateway payload.
   */
  buildRevealRandomnessTx(
    roundId: bigint,
    randomnessAccount: PublicKey,
    oracle: PublicKey,
    queue: PublicKey,
    stats: PublicKey,
    rewardEscrow: PublicKey,
    programState: PublicKey,
    oracleProgram: PublicKey,
    crank: PublicKey,
    signature: Uint8Array,
    recoveryId: number,
    value: Uint8Array,
  ): Transaction {
    if (signature.length !== 64 || value.length !== 32) {
      throw new Error("reveal args: signature must be 64 bytes, value 32");
    }
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: false },
        { pubkey: roundKey(roundId), isSigner: false, isWritable: false },
        { pubkey: randomnessAccount, isSigner: false, isWritable: true },
        { pubkey: oracle, isSigner: false, isWritable: false },
        { pubkey: queue, isSigner: false, isWritable: false },
        { pubkey: stats, isSigner: false, isWritable: true },
        { pubkey: crank, isSigner: true, isWritable: true },
        { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: rewardEscrow, isSigner: false, isWritable: true },
        {
          pubkey: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: new PublicKey("So11111111111111111111111111111111111111112"),
          isSigner: false,
          isWritable: false,
        },
        { pubkey: programState, isSigner: false, isWritable: false },
        { pubkey: oracleProgram, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: Buffer.concat([
        disc("reveal_randomness"),
        Buffer.from(signature),
        Buffer.from([recoveryId]),
        Buffer.from(value),
      ]),
    });
    return tx;
  }

  /**
   * Escrow `amountLamports` from `player`, minting the next entry. The
   * first-ever bet also creates the player's profile escrow and pays the
   * one-time account-open fee (Phase 11.6) — breaking change to the
   * account list since 0.3.0.
   */
  async buildDepositTx(
    player: PublicKey,
    roundId: bigint,
    amountLamports: bigint,
    entryIndex?: number,
  ): Promise<Transaction> {
    const index = entryIndex ?? (await this.nextEntryIndex(roundId));
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: false },
        { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
        { pubkey: entryKey(roundId, index), isSigner: false, isWritable: true },
        {
          pubkey: roundVaultKey(roundId),
          isSigner: false,
          isWritable: true,
        },
        // Phase 11.6 (decision D1): the player profile rides every
        // deposit — `init_if_needed` creates it on the first-ever bet and
        // charges the one-time account-open fee into the Mega-Pot.
        { pubkey: escrowKey(player), isSigner: false, isWritable: true },
        { pubkey: megaPotKey(), isSigner: false, isWritable: true },
        { pubkey: player, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: Buffer.concat([
        disc("deposit"),
        u64Le(amountLamports),
      ]),
    });
    return tx;
  }

  /**
   * Submit the winning membership proof for `entryIndex`. Permissionless —
   * `player` need not sign; the payout always goes to the entry's player.
   */
  buildClaimTx(
    player: PublicKey,
    roundId: bigint,
    entryIndex: number,
  ): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
        {
          pubkey: roundVaultKey(roundId),
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: entryKey(roundId, entryIndex),
          isSigner: false,
          isWritable: false,
        },
        { pubkey: player, isSigner: false, isWritable: true },
        { pubkey: this.payer ?? player, isSigner: true, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: eventAuthorityKey(), isSigner: false, isWritable: false },
        { pubkey: this.programId, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: Buffer.concat([disc("claim_winnings"), u32Le(entryIndex)]),
    });
    return tx;
  }

  /** Permissionless window-close crank (or auto-cancel). */
  buildLockRoundTx(roundId: bigint, crank: PublicKey): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: false },
        { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
        {
          pubkey: roundVaultKey(roundId),
          isSigner: false,
          isWritable: false,
        },
        { pubkey: crank, isSigner: true, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: disc("lock_round"),
    });
    return tx;
  }

  /** Refund one entry of a cancelled round to `player`. Permissionless. */
  buildRefundTx(
    player: PublicKey,
    roundId: bigint,
    entryIndex: number,
    crank?: PublicKey,
  ): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
        {
          pubkey: roundVaultKey(roundId),
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: entryKey(roundId, entryIndex),
          isSigner: false,
          isWritable: true,
        },
        { pubkey: player, isSigner: false, isWritable: true },
        {
          pubkey: crank ?? player,
          isSigner: true,
          isWritable: false,
        },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: Buffer.concat([disc("refund_entry"), u32Le(entryIndex)]),
    });
    return tx;
  }

  /**
   * The cancelled-round batch twin of {@link buildRefundTx}: up to
   * {@link CLOSE_ENTRY_MAX_PER_TX} full-stake refunds in ONE signature
   * (identical packet footprint to close_entry). Each entry carries its
   * own `player` — the on-chain destination check pins it to
   * `entry.player`, which is the ESCROW PDA for auto-play entries, never
   * necessarily the signer.
   */
  buildRefundsTx(
    roundId: bigint,
    entries: ReadonlyArray<{ entryIndex: number; player: PublicKey }>,
    crank: PublicKey,
  ): Transaction {
    if (entries.length === 0) {
      throw new Error("refund_entry batch: no entries");
    }
    if (entries.length > CLOSE_ENTRY_MAX_PER_TX) {
      throw new Error(
        `refund_entry batch: ${entries.length} entries exceeds the ${CLOSE_ENTRY_MAX_PER_TX}-per-transaction packet width — split the batch`,
      );
    }
    const tx = new Transaction();
    for (const { entryIndex, player } of entries) {
      tx.add({
        keys: [
          { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
          {
            pubkey: roundVaultKey(roundId),
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: entryKey(roundId, entryIndex),
            isSigner: false,
            isWritable: true,
          },
          { pubkey: player, isSigner: false, isWritable: true },
          { pubkey: crank, isSigner: true, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ],
        programId: this.programId,
        data: Buffer.concat([disc("refund_entry"), u32Le(entryIndex)]),
      });
    }
    return tx;
  }

  /** Permissionless settlement crank (event-cpi accounts included). */
  buildFulfillSettleTx(
    roundId: bigint,
    randomnessAccount: PublicKey,
    crank: PublicKey,
    /** Economics v3: the entry holding the winning ticket (required on
     *  chain from v3 on; ignored by v2). Appended as a remaining account. */
    winningEntry?: PublicKey,
  ): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: false },
        { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
        {
          pubkey: roundVaultKey(roundId),
          isSigner: false,
          isWritable: true,
        },
        { pubkey: treasuryKey(), isSigner: false, isWritable: true },
        { pubkey: megaPotKey(), isSigner: false, isWritable: true },
        // Writable since the randomness fallback: an entropy round pins the
        // chain account, whose `value_round` settle clears.
        { pubkey: randomnessAccount, isSigner: false, isWritable: true },
        { pubkey: crank, isSigner: true, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: eventAuthorityKey(), isSigner: false, isWritable: false },
        { pubkey: this.programId, isSigner: false, isWritable: false },
        ...(winningEntry === undefined
          ? []
          : [{ pubkey: winningEntry, isSigner: false, isWritable: false }]),
      ],
      programId: this.programId,
      data: disc("fulfill_settle"),
    });
    return tx;
  }

  /**
   * Oracle-timeout cancel (permissionless): once
   * `slot > randomness_commit_slot + randomness_reveal_deadline_slots` and
   * the pinned randomness was NEVER revealed, the round cancels and every
   * entry becomes refundable. A revealed value must settle instead — the
   * program refuses the cancel (AUDIT P-1). `randomnessAccount` is the
   * round's pin (`round.randomnessAccount`).
   */
  buildCancelRoundTx(roundId: bigint, randomnessAccount: PublicKey, crank: PublicKey): Transaction {
    return new Transaction().add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: false },
        { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
        { pubkey: roundVaultKey(roundId), isSigner: false, isWritable: false },
        { pubkey: crank, isSigner: true, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        // Writable: cancelling an entropy round releases the chain.
        { pubkey: randomnessAccount, isSigner: false, isWritable: true },
      ],
      programId: this.programId,
      data: disc("cancel_round"),
    });
  }

  // ── randomness fallback: self-hosted entropy provider ──

  /** Admin: create or rotate the entropy hash chain (`commit` = sha256 of
   *  the first seed to reveal; `length` = seeds available). Refused on
   *  chain while a round is in flight on it. */
  buildSetEntropyChainTx(admin: PublicKey, commit: Buffer, length: bigint): Transaction {
    if (commit.length !== 32) throw new RangeError("commit must be 32 bytes");
    return new Transaction().add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: false },
        { pubkey: entropyChainKey(), isSigner: false, isWritable: true },
        { pubkey: admin, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: Buffer.concat([disc("set_entropy_chain"), commit, u64Le(length)]),
    });
  }

  /** Admin: switch the randomness provider NEW rounds use. Pinned rounds
   *  keep theirs. Every other `update_config` field is left `None`. */
  buildSetOracleProviderTx(admin: PublicKey, provider: OracleProviderName): Transaction {
    return new Transaction().add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: true },
        { pubkey: admin, isSigner: true, isWritable: false },
      ],
      programId: this.programId,
      data: Buffer.concat([
        disc("update_config"),
        Buffer.alloc(UPDATE_CONFIG_LEADING_OPTIONS, 0),
        Buffer.from([1, providerTag(provider)]),
      ]),
    });
  }

  /** Permissionless: pin a Locked round to the entropy chain (Locked →
   *  AwaitingRandomness); the target slot is fixed on chain. */
  buildRequestEntropyTx(roundId: bigint, authority: PublicKey): Transaction {
    return new Transaction().add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: false },
        { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
        { pubkey: entropyChainKey(), isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: true, isWritable: false },
      ],
      programId: this.programId,
      data: disc("request_entropy"),
    });
  }

  /** Reveal the next chain seed for the pending entropy round (only the
   *  seed holder can produce it). Send once the target slot has a hash. */
  buildRevealEntropyTx(roundId: bigint, seed: Buffer, authority: PublicKey): Transaction {
    if (seed.length !== 32) throw new RangeError("seed must be 32 bytes");
    return new Transaction().add({
      keys: [
        { pubkey: roundKey(roundId), isSigner: false, isWritable: false },
        { pubkey: entropyChainKey(), isSigner: false, isWritable: true },
        { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: authority, isSigner: true, isWritable: false },
      ],
      programId: this.programId,
      data: Buffer.concat([disc("reveal_entropy"), seed]),
    });
  }

  /** Admin, one-way: economics v2 → v3 (the rake falls on losers only). */
  buildMigrateEconomicsV3Tx(admin: PublicKey): Transaction {
    return new Transaction().add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: true },
        { pubkey: admin, isSigner: true, isWritable: false },
      ],
      programId: this.programId,
      data: disc("migrate_economics_v3"),
    });
  }

  /**
   * Lapsed-prize recovery (roadmap 4.7): after `settle_ts +
   * claim_deadline_secs`, an unclaimed prize reroutes to the Mega-Pot.
   * Permissionless; the caller receives nothing (the value stays in the
   * game). Idempotent on-chain — fails with `PrizeAlreadyClaimed` once
   * `round.prize_claimed` is set (by a claim OR a prior sweep).
   */
  buildSweepUnclaimedPrizeTx(roundId: bigint, crank: PublicKey): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: false },
        { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
        {
          pubkey: roundVaultKey(roundId),
          isSigner: false,
          isWritable: true,
        },
        { pubkey: megaPotKey(), isSigner: false, isWritable: true },
        { pubkey: crank, isSigner: true, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: disc("sweep_unclaimed_prize"),
    });
    return tx;
  }

  /**
   * Close one entry of a **Settled** round (Phase 11.4): pays the entry's
   * pro-rata refund (+ Mega field share on a trigger) AND its reclaimed
   * rent to `entry.player` — never to the caller — so `player` must be
   * the entry's actual owner (enforced on-chain). Permissionless by
   * design: this IS the player's manual claim path if the keeper is down.
   * The winning entry may only close once `round.prizeClaimed` is true;
   * in a `Cancelled` round use `buildRefundTx` instead.
   */
  buildCloseEntryTx(
    player: PublicKey,
    roundId: bigint,
    entryIndex: number,
    crank: PublicKey,
  ): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
        { pubkey: roundVaultKey(roundId), isSigner: false, isWritable: true },
        { pubkey: entryKey(roundId, entryIndex), isSigner: false, isWritable: true },
        { pubkey: player, isSigner: false, isWritable: true },
        { pubkey: crank, isSigner: true, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: Buffer.concat([disc("close_entry"), u32Le(entryIndex)]),
    });
    return tx;
  }

  /**
   * The keeper's refund-delivery batching unit (Phase 11.8): one
   * transaction carrying up to {@link CLOSE_ENTRY_MAX_PER_TX} closes —
   * 4 shared accounts + 2 per entry against the 1232-byte packet limit
   * (CU ~11.6k per close against the 200k budget, so size binds first;
   * docs/reports/cu_profile.md). Throws rather than silently truncating.
   * Each entry needs its own `player` (the on-chain destination check);
   * the winning entry must only be included once `prizeClaimed` holds.
   */
  buildCloseEntryBatchTx(
    roundId: bigint,
    entries: ReadonlyArray<{ entryIndex: number; player: PublicKey }>,
    crank: PublicKey,
  ): Transaction {
    if (entries.length === 0) {
      throw new Error("close_entry batch: no entries");
    }
    if (entries.length > CLOSE_ENTRY_MAX_PER_TX) {
      throw new Error(
        `close_entry batch: ${entries.length} entries exceeds the ${CLOSE_ENTRY_MAX_PER_TX}-per-transaction packet width — split the batch`,
      );
    }
    const tx = new Transaction();
    for (const { entryIndex, player } of entries) {
      tx.add({
        keys: [
          { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
          { pubkey: roundVaultKey(roundId), isSigner: false, isWritable: true },
          { pubkey: entryKey(roundId, entryIndex), isSigner: false, isWritable: true },
          { pubkey: player, isSigner: false, isWritable: true },
          { pubkey: crank, isSigner: true, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ],
        programId: this.programId,
        data: Buffer.concat([disc("close_entry"), u32Le(entryIndex)]),
      });
    }
    return tx;
  }

  /**
   * The player-side sibling of {@link buildCloseEntryBatchTx}: the rewards
   * card's closable set spans ROUNDS (one entry per rolled-over round), so
   * each item carries its own `roundId`. The packet math is unchanged —
   * every ix already pins its own round/vault keys — so the same
   * {@link CLOSE_ENTRY_MAX_PER_TX} ceiling binds; chunk beyond it (one
   * signature per chunk, never one per entry).
   */
  buildCloseEntriesTx(
    entries: ReadonlyArray<{ roundId: bigint; entryIndex: number; player: PublicKey }>,
    crank: PublicKey,
  ): Transaction {
    if (entries.length === 0) {
      throw new Error("close_entry batch: no entries");
    }
    if (entries.length > CLOSE_ENTRY_MAX_PER_TX) {
      throw new Error(
        `close_entry batch: ${entries.length} entries exceeds the ${CLOSE_ENTRY_MAX_PER_TX}-per-transaction packet width — split the batch`,
      );
    }
    const tx = new Transaction();
    for (const { roundId, entryIndex, player } of entries) {
      tx.add({
        keys: [
          { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
          { pubkey: roundVaultKey(roundId), isSigner: false, isWritable: true },
          { pubkey: entryKey(roundId, entryIndex), isSigner: false, isWritable: true },
          { pubkey: player, isSigner: false, isWritable: true },
          { pubkey: crank, isSigner: true, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ],
        programId: this.programId,
        data: Buffer.concat([disc("close_entry"), u32Le(entryIndex)]),
      });
    }
    return tx;
  }

  /**
   * Final round teardown (Phase 11.4): once every entry is closed, the
   * two pro-rata pools' rounding dust (I22-bounded) sweeps to the
   * Mega-Pot and both PDAs close, reclaiming their rents to
   * `destination` — pinned to `config.admin`. Requires
   * `entries_closed == entry_count` (a `Cancelled` round arrives at zero
   * dust: `refund_entry` pays exact amounts).
   */
  buildCloseRoundTx(
    roundId: bigint,
    destination: PublicKey,
    crank: PublicKey,
  ): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: true },
        { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
        {
          pubkey: roundVaultKey(roundId),
          isSigner: false,
          isWritable: true,
        },
        { pubkey: megaPotKey(), isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: crank, isSigner: true, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: disc("close_round"),
    });
    return tx;
  }

  /**
   * The ADR-11 one-way economics cutover (Phase 11.2). Admin-signed;
   * refuses while the Mega-Pot holds lamports (`MegaPotNotDrained`) or any
   * round is in flight (`RoundInFlight`), and exactly once — after the
   * latch `economicsVersion` is 2 forever and `update_config` still cannot
   * express any of these fields (R7).
   */
  buildMigrateEconomicsV2Tx(
    admin: PublicKey,
    args: MigrateEconomicsV2ArgsData,
  ): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: true },
        { pubkey: megaPotKey(), isSigner: false, isWritable: false },
        { pubkey: admin, isSigner: true, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: Buffer.concat([
        disc("migrate_economics_v2"),
        u16Le(args.winnerBps),
        u16Le(args.refundBps),
        u16Le(args.megaAwardBps),
        u16Le(args.megaFieldBps),
        u32Le(args.megaTriggerModulus),
        u32Le(args.megaPayoutCapBps),
        u64Le(args.accountOpenFeeLamports),
      ]),
    });
    return tx;
  }

  /**
   * The ADR-11 preflight drain: pays the whole pre-v2 Mega-Pot into the
   * treasury and zeroes `accruedLamports`, so the migration's drain guard
   * is satisfied by real bookkeeping (under v1 odds the pot can never
   * reach 0 by itself). Admin-signed; refuses once `economicsVersion` is
   * 2 (`EconomicsAlreadyMigrated`), while any round is in flight
   * (`RoundInFlight`), or when the pot is already empty
   * (`MegaPotAlreadyDrained`). No args — discriminator only.
   */
  buildDrainMegaPotPreflightTx(admin: PublicKey): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: false },
        { pubkey: megaPotKey(), isSigner: false, isWritable: true },
        { pubkey: treasuryKey(), isSigner: false, isWritable: true },
        { pubkey: admin, isSigner: true, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: disc("drain_mega_pot_v1_preflight"),
    });
    return tx;
  }

  // ── Phase 10: escrow auto-deposit builders ─────────────────────────────

  /**
   * Fund (or re-fund) `owner`'s escrow and declare its terms. The seed
   * contains the signer's key, so cross-owner reinitialisation is
   * structurally impossible on-chain; `amountLamports == 0n` means
   * "change my terms only". NOTE: the transferred amount IS the intended
   * spendable — anchor's `init_if_needed` charges the rent-exempt minimum
   * to the payer on top of it.
   */
  buildInitOrDepositEscrowTx(
    owner: PublicKey,
    amountLamports: bigint,
    perRoundLamports: bigint,
    maxRounds: number,
    autoReinvest: boolean,
  ): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: false },
        { pubkey: escrowKey(owner), isSigner: false, isWritable: true },
        // Phase 11.6: the one-time account-open fee sinks into the pot on
        // the fresh-account branch (shared with `deposit`, once per wallet).
        { pubkey: megaPotKey(), isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: Buffer.concat([
        disc("init_or_deposit_escrow"),
        u64Le(amountLamports),
        u64Le(perRoundLamports),
        u32Le(maxRounds),
        Buffer.from([autoReinvest ? 1 : 0]),
      ]),
    });
    return tx;
  }

  /**
   * Withdraw spendable escrow lamports to the owner's wallet. Not
   * pause-gated and carries no config account — the fund exit keeps
   * maximum liveness. Drains to the rent floor; there is no
   * `close_escrow` in this release.
   */
  buildWithdrawEscrowTx(owner: PublicKey, amountLamports: bigint): Transaction {
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: escrowKey(owner), isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: Buffer.concat([disc("withdraw_escrow"), u64Le(amountLamports)]),
    });
    return tx;
  }

  /**
   * Enter `escrowOwner`'s escrow into round `roundId` — permissionless:
   * any `crank` may send it; inside the config window only, unless the
   * crank IS the owner (the escape hatch). `entryIndex` defaults to the
   * round's current `entry_count` (re-read per attempt on contention).
   */
  async buildCrankAutoDepositTx(
    roundId: bigint,
    escrowOwner: PublicKey,
    crank: PublicKey,
    entryIndex?: number,
  ): Promise<Transaction> {
    const index = entryIndex ?? (await this.nextEntryIndex(roundId));
    const tx = new Transaction();
    tx.add({
      keys: [
        { pubkey: configKey(), isSigner: false, isWritable: false },
        { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
        { pubkey: entryKey(roundId, index), isSigner: false, isWritable: true },
        { pubkey: roundVaultKey(roundId), isSigner: false, isWritable: true },
        { pubkey: escrowKey(escrowOwner), isSigner: false, isWritable: true },
        { pubkey: crank, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: Buffer.concat([disc("crank_auto_deposit"), u64Le(roundId)]),
    });
    return tx;
  }

  /**
   * The keeper's batching unit: up to
   * `CRANK_AUTO_DEPOSIT_MAX_PER_TX` escrows in one transaction, entry
   * PDAs at `firstEntryIndex + i` sequentially. `firstEntryIndex`
   * defaults to a FRESH `nextEntryIndex` read — each send attempt
   * re-derives the indices (entry-index contention with human deposits
   * is the main failure mode; see `useDeposit`'s retry contract).
   */
  async buildCrankAutoDepositBatchTx(
    roundId: bigint,
    escrowOwners: PublicKey[],
    crank: PublicKey,
    firstEntryIndex?: number,
  ): Promise<Transaction> {
    const first = firstEntryIndex ?? (await this.nextEntryIndex(roundId));
    const tx = new Transaction();
    escrowOwners.forEach((owner, i) => {
      tx.add({
        keys: [
          { pubkey: configKey(), isSigner: false, isWritable: false },
          { pubkey: roundKey(roundId), isSigner: false, isWritable: true },
          { pubkey: entryKey(roundId, first + i), isSigner: false, isWritable: true },
          { pubkey: roundVaultKey(roundId), isSigner: false, isWritable: true },
          { pubkey: escrowKey(owner), isSigner: false, isWritable: true },
          { pubkey: crank, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ],
        programId: this.programId,
        data: Buffer.concat([disc("crank_auto_deposit"), u64Le(roundId)]),
      });
    });
    return tx;
  }

  // ── event subscriptions (dual transport; no anchor Program) ───────────

  /** Subscribe to any event by name, envelope-carrying form. */
  subscribe(
    name: OrbitEventName,
    callback: (envelope: OrbitEventEnvelope) => void,
  ): Promise<number> {
    return this.feed.on(name, callback);
  }

  /** A new round began accepting deposits. */
  subscribeRoundOpened(
    callback: (event: RoundOpenedEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("RoundOpened", callback);
  }

  /** A deposit minted one entry; `extended` drives the anti-snipe cue. */
  subscribeDeposited(
    callback: (event: DepositedEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("Deposited", callback);
  }

  /** The deposit window closed. */
  subscribeRoundLocked(
    callback: (event: RoundLockedEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("RoundLocked", callback);
  }

  /** Subscribe to settlements — the outcome the wheel animates to. */
  subscribeRoundSettled(
    callback: (event: RoundSettledEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("RoundSettled", callback);
  }

  /** The winning entry proved membership and was paid. */
  subscribePrizeClaimed(
    callback: (event: PrizeClaimedEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("PrizeClaimed", callback);
  }

  /** A round entered the terminal refund state. */
  subscribeRoundCancelled(
    callback: (event: RoundCancelledEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("RoundCancelled", callback);
  }

  /** Subscribe to the 1-in-N Mega-Pot pop (N = config megaTriggerModulus). */
  subscribeMegaPotTriggered(
    callback: (event: MegaPotTriggeredEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("MegaPotTriggered", callback);
  }

  /** An escrow was funded (or re-funded) — the keeper registry's feed. */
  subscribeEscrowFunded(
    callback: (event: EscrowFundedEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("EscrowFunded", callback);
  }

  /** The owner withdrew spendable escrow lamports. */
  subscribeEscrowWithdrawn(
    callback: (event: EscrowWithdrawnEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("EscrowWithdrawn", callback);
  }

  /** A permissionless crank entered an escrow into a round (Phase 10). */
  subscribeAutoDeposited(
    callback: (event: AutoDepositedEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("AutoDeposited", callback);
  }

  /** An escrow's budget ran dry; demote without polling it. */
  subscribeEscrowDepleted(
    callback: (event: EscrowDepletedEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("EscrowDepleted", callback);
  }

  /** One entry drew its refund (+ field share) at close_entry (Phase 11). */
  subscribeEntryRefundPaid(
    callback: (event: EntryRefundPaidEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("EntryRefundPaid", callback);
  }

  /** The pro-rata pools' rounding dust swept at close_round (Phase 11). */
  subscribeRoundDustSwept(
    callback: (event: RoundDustSweptEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("RoundDustSwept", callback);
  }

  /** A player profile was born and the fee seeded the pot (Phase 11.6). */
  subscribeAccountOpened(
    callback: (event: AccountOpenedEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("AccountOpened", callback);
  }

  /** The one-way economics cutover (ADR-11) — fires exactly once, ever. */
  subscribeEconomicsMigrated(
    callback: (event: EconomicsMigratedEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("EconomicsMigrated", callback);
  }

  /** The pre-v2 pot drain that unlocked the cutover (ADR-11 preflight). */
  subscribeMegaPotDrainedPreflight(
    callback: (event: MegaPotDrainedPreflightEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("MegaPotDrainedPreflight", callback);
  }

  /**
   * An empty round's window rolled forward in place (Phase 12) — the UI's
   * cue to refresh its countdown without any account churn.
   */
  subscribeRoundWindowRolled(
    callback: (event: RoundWindowRolledEvent) => void,
  ): Promise<number> {
    return this.subscribeMapped("RoundWindowRolled", callback);
  }

  async unsubscribe(id: number): Promise<void> {
    await this.feed.off(id);
  }

  private subscribeMapped<T>(
    name: OrbitEventName,
    callback: (event: T) => void,
  ): Promise<number> {
    return this.feed.on(name, ({ event }) => callback(event.data as T));
  }
}
