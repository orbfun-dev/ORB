/**
 * The body of the raffle page's BUY ENTRIES card: a count picker, the
 * exact total, the ceilings that are left, one brass button, and a status
 * line that walks the purchase from signature to credited entries.
 *
 * The picker can never hold a count the server would clamp (see
 * purchasePlan) — over-paying a ceiling buys nothing, so the page must
 * make it impossible rather than warn about it.
 */

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Check, Loader2, Minus, Plus, Wallet2 } from "lucide-react";
import { formatSolCompact } from "../../lib/format";
import type { PurchaseTerms, RaffleEpoch } from "./api";
import { buyLimit, clampCount, purchaseLamports, type BuyBlocker } from "./purchasePlan";
import { usePurchase, type PurchasePhase } from "./usePurchase";

const BLOCKED: Record<BuyBlocker, string> = {
  "epoch-closed": "This epoch is closed. Buying opens again with the next one.",
  "closing-soon":
    "The epoch closes in under 10 minutes, so buying is paused. A payment that confirms after the draw locks would earn nothing.",
  "share-full":
    "Bought entries have reached their 30% share of this epoch. You can still earn entries on the ORE tab.",
  "wallet-full": "You've bought the maximum for this epoch.",
};

const solscan = (signature: string): string => `https://solscan.io/tx/${signature}`;

function PhaseLine({ phase }: { phase: PurchasePhase }) {
  const busy = (text: string) => (
    <p className="flex items-center gap-2 text-orbit-text-mid">
      <Loader2 className="size-3.5 shrink-0 animate-spin text-orbit-gold" />
      {text}
    </p>
  );
  switch (phase.kind) {
    case "idle":
      return null;
    case "checking":
      return busy("Checking what's still available…");
    case "signing":
      return busy("Approve the payment in your wallet…");
    case "confirming":
      return busy("Payment sent. Waiting for Solana to confirm it…");
    case "crediting":
      return busy(
        `Paid for ${phase.count}. Adding your entries once the payment finalizes (usually under a minute)…`,
      );
    case "done":
      return (
        <p className="flex items-center gap-2 text-orbit-green">
          <Check className="size-3.5 shrink-0" />
          {phase.awarded === phase.count
            ? `${phase.awarded} ${phase.awarded === 1 ? "entry" : "entries"} added.`
            : `${phase.awarded} of ${phase.count} added. A ceiling was reached first.`}{" "}
          <a className="underline underline-offset-2" href={solscan(phase.signature)} target="_blank" rel="noopener noreferrer">
            View payment
          </a>
        </p>
      );
    case "failed":
      return (
        <p className="text-orbit-red-bright">
          {phase.message}{" "}
          {phase.signature !== undefined && (
            <a className="underline underline-offset-2" href={solscan(phase.signature)} target="_blank" rel="noopener noreferrer">
              View transaction
            </a>
          )}
        </p>
      );
  }
}

export function BuyEntries({
  terms,
  epoch,
  walletBought,
  onChanged,
}: {
  terms: PurchaseTerms;
  epoch: RaffleEpoch;
  walletBought: number;
  onChanged: () => void;
}) {
  const { publicKey } = useWallet();
  const walletModal = useWalletModal();
  const { phase, buy, reset } = usePurchase(terms, onChanged);

  // Re-evaluated each render; status polls every 20 s, which is plenty
  // for a 10-minute closing margin.
  const limit = buyLimit(terms, epoch, walletBought, Date.now());
  const [count, setCount] = useState(1);
  const n = clampCount(count, limit.max);
  useEffect(() => {
    if (count !== n && n > 0) setCount(n);
  }, [count, n]);

  const inFlight =
    phase.kind === "checking" ||
    phase.kind === "signing" ||
    phase.kind === "confirming" ||
    phase.kind === "crediting";
  const total = purchaseLamports(terms, Math.max(n, 1));
  const price = formatSolCompact(BigInt(terms.priceLamports));

  const onBuy = (): void => {
    if (publicKey === null) {
      walletModal.setVisible(true);
      return;
    }
    if (n === 0 || inFlight) return;
    void buy(n);
  };

  const step = (delta: number): void => {
    if (phase.kind === "done" || phase.kind === "failed") reset();
    setCount(clampCount(n + delta, limit.max));
  };

  return (
    <div className="space-y-3.5">
      <p className="text-orbit-muted">
        <span className="num text-orbit-text-mid">{price} SOL</span> an entry. Up to{" "}
        {terms.perWalletCap} per wallet, and bought entries can make up at most 30% of an epoch.
        Proceeds buy back ORB.
      </p>

      {limit.blocker !== null ? (
        <p className="rounded-lg border border-orbit-line bg-orbit-panel-2 px-3 py-2.5 text-orbit-text-mid">
          {BLOCKED[limit.blocker]}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center rounded-full border border-orbit-line bg-orbit-panel-2">
              <button
                type="button"
                aria-label="One fewer"
                onClick={() => step(-1)}
                disabled={inFlight || n <= 1}
                className="pressable grid size-9 place-items-center rounded-full text-orbit-text disabled:text-orbit-disabled"
              >
                <Minus className="size-4" />
              </button>
              <span className="num w-10 text-center text-lg font-semibold text-orbit-text" aria-live="polite">
                {n}
              </span>
              <button
                type="button"
                aria-label="One more"
                onClick={() => step(1)}
                disabled={inFlight || n >= limit.max}
                className="pressable grid size-9 place-items-center rounded-full text-orbit-text disabled:text-orbit-disabled"
              >
                <Plus className="size-4" />
              </button>
            </div>
            <div className="flex gap-1.5">
              {[5, 10].filter((q) => q < limit.max).map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => step(q - n)}
                  disabled={inFlight}
                  className="pressable rounded-full border border-orbit-line bg-orbit-panel-2 px-3 py-1.5 text-[11px] font-semibold text-orbit-text-mid hover:text-orbit-text"
                >
                  {q}
                </button>
              ))}
              {limit.max > 1 && (
                <button
                  type="button"
                  onClick={() => step(limit.max - n)}
                  disabled={inFlight}
                  className="pressable rounded-full border border-orbit-line bg-orbit-panel-2 px-3 py-1.5 text-[11px] font-semibold text-orbit-text-mid hover:text-orbit-text"
                >
                  Max {limit.max}
                </button>
              )}
            </div>
          </div>

          <dl className="num space-y-1 text-xs">
            <div className="flex justify-between gap-4">
              <dt className="font-sans text-orbit-muted">Total</dt>
              <dd className="font-semibold text-orbit-text">{formatSolCompact(total)} SOL</dd>
            </div>
            {publicKey !== null && (
              <div className="flex justify-between gap-4">
                <dt className="font-sans text-orbit-muted">You can still buy</dt>
                <dd className="text-orbit-text-mid">{limit.walletLeft} of {terms.perWalletCap}</dd>
              </div>
            )}
            <div className="flex justify-between gap-4">
              <dt className="font-sans text-orbit-muted">Left to buy this epoch</dt>
              <dd className="text-orbit-text-mid">{limit.shareLeft} of {epoch.purchaseCap}</dd>
            </div>
          </dl>

          <button
            type="button"
            onClick={onBuy}
            disabled={inFlight}
            className="pressable flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-orbit-gold-bright via-orbit-gold to-[#c88f24] px-5 py-3 text-sm font-bold text-orbit-void shadow-[inset_0_1px_0_0_rgba(255,255,255,0.42),0_14px_32px_-14px_rgba(242,181,68,0.6)] hover:brightness-[1.07] disabled:cursor-wait disabled:opacity-70"
            data-testid="buy-entries"
          >
            {publicKey === null ? (
              <>
                <Wallet2 className="size-4" /> Connect a wallet to buy
              </>
            ) : inFlight ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Working…
              </>
            ) : (
              `Buy ${n} ${n === 1 ? "entry" : "entries"} · ${formatSolCompact(total)} SOL`
            )}
          </button>
        </>
      )}

      <div className="text-xs leading-relaxed">
        <PhaseLine phase={phase} />
      </div>
      <p className="text-[11px] text-orbit-muted">
        Paid in SOL on Solana mainnet. Entries can't be refunded.
      </p>
    </div>
  );
}
