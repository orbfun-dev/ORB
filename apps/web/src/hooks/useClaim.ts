/**
 * Claim submission. `buildClaimTx` is permissionless (the wallet signs as
 * its own payer; the program enforces that the payout lands on
 * `entry.player`) — the UI gates on the integer winner lookup, the chain
 * remains the authority. The claim targets a ROUND ID, not "the active
 * round": the banner lives across rollovers for the whole 30-day window.
 */

import { useCallback, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useOrbitClient } from "../context/OrbitClientProvider";
import { useToast } from "../context/ToastProvider";
import { confirmSignature, shortSignature } from "../lib/tx";
import { formatLamports } from "../lib/format";

/** What the banner knows about the round it is claiming. */
export interface ClaimTarget {
  roundId: bigint;
  entryIndex: number;
  winnerPayout: bigint;
  megaAwarded: bigint;
}

export function useClaim(): {
  claim: (target: ClaimTarget) => Promise<boolean>;
  pending: boolean;
} {
  const { client } = useOrbitClient();
  const { publicKey, connected, sendTransaction } = useWallet();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  const claim = useCallback(
    async (target: ClaimTarget): Promise<boolean> => {
      if (!connected || publicKey === null) {
        toast.push("warning", "connect a signing wallet to claim");
        return false;
      }
      setPending(true);
      try {
        const tx = client.buildClaimTx(publicKey, target.roundId, target.entryIndex);
        const signature = await sendTransaction(tx, client.connection);
        toast.push("info", "claim sent — confirming…", shortSignature(signature));
        await confirmSignature(client.connection, signature);
        toast.push(
          "success",
          `prize claimed: ${formatLamports(target.winnerPayout + target.megaAwarded)} SOL`,
          shortSignature(signature),
        );
        return true;
      } catch (err) {
        toast.push(
          "error",
          "claim failed",
          err instanceof Error ? err.message.slice(0, 160) : String(err),
        );
        return false;
      } finally {
        setPending(false);
      }
    },
    [client, publicKey, connected, sendTransaction, toast],
  );

  return { claim, pending };
}
