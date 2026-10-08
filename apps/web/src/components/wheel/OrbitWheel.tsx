/**
 * The Orbit Wheel assembly (roadmap 7.3).
 *
 * Data contracts — the parity rule, enforced by construction:
 *  - arcs render from `calculateWheelSlices` (SDK) only;
 *  - the needle's target is `thetaDegrees(winningTicket, total)` (SDK) only;
 *  - the highlighted winner comes from `findWinningEntry` (SDK integer
 *    lookup) — the angle animated the needle onto it, never picked it.
 *
 * Era separation (the rollover-race fix): a settlement FREEZES the round's
 * book (`captureSettledBook`) for the whole landing presentation — spin,
 * landed highlight, overlay. The live feed keeps moving underneath (the
 * next round's first deposits swap `entries` within seconds), but the
 * needle lands against the FROZEN slices with the FROZEN winner until the
 * presentation ends (dismiss, or auto-clear once the round has rolled
 * past). An in-flight spin is never cancelled by a rollover.
 *
 * The reconnect case (page loaded on an already-settled round, no event in
 * flight) derives the same θ from the round account and jumps — no spin,
 * straight to the landed presentation.
 *
 * The DRAW (pipelined settle). The keeper opens round N+1 about two
 * seconds after locking N, and N's randomness lands ~30 s later — so the
 * outcome the player is waiting for belongs to a round that is no longer
 * the live one. From the moment N closes, the wheel keeps N's frozen book
 * on screen with the needle running ("drawing"), and N's settlement lands
 * against THAT book. It used to snap to N+1's empty dial, then spin N's
 * ticket over N+1's arcs half a minute later — a needle pointing at a
 * "winner" in a round that had only just started.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  thetaDegrees,
  type PlayerEntryAccountData,
  type PlayerEntryData,
  type RoundData,
  type RoundSettledEvent,
} from "@orbit-jackpot/sdk";
import { useRoundData, type SettlementOutcome } from "../../context/RoundDataProvider";
import { useViewedWallet } from "../../hooks/useViewedWallet";
import { isMyKey } from "../../lib/identity";
import { formatSolCompact } from "../../lib/format";
import { captureSettledBook, landingThetaOf, safeWheelSlices, type SettledBookCapture } from "../../lib/book";
import { useWheelSpin } from "./useWheelSpin";
import { annularSectorPath, polarToXY, WheelSliceArc, type WheelGeometry } from "./WheelSliceArc";
import { NeedleHub, SpinNeedle } from "./SpinNeedle";
import { WheelStats } from "./WheelStats";
import { MegaPotCard } from "./MegaPotCard";
import { RoundTimerCard } from "./RoundTimerCard";
import { WinnerOverlay } from "./WinnerOverlay";

const GEOMETRY: WheelGeometry = { cx: 200, cy: 200, r0: 126, r1: 181 };

/** Bezel casing: the machined rim the data ring is seated in. */
const BEZEL = { inner: 182, outer: 196 };

/** The engraved scale — every 5° a minor tick, every 30° a major one. The
 *  scale is FIXED (a scale that moves is not a scale); only the light
 *  travelling over the casing moves. */
const MINOR_TICKS = Array.from({ length: 72 }, (_, i) => i * 5);
const MAJOR_TICKS = Array.from({ length: 12 }, (_, i) => i * 30);

/** How long the landed presentation lingers after the round has rolled
 *  past it — the winner stays readable while the new round takes over.
 *  With the pipelined settle the round has ALWAYS rolled past by the time
 *  the needle lands, so this is simply how long the winner is on screen. */
const ROLLOVER_GRACE_MS = 6_000;

const isDrawing = (r: RoundData): boolean =>
  r.state === "locked" || r.state === "awaitingRandomness";

/** A superseded round still undrawn after this long is STUCK — the keeper
 *  quarantines a round whose reveal window it missed, and it then waits
 *  for an oracle-timeout cancel. The stage goes back to the live round
 *  instead of freezing on a draw that may never land. A healthy draw takes
 *  ~20–30 s. */
const DRAW_STAGE_MAX_SECS = 120n;

/**
 * Reveal pacing. The original 5 s deceleration over 4 full laps read as a
 * stall rather than a flourish, especially once rounds dropped to 60 s —
 * the outcome is already decided on chain, so the spin is theatre and the
 * theatre should not outlast the interest. 2.2 s over 3 laps keeps the
 * ease-out legible (the needle still visibly decelerates onto the slice)
 * at well under half the dead time.
 */
const SPIN_DURATION_MS = 2_200;
const SPIN_TURNS = 3;

/** The frozen landing presentation of one settled round. `capture` is
 *  null in the degenerate unrenderable-book case (live wheel kept). */
interface SettledPresentation {
  capture: SettledBookCapture | null;
  outcome: SettlementOutcome;
  roundId: bigint;
}

export function OrbitWheel() {
  const { state } = useRoundData();
  const { round, entries, megaPot, config, lastSettlement, antiSnipe, previous, nowMs, clockOffsetMs } =
    state;
  const viewed = useViewedWallet();
  const me = viewed.publicKey?.toString() ?? null;

  const [landed, setLanded] = useState<SettlementOutcome | null>(null);
  // The controller's `phase()` is a ref read by design (no re-render per
  // frame). The reveal still needs a React-visible build-up, so the two
  // coarse transitions the wheel itself drives — spinTo here, onLanded
  // below — mirror into state. Nothing per-frame crosses this boundary.
  const [spinning, setSpinning] = useState(false);
  const [presentation, setPresentation] = useState<SettledPresentation | null>(null);
  const presentationRef = useRef<SettledPresentation | null>(null);
  const seenSettlementRef = useRef<SettlementOutcome | null>(null);

  const onLanded = useCallback(() => {
    setSpinning(false);
    const current = presentationRef.current;
    if (current !== null) {
      setLanded(current.outcome);
    }
  }, []);
  const spin = useWheelSpin({ onLanded, durationMs: SPIN_DURATION_MS, minTurns: SPIN_TURNS });

  /** Dismiss / end the landing presentation; the needle-mode effect below
   *  picks the next motion (drift, another draw, or parked). */
  const endPresentation = useCallback(() => {
    presentationRef.current = null;
    setPresentation(null);
    setLanded(null);
  }, []);

  // The round whose outcome is being drawn right now, with ITS book: the
  // live round itself while it is locked, or — the usual case — the
  // superseded round drawing behind the next one's open window.
  const chainNowSecs = BigInt(Math.floor((nowMs + clockOffsetMs) / 1000));
  const previousStuck =
    previous !== null &&
    chainNowSecs -
      (previous.round.lockTs > 0n ? previous.round.lockTs : previous.round.endTs) >
      DRAW_STAGE_MAX_SECS;
  const drawing = useMemo<{ round: RoundData; entries: readonly PlayerEntryAccountData[] } | null>(() => {
    if (round !== null && isDrawing(round)) return { round, entries };
    if (previous !== null && isDrawing(previous.round) && !previousStuck) return previous;
    return null;
  }, [round, entries, previous, previousStuck]);

  // A settlement lands against its OWN round's book — never the live one.
  // null: a round this page never saw (nothing truthful to draw it on).
  const settledBook = useMemo<readonly PlayerEntryAccountData[] | null>(() => {
    if (lastSettlement === null) return null;
    const id = lastSettlement.event.roundId;
    if (round !== null && round.roundId === id) return entries;
    if (previous !== null && previous.round.roundId === id) return previous.entries;
    return null;
  }, [lastSettlement, round, entries, previous]);

  // Live slice math runs against the BOOK's own total (I9: entries
  // telescope to their end) — `round.total_lamports` may transiently lead
  // the entry refetch, and the SDK rightly refuses a broken partition.
  // Sparse books (refunds/closes deleted entries) are sanitized first:
  // gaps render as neutral closed arcs instead of crashing the page.
  // The stage book: the drawing round's while its outcome is pending, the
  // live round's otherwise.
  const stageEntries = drawing !== null ? drawing.entries : entries;
  const wheel = useMemo(() => safeWheelSlices(stageEntries), [stageEntries]);
  // The rendered wheel: the FROZEN book while a landing presentation is
  // live, the stage book otherwise.
  const frozen = presentation?.capture ?? null;
  const slices = frozen !== null ? frozen.wheel.slices : (wheel?.slices ?? null);
  const fillerIndexes = frozen !== null ? frozen.wheel.fillerIndexes : wheel?.fillerIndexes;
  const labelEntries = frozen !== null ? frozen.bookEntries : stageEntries;
  const winner: PlayerEntryData | null = frozen !== null ? frozen.winner : null;

  // Needle mode whenever no presentation owns it: run while an outcome is
  // drawn, drift over an active round, stay parked on a settled one.
  // Declared BEFORE the spin trigger so a settle that ends the draw in the
  // same commit is not undone by a late resumeIdle.
  useEffect(() => {
    if (presentation !== null || presentationRef.current !== null) return;
    if (drawing !== null) {
      spin.startDrawing();
    } else if (round?.state === "open") {
      spin.resumeIdle();
    }
  }, [presentation, drawing, round?.state, spin]);

  // Spin trigger: every NEW settlement freezes the round's book and spins
  // the needle exactly once against it. A cleared settlement (round
  // rollover) NEVER cancels an in-flight spin or a live presentation —
  // the landing belongs to the settled round; the rolled-past effect
  // below hands the wheel back to the new round after a grace period.
  useEffect(() => {
    if (lastSettlement === null) {
      if (presentationRef.current === null) {
        seenSettlementRef.current = null;
        setLanded(null);
      }
      return;
    }
    // One presentation per ROUND: the reducer may restate a settlement it
    // first read off the account once the event itself arrives — that
    // refines the overlay's figures, it must not spin the needle again.
    if (seenSettlementRef.current?.event.roundId === lastSettlement.event.roundId) return;
    if (settledBook === null) {
      // A round this page never saw: there is no book to land it on, and
      // spinning its ticket over the live round's arcs is the exact bug
      // this guards against. The rewards card still credits it.
      seenSettlementRef.current = lastSettlement;
      return;
    }
    if (settledBook.length === 0) return; // its book is still loading
    const capture = captureSettledBook(settledBook, lastSettlement.event.winningTicket);
    seenSettlementRef.current = lastSettlement;
    if (capture === null) return; // unrenderable book — nothing truthful to show
    const settled: SettledPresentation = {
      capture,
      outcome: lastSettlement,
      roundId: lastSettlement.event.roundId,
    };
    presentationRef.current = settled;
    setPresentation(settled);
    setLanded(null);
    // θ against the scale the wheel is DRAWN in — the capture's book
    // total, never the event's. See `landingThetaOf`.
    setSpinning(true);
    spin.spinTo(landingThetaOf(capture, lastSettlement.event.winningTicket));
    // The book is read at capture time only — the era-separation rule.
  }, [lastSettlement, settledBook, spin]);

  // Once the round has rolled past the presentation and the needle has
  // landed, hand the wheel back to the live (new) round after a grace.
  const rolledPast =
    presentation !== null && round !== null && round.roundId !== presentation.roundId;
  useEffect(() => {
    if (presentation === null || landed === null || !rolledPast) return;
    const t = window.setTimeout(endPresentation, ROLLOVER_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [presentation, landed, rolledPast, endPresentation]);

  // Reconnect fallback: settled round with no event in flight — land
  // statically on the account-derived θ and show the overlay immediately.
  //
  // Effect-dep hygiene: `round`/`megaPot` are fresh object references on
  // every 3 s poll dispatch, so the effect body must bail out on an
  // outcome SIGNATURE (round id + the fields the landing depends on)
  // rather than identity — otherwise every poll re-runs jumpTo and
  // setLanded(new Object), and pre-7.7 that was an infinite render loop.
  const reconnectSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      lastSettlement === null &&
      round !== null &&
      round.state === "settled" &&
      round.totalLamports > 0n &&
      round.winningTicket < round.totalLamports
    ) {
      const sig = [
        round.roundId,
        round.winningTicket,
        round.totalLamports,
        round.winnerPayout,
        round.megaAwarded,
        round.megaTriggered,
        round.randomnessSeedSlot,
        megaPot?.accruedLamports ?? "?",
      ].join(":");
      if (reconnectSigRef.current !== sig) {
        reconnectSigRef.current = sig;
        setSpinning(false);
        const capture = captureSettledBook(entries, round.winningTicket);
        spin.jumpTo(
          capture !== null
            ? landingThetaOf(capture, round.winningTicket)
            : thetaDegrees(round.winningTicket, round.totalLamports),
        );
        const fromAccount: RoundSettledEvent = {
          roundId: round.roundId,
          winningTicket: round.winningTicket,
          totalLamports: round.totalLamports,
          winnerPayout: round.winnerPayout,
          refundPool: round.refundPool,
          adminCut: round.adminCut,
          megaCut: round.megaCut,
          megaTriggered: round.megaTriggered,
          megaAwarded: round.megaAwarded,
          megaFieldPool: round.megaFieldPool,
          megaPotRemaining: megaPot?.accruedLamports ?? 0n,
          randomnessSeedSlot: round.randomnessSeedSlot,
          randomnessValue: new Uint8Array(32),
        };
        const outcome: SettlementOutcome = {
          event: fromAccount,
          at: 0,
          mega:
            round.megaTriggered && megaPot !== null
              ? {
                  roundId: round.roundId,
                  cycleIndex: megaPot.cycleIndex,
                  awarded: round.megaAwarded,
                  fieldPool: round.megaFieldPool,
                  retained: megaPot.accruedLamports,
                }
              : null,
        };
        seenSettlementRef.current = outcome;
        const settled: SettledPresentation = { capture, outcome, roundId: round.roundId };
        presentationRef.current = settled;
        setPresentation(settled);
        setLanded(outcome);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSettlement, round, megaPot, spin]);

  // The hollow centre describes the round ON STAGE — the one being drawn
  // or presented — not the live round filling up behind it.
  const stageRound: RoundData | null = useMemo(() => {
    const id = presentation?.roundId ?? drawing?.round.roundId ?? null;
    if (id === null || round?.roundId === id) return round;
    if (previous?.round.roundId === id) return previous.round;
    return round;
  }, [presentation?.roundId, drawing, round, previous]);
  const stageEntryCount =
    stageRound !== null && stageRound.roundId !== round?.roundId
      ? (previous?.entries.length ?? 0)
      : entries.length;

  // Curved on-slice labels ("8SOL", or "YOU" for either identity of the
  // viewer — wallet OR escrow, per the dual-identity rule). Filler arcs
  // (closed ranges) get no label. The label is display-only; the marker
  // still lands on SDK angles and the winner is still findWinningEntry.
  const labelByIndex = useMemo(() => {
    const m = new Map<number, string>();
    if (slices === null || fillerIndexes === undefined) return m;
    const byIndex = new Map(labelEntries.map((e) => [e.entryIndex, e]));
    for (const s of slices) {
      if (fillerIndexes.has(s.entryIndex)) continue;
      const entry = byIndex.get(s.entryIndex);
      if (entry === undefined) continue;
      m.set(s.entryIndex, isMyKey(s.player, me) ? "YOU" : `${formatSolCompact(entry.amountLamports)} ◎`);
    }
    return m;
  }, [slices, fillerIndexes, labelEntries, me]);

  return (
    <div className="mx-auto w-full max-w-[34rem] space-y-3.5 sm:space-y-4">
      {round !== null && (
        // Mega-Pot + clock live above the wheel, side by side; the
        // hollow center reads only round + pot.
        <div
          className={`grid gap-2.5 sm:gap-3 ${megaPot !== null ? "grid-cols-2" : "grid-cols-1"}`}
        >
          {megaPot !== null && <MegaPotCard megaPot={megaPot} />}
          <RoundTimerCard round={round} config={config} antiSnipe={antiSnipe} />
        </div>
      )}

      {/* THE STAGE. The glow under the apparatus is the page's centre of
          gravity — it is what stops a dark page reading as an empty one —
          and it brightens while the needle is running, so the reveal has a
          build instead of only a stop. */}
      <div className="relative">
        <div
          aria-hidden
          className={`pointer-events-none absolute -inset-8 rounded-full blur-2xl transition-opacity duration-[900ms] sm:-inset-12 ${
            spinning ? "opacity-100" : "opacity-50"
          }`}
          style={{
            background:
              "radial-gradient(circle at 50% 46%, rgb(242 181 68 / 0.17) 0%, rgb(59 217 203 / 0.08) 40%, rgb(9 13 20 / 0) 72%)",
          }}
        />

        {/* overflow-hidden: the rotated needle wrapper's square bounding box
            would otherwise poke past the wheel and widen the page on mobile —
            every drawn element stays inside the viewBox edge, so nothing real
            is clipped. */}
        <div className="relative aspect-square w-full overflow-hidden rounded-full">
          <svg viewBox="0 0 400 400" className="h-full w-full">
            <defs>
              {/* Light from above, in user space over the whole dial, so a
                  sector's lit edge depends on where it sits on the wheel —
                  not on the sector's own bounding box. */}
              <linearGradient
                id="sliceEdge"
                gradientUnits="userSpaceOnUse"
                x1="200"
                y1="12"
                x2="200"
                y2="388"
              >
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
                <stop offset="45%" stopColor="#ffffff" stopOpacity="0.08" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
              </linearGradient>

              {/* Machined casing: lit crown, shadowed underside. */}
              <linearGradient
                id="bezelMetal"
                gradientUnits="userSpaceOnUse"
                x1="200"
                y1="4"
                x2="200"
                y2="396"
              >
                <stop offset="0%" stopColor="#4d5a70" />
                <stop offset="34%" stopColor="#2a3443" />
                <stop offset="68%" stopColor="#141a25" />
                <stop offset="100%" stopColor="#323d4e" />
              </linearGradient>

              <linearGradient id="bezelSheen" gradientUnits="objectBoundingBox" x1="0" x2="1">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0" />
                <stop offset="50%" stopColor="#ffffff" stopOpacity="0.1" />
                <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
              </linearGradient>

              {/* The hollow centre reads as a recess, not a hole punched in
                  a flat disc. */}
              <radialGradient id="holeShade" gradientUnits="userSpaceOnUse" cx="200" cy="200" r="126">
                <stop offset="70%" stopColor="#06090f" stopOpacity="0" />
                <stop offset="100%" stopColor="#06090f" stopOpacity="0.85" />
              </radialGradient>
            </defs>

            {/* ── casing ─────────────────────────────────────────────── */}
            <circle
              cx={GEOMETRY.cx}
              cy={GEOMETRY.cy}
              r={(BEZEL.inner + BEZEL.outer) / 2}
              fill="none"
              stroke="url(#bezelMetal)"
              strokeWidth={BEZEL.outer - BEZEL.inner}
            />
            <circle
              cx={GEOMETRY.cx}
              cy={GEOMETRY.cy}
              r={BEZEL.outer}
              fill="none"
              stroke="#060a11"
              strokeWidth={1.5}
            />
            <circle
              cx={GEOMETRY.cx}
              cy={GEOMETRY.cy}
              r={BEZEL.inner}
              fill="none"
              stroke="#0a0f18"
              strokeWidth={1.5}
            />

            {/* A glint travelling over the casing — the only moving part
                besides the needle, and it never crosses the data ring. */}
            <g className="animate-drift" style={{ transformOrigin: "200px 200px" }}>
              <path
                d={annularSectorPath(
                  { cx: 200, cy: 200, r0: BEZEL.inner, r1: BEZEL.outer },
                  -38,
                  38,
                )}
                fill="url(#bezelSheen)"
              />
            </g>

            {/* ── engraved scale ─────────────────────────────────────── */}
            <g strokeLinecap="round">
              {MINOR_TICKS.map((deg) => {
                const a = polarToXY(200, 200, BEZEL.inner + 2, deg);
                const b = polarToXY(200, 200, BEZEL.inner + 7, deg);
                return (
                  <line
                    key={`minor-${deg}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke="#f3f6fa"
                    strokeOpacity={0.13}
                    strokeWidth={1}
                  />
                );
              })}
              {MAJOR_TICKS.map((deg) => {
                const a = polarToXY(200, 200, BEZEL.inner + 1, deg);
                const b = polarToXY(200, 200, BEZEL.outer - 2, deg);
                return (
                  <line
                    key={`major-${deg}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke="#f3f6fa"
                    strokeOpacity={0.3}
                    strokeWidth={1.6}
                  />
                );
              })}
            </g>

            {/* ── backplate under the data ring ──────────────────────── */}
            <circle
              cx={GEOMETRY.cx}
              cy={GEOMETRY.cy}
              r={GEOMETRY.r1 + 1}
              fill="#0b101a"
              stroke="#1b2432"
              strokeWidth={1.5}
            />

            {slices !== null ? (
              slices.map((slice) => (
                <WheelSliceArc
                  key={slice.entryIndex}
                  slice={slice}
                  geometry={GEOMETRY}
                  isWinner={landed !== null && winner !== null && winner.entryIndex === slice.entryIndex}
                  dimmed={landed !== null}
                  label={labelByIndex.get(slice.entryIndex) ?? null}
                />
              ))
            ) : (
              // Empty book: the dial is calibrated and waiting — a dashed
              // ring on the scale, idle needle still drifting over it.
              <circle
                cx={GEOMETRY.cx}
                cy={GEOMETRY.cy}
                r={(GEOMETRY.r0 + GEOMETRY.r1) / 2}
                fill="none"
                stroke="#27313f"
                strokeWidth={GEOMETRY.r1 - GEOMETRY.r0}
                strokeDasharray="3 9"
                className="opacity-70"
              />
            )}

            {/* The recess, drawn over the ring's inner edge. */}
            <circle cx={GEOMETRY.cx} cy={GEOMETRY.cy} r={GEOMETRY.r0} fill="url(#holeShade)" />
            <circle
              cx={GEOMETRY.cx}
              cy={GEOMETRY.cy}
              r={GEOMETRY.r0}
              fill="none"
              stroke="#f3f6fa"
              strokeOpacity={0.07}
              strokeWidth={1}
            />
          </svg>

          <SpinNeedle spin={spin} boosted={spinning} />
          <NeedleHub />

          {/* hollow-center stats */}
          <div className="absolute inset-0 flex items-center justify-center">
            {round !== null ? (
              <WheelStats round={stageRound ?? round} entryCount={stageEntryCount} />
            ) : (
              <div className="flex aspect-square w-[58%] max-w-[15.5rem] flex-col items-center justify-center gap-2 rounded-full border border-dashed border-orbit-line bg-orbit-panel/40 text-center backdrop-blur-sm">
                <span className="text-[10px] font-semibold tracking-[0.28em] text-orbit-muted">
                  NO ACTIVE ROUND
                </span>
                <span className="text-xs text-orbit-muted/70">waiting for the next window…</span>
              </div>
            )}
          </div>

          {landed !== null && presentation !== null && (
            // The reducer's settlement is the live copy — MegaPotTriggered
            // attaches to it from the same settle transaction after the
            // spin-start snapshot was taken. Everything else is frozen.
            <WinnerOverlay
              roundId={presentation.roundId}
              settlement={state.lastSettlement ?? landed}
              winner={winner}
              onDismiss={endPresentation}
            />
          )}
        </div>
      </div>
    </div>
  );
}
