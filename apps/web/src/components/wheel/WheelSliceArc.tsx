/**
 * One annular sector of the wheel ring, plus its curved on-slice label:
 * the stake ("8SOL") or "YOU" on the viewer's own slice — the only text
 * that lives on the wheel.
 *
 * Geometry comes ONLY from the slice's SDK-computed degrees — adjacent
 * slices share the exact same integer micro-degree boundary, so the float
 * conversions of `slice.endAngleDegrees` (i) and `slice.startAngleDegrees`
 * (i+1) are bit-identical: zero gaps, zero overlap, by construction.
 *
 * Angle convention (matching the marker bar): 0° at 12 o'clock, clockwise.
 * Pure helpers (`polarToXY`, `annularSectorPath`, `labelArcPath`,
 * `contrastTextFor`) are exported for tests.
 */

import { memo } from "react";
import type { WheelSlice } from "@orbit-jackpot/sdk";

export interface WheelGeometry {
  cx: number;
  cy: number;
  /** Inner radius (ring hole edge). */
  r0: number;
  /** Outer radius (rim edge). */
  r1: number;
}

/** Degrees (0° top, clockwise) → SVG point. */
export function polarToXY(cx: number, cy: number, r: number, deg: number): { x: number; y: number } {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

const fmt = (n: number): string => Number(n.toFixed(3)).toString();

/**
 * Annular sector path from `startDeg` to `endDeg` (clockwise). The
 * full-circle case (sole depositor) renders as two semicircle pairs with
 * even-odd fill — an arc whose endpoints coincide draws nothing.
 */
export function annularSectorPath(
  { cx, cy, r0, r1 }: WheelGeometry,
  startDeg: number,
  endDeg: number,
): string {
  const sweep = endDeg - startDeg;
  if (sweep >= 359.999999) {
    const o1 = polarToXY(cx, cy, r1, 0);
    const o2 = polarToXY(cx, cy, r1, 180);
    const i1 = polarToXY(cx, cy, r0, 0);
    const i2 = polarToXY(cx, cy, r0, 180);
    return [
      `M ${fmt(o1.x)} ${fmt(o1.y)}`,
      `A ${fmt(r1)} ${fmt(r1)} 0 1 1 ${fmt(o2.x)} ${fmt(o2.y)}`,
      `A ${fmt(r1)} ${fmt(r1)} 0 1 1 ${fmt(o1.x)} ${fmt(o1.y)}`,
      `M ${fmt(i1.x)} ${fmt(i1.y)}`,
      `A ${fmt(r0)} ${fmt(r0)} 0 1 0 ${fmt(i2.x)} ${fmt(i2.y)}`,
      `A ${fmt(r0)} ${fmt(r0)} 0 1 0 ${fmt(i1.x)} ${fmt(i1.y)}`,
      "Z",
    ].join(" ");
  }
  const largeArc = sweep > 180 ? 1 : 0;
  const outerStart = polarToXY(cx, cy, r1, startDeg);
  const outerEnd = polarToXY(cx, cy, r1, endDeg);
  const innerEnd = polarToXY(cx, cy, r0, endDeg);
  const innerStart = polarToXY(cx, cy, r0, startDeg);
  return [
    `M ${fmt(outerStart.x)} ${fmt(outerStart.y)}`,
    `A ${fmt(r1)} ${fmt(r1)} 0 ${largeArc} 1 ${fmt(outerEnd.x)} ${fmt(outerEnd.y)}`,
    `L ${fmt(innerEnd.x)} ${fmt(innerEnd.y)}`,
    `A ${fmt(r0)} ${fmt(r0)} 0 ${largeArc} 0 ${fmt(innerStart.x)} ${fmt(innerStart.y)}`,
    "Z",
  ].join(" ");
}

/** Slices narrower than this can't fit a curved label; wider than this
 *  (full-circle sole depositor) has no mid-arc to put one on. */
const LABEL_MIN_SWEEP_DEG = 15;
const LABEL_MAX_SWEEP_DEG = 359;

/** Mid-band radius the curved labels ride. */
export function labelRadius({ r0, r1 }: WheelGeometry): number {
  return (r0 + r1) / 2;
}

/**
 * Arc for a `<textPath>` at radius `r` spanning [startDeg, endDeg].
 * Runs clockwise on the top half; in the bottom half (mid-angle in
 * (90°, 270°)) it runs counter-clockwise so glyphs never render
 * upside-down — the standard wheel-label flip.
 */
export function labelArcPath(
  { cx, cy }: WheelGeometry,
  r: number,
  startDeg: number,
  endDeg: number,
): string {
  const mid = (((startDeg + endDeg) / 2) % 360 + 360) % 360;
  const flip = mid > 90 && mid < 270;
  const a0 = flip ? endDeg : startDeg;
  const a1 = flip ? startDeg : endDeg;
  const largeArc = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  const p0 = polarToXY(cx, cy, r, a0);
  const p1 = polarToXY(cx, cy, r, a1);
  return [
    `M ${fmt(p0.x)} ${fmt(p0.y)}`,
    `A ${fmt(r)} ${fmt(r)} 0 ${largeArc} ${flip ? 0 : 1} ${fmt(p1.x)} ${fmt(p1.y)}`,
  ].join(" ");
}

/** The two inks the on-slice labels may be drawn in (chrome tokens). */
export const SLICE_INK_DARK = "#06090f";
export const SLICE_INK_LIGHT = "#f3f6fa";

/**
 * WCAG relative luminance — channels LINEARISED, not raw sRGB. The old
 * version averaged the gamma-encoded bytes, which overstates the
 * luminance of saturated mid-tones and so handed light ink to fills that
 * needed dark (brass #f2b544 was the exact failure: 1.8:1 with white,
 * 9.9:1 with ink).
 */
export function relativeLuminance(hex: string): number {
  const n = hex.replace("#", "");
  const channel = (byte: number): number => {
    const c = byte / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(n.slice(0, 2), 16));
  const g = channel(parseInt(n.slice(2, 4), 16));
  const b = channel(parseInt(n.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * L≈0.183 is where `(L+0.05)/(Link+0.05)` and `(Llight+0.05)/(L+0.05)`
 * cross for this app's two inks — i.e. the fill lightness at which dark
 * and light text are equally legible. Picking the better side of that
 * crossover is what guarantees the 4.5:1 the palette note claims.
 */
const INK_CROSSOVER_L = 0.183;

/** Dark ink on light slices, light ink on dark ones. */
export function contrastTextFor(hex: string): string {
  return relativeLuminance(hex) > INK_CROSSOVER_L ? SLICE_INK_DARK : SLICE_INK_LIGHT;
}

interface WheelSliceArcProps {
  slice: WheelSlice;
  geometry: WheelGeometry;
  isWinner: boolean;
  /** Non-winner slices fade once the marker has landed. */
  dimmed: boolean;
  /** Curved on-slice text ("8SOL", or "YOU" for the viewer) — null hides. */
  label?: string | null;
}

export const WheelSliceArc = memo(function WheelSliceArc({
  slice,
  geometry,
  isWinner,
  dimmed,
  label = null,
}: WheelSliceArcProps) {
  const d = annularSectorPath(geometry, slice.startAngleDegrees, slice.endAngleDegrees);
  const sweep = slice.endAngleDegrees - slice.startAngleDegrees;
  const showLabel =
    label !== null && sweep >= LABEL_MIN_SWEEP_DEG && sweep < LABEL_MAX_SWEEP_DEG;
  const labelR = labelRadius(geometry);
  const arcLen = (sweep * Math.PI * labelR) / 180;
  const fontSize = showLabel
    ? Math.max(9, Math.min(13.5, arcLen / ((label?.length ?? 1) * 0.72)))
    : 0;
  const pathId = `slice-label-${slice.entryIndex}`;
  const symIdx = label !== null ? label.indexOf(" ◎") : -1;
  const labelText = label ?? "";
  return (
    <g
      opacity={dimmed && !isWinner ? 0.22 : 1}
      style={{ transition: "opacity 0.45s cubic-bezier(0.22,1,0.36,1)" }}
    >
      <path
        d={d}
        fill={slice.color}
        fillRule="evenodd"
        stroke={isWinner ? "#ffd07a" : "#06090f"}
        strokeWidth={isWinner ? 2.5 : 1.75}
        data-entry-index={slice.entryIndex}
        className={isWinner ? "drop-shadow-[0_0_14px_#ffd07a88]" : undefined}
      />
      {/* A lit top edge on every arc. One hairline of specular is the
          difference between a flat pie chart and a machined ring — it
          gives each sector a thickness the eye can read. */}
      <path
        d={d}
        fill="none"
        stroke="url(#sliceEdge)"
        strokeWidth={1}
        opacity={isWinner ? 0.95 : 0.6}
        pointerEvents="none"
      />
      {showLabel && (
        <>
          <defs>
            <path
              id={pathId}
              d={labelArcPath(geometry, labelR, slice.startAngleDegrees, slice.endAngleDegrees)}
            />
          </defs>
          <text
            fontSize={fontSize}
            fontWeight="600"
            fill={contrastTextFor(slice.color)}
            className="num"
          >
            <textPath href={`#${pathId}`} startOffset="50%" textAnchor="middle">
              {symIdx >= 0 ? (
                <>
                  {labelText.slice(0, symIdx)}
                  {/* The ◎ runs ~30% larger than the digits, shifted along
                      the arc by dx (never a space char — renderers trim it). */}
                  <tspan dx={fontSize * 0.3} fontSize={fontSize * 1.3}>
                    ◎
                  </tspan>
                </>
              ) : (
                labelText
              )}
            </textPath>
          </text>
        </>
      )}
    </g>
  );
});
