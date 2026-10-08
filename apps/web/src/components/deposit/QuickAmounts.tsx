/**
 * Quick SOL selectors (+0.1 / +0.5 / +1 / +5). Additive: each click ADDS to
 * the current input — the arithmetic is exact bigint lamports (parse →
 * add → serialize), never float addition.
 */

import { LAMPORTS_PER_SOL, parseSolToLamports } from "../../lib/format";

export const QUICK_AMOUNTS = [
  { label: "+0.1", lamports: 100_000_000n },
  { label: "+0.5", lamports: 500_000_000n },
  { label: "+1", lamports: 1_000_000_000n },
  { label: "+5", lamports: 5_000_000_000n },
] as const;

/** `addSol("0.2", "+0.1") = "0.3"` — exact via bigint, trailing zeros trimmed. */
export function addSolToInput(current: string, addLamports: bigint): string {
  const base = parseSolToLamports(current) ?? 0n;
  const total = base + addLamports;
  const whole = total / LAMPORTS_PER_SOL;
  const frac = (total % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

interface QuickAmountsProps {
  disabled: boolean;
  onAdd: (lamports: bigint) => void;
}

export function QuickAmounts({ disabled, onAdd }: QuickAmountsProps) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {QUICK_AMOUNTS.map((preset) => (
        <button
          key={preset.label}
          type="button"
          disabled={disabled}
          onClick={() => onAdd(preset.lamports)}
          className="num pressable rounded-lg border border-orbit-line bg-orbit-panel-2 py-2 text-xs font-semibold text-orbit-text-mid hover:border-orbit-gold/50 hover:bg-orbit-panel-3 hover:text-orbit-gold disabled:cursor-not-allowed disabled:opacity-35"
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}
