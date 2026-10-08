/**
 * P1 GATE — server skeleton + security posture (directive §7 P1).
 *
 *  1. No Supabase credential is reachable from apps/web/src/** (R1):
 *     grep-based, mirroring apps/web/tests/ore_isolation.test.ts — the
 *     repo has no eslint config and a grepping test has zero new
 *     dependencies. Nothing under apps/web/src may reference supabase
 *     in any spelling, import the raffle server package, or reach
 *     packages/raffle by path; apps/web/package.json must not depend on
 *     any supabase package; apps/web/.env.example must not name a
 *     SUPABASE variable (the browser never even sees a key name).
 *
 *  2. Every endpoint rejects a body carrying `amount` or `entries` at
 *     any depth with 400 — the server derives every number from the
 *     chain (R2), and a hostile client cannot even suggest them.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect } from "chai";
import { describe, it } from "mocha";
import { claimEndpoint, type ClaimDeps } from "../src/endpoints/claim";
import { json, serveRaffle, type RaffleRequest } from "../src/http";
import { ORE_FEE_DEFAULTS } from "../src/env";

const testsDir = __dirname;
const repoRoot = resolve(testsDir, "..", "..", "..");
const webSrcRoot = resolve(repoRoot, "apps", "web", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("P1 — R1: no Supabase credential reachable from apps/web/src", () => {
  const files = walk(webSrcRoot);

  it("no file under apps/web/src mentions supabase in any spelling", () => {
    const offenders = files.filter((f) => {
      const text = readFileSync(f, "utf8");
      return /supabase/i.test(text);
    });
    expect(offenders, "files referencing supabase").to.deep.equal([]);
  });

  it("no file under apps/web/src imports the raffle server package or its source path", () => {
    const offenders = files.filter((f) => {
      const text = readFileSync(f, "utf8");
      return (
        text.includes("@orbit-jackpot/raffle") ||
        text.includes("packages/raffle")
      );
    });
    expect(offenders, "files importing the raffle server package").to.deep.equal([]);
  });

  it("apps/web/package.json has no supabase dependency", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "apps/web/package.json"), "utf8"));
    const all = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    const names = Object.keys(all).filter((n) => /supabase/i.test(n));
    expect(names, "supabase packages in apps/web").to.deep.equal([]);
  });

  it("apps/web/.env.example names no SUPABASE variable", () => {
    const env = readFileSync(join(repoRoot, "apps/web/.env.example"), "utf8");
    expect(/SUPABASE/i.test(env), "SUPABASE variable in web env example").to.be.false;
  });

  it("the service-role key is loaded in exactly one module", () => {
    const src = walk(resolve(repoRoot, "packages/raffle/src"));
    const loaders = src.filter((f) => readFileSync(f, "utf8").includes("SUPABASE_SERVICE_ROLE_KEY"));
    expect(loaders).to.deep.equal([join(resolve(repoRoot, "packages/raffle/src"), "env.ts")]);
  });
});

// ── endpoint posture ───────────────────────────────────────────────────

function failingDeps(): ClaimDeps {
  return {
    config: {
      supabaseUrl: "https://example.supabase.co",
      supabaseServiceRoleKey: "test-key",
      solanaRpcUrl: "https://api.mainnet-beta.solana.com",
      raffleTreasuryPubkey: "Treasury111111111111111111111111111111111111",
      cronSecret: "cron-secret",
      ...ORE_FEE_DEFAULTS,
      lamportsPerEntry: 1_000_000_000,
      entryPriceLamports: 50_000_000,
      referralMinLamports: 1_000_000_000,
      referralCapPerEpoch: 25,
      purchaseCapPerWallet: 25,
      purchaseCapShareBps: 3_000,
      epochCap: 1_000,
      epochDurationDays: 7,
    },
    // Every dependency past the guard throws, so a body that should
    // have been rejected cannot reach the chain OR the database
    // quietly — it fails loudly instead of returning a plausible 200.
    store: {
      currentOpenEpoch: async () => {
        throw new Error("the store must not be reached for rejected bodies");
      },
      getOrbRound: async () => {
        throw new Error("the store must not be reached for rejected bodies");
      },
      submitEarnedEvent: async () => {
        throw new Error("the store must not be reached for rejected bodies");
      },
    },
    fetchTransaction: async () => {
      throw new Error("fetchTransaction must not be called for rejected bodies");
    },
  };
}

async function serve(req: RaffleRequest): Promise<{ status: number; payload: any }> {
  let captured: { status: number; payload: unknown } | null = null;
  await serveRaffle(req, {
    status: (code: number) => ({
      json: (payload: unknown) => {
        captured = { status: code, payload };
      },
    }),
  }, claimEndpoint(failingDeps()));
  return captured as unknown as { status: number; payload: any };
}

describe("P1 — R2 posture: hostile bodies are rejected before any chain call", () => {
  const handler = claimEndpoint(failingDeps());
  const base = { signature: "5".repeat(87), wallet: "9".repeat(43) };

  it("rejects a body carrying amount (400 forbidden_body_field)", async () => {
    let thrown: any;
    try {
      await handler({ method: "POST", headers: {}, body: { ...base, amount: 5 } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).to.be.instanceOf(Error);
    expect((thrown as any).status).to.equal(400);
    expect((thrown as any).code).to.equal("forbidden_body_field");
  });

  it("rejects a body carrying entries (400 forbidden_body_field)", async () => {
    let thrown: any;
    try {
      await handler({ method: "POST", headers: {}, body: { ...base, entries: 999 } });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as any).status).to.equal(400);
  });

  it("rejects amount/entries at any depth, including arrays", async () => {
    const hostile = [
      { ...base, nested: { deep: [{ amount: 1 }] } },
      { ...base, nested: { deep: [{ entries: 1 }] } },
      { ...base, nested: { AMOUNT: 1 } },
    ];
    for (const body of hostile) {
      let thrown: any;
      try {
        await handler({ method: "POST", headers: {}, body });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, JSON.stringify(body)).to.be.instanceOf(Error);
      expect((thrown as any).code).to.equal("forbidden_body_field");
    }
  });

  it("rejects non-JSON-object and non-POST requests", async () => {
    for (const body of [[1, 2], "x", 42, null]) {
      let thrown: any;
      try {
        await handler({ method: "POST", headers: {}, body });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, String(body)).to.be.instanceOf(Error);
      expect((thrown as any).status).to.equal(400);
    }
    let thrown: any;
    try {
      await handler({ method: "GET", headers: {}, body: base });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as any).status).to.equal(405);
  });

  it("malformed signatures and wallets 400 before any fetch", async () => {
    for (const body of [
      { signature: "short", wallet: base.wallet },
      { signature: base.signature, wallet: "not-a-pubkey!!" },
      { wallet: base.wallet },
    ]) {
      let thrown: any;
      try {
        await handler({ method: "POST", headers: {}, body });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, JSON.stringify(body)).to.be.instanceOf(Error);
      expect((thrown as any).status).to.equal(400);
    }
  });

  it("serveRaffle converts guard throws into JSON error responses", async () => {
    const res = await serve({ method: "POST", headers: {}, body: { amount: 1 } });
    expect(res.status).to.equal(400);
    expect(res.payload).to.deep.include({ error: "forbidden_body_field" });
  });

  it("an unhandled orchestrator failure is a 500, never a crash", async () => {
    const deps = failingDeps();
    deps.fetchTransaction = async () => {
      throw new Error("rpc down");
    };
    const res = await serve2(deps);
    expect(res.status).to.equal(500);
  });

  async function serve2(deps: ClaimDeps): Promise<{ status: number; payload: any }> {
    let captured: { status: number; payload: unknown } | null = null;
    await serveRaffle(
      { method: "POST", headers: {}, body: { signature: "5".repeat(87), wallet: "9".repeat(43) } },
      {
        status: (code: number) => ({
          json: (payload: unknown) => {
            captured = { status: code, payload };
          },
        }),
      },
      claimEndpoint(deps),
    );
    return captured as unknown as { status: number; payload: any };
  }

  it("json() helper shapes { status, payload }", () => {
    const r = json(202, { status: "pending" });
    expect(r.status).to.equal(202);
  });
});
