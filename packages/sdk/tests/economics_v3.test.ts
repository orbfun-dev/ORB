/**
 * Economics v3 mirror — pinned to the Rust unit tests in
 * programs/orbit_jackpot/src/math/split.rs (same inputs, same lamports).
 */

import { expect } from "chai";
import { Connection, Keypair } from "@solana/web3.js";
import { splitRoundPot, splitRoundPotV3, winnerTakeHome } from "../src/math/economics";
import { OrbitJackpotClient } from "../src/client";

describe("economics v3 mirror", () => {
  it("the owner's case: 0.1 SOL vs 0.01 SOL wins money under v3, loses under v2", () => {
    const total = 110_000_000n;
    const stake = 100_000_000n;
    const v3 = splitRoundPotV3(total, stake, 900, 100, 100);
    expect(v3.adminCut).to.equal(100_000n);
    expect(v3.megaCut).to.equal(100_000n);
    expect(v3.refundPool).to.equal(splitRoundPot(total, 900, 100, 100).refundPool);
    expect(winnerTakeHome(3, total, stake, 900, 100, 100)).to.equal(100_900_000n);
    expect(winnerTakeHome(2, total, stake, 900, 100, 100)).to.equal(98_900_000n);
  });

  it("a balanced 1 vs 1 SOL round", () => {
    expect(winnerTakeHome(3, 2_000_000_000n, 1_000_000_000n, 900, 100, 100)).to.equal(1_090_000_000n);
  });

  it("reassembles the pot and never pays the winner below stake", () => {
    for (const [w, l] of [[1n, 1n], [7n, 3n], [999_999_937n, 13n], [10n ** 12n, 10n ** 9n + 7n]]) {
      const s = splitRoundPotV3(w! + l!, w!, 900, 100, 100);
      expect(s.winnerPayout + s.refundPool + s.adminCut + s.megaCut).to.equal(w! + l!);
      expect(winnerTakeHome(3, w! + l!, w!, 900, 100, 100) >= w!).to.equal(true);
    }
  });

  it("rejects a stake larger than the pot", () => {
    expect(() => splitRoundPotV3(10n, 11n, 900, 100, 100)).to.throw(RangeError);
  });

  it("the cancel builder carries the pinned randomness account last (AUDIT P-1)", () => {
    const client = new OrbitJackpotClient(new Connection("http://127.0.0.1:1"));
    const randomness = Keypair.generate().publicKey;
    const crank = Keypair.generate().publicKey;
    const ix = client.buildCancelRoundTx(4n, randomness, crank).instructions[0]!;
    expect(ix.data.toString("hex")).to.equal("524686362e609408");
    expect(ix.keys).to.have.lengthOf(6);
    expect(ix.keys[5]!.pubkey.toBase58()).to.equal(randomness.toBase58());
    expect(ix.keys[3]!.isSigner).to.equal(true);
  });

  it("the settle builder appends the winning entry; the migrate builder targets v3", () => {
    const client = new OrbitJackpotClient(new Connection("http://127.0.0.1:1"));
    const crank = Keypair.generate().publicKey;
    const entry = Keypair.generate().publicKey;
    const plain = client.buildFulfillSettleTx(3n, Keypair.generate().publicKey, crank).instructions[0]!;
    const v3 = client.buildFulfillSettleTx(3n, Keypair.generate().publicKey, crank, entry).instructions[0]!;
    expect(v3.keys.length).to.equal(plain.keys.length + 1);
    expect(v3.keys.at(-1)!.pubkey.toBase58()).to.equal(entry.toBase58());
    expect(v3.keys.at(-1)!.isWritable).to.equal(false);
    const mig = client.buildMigrateEconomicsV3Tx(crank).instructions[0]!;
    expect(mig.data.toString("hex")).to.equal("016c4d3451e5d242");
    expect(mig.keys[1]!.isSigner).to.equal(true);
  });
});
