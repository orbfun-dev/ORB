/**
 * The single play card: MANUAL and AUTO in one surface, tab-switched.
 *
 * Replaces the old split (DepositPanel + a second AUTO-PLAY ESCROW card),
 * which showed two competing CTAs and buried the auto flow under four stat
 * tiles and five paragraphs of disclosure. The contract here:
 *
 *  - ONE amount field, ONE primary button, whichever tab is showing;
 *  - the auto tab adds exactly one control — a ROUNDS stepper — plus two
 *    derived read-out rows. Auto-play never reinvests (owner directive,
 *    2026-10-08): it plays the funded rounds and winnings/refunds wait in
 *    the escrow until cancel returns them;
 *  - copy is read-out rows, not prose. A blocker still becomes the
 *    button's own label (the rule the 2026-10-07 freeze bought us), but
 *    the standing explanations are gone;
 *  - while auto-play is live the card is replaced by a compact running
 *    bar whose only action is CANCEL — one signature that returns the
 *    unplayed rounds AND claims the refunds already owed.
 */

import { useMemo, useState } from "react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Ban, Bot, CircleAlert, Coins, Minus, Plus, Wallet2, Zap } from "lucide-react";
import { formatSolCompact, formatSolReward, parseSolToLamports } from "../../lib/format";
import { useRoundData } from "../../context/RoundDataProvider";
import { useViewedWallet } from "../../hooks/useViewedWallet";
import { useWalletBalance } from "../../hooks/useWalletBalance";
import { useDeposit } from "../../hooks/useDeposit";
import { useEscrow } from "../../hooks/useEscrow";
import {
  MAX_AUTO_PLAY_ROUNDS,
  effectiveRoundsLeft,
  planAutoEntry,
  planAutoPlay,
  type AutoEntryBlocker,
  type AutoPlayBlocker,
} from "../../lib/autoPlay";
import { validateDeposit } from "../deposit/DepositPanel";
import { QuickAmounts, addSolToInput } from "../deposit/QuickAmounts";
import { WinProbability, winProbabilityBps } from "../deposit/WinProbability";
import { sumPlayerLamports } from "../deposit/DepositPanel";

/** Blocker → the auto button's label. One line, no paragraph. */
const FUND_LABELS: Record<AutoPlayBlocker, string> = {
  "wallet-disconnected": "connect wallet",
  "amount-invalid": "enter an amount",
  paused: "program paused",
  "auto-deposit-disabled": "auto-play is off on-chain",
  "rounds-out-of-range": `rounds must be 1–${MAX_AUTO_PLAY_ROUNDS}`,
  "below-min-deposit": "below the minimum stake",
  "insufficient-balance": "insufficient balance",
};

const ENTRY_LABELS: Record<AutoEntryBlocker, string> = {
  "wallet-disconnected": "connect wallet",
  paused: "program paused",
  "auto-deposit-disabled": "auto-play is off on-chain",
  "no-escrow": "no escrow",
  "round-not-open": "no round open",
  "deposit-window-closed": "window closed",
  "round-window-expired": "window expired — start the next round",
  "already-entered-this-round": "entered this round",
  "escrow-depleted": "budget spent",
  "below-min-deposit": "stake under the minimum",
  "round-full": "round full",
  "escrow-insufficient-balance": "not enough for one more round",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-orbit-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * The one primary action on the card, whichever tab is showing. Brass with
 * a lit crown and a specular pass on hover: the single most-pressed
 * element in the product should feel like a physical key, and a flat fill
 * that does not move under the cursor is most of what made this surface
 * read as a prototype. `children` is passed straight through so the
 * accessible name stays whatever the blocker/label logic computed.
 */
function PrimaryButton({
  disabled,
  onClick,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="pressable group relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl py-3 text-sm font-bold tracking-wide text-orbit-void shadow-[inset_0_1px_0_0_rgba(255,255,255,0.42),0_14px_32px_-14px_rgba(242,181,68,0.6)] hover:brightness-[1.07] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:hover:brightness-100"
      style={{
        backgroundImage:
          "linear-gradient(180deg, #ffd07a 0%, #f2b544 52%, #c88f24 100%)",
      }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 -left-full w-1/2 skew-x-[-18deg] bg-white/35 transition-all duration-700 group-hover:left-[150%] group-disabled:hidden"
      />
      <span className="relative flex items-center gap-2">{children}</span>
    </button>
  );
}

function Step({
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
      className="pressable flex size-8 items-center justify-center rounded-lg border border-orbit-line bg-orbit-panel-2 text-orbit-text-mid hover:border-orbit-line-2 hover:bg-orbit-panel-3 hover:text-orbit-text disabled:cursor-not-allowed disabled:opacity-35"
    >
      {children}
    </button>
  );
}

export function PlayCard() {
  const { state } = useRoundData();
  const { round, entries, config } = state;
  const viewed = useViewedWallet();
  const walletModal = useWalletModal();
  const { balanceLamports } = useWalletBalance();
  const { deposit, pending: depositPending } = useDeposit();
  const {
    state: escrowState,
    fundEscrow,
    withdrawEscrow,
    autoDepositNow,
    cancelAutoPlay,
    pending: escrowPending,
  } = useEscrow();
  const escrow = escrowState.escrow;

  const [tab, setTab] = useState<"manual" | "auto">("manual");
  const [amount, setAmount] = useState("");
  const [rounds, setRounds] = useState(10);

  const nowSecs = BigInt(Math.floor((state.nowMs + state.clockOffsetMs) / 1000));
  const open = round?.state === "open";
  const paused = config?.paused === true;
  const lamports = parseSolToLamports(amount.trim());

  // ── auto: the plan owns every number and every blocker ───────────────
  const fund = useMemo(
    () =>
      planAutoPlay({
        perRoundLamports: lamports,
        rounds,
        tipLamports: config?.autoDepositTipLamports ?? 0n,
        minDepositLamports: config?.minDepositLamports ?? 0n,
        accountOpenFeeLamports: config?.accountOpenFeeLamports ?? 0n,
        autoDepositEnabled: config === null ? true : config.autoDepositEnabled,
        paused: config?.paused ?? false,
        escrowExists: escrowState.isFunded,
        currentSpendableLamports: escrowState.spendable,
        walletBalanceLamports: balanceLamports,
        canSign: viewed.canSign,
      }),
    [balanceLamports, config, escrowState.isFunded, escrowState.spendable, lamports, rounds, viewed.canSign],
  );

  const entry = useMemo(
    () =>
      planAutoEntry({
        canSign: viewed.canSign,
        paused: config?.paused ?? false,
        autoDepositEnabled: config === null ? true : config.autoDepositEnabled,
        tipLamports: config?.autoDepositTipLamports ?? 0n,
        minDepositLamports: config?.minDepositLamports ?? 0n,
        autoDepositWindowSecs: config?.autoDepositWindowSecs ?? 0n,
        maxEntriesPerRound: config?.maxEntriesPerRound ?? 0,
        escrow:
          escrow === null
            ? null
            : {
                perRoundLamports: escrow.perRoundLamports,
                roundsRemaining: escrow.roundsRemaining,
                nextEligibleRoundId: escrow.nextEligibleRoundId,
              },
        escrowLamports: escrowState.lamports ?? 0n,
        round:
          round === null
            ? null
            : {
                roundId: round.roundId,
                state: round.state,
                startTs: round.startTs,
                endTs: round.endTs,
                entryCount: round.entryCount,
                totalLamports: round.totalLamports,
              },
        nowSecs,
      }),
    [config, escrow, escrowState.lamports, nowSecs, round, viewed.canSign],
  );

  // ── manual ───────────────────────────────────────────────────────────
  const validation = useMemo(
    () => validateDeposit(amount, open ? config?.minDepositLamports ?? null : null, balanceLamports),
    [amount, config, open, balanceLamports],
  );
  const existing = useMemo(
    () => sumPlayerLamports(entries, viewed.publicKey?.toString() ?? null),
    [entries, viewed.publicKey],
  );
  const bps = useMemo(
    () =>
      winProbabilityBps(
        validation.ok ? validation.lamports : 0n,
        existing,
        round?.totalLamports ?? 0n,
      ),
    [validation, existing, round?.totalLamports],
  );

  // ── live auto-play: the honest counter, not the chain's forecast ─────
  const liveRoundCost = escrow === null ? 0n : entry.roundCost;
  const roundsLeft =
    escrow === null
      ? 0
      : effectiveRoundsLeft(escrow.roundsRemaining, escrowState.spendable, liveRoundCost);
  const running = escrowState.isFunded && roundsLeft > 0;

  const busy = depositPending || escrowPending !== null;

  const submitManual = (): void => {
    if (viewed.publicKey === null) {
      walletModal.setVisible(true);
      return;
    }
    if (validation.ok) void deposit(validation.lamports).then((ok) => ok && setAmount(""));
  };

  const submitAuto = (): void => {
    if (viewed.publicKey === null) {
      walletModal.setVisible(true);
      return;
    }
    void fundEscrow({
      amountLamports: fund.deposit,
      perRoundLamports: fund.perRound,
      maxRounds: fund.rounds,
      autoReinvest: false,
    });
  };

  const stepRounds = (delta: number): void =>
    setRounds((r) => Math.min(MAX_AUTO_PLAY_ROUNDS, Math.max(1, r + delta)));

  // ── running bar: sits ABOVE the card, never replaces it. Auto-play
  //    being live must not take the manual deposit away. ───────────────
  // The escrow's own progress: how much of what was funded has been
  // played. A bare "7 rounds left" says nothing about where in the plan
  // the player is; the bar does, at a glance.
  const roundsFunded = escrow === null ? 0 : Number(escrow.roundsFunded);
  const roundsTotal = roundsFunded + roundsLeft;
  const playedPct = roundsTotal === 0 ? 0 : (roundsFunded / roundsTotal) * 100;

  const runningBar = running ? (
    <section className="panel relative flex flex-col gap-3 overflow-hidden border-orbit-blue/35 p-4">
        {/* A cool wash, so a live automation never reads as the same kind
            of surface as the brass "spend money" card below it. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgb(85 145 255 / 0.1) 0%, rgb(85 145 255 / 0) 55%)",
          }}
        />
        <header className="relative flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[13px] font-bold tracking-[0.1em] text-orbit-text">
            <span className="relative grid size-6 shrink-0 place-items-center rounded-full bg-orbit-blue/15">
              <Bot className="size-3.5 text-orbit-blue" />
              <span className="absolute inset-0 animate-ping-ring rounded-full bg-orbit-blue/40" />
            </span>
            AUTO-PLAY RUNNING
          </h2>
          <span className="num shrink-0 rounded-full border border-orbit-blue/40 bg-orbit-blue/15 px-2 py-0.5 text-[10px] font-bold tracking-wide text-orbit-blue">
            {roundsLeft} {roundsLeft === 1 ? "ROUND" : "ROUNDS"} LEFT
          </span>
        </header>

        <div className="relative">
          <div className="h-1.5 overflow-hidden rounded-full bg-orbit-panel-2">
            <div
              className="h-full rounded-full bg-gradient-to-r from-orbit-blue/60 to-orbit-blue shadow-[0_0_10px_rgba(85,145,255,0.6)] transition-[width] duration-700 ease-out"
              style={{ width: `${playedPct}%` }}
            />
          </div>
          <div className="num mt-1.5 flex items-baseline justify-between text-[10px] text-orbit-muted">
            <span>
              {formatSolCompact(escrow!.perRoundLamports)} SOL / round ·{" "}
              <span className="text-orbit-text-mid">{escrow!.roundsFunded.toString()}</span> played
            </span>
            <span>
              <span className="text-orbit-text-mid">
                {formatSolCompact(escrowState.spendable)}
              </span>{" "}
              SOL left
            </span>
          </div>
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => void cancelAutoPlay(escrowState.spendable)}
          className="pressable relative flex items-center justify-center gap-2 rounded-xl border border-orbit-line bg-orbit-panel-2 px-4 py-2.5 text-sm font-semibold text-orbit-text-mid hover:border-orbit-line-2 hover:bg-orbit-panel-3 hover:text-orbit-text disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Ban className="size-4" />
          {/* Only the unspent escrow — the rounds not joined yet. Settled
              refunds are claimed on the rewards card, never here. */}
          {escrowPending === "auto-play cancel"
            ? "cancelling…"
            : `cancel — get back ${formatSolReward(escrowState.spendable)} SOL`}
        </button>

        {/* The owner escape hatch stays reachable, one line, no sermon. */}
        <button
          type="button"
          disabled={entry.blocker !== null || busy}
          onClick={() => round !== null && void autoDepositNow(round.roundId)}
          className="pressable relative flex items-center justify-center gap-2 rounded-xl border border-orbit-line px-4 py-2 text-xs font-semibold text-orbit-text-mid hover:border-orbit-blue/60 hover:text-orbit-blue disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Zap className="size-3.5" />
          {escrowPending === "auto-deposit"
            ? "entering…"
            : entry.blocker !== null
              ? ENTRY_LABELS[entry.blocker]
              : `play round ${round!.roundId.toString()} now`}
        </button>
    </section>
  ) : null;

  // ── the card ─────────────────────────────────────────────────────────
  const autoBlocked = fund.blocker !== null;
  const manualBlocked = viewed.publicKey !== null && (!open || paused || !validation.ok);

  return (
    <div className="space-y-4">
      {runningBar}
      <section className="panel p-4">
      <header className="mb-4 flex items-center justify-between gap-2">
        {/* Segmented control with a travelling brass index, so switching
            modes is a movement the eye can follow instead of two
            independently-lit pills. The button's text content stays the
            bare mode name — it is the accessible name. */}
        <div className="relative flex rounded-full border border-orbit-line bg-orbit-bg/70 p-1 shadow-[inset_0_1px_3px_rgba(0,0,0,0.5)]">
          <span
            aria-hidden
            className="absolute inset-y-1 w-[calc(50%-0.25rem)] rounded-full bg-orbit-panel-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{ transform: tab === "auto" ? "translateX(0)" : "translateX(100%)" }}
          />
          {(["auto", "manual"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`relative z-10 w-[4.75rem] rounded-full px-3 py-1.5 text-xs font-bold capitalize transition-colors duration-200 ${
                tab === t ? "text-orbit-text" : "text-orbit-muted hover:text-orbit-text-mid"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        {balanceLamports !== null && (
          <span className="flex items-baseline gap-1.5 text-right">
            <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-orbit-muted">
              Bal
            </span>
            <span className="num text-xs font-semibold text-orbit-text-mid">
              {formatSolCompact(balanceLamports)}
            </span>
            <span className="text-[9px] text-orbit-muted">SOL</span>
          </span>
        )}
      </header>

      <div className="space-y-3">
        <div className="group relative">
          <span className="pointer-events-none absolute -top-2 left-3 z-10 bg-orbit-panel px-1.5 text-[9px] font-bold uppercase tracking-[0.18em] text-orbit-muted">
            {tab === "auto" ? "Stake / round" : "Deposit"}
          </span>
          <input
            inputMode="decimal"
            autoComplete="off"
            aria-label={tab === "auto" ? "stake per round in SOL" : "deposit amount in SOL"}
            placeholder="0"
            value={amount}
            disabled={paused}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") (tab === "auto" ? submitAuto : submitManual)();
            }}
            className="num w-full rounded-xl border border-orbit-line bg-orbit-panel-2 px-3.5 py-3.5 pr-14 text-[1.75rem] font-medium leading-none tabular-nums text-orbit-text shadow-[inset_0_2px_6px_rgba(0,0,0,0.45)] transition-colors placeholder:text-orbit-disabled focus:border-orbit-gold/70 focus:outline-none focus:ring-4 focus:ring-orbit-gold/12 disabled:opacity-60"
          />
          <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[11px] font-bold tracking-wider text-orbit-muted">
            SOL
          </span>
        </div>

        <QuickAmounts disabled={paused} onAdd={(add) => setAmount((c) => addSolToInput(c, add))} />

        {tab === "manual" ? (
          <>
            <WinProbability bps={bps} />
            {!validation.ok && validation.reason !== "empty" && (
              <p
                className="flex items-start gap-1.5 rounded-lg border border-orbit-red/35 bg-orbit-red/[0.07] px-2.5 py-1.5 text-[11px] font-medium text-orbit-red-bright"
                role="alert"
              >
                <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                {validation.message}
              </p>
            )}
            <PrimaryButton disabled={depositPending || manualBlocked} onClick={submitManual}>
              {depositPending ? (
                "depositing…"
              ) : viewed.publicKey === null ? (
                <>
                  <Wallet2 className="size-4" /> connect wallet
                </>
              ) : !open ? (
                `round ${round?.state ?? "closed"}`
              ) : validation.ok ? (
                `deposit ${formatSolCompact(validation.lamports)} SOL`
              ) : (
                "deposit"
              )}
            </PrimaryButton>
          </>
        ) : (
          <>
            <div className="divide-y divide-orbit-line/60 rounded-xl border border-orbit-line/70 bg-orbit-bg/30 px-3">
              <Row label="Rounds">
                <span className="flex items-center gap-2">
                  <Step onClick={() => stepRounds(-1)} disabled={rounds <= 1} label="fewer rounds">
                    <Minus className="size-3.5" />
                  </Step>
                  <input
                    inputMode="numeric"
                    aria-label="number of rounds"
                    value={String(rounds)}
                    onChange={(e) => {
                      const n = Number.parseInt(e.target.value.replace(/[^\d]/g, ""), 10);
                      setRounds(Number.isFinite(n) ? Math.min(MAX_AUTO_PLAY_ROUNDS, Math.max(1, n)) : 1);
                    }}
                    className="num w-10 bg-transparent text-center text-base tabular-nums text-orbit-text outline-none"
                  />
                  <Step
                    onClick={() => stepRounds(1)}
                    disabled={rounds >= MAX_AUTO_PLAY_ROUNDS}
                    label="more rounds"
                  >
                    <Plus className="size-3.5" />
                  </Step>
                </span>
              </Row>

              <Row label="Cost per round">
                <span className="num text-sm tabular-nums text-orbit-text-mid">
                  {formatSolCompact(fund.roundCost)} <span className="text-orbit-muted">SOL</span>
                </span>
              </Row>

              <Row label="Total">
                <span className="num text-base font-semibold tabular-nums text-orbit-gold">
                  {formatSolCompact(fund.walletDebit)}{" "}
                  <span className="text-xs font-normal text-orbit-gold/60">SOL</span>
                </span>
              </Row>
            </div>

            <PrimaryButton
              disabled={busy || (viewed.publicKey !== null && autoBlocked)}
              onClick={submitAuto}
            >
              {escrowPending === "escrow fund" ? (
                "starting…"
              ) : viewed.publicKey === null ? (
                <>
                  <Wallet2 className="size-4" /> connect wallet
                </>
              ) : fund.blocker !== null ? (
                FUND_LABELS[fund.blocker]
              ) : (
                <>
                  <Coins className="size-4" /> start {fund.rounds} rounds
                </>
              )}
            </PrimaryButton>
          </>
        )}

        {/* A dormant escrow still holding money: one sweep, no card state. */}
        {!running && escrowState.spendable > 0n && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void withdrawEscrow(escrowState.spendable)}
            className="w-full rounded-lg py-1 text-center text-[11px] text-orbit-muted underline decoration-orbit-line-2 decoration-dotted underline-offset-[3px] transition-colors hover:text-orbit-gold hover:decoration-orbit-gold/60"
          >
            withdraw {formatSolCompact(escrowState.spendable)} SOL left in your escrow
          </button>
        )}
      </div>
      </section>
    </div>
  );
}
