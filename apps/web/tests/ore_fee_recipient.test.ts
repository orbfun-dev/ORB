/**
 * The fee-recipient bootstrap read (live 2026-10-07 incident #2).
 *
 * A bundled `SystemProgram.transfer` to a system account that does not
 * exist must CREATE it, and creation requires the transfer to cover the
 * 650 240-lamport rent-exempt minimum. The platform-fee treasury was
 * generated at launch but never funded, so every deploy whose 1% fee sat
 * at the 100 000-lamport floor died pre-sign with
 * `{"InsufficientFundsForRent":{"account_index":1}}` — index 1 of the
 * TRANSFER, i.e. the recipient, which read as the wallet's own rent floor
 * and cost an evening to disambiguate.
 *
 * These tests pin the read that makes the condition nameable: the
 * recipient rides in the SAME batched `getMultipleAccountsInfo` (no extra
 * round trip), its absence is NOT fatal to the snapshot, and the planner
 * turns it into a blocker rather than leaking the simulation error.
 *
 * client.ts imports config.ts, which throws at module load when
 * VITE_ORE_FEE_RECIPIENT is unset — stubbed before the dynamic import,
 * same pattern as ore_golden.test.ts.
 */

import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";

const FEE_RECIPIENT = Keypair.fromSeed(new Uint8Array(32).fill(23)).publicKey;
vi.stubEnv("VITE_ORE_FEE_RECIPIENT", FEE_RECIPIENT.toBase58());

const { OreClient } = await import("../src/features/ore-lite/client");
const { ORE_ACCOUNT_SIZES, ORE_DISCRIMINANTS } = await import("../src/features/ore-lite/codec");
const { BOARD_ADDRESS, CONFIG_ADDRESS, TREASURY_ADDRESS, PLATFORM_FEE } = await import(
  "../src/features/ore-lite/config"
);

function alloc(size: number, discriminator: number): Buffer {
  const buf = Buffer.alloc(size);
  buf.writeBigUInt64LE(BigInt(discriminator), 0);
  return buf;
}

function boardFixture(): Buffer {
  const buf = alloc(ORE_ACCOUNT_SIZES.board, ORE_DISCRIMINANTS.Board);
  buf.writeBigUInt64LE(454_137n, 8); // round_id
  buf.writeBigUInt64LE(454_100_000n, 16); // start_slot
  buf.writeBigUInt64LE(454_100_240n, 24); // end_slot
  return buf;
}

function configFixture(): Buffer {
  return alloc(ORE_ACCOUNT_SIZES.config, ORE_DISCRIMINANTS.Config);
}

function treasuryFixture(): Buffer {
  return alloc(ORE_ACCOUNT_SIZES.treasury, ORE_DISCRIMINANTS.Treasury);
}

/** The shape fetchSnapshot reads: only `.data` and null-ness matter. */
function info(data: Buffer) {
  return { data, executable: false, lamports: 1n, owner: PublicKey.default, rentEpoch: 0 };
}

/** Records every address batched, so "one round trip" is a real assertion. */
function fakeConnection(opts: { feeRecipientFunded: boolean }) {
  const batches: PublicKey[][] = [];
  let singleReads = 0;
  const connection = {
    getSlot: async () => 454_100_100,
    getMultipleAccountsInfo: async (addresses: PublicKey[]) => {
      batches.push(addresses);
      return addresses.map((address) => {
        if (address.equals(BOARD_ADDRESS)) return info(boardFixture());
        if (address.equals(CONFIG_ADDRESS)) return info(configFixture());
        if (address.equals(TREASURY_ADDRESS)) return info(treasuryFixture());
        if (address.equals(FEE_RECIPIENT)) {
          // A funded system account holds zero data bytes — existence is
          // the whole signal. getAccountInfo returned literal `null` for
          // 7HQzM3eP…4Dsr on mainnet, which is the bug being pinned.
          return opts.feeRecipientFunded ? info(Buffer.alloc(0)) : null;
        }
        return null; // miner / automation: wallet has never deployed
      });
    },
    getAccountInfo: async () => {
      singleReads += 1;
      return null; // round PDA — absent right after a reset
    },
  };
  return {
    client: new OreClient(connection as unknown as Connection),
    batches,
    singleReads: () => singleReads,
  };
}

describe("fetchSnapshot reads the fee recipient alongside the protocol accounts", () => {
  it("batches the recipient with Board/Config/Treasury — no extra round trip", async () => {
    const { client, batches, singleReads } = fakeConnection({ feeRecipientFunded: true });
    const snapshot = await client.fetchSnapshot(null);

    expect(batches).toHaveLength(1);
    expect(batches[0].map((a) => a.toBase58())).toEqual([
      BOARD_ADDRESS.toBase58(),
      CONFIG_ADDRESS.toBase58(),
      TREASURY_ADDRESS.toBase58(),
      FEE_RECIPIENT.toBase58(),
    ]);
    // Only the round PDA is read on its own, exactly as before the change.
    expect(singleReads()).toBe(1);
    expect(snapshot.feeRecipientExists).toBe(true);
  });

  it("an unfunded recipient is reported, not thrown — it is a bootstrap state", async () => {
    // Board/Config/Treasury missing means "wrong cluster" and throws. A
    // missing fee recipient means "nobody has funded it yet" and must flow
    // through to the planner instead of breaking the whole page.
    const { client } = fakeConnection({ feeRecipientFunded: false });
    const snapshot = await client.fetchSnapshot(null);
    expect(snapshot.feeRecipientExists).toBe(false);
    expect(snapshot.board.roundId).toBe(454_137n);
  });

  it("the snapshot flag drives the planner blocker end to end", async () => {
    const { planDeploy } = await import("../src/features/ore-lite/planner");
    const { client } = fakeConnection({ feeRecipientFunded: false });
    const snapshot = await client.fetchSnapshot(null);

    const plan = planDeploy({
      board: snapshot.board,
      miner: null,
      currentSlot: snapshot.slot,
      requestedTotalLamports: 10_000_000n, // the live 0.010 SOL deploy
      walletBalanceLamports: 1_000_000_000n, // plenty — this is not a balance bug
      feeRecipientExists: snapshot.feeRecipientExists,
      fee: PLATFORM_FEE,
      networkFeeLamports: 155_000n,
    });

    expect(plan.platformFee).toBe(100_000n);
    expect(plan.blocker).toBe("fee-recipient-uninitialized");
  });
});
