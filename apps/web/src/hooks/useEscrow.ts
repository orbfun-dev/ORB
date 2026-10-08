/**
 * The viewer's `PlayerEscrow` (Phase 10): fetch + live subscribe, plus the
 * three actions — fund/update terms, withdraw spendable, and the
 * owner-signed "play this round now" (the §4.2 window exemption: the owner
 * may crank their own escrow at any moment before the round's end, while
 * third parties are bound to `start_ts + auto_deposit_window_secs`).
 *
 * Transaction shape copies `useDeposit`: the wallet signs through the
 * adapter, `confirmSignature` races a 45 s timeout, toasts narrate, and a
 * SYNCHRONOUS in-flight ref makes double-submit impossible (two clicks in
 * the same frame both pass a pending-state check).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type { Transaction } from "@solana/web3.js";
import { decodePlayerEscrow, escrowKey, type PlayerEscrowData } from "@orbit-jackpot/sdk";
import { useOrbitClient } from "../context/OrbitClientProvider";
import { useToast } from "../context/ToastProvider";
import { confirmSignature, shortSignature } from "../lib/tx";

/** The escrow's rent-exempt floor — permanently locked while it exists
 *  (there is no `close_escrow` in this release; `withdraw_escrow` drains
 *  to this floor). One definition, in the planner, so the hook and
 *  `planAutoEntry` can never disagree about what "spendable" means. */
export { ESCROW_RENT_LAMPORTS as ESCROW_RENT_FLOOR_LAMPORTS } from "../lib/autoPlay";
import { ESCROW_RENT_LAMPORTS as ESCROW_RENT_FLOOR_LAMPORTS } from "../lib/autoPlay";

export interface EscrowState {
  /** Decoded escrow account, or `null` when never funded. */
  escrow: PlayerEscrowData | null;
  /** On-chain balance (rent floor included); `null` before the first read. */
  lamports: bigint | null;
  /** `max(0, lamports − rent floor)` — the ONLY way escrow funds read. */
  spendable: bigint;
  isFunded: boolean;
  /** `roundsRemaining === 0` — dormant until re-funded. */
  isDepleted: boolean;
}

export interface FundEscrowArgs {
  /** Additional lamports in (the intended SPENDABLE — the rent charge for
   *  a brand-new escrow is on top of this). `0n` = terms-only update. */
  amountLamports: bigint;
  perRoundLamports: bigint;
  maxRounds: number;
  autoReinvest: boolean;
}

export function useEscrow(): {
  state: EscrowState;
  fundEscrow: (args: FundEscrowArgs) => Promise<boolean>;
  withdrawEscrow: (amountLamports: bigint) => Promise<boolean>;
  autoDepositNow: (roundId: bigint) => Promise<boolean>;
  /** Stop auto-play: withdraw the escrow's unspent SOL. */
  cancelAutoPlay: (spendableLamports: bigint) => Promise<boolean>;
  pending: string | null;
} {
  const { client } = useOrbitClient();
  const { publicKey, connected, sendTransaction } = useWallet();
  const toast = useToast();
  const [escrow, setEscrow] = useState<PlayerEscrowData | null>(null);
  const [lamports, setLamports] = useState<bigint | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  // Live subscription on the escrow PDA: every fund/withdraw/auto-depot
  // (ours, the keeper's, or a prize landing) pushes the fresh account.
  useEffect(() => {
    if (publicKey === null) {
      setEscrow(null);
      setLamports(null);
      return;
    }
    const key = escrowKey(publicKey);
    let subId: number | null = null;
    let disposed = false;
    const refresh = async (): Promise<void> => {
      const info = await client.connection.getAccountInfo(key, "confirmed");
      if (disposed) return;
      setLamports(info === null ? null : BigInt(info.lamports));
      setEscrow(info === null ? null : decodePlayerEscrow(info.data));
    };
    void refresh().catch(() => undefined);
    // web3.js returns the listener id synchronously here.
    const id = client.connection.onAccountChange(
      key,
      () => void refresh().catch(() => undefined),
      "confirmed",
    );
    if (disposed) {
      void client.connection.removeAccountChangeListener(id).catch(() => undefined);
    } else {
      subId = id;
    }
    return () => {
      disposed = true;
      if (subId !== null) {
        void client.connection.removeAccountChangeListener(subId).catch(() => undefined);
      }
    };
  }, [client, publicKey]);

  const send = useCallback(
    async (label: string, build: () => Promise<{ tx: Transaction }>): Promise<boolean> => {
      if (inFlightRef.current || !connected || publicKey === null) return false;
      inFlightRef.current = true;
      setPending(label);
      try {
        const { tx } = await build();
        const signature = await sendTransaction(tx, client.connection);
        toast.push("info", `${label} sent — confirming…`, shortSignature(signature));
        await confirmSignature(client.connection, signature);
        toast.push("success", `${label} confirmed`, shortSignature(signature));
        return true;
      } catch (err) {
        toast.push(
          "error",
          `${label} failed`,
          err instanceof Error ? err.message.slice(0, 160) : String(err),
        );
        return false;
      } finally {
        inFlightRef.current = false;
        setPending(null);
      }
    },
    [client, connected, publicKey, sendTransaction, toast],
  );

  const fundEscrow = useCallback(
    (args: FundEscrowArgs) =>
      send("escrow fund", async () => ({
        tx: await client.buildInitOrDepositEscrowTx(
          publicKey!,
          args.amountLamports,
          args.perRoundLamports,
          args.maxRounds,
          args.autoReinvest,
        ),
      })),
    [client, publicKey, send],
  );

  const withdrawEscrow = useCallback(
    (amountLamports: bigint) =>
      send("escrow withdraw", async () => ({
        tx: await client.buildWithdrawEscrowTx(publicKey!, amountLamports),
      })),
    [client, publicKey, send],
  );

  const autoDepositNow = useCallback(
    (roundId: bigint) =>
      send("auto-deposit", async () => ({
        tx: await client.buildCrankAutoDepositTx(roundId, publicKey!, publicKey!),
      })),
    [client, publicKey, send],
  );

  /**
   * Stop auto-play: withdraw the escrow's unspent SOL — the rounds it has
   * NOT joined yet. The round already entered stays in play, and settled
   * refunds are NOT bundled here: the rewards card is the one place to
   * claim them. Bundling them made the cancel button promise refund money
   * the rewards card was showing at the same time ("cancel — refund 0.66"
   * over 0.30 unspent + 0.35 owed, 2026-10-08), which read as double.
   */
  const cancelAutoPlay = useCallback(
    (spendableLamports: bigint) =>
      send("auto-play cancel", async () => {
        // Sweep exactly the spendable the chain reported — `withdraw_escrow`
        // REQUIRES `spendable >= amount` and does not clamp
        // (withdraw_escrow.rs:45), so guessing high would fail the cancel.
        if (spendableLamports <= 0n) throw new Error("nothing to cancel");
        return { tx: await client.buildWithdrawEscrowTx(publicKey!, spendableLamports) };
      }),
    [client, publicKey, send],
  );

  const spendable =
    lamports === null ? 0n : lamports > ESCROW_RENT_FLOOR_LAMPORTS ? lamports - ESCROW_RENT_FLOOR_LAMPORTS : 0n;

  return {
    state: {
      escrow,
      lamports,
      spendable: escrow === null ? 0n : spendable,
      isFunded: escrow !== null,
      isDepleted: escrow !== null && escrow.roundsRemaining === 0,
    },
    fundEscrow,
    withdrawEscrow,
    autoDepositNow,
    cancelAutoPlay,
    pending,
  };
}
