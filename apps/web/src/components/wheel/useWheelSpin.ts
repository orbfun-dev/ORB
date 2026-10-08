/**
 * The needle's easing engine (roadmap 7.3).
 *
 * Division of labor — the rule the whole wheel is built on:
 *  - the TARGET angle is always `thetaDegrees(winningTicket, total)` from
 *    the SDK (integer micro-degrees under it); nothing here ever derives
 *    an angle from a float ratio of lamports;
 *  - the trajectory is a pure function `angleAt(start, final, t)` —
 *    quartic ease-out, deterministic and unit-tested, landing within
 *    1e-9° of `final ≡ θtarget (mod 360)` (gate: ±0.001°);
 *  - the rAF loop touches ONLY `style.transform` of the attached element —
 *    no React state, no re-render, no jank. React sees three coarse
 *    transitions (idle → spinning → landed) through callbacks.
 *
 * Angle convention: degrees, 0° at 12 o'clock, clockwise positive — the
 * same convention the slice paths use, so a needle at θ sits exactly on
 * the slice spanning [start°, end°).
 *
 * REDUCED MOTION. The spin is theatre: the outcome is already decided on
 * chain and the overlay states it in words. So when the viewer has asked
 * for reduced motion, the needle does not travel and does not drift — it
 * is placed on the landing angle and `onLanded` fires immediately, which
 * means the settlement presentation (frozen book, highlighted winner,
 * overlay) still runs in full. CSS can suppress a decorative keyframe but
 * it cannot reach a rAF loop writing `style.transform`, so this has to be
 * handled here; the preference is read live, per call, so a viewer who
 * changes the OS setting mid-session is honoured without a reload.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

export interface WheelSpinOptions {
  /** Ambient drift speed while idle (default 18°/s — one lap per 20 s). */
  idleDegPerSec?: number;
  /** Steady speed while the outcome is being drawn (default 240°/s). */
  drawDegPerSec?: number;
  /** Deceleration duration in ms (default 5000). */
  durationMs?: number;
  /** Full extra rotations before the residual delta (default 4). */
  minTurns?: number;
  /** Fired once when the deceleration finishes; receives the landed θ ∈ [0, 360). */
  onLanded?: (theta: number) => void;
}

/** `drawing`: the round has closed and its randomness is in flight — a
 *  steady fast run that says "the result is coming", not ambient drift. */
export type SpinPhase = "idle" | "drawing" | "spinning" | "landed";

/** Quartic ease-out: f(0)=0, f(1)=1 exactly; velocity strictly decreasing. */
export function easeOutQuart(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const u = 1 - t;
  return 1 - u * u * u * u;
}

/**
 * The deterministic landing angle: `current + minTurns·360° + Δ` where Δ ∈
 * [0, 360) is the forward distance to the target, so
 * `final ≡ θtarget (mod 360)` by construction and the wheel always spins
 * forward at least `minTurns` full laps.
 */
export function computeFinalAngle(
  currentAngle: number,
  targetTheta: number,
  minTurns = 4,
): number {
  const delta = (((targetTheta - currentAngle) % 360) + 360) % 360;
  return currentAngle + minTurns * 360 + delta;
}

/** Trajectory: quartic ease-out from `start` to `final` over `durationMs`. */
export function angleAt(
  startAngle: number,
  finalAngle: number,
  elapsedMs: number,
  durationMs: number,
): number {
  const t = elapsedMs / durationMs;
  // Snap at the ends — the easing is exact there, but float a+(b-a) is not.
  if (t <= 0) return startAngle;
  if (t >= 1) return finalAngle;
  return startAngle + (finalAngle - startAngle) * easeOutQuart(t);
}

/** Normalizes any angle into [0, 360). */
export function normalizeAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Live read of the viewer's motion preference (SSR/test-safe). */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const MAX_FRAME_MS = 100; // tab was hidden — don't lurch on resume
/** Keep the accumulator small over hours of idle drift (float hygiene). */
const IDLE_WRAP_AT = 360_000;

export interface WheelSpin {
  /** Ref-callback: attach to the rotating needle wrapper (origin centered). */
  attach: (element: HTMLElement | null) => void;
  /** Begin deceleration onto `targetTheta` (θ from the SDK, degrees). */
  spinTo: (targetTheta: number) => void;
  /** Teleport to θ without motion (already-settled rounds on load). */
  jumpTo: (theta: number) => void;
  /** Return to ambient drift (new round opened). */
  resumeIdle: () => void;
  /** Run steadily while the outcome is drawn; `spinTo` decelerates from it. */
  startDrawing: () => void;
  /** Latest angle — a ref read, never React state. */
  currentAngle: () => number;
  /** Current phase — a ref read for event handlers. */
  phase: () => SpinPhase;
}

export function useWheelSpin(options: WheelSpinOptions = {}): WheelSpin {
  const {
    idleDegPerSec = 18,
    drawDegPerSec = 240,
    durationMs = 5_000,
    minTurns = 4,
  } = options;

  const elementRef = useRef<HTMLElement | null>(null);
  const angleRef = useRef(0);
  const phaseRef = useRef<SpinPhase>("idle");
  const spinRef = useRef<{ start: number; final: number; beganAt: number } | null>(null);
  const onLandedRef = useRef(options.onLanded);
  useEffect(() => {
    onLandedRef.current = options.onLanded;
  }, [options.onLanded]);

  const attach = useCallback((element: HTMLElement | null) => {
    elementRef.current = element;
  }, []);

  const applyAngle = useCallback((deg: number) => {
    const el = elementRef.current;
    if (el !== null) {
      el.style.transform = `rotate(${deg}deg)`;
    }
  }, []);

  const spinTo = useCallback(
    (targetTheta: number) => {
      // Reduced motion: land immediately, and still report the landing so
      // the winner presentation downstream is identical.
      if (prefersReducedMotion()) {
        spinRef.current = null;
        phaseRef.current = "landed";
        angleRef.current = normalizeAngle(targetTheta);
        applyAngle(angleRef.current);
        onLandedRef.current?.(angleRef.current);
        return;
      }
      const current = angleRef.current;
      spinRef.current = {
        start: current,
        final: computeFinalAngle(current, targetTheta, minTurns),
        beganAt: performance.now(),
      };
      phaseRef.current = "spinning";
    },
    [applyAngle, minTurns],
  );

  const jumpTo = useCallback(
    (theta: number) => {
      spinRef.current = null;
      phaseRef.current = "landed";
      angleRef.current = normalizeAngle(theta);
      applyAngle(angleRef.current);
    },
    [applyAngle],
  );

  const resumeIdle = useCallback(() => {
    if (phaseRef.current !== "idle") {
      spinRef.current = null;
      phaseRef.current = "idle";
      angleRef.current = normalizeAngle(angleRef.current);
    }
  }, []);

  const startDrawing = useCallback(() => {
    if (phaseRef.current !== "drawing") {
      spinRef.current = null;
      phaseRef.current = "drawing";
      angleRef.current = normalizeAngle(angleRef.current);
    }
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const frame = (now: number): void => {
      const dtMs = Math.min(MAX_FRAME_MS, now - last);
      last = now;

      if (phaseRef.current === "spinning" && spinRef.current !== null) {
        const { start, final, beganAt } = spinRef.current;
        const elapsed = now - beganAt;
        const angle = angleAt(start, final, elapsed, durationMs);
        angleRef.current = angle;
        applyAngle(angle);
        if (elapsed >= durationMs) {
          angleRef.current = final;
          applyAngle(final);
          phaseRef.current = "landed";
          spinRef.current = null;
          onLandedRef.current?.(normalizeAngle(final));
        }
      } else if (
        (phaseRef.current === "idle" || phaseRef.current === "drawing") &&
        !prefersReducedMotion()
      ) {
        const degPerSec = phaseRef.current === "drawing" ? drawDegPerSec : idleDegPerSec;
        let angle = angleRef.current + (degPerSec * dtMs) / 1000;
        if (angle > IDLE_WRAP_AT) {
          angle -= 360 * Math.floor(angle / 360); // multiple of 360: no visual step
        }
        angleRef.current = angle;
        applyAngle(angle);
      }
      // "landed": hold the winning angle — no motion after the stop.

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [applyAngle, durationMs, idleDegPerSec, drawDegPerSec]);

  // Stable identity across renders: consumers put `spin` in effect deps —
  // a fresh object literal per render re-arms those effects every frame
  // and, combined with a setState in any of them, loops the renderer.
  const currentAngle = useCallback(() => angleRef.current, []);
  const phase = useCallback(() => phaseRef.current, []);

  return useMemo<WheelSpin>(
    () => ({
      attach,
      spinTo,
      jumpTo,
      resumeIdle,
      startDrawing,
      currentAngle,
      phase,
    }),
    [attach, spinTo, jumpTo, resumeIdle, startDrawing, currentAngle, phase],
  );
}
