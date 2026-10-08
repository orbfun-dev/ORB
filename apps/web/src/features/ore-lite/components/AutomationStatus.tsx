/**
 * Live automation status panel (auto-join directive §5.3): replaces the
 * deploy card while an automation exists. On-chain facts only — balance,
 * rounds remaining at the account's own terms, per-round figures and
 * lifetime totals — plus Top up (enabled deployments only, never
 * switching executors) and Stop & withdraw (always available: it is the
 * user's own signature, executor = Pubkey.default(), full refund).
 */

import { Ban, Plus } from "lucide-react";
import type { OreAutomation } from "../codec";
import { ORE_AUTOJOIN } from "../config";
import { formatOre, formatSol } from "../format";
import { automationPerRound, popcount25, roundsRemaining } from "../planner";
import type { OreAutomateApi } from "../hooks/useOreAutomate";

const TOP_UP_PRESETS = [1, 10, 50] as const;

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 rounded-xl border border-orbit-line bg-orbit-panel-2/60 px-2 py-3">
      <span className="text-[9px] uppercase tracking-[0.16em] text-orbit-muted">{label}</span>
      <span className="num text-sm font-semibold tabular-nums sm:text-base">{value}</span>
      {sub !== undefined && <span className="text-[10px] text-orbit-muted">{sub}</span>}
    </div>
  );
}

export interface AutomationStatusProps {
  automation: OreAutomation;
  api: OreAutomateApi;
}

export function AutomationStatus({ automation, api }: AutomationStatusProps) {
  const squares = popcount25(automation.mask);
  const perRound = automationPerRound(automation);
  const remaining = roundsRemaining(automation);
  const inFlight = api.inFlight;

  return (
    <section className="space-y-3 panel p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Auto-join running</h2>
        <span className="text-[10px] uppercase tracking-[0.18em] text-orbit-gold">
          {formatSol(automation.balance, 4)} SOL held
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Rounds left" value={remaining.toString()} sub="at current terms" />
        <Stat label="Per round" value={`${formatSol(perRound, 4)} SOL`} sub={`${squares} squares`} />
        <Stat
          label="Bot fee / round"
          value={`${formatSol(automation.fee, 6)} SOL`}
          sub="to the fleet"
        />
        <Stat
          label="ORE earned"
          value={formatOre(automation.totalOreEarned, 2)}
          sub="lifetime"
        />
      </div>

      <p className="text-[11px] leading-relaxed text-orbit-muted">
        Your SOL sits in an ORE program account derived from your wallet — only you can withdraw
        it, in one transaction, with no cooperation from anyone. Rounds are executed by an
        independent public bot fleet racing for the per-round executor fee; neither we nor the
        bots can change your amount or squares. When the balance can no longer cover a full
        round, the program self-closes and refunds the remainder automatically.
      </p>

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => api.stop(automation)}
          disabled={inFlight}
          className="pressable flex w-full items-center justify-center gap-2 rounded-xl border border-orbit-red/60 bg-orbit-red/15 px-5 py-3 text-sm font-bold text-orbit-red-bright hover:bg-orbit-red/25 disabled:opacity-40"
        >
          <Ban className="size-4" /> Stop & withdraw everything
        </button>

        {ORE_AUTOJOIN.enabled && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.2em] text-orbit-muted">
              Add rounds
            </span>
            {TOP_UP_PRESETS.map((extra) => (
              <button
                key={extra}
                type="button"
                onClick={() => api.topUp(automation, extra)}
                disabled={inFlight}
                className="num pressable flex items-center gap-1 rounded-full border border-orbit-line bg-orbit-panel-2 px-3 py-1 text-xs font-medium text-orbit-text-mid hover:border-orbit-line-2 hover:text-orbit-text disabled:opacity-40"
              >
                <Plus className="size-3" /> {extra}
              </button>
            ))}
            <span className="text-[10px] text-orbit-muted">
              +{formatSol(perRound + automation.fee, 4)} SOL per round
            </span>
          </div>
        )}
      </div>

      {api.phase === "confirmed" && (
        <p className="text-center text-xs text-orbit-green">
          Done — the account settles in a few seconds.{" "}
          {api.signature !== null && (
            <a
              className="underline decoration-dotted underline-offset-2"
              href={`https://solscan.io/tx/${api.signature}`}
              target="_blank"
              rel="noreferrer"
            >
              Solscan
            </a>
          )}
        </p>
      )}
      {api.phase === "failed" && (
        <p className="text-center text-xs text-orbit-red-bright">{api.error ?? "Transaction failed."}</p>
      )}
    </section>
  );
}
