/**
 * Deposit submission with the roadmap 6.7 contention-retry contract.
 *
 * `buildDepositTx` derives the entry PDA from the round's current
 * `entry_count`; a concurrent deposit advances that counter between our
 * read and the send, and the chain rejects the stale index (the wrong-seed
 * PDA is unforgeable — by design). The contract: rebuild with a FRESH
 * index each attempt, and only retry when the counter verifiably moved
 * under us (re-read after failure); a failure with a stable counter is a
 * real error and surfaces immediately. At most 3 attempts.
 */

import { useCallback, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useOrbitClient } from "../context/OrbitClientProvider";
import { useRoundData } from "../context/RoundDataProvider";
import { useToast } from "../context/ToastProvider";
import { confirmSignature, shortSignature } from "../lib/tx";
import { formatSolCompact } from "../lib/format";

const MAX_ATTEMPTS = 3;

/**
 * AUDIT W-1: after a deposit's CONFIRMATION fails (its signature exists),
 * what the targeted entry PDA says. Only "taken" (someone else holds the
 * slot, so ours can never land) permits a retry; "unknown" never does.
 */
export function afterConfirmFailure(
  entryPlayer: string | null,
  me: string,
): "landed" | "taken" | "unknown" {
  if (entryPlayer === null) return "unknown";
  return entryPlayer === me ? "landed" : "taken";
}

export function useDeposit(): {
  deposit: (amountLamports: bigint) => Promise<boolean>;
  pending: boolean;
} {
  const { client } = useOrbitClient();
  const { state } = useRoundData();
  const { publicKey, connected, sendTransaction } = useWallet();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  // Synchronous lock: two clicks (or Enter + click) in the same frame both
  // pass a `pending` state check — the flag has not flushed yet. A deposit
  // already in flight OWNS the submission path until it fully settles.
  const inFlightRef = useRef(false);

  const deposit = useCallback(
    async (amountLamports: bigint): Promise<boolean> => {
      const round = state.round;
      if (inFlightRef.current) {
        return false; // a signature is already out — never double-deposit
      }
      if (!connected || publicKey === null || round === null || round.state !== "open") {
        return false;
      }
      inFlightRef.current = true;
      setPending(true);
      try {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          const index = await client.nextEntryIndex(round.roundId);
          const tx = await client.buildDepositTx(publicKey, round.roundId, amountLamports, index);
          // AUDIT W-1: sending and confirming fail for different reasons.
          // A send that throws never reached the network → the contention
          // retry below is safe. Once a signature EXISTS the deposit may
          // land however long confirmation takes: never auto-retry then.
          let signature: string;
          try {
            signature = await sendTransaction(tx, client.connection);
          } catch (err) {
            // Contention check: did entry_count advance past the index we used?
            const nowIndex = await client.nextEntryIndex(round.roundId).catch(() => index);
            if (nowIndex > index) {
              toast.push(
                "warning",
                `another player grabbed entry #${index} — retrying (${attempt}/${MAX_ATTEMPTS})`,
              );
              continue;
            }
            throw err;
          }
          toast.push("info", "deposit sent — confirming…", shortSignature(signature));
          try {
            await confirmSignature(client.connection, signature);
          } catch (err) {
            // The confirmation timed out or errored — read the entry PDA we
            // targeted to learn what actually happened.
            const landed = await client.fetchEntry(round.roundId, index).catch(() => null);
            const verdict = afterConfirmFailure(landed?.player ?? null, publicKey.toBase58());
            if (verdict === "landed") {
              toast.push("success", `deposited ${formatSolCompact(amountLamports)} SOL`, shortSignature(signature));
              return true;
            }
            if (verdict === "taken") {
              // Someone else holds the slot: our transaction cannot land.
              toast.push(
                "warning",
                `another player grabbed entry #${index} — retrying (${attempt}/${MAX_ATTEMPTS})`,
              );
              continue;
            }
            // Unknown: it may still land. Never send a second deposit blind.
            throw new Error(
              `couldn't confirm deposit ${shortSignature(signature)} yet — check your entries before trying again (${
                err instanceof Error ? err.message.slice(0, 80) : String(err)
              })`,
            );
          }
          toast.push(
            "success",
            `deposited ${formatSolCompact(amountLamports)} SOL`,
            shortSignature(signature),
          );
          return true;
        }
        throw new Error(`deposit failed after ${MAX_ATTEMPTS} contention retries`);
      } catch (err) {
        toast.push(
          "error",
          "deposit failed",
          err instanceof Error ? err.message.slice(0, 160) : String(err),
        );
        return false;
      } finally {
        inFlightRef.current = false;
        setPending(false);
      }
    },
    [client, connected, publicKey, sendTransaction, state.round, toast],
  );

  return { deposit, pending };
}
