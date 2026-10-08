/**
 * Randomness fallback (self-hosted entropy provider): discriminators,
 * account order mirroring the Rust contexts, arg encoding, and the chain
 * decoder.
 */

import { expect } from "chai";
import { createHash } from "crypto";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
import { configKey, entropyChainKey, PROGRAM_ID, roundKey } from "../src/pda";
import { INSTRUCTION_DISCRIMINATORS, OrbitJackpotClient } from "../src/client";
import {
  ACCOUNT_DISCRIMINATORS,
  decodeEntropyChain,
  ENTROPY_NONE,
  ORACLE_PROVIDERS,
} from "../src/accounts";

const sighash = (ns: string, name: string) =>
  createHash("sha256").update(`${ns}:${name}`).digest().subarray(0, 8).toString("hex");

const client = new OrbitJackpotClient(new Connection("http://127.0.0.1:8899", "confirmed"));
const signer = Keypair.generate().publicKey;

describe("entropy provider", () => {
  it("pins the new discriminators to anchor's sighash", () => {
    for (const name of ["set_entropy_chain", "request_entropy", "reveal_entropy"]) {
      expect(INSTRUCTION_DISCRIMINATORS[name]).to.equal(sighash("global", name));
    }
    expect(ACCOUNT_DISCRIMINATORS.EntropyChain).to.equal(sighash("account", "EntropyChain"));
  });

  it("derives the chain PDA from the documented seed", () => {
    const [expected] = PublicKey.findProgramAddressSync([Buffer.from("entropy_chain")], PROGRAM_ID);
    expect(entropyChainKey().equals(expected)).to.equal(true);
  });

  it("orders provider tags as the Rust enum", () => {
    expect(ORACLE_PROVIDERS).to.deep.equal(["switchboard", "orao", "entropy"]);
  });

  it("encodes set_entropy_chain", () => {
    const commit = Buffer.alloc(32, 7);
    const ix = client.buildSetEntropyChainTx(signer, commit, 1000n).instructions[0]!;
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).to.deep.equal([
      [configKey().toBase58(), false, false],
      [entropyChainKey().toBase58(), false, true],
      [signer.toBase58(), true, true],
      [SystemProgram.programId.toBase58(), false, false],
    ]);
    expect(ix.data.length).to.equal(8 + 32 + 8);
    expect(ix.data.subarray(8, 40).equals(commit)).to.equal(true);
    expect(ix.data.readBigUInt64LE(40)).to.equal(1000n);
  });

  it("encodes the provider switch as 15 Nones then Some(tag)", () => {
    const ix = client.buildSetOracleProviderTx(signer, "entropy").instructions[0]!;
    expect(ix.data.subarray(0, 8).toString("hex")).to.equal(INSTRUCTION_DISCRIMINATORS.update_config);
    const args = ix.data.subarray(8);
    expect(args.length).to.equal(17);
    expect([...args.subarray(0, 15)].every((b) => b === 0)).to.equal(true);
    expect([...args.subarray(15)]).to.deep.equal([1, 2]);
    expect(ix.keys[0]!.isWritable).to.equal(true);
    expect(ix.keys[1]!.isSigner).to.equal(true);
  });

  it("encodes request_entropy and reveal_entropy", () => {
    const req = client.buildRequestEntropyTx(4n, signer).instructions[0]!;
    expect(req.keys.map((k) => k.pubkey.toBase58())).to.deep.equal([
      configKey().toBase58(),
      roundKey(4n).toBase58(),
      entropyChainKey().toBase58(),
      signer.toBase58(),
    ]);
    expect(req.keys[2]!.isWritable).to.equal(true);
    const seed = Buffer.alloc(32, 3);
    const rev = client.buildRevealEntropyTx(4n, seed, signer).instructions[0]!;
    expect(rev.keys.map((k) => k.pubkey.toBase58())).to.deep.equal([
      roundKey(4n).toBase58(),
      entropyChainKey().toBase58(),
      SYSVAR_SLOT_HASHES_PUBKEY.toBase58(),
      signer.toBase58(),
    ]);
    expect(rev.data.subarray(8).equals(seed)).to.equal(true);
  });

  it("marks the pinned randomness writable in settle and cancel", () => {
    const pin = entropyChainKey();
    const settle = client.buildFulfillSettleTx(1n, pin, signer).instructions[0]!;
    expect(settle.keys[5]!.pubkey.equals(pin) && settle.keys[5]!.isWritable).to.equal(true);
    const cancel = client.buildCancelRoundTx(1n, pin, signer).instructions[0]!;
    expect(cancel.keys[5]!.pubkey.equals(pin) && cancel.keys[5]!.isWritable).to.equal(true);
  });

  it("decodes an EntropyChain account", () => {
    const data = Buffer.alloc(193);
    Buffer.from(ACCOUNT_DISCRIMINATORS.EntropyChain!, "hex").copy(data, 0);
    let o = 8;
    data.fill(0xaa, o, o + 32); o += 32; // commit
    data.writeBigUInt64LE(5n, o); o += 8; // remaining
    data.writeBigUInt64LE(ENTROPY_NONE, o); o += 8; // pending
    data.writeBigUInt64LE(77n, o); o += 8; // target
    data.writeBigUInt64LE(75n, o); o += 8; // request
    data.fill(0xbb, o, o + 32); o += 32; // value
    data.writeBigUInt64LE(9n, o); o += 8; // value_round
    data.writeBigUInt64LE(78n, o); o += 8; // value_slot
    data.writeBigUInt64LE(3n, o); o += 8; // revealed
    data[o] = 254;
    const chain = decodeEntropyChain(data);
    expect(chain.commit).to.equal("aa".repeat(32));
    expect(chain.remaining).to.equal(5n);
    expect(chain.pendingRound).to.equal(ENTROPY_NONE);
    expect(chain.targetSlot).to.equal(77n);
    expect(chain.valueRound).to.equal(9n);
    expect(chain.valueSlot).to.equal(78n);
    expect(chain.bump).to.equal(254);
  });
});
