/**
 * The Start-auto-join button + phase line (auto-join §5.2). One user
 * signature: [CU limit, CU price, Automate] — no platform-fee transfer,
 * the revenue is the protocol-paid per-round executor fee.
 */

import { CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { formatSol } from "../format";
import type { AutomationPlan } from "../planner";
import type { OreTransactionApi } from "../hooks/useOreDeploy";

export interface AutomationSetupProps {
  plan: AutomationPlan;
  api: OreTransactionApi;
  onSetup: () => void;
  walletBalanceLamports: bigint;
}

const BLOCKERS: Partial<Record<NonNullable<AutomationPlan["blocker"]>, { label: string; sub: string }>> = {
  "amount-too-small": {
    label: "Round total too small",
    sub: "Each round must deploy at least 0.001 SOL across the board.",
  },
  "fee-recipient-uninitialized": {
    label: "Fee wallet not initialized",
    sub: "ORB's fee wallet has not been created on-chain yet, so the bundled fee transfer cannot settle. Nothing was charged — this clears as soon as the wallet is funded once.",
  },
  "automation-active": {
    label: "Auto-join already active",
    sub: "Stop or top up the existing automation instead of starting a second one.",
  },
};

export function AutomationSetup({ plan, api, onSetup, walletBalanceLamports }: AutomationSetupProps) {
  const inFlight = api.inFlight;
  const terminal = api.phase === "confirmed" || api.phase === "failed" || api.phase === "expired";
  const blocker = plan.blocker !== null ? BLOCKERS[plan.blocker] : undefined;
  const shortfall =
    plan.blocker === "insufficient-balance" ? plan.requiredBalance - walletBalanceLamports : null;

  let label: string;
  let sub: string | null;
  let disabled: boolean;
  if (shortfall !== null) {
    label = "Insufficient balance";
    sub = `Short by ${formatSol(shortfall, 6)} SOL — your wallet must keep ${formatSol(plan.walletRentFloor, 6)} SOL rent minimum after the transaction (need ${formatSol(plan.requiredBalance, 6)} in total).`;
    disabled = true;
  } else if (blocker !== undefined) {
    label = blocker.label;
    sub = blocker.sub;
    disabled = true;
  } else {
    label = `Start auto-join — ${plan.rounds} rounds`;
    sub = `One signature debits ${formatSol(plan.walletDebit)} SOL (incl. the ${formatSol(plan.setupFee, 6)} SOL ORB fee). An independent public bot fleet executes the rounds; stop any time for a full refund of what's left.`;
    disabled = false;
  }

  return (
    <div>
      <button
        type="button"
        onClick={terminal && api.phase !== "confirmed" ? api.reset : onSetup}
        disabled={disabled || inFlight}
        className={`flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3.5 text-sm font-semibold transition-all disabled:cursor-not-allowed ${
          terminal && api.phase === "failed"
            ? "bg-orbit-red text-orbit-text hover:opacity-90"
            : "pressable bg-gradient-to-b from-orbit-gold-bright via-orbit-gold to-[#c88f24] text-orbit-void shadow-[inset_0_1px_0_0_rgba(255,255,255,0.42),0_14px_32px_-14px_rgba(242,181,68,0.6)] hover:brightness-[1.07] disabled:opacity-40 disabled:shadow-none"
        }`}
      >
        {inFlight && <Loader2 className="size-4 animate-spin" />}
        {terminal && api.phase !== "failed" && <RefreshCw className="size-4" />}
        {inFlight
          ? api.phase === "simulating"
            ? "Simulating…"
            : api.phase === "awaiting-signature"
              ? "Waiting for signature…"
              : "Confirming…"
          : label}
      </button>
      {sub !== null && !terminal && (
        <p className="mt-2 text-center text-xs text-orbit-muted">{sub}</p>
      )}
      {api.phase === "confirmed" && (
        <p className="mt-2 flex items-center justify-center gap-1.5 text-center text-xs text-orbit-green">
          <CheckCircle2 className="size-3.5" /> Auto-join live.{" "}
          {api.signature !== null && (
            <a
              className="underline decoration-dotted underline-offset-2"
              href={`https://solscan.io/tx/${api.signature}`}
              target="_blank"
              rel="noreferrer"
            >
              View on Solscan
            </a>
          )}
        </p>
      )}
      {api.phase === "failed" && (
        <p className="mt-2 flex items-center justify-center gap-1.5 text-center text-xs text-orbit-red-bright">
          <XCircle className="size-3.5" /> {api.error ?? "Transaction failed."}
        </p>
      )}
      {api.phase === "expired" && (
        <p className="mt-2 text-center text-xs text-orbit-gold">
          Transaction expired — nothing was debited. {api.error ?? ""}
        </p>
      )}
    </div>
  );
}
