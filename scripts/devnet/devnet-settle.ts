/**
 * The LIVE devnet settlement pipeline (phase 8.3) — resumable at every
 * stage, mirroring the on-chain protocol proven in 8.1–8.3:
 *
 *   wait for end_ts → lock_round
 *   → create_randomness (OUR program CPIs `randomness_init`; the round
 *     PDA signs as the account authority — the deployed program demands
 *     the authority's signature, probed live)
 *   → request_randomness (pin, ADR-4)
 *   → commit_randomness (OUR program CPIs `randomness_commit`; the round
 *     PDA signs — the authority-gated precommitment)
 *   → reveal_randomness (OUR program CPIs `randomness_reveal`; the value
 *     comes from the oracle's HTTPS gateway, TEE-signed over the
 *     committed slothash)
 *   → fulfill_settle
 *   → verify: the emitted RoundSettled event vs the account bytes vs the
 *     independent entropy mirror.
 *
 *   npx tsx scripts/devnet/devnet-settle.ts
 */

import { getAssociatedTokenAddressSync, NATIVE_MINT } from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { AnchorUtils, Oracle, Queue, State } from "@switchboard-xyz/on-demand";
import { Gateway } from "@switchboard-xyz/common";
import { getLutSigner, getLutKey } from "@switchboard-xyz/on-demand/dist/esm/utils/lookupTable.js";
import bs58 from "bs58";
import {
  OrbitJackpotClient,
  parseEventInstruction,
  roundKey,
} from "@orbit-jackpot/sdk";
import { splitEntropy, ticketFromEntropy, megaTriggered } from "../local-demo/common";
import {
  assertSafeGatewayUrl,
  connection,
  DEVNET_RPC_URL,
  explorer,
  loadAdmin,
  loadOrGenerateKeypair,
  SB_DEVNET_PROGRAM_ID,
  SB_DEVNET_QUEUE,
  send,
} from "./common";

const DEFAULT_PUBKEY = PublicKey.default.toBase58();

/** The 408-byte RandomnessAccountData offsets (repr(C), probed live). */
const RA = {
  discriminator: [10, 66, 229, 135, 220, 239, 217, 114],
  authority: [8, 40],
  queue: [40, 72],
  seedSlothash: [72, 104],
  seedSlot: [104, 112],
  oracle: [112, 144],
  revealSlot: [144, 152],
  value: [152, 184],
} as const;

interface RandomnessView {
  authority: PublicKey;
  queue: PublicKey;
  seedSlothash: Uint8Array;
  seedSlot: bigint;
  oracle: PublicKey;
  revealSlot: bigint;
  value: Uint8Array;
}

async function readRandomness(key: PublicKey): Promise<RandomnessView | null> {
  const info = await connection.getAccountInfo(key);
  if (info === null) return null;
  const d = info.data;
  const pk = (r: readonly [number, number]) => new PublicKey(d.subarray(r[0], r[1]));
  const u64 = (r: readonly [number, number]) => d.readBigUInt64LE(r[0]);
  return {
    authority: pk(RA.authority),
    queue: pk(RA.queue),
    seedSlothash: Uint8Array.from(d.subarray(RA.seedSlothash[0], RA.seedSlothash[1])),
    seedSlot: u64(RA.seedSlot),
    oracle: pk(RA.oracle),
    revealSlot: u64(RA.revealSlot),
    value: Uint8Array.from(d.subarray(RA.value[0], RA.value[1])),
  };
}

async function waitChainClockPast(unixTarget: bigint): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    const slot = await connection.getSlot("confirmed");
    const blockTime = await connection.getBlockTime(slot).catch(() => null);
    if (blockTime !== null && BigInt(blockTime) >= unixTarget) return;
    console.log(`  waiting for end_ts ${unixTarget} (chain now ${blockTime})…`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error("chain clock never reached end_ts");
}

async function main(): Promise<void> {
  const client = new OrbitJackpotClient(connection);
  const admin = loadAdmin();
  const config = (await client.fetchConfig()) ?? null;
  if (config === null) throw new Error("not initialized — run init-config first");
  const roundId = config.activeRoundId;
  let round = await client.fetchRound(roundId);
  if (round === null) throw new Error(`round ${roundId} not found — run open-round first`);

  // ── 1. lock the window on the CHAIN clock ──
  if (round.state === "open") {
    console.log("waiting for the deposit window to close…");
    await waitChainClockPast(round.endTs);
    await send(client.buildLockRoundTx(roundId, admin.publicKey), [admin], "lock_round");
    round = (await client.fetchRound(roundId))!;
    if (round.state === "cancelled") throw new Error("round auto-cancelled (empty/sole)");
  }
  if (round.state === "locked") {
    // ── 2. create the round's randomness account THROUGH our program: the
    // round PDA signs `randomness_init` as the authority (the deployed
    // program demands the authority's signature — probed live) ──
    const randomKp = loadOrGenerateKeypair(`randomness-${roundId}`);
    const existing = await readRandomness(randomKp.publicKey);
    if (existing === null) {
      const sbProgram = await AnchorUtils.loadProgramFromConnection(connection, admin);
      // The ALT CreateLookupTable CPI demands a slot inside the recent
      // 512-slot window; 'finalized' lags far enough on devnet (plus 429
      // retries) to go stale — so derive from 'confirmed' and rebuild with
      // a FRESH slot on failure. The whole create is atomic: a failed
      // attempt lands nothing.
      let created = false;
      for (let attempt = 1; attempt <= 3 && !created; attempt += 1) {
        const recentSlot = await connection.getSlot("confirmed");
        const lutSigner = getLutSigner(SB_DEVNET_PROGRAM_ID, randomKp.publicKey);
        const lutKey = getLutKey(lutSigner, recentSlot);
        const tx = client.buildCreateRandomnessTx(
          roundId,
          randomKp.publicKey,
          BigInt(recentSlot),
          SB_DEVNET_QUEUE,
          getAssociatedTokenAddressSync(NATIVE_MINT, randomKp.publicKey),
          State.keyFromSeed(sbProgram),
          lutSigner,
          lutKey,
          SB_DEVNET_PROGRAM_ID,
          admin.publicKey,
        );
        try {
          await send(tx, [admin, randomKp], `create_randomness (authority = round ${roundId} PDA)`);
          created = true;
        } catch (err) {
          console.log(`  create attempt ${attempt} failed: ${String(err).slice(0, 140)}`);
          await new Promise((r) => setTimeout(r, 1_500));
        }
      }
      if (!created) throw new Error("create_randomness never landed");
    } else {
      console.log(`randomness account exists: ${randomKp.publicKey.toBase58()}`);
    }

    // ── 3. pin it (Locked → AwaitingRandomness) ──
    await send(
      client.buildRequestRandomnessTx(roundId, randomKp.publicKey, admin.publicKey),
      [admin],
      "request_randomness (pin)",
    );
    round = (await client.fetchRound(roundId))!;
  }

  const pinned =
    round!.randomnessAccount === DEFAULT_PUBKEY
      ? null
      : new PublicKey(round!.randomnessAccount);
  if (pinned === null) throw new Error("round has no pinned randomness account");

  // ── 4. COMMIT through our program (round PDA signs the CPI) ──
  let view = await readRandomness(pinned);
  if (view === null) throw new Error(`pinned randomness account ${pinned} missing`);
  if (view.seedSlot === 0n) {
    const sbProgram = await AnchorUtils.loadProgramFromConnection(connection, admin);
    const queue = new Queue(sbProgram, SB_DEVNET_QUEUE);
    const { oracle } = await queue.selectRandomnessOracle();
    console.log(`commit oracle: ${oracle.pubkey.toBase58()}`);
    await send(
      client.buildCommitRandomnessTx(
        roundId,
        pinned,
        SB_DEVNET_QUEUE,
        oracle.pubkey,
        SB_DEVNET_PROGRAM_ID,
        admin.publicKey,
      ),
      [admin],
      "commit_randomness (round PDA CPI)",
    );
    view = await readRandomness(pinned);
    console.log(`  seed_slot ${view!.seedSlot} · oracle ${view!.oracle.toBase58()}`);
  } else {
    console.log(`already committed: seed_slot ${view.seedSlot}`);
  }
  if (view!.seedSlot <= round!.lockSlot) throw new Error("commit not fresh vs lock — investigate");

  // ── 5. REVEAL: fetch the TEE payload from the oracle gateway, publish
  // THROUGH our program (the round PDA signs the reveal CPI) ──
  if (view!.revealSlot === 0n) {
    const sbProgram = await AnchorUtils.loadProgramFromConnection(connection, admin);
    const oracleAccount = new Oracle(sbProgram, view!.oracle);
    const oracleData = await oracleAccount.loadData();
    const gatewayUrl = Buffer.from(oracleData.gatewayUri).toString().replace(/\0+$/, "");
    assertSafeGatewayUrl(gatewayUrl);
    console.log(`oracle gateway: ${gatewayUrl}`);

    let reveal: { signature: string; recovery_id: number; value: string } | null = null;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      try {
        reveal = await new Gateway(gatewayUrl).fetchRandomnessReveal({
          randomnessAccount: pinned,
          slothash: bs58.encode(Buffer.from(view!.seedSlothash)),
          slot: Number(view!.seedSlot),
          rpc: DEVNET_RPC_URL,
        });
        break;
      } catch (err) {
        console.log(`  gateway not ready (attempt ${attempt}): ${String(err).slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    if (reveal === null) throw new Error("gateway never produced a reveal");

    const stats = PublicKey.findProgramAddressSync(
      [Buffer.from("OracleRandomnessStats"), view!.oracle.toBuffer()],
      SB_DEVNET_PROGRAM_ID,
    )[0];
    const tx = client.buildRevealRandomnessTx(
      roundId,
      pinned,
      view!.oracle,
      SB_DEVNET_QUEUE,
      stats,
      getAssociatedTokenAddressSync(NATIVE_MINT, pinned),
      State.keyFromSeed(sbProgram),
      SB_DEVNET_PROGRAM_ID,
      admin.publicKey,
      Buffer.from(reveal.signature, "base64"),
      reveal.recovery_id,
      Buffer.from(reveal.value, "base64"),
    );
    await send(tx, [admin], "reveal_randomness (round PDA CPI)");
    view = await readRandomness(pinned);
  }
  if (view!.revealSlot === 0n) throw new Error("reveal did not land");
  console.log(`  revealed at slot ${view!.revealSlot}`);
  console.log(`  value ${Buffer.from(view!.value).toString("hex")}`);

  // ── 6. SETTLE (resume-safe: an already-settled round verifies against a
  // caller-provided signature) ──
  let settleSig = process.env.SETTLE_SIG;
  if (round!.state === "awaitingRandomness") {
    settleSig = await send(
      client.buildFulfillSettleTx(roundId, pinned, admin.publicKey),
      [admin],
      "fulfill_settle",
    );
  } else if (round!.state !== "settled") {
    throw new Error(`round ${roundId} is ${round!.state} — nothing to settle`);
  }
  if (settleSig === undefined || settleSig === "") {
    throw new Error("round already settled — re-run with SETTLE_SIG=<signature> to verify");
  }

  // ── 7. VERIFY: event vs account bytes vs the independent mirror ──
  const settled = (await client.fetchRound(roundId))!;
  const tx = await connection.getTransaction(settleSig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  // Public RPC returns raw inner instructions (programIdIndex + base58
  // data); some RPCs return the parsed shape (programId). Handle both, and
  // coerce account keys defensively (tsx's module graph can yield String
  // objects where plain node yields primitives).
  const message = tx!.transaction.message as { accountKeys?: unknown[] };
  const asKey = (k: unknown): string => {
    if (typeof k === "object" && k !== null && "pubkey" in k) {
      return String((k as { pubkey: unknown }).pubkey);
    }
    return String(k);
  };
  const accountKeys: string[] = (message.accountKeys ?? []).map(asKey);
  const loaded = tx!.meta?.loadedAddresses;
  if (loaded !== undefined) {
    accountKeys.push(...loaded.writable.map(asKey), ...loaded.readonly.map(asKey));
  }
  let event: ReturnType<typeof parseEventInstruction> = null;
  for (const group of tx?.meta?.innerInstructions ?? []) {
    for (const raw of group.instructions as Array<Record<string, unknown>>) {
      const programId =
        typeof raw.programId === "string"
          ? raw.programId
          : typeof raw.programIdIndex === "number"
            ? accountKeys[raw.programIdIndex]
            : undefined;
      const data = typeof raw.data === "string" ? raw.data : undefined;
      if (programId === undefined || data === undefined) continue;
      if (programId !== client.programId.toString()) continue;
      const parsed = parseEventInstruction(bs58.decode(data));
      if (parsed !== null && parsed.name === "RoundSettled") event = parsed;
    }
  }
  if (event === null) throw new Error("RoundSettled event not found in the settle tx");

  const mirror = splitEntropy(view!.value);
  const expectedTicket = ticketFromEntropy(mirror.ticket, settled.totalLamports);
  console.log("\n═══ ROUND SETTLED ON DEVNET ═══");
  console.log(`round            ${roundId}`);
  console.log(`total            ${Number(settled.totalLamports) / LAMPORTS_PER_SOL} SOL`);
  console.log(`winning ticket   ${settled.winningTicket}`);
  console.log(`  mirror         ${expectedTicket} ${expectedTicket === settled.winningTicket ? "✓ MATCH" : "✗ DIVERGED"}`);
  console.log(`  event          ${event.data.winningTicket} ${event.data.winningTicket === settled.winningTicket ? "✓ MATCH" : "✗ DIVERGED"}`);
  console.log(`winner payout    ${Number(settled.winnerPayout) / LAMPORTS_PER_SOL} SOL`);
  console.log(`admin cut        ${Number(settled.adminCut) / LAMPORTS_PER_SOL} SOL`);
  console.log(`mega cut         ${Number(settled.megaCut) / LAMPORTS_PER_SOL} SOL`);
  console.log(`mega TRIGGERED   ${settled.megaTriggered} (mirror says ${megaTriggered(mirror.mega)})`);
  console.log(`randomness value ${Buffer.from(view!.value).toString("hex")}`);
  console.log(`round account    ${explorer(roundKey(roundId).toBase58(), "address")}`);
  console.log(`settle tx        ${explorer(settleSig)}`);
  if (expectedTicket !== settled.winningTicket || event.data.winningTicket !== settled.winningTicket) {
    throw new Error("settlement verification FAILED");
  }
  console.log("\nverification PASSED — chain outcome ≡ event ≡ independent mirror");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
