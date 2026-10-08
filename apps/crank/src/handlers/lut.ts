/**
 * Phase 13 — the lookup-table sweep.
 *
 * `close_randomness` closes a round's randomness account and escrow but can
 * only DEACTIVATE its address lookup table: a table must age past the
 * SlotHashes window (512 slots, ~3.5 min) before the ALT program will
 * close it. By then the round is long gone, so the table is reclaimed here
 * instead, with Switchboard's `randomness_close_lut` signed by the
 * randomness KEYPAIR this crank persisted at create time. ≈0.0014 SOL each
 * comes back to the keeper.
 *
 * The pending list lives in state.json (written by the cleanup handler
 * right before `close_randomness`), because the LUT's address derives from
 * `lut_slot`, which only the now-closed randomness account recorded.
 */

import type { GlobalConfigData } from "@orbit-jackpot/sdk";
import { PublicKey, Transaction } from "@solana/web3.js";
import type { CrankAction } from "../actions";
import type { HandlerCtx } from "../context";
import type { ChainClock } from "../rpc";
import { closeLutInstruction, lutKeys } from "../randomness";
import { CLOSE_RANDOMNESS_MAX_FAILURES } from "./cleanup";

/** The ALT program closes a table once its deactivation slot has left
 *  SlotHashes (512 ENTRIES). With skipped slots those 512 entries span
 *  more than 512 slot numbers, so a 513-slot margin failed preflight
 *  under normal mainnet conditions (AUDIT C-6). */
export const LUT_COOLDOWN_SLOTS = 700n;
const U64_MAX = 18_446_744_073_709_551_615n;
const CLOSE_LUT_MAX_FAILURES = 3;

export async function evalLutSweep(
  ctx: HandlerCtx,
  config: GlobalConfigData,
  clock: ChainClock,
): Promise<CrankAction | null> {
  if (!ctx.cfg.cleanupEnabled) return null;
  const oracleProgram = new PublicKey(config.oracleProgramId);

  for (const pending of ctx.book.pendingLuts()) {
    const id = pending.roundId;
    if (ctx.book.failureCount(`close_randomness_lut:${id}`) >= CLOSE_LUT_MAX_FAILURES) {
      ctx.logger.warn({ roundId: id.toString() }, "LUT close keeps failing — dropping it from the sweep");
      ctx.book.forgetLut(id);
      continue;
    }
    const randomness = new PublicKey(pending.randomness);
    const { lut } = lutKeys(oracleProgram, randomness, pending.lutSlot);
    const table = await ctx.bridge.lookupTable(lut);
    if (table === null) {
      ctx.book.forgetLut(id); // already closed
      continue;
    }
    if (table.deactivationSlot === U64_MAX) {
      // Not deactivated: close_randomness has not landed. After repeated
      // failures stop polling it (C-11); the next close_randomness attempt
      // re-registers the table before it sends.
      if (ctx.book.failureCount(`close_randomness:${id}`) >= CLOSE_RANDOMNESS_MAX_FAILURES) {
        ctx.book.forgetLut(id);
      }
      continue;
    }
    if (clock.slot <= table.deactivationSlot + LUT_COOLDOWN_SLOTS) continue; // cooling down

    const kp = ctx.book.randomnessKeypair(id);
    if (!kp.publicKey.equals(randomness)) {
      ctx.logger.error(
        { roundId: id.toString(), expected: pending.randomness, found: kp.publicKey.toBase58() },
        "persisted randomness keypair does not match the pending LUT — dropping it",
      );
      ctx.book.forgetLut(id);
      continue;
    }
    const keeper = ctx.keeper.publicKey;
    return {
      kind: "close_randomness_lut",
      roundId: id,
      quarantineOnFailure: false,
      extraSigners: [kp],
      label: `close_randomness_lut r${id} (lookup-table rent → keeper)`,
      build: () => new Transaction().add(closeLutInstruction(oracleProgram, randomness, pending.lutSlot, keeper)),
      after: async () => ctx.book.forgetLut(id),
    };
  }
  return null;
}
