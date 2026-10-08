/**
 * Independent draw verification — directive §7 P8 / §8.5.
 *
 * Anyone can recompute the winning entry number from (merkle_root,
 * blockhash); this script does so WITHOUT importing the raffle package
 * — the ~25 lines of crypto below are the whole algorithm, re-implemented
 * from the published spec so a bug in the engine cannot hide here.
 *
 *   canonical list : entries ordered by entry_no ascending
 *   leaf           : sha256(u32le(entry_no) ++ utf8(wallet))
 *   tree           : pairwise sha256(left ++ right), odd node duplicated
 *   reveal         : winning_no = u64_le(sha256(root ‖ blockhash)) mod issued + 1
 *   reveal block   : the FIRST block at or after target_slot (a skipped
 *                    slot has no block); memo says reveal=first_block_at_or_after_target
 *   commitment     : the EARLIEST successful memo from the commit wallet
 *                    for the epoch; it must land before target_slot
 *
 * Usage:
 *   # from published artifacts (offline):
 *   npx tsx scripts/raffle/verify-draw.ts --entries entries.json \
 *       --blockhash <base58> [--root <hex>] [--expect <winning_no>]
 *
 *   # from the database (service-role env, server-side only):
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY_KEY... see below \
 *     npx tsx scripts/raffle/verify-draw.ts --epoch 3
 *
 *   # ... and against the chain (any RPC with history):
 *     npx tsx scripts/raffle/verify-draw.ts --epoch 3 --rpc https://...
 *   checks the commit memo is the earliest for the epoch, landed before
 *   target_slot, carries the recorded root, and that the recorded block
 *   is the first block at or after target_slot with that blockhash.
 *
 * entries.json: [{ "entry_no": 1, "wallet": "..." }, ...] — the published
 * entry list. Exit 0 on success, 1 on any mismatch.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function sha256(...chunks: Buffer[]): Buffer {
  return createHash("sha256").update(Buffer.concat(chunks)).digest();
}

function merkleRoot(entries: Array<{ entryNo: number; wallet: string }>): Buffer {
  let level = entries.map((e) => {
    const no = Buffer.alloc(4);
    no.writeUInt32LE(e.entryNo >>> 0);
    return sha256(no, Buffer.from(e.wallet, "utf8"));
  });
  while (level.length > 1) {
    if (level.length % 2 === 1) level = [...level, level[level.length - 1]];
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(sha256(level[i], level[i + 1]));
    }
    level = next;
  }
  return level[0];
}

function winningNo(root: Buffer, blockhash: Buffer, issued: number): number {
  const h = sha256(root, blockhash);
  return Number(h.readBigUInt64LE(0) % BigInt(issued)) + 1;
}

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** The memo text a transaction logged, or null. */
function memoOf(tx: any): string | null {
  for (const line of (tx?.meta?.logMessages ?? []) as string[]) {
    const m = /^Program log: Memo \(len \d+\): "(.*)"$/.exec(line);
    if (m) return m[1]!;
  }
  return null;
}

interface ChainDraw {
  epoch: number;
  rootHex: string;
  commitSig: string;
  targetSlot: number;
  blockSlot: number | null;
  blockhash: string | null;
}

/** Returns the list of failures (empty = verified). */
async function verifyOnChain(url: string, d: ChainDraw): Promise<string[]> {
  const failures: string[] = [];
  const commit = await rpc(url, "getTransaction", [
    d.commitSig,
    { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 },
  ]);
  if (!commit) return [`commit ${d.commitSig} not found at finalized`];
  if (commit.meta?.err !== null) failures.push("the recorded commit memo FAILED on chain");
  const memo = memoOf(commit) ?? "";
  const expected = new RegExp(
    `^orb-raffle epoch=${d.epoch} root=${d.rootHex} target_slot=${d.targetSlot}( |$)`,
  );
  if (!expected.test(memo)) failures.push(`commit memo does not carry this draw: "${memo}"`);
  if (!(commit.slot < d.targetSlot)) failures.push(`commit landed at ${commit.slot}, not before target ${d.targetSlot}`);
  console.log(`commit        ${d.commitSig} (slot ${commit.slot})`);

  // Earliest successful memo for the epoch, from the commit wallet's history.
  const wallet = commit.transaction.message.accountKeys[0] as string;
  let before: string | undefined;
  let earliest: { sig: string; slot: number } | null = null;
  for (let page = 0; page < 20; page += 1) {
    const sigs = (await rpc(url, "getSignaturesForAddress", [
      wallet,
      { limit: 1000, commitment: "finalized", ...(before ? { before } : {}) },
    ])) as Array<{ signature: string; slot: number; err: unknown; memo: string | null }>;
    for (const s of sigs) {
      if (s.err !== null || !s.memo || !s.memo.includes(`orb-raffle epoch=${d.epoch} `)) continue;
      if (earliest === null || s.slot <= earliest.slot) earliest = { sig: s.signature, slot: s.slot };
    }
    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1]!.signature;
  }
  if (earliest === null) failures.push("no memo for this epoch in the commit wallet's history");
  else if (earliest.sig !== d.commitSig) {
    failures.push(`the earliest memo for epoch ${d.epoch} is ${earliest.sig}, not the recorded one`);
  }

  if (d.blockSlot !== null && d.blockhash !== null) {
    const slots = (await rpc(url, "getBlocks", [d.targetSlot, d.targetSlot + 499, { commitment: "finalized" }])) as number[];
    const first = slots.length > 0 ? Math.min(...slots) : null;
    if (first !== d.blockSlot) failures.push(`first block at/after ${d.targetSlot} is ${first}, recorded ${d.blockSlot}`);
    if (first !== null) {
      const block = await rpc(url, "getBlock", [
        first,
        { commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 },
      ]);
      if (block?.blockhash !== d.blockhash) failures.push(`block ${first} hash ${block?.blockhash} != recorded ${d.blockhash}`);
      console.log(`reveal block  ${first} ${block?.blockhash}`);
    }
  }
  return failures;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * The DB-mode target is allowlisted: HTTPS only, and the host must be a
 * Supabase project host (or an explicit RAFFLE_VERIFY_ALLOWED_HOST).
 * This script never talks to anything else.
 */
function allowlistedRestBase(): string {
  const raw = process.env.SUPABASE_URL ?? "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("SUPABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("SUPABASE_URL must be https");
  }
  const allowedHost =
    process.env.RAFFLE_VERIFY_ALLOWED_HOST ?? "";
  const hostOk =
    (parsed.hostname.endsWith(".supabase.co") && parsed.hostname !== "supabase.co") ||
    (allowedHost !== "" && parsed.hostname === allowedHost);
  if (!hostOk) {
    throw new Error(
      `SUPABASE_URL host ${parsed.hostname} is not an allowlisted Supabase host — refusing to fetch`,
    );
  }
  return parsed.origin;
}

async function main(): Promise<void> {
  const blockhashB58 = arg("blockhash");
  const expect = arg("expect");
  const epochArg = arg("epoch");
  const rootArg = arg("root");
  const entriesFile = arg("entries");
  const bs58 = (await import("bs58")).default;

  let root: Buffer | null = rootArg ? Buffer.from(rootArg.replace(/^0x/, ""), "hex") : null;
  let blockhash: Buffer | null = blockhashB58 ? bs58.decode(blockhashB58) : null;

  if (epochArg !== undefined) {
    // Database mode: fetch the draw + canonical entry list via PostgREST.
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) {
      console.error("SUPABASE_SERVICE_ROLE_KEY is required with --epoch");
      process.exit(1);
    }
    const base = allowlistedRestBase();
    const epoch = Number(epochArg);
    const headers = { apikey: key, authorization: `Bearer ${key}` };
    const drawRes = await fetch(`${base}/rest/v1/raffle_draws?epoch_id=eq.${epoch}&select=*`, { headers });
    const draw = (await drawRes.json())[0];
    if (!draw) {
      console.error(`no draw row for epoch ${epoch}`);
      process.exit(1);
    }
    root = Buffer.from(String(draw.merkle_root).replace(/^\\x/, ""), "hex");
    blockhash = draw.slot_blockhash ? bs58.decode(draw.slot_blockhash) : null;
    const entriesRes = await fetch(
      `${base}/rest/v1/raffle_entries?epoch_id=eq.${epoch}&status=neq.voided&select=entry_no,wallet&order=entry_no.asc`,
      { headers },
    );
    const rows = (await entriesRes.json()) as Array<{ entry_no: number; wallet: string }>;
    const entries = rows.map((r) => ({ entryNo: Number(r.entry_no), wallet: r.wallet }));

    const issued = Number(draw.entries_issued ?? entries.length) || entries.length;
    console.log(`epoch ${epoch}`);
    console.log(`root          ${root.toString("hex")}`);
    console.log(`blockhash     ${draw.slot_blockhash ?? "(not yet revealed)"}`);
    console.log(`entries       ${entries.length}`);
    if (blockhash !== null) {
      const recomputed = winningNo(root, blockhash, issued);
      console.log(`winning_no    ${recomputed}`);
      console.log(`recorded      ${draw.winning_no ?? "(none)"}`);
      console.log(`winner        ${draw.winner_wallet ?? "(none)"}`);
      if (Number(draw.winning_no) !== recomputed) {
        console.error("MISMATCH: the recorded winning_no does not reproduce");
        process.exit(1);
      }
    } else {
      console.log(`target_slot   ${draw.target_slot} — reveal pending`);
    }
    const rpcUrl = arg("rpc");
    if (rpcUrl !== undefined) {
      const failures = await verifyOnChain(rpcUrl, {
        epoch,
        rootHex: root.toString("hex"),
        commitSig: String(draw.commit_sig),
        targetSlot: Number(draw.target_slot),
        blockSlot: draw.block_slot === null || draw.block_slot === undefined ? null : Number(draw.block_slot),
        blockhash: draw.slot_blockhash ?? null,
      });
      for (const f of failures) console.error(`MISMATCH: ${f}`);
      if (failures.length > 0) process.exit(1);
      console.log("chain check   OK");
    }
    return;
  }

  if (!entriesFile || !blockhash) {
    console.error("usage: --entries entries.json --blockhash <base58> [--root <hex>] [--expect n]");
    console.error("       --epoch N (with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)");
    process.exit(1);
  }

  const entries = (JSON.parse(readFileSync(entriesFile, "utf8")) as Array<{
    entry_no: number | string;
    wallet: string;
  }>)
    .map((e) => ({ entryNo: Number(e.entry_no), wallet: e.wallet }))
    .sort((a, b) => a.entryNo - b.entryNo);

  const computedRoot = merkleRoot(entries);
  console.log(`entries       ${entries.length}`);
  console.log(`root          ${computedRoot.toString("hex")}`);
  if (root !== null) {
    if (!root.equals(computedRoot)) {
      console.error("MISMATCH: the published merkle root does not match the entry list");
      process.exit(1);
    }
    console.log("root check    OK");
  }
  const no = winningNo(computedRoot, blockhash, entries.length);
  console.log(`winning_no    ${no}`);
  if (expect !== undefined) {
    if (Number(expect) !== no) {
      console.error(`MISMATCH: expected ${expect}`);
      process.exit(1);
    }
    console.log("expect check  OK");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
