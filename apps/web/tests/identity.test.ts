/**
 * Dual-identity gates (Phase 10 §6.3): both the wallet AND its escrow PDA
 * are "mine" — for entries, claims, refunds, and stake totals — while
 * other players' escrows and synthetic markers stay foreign.
 */

import { expect, describe, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { escrowKey } from "@orbit-jackpot/sdk";
import { escrowAddressOf, isMyKey, myEntriesOf } from "../src/lib/identity";
import { sumPlayerLamports } from "../src/components/deposit/DepositPanel";
import { CLOSED_RANGE_PLAYER } from "../src/lib/book";

const wallet = Keypair.generate().publicKey;
const walletB58 = wallet.toString();
const escrowB58 = escrowAddressOf(walletB58);
const stranger = Keypair.generate().publicKey;
const strangerEscrow = escrowAddressOf(stranger.toString());

describe("escrowAddressOf", () => {
  it("matches the SDK's escrowKey derivation", () => {
    expect(escrowAddressOf(walletB58)).to.equal(escrowKey(wallet).toString());
  });

  it("is deterministic and distinct from the wallet", () => {
    expect(escrowAddressOf(walletB58)).to.equal(escrowB58);
    expect(escrowB58).to.not.equal(walletB58);
  });
});

describe("isMyKey — both identities are mine", () => {
  it("accepts the wallet itself", () => {
    expect(isMyKey(walletB58, walletB58)).to.equal(true);
  });

  it("accepts the wallet's escrow PDA", () => {
    expect(isMyKey(escrowB58, walletB58)).to.equal(true);
  });

  it("rejects strangers, their escrows, null wallets, and synthetic markers", () => {
    expect(isMyKey(stranger.toString(), walletB58)).to.equal(false);
    expect(isMyKey(strangerEscrow, walletB58)).to.equal(false);
    expect(isMyKey(walletB58, null)).to.equal(false);
    // The sparse-book filler and non-base58 ids must not throw.
    expect(isMyKey(CLOSED_RANGE_PLAYER, walletB58)).to.equal(false);
    expect(isMyKey(walletB58, "not-a-pubkey")).to.equal(false);
  });
});

describe("myEntriesOf — attribution across both identities", () => {
  const entries = [
    { player: walletB58, amount: 1n },
    { player: escrowB58, amount: 2n },
    { player: stranger.toString(), amount: 4n },
    { player: strangerEscrow, amount: 8n },
    { player: CLOSED_RANGE_PLAYER, amount: 16n },
  ];

  it("returns wallet + escrow entries only", () => {
    const mine = myEntriesOf(entries, walletB58);
    expect(mine.map((e) => e.amount)).to.deep.equal([1n, 2n]);
  });

  it("is empty without a wallet and unchanged for strangers", () => {
    expect(myEntriesOf(entries, null)).to.deep.equal([]);
    expect(myEntriesOf(entries, stranger.toString()).map((e) => e.amount)).to.deep.equal([4n, 8n]);
  });
});

describe("sumPlayerLamports — the stake counts both identities", () => {
  const entries = [
    { player: walletB58, amountLamports: 100n },
    { player: escrowB58, amountLamports: 50n },
    { player: stranger.toString(), amountLamports: 900n },
  ];

  it("sums wallet + escrow stakes", () => {
    expect(sumPlayerLamports(entries, walletB58)).to.equal(150n);
  });

  it("still handles the no-wallet and synthetic cases", () => {
    expect(sumPlayerLamports(entries, null)).to.equal(0n);
    expect(sumPlayerLamports(entries, "synthetic")).to.equal(0n);
  });
});
