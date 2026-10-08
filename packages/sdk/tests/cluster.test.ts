/** Cluster selection: devnet by default, mainnet only on an explicit opt-in. */

import { expect } from "chai";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  DEVNET_PROGRAM_ID,
  MAINNET_PROGRAM_ID,
  ORB_CLUSTER,
  PROGRAM_ID,
  resolveCluster,
} from "../src/pda";

describe("cluster selection", () => {
  it("defaults to devnet, accepts mainnet spellings, refuses typos", () => {
    expect(resolveCluster(undefined)).to.equal("devnet");
    expect(resolveCluster("")).to.equal("devnet");
    expect(resolveCluster("devnet")).to.equal("devnet");
    expect(resolveCluster("mainnet")).to.equal("mainnet");
    expect(resolveCluster("mainnet-beta")).to.equal("mainnet");
    expect(() => resolveCluster("mainet")).to.throw(/ORB_CLUSTER/);
  });

  it("the test process (no ORB_CLUSTER) targets the devnet program", () => {
    expect(ORB_CLUSTER).to.equal("devnet");
    expect(PROGRAM_ID.toBase58()).to.equal(DEVNET_PROGRAM_ID.toBase58());
  });

  it("ORB_CLUSTER=mainnet switches PROGRAM_ID (and every PDA) to the mainnet program", () => {
    const script = `const p=require(${JSON.stringify(join(__dirname, "..", "src", "pda.ts"))});console.log(p.PROGRAM_ID.toBase58(), p.configKey().toBase58())`;
    const out = execFileSync(process.execPath, ["-r", "ts-node/register/transpile-only", "-e", script], {
      env: { ...process.env, ORB_CLUSTER: "mainnet" },
      encoding: "utf8",
    }).trim();
    const [programId, config] = out.split(" ");
    expect(programId).to.equal(MAINNET_PROGRAM_ID.toBase58());
    expect(config).to.not.equal(
      require("../src/pda").configKey().toBase58(),
      "PDAs derive from the selected program",
    );
  });
});
