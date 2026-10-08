/**
 * The deposit card: quick amounts + custom decimal input, validated
 * against the ON-CHAIN minimum (fetched from GlobalConfig — never a
 * literal) and the wallet's live balance (with a rent/fee reserve), with
 * the win probability recomputing on every keystroke and click in integer
 * basis points.
 *
 * The pure validator (`validateDeposit`) and the player-stake summer
 * (`sumPlayerLamports`) are exported for unit tests.
 */

import { useEffect, useMemo, useState } from "react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Coins, Wallet2 } from "lucide-react";
import { entryShare, escrowKey, winnerTakeHome } from "@orbit-jackpot/sdk";
import { formatSolCompact, parseSolToLamports } from "../../lib/format";
import { isMyKey } from "../../lib/identity";
import { useRoundData } from "../../context/RoundDataProvider";
import { useViewedWallet } from "../../hooks/useViewedWallet";
import { useWalletBalance } from "../../hooks/useWalletBalance";
import { useDeposit } from "../../hooks/useDeposit";
import { useOrbitClient } from "../../context/OrbitClientProvider";
import { QuickAmounts, addSolToInput } from "./QuickAmounts";
import { WinProbability, winProbabilityBps } from "./WinProbability";

/** Rent for the new entry + tx fees — kept aside when balance-checking. */
export const DEPOSIT_RESERVE_LAMPORTS = 5_000_000n; // 0.005 SOL

/**
 * The PlayerEscrow profile rent (Phase 11.6): (128 + 122) × 3480 × 2
 * lamports ≈ 0.00174 SOL — refundable in principle, charged on top of the
 * one-time fee on the FIRST bet only. Shown as its own line so the wallet
 * prompt is never a surprise.
 */
export const PROFILE_RENT_ESTIMATE_LAMPORTS = 1_740_000n;

export type DepositValidation =
  | { ok: true; lamports: bigint }
  | { ok: false; reason: "empty" | "parse" | "min" | "balance"; message: string };

export function validateDeposit(
  input: string,
  minLamports: bigint | null,
  balanceLamports: bigint | null,
  /** Extra first-bet costs (account fee + profile rent) held aside too. */
  firstBetExtraLamports = 0n,
): DepositValidation {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { ok: false, reason: "empty", message: "enter an amount" };
  }
  const lamports = parseSolToLamports(trimmed);
  if (lamports === null) {
    return { ok: false, reason: "parse", message: "up to 9 decimals, digits only" };
  }
  if (minLamports !== null && lamports < minLamports) {
    return {
      ok: false,
      reason: "min",
      message: `minimum deposit is ${formatSolCompact(minLamports)} SOL`,
    };
  }
  if (
    balanceLamports !== null &&
    lamports + DEPOSIT_RESERVE_LAMPORTS + firstBetExtraLamports > balanceLamports
  ) {
    return {
      ok: false,
      reason: "balance",
      message:
        firstBetExtraLamports > 0n
          ? `insufficient balance for a first bet (keep ${formatSolCompact(DEPOSIT_RESERVE_LAMPORTS + firstBetExtraLamports)} SOL for the one-time fee, rent & fees)`
          : `insufficient balance (keep ${formatSolCompact(DEPOSIT_RESERVE_LAMPORTS)} SOL for rent & fees)`,
    };
  }
  return { ok: true, lamports };
}

/**
 * Total lamports the wallet already has in this round's book — BOTH
 * identities: the wallet's manual deposits and its escrow's auto-deposits
 * count as the player's stake (Phase 10 dual identity).
 */
export function sumPlayerLamports(
  entries: readonly { player: string; amountLamports: bigint }[],
  player: string | null,
): bigint {
  if (player === null) return 0n;
  let sum = 0n;
  for (const entry of entries) {
    if (isMyKey(entry.player, player)) sum += entry.amountLamports;
  }
  return sum;
}

export function DepositPanel() {
  const { state } = useRoundData();
  const { round, entries, config } = state;
  const viewed = useViewedWallet();
  const walletModal = useWalletModal();
  const { balanceLamports } = useWalletBalance();
  const { deposit, pending } = useDeposit();
  const { client } = useOrbitClient();
  const [input, setInput] = useState("");
  // Phase 11.6 (D1): probe for the player profile — a first-ever bet pays
  // the one-time account-open fee + the escrow rent on top of the stake,
  // and the panel must say so BEFORE the wallet prompt, as separate lines.
  const [profileExists, setProfileExists] = useState<boolean | null>(null);
  const walletKey = viewed.publicKey;
  useEffect(() => {
    let alive = true;
    if (walletKey === null) {
      setProfileExists(null);
      return;
    }
    void client.connection
      .getAccountInfo(escrowKey(walletKey))
      .then((info) => {
        if (alive) setProfileExists(info !== null);
      })
      .catch(() => {
        if (alive) setProfileExists(null); // unknown — suppress the disclosure
      });
    return () => {
      alive = false;
    };
  }, [client, walletKey]);

  const open = round?.state === "open";
  const paused = config?.paused === true;
  const disabled = !open || paused;
  const minLamports = config?.minDepositLamports ?? null;
  const isFirstBet = profileExists === false;

  const validation = useMemo(
    () =>
      validateDeposit(
        input,
        open ? minLamports : null,
        balanceLamports,
        isFirstBet ? (config?.accountOpenFeeLamports ?? 0n) + PROFILE_RENT_ESTIMATE_LAMPORTS : 0n,
      ),
    [input, minLamports, balanceLamports, open, isFirstBet, config],
  );

  const existingLamports = useMemo(
    () => sumPlayerLamports(entries, viewed.publicKey?.toString() ?? null),
    [entries, viewed.publicKey],
  );
  const staked = validation.ok ? validation.lamports : 0n;
  const bps = useMemo(
    () => winProbabilityBps(staked, existingLamports, round?.totalLamports ?? 0n),
    [staked, existingLamports, round?.totalLamports],
  );
  // The Phase 11 deal, stated exactly: the 89% refund this stake would
  // draw from the round's refund pool (SDK pro-rata math, never a float
  // percentage), and the first-bet cost breakdown as three honest lines.
  const projectedRefund = useMemo(() => {
    if (staked === 0n || config === null) return 0n;
    // While the round is open the pool doesn't exist yet — project it as
    // the residual of (pot + this stake) under the config's four-way split.
    const potAfter = (round?.totalLamports ?? 0n) + staked;
    if (potAfter === 0n) return 0n;
    const winner = (potAfter * BigInt(config.winnerBps)) / 10_000n;
    const admin = (potAfter * BigInt(config.feeBpsAdmin)) / 10_000n;
    const mega = (potAfter * BigInt(config.feeBpsMega)) / 10_000n;
    return entryShare(staked, potAfter - winner - admin - mega, potAfter);
  }, [staked, round?.totalLamports, config]);
  // What this stake collects in total if it wins at the current pot —
  // under v3 always more than the stake (the rake falls on the losers).
  const projectedWin = useMemo(() => {
    if (staked === 0n || config === null) return 0n;
    const potAfter = (round?.totalLamports ?? 0n) + staked;
    return winnerTakeHome(
      config.economicsVersion,
      potAfter,
      staked,
      config.winnerBps,
      config.feeBpsAdmin,
      config.feeBpsMega,
    );
  }, [staked, round?.totalLamports, config]);
  const openFee = isFirstBet ? config?.accountOpenFeeLamports ?? 0n : 0n;

  const submit = (): void => {
    // No wallet yet? The form is still fully explorable — connecting is
    // deferred to the point of action (the submit button opens the
    // wallet modal).
    if (viewed.publicKey === null) {
      walletModal.setVisible(true);
      return;
    }
    if (validation.ok) {
      void deposit(validation.lamports).then((sent) => {
        if (sent) setInput("");
      });
    }
  };

  return (
    <section className="rounded-2xl border border-orbit-line bg-orbit-panel/60 p-4">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-display text-sm font-semibold tracking-wide">
          <Coins className="size-4 text-orbit-text" /> DEPOSIT
        </h2>
        {balanceLamports !== null && (
          <span className="num text-[11px] text-orbit-muted">
            balance {formatSolCompact(balanceLamports)} SOL
          </span>
        )}
      </header>

      {/* The full form always renders — no wallet required to compose.
          The submit button doubles as the connect CTA. */}
      <div className="space-y-3">
          <QuickAmounts disabled={disabled} onAdd={(add) => setInput((cur) => addSolToInput(cur, add))} />

          <div className="relative">
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder={`custom SOL${minLamports !== null ? ` · min ${formatSolCompact(minLamports)}` : ""}`}
              value={input}
              disabled={disabled}
              onChange={(e) => setInput(e.target.value.replace(/[^\d.]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              className="num w-full rounded-xl border border-orbit-line bg-orbit-panel-2 px-3.5 py-2.5 text-sm text-orbit-text placeholder:text-orbit-disabled focus:border-orbit-muted focus:outline-none disabled:cursor-not-allowed disabled:text-orbit-disabled disabled:opacity-60"
            />
            <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-[11px] text-orbit-muted">
              SOL
            </span>
          </div>

          <WinProbability bps={bps} />

          {/* The soft-jackpot deal: whatever happens, 89% comes back. */}
          {validation.ok && (
            <p className="num text-[11px] text-orbit-text-mid">
              you keep {formatSolCompact(projectedRefund)} SOL whatever happens · win and you
              take home {formatSolCompact(projectedWin)} SOL at the current pot
            </p>
          )}

          {/* First-ever bet: the full cost, three honest lines, BEFORE the
              wallet prompt (D1) — stake, one-time fee, refundable rent. */}
          {isFirstBet && validation.ok && (
            <div className="rounded-xl border border-orbit-line bg-orbit-panel-2/70 px-3 py-2 text-[11px]">
              <div className="mb-1 font-semibold tracking-wide text-orbit-text">
                first bet — one-time costs
              </div>
              <div className="num flex justify-between text-orbit-muted">
                <span>stake</span>
                <span>{formatSolCompact(validation.lamports)} SOL</span>
              </div>
              <div className="num flex justify-between text-orbit-muted">
                <span>account fee — one-time, seeds the jackpot</span>
                <span>{formatSolCompact(openFee)} SOL</span>
              </div>
              <div className="num flex justify-between text-orbit-muted">
                <span>account rent — refundable</span>
                <span>~{formatSolCompact(PROFILE_RENT_ESTIMATE_LAMPORTS)} SOL</span>
              </div>
            </div>
          )}

          {!validation.ok && validation.reason !== "empty" && (
            <p className="text-[11px] text-orbit-gold" role="alert">
              {validation.message}
            </p>
          )}
          {paused && (
            <p className="text-[11px] text-orbit-gold" role="alert">
              program paused — deposits closed
            </p>
          )}
          {!open && round !== null && (
            <p className="text-[11px] text-orbit-muted">
              deposit window closed ({round.state})
            </p>
          )}

          <button
            type="button"
            disabled={pending || (viewed.publicKey !== null && (disabled || !validation.ok))}
            onClick={submit}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-orbit-gold py-2.5 text-sm font-semibold text-orbit-bg transition-all hover:bg-orbit-gold-bright disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending
              ? "depositing…"
              : viewed.publicKey === null
                ? (
                  <>
                    <Wallet2 className="size-4" /> connect wallet to deposit
                  </>
                )
                : validation.ok
                  ? `deposit ${formatSolCompact(validation.lamports)} SOL`
                  : "deposit"}
          </button>
        </div>
    </section>
  );
}
