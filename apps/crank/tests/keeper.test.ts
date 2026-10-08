/**
 * Keeper identity loading: base58 and solana-cli JSON file sources, byte
 * validation, mode warnings, and the instructive no-identity error.
 */

import { expect } from "chai";
import { Keypair } from "@solana/web3.js";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import { loadKeeper } from "../src/keeper";

describe("keeper loading", () => {
  it("loads a 64-byte secret from base58 and derives the same pubkey", () => {
    const kp = Keypair.generate();
    const identity = loadKeeper({ keypairBase58: bs58.encode(kp.secretKey) });
    expect(identity.keypair.publicKey.toString()).to.equal(kp.publicKey.toString());
    expect(identity.source).to.equal("base58");
  });

  it("loads a solana-cli JSON keypair file", () => {
    const kp = Keypair.generate();
    const dir = mkdtempSync(join(tmpdir(), "crank-keeper-"));
    const file = join(dir, "keeper.json");
    writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
    chmodSync(file, 0o600);
    const identity = loadKeeper({ keypairPath: file });
    expect(identity.keypair.publicKey.toString()).to.equal(kp.publicKey.toString());
    expect(identity.source).to.equal(`file:${file}`);
  });

  it("warns (not throws) on a group-readable keypair file", () => {
    const kp = Keypair.generate();
    const dir = mkdtempSync(join(tmpdir(), "crank-keeper-"));
    const file = join(dir, "loose.json");
    writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
    chmodSync(file, 0o644);
    const warnings: string[] = [];
    const logger = {
      warn: (obj: unknown, msg: string) => warnings.push(msg),
    } as never;
    const identity = loadKeeper({ keypairPath: file }, logger);
    expect(identity.keypair.publicKey.toString()).to.equal(kp.publicKey.toString());
    expect(warnings.length).to.equal(1);
    expect(warnings[0]).to.match(/chmod 600/);
  });

  it("rejects garbage base58 secrets, non-JSON files, and wrong shapes", () => {
    expect(() => loadKeeper({ keypairBase58: "3" })).to.throw(); // decodes to 1 byte
    const dir = mkdtempSync(join(tmpdir(), "crank-keeper-"));
    const notJson = join(dir, "not-json.json");
    writeFileSync(notJson, "this is not json");
    expect(() => loadKeeper({ keypairPath: notJson })).to.throw(/not valid JSON/);
    const wrongShape = join(dir, "wrong.json");
    writeFileSync(wrongShape, JSON.stringify([1, 2, 3]));
    expect(() => loadKeeper({ keypairPath: wrongShape })).to.throw(/64 bytes/);
  });

  it("fails with instructions when no identity source is configured", () => {
    expect(() => loadKeeper({})).to.throw(/CRANK_KEYPAIR_PATH|CRANK_KEYPAIR_BASE58/);
  });
});
