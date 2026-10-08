/**
 * The autonomous settle pipeline — the daemonized form of the phase-8
 * `devnet-settle.ts` state machine, resumable at every stage because each
 * step is gated on observable chain state (round state, pin, seed_slot,
 * reveal_slot). One action per evaluation; the supervisor re-reads and
 * re-evaluates after each landing, so a crash anywhere resumes exactly
 * where the chain says it should.
 *
 *   locked, unpinned  → create_randomness (round-PDA authority CPI;
 *                       fresh confirmed slot per send attempt — the
 *                       512-slot ALT window) → request_randomness (pin)
 *   awaiting, seed 0   → commit_randomness (exactly-once: seed_slot==0;
 *                       post-landing belt asserts seed_slot > lock_slot,
 *                       else the round is QUARANTINED, never blind-retried)
 *   awaiting, unrevealed → gateway reveal fetch (URL-guarded, bounded)
 *                       → reveal_randomness (TEE payload published via CPI)
 *   awaiting, revealed → fulfill_settle (keeper tip lands) → post-landing
 *                       three-way verification (chain ≡ event ≡ mirror)
 */

import {
  ENTROPY_NONE,
  entropyChainKey,
  entryKey,
  parseEventInstruction,
  roundKey,
  decodeRound,
  type GlobalConfigData,
  type RoundData,
} from "@orbit-jackpot/sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { CrankAction } from "../actions";
import type { HandlerCtx } from "../context";
import type { ChainClock } from "../rpc";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { lutKeys, randomnessStatsKey } from "../randomness";
import { splitEntropy, ticketFromEntropy } from "../mirror";
import { ENTROPY_REVEAL_DEADLINE_SLOTS, entropyValue, findSlotHash } from "../entropy";

const DEFAULT_PUBKEY = PublicKey.default.toBase58();
const CREATE_ATTEMPTS = 3;
/** After this many failed combined sends, fall back to a plain reveal. */
export const REVEAL_AND_SETTLE_MAX_FAILURES = 1;

export async function evalSettle(
  ctx: HandlerCtx,
  config: GlobalConfigData,
  round: RoundData,
  clock: ChainClock,
): Promise<CrankAction | null> {
  if (config.paused) return null;
  if (round.state !== "locked" && round.state !== "awaitingRandomness") return null;
  if (ctx.book.isQuarantined(round.roundId) !== null) return null;

  // Randomness fallback: a round pinned to the entropy chain stays on it
  // whatever the config says now; an unpinned round uses the configured
  // provider. Never decide per round from anything else.
  const chainKey = entropyChainKey().toBase58();
  if (round.randomnessAccount === chainKey) return evalEntropy(ctx, config, round, clock);
  if (round.randomnessAccount === DEFAULT_PUBKEY && round.state === "locked") {
    if (config.oracleProvider === "entropy") return evalEntropy(ctx, config, round, clock);
    if (config.oracleProvider !== "switchboard") return null;
  }

  const keeper = ctx.keeper;
  const roundId = round.roundId;
  // Config pubkeys arrive as base58 strings — hoist the conversions once.
  const queue = new PublicKey(config.oracleQueue);
  const oracleProgram = new PublicKey(config.oracleProgramId);

  // ── stage 1: birth + pin the randomness account ──
  if (round.state === "locked") {
    if (round.randomnessAccount === DEFAULT_PUBKEY) {
      const kp = ctx.book.randomnessKeypair(roundId); // persisted before any send
      const existing = await ctx.bridge.randomness(kp.publicKey);
      if (existing === null) {
        return {
          kind: "create_randomness",
          roundId,
          label: `create_randomness r${roundId} (${kp.publicKey.toBase58().slice(0, 8)}…)`,
          sendAttempts: CREATE_ATTEMPTS,
          extraSigners: [kp],
          build: async (freshSlot) => {
            const { lutSigner, lut } = lutKeys(oracleProgram, kp.publicKey, freshSlot);
            return ctx.client.buildCreateRandomnessTx(
              roundId,
              kp.publicKey,
              freshSlot,
              queue,
              getAssociatedTokenAddressSync(NATIVE_MINT, kp.publicKey),
              await ctx.sb.programStateKey(),
              lutSigner,
              lut,
              oracleProgram,
              keeper.publicKey,
            );
          },
        };
      }
      return pinAction(ctx, roundId, kp.publicKey);
    }
    // Locked but already pinned — the pin tx must not have landed; replay it.
    return pinAction(ctx, roundId, new PublicKey(round.randomnessAccount));
  }

  // ── stages 2–4: the pinned-account pipeline ──
  if (round.randomnessAccount === DEFAULT_PUBKEY) {
    ctx.book.quarantine(roundId, "awaitingRandomness without a pinned randomness account");
    return null;
  }
  const pinned = new PublicKey(round.randomnessAccount);
  const view = await ctx.bridge.randomness(pinned);
  if (view === null) {
    ctx.book.quarantine(roundId, `pinned randomness account ${pinned.toBase58()} missing`);
    return null;
  }

  // The oracle-timeout cancel applies BEFORE the commit too: if no oracle
  // can be selected or commit (a Switchboard outage — mainnet 2026-10-08,
  // every gateway on the queue returning 503), the round would otherwise
  // retry the commit forever and never refund. The deadline runs from the
  // pin (randomness_commit_slot), exactly as the program checks it.
  if (view.revealSlot === 0n && clock.slot > round.randomnessCommitSlot + config.randomnessRevealDeadlineSlots) {
    return {
      kind: "cancel_round",
      roundId,
      quarantineOnFailure: false,
      label: `cancel_round r${roundId} (oracle never ${view.seedSlot === 0n ? "committed" : "revealed"}; refunds follow)`,
      build: () => ctx.client.buildCancelRoundTx(roundId, pinned, keeper.publicKey),
    };
  }

  if (view.seedSlot === 0n) {
    const oracle = await ctx.sb.selectOracle(queue);
    return {
      kind: "commit_randomness",
    sendAttempts: 3, // AUDIT C-8: pipeline stages retry with a fresh blockhash
      roundId,
      label: `commit_randomness r${roundId} (oracle ${oracle.toBase58().slice(0, 8)}…)`,
      build: () =>
        ctx.client.buildCommitRandomnessTx(
          roundId,
          pinned,
          queue,
          oracle,
          oracleProgram,
          keeper.publicKey,
        ),
      after: async () => {
        // The belt from phase 8: the commit must be fresh vs the lock.
        const fresh = await ctx.bridge.randomness(pinned);
        if (fresh === null || fresh.seedSlot <= round.lockSlot) {
          ctx.book.quarantine(
            roundId,
            `commit not fresh vs lock (seed_slot ${fresh?.seedSlot ?? 0n} <= lock_slot ${round.lockSlot})`,
          );
        }
      },
    };
  }

  if (view.seedSlot <= round.lockSlot) {
    ctx.book.quarantine(
      roundId,
      `commit not fresh vs lock — investigate (seed_slot ${view.seedSlot} <= lock_slot ${round.lockSlot})`,
    );
    return null;
  }

  if (view.revealSlot === 0n) {
    // AUDIT C-3: the on-chain deadline runs from `randomness_commit_slot`
    // (set at the pin), not the oracle's seed slot. Past it, an unrevealed
    // round can never settle: cancel it so every entry refunds (AUDIT C-1
    // — the old quarantine here was a dead end that froze player money).
    // A reveal that lands first wins the race; the program refuses a
    // cancel once revealed (AUDIT P-1).
    if (clock.slot > round.randomnessCommitSlot + config.randomnessRevealDeadlineSlots) {
      return {
        kind: "cancel_round",
        roundId,
        quarantineOnFailure: false,
        label: `cancel_round r${roundId} (oracle never revealed; refunds follow)`,
        build: () => ctx.client.buildCancelRoundTx(roundId, pinned, keeper.publicKey),
      };
    }
    const gatewayUrl = await ctx.sb.oracleGatewayUrl(view.oracle);
    const payload = await ctx.sb.fetchReveal(gatewayUrl, pinned, view);
    if (payload === null) {
      ctx.logger.warn({ roundId: roundId.toString(), oracle: view.oracle.toBase58() }, "gateway produced no reveal yet — retrying next tick");
      return null;
    }
    const stats = randomnessStatsKey(view.oracle, oracleProgram);
    const buildReveal = async () =>
      ctx.client.buildRevealRandomnessTx(
        roundId,
        pinned,
        view.oracle,
        queue,
        stats,
        getAssociatedTokenAddressSync(NATIVE_MINT, pinned),
        await ctx.sb.programStateKey(),
        oracleProgram,
        keeper.publicKey,
        payload.signature,
        payload.recoveryId,
        payload.value,
      );

    // AUDIT P-5: once a reveal lands on its own, anyone can send
    // fulfill_settle ahead of the keeper and take the tip. Revealing and
    // settling in ONE transaction leaves no such window. The program
    // checks the presented value equals the revealed one, so the winner
    // computed from the payload is the one settlement will pick. If the
    // combined send fails, the next attempt falls back to the plain
    // two-step path so a combined-only problem can never stall a round.
    const combinedFailures = ctx.book.failureCount(`reveal_and_settle:${roundId}`);
    if (combinedFailures < REVEAL_AND_SETTLE_MAX_FAILURES) {
      const winningEntry = await findWinningEntry(ctx, config, round, payload.value);
      if (winningEntry !== null) {
        return {
          kind: "reveal_and_settle",
          sendAttempts: 3, // AUDIT C-8
          roundId,
          quarantineOnFailure: false,
          label: `reveal_and_settle r${roundId} (tip ${config.keeperTipLamports} lamports, one tx)`,
          build: async () => {
            const reveal = await buildReveal();
            const settle = ctx.client.buildFulfillSettleTx(
              roundId,
              pinned,
              keeper.publicKey,
              winningEntry === "v2" ? undefined : winningEntry,
            );
            return new Transaction().add(...reveal.instructions, ...settle.instructions);
          },
          after: (sig) => verifySettlement(ctx, roundId, sig, sbValue(ctx, pinned)),
        };
      }
    }
    return {
      kind: "reveal_randomness",
      sendAttempts: 3, // AUDIT C-8: pipeline stages retry with a fresh blockhash
      roundId,
      label: `reveal_randomness r${roundId}`,
      build: buildReveal,
    };
  }

  // Revealed and still awaiting settlement — finish it.
  const found = await findWinningEntry(ctx, config, round, view.value);
  if (found === null) return null;
  const winningEntry = found === "v2" ? undefined : found;
  return {
    kind: "fulfill_settle",
    sendAttempts: 3, // AUDIT C-8: pipeline stages retry with a fresh blockhash
    roundId,
    label: `fulfill_settle r${roundId} (tip ${config.keeperTipLamports} lamports${winningEntry ? ", v3" : ""})`,
    build: () => ctx.client.buildFulfillSettleTx(roundId, pinned, keeper.publicKey, winningEntry),
    after: (sig) => verifySettlement(ctx, roundId, sig, sbValue(ctx, pinned)),
  };
}

/** The revealed Switchboard value, re-read after settlement. */
function sbValue(ctx: HandlerCtx, pinned: PublicKey): () => Promise<Uint8Array | null> {
  return async () => (await ctx.bridge.randomness(pinned))?.value ?? null;
}

/**
 * Randomness fallback — the entropy pipeline (design §2.2):
 *
 *   locked, unpinned, provider entropy, chain free → request_entropy
 *   awaiting, chain pending this round, target hashed → reveal_entropy
 *       + fulfill_settle in ONE tx (value and winner computed locally from
 *       the same SlotHashes rule the program applies); plain reveal after
 *       one failed combined send
 *   awaiting, value revealed for this round → fulfill_settle
 *   awaiting, no reveal for ~24 h → cancel_round (the long deadline)
 */
async function evalEntropy(
  ctx: HandlerCtx,
  config: GlobalConfigData,
  round: RoundData,
  clock: ChainClock,
): Promise<CrankAction | null> {
  const roundId = round.roundId;
  const keeper = ctx.keeper;
  const pinned = entropyChainKey();
  const chain = ctx.bridge.entropyChain ? await ctx.bridge.entropyChain() : null;
  if (chain === null) {
    ctx.logger.error({ roundId: roundId.toString() }, "entropy: chain account missing — set it with scripts/mainnet/entropy-chain.ts");
    return null;
  }

  if (round.state === "locked") {
    if (chain.pendingRound !== ENTROPY_NONE || chain.valueRound !== ENTROPY_NONE) return null; // previous round first
    if (chain.remaining === 0n) {
      ctx.logger.error({ roundId: roundId.toString() }, "entropy: chain exhausted — rotate it");
      return null;
    }
    return {
      kind: "request_entropy",
      roundId,
      label: `request_entropy r${roundId} (pin to chain, ${chain.remaining} seeds left)`,
      build: () => ctx.client.buildRequestEntropyTx(roundId, keeper.publicKey),
    };
  }

  if (chain.valueRound === roundId) {
    const value = Buffer.from(chain.value, "hex");
    const found = await findWinningEntry(ctx, config, round, value);
    if (found === null) return null;
    const winningEntry = found === "v2" ? undefined : found;
    return {
      kind: "fulfill_settle",
      sendAttempts: 3,
      roundId,
      label: `fulfill_settle r${roundId} (entropy, tip ${config.keeperTipLamports} lamports)`,
      build: () => ctx.client.buildFulfillSettleTx(roundId, pinned, keeper.publicKey, winningEntry),
      after: (sig) => verifySettlement(ctx, roundId, sig, async () => value),
    };
  }

  if (chain.pendingRound !== roundId) {
    ctx.book.quarantine(roundId, "entropy: round pinned to the chain but neither pending nor revealed");
    return null;
  }

  if (clock.slot > round.randomnessCommitSlot + ENTROPY_REVEAL_DEADLINE_SLOTS) {
    return {
      kind: "cancel_round",
      roundId,
      quarantineOnFailure: false,
      label: `cancel_round r${roundId} (entropy never revealed in 24 h; refunds follow)`,
      build: () => ctx.client.buildCancelRoundTx(roundId, pinned, keeper.publicKey),
    };
  }
  if (clock.slot <= chain.targetSlot) return null; // target not produced yet

  const seed = ctx.entropy?.seedFor(chain.commit, chain.remaining) ?? null;
  if (seed === null) {
    ctx.logger.error(
      { roundId: roundId.toString(), seedFile: ctx.cfg.entropySeedFile ?? null },
      "entropy: NO SEED for the on-chain commit — wrong or missing CRANK_ENTROPY_SEED_FILE; the round halts until fixed",
    );
    return null;
  }
  const sysvar = ctx.bridge.slotHashes ? await ctx.bridge.slotHashes() : null;
  const lookup = sysvar === null ? ({ kind: "malformed" } as const) : findSlotHash(sysvar, chain.targetSlot);
  if (lookup.kind === "expired") {
    ctx.logger.error(
      { roundId: roundId.toString(), target: chain.targetSlot.toString() },
      "entropy: target slot left SlotHashes — the round can only cancel at its 24 h deadline",
    );
    return null;
  }
  const buildReveal = () => ctx.client.buildRevealEntropyTx(roundId, seed, keeper.publicKey);
  if (lookup.kind === "found" && ctx.book.failureCount(`reveal_and_settle:${roundId}`) < REVEAL_AND_SETTLE_MAX_FAILURES) {
    const value = entropyValue(roundId, lookup.hash, seed);
    const found = await findWinningEntry(ctx, config, round, value);
    if (found !== null) {
      const winningEntry = found === "v2" ? undefined : found;
      return {
        kind: "reveal_and_settle",
        sendAttempts: 3,
        roundId,
        quarantineOnFailure: false,
        label: `reveal_and_settle r${roundId} (entropy, slot ${lookup.slot}, one tx)`,
        build: async () => {
          const settle = ctx.client.buildFulfillSettleTx(roundId, pinned, keeper.publicKey, winningEntry);
          return new Transaction().add(...buildReveal().instructions, ...settle.instructions);
        },
        after: (sig) => verifySettlement(ctx, roundId, sig, async () => value),
      };
    }
  }
  return {
    kind: "reveal_entropy",
    sendAttempts: 3,
    roundId,
    quarantineOnFailure: false,
    label: `reveal_entropy r${roundId}`,
    build: async () => buildReveal(),
  };
}

/**
 * Economics v3: settlement rakes only the losers' money, so it needs the
 * winning entry. The ticket is a pure function of the revealed value and
 * the pot (the same mirror verifySettlement checks against), so the crank
 * finds the entry before sending; the program re-verifies it. "v2" when
 * the config predates v3 (no entry needed); null when no entry holds the
 * ticket yet (retried next tick).
 */
async function findWinningEntry(
  ctx: HandlerCtx,
  config: GlobalConfigData,
  round: RoundData,
  value: Uint8Array,
): Promise<PublicKey | "v2" | null> {
  if (config.economicsVersion < 3) return "v2";
  const ticket = ticketFromEntropy(splitEntropy(value).ticket, round.totalLamports);
  const entries = await ctx.bridge.entries(round.roundId, round.entryCount);
  const winner = entries.find((e) => ticket >= e.ticketStart && ticket < e.ticketEnd);
  if (winner === undefined) {
    ctx.logger.error(
      { roundId: round.roundId.toString(), ticket: ticket.toString() },
      "v3 settle: no entry holds the winning ticket yet — retrying next tick",
    );
    return null;
  }
  return entryKey(round.roundId, winner.entryIndex);
}

function pinAction(ctx: HandlerCtx, roundId: bigint, randomness: PublicKey): CrankAction {
  const keeper = ctx.keeper;
  return {
    kind: "request_randomness",
    roundId,
    label: `request_randomness r${roundId} (pin)`,
    build: () => ctx.client.buildRequestRandomnessTx(roundId, randomness, keeper.publicKey),
  };
}

/**
 * Post-settle verification, ported from the devnet script: the round's
 * chain outcome must equal the `RoundSettled` event and the independent
 * entropy mirror. Public RPCs return raw inner instructions
 * (`programIdIndex` + base58 data) — both shapes handled. Non-fatal by
 * design: an alert screams, the settlement itself stands.
 */
async function verifySettlement(
  ctx: HandlerCtx,
  roundId: bigint,
  sig: string,
  readValue: () => Promise<Uint8Array | null>,
): Promise<void> {
  const settled = await readRound(ctx, roundId);
  const value = await readValue();
  if (settled === null || value === null) {
    ctx.logger.error({ roundId: roundId.toString(), sig }, "settle verification could not re-read state");
    return;
  }

  let event: ReturnType<typeof parseEventInstruction> = null;
  for (let attempt = 1; attempt <= 4 && event === null; attempt += 1) {
    const tx = await ctx.rpc.call("getTransaction", () =>
      ctx.rpc.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
    );
    if (tx !== null) {
      event = findRoundSettled(ctx, tx, sig);
      if (event !== null) break;
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  if (event === null || event.name !== "RoundSettled") {
    ctx.logger.error({ roundId: roundId.toString(), sig }, "RoundSettled event not found in settle tx");
    return;
  }

  const mirror = splitEntropy(value);
  const expectedTicket = ticketFromEntropy(mirror.ticket, settled.totalLamports);
  const chainTicket = settled.winningTicket;
  const eventTicket = event.data.winningTicket;
  const pass = chainTicket === eventTicket && chainTicket === expectedTicket;
  if (pass) {
    ctx.logger.info(
      {
        event: "settle_verified",
        roundId: roundId.toString(),
        sig,
        winningTicket: chainTicket.toString(),
        winner: settled.winner,
        winnerPayoutLamports: String(settled.winnerPayout),
        refundPoolLamports: String(settled.refundPool),
        adminCutLamports: String(settled.adminCut),
        megaCutLamports: String(settled.megaCut),
        megaTriggered: settled.megaTriggered,
        megaFieldPoolLamports: String(settled.megaFieldPool),
        entropy: Buffer.from(value).toString("hex"),
      },
      "settlement verified — chain ≡ event ≡ mirror",
    );
  } else {
    ctx.logger.error(
      {
        event: "settle_verification_failed",
        roundId: roundId.toString(),
        sig,
        chainTicket: chainTicket.toString(),
        eventTicket: eventTicket.toString(),
        mirrorTicket: expectedTicket.toString(),
      },
      "SETTLEMENT DIVERGENCE — chain ≠ event ≠ mirror",
    );
  }
}

function findRoundSettled(
  ctx: HandlerCtx,
  tx: NonNullable<Awaited<ReturnType<typeof ctx.rpc.connection.getTransaction>>>,
  sig: string,
): ReturnType<typeof parseEventInstruction> {
  const message = tx.transaction.message as { accountKeys?: unknown[] };
  const asKey = (k: unknown): string => {
    if (typeof k === "object" && k !== null && "pubkey" in k) {
      return String((k as { pubkey: unknown }).pubkey);
    }
    return String(k);
  };
  const accountKeys: string[] = (message.accountKeys ?? []).map(asKey);
  const loaded = tx.meta?.loadedAddresses;
  if (loaded !== undefined) {
    accountKeys.push(...loaded.writable.map(asKey), ...loaded.readonly.map(asKey));
  }
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const raw of group.instructions as Array<Record<string, unknown>>) {
      const programId =
        typeof raw.programId === "string"
          ? raw.programId
          : typeof raw.programIdIndex === "number"
            ? accountKeys[raw.programIdIndex]
            : undefined;
      const data = typeof raw.data === "string" ? raw.data : undefined;
      if (programId === undefined || data === undefined) continue;
      if (programId !== ctx.client.programId.toString()) continue;
      const parsed = parseEventInstruction(bs58.decode(data));
      if (parsed !== null && parsed.name === "RoundSettled") return parsed;
    }
  }
  void sig;
  return null;
}

async function readRound(ctx: HandlerCtx, roundId: bigint): Promise<RoundData | null> {
  const info = await ctx.rpc.call("getRound", () =>
    ctx.rpc.connection.getAccountInfo(roundKey(roundId), "confirmed"),
  );
  return info === null ? null : decodeRound(info.data);
}
