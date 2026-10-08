/**
 * Real-time win probability — integer basis points, per the directive:
 *   bps = (staked + playerExisting) × 10_000n / (pot + staked)
 * `Number` appears only as the bar width at the render boundary; the
 * percentage text is formatted from the integer bps directly.
 *
 * Drawn as a calibrated gauge rather than a progress bar: quarter ticks so
 * the figure can be read off the scale, and a fill that warms from cyan
 * toward brass as the odds climb, so the player feels the stake landing
 * instead of just reading a new number.
 */

export function winProbabilityBps(
  stakedLamports: bigint,
  playerExistingLamports: bigint,
  currentPotLamports: bigint,
): bigint {
  const denominator = currentPotLamports + stakedLamports;
  if (denominator <= 0n) return 0n;
  return ((playerExistingLamports + stakedLamports) * 10_000n) / denominator;
}

/** `24.50%` — formatted from integer bps, never a float ratio. */
export function bpsToPercent(bps: bigint): string {
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}%`;
}

export function WinProbability({ bps }: { bps: bigint }) {
  const width = Math.min(100, Number(bps) / 100); // render boundary only
  // Majority odds earn the brass; below that the gauge stays cool, so the
  // colour itself carries the reading.
  const strong = bps >= 5_000n;

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-orbit-muted">
          Win probability
        </span>
        <span
          className={`num text-base font-semibold tabular-nums transition-colors ${
            strong ? "text-orbit-gold" : "text-orbit-text"
          }`}
        >
          {bpsToPercent(bps)}
        </span>
      </div>

      <div className="relative h-2 overflow-hidden rounded-full border border-orbit-line bg-orbit-bg/80 shadow-[inset_0_1px_3px_rgba(0,0,0,0.5)]">
        <div
          className={`h-full rounded-full transition-[width,background-image,box-shadow] duration-300 ease-out ${
            strong
              ? "bg-gradient-to-r from-orbit-cyan via-orbit-gold to-orbit-gold-bright shadow-[0_0_12px_rgba(242,181,68,0.55)]"
              : "bg-gradient-to-r from-orbit-cyan/60 to-orbit-cyan shadow-[0_0_10px_rgba(59,217,203,0.45)]"
          }`}
          style={{ width: `${width}%` }}
        />
        {/* Quarter ticks — the scale the fill is read against. */}
        {[25, 50, 75].map((at) => (
          <span
            key={at}
            aria-hidden
            className="absolute top-0 h-full w-px bg-orbit-void/70"
            style={{ left: `${at}%` }}
          />
        ))}
      </div>
    </div>
  );
}
