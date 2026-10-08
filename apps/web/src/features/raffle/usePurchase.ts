/**
 * Buying entries: one SystemProgram.transfer to the raffle treasury on
 * MAINNET, then a report to /api/raffle/purchase until it is credited.
 *
 * The report is the load-bearing step. The server never scans the
 * treasury — it awards a purchase only when the page posts the signature
 * — so a paid transfer whose report never lands would be SOL for
 * nothing. Hence:
 *
 *  · the signature is written to localStorage the moment the transfer
 *    is sent (before it is confirmed), and every pending one is
 *    re-reported on load. A closed tab, a reload or a dropped
 *    connection only delays the credit;
 *  · reporting repeats while the server answers `pending` (it waits for
 *    finalized commitment, ~15–30 s after confirmed). The endpoint is
 *    idempotent per signature, so a repeat never double-awards;
 *  · a pending record is dropped only on an answer that can never
 *    change: credited, refused, or the transfer itself failed/expired.
 *
 * The app's connection is DEVNET (the wheel). The raffle is mainnet-only,
 * so this module owns a mainnet connection of its own.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { fetchRaffleStatus, submitPurchase, type PurchaseTerms } from "./api";
import { buyLimit, purchaseLamports } from "./purchasePlan";

/** Same mainnet endpoint as the ORE tab (a production-only env var). */
const MAINNET_RPC_URL =
  (import.meta.env.VITE_ORE_RPC_URL as string | undefined)?.trim() ||
  "https://api.mainnet-beta.solana.com";

const REPORT_EVERY_MS = 4_000;
/** Network fee headroom when checking the balance (a transfer costs 5000). */
const FEE_HEADROOM_LAMPORTS = 10_000n;
/** A blockhash lives ~60–90 s; an unseen signature older than this never lands. */
const UNSEEN_EXPIRY_MS = 3 * 60_000;

const STORAGE_KEY = "orb.raffle.pendingPurchases.v1";

interface PendingPurchase {
  signature: string;
  wallet: string;
  count: number;
  sentAt: number;
}

function readPending(): PendingPurchase[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingPurchase[]) : [];
  } catch {
    return [];
  }
}

function writePending(list: PendingPurchase[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Private mode / blocked storage: the live poll below still credits
    // the purchase as long as the tab stays open.
  }
}

function addPending(p: PendingPurchase): void {
  writePending([...readPending().filter((x) => x.signature !== p.signature), p]);
}

function dropPending(signature: string): void {
  writePending(readPending().filter((x) => x.signature !== signature));
}

export type PurchasePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "signing" }
  | { kind: "confirming"; signature: string }
  | { kind: "crediting"; signature: string; count: number }
  | { kind: "done"; signature: string; awarded: number; count: number }
  | { kind: "failed"; message: string; signature?: string };

export function usePurchase(terms: PurchaseTerms | undefined, onCredited: () => void) {
  const { publicKey, signTransaction, sendTransaction } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const connection = useMemo(() => new Connection(MAINNET_RPC_URL, "confirmed"), []);
  const [phase, setPhase] = useState<PurchasePhase>({ kind: "idle" });
  const onCreditedRef = useRef(onCredited);
  onCreditedRef.current = onCredited;
  // Reporting stops when the page unmounts; the next visit resumes it
  // from localStorage, so leaving never strands a purchase.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Reports one signature until the answer is final. Resolves to the
   * phase to show; never throws (a network blip keeps it reporting).
   */
  const report = useCallback(
    async (p: PendingPurchase, isLive: () => boolean): Promise<PurchasePhase | null> => {
      while (isLive()) {
        let result;
        try {
          result = await submitPurchase(p.signature, p.wallet);
        } catch {
          result = null; // offline — keep the record, try again
        }
        if (result?.kind === "awarded") {
          dropPending(p.signature);
          onCreditedRef.current();
          return { kind: "done", signature: p.signature, awarded: result.awarded, count: p.count };
        }
        if (result?.kind === "nothing" || result?.kind === "error") {
          dropPending(p.signature);
          onCreditedRef.current();
          const why =
            result.kind === "error"
              ? result.message
              : result.reason === "transaction_failed"
                ? "that transaction failed on-chain, nothing was charged except the network fee"
                : result.reason === "no_purchase_found"
                  ? "the server found no payment to the raffle treasury in that transaction"
                  : "a purchase ceiling was reached before it was counted";
          return { kind: "failed", signature: p.signature, message: `Not credited: ${why}.` };
        }
        // pending (not finalized yet) or offline: was the transfer real?
        if (Date.now() - p.sentAt > UNSEEN_EXPIRY_MS) {
          try {
            const { value } = await connection.getSignatureStatus(p.signature, {
              searchTransactionHistory: true,
            });
            if (value === null || value.err !== null) {
              dropPending(p.signature);
              return {
                kind: "failed",
                signature: p.signature,
                message: "That payment never landed on-chain, so no SOL left your wallet.",
              };
            }
          } catch {
            // RPC blip — ask again next lap.
          }
        }
        await new Promise((r) => window.setTimeout(r, REPORT_EVERY_MS));
      }
      return null;
    },
    [connection],
  );

  // Resume anything this wallet paid for but never saw credited.
  useEffect(() => {
    if (wallet === null) return;
    const mine = readPending().filter((p) => p.wallet === wallet);
    if (mine.length === 0) return;
    let live = true;
    const latest = mine[mine.length - 1]!;
    setPhase({ kind: "crediting", signature: latest.signature, count: latest.count });
    void Promise.all(mine.map((p) => report(p, () => live))).then((results) => {
      const last = results[results.length - 1];
      if (live && last) setPhase(last);
    });
    return () => {
      live = false;
    };
  }, [wallet, report]);

  const buy = useCallback(
    async (count: number): Promise<void> => {
      if (publicKey === null || wallet === null || terms === undefined || count <= 0) return;
      const isLive = (): boolean => mountedRef.current;
      try {
        // Re-check every ceiling on FRESH numbers right before paying:
        // the page's status can be 20 s old and other buyers move the
        // shared allowance.
        setPhase({ kind: "checking" });
        const fresh = await fetchRaffleStatus(wallet);
        const freshTerms = fresh.purchase;
        if (fresh.epoch === null || freshTerms === undefined) {
          setPhase({ kind: "failed", message: "The raffle isn't taking purchases right now." });
          return;
        }
        const limit = buyLimit(freshTerms, fresh.epoch, fresh.wallet?.bySource.purchase ?? 0, Date.now());
        if (count > limit.max) {
          setPhase({
            kind: "failed",
            message:
              limit.max === 0
                ? "Buying just closed for this epoch. Nothing was charged."
                : `Only ${limit.max} can be bought right now. Lower the amount and try again. Nothing was charged.`,
          });
          onCreditedRef.current(); // refresh the card's limits
          return;
        }

        const lamports = purchaseLamports(freshTerms, count);
        const balance = BigInt(await connection.getBalance(publicKey, "confirmed"));
        if (balance < lamports + FEE_HEADROOM_LAMPORTS) {
          setPhase({ kind: "failed", message: "Not enough SOL in this wallet on mainnet." });
          return;
        }

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(
          SystemProgram.transfer({
            fromPubkey: publicKey,
            toPubkey: new PublicKey(freshTerms.treasury),
            lamports,
          }),
        );

        setPhase({ kind: "signing" });
        let signature: string;
        if (signTransaction !== undefined) {
          const signed = await signTransaction(tx);
          signature = await connection.sendRawTransaction(signed.serialize(), {
            skipPreflight: false,
          });
        } else {
          signature = await sendTransaction(tx, connection);
        }
        // Recorded before anything else can fail: from here on the SOL
        // may be moving, and only a report credits it.
        addPending({ signature, wallet, count, sentAt: Date.now() });

        setPhase({ kind: "confirming", signature });
        try {
          const confirmation = await connection.confirmTransaction(
            { signature, blockhash, lastValidBlockHeight },
            "confirmed",
          );
          if (confirmation.value.err !== null) {
            dropPending(signature);
            setPhase({
              kind: "failed",
              signature,
              message: "The payment failed on-chain. Nothing was charged except the network fee.",
            });
            return;
          }
        } catch {
          // Timed out or the RPC dropped. Not a verdict: the report loop
          // below asks the chain directly and settles it either way.
        }

        setPhase({ kind: "crediting", signature, count });
        const final = await report({ signature, wallet, count, sentAt: Date.now() }, isLive);
        if (final !== null) setPhase(final);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const rejected = /reject|declin|cancel/i.test(message);
        setPhase({
          kind: "failed",
          message: rejected
            ? "Cancelled in the wallet. Nothing was charged."
            : `Couldn't complete the purchase: ${message}`,
        });
      }
    },
    [connection, publicKey, report, sendTransaction, signTransaction, terms, wallet],
  );

  const reset = useCallback(() => setPhase({ kind: "idle" }), []);

  return { phase, buy, reset };
}
