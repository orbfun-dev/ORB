/**
 * Refund submission for cancelled rounds — permissionless crank per entry
 * (`refund_entry`, wallet signs as its own payer). The card drives ONE
 * batched claim: entries pack into transactions of
 * CLOSE_ENTRY_MAX_PER_TX instructions (the chain's packet ceiling), so
 * the wallet signs once per chunk, and a failed chunk leaves the rest
 * claimable.
 *
 * Each entry carries its OWN `player` (wallet or escrow PDA): the
 * on-chain context pins the destination to `entry.player`, so passing
 * the signer for an auto-play entry would be rejected.
 *
 * Targets also carry their own `roundId`. They used to be implicitly the
 * CURRENT round's, which was fine only while the card could not show a
 * cancelled round that had already rolled over — now that the cancelled
 * book outlives the rollover, one click can span several rounds, and
 * `refund_entry`'s accounts are per-round. Targets are grouped by round
 * and chunked within each.
 */

import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { CLOSE_ENTRY_MAX_PER_TX } from "@orbit-jackpot/sdk";
import { useOrbitClient } from "../context/OrbitClientProvider";
import { useToast } from "../context/ToastProvider";
import { confirmSignature, shortSignature } from "../lib/tx";

function chunk<T>(items: readonly T[], width: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += width) out.push(items.slice(i, i + width));
  return out;
}

/** One `refund_entry` target — its round, its index, its destination. */
export interface RefundTarget {
  roundId: bigint;
  entryIndex: number;
  player: string;
}

export function useRefund(): {
  refundAll: (targets: ReadonlyArray<RefundTarget>) => Promise<string | null>;
  pending: boolean;
} {
  const { client } = useOrbitClient();
  const { publicKey, connected, sendTransaction } = useWallet();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  /**
   * Refunds every target, across however many cancelled rounds they span.
   * Returns the last confirmed signature, or null when nothing landed.
   * Stops at the first failed chunk — the rest remain claimable.
   */
  const refundAll = useCallback(
    async (targets: ReadonlyArray<RefundTarget>): Promise<string | null> => {
      if (!connected || publicKey === null) {
        toast.push("warning", "connect a signing wallet to refund");
        return null;
      }
      if (targets.length === 0) return null;
      setPending(true);
      let lastSignature: string | null = null;
      try {
        const byRound = new Map<bigint, RefundTarget[]>();
        for (const t of targets) {
          const bucket = byRound.get(t.roundId);
          if (bucket === undefined) byRound.set(t.roundId, [t]);
          else bucket.push(t);
        }
        const parts = [...byRound].flatMap(([roundId, group]) =>
          chunk(group, CLOSE_ENTRY_MAX_PER_TX).map((part) => ({ roundId, part })),
        );
        for (const { roundId, part } of parts) {
          try {
            const tx = client.buildRefundsTx(
              roundId,
              part.map((t) => ({ entryIndex: t.entryIndex, player: new PublicKey(t.player) })),
              publicKey,
            );
            const signature = await sendTransaction(tx, client.connection);
            toast.push(
              "info",
              `refund sent (${part.length} ${part.length === 1 ? "entry" : "entries"}) — confirming…`,
              shortSignature(signature),
            );
            await confirmSignature(client.connection, signature);
            lastSignature = signature;
          } catch (err) {
            toast.push(
              "error",
              "refund failed — the rest stays claimable",
              err instanceof Error ? err.message.slice(0, 160) : String(err),
            );
            break;
          }
        }
        return lastSignature;
      } finally {
        setPending(false);
      }
    },
    [client, publicKey, connected, sendTransaction, toast],
  );

  return { refundAll, pending };
}
