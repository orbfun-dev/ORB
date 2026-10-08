/**
 * The deploy amount card, ore.com-Lite style (user directive 2026-10-07):
 * a big centered TOTAL (the one editable figure — borderless display
 * input), quick-add chips + MAX beneath it, then two read-out rows —
 * ROUNDS (− / n / + stepper) and PER ROUND (derived: total ÷ rounds,
 * never typeable). SQUARES and PRIORITY rows were removed by user
 * directive (deploy-all is by design; priority fee stays fixed at
 * Normal inside OreLiteMiner). Every figure on the card derives from
 * the one total; nothing else is recomputed here.
 */

import { formatSol } from "../format";

export interface AmountInputProps {
  value: string;
  onChange: (value: string) => void;
  onMax: () => void;
  maxTotalLamports: bigint | null;
  invalid: boolean;
  disabled: boolean;
  /** The parsed total — null while the typed figure is empty/invalid. */
  totalLamports: bigint | null;
  /** Wallet balance, shown exact under the big number (ore convention). */
  balanceLamports: bigint | null;
  /** Auto-join state; the control only renders live when `roundsEnabled`. */
  rounds: number;
  onRoundsChange: (rounds: number) => void;
  roundsEnabled: boolean;
}

const QUICK_ADDS = ["0.01", "0.1", "1"] as const;
const ROUNDS_MAX = 500;

function Row({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] uppercase tracking-[0.18em] text-orbit-muted" title={title}>
        {label}
      </span>
      {children}
    </div>
  );
}

function StepperButton({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="pressable flex size-9 items-center justify-center rounded-xl border border-orbit-line bg-orbit-panel-2 text-lg text-orbit-text-mid hover:border-orbit-line-2 hover:bg-orbit-panel-3 hover:text-orbit-text disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
    </button>
  );
}

export function AmountInput({
  value,
  onChange,
  onMax,
  maxTotalLamports,
  invalid,
  disabled,
  totalLamports,
  balanceLamports,
  rounds,
  onRoundsChange,
  roundsEnabled,
}: AmountInputProps) {
  const add = (increment: string): void => {
    const current = Number(value || "0");
    if (!Number.isFinite(current) || current < 0) {
      onChange(increment);
      return;
    }
    // String math via the parser keeps >2^53 inputs exact enough for quick
    // adds; the canonical validation path stays parseSolToLamports.
    const next = (Math.round(current * 1e9) + Number(increment) * 1e9) / 1e9;
    onChange(String(Number(next.toFixed(9))));
  };

  const stepRounds = (delta: number): void => {
    onRoundsChange(Math.min(ROUNDS_MAX, Math.max(1, rounds + delta)));
  };

  return (
    <div className="space-y-6">
      {/* The one editable figure — the TOTAL across all rounds, displayed
          as a bare centered numeral (no box), ore-Lite style. */}
      <div className="flex flex-col items-center gap-1.5 pt-1">
        <input
          id="ore-lite-total-input"
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
          placeholder="0"
          disabled={disabled}
          aria-label="total deploy amount in SOL (split across rounds and squares)"
          className={`num w-full border-0 bg-transparent text-center text-6xl font-semibold tabular-nums outline-none placeholder:text-orbit-disabled disabled:opacity-40 ${
            invalid ? "text-orbit-red-bright" : "text-orbit-text"
          }`}
        />
        <span
          className="num text-sm text-orbit-muted"
          title="your wallet balance"
          aria-live="polite"
        >
          ◎{" "}
          {balanceLamports === null
            ? "—"
            : formatSol(balanceLamports, 9).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}
        </span>
      </div>

      {/* quick adds — the primary way to build an amount */}
      <div className="grid grid-cols-4 gap-2">
        {QUICK_ADDS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => add(q)}
            disabled={disabled}
            className="num pressable rounded-full border border-orbit-line bg-orbit-panel-2 py-3 text-sm font-semibold text-orbit-text-mid hover:border-orbit-gold/50 hover:bg-orbit-panel-3 hover:text-orbit-gold disabled:cursor-not-allowed disabled:opacity-35"
          >
            +{q}
          </button>
        ))}
        <button
          type="button"
          onClick={onMax}
          disabled={disabled || maxTotalLamports === null || maxTotalLamports <= 0n}
          title={
            maxTotalLamports && maxTotalLamports > 0n
              ? `Max deployable total: ${formatSol(maxTotalLamports)} SOL`
              : "Not enough SOL for the minimum deploy"
          }
          className="pressable rounded-full border border-orbit-line bg-orbit-panel-2 py-3 text-sm font-semibold tracking-wide text-orbit-text-mid hover:border-orbit-gold/50 hover:bg-orbit-panel-3 hover:text-orbit-gold disabled:cursor-not-allowed disabled:opacity-35"
        >
          MAX
        </button>
      </div>

      {/* read-out rows */}
      <div className="space-y-4">
        <Row label="Rounds" title="how many consecutive rounds to auto-join">
          {roundsEnabled ? (
            <span className="flex items-center gap-2.5">
              <StepperButton
                onClick={() => stepRounds(-1)}
                disabled={disabled || rounds <= 1}
                label="decrease rounds"
              >
                −
              </StepperButton>
              <span className="num w-8 text-center text-lg font-medium tabular-nums text-orbit-text">
                {rounds}
              </span>
              <StepperButton
                onClick={() => stepRounds(1)}
                disabled={disabled || rounds >= ROUNDS_MAX}
                label="increase rounds"
              >
                +
              </StepperButton>
            </span>
          ) : (
            <span className="flex items-center gap-2.5">
              <StepperButton onClick={() => {}} disabled label="decrease rounds">
                −
              </StepperButton>
              <span className="num w-8 text-center text-lg tabular-nums text-orbit-disabled">1</span>
              <StepperButton onClick={() => {}} disabled label="increase rounds">
                +
              </StepperButton>
              <span className="text-[10px] text-orbit-disabled">soon</span>
            </span>
          )}
        </Row>

        <Row label="Per round" title="derived — total ÷ rounds">
          <span className="num text-lg font-medium tabular-nums text-orbit-text">
            {totalLamports === null
              ? "—"
              : `${formatSol(totalLamports / BigInt(rounds), 4)} SOL`}
          </span>
        </Row>
      </div>
    </div>
  );
}
