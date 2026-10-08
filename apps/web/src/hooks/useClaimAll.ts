/**
 * The single combined claim: every unclaimed prize, every refund those
 * prizes unlock, and the sweep that carries escrow-destined proceeds to
 * the player's own address — one transaction, one signature.
 *
 * Two SDK details this has to get right, both of which were wrong in the
 * per-row claim it replaces:
 *
 *  - `buildClaimTx(player, …)` puts `player` in the payout slot AND, when
 *    the client carries no `payer`, in the SIGNER slot. An auto-played
 *    entry's `entry.player` is the escrow PDA, which cannot sign — so the
 *    claim must be built from a payer-bound client, with the escrow as
 *    the destination and the wallet as the signer. Building it with the
 *    wallet in the destination slot instead (what `useClaim` did) is
 *    rejected outright by claim_winnings.rs:60.
 *  - ordering is load-bearing: `close_entry` refuses the winning entry
 *    until `prize_claimed`, so every prize claim must precede the closes.
 *
 * Transaction size is measured, not guessed: rounds are packed whole into
 * as many transactions as they need (`packClaimBatches`), and the wallet
 * approves them ALL in one prompt (`signAllTransactions`). Before this,
 * the first round that overflowed the ~1232-byte packet stopped the batch,
 * so a click claimed only ~2 rounds — about 0.16 SOL at 0.1 SOL stakes.
 */

import { useCallback, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { OrbitJackpotClient, PROGRAM_ID } from "@orbit-jackpot/sdk";
import { useOrbitClient } from "../context/OrbitClientProvider";
import { useToast } from "../context/ToastProvider";
import { confirmSignature, shortSignature } from "../lib/tx";
import { formatSolCompact } from "../lib/format";
import { packClaimBatches, type ClaimAllPlan, type ClaimStep } from "../lib/claimAll";

/**
 * Message-size budget. A legacy transaction is 1232 bytes including the
 * signature section; one signature is 64 bytes plus the 1-byte count, so
 * the message itself must stay well under that. The margin absorbs the
 * blockhash the adapter substitutes at send.
 */
const MAX_MESSAGE_BYTES = 1_100;
const SIZING_BLOCKHASH = "11111111111111111111111111111111";

/** Instructions grouped per round, so a round is never half-sent. */
function groupByRound(plan: ClaimAllPlan): Map<string, { prizes: ClaimStep[]; refunds: ClaimStep[] }> {
  const byRound = new Map<string, { prizes: ClaimStep[]; refunds: ClaimStep[] }>();
  const slot = (roundId: bigint) => {
    const key = roundId.toString();
    let found = byRound.get(key);
    if (found === undefined) {
      found = { prizes: [], refunds: [] };
      byRound.set(key, found);
    }
    return found;
  };
  for (const p of plan.prizes) slot(p.roundId).prizes.push(p);
  for (const r of plan.refunds) slot(r.roundId).refunds.push(r);
  return byRound;
}

function messageBytes(tx: Transaction, feePayer: PublicKey): number {
  const probe = new Transaction();
  probe.add(...tx.instructions);
  probe.feePayer = feePayer;
  probe.recentBlockhash = SIZING_BLOCKHASH;
  return probe.serializeMessage().length;
}

export function useClaimAll(): {
  /** Returns the number of rounds actually sent (0 = nothing went out). */
  claimAll: (plan: ClaimAllPlan, escrow: PublicKey | null) => Promise<number>;
  pending: boolean;
} {
  const { client } = useOrbitClient();
  const { publicKey, connected, sendTransaction, signAllTransactions } = useWallet();
  const toast = useToast();
  const [pending, setPending] = useState(false);

  // A payer-bound twin of the app client: same connection and program,
  // but every built instruction signs as the WALLET even when the payout
  // destination is the escrow PDA.
  const payerClient = useMemo(
    () =>
      publicKey === null
        ? null
        : new OrbitJackpotClient(client.connection, undefined, PROGRAM_ID, publicKey),
    [client, publicKey],
  );

  const claimAll = useCallback(
    async (plan: ClaimAllPlan, escrow: PublicKey | null): Promise<number> => {
      if (!connected || publicKey === null || payerClient === null) {
        toast.push("warning", "connect a signing wallet to claim");
        return 0;
      }
      if (plan.prizes.length === 0 && plan.refunds.length === 0) return 0;

      const escrowKey = escrow?.toString() ?? null;
      const groups = [...groupByRound(plan)];
      const rounds = groups.map(([key, group]) => ({
        key,
        instructions: [
          // Prizes first — they are what unlocks the closes below.
          ...group.prizes.flatMap(
            (p) =>
              payerClient.buildClaimTx(new PublicKey(p.player), p.roundId, p.entryIndex).instructions,
          ),
          ...group.refunds.flatMap(
            (r) =>
              client.buildCloseEntryTx(new PublicKey(r.player), r.roundId, r.entryIndex, publicKey)
                .instructions,
          ),
        ],
      }));
      const fits = (ixs: TransactionInstruction[]): boolean =>
        messageBytes(new Transaction().add(...ixs), publicKey) <= MAX_MESSAGE_BYTES;
      const { batches, oversized } = packClaimBatches(rounds, fits);
      if (batches.length === 0) {
        toast.push("error", "claim too large for one transaction");
        return 0;
      }

      // Refund shares each batch credits the escrow, with the chain's own
      // integer math. The sweep that carries them to the wallet rides in
      // the same transaction when it fits; whatever does not fit goes out
      // in one last sweep-only transaction, after the credits have landed
      // (`withdraw_escrow` requires `spendable >= amount` and does not
      // clamp). The prize and reclaimed entry rent stay behind as margin.
      const creditOf = new Map<string, bigint>();
      for (const [key, group] of groups) {
        let credit = 0n;
        for (const r of group.refunds) {
          if (escrowKey !== null && r.player === escrowKey) credit += r.lamports;
        }
        creditOf.set(key, credit);
      }
      let unswept = 0n;
      let swept = 0n;
      const txs: Transaction[] = [];
      for (const batch of batches) {
        const credit = batch.keys.reduce((sum, k) => sum + (creditOf.get(k) ?? 0n), 0n);
        const tx = new Transaction().add(...batch.instructions);
        if (credit > 0n) {
          const sweep = client.buildWithdrawEscrowTx(publicKey, credit).instructions;
          if (fits([...batch.instructions, ...sweep])) {
            tx.add(...sweep);
            swept += credit;
          } else {
            unswept += credit;
          }
        }
        txs.push(tx);
      }
      if (unswept > 0n) {
        txs.push(new Transaction().add(...client.buildWithdrawEscrowTx(publicKey, unswept).instructions));
        swept += unswept;
      }
      const roundsIncluded = batches.reduce((n, b) => n + b.keys.length, 0);

      setPending(true);
      let landed = 0;
      try {
        // ONE wallet approval for every transaction, when the wallet can
        // sign a batch; otherwise one prompt per transaction.
        let send: (tx: Transaction, i: number) => Promise<string>;
        if (signAllTransactions !== undefined) {
          const { blockhash } = await client.connection.getLatestBlockhash("confirmed");
          for (const tx of txs) {
            tx.feePayer = publicKey;
            tx.recentBlockhash = blockhash;
          }
          const signed = await signAllTransactions(txs);
          send = (_tx, i) =>
            client.connection.sendRawTransaction(signed[i]!.serialize(), { maxRetries: 5 });
        } else {
          send = (tx) => sendTransaction(tx, client.connection);
        }
        // In order, each confirmed before the next: the trailing sweep
        // spends credits the earlier transactions put in the escrow.
        for (let i = 0; i < txs.length; i += 1) {
          const signature = await send(txs[i]!, i);
          toast.push(
            "info",
            txs.length > 1 ? `claim ${i + 1}/${txs.length} sent — confirming…` : "claim sent — confirming…",
            shortSignature(signature),
          );
          await confirmSignature(client.connection, signature);
          landed += 1;
        }
        toast.push(
          "success",
          swept > 0n
            ? `claimed ${roundsIncluded} round${roundsIncluded === 1 ? "" : "s"} — ${formatSolCompact(swept)} SOL sent to your wallet`
            : `claimed ${roundsIncluded} round${roundsIncluded === 1 ? "" : "s"}`,
        );
        if (oversized.length > 0) {
          toast.push("warning", `${oversized.length} round(s) too large to claim here — claim them one at a time`);
        }
        return roundsIncluded;
      } catch (err) {
        toast.push(
          "error",
          landed > 0 ? `claim stopped after ${landed} of ${txs.length} transactions` : "claim failed",
          err instanceof Error ? err.message.slice(0, 160) : String(err),
        );
        return 0;
      } finally {
        setPending(false);
      }
    },
    [client, connected, payerClient, publicKey, sendTransaction, signAllTransactions, toast],
  );

  return { claimAll, pending };
}
