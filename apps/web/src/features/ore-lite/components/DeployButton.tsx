/**
 * The Deploy button as the state-machine surface (§6): every phase,
 * blocker and terminal state renders here and nowhere else.
 */

import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import type { OreTxPhase } from "../hooks/useOreDeploy";
import type { DeployPlan } from "../planner";
import { formatSol } from "../format";

export type PageState =
  | "LOADING"
  | "ERROR"
  | "WALLET_DISCONNECTED"
  | "WAITING_FIRST_DEPLOY"
  | "OPEN"
  | "INTERMISSION"
  | "AMOUNT_INVALID";

export interface DeployButtonProps {
  pageState: PageState;
  plan: DeployPlan | null;
  /** Extra context for blocker copy. */
  walletBalanceLamports: bigint;
  phase: OreTxPhase;
  phaseError: string | null;
  signature: string | null;
  onDeploy: () => void;
  onReset: () => void;
}

function PhaseLine({ phase, phaseError, signature }: Pick<DeployButtonProps, "phase" | "phaseError" | "signature">) {
  if (phase === "idle") return null;
  if (phase === "simulating") {
    return (
      <StatusLine tone="muted">
        <Loader2 className="size-3.5 animate-spin" /> Simulating on mainnet — nothing is signed yet…
      </StatusLine>
    );
  }
  if (phase === "awaiting-signature") {
    return (
      <StatusLine tone="muted">
        <Loader2 className="size-3.5 animate-spin" /> Approve the transaction in your wallet…
      </StatusLine>
    );
  }
  if (phase === "confirming") {
    return (
      <StatusLine tone="muted">
        <Loader2 className="size-3.5 animate-spin" /> Confirming…
      </StatusLine>
    );
  }
  if (phase === "confirmed") {
    return (
      <StatusLine tone="green">
        <CheckCircle2 className="size-3.5" /> Deployed.{" "}
        {signature !== null && (
          <a
            className="underline decoration-dotted underline-offset-2"
            href={`https://solscan.io/tx/${signature}`}
            target="_blank"
            rel="noreferrer"
          >
            View on Solscan
          </a>
        )}
      </StatusLine>
    );
  }
  if (phase === "expired") {
    return (
      <StatusLine tone="gold">
        <AlertTriangle className="size-3.5" /> Transaction expired — no SOL was spent, including the
        platform fee. {phaseError ? `(${phaseError})` : ""}
      </StatusLine>
    );
  }
  return (
    <StatusLine tone="red">
      <XCircle className="size-3.5" /> {phaseError ?? "Transaction failed."}
    </StatusLine>
  );
}

function StatusLine({
  tone,
  children,
}: {
  tone: "muted" | "green" | "gold" | "red";
  children: React.ReactNode;
}) {
  const color =
    tone === "green"
      ? "text-orbit-green"
      : tone === "gold"
        ? "text-orbit-gold"
        : tone === "red"
          ? "text-orbit-red-bright"
          : "text-orbit-muted";
  return (
    <div className={`mt-2 flex items-center justify-center gap-1.5 text-center text-xs ${color}`}>
      {children}
    </div>
  );
}

export function DeployButton({
  pageState,
  plan,
  walletBalanceLamports,
  phase,
  phaseError,
  signature,
  onDeploy,
  onReset,
}: DeployButtonProps) {
  const inFlight = phase === "simulating" || phase === "awaiting-signature" || phase === "confirming";
  const terminal = phase === "confirmed" || phase === "failed" || phase === "expired";

  let label = "Deploy";
  let disabled = true;
  let sub: string | null = null;

  if (pageState === "LOADING" || pageState === "ERROR") {
    label = pageState === "LOADING" ? "Loading round…" : "Mainnet unreachable";
  } else if (pageState === "WALLET_DISCONNECTED") {
    label = "Connect wallet to mine";
  } else if (pageState === "AMOUNT_INVALID") {
    label = plan === null ? "Enter an amount" : "Enter a valid amount";
  } else if (pageState === "INTERMISSION") {
    label = "Intermission — deploys paused";
    sub = "The next round starts shortly. Nothing to sign until then.";
  } else if (plan === null) {
    label = "Enter an amount";
  } else if (plan.blocker === "no-eligible-squares") {
    label = "Every selected square is taken";
    sub = "You already deployed to all selected squares this round — pick different squares.";
  } else if (plan.blocker === "amount-too-small") {
    label = "Amount too small";
    sub = "The total must be at least 1 lamport per eligible square.";
  } else if (plan.blocker === "insufficient-balance") {
    const shortfall = plan.requiredBalance - walletBalanceLamports;
    label = "Insufficient balance";
    sub = `Short by ${formatSol(shortfall, 6)} SOL (need ${formatSol(plan.requiredBalance, 6)} incl. fees).`;
  } else if (plan.blocker === "fee-recipient-uninitialized") {
    label = "Fee wallet not initialized";
    sub =
      "ORB's fee wallet has not been created on-chain yet, so the bundled fee transfer cannot settle. Nothing was charged — this clears as soon as the wallet is funded once.";
  } else if (plan.blocker === "automation-active") {
    label = "Auto-join is active — manual deploy paused";
    sub =
      "This wallet's ORE automation deploys its own plan from its own balance. Stop it to deploy manually again.";
  } else if (plan.blocker !== null) {
    label = "Round not open";
  } else {
    disabled = false;
    label =
      pageState === "WAITING_FIRST_DEPLOY"
        ? `Start round — deploy ${formatSol(plan.totalDeploy)} SOL`
        : `Deploy ${formatSol(plan.totalDeploy)} SOL`;
    sub = `${plan.eligibleSquares.length} square${plan.eligibleSquares.length === 1 ? "" : "s"} × ${formatSol(plan.amountPerSquare, 6)} SOL per square`;
  }

  if (inFlight) {
    disabled = true;
    if (phase === "simulating") label = "Simulating…";
    if (phase === "awaiting-signature") label = "Waiting for signature…";
    if (phase === "confirming") label = "Confirming…";
  }

  return (
    <div>
      <button
        type="button"
        onClick={terminal && phase !== "confirmed" ? onReset : onDeploy}
        disabled={disabled || inFlight}
        className={`flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3.5 text-sm font-semibold transition-all disabled:cursor-not-allowed ${
          terminal && phase === "failed"
            ? "bg-orbit-red text-orbit-text hover:opacity-90"
            : "pressable bg-gradient-to-b from-orbit-gold-bright via-orbit-gold to-[#c88f24] text-orbit-void shadow-[inset_0_1px_0_0_rgba(255,255,255,0.42),0_14px_32px_-14px_rgba(242,181,68,0.6)] hover:brightness-[1.07] disabled:opacity-40 disabled:shadow-none"
        }`}
      >
        {(phase === "simulating" || phase === "awaiting-signature" || phase === "confirming") && (
          <Loader2 className="size-4 animate-spin" />
        )}
        {terminal && phase !== "failed" && <RefreshCw className="size-4" />}
        {label}
      </button>
      {sub !== null && !terminal && (
        <p className="mt-2 text-center text-xs text-orbit-muted">{sub}</p>
      )}
      <PhaseLine phase={phase} phaseError={phaseError} signature={signature} />
      {terminal && (
        <button
          type="button"
          onClick={onReset}
          className="mx-auto mt-2 block text-xs text-orbit-muted underline decoration-dotted underline-offset-2 hover:text-orbit-text"
        >
          {phase === "confirmed" ? "Deploy again" : "Try again"}
        </button>
      )}
    </div>
  );
}
