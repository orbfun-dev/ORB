/**
 * Builder-encoding gates for the Phase 7.5 instructions: discriminator,
 * account order (mirroring the Rust contexts exactly), and borsh argument
 * bytes for `initialize`; account lists for `open_round` (first-round
 * omission and previous-round inclusion) and `request_randomness`.
 */

import { expect } from "chai";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  configKey,
  entryKey,
  escrowKey,
  eventAuthorityKey,
  megaPotKey,
  PROGRAM_ID,
  roundKey,
  roundVaultKey,
  treasuryKey,
} from "../src/pda";
import {
  CLOSE_ENTRY_MAX_PER_TX,
  OrbitJackpotClient,
  rentReclaimDestination,
} from "../src/client";
import type { GlobalConfigData, RoundData } from "../src/accounts";

// PROGRAM_ID imported via pda above.

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const payer = Keypair.generate().publicKey;
/** System program id, spelled out for expected-account lists. */
const PROGRAM_ID_SYS = new PublicKey("11111111111111111111111111111111");

function ixOf(tx: ReturnType<OrbitJackpotClient["buildInitializeTx"]>) {
  return tx.instructions[0]!;
}

describe("initialize builder", () => {
  const treasuryAuthority = Keypair.generate().publicKey;
  const oracleProgramId = Keypair.generate().publicKey;
  const oracleQueue = Keypair.generate().publicKey;
  const client = new OrbitJackpotClient(conn);
  const tx = client.buildInitializeTx(payer, {
    treasuryAuthority,
    oracleProgramId,
    oracleQueue,
    oracleProvider: "switchboard",
    maxEntriesPerRound: 500,
    roundDurationSecs: 45n,
    maxRoundDurationSecs: 345n,
    antiSnipeWindowSecs: 30n,
    antiSnipeExtensionSecs: 15n,
    claimDeadlineSecs: 2_592_000n,
    minDepositLamports: 10_000_000n,
    antiSnipeMinDepositLamports: 100_000_000n,
    keeperTipLamports: 0n,
    randomnessRevealDeadlineSlots: 400n,
    autoDepositWindowSecs: 20n,
    autoDepositTipLamports: 200_000n,
    autoDepositEnabled: true,
  });
  const ix = ixOf(tx);

  it("targets the program with the initialize sighash", () => {
    expect(ix.programId.equals(PROGRAM_ID)).to.equal(true);
    expect(ix.data.subarray(0, 8).toString("hex")).to.equal("afaf6d1f0d989bed");
  });

  it("lists accounts in the Rust context order", () => {
    expect(ix.keys.map((k) => k.pubkey.toString())).to.deep.equal(
      [
        configKey(),
        treasuryKey(),
        megaPotKey(),
        payer,
        new PublicKey("11111111111111111111111111111111"),
      ].map((k) => k.toString()),
    );
    expect(ix.keys[3]!.isSigner).to.equal(true);
    expect(ix.keys[3]!.isWritable).to.equal(true);
  });

  it("borsh-encodes InitializeArgs in declaration order (198 bytes)", () => {
    const args = ix.data.subarray(8);
    expect(args.length).to.equal(32 + 32 + 32 + 1 + 4 + 8 * 5 + 8 * 4 + 8 + 8 + 1 + 8);
    expect(new PublicKey(args.subarray(0, 32)).toString()).to.equal(treasuryAuthority.toString());
    expect(new PublicKey(args.subarray(32, 64)).toString()).to.equal(oracleProgramId.toString());
    expect(new PublicKey(args.subarray(64, 96)).toString()).to.equal(oracleQueue.toString());
    expect(args[96]).to.equal(0); // OracleProvider::Switchboard
    expect(args.readUInt32LE(97)).to.equal(500);
    expect(args.readBigInt64LE(101)).to.equal(45n);
    expect(args.readBigInt64LE(109)).to.equal(345n);
    expect(args.readBigInt64LE(117)).to.equal(30n);
    expect(args.readBigInt64LE(125)).to.equal(15n);
    expect(args.readBigInt64LE(133)).to.equal(2_592_000n);
    expect(args.readBigUInt64LE(141)).to.equal(10_000_000n);
    expect(args.readBigUInt64LE(149)).to.equal(100_000_000n);
    expect(args.readBigUInt64LE(157)).to.equal(0n);
    expect(args.readBigUInt64LE(165)).to.equal(400n);
    // Phase 10 fields appended in declaration order — every earlier offset
    // is unchanged (the zero-migration property, mirrored on the wire).
    expect(args.readBigInt64LE(173)).to.equal(20n);
    expect(args.readBigUInt64LE(181)).to.equal(200_000n);
    expect(args[189]).to.equal(1);
    // Phase 11.6: the optional account-open fee defaults to 0n — the
    // args tail grows by 8 bytes, every earlier offset unchanged.
    expect(args.readBigUInt64LE(190)).to.equal(0n);
  });
});

describe("open_round builder", () => {
  const client = new OrbitJackpotClient(conn);

  it("first round: seven accounts with the program-id None sentinel tail", () => {
    const ix = client.buildOpenRoundTx(payer, 0n).instructions[0]!;
    expect(ix.keys.map((k) => k.pubkey.toString())).to.deep.equal(
      [configKey(), roundKey(0n), roundVaultKey(0n), payer,
        new PublicKey("11111111111111111111111111111111"), SYSVAR_RENT_PUBKEY, PROGRAM_ID]
        .map((k) => k.toString()),
    );
    expect(ix.data.length).to.equal(8);
    expect(ix.data.subarray(0, 8).toString("hex")).to.equal("42eb7bf00823b99f");
  });

  it("later rounds: seven accounts with the active round as tail", () => {
    const previous = roundKey(0n);
    const ix = client.buildOpenRoundTx(payer, 1n, previous).instructions[0]!;
    expect(ix.keys).to.have.lengthOf(7);
    expect(ix.keys[1]!.pubkey.toString()).to.equal(roundKey(1n).toString());
    expect(ix.keys[6]!.pubkey.toString()).to.equal(previous.toString());
    expect(ix.keys[6]!.isWritable).to.equal(false);
  });
});

describe("request_randomness builder", () => {
  it("lists accounts in the Rust context order", () => {
    const client = new OrbitJackpotClient(conn);
    const randomnessAccount = Keypair.generate().publicKey;
    const ix = client.buildRequestRandomnessTx(0n, randomnessAccount, payer).instructions[0]!;
    expect(ix.keys.map((k) => k.pubkey.toString())).to.deep.equal(
      [configKey(), roundKey(0n), roundVaultKey(0n), randomnessAccount, payer, SYSVAR_RENT_PUBKEY]
        .map((k) => k.toString()),
    );
    expect(ix.keys[4]!.isSigner).to.equal(true);
    expect(ix.data.length).to.equal(8);
    expect(ix.data.subarray(0, 8).toString("hex")).to.equal("d505ada625ec1f12");
  });
});

describe("commit_randomness builder", () => {
  it("lists accounts in the Rust context order with the oracle WRITABLE", () => {
    const client = new OrbitJackpotClient(conn);
    const randomnessAccount = Keypair.generate().publicKey;
    const queue = Keypair.generate().publicKey;
    const oracle = Keypair.generate().publicKey;
    const oracleProgram = Keypair.generate().publicKey;
    const ix =
      client.buildCommitRandomnessTx(0n, randomnessAccount, queue, oracle, oracleProgram, payer)
        .instructions[0]!;
    expect(ix.keys.map((k) => k.pubkey.toString())).to.deep.equal(
      [
        configKey(),
        roundKey(0n),
        randomnessAccount,
        queue,
        oracle,
        new PublicKey("SysvarS1otHashes111111111111111111111111111"),
        oracleProgram,
        payer,
      ].map((k) => k.toString()),
    );
    // The commit CPI writes the randomness account AND bumps the oracle's
    // own stats — pinned by `cpi_metas_match_the_context_mut_set` in Rust.
    expect(ix.keys[2]!.isWritable).to.equal(true);
    expect(ix.keys[3]!.isWritable).to.equal(false);
    expect(ix.keys[4]!.isWritable).to.equal(true);
    expect(ix.keys[7]!.isSigner).to.equal(true);
    expect(ix.data.length).to.equal(8);
    expect(ix.data.subarray(0, 8).toString("hex")).to.equal("9234c3dc4f1e351a");
  });
});

describe("create_randomness builder", () => {
  it("targets the program with u64 recentSlot args and program-signer randomness", () => {
    const client = new OrbitJackpotClient(conn);
    const randomness = Keypair.generate().publicKey;
    const queue = Keypair.generate().publicKey;
    const escrow = Keypair.generate().publicKey;
    const programState = Keypair.generate().publicKey;
    const lutSigner = Keypair.generate().publicKey;
    const lut = Keypair.generate().publicKey;
    const oracleProgram = Keypair.generate().publicKey;
    const ix =
      client.buildCreateRandomnessTx(
        0n, randomness, 123_456n, queue, escrow, programState, lutSigner, lut, oracleProgram, payer,
      ).instructions[0]!;
    expect(ix.keys).to.have.lengthOf(15);
    expect(ix.keys[2]!.pubkey.toString()).to.equal(randomness.toString());
    expect(ix.keys[2]!.isSigner).to.equal(true);
    expect(ix.keys[2]!.isWritable).to.equal(true);
    expect(ix.keys[3]!.isWritable).to.equal(true, "queue writable — probed live");
    expect(ix.keys[4]!.isSigner).to.equal(true, "payer signs");
    expect(ix.keys[14]!.pubkey.toString()).to.equal(oracleProgram.toString());
    expect(ix.data.subarray(0, 8).toString("hex")).to.equal("26a26be5984fd017");
    expect(ix.data.readBigUInt64LE(8)).to.equal(123_456n);
  });
});

describe("reveal_randomness builder", () => {
  it("borsh-encodes the gateway payload and lists 14 accounts", () => {
    const client = new OrbitJackpotClient(conn);
    const randomness = Keypair.generate().publicKey;
    const oracle = Keypair.generate().publicKey;
    const queue = Keypair.generate().publicKey;
    const stats = Keypair.generate().publicKey;
    const escrow = Keypair.generate().publicKey;
    const programState = Keypair.generate().publicKey;
    const oracleProgram = Keypair.generate().publicKey;
    const signature = Buffer.alloc(64, 0xab);
    const value = Buffer.alloc(32, 0xcd);
    const ix =
      client.buildRevealRandomnessTx(
        0n, randomness, oracle, queue, stats, escrow, programState, oracleProgram, payer,
        signature, 1, value,
      ).instructions[0]!;
    expect(ix.keys).to.have.lengthOf(14);
    expect(ix.keys[2]!.isWritable).to.equal(true, "randomness written by the CPI");
    expect(ix.keys[5]!.isWritable).to.equal(true, "stats written");
    expect(ix.keys[6]!.isSigner).to.equal(true, "crank pays");
    expect(ix.data.subarray(0, 8).toString("hex")).to.equal("1e8255dcd0501ca9");
    expect(ix.data.length).to.equal(8 + 64 + 1 + 32);
    expect(ix.data[8 + 64]!).to.equal(1);
    expect(ix.data.subarray(8 + 65).equals(value)).to.equal(true);
    // Malformed payloads are rejected at build time.
    expect(() =>
      client.buildRevealRandomnessTx(
        0n, randomness, oracle, queue, stats, escrow, programState, oracleProgram, payer,
        Buffer.alloc(10), 0, value,
      ),
    ).to.throw(/64 bytes/);
  });
});

// The event authority key exists on the client's claim builder; keep the
// import honest for future claim-builder tests.
void eventAuthorityKey;
void entryKey;

describe("sweep_unclaimed_prize builder", () => {
  it("lists accounts in the Rust context order (vaults + mega-pot writable)", () => {
    const client = new OrbitJackpotClient(conn);
    const ix = client.buildSweepUnclaimedPrizeTx(0n, payer).instructions[0]!;
    expect(ix.keys.map((k) => k.pubkey.toString())).to.deep.equal(
      [configKey(), roundKey(0n), roundVaultKey(0n), megaPotKey(), payer, SYSVAR_RENT_PUBKEY]
        .map((k) => k.toString()),
    );
    expect(ix.keys[1]!.isWritable).to.equal(true, "round marked prize_claimed");
    expect(ix.keys[2]!.isWritable).to.equal(true, "vault drained to rent floor");
    expect(ix.keys[3]!.isWritable).to.equal(true, "mega-pot books the contribution");
    expect(ix.keys[4]!.isSigner).to.equal(true, "permissionless crank signs");
    expect(ix.keys[4]!.isWritable).to.equal(false, "the caller receives nothing");
    expect(ix.data.length).to.equal(8);
    expect(ix.data.subarray(0, 8).toString("hex")).to.equal("72cea44accc08538");
  });
});

describe("close_entry builder", () => {
  it("lists accounts in the Rust context order with u32 entry_index args", () => {
    const client = new OrbitJackpotClient(conn);
    const player = Keypair.generate().publicKey;
    const ix = client.buildCloseEntryTx(player, 7n, 42, payer).instructions[0]!;
    expect(ix.keys.map((k) => k.pubkey.toString())).to.deep.equal(
      [roundKey(7n), roundVaultKey(7n), entryKey(7n, 42), player, payer, SYSVAR_RENT_PUBKEY].map(
        (k) => k.toString(),
      ),
    );
    // The refund + rent go to the entry's player, never to the crank caller.
    expect(ix.keys[1]!.isWritable).to.equal(true, "the vault pays the refund");
    expect(ix.keys[3]!.isWritable).to.equal(true, "payout destination");
    expect(ix.keys[3]!.isSigner).to.equal(false);
    expect(ix.keys[4]!.isSigner).to.equal(true, "permissionless crank signs");
    expect(ix.keys[4]!.isWritable).to.equal(false, "the caller receives nothing");
    expect(ix.data.subarray(0, 8).toString("hex")).to.equal("841aca91be257243");
    expect(ix.data.length).to.equal(8 + 4);
    expect(ix.data.readUInt32LE(8)).to.equal(42);
  });

  it("batch: one tx, N close instructions at the width limit, throws beyond it", () => {
    const client = new OrbitJackpotClient(conn);
    const entries = Array.from({ length: CLOSE_ENTRY_MAX_PER_TX }, (_, i) => ({
      entryIndex: i,
      player: Keypair.generate().publicKey,
    }));
    const tx = client.buildCloseEntryBatchTx(5n, entries, payer);
    expect(tx.instructions).to.have.lengthOf(CLOSE_ENTRY_MAX_PER_TX);
    tx.instructions.forEach((ix, i) => {
      expect(ix.keys.map((k) => k.pubkey.toString())).to.deep.equal(
        [
          roundKey(5n),
          roundVaultKey(5n),
          entryKey(5n, i),
          entries[i]!.player,
          payer,
          SYSVAR_RENT_PUBKEY,
        ].map((k) => k.toString()),
        `instruction ${i}`,
      );
      expect(ix.data.readUInt32LE(8), `instruction ${i}`).to.equal(i);
    });
    // Never silently truncate.
    expect(() =>
      client.buildCloseEntryBatchTx(5n, [...entries, { entryIndex: 99, player: entries[0]!.player }], payer),
    ).to.throw(/packet width/);
    expect(() => client.buildCloseEntryBatchTx(5n, [], payer)).to.throw(/no entries/);
  });
});

describe("cross-round close_entry batch builder (the player's one-signature claim)", () => {
  it("packs entries from DIFFERENT rounds with per-instruction round keys", () => {
    const client = new OrbitJackpotClient(conn);
    const players = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const entries = [
      { roundId: 11n, entryIndex: 3, player: players[0]! },
      { roundId: 11n, entryIndex: 7, player: players[1]! },
      { roundId: 12n, entryIndex: 0, player: players[0]! },
    ];
    const tx = client.buildCloseEntriesTx(entries, payer);
    expect(tx.instructions).to.have.lengthOf(3);
    const want = [
      [roundKey(11n), roundVaultKey(11n), entryKey(11n, 3), players[0]!, payer, SYSVAR_RENT_PUBKEY],
      [roundKey(11n), roundVaultKey(11n), entryKey(11n, 7), players[1]!, payer, SYSVAR_RENT_PUBKEY],
      [roundKey(12n), roundVaultKey(12n), entryKey(12n, 0), players[0]!, payer, SYSVAR_RENT_PUBKEY],
    ];
    tx.instructions.forEach((ix, i) => {
      expect(ix.keys.map((k) => k.pubkey.toString()), `instruction ${i}`).to.deep.equal(
        want[i]!.map((k) => k.toString()),
      );
      expect(ix.data.subarray(0, 8).toString("hex"), `instruction ${i}`).to.equal(
        "841aca91be257243",
      );
      expect(ix.data.readUInt32LE(8), `instruction ${i}`).to.equal(entries[i]!.entryIndex);
    });
  });

  it("refuses to silently truncate or batch nothing", () => {
    const client = new OrbitJackpotClient(conn);
    const many = Array.from({ length: CLOSE_ENTRY_MAX_PER_TX + 1 }, (_, i) => ({
      roundId: 5n,
      entryIndex: i,
      player: payer,
    }));
    expect(() => client.buildCloseEntriesTx(many, payer)).to.throw(/packet width/);
    expect(() => client.buildCloseEntriesTx([], payer)).to.throw(/no entries/);
  });
});

describe("refund_entry batch builder (cancelled rounds, one signature)", () => {
  it("keeps the refund context order per entry — player may be the escrow PDA", () => {
    const client = new OrbitJackpotClient(conn);
    const escrow = Keypair.generate().publicKey;
    const entries = [
      { entryIndex: 0, player: payer },
      { entryIndex: 1, player: escrow },
    ];
    const tx = client.buildRefundsTx(9n, entries, payer);
    expect(tx.instructions).to.have.lengthOf(2);
    tx.instructions.forEach((ix, i) => {
      expect(ix.keys.map((k) => k.pubkey.toString()), `instruction ${i}`).to.deep.equal(
        [
          roundKey(9n),
          roundVaultKey(9n),
          entryKey(9n, entries[i]!.entryIndex),
          entries[i]!.player,
          payer,
          SYSVAR_RENT_PUBKEY,
        ].map((k) => k.toString()),
      );
      expect(ix.data.subarray(0, 8).toString("hex"), `instruction ${i}`).to.equal(
        "d6058817fd07e651",
      );
      expect(ix.data.readUInt32LE(8), `instruction ${i}`).to.equal(entries[i]!.entryIndex);
    });
  });

  it("refuses to silently truncate or batch nothing", () => {
    const client = new OrbitJackpotClient(conn);
    const many = Array.from({ length: CLOSE_ENTRY_MAX_PER_TX + 1 }, (_, i) => ({
      entryIndex: i,
      player: payer,
    }));
    expect(() => client.buildRefundsTx(9n, many, payer)).to.throw(/packet width/);
    expect(() => client.buildRefundsTx(9n, [], payer)).to.throw(/no entries/);
  });
});

describe("migrate_economics_v2 builder", () => {
  it("lists accounts in the Rust context order with the 22-byte args tuple", () => {
    const client = new OrbitJackpotClient(conn);
    const admin = Keypair.generate().publicKey;
    const ix = client
      .buildMigrateEconomicsV2Tx(admin, {
        winnerBps: 900,
        refundBps: 8_900,
        megaAwardBps: 5_000,
        megaFieldBps: 4_000,
        megaTriggerModulus: 625,
        megaPayoutCapBps: 125_000, // the I21 boundary, accepted exactly
        accountOpenFeeLamports: 10_000_000n,
      })
      .instructions[0]!;
    expect(ix.keys.map((k) => k.pubkey.toString())).to.deep.equal(
      [configKey(), megaPotKey(), admin, SYSVAR_RENT_PUBKEY].map((k) => k.toString()),
    );
    expect(ix.keys[0]!.isWritable).to.equal(true, "the latch writes config");
    expect(ix.keys[1]!.isWritable).to.equal(false, "the pot is read-only: guard only");
    expect(ix.keys[2]!.isSigner).to.equal(true, "admin-only, one-way");
    expect(ix.data.subarray(0, 8).toString("hex")).to.equal("b4c9b6ad6edfef53");
    expect(ix.data.length).to.equal(8 + 2 + 2 + 2 + 2 + 4 + 4 + 8);
    expect(ix.data.readUInt16LE(8)).to.equal(900);
    expect(ix.data.readUInt16LE(10)).to.equal(8_900);
    expect(ix.data.readUInt16LE(12)).to.equal(5_000);
    expect(ix.data.readUInt16LE(14)).to.equal(4_000);
    expect(ix.data.readUInt32LE(16)).to.equal(625);
    expect(ix.data.readUInt32LE(20)).to.equal(125_000);
    expect(ix.data.readBigUInt64LE(24)).to.equal(10_000_000n);
  });
});

describe("drain_mega_pot_v1_preflight builder", () => {
  it("lists accounts in the Rust context order; discriminator-only data", () => {
    const client = new OrbitJackpotClient(conn);
    const admin = Keypair.generate().publicKey;
    const ix = client.buildDrainMegaPotPreflightTx(admin).instructions[0]!;
    expect(ix.keys.map((k) => k.pubkey.toString())).to.deep.equal(
      [configKey(), megaPotKey(), treasuryKey(), admin, SYSVAR_RENT_PUBKEY].map((k) =>
        k.toString(),
      ),
    );
    expect(ix.keys[0]!.isWritable).to.equal(false, "the drain never writes config");
    expect(ix.keys[1]!.isWritable).to.equal(true, "the pot pays out");
    expect(ix.keys[2]!.isWritable).to.equal(true, "the treasury receives");
    expect(ix.keys[3]!.isSigner).to.equal(true, "admin-only preflight");
    expect(ix.data.toString("hex")).to.equal("675c522e65fb2472", "8 bytes, no args");
  });
});

describe("close_round builder", () => {
  it("lists accounts in the Rust context order (rent to config.admin)", () => {
    const client = new OrbitJackpotClient(conn);
    const admin = Keypair.generate().publicKey;
    const ix = client.buildCloseRoundTx(7n, admin, payer).instructions[0]!;
    expect(ix.keys.map((k) => k.pubkey.toString())).to.deep.equal(
      [configKey(), roundKey(7n), roundVaultKey(7n), megaPotKey(), admin, payer, SYSVAR_RENT_PUBKEY].map(
        (k) => k.toString(),
      ),
    );
    // Closing an older round leaves the active pointer untouched; closing
    // the newest retires it — hence config is WRITABLE here.
    expect(ix.keys[0]!.isWritable).to.equal(true, "active_round_id may retire");
    expect(ix.keys[1]!.isWritable).to.equal(true, "close");
    expect(ix.keys[2]!.isWritable).to.equal(true, "close");
    expect(ix.keys[3]!.isWritable).to.equal(true, "the I22 dust sweep lands here");
    expect(ix.keys[4]!.isWritable).to.equal(true, "rent destination");
    expect(ix.keys[5]!.isSigner).to.equal(true, "permissionless crank signs");
    expect(ix.keys[5]!.isWritable).to.equal(false, "the caller receives nothing");
    expect(ix.data.length).to.equal(8);
    expect(ix.data.subarray(0, 8).toString("hex")).to.equal("950e5158e6e2ea25");
  });
});

describe("close_randomness builder", () => {
  it("lists accounts in the Rust context order; round writable, crank signs only", () => {
    const client = new OrbitJackpotClient(conn);
    const [randomness, escrow, state, lutSigner, lut, sb] = Array.from({ length: 6 }, () =>
      Keypair.generate().publicKey,
    );
    const ix = client.buildCloseRandomnessTx(9n, randomness, escrow, state, lutSigner, lut, sb, payer)
      .instructions[0]!;
    expect(ix.keys.map((k) => k.pubkey.toString())).to.deep.equal(
      [
        configKey(),
        roundKey(9n),
        randomness,
        escrow,
        state,
        SystemProgram.programId,
        new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        new PublicKey("So11111111111111111111111111111111111111112"),
        lut,
        lutSigner,
        new PublicKey("AddressLookupTab1e1111111111111111111111111"),
        sb,
        payer,
      ].map((k) => k.toString()),
    );
    expect(ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toString())).to.deep.equal(
      [roundKey(9n), randomness, escrow, lut].map((k) => k.toString()),
      "the round receives the rent; Switchboard closes randomness + escrow and deactivates the LUT",
    );
    expect(ix.keys[12]!.isSigner).to.equal(true);
    expect(ix.data.toString("hex")).to.equal("f8105307bf85afac");
  });
});

// ── Phase 10: escrow auto-deposit builders ─────────────────────────────────

describe("init_or_deposit_escrow builder", () => {
  const client = new OrbitJackpotClient(conn);
  const owner = Keypair.generate().publicKey;

  it("lists accounts in the Rust context order and borsh-encodes the terms", async () => {
    const tx = client.buildInitOrDepositEscrowTx(owner, 1_014_039_600n, 100_000_000n, 10, true);
    const ix = tx.instructions[0]!;
    expect(ix.keys.map((k) => k.pubkey.toString())).to.deep.equal(
      [configKey(), escrowKey(owner), megaPotKey(), owner, PROGRAM_ID_SYS, SYSVAR_RENT_PUBKEY].map(
        (k) => k.toString(),
      ),
    );
    expect(ix.keys[0]!.isWritable).to.equal(false, "config is read-only");
    expect(ix.keys[1]!.isWritable).to.equal(true, "escrow mut");
    expect(ix.keys[2]!.isWritable).to.equal(true, "the one-time fee sinks into the pot");
    expect(ix.keys[3]!.isSigner).to.equal(true, "owner signs");
    expect(ix.keys[3]!.isWritable).to.equal(true, "owner mut (transfer from)");
    expect(ix.data.subarray(0, 8).toString("hex")).to.equal("aaab2d6f0d3310d5");
    // u64 amount ++ u64 per_round ++ u32 max_rounds ++ bool — 21 bytes.
    expect(ix.data.length).to.equal(8 + 21);
    expect(ix.data.readBigUInt64LE(8)).to.equal(1_014_039_600n);
    expect(ix.data.readBigUInt64LE(16)).to.equal(100_000_000n);
    expect(ix.data.readUInt32LE(24)).to.equal(10);
    expect(ix.data[28]).to.equal(1);
  });
});

describe("withdraw_escrow builder", () => {
  const client = new OrbitJackpotClient(conn);
  const owner = Keypair.generate().publicKey;

  it("carries NO config account (fund-exit liveness) and u64 amount args", () => {
    const ix = client.buildWithdrawEscrowTx(owner, 500_000_000n).instructions[0]!;
    expect(ix.keys.map((k) => k.pubkey.toString())).to.deep.equal(
      [escrowKey(owner), owner, SYSVAR_RENT_PUBKEY].map((k) => k.toString()),
    );
    expect(ix.keys[0]!.isWritable).to.equal(true);
    expect(ix.keys[1]!.isSigner).to.equal(true);
    expect(ix.keys[1]!.isWritable).to.equal(true, "payout destination");
    expect(ix.data.subarray(0, 8).toString("hex")).to.equal("5154e280f52f6068");
    expect(ix.data.length).to.equal(8 + 8);
    expect(ix.data.readBigUInt64LE(8)).to.equal(500_000_000n);
  });
});

describe("crank_auto_deposit builders", () => {
  const client = new OrbitJackpotClient(conn);
  const escrowOwner = Keypair.generate().publicKey;

  it("single: Rust context order, crank signer+writable (pays then is reimbursed)", async () => {
    const tx = await client.buildCrankAutoDepositTx(7n, escrowOwner, payer, 42);
    const ix = tx.instructions[0]!;
    expect(ix.keys.map((k) => k.pubkey.toString())).to.deep.equal(
      [
        configKey(),
        roundKey(7n),
        entryKey(7n, 42),
        roundVaultKey(7n),
        escrowKey(escrowOwner),
        payer,
        PROGRAM_ID_SYS,
        SYSVAR_RENT_PUBKEY,
      ].map((k) => k.toString()),
    );
    expect(ix.keys[0]!.isWritable).to.equal(false);
    for (const idx of [1, 2, 3, 4]) {
      expect(ix.keys[idx]!.isWritable, `key ${idx}`).to.equal(true);
    }
    expect(ix.keys[5]!.isSigner).to.equal(true, "permissionless crank");
    expect(ix.keys[5]!.isWritable).to.equal(true, "pays entry init, reimbursed inside");
    expect(ix.data.subarray(0, 8).toString("hex")).to.equal("03fadfa27cca71af");
    expect(ix.data.length).to.equal(8 + 8);
    expect(ix.data.readBigUInt64LE(8)).to.equal(7n);
  });

  it("batch: consecutive entry PDAs at firstEntryIndex + i, one tx", async () => {
    const owners = [0, 1, 2].map(() => Keypair.generate().publicKey);
    const tx = await client.buildCrankAutoDepositBatchTx(9n, owners, payer, 4);
    expect(tx.instructions).to.have.lengthOf(3);
    tx.instructions.forEach((ix, i) => {
      expect(ix.keys.map((k) => k.pubkey.toString())).to.deep.equal(
        [
          configKey(),
          roundKey(9n),
          entryKey(9n, 4 + i),
          roundVaultKey(9n),
          escrowKey(owners[i]!),
          payer,
          PROGRAM_ID_SYS,
          SYSVAR_RENT_PUBKEY,
        ].map((k) => k.toString()),
        `instruction ${i}`,
      );
      expect(ix.data.subarray(0, 8).toString("hex"), `instruction ${i}`).to.equal(
        "03fadfa27cca71af",
      );
    });
  });

  it("batch defaults firstEntryIndex to a fresh nextEntryIndex read", async () => {
    // A stubbed connection returning a round account whose entry_count
    // (pinned offset 65) reads 11 — the batch must start at entry 11.
    const roundData = Buffer.alloc(302);
    roundData.writeUInt32LE(11, 65);
    const stub = new OrbitJackpotClient({
      getAccountInfo: async () => ({ data: roundData }),
    } as unknown as Connection);
    const owners = [0, 1].map(() => Keypair.generate().publicKey);
    const tx = await stub.buildCrankAutoDepositBatchTx(3n, owners, payer);
    expect(tx.instructions[0]!.keys[2]!.pubkey.toString()).to.equal(entryKey(3n, 11).toString());
    expect(tx.instructions[1]!.keys[2]!.pubkey.toString()).to.equal(entryKey(3n, 12).toString());
  });
});

describe("rentReclaimDestination (Phase 12 R5)", () => {
  const admin = Keypair.generate().publicKey;
  const keeper = Keypair.generate().publicKey;
  const config = { admin: admin.toBase58() } as unknown as GlobalConfigData;

  it("returns the recorded rent payer for a Phase-12 round", () => {
    const round = { rentPayer: keeper.toBase58() } as unknown as RoundData;
    expect(rentReclaimDestination(round, config)).to.deep.equal(keeper);
  });

  it("falls back to the config admin on the legacy all-zero sentinel", () => {
    const round = {
      rentPayer: "11111111111111111111111111111111",
    } as unknown as RoundData;
    expect(rentReclaimDestination(round, config)).to.deep.equal(admin);
  });
});
