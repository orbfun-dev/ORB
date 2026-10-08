/**
 * Permissionless refund delivery for SETTLED rounds (Phase 11.9): every
 * entry's `close_entry` pays its pro-rata share of the 89% refund pool
 * (+ the Mega field share on a trigger) plus the reclaimed entry rent to
 * `entry.player` — the wallet for direct deposits, the escrow for
 * auto-play. The keeper batches the same instruction; this hook is the
 * player's own trigger when they don't want to wait for the crank —
 * never a dead-end spinner.
 *
 * The click is ONE batch, not a signing marathon: targets across every
 * rolled-over round pack into single transactions of
 * CLOSE_ENTRY_MAX_PER_TX instructions each (the chain's packet ceiling),
 * so the wallet pops up once per chunk — for the typical handful of
 * entries, once, period. The winning entry is refused on-chain until its
 * prize is claimed (or swept), so the caller filters it.
 */

import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { CLOSE_ENTRY_MAX_PER_TX } from "@orbit-jackpot/sdk";
import { useOrbitClient } from "../context/OrbitClientProvider";
import { useToast } from "../context/ToastProvider";
import { confirmSignature, shortSignature } from "../lib/tx";

/** One closable entry — the round id is a PARAMETER, not the live round:
 * refund rows outlive rollovers, and one batch usually spans many. */
export interface CloseTarget {
  roundId: bigint;
  entryIndex: number;
  /** The entry's true owner (wallet or escrow PDA) — the payout destination. */
  player: string;
}

function chunk<T>(items: readonly T[], width: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += width) out.push(items.slice(i, i + width));
  return out;
}

export function useCloseEntry(): {
  closeAll: (targets: readonly CloseTarget[]) => Promise<string | null>;
  pending: boolean;
} {
  const { client } = useOrbitClient();
  const { publicKey, connected, sendTransaction } = useWallet();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  /**
   * Claims every target. Returns the last confirmed signature, or null
   * when nothing landed (caller decides the messaging). Stops at the
   * first failed chunk — the rest remain claimable.
   */
  const closeAll = useCallback(
    async (targets: readonly CloseTarget[]): Promise<string | null> => {
      if (!connected || publicKey === null) {
        toast.push("warning", "connect a signing wallet to claim your refund");
        return null;
      }
      if (targets.length === 0) return null;
      setPending(true);
      let lastSignature: string | null = null;
      try {
        for (const part of chunk(targets, CLOSE_ENTRY_MAX_PER_TX)) {
          try {
            // Permissionless: the wallet signs as fee payer; each payout
            // goes to its entry.player (enforced on-chain), never the signer.
            const tx = client.buildCloseEntriesTx(
              part.map((t) => ({
                roundId: t.roundId,
                entryIndex: t.entryIndex,
                player: new PublicKey(t.player),
              })),
              publicKey,
            );
            const signature = await sendTransaction(tx, client.connection);
            toast.push(
              "info",
              `refund claim sent (${part.length} ${
                part.length === 1 ? "entry" : "entries"
              }) — confirming…`,
              shortSignature(signature),
            );
            await confirmSignature(client.connection, signature);
            lastSignature = signature;
          } catch (err) {
            toast.push(
              "error",
              "refund claim failed — the rest stays claimable",
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
    [client, connected, publicKey, sendTransaction, toast],
  );

  return { closeAll, pending };
}
