/**
 * Decoder gates (roadmap 7.0): every account decoder must reproduce the
 * `expected` field values recorded by the Rust layout-fixture generator
 * (`programs/orbit_jackpot/src/layout_fixture.rs`) from the same file's
 * byte-exact hex — proving each pinned offset against Rust's own borsh
 * writer, not against a hand-counted layout.
 *
 * The fixture values are deliberately adversarial: a negative i64
 * timestamp, u64s above Number.MAX_SAFE_INTEGER, and byte-pattern pubkeys
 * that make any shifted offset decode to a visibly wrong value.
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_SIZES,
  decodeGlobalConfig,
  decodeMegaPotVault,
  decodePlayerEntry,
  decodePlayerEscrow,
  decodeRound,
  ROUND_ENTRY_COUNT_OFFSET,
} from "../src/accounts";

interface Fixture {
  accounts: Record<string, { hex: string; expected: Record<string, unknown> }>;
}

const fixture: Fixture = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures", "account_layouts.json"),
    "utf8",
  ),
) as Fixture;

const big = (v: unknown): bigint => BigInt(v as string);

function expectMatches(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
  for (const [key, want] of Object.entries(expected)) {
    expect(actual, key).to.have.property(key);
    const got = actual[key];
    if (typeof want === "string" && /^-?\d+$/.test(want) && typeof got === "bigint") {
      expect(got.toString(), key).to.equal(want);
    } else if (typeof want === "number" && typeof got === "number") {
      expect(got, key).to.equal(want);
    } else if (typeof want === "boolean") {
      expect(got, key).to.equal(want);
    } else {
      expect(got, key).to.deep.equal(want);
    }
  }
}

describe("account decoders against the Rust layout fixture", () => {
  it("fixture discriminators match the committed constants", () => {
    for (const [name, { hex }] of Object.entries(fixture.accounts)) {
      const disc = Buffer.from(hex, "hex").subarray(0, 8).toString("hex");
      expect(disc, name).to.equal(ACCOUNT_DISCRIMINATORS[name]);
    }
  });

  it("fixture sizes match the size-locked account sizes", () => {
    for (const [name, { hex }] of Object.entries(fixture.accounts)) {
      expect(hex.length / 2, name).to.equal(ACCOUNT_SIZES[name]);
    }
  });

  it("decodes GlobalConfig field-for-field", () => {
    const { hex, expected } = fixture.accounts.GlobalConfig!;
    const decoded = decodeGlobalConfig(Buffer.from(hex, "hex")) as unknown as Record<string, unknown>;
    expectMatches(decoded, expected);
    expect(decoded.oracleProvider).to.equal("switchboard");
  });

  it("decodes Round field-for-field, including the negative i64", () => {
    const { hex, expected } = fixture.accounts.Round!;
    const round = decodeRound(Buffer.from(hex, "hex"));
    expectMatches(round as unknown as Record<string, unknown>, expected);
    expect(round.state).to.equal("settled");
    expect(round.startTs).to.equal(-1_700_000_001n);
    // Above MAX_SAFE_INTEGER both ways — BigInt round-trips exactly.
    expect(round.totalLamports).to.equal(123_456_789_012_345_678n);
    expect(round.winningTicket).to.equal(98_765_432_101_234_567n);
  });

  it("decodes the PRE-PHASE-12 Round shape: a zeroed rent_payer tail reads as the System program (the legacy sentinel)", () => {
    const { hex } = fixture.accounts.Round!;
    const buf = Buffer.from(hex, "hex");
    // Zero the trailing 32 bytes — exactly what every round opened before
    // the Phase 12 upgrade carries in its former reserved padding.
    buf.fill(0, buf.length - 32);
    const round = decodeRound(buf);
    expect(round.rentPayer).to.equal("11111111111111111111111111111111");
    // And the recorded shape decodes the fixture's [0xBC; 32] payer.
    expect(decodeRound(Buffer.from(hex, "hex")).rentPayer).to.equal(
      fixture.accounts.Round!.expected.rentPayer,
    );
  });

  it("decodes PlayerEntry field-for-field (round_id @8, player @20)", () => {
    const { hex, expected } = fixture.accounts.PlayerEntry!;
    const decoded = decodePlayerEntry(Buffer.from(hex, "hex")) as unknown as Record<string, unknown>;
    expectMatches(decoded, expected);
  });

  it("decodes PlayerEscrow field-for-field (Phase 10)", () => {
    const { hex, expected } = fixture.accounts.PlayerEscrow!;
    const decoded = decodePlayerEscrow(Buffer.from(hex, "hex")) as unknown as Record<string, unknown>;
    expectMatches(decoded, expected);
    // Above MAX_SAFE_INTEGER both ways — BigInt round-trips exactly.
    const escrow = decodePlayerEscrow(Buffer.from(hex, "hex"));
    expect(escrow.perRoundLamports).to.equal(123_456_789_012_345n);
    expect(escrow.lifetimeDeposited).to.equal(4_999_999_999_999_999n);
    expect(escrow.autoReinvest).to.equal(true);
  });

  it("decodes the PRE-UPGRADE GlobalConfig shape: new fields read 0n/0n/0/0n/0 (zero migration)", () => {
    const { hex, expected } = fixture.accounts.GlobalConfig!;
    const buf = Buffer.from(hex, "hex");
    // The deployed account's bytes at the new field positions were
    // reserved zeros — after the program upgrade they must decode as the
    // feature-off, pre-Phase-11-economics state with every earlier offset
    // intact. Phase 10 took 17 bytes at 276; Phase 11 the next 17 at 293
    // (refund_bps…economics_version) — both zeroed together here.
    Buffer.alloc(34).copy(buf, 276);
    const config = decodeGlobalConfig(buf);
    expect(config.autoDepositWindowSecs).to.equal(0n);
    expect(config.autoDepositTipLamports).to.equal(0n);
    expect(config.autoDepositEnabled).to.equal(false);
    expect(config.refundBps).to.equal(0);
    expect(config.megaFieldBps).to.equal(0);
    expect(config.megaPayoutCapBps).to.equal(0, "0 = uncapped (the v1 behaviour)");
    expect(config.accountOpenFeeLamports).to.equal(0n);
    expect(config.economicsVersion).to.equal(0);
    expect(config.paused).to.equal(false);
    expect(config.bump).to.equal(expected.bump);
    expect(config.nextRoundId).to.equal(big(expected.nextRoundId));
    expect(config.minDepositLamports).to.equal(big(expected.minDepositLamports));
  });

  it("keeps ACCOUNT_SIZES and ROUND_ENTRY_COUNT_OFFSET unchanged (the zero-migration proof)", () => {
    // Phase 11 grew BOTH layouts out of reserved bytes only — the TS-side
    // statement of the Rust size-lock tests (GlobalConfig 340, Round 302).
    expect(ACCOUNT_SIZES.GlobalConfig).to.equal(340);
    expect(ACCOUNT_SIZES.Round).to.equal(302);
    expect(ACCOUNT_SIZES.PlayerEntry).to.equal(109);
    expect(ACCOUNT_SIZES.PlayerEscrow).to.equal(122);
    expect(ROUND_ENTRY_COUNT_OFFSET).to.equal(65);
  });

  it("decodes MegaPotVault field-for-field", () => {
    const { hex, expected } = fixture.accounts.MegaPotVault!;
    const decoded = decodeMegaPotVault(Buffer.from(hex, "hex")) as unknown as Record<string, unknown>;
    expectMatches(decoded, expected);
  });

  it("entry_count reads from the pinned offset (the 65-vs-73 regression)", () => {
    const { hex } = fixture.accounts.Round!;
    const buf = Buffer.from(hex, "hex");
    // The fixture wrote entry_count = 3; offset 73 lands inside
    // first_depositor's [0x55; 32] pubkey and reads 0x55555555 instead.
    expect(buf.readUInt32LE(ROUND_ENTRY_COUNT_OFFSET)).to.equal(3);
    expect(decodeRound(buf).entryCount).to.equal(3);
  });

  it("rejects wrong-length buffers loudly", () => {
    const { hex } = fixture.accounts.Round!;
    const short = Buffer.from(hex, "hex").subarray(0, 300);
    expect(() => decodeRound(short)).to.throw(/expected exactly 302/);
  });

  it("rejects wrong discriminators loudly", () => {
    const { hex } = fixture.accounts.Round!;
    const buf = Buffer.from(hex, "hex");
    buf.writeUInt8(buf[0]! ^ 0xff, 0);
    expect(() => decodeRound(buf)).to.throw(/discriminator .* does not match/);
  });

  it("decodes a None pending_admin (borsh Option is variable-width)", () => {
    const { hex } = fixture.accounts.GlobalConfig!;
    const buf = Buffer.from(hex, "hex");
    // On-chain reality: `None` serializes as a lone 0 tag — the 32 key
    // bytes vanish and every later field shifts down, while the account
    // keeps its allocated 340-byte length (anchor ignores the stale tail).
    const withNone = Buffer.concat([
      buf.subarray(0, 40),           // discriminator + admin
      Buffer.from([0]),              // Option::None tag
      buf.subarray(8 + 32 + 33),     // everything from treasury_authority (byte 73) on
      Buffer.alloc(32),              // stale allocated tail
    ]);
    expect(withNone.length).to.equal(340);
    const config = decodeGlobalConfig(withNone);
    expect(config.pendingAdmin).to.equal(null);
    expect(config.treasuryAuthority).to.equal(fixture.accounts.GlobalConfig!.expected.treasuryAuthority);
    expect(config.activeRoundId).to.equal(big(fixture.accounts.GlobalConfig!.expected.activeRoundId));
  });

  it("rejects out-of-range enum tags", () => {
    const { hex } = fixture.accounts.Round!;
    const buf = Buffer.from(hex, "hex");
    buf.writeUInt8(9, 8 + 8); // state byte
    expect(() => decodeRound(buf)).to.throw(/outside 0\.\.4/);
  });
});
