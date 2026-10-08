/**
 * Config parsing gates: defaults target devnet/public-RPC etiquette,
 * overrides parse, and malformed values fail loudly with the offending
 * variable named.
 */

import { expect } from "chai";
import { loadConfig, redactUrl } from "../src/config";

describe("config defaults", () => {
  it("targets devnet with public-RPC-safe pacing", () => {
    const cfg = loadConfig({});
    expect(cfg.rpcUrl).to.equal("https://api.devnet.solana.com");
    expect(cfg.commitment).to.equal("confirmed");
    expect(cfg.pollIntervalMs).to.equal(10_000);
    expect(cfg.wsEnabled).to.equal(true);
    expect(cfg.rpcPaceMs).to.equal(350);
    expect(cfg.maxBackoffMs).to.equal(30_000);
    expect(cfg.healthzHost).to.equal("127.0.0.1");
    expect(cfg.healthzPort).to.equal(8_080);
    expect(cfg.stateDir).to.equal("var");
    expect(cfg.logLevel).to.equal("info");
    expect(cfg.logFile).to.equal(undefined);
    expect(cfg.keypairPath).to.equal(undefined);
    expect(cfg.keypairBase58).to.equal(undefined);
    expect(cfg.priorityFeeMicrolamports).to.equal(0);
    expect(cfg.computeUnitLimit).to.equal(undefined);
    expect(cfg.minKeeperBalanceLamports).to.equal(50_000_000n);
    expect(cfg.maxTrackedRounds).to.equal(64);
    expect(cfg.cleanupEnabled).to.equal(true);
    expect(cfg.claimForWinners).to.equal(false);
    expect(cfg.closeBatchMaxPerTx).to.equal(11, "the SDK's measured packet width");
    expect(cfg.stuckCleanupAlertSecs).to.equal(3_600, "one hour, then health degrades");
    expect(cfg.dryRun).to.equal(false);
  });

  it("parses the Phase 11.8 cleanup knobs and rejects nonsense", () => {
    const cfg = loadConfig({
      CRANK_CLOSE_BATCH_MAX_PER_TX: "6",
      CRANK_STUCK_CLEANUP_ALERT_SECS: "120",
    });
    expect(cfg.closeBatchMaxPerTx).to.equal(6);
    expect(cfg.stuckCleanupAlertSecs).to.equal(120);
    expect(() => loadConfig({ CRANK_CLOSE_BATCH_MAX_PER_TX: "17" })).to.throw(
      /CRANK_CLOSE_BATCH_MAX_PER_TX/,
    );
    expect(() => loadConfig({ CRANK_CLOSE_BATCH_MAX_PER_TX: "0" })).to.throw(
      /CRANK_CLOSE_BATCH_MAX_PER_TX/,
    );
    expect(() => loadConfig({ CRANK_STUCK_CLEANUP_ALERT_SECS: "30" })).to.throw(
      /CRANK_STUCK_CLEANUP_ALERT_SECS/,
    );
  });
});

describe("config overrides", () => {
  it("parses ints, bools, SOL amounts and optional values", () => {
    const cfg = loadConfig({
      CRANK_RPC_URL: "https://my-rpc.example:8899 ",
      CRANK_COMMITMENT: "finalized",
      CRANK_POLL_INTERVAL_MS: "5000",
      CRANK_WS_ENABLED: "0",
      CRANK_KEYPAIR_PATH: "/etc/orbit-crank/keeper.json",
      CRANK_PRIORITY_FEE_MICROLAMPORTS: "1500",
      CRANK_COMPUTE_UNIT_LIMIT: "250000",
      CRANK_MIN_KEEPER_BALANCE_SOL: "2.5",
      CRANK_HEALTHZ_PORT: "9090",
      CRANK_DRY_RUN: "true",
      CRANK_CLAIM_FOR_WINNERS: "yes",
      CRANK_STATE_DIR: "/var/lib/orbit-crank",
      CRANK_LOG_LEVEL: "debug",
      CRANK_LOG_FILE: "/var/log/orbit-crank/log.json",
    });
    expect(cfg.rpcUrl).to.equal("https://my-rpc.example:8899");
    expect(cfg.commitment).to.equal("finalized");
    expect(cfg.pollIntervalMs).to.equal(5_000);
    expect(cfg.wsEnabled).to.equal(false);
    expect(cfg.keypairPath).to.equal("/etc/orbit-crank/keeper.json");
    expect(cfg.priorityFeeMicrolamports).to.equal(1_500);
    expect(cfg.computeUnitLimit).to.equal(250_000);
    expect(cfg.minKeeperBalanceLamports).to.equal(2_500_000_000n);
    expect(cfg.healthzPort).to.equal(9_090);
    expect(cfg.dryRun).to.equal(true);
    expect(cfg.claimForWinners).to.equal(true);
    expect(cfg.stateDir).to.equal("/var/lib/orbit-crank");
    expect(cfg.logFile).to.equal("/var/log/orbit-crank/log.json");
  });
});

describe("config rejections", () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["both keypair sources", { CRANK_KEYPAIR_PATH: "/a", CRANK_KEYPAIR_BASE58: "b" }],
    ["bad commitment", { CRANK_COMMITMENT: "processed" }],
    ["non-integer interval", { CRANK_POLL_INTERVAL_MS: "1.5" }],
    ["out-of-range interval", { CRANK_POLL_INTERVAL_MS: "10" }],
    ["bad bool", { CRANK_WS_ENABLED: "maybe" }],
    ["bad SOL amount", { CRANK_MIN_KEEPER_BALANCE_SOL: "lots" }],
    ["out-of-range port", { CRANK_HEALTHZ_PORT: "99999" }],
    ["negative priority fee", { CRANK_PRIORITY_FEE_MICROLAMPORTS: "-1" }],
    ["zero CU limit", { CRANK_COMPUTE_UNIT_LIMIT: "0" }],
  ];
  for (const [name, env] of cases) {
    it(`rejects ${name} and names the variable`, () => {
      expect(() => loadConfig(env)).to.throw(/config error: CRANK_[A-Z_]+/);
    });
  }
});

describe("idle knobs (Phase 12)", () => {
  it("defaults: 120 s idle poll ceiling, idle-roll net OFF", () => {
    const cfg = loadConfig({});
    expect(cfg.idlePollMaxMs).to.equal(120_000);
    expect(cfg.idleRollSecs).to.equal(0);
  });

  it("accepts in-range overrides", () => {
    const cfg = loadConfig({ CRANK_IDLE_POLL_MAX_MS: "30000", CRANK_IDLE_ROLL_SECS: "900" });
    expect(cfg.idlePollMaxMs).to.equal(30_000);
    expect(cfg.idleRollSecs).to.equal(900);
  });

  it("rejects out-of-range values naming the variable", () => {
    expect(() => loadConfig({ CRANK_IDLE_POLL_MAX_MS: "500" })).to.throw(/CRANK_IDLE_POLL_MAX_MS/);
    expect(() => loadConfig({ CRANK_IDLE_ROLL_SECS: "-1" })).to.throw(/CRANK_IDLE_ROLL_SECS/);
    expect(() => loadConfig({ CRANK_IDLE_ROLL_SECS: "90000" })).to.throw(/CRANK_IDLE_ROLL_SECS/);
  });
});

describe("Switchboard crossbar (settle latency)", () => {
  // The SDK's built-in crossbar host, crossbar.switchboard.xyz, no longer
  // resolves (ENOTFOUND on the droplet, 2026-10-07): every oracle pick
  // waited out the health-check fallback, ~11 s of the ~30 s between a
  // round closing and its winner appearing. The labs host answered the
  // same pick in ~3 s with the same live oracle.
  it("defaults to the working switchboardlabs host", () => {
    expect(loadConfig({}).sbCrossbarUrl).to.equal("https://crossbar.switchboardlabs.xyz");
  });

  it("accepts an https override and refuses anything else", () => {
    expect(
      loadConfig({ CRANK_SB_CROSSBAR_URL: "https://crossbar.example.org" }).sbCrossbarUrl,
    ).to.equal("https://crossbar.example.org");
    expect(() => loadConfig({ CRANK_SB_CROSSBAR_URL: "http://crossbar.example.org" })).to.throw(
      /CRANK_SB_CROSSBAR_URL/,
    );
    expect(() => loadConfig({ CRANK_SB_CROSSBAR_URL: "not a url" })).to.throw(
      /CRANK_SB_CROSSBAR_URL/,
    );
  });
});

describe("config cluster (mainnet launch guards)", () => {
  it("defaults to devnet", () => {
    expect(loadConfig({}).cluster).to.equal("devnet");
  });

  it("mainnet needs an explicit mainnet RPC and a keeper key", () => {
    const key = { CRANK_KEYPAIR_PATH: "/etc/orbit-crank/keeper-mainnet.json" };
    expect(() => loadConfig({ ORB_CLUSTER: "mainnet", ...key })).to.throw(/requires CRANK_RPC_URL/);
    expect(() =>
      loadConfig({ ORB_CLUSTER: "mainnet", CRANK_RPC_URL: "https://devnet.helius-rpc.com/?api-key=x", ...key }),
    ).to.throw(/points at devnet/);
    expect(() => loadConfig({ ORB_CLUSTER: "mainnet", CRANK_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=x" })).to.throw(
      /requires CRANK_KEYPAIR/,
    );
    const ok = loadConfig({ ORB_CLUSTER: "mainnet", CRANK_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=x", ...key });
    expect(ok.cluster).to.equal("mainnet");
  });

  it("ORB_REHEARSAL=devnet allows (only) a devnet RPC for the dress rehearsal", () => {
    const key = { CRANK_KEYPAIR_PATH: "/k.json" };
    const dev = "https://devnet.helius-rpc.com/?api-key=x";
    expect(loadConfig({ ORB_CLUSTER: "mainnet", ORB_REHEARSAL: "devnet", CRANK_RPC_URL: dev, ...key }).cluster).to.equal("mainnet");
    expect(() =>
      loadConfig({ ORB_CLUSTER: "mainnet", ORB_REHEARSAL: "devnet", CRANK_RPC_URL: "https://mainnet.helius-rpc.com", ...key }),
    ).to.throw(/needs a devnet/);
  });

  it("refuses a misspelled cluster", () => {
    expect(() => loadConfig({ ORB_CLUSTER: "mainet" })).to.throw(/ORB_CLUSTER/);
  });
});

describe("redactUrl (keys never reach the logs)", () => {
  it("masks query-string credentials and userinfo, keeps the host", () => {
    const out = redactUrl("https://devnet.helius-rpc.com/?api-key=00000000-secret");
    expect(out).to.equal("https://devnet.helius-rpc.com/?api-key=***");
    expect(redactUrl("https://user:pass@rpc.example.com/x")).to.equal("https://***:***@rpc.example.com/x");
    expect(redactUrl("https://api.devnet.solana.com")).to.equal("https://api.devnet.solana.com/");
    expect(redactUrl("not a url")).to.equal("<unparseable url>");
  });
});

describe("gateway RPC (what third-party oracles see)", () => {
  it("defaults to the cluster's public endpoint, never the paid RPC", () => {
    const paid = "https://mainnet.helius-rpc.com/?api-key=secret";
    const main = loadConfig({ ORB_CLUSTER: "mainnet", CRANK_RPC_URL: paid, CRANK_KEYPAIR_PATH: "/k.json" });
    expect(main.gatewayRpcUrl).to.equal("https://api.mainnet-beta.solana.com");
    expect(main.gatewayRpcUrl).to.not.include("api-key");
    const dev = loadConfig({ CRANK_RPC_URL: "https://devnet.helius-rpc.com/?api-key=secret" });
    expect(dev.gatewayRpcUrl).to.equal("https://api.devnet.solana.com");
    expect(loadConfig({ CRANK_GATEWAY_RPC_URL: "https://my.public.rpc" }).gatewayRpcUrl).to.equal("https://my.public.rpc");
  });
});
