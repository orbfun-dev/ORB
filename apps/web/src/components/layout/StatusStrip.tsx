import { useState } from "react";
import { ChevronDown, CircleAlert, Radio, ShieldCheck, WifiOff } from "lucide-react";
import { RPC_ENDPOINT } from "../../lib/rpc";
import { formatSolCompact, shortAddress } from "../../lib/format";
import { useOrbitClient } from "../../context/OrbitClientProvider";
import { useRoundData } from "../../context/RoundDataProvider";
import { ManualCrankButton } from "../common/ManualCrankButton";
import { LiveDot } from "../common/Figure";

/**
 * Operational status — redesigned from a single 11px grey run of
 * `endpoint · program · live · initialized · admin · round · pot · entries
 * · mega-pot`, which was literally a console dump shipped to players and
 * was the loudest "unfinished" signal in the whole product.
 *
 * The split is by audience, because these facts have two different ones:
 *
 *  · ALWAYS VISIBLE — the one thing a player needs from this bar: is the
 *    page actually connected to the chain, and does anything need doing
 *    (the permissionless crank). Plus the cluster, because mistaking
 *    devnet for mainnet is an expensive mistake.
 *  · BEHIND A DISCLOSURE — endpoint, program id, admin, decoded round and
 *    vault figures: operator/debug facts. Nothing is removed, so the
 *    diagnostic value survives; it just stops being the page's footer
 *    headline.
 *
 * Failure states are promoted, not demoted: an unreachable RPC or a
 * missing config is the one case where this bar should be the most
 * prominent thing on the screen, and it now has the red to do that with.
 */

/** Feed health → dot tone, label, glyph. */
function feedPresentation(status: string, mode: string): {
  tone: string;
  text: string;
  pulse: boolean;
  Icon: typeof Radio;
} {
  if (mode === "fixture") {
    return { tone: "#9b86ff", text: "FIXTURE", pulse: false, Icon: ShieldCheck };
  }
  switch (status) {
    case "live":
      return { tone: "#3bd9cb", text: "LIVE", pulse: true, Icon: Radio };
    case "polling":
      return { tone: "#f2b544", text: "POLLING", pulse: true, Icon: Radio };
    case "offline":
      return { tone: "#ff5c46", text: "OFFLINE", pulse: false, Icon: WifiOff };
    default:
      return { tone: "#76839a", text: status.toUpperCase(), pulse: false, Icon: Radio };
  }
}

/** One key/value line in the expanded diagnostics grid. */
function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-orbit-line/50 py-1.5 last:border-b-0">
      <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-orbit-muted">
        {label}
      </span>
      <span className="num min-w-0 truncate text-[11px] text-orbit-text-mid">{children}</span>
    </div>
  );
}

export function StatusStrip() {
  const { programId } = useOrbitClient();
  const { state } = useRoundData();
  const { config, round, megaPot, entries } = state;
  const [open, setOpen] = useState(false);

  const feed = feedPresentation(state.feedStatus, state.mode);
  const cluster = state.mode === "fixture" ? "fixture" : RPC_ENDPOINT.includes("devnet") ? "devnet" : RPC_ENDPOINT.includes("mainnet") ? "mainnet-beta" : "localnet";

  // The one blocking condition worth shouting about.
  const fault =
    config === null
      ? state.mode === "fixture"
        ? "no scenario loaded"
        : state.feedStatus === "offline"
          ? "RPC unreachable — is the validator running?"
          : "config not found — run the Phase 7.5 local seed scripts"
      : null;

  return (
    <footer className="mt-2 border-t border-orbit-line/70">
      <div className="mx-auto max-w-6xl px-3 py-2.5 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* Connection — the headline of this bar. */}
          <span
            className="flex items-center gap-2 rounded-full border border-orbit-line bg-orbit-panel/70 px-2.5 py-1"
            title={`feed: ${state.feedStatus}`}
          >
            <LiveDot tone={feed.tone} pulse={feed.pulse} />
            <span
              className="text-[10px] font-bold tracking-[0.16em]"
              style={{ color: feed.tone }}
            >
              {feed.text}
            </span>
            <span className="text-orbit-line-2">·</span>
            <span className="num text-[10px] uppercase tracking-wider text-orbit-muted">
              {cluster}
            </span>
          </span>

          {state.mode === "fixture" && state.fixtureName !== null && (
            <span className="num text-[10px] tracking-wide text-orbit-violet">
              {state.fixtureName}
            </span>
          )}

          {fault !== null && (
            <span className="flex min-w-0 items-center gap-1.5 rounded-full border border-orbit-red/50 bg-orbit-red/10 px-2.5 py-1 text-[10px] font-semibold text-orbit-red-bright">
              <CircleAlert className="size-3.5 shrink-0" />
              <span className="truncate">{fault}</span>
            </span>
          )}

          {state.error !== null && (
            <span
              className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold text-orbit-red-bright"
              title={state.error}
            >
              <CircleAlert className="size-3.5 shrink-0" />
              <span className="max-w-[22rem] truncate">{state.error}</span>
            </span>
          )}

          <span className="ml-auto flex items-center gap-2 text-[10px]">
            {/* Phase 12: permissionless fallback crank — renders nothing
                while the keeper is on time; never the settle pipeline. */}
            <ManualCrankButton />
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="pressable flex items-center gap-1 rounded-full border border-orbit-line px-2.5 py-1 font-bold uppercase tracking-[0.14em] text-orbit-muted hover:border-orbit-line-2 hover:text-orbit-text-mid"
            >
              Diagnostics
              <ChevronDown
                className={`size-3 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
              />
            </button>
          </span>
        </div>

        {open && (
          <div className="animate-rise mt-2.5 grid gap-x-8 rounded-xl border border-orbit-line bg-orbit-panel/50 px-3.5 py-2 sm:grid-cols-2">
            <Detail label="endpoint">{RPC_ENDPOINT}</Detail>
            <Detail label="program">{shortAddress(programId, 6, 6)}</Detail>
            {config !== null && <Detail label="admin">{shortAddress(config.admin)}</Detail>}
            {config !== null && (
              <Detail label="paused">{config.paused ? "yes" : "no"}</Detail>
            )}
            {round !== null && (
              <>
                <Detail label="round">
                  {round.roundId.toString()} · {round.state}
                </Detail>
                <Detail label="pot">{formatSolCompact(round.totalLamports)} SOL</Detail>
                <Detail label="entries">
                  {entries.length}/{round.entryCount} decoded
                </Detail>
              </>
            )}
            {megaPot !== null && (
              <Detail label="mega-pot vault">
                {formatSolCompact(megaPot.accruedLamports)} SOL · cycle{" "}
                {megaPot.cycleIndex.toString()}
              </Detail>
            )}
          </div>
        )}
      </div>
    </footer>
  );
}
