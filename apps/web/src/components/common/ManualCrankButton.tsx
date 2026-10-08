/**
 * The permissionless community crank trigger (Phase 12.5). Renders
 * NOTHING while the keeper is on time — this is a fallback, not a race —
 * and never touches the Switchboard settle pipeline (R6: for
 * locked/awaitingRandomness rounds the UI shows status, not buttons).
 * Lives in StatusStrip (the operational-status surface), not WheelStats
 * (the 250 ms-clocked hollow-centre HUD).
 */

import { Zap } from "lucide-react";
import { useManualCrank } from "../../hooks/useManualCrank";
import { useEscrow } from "../../hooks/useEscrow";

const LABELS: Record<string, string> = {
  lock_round: "close round window",
  sweep_unclaimed_prize: "sweep prize to pot",
  close_round: "close round",
};

export function ManualCrankButton() {
  // An expired EMPTY round is normally nobody's business — except when the
  // viewer's own auto-play escrow is starving behind the dead window, which
  // only this component can know.
  const { state: escrowState } = useEscrow();
  const starving = escrowState.isFunded && !escrowState.isDepleted;
  const { available, because, run, pending, cooldownSecs, label: override } =
    useManualCrank(starving);
  if (available === null) return null;

  const label = override ?? LABELS[available.kind] ?? available.kind;
  const title =
    because === null
      ? undefined
      : `${because}. Permissionless: the signer pays only the transaction fee and is paid ` +
        "nothing — this keeps the game moving when the keeper is delayed.";

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={pending || cooldownSecs > 0}
      title={title}
      className="pressable flex items-center gap-1.5 rounded-full border border-orbit-gold/55 bg-orbit-gold/10 px-2.5 py-1 font-bold uppercase tracking-[0.14em] text-orbit-gold hover:border-orbit-gold hover:bg-orbit-gold/20 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Zap className="size-3" />
      {pending ? "cranking…" : cooldownSecs > 0 ? `retry in ${cooldownSecs}s` : label}
    </button>
  );
}
