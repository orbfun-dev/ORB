/**
 * Test doubles wiring the raffle orchestration to the REAL local
 * Postgres SQL (raffle_submit_earned_event etc.), so endpoint gates run
 * the shipping database functions. All parameters bound.
 */

import type { Pool } from "pg";
import type { ClaimStore } from "../../src/endpoints/claim";
import type { PurchaseStore } from "../../src/endpoints/purchase";
import bs58 from "bs58";
import { ORE_FEE_DEFAULTS, type RaffleConfig } from "../../src/env";

/** A fixed, valid base58 pubkey standing in for playorb's fee wallet. */
export const FEE_RECIPIENT = bs58.encode(
  Buffer.concat([Buffer.from("PlayorbFeeRecipient"), Buffer.alloc(13)]),
);

/**
 * An endpoint response with the body typed loose for assertions.
 *
 * `JsonResponse.payload` is `unknown` in src/http.ts on purpose — the
 * server never introspects a body it is about to serialize — so the
 * cast belongs here, at the test boundary, and not in a production type
 * widened to suit the tests.
 */
export interface ServedResponse {
  status: number;
  payload: any;
}

export function testConfig(): RaffleConfig {
  return {
    supabaseUrl: "https://test.supabase.co",
    supabaseServiceRoleKey: "test-service-role-key",
    solanaRpcUrl: "https://api.mainnet-beta.solana.com",
    raffleTreasuryPubkey: "Treasury111111111111111111111111111111111111",
    cronSecret: "test-cron-secret",
    oreFeeRecipient: FEE_RECIPIENT,
    ...ORE_FEE_DEFAULTS,
    lamportsPerEntry: 1_000_000_000,
    entryPriceLamports: 50_000_000,
    referralMinLamports: 1_000_000_000,
    referralCapPerEpoch: 25,
    purchaseCapPerWallet: 25,
    purchaseCapShareBps: 3_000,
    epochCap: 1_000,
    epochDurationDays: 7,
  };
}

export function pgClaimStore(pool: Pool): ClaimStore & PurchaseStore {
  return {
    async currentOpenEpoch() {
      const res = await pool.query(
        "SELECT id, cap, starts_at FROM raffle_epochs WHERE status = 'open' ORDER BY id DESC LIMIT 1",
      );
      const row = res.rows[0];
      return row
        ? { id: Number(row.id), cap: Number(row.cap), startsAt: new Date(row.starts_at).toISOString() }
        : null;
    },
    async getOrbRound(roundId: number) {
      const res = await pool.query(
        "SELECT round_id, state, reason FROM raffle_orb_rounds WHERE round_id = $1",
        [roundId],
      );
      const row = res.rows[0];
      return row
        ? { roundId: Number(row.round_id), state: row.state, reason: row.reason ?? null }
        : null;
    },
    async entriesForSignature(signature: string, wallet?: string) {
      const ev = await pool.query(
        "SELECT id FROM raffle_events WHERE signature = $1 AND source = 'purchase' AND ($2::TEXT IS NULL OR wallet = $2)",
        [signature, wallet ?? null],
      );
      if (ev.rows[0] === undefined) return null;
      const n = await pool.query(
        "SELECT count(*)::INT AS n FROM raffle_entries WHERE origin_event = $1",
        [ev.rows[0].id],
      );
      return Number(n.rows[0].n);
    },
    async submitEarnedEvent(args) {
      const res = await pool.query(
        `SELECT raffle_submit_earned_event(
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) AS grant`,
        [
          args.signature,
          args.eventIndex,
          args.slot,
          args.blockTime,
          args.source,
          args.wallet,
          args.epochId,
          args.solLamports,
          args.lamportsPerEntry,
          args.orbRoundId ?? null,
          args.status ?? "accepted",
          args.rejectReason ?? null,
          args.entryStatus ?? "confirmed",
        ],
      );
      return Number(res.rows[0].grant);
    },
  };
}
