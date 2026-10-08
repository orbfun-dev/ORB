/**
 * Rewards: the three balances an ORE miner holds — unrefined ORE, refined
 * ORE and SOL — and three ways to take them: Claim ORE (refined AND
 * unrefined, at a chosen %), Claim SOL, or Claim all in one signature.
 * Modeled on the official ore-starter-app rewards page; every figure is
 * the program's own math (rewards.ts). Claims carry NO platform fee —
 * feeing a user's withdrawal of their own winnings is the fastest way to
 * lose them. This decision is recorded in the feature README.
 */

import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Coins, Loader2, Wallet } from "lucide-react";
import { useOreRewards } from "../hooks/useOreRewards";
import { useOreTransaction } from "../hooks/useOreDeploy";
import { formatOre, formatSol } from "../format";
import { DENOMINATOR_BPS, previewClaimOre } from "../rewards";
import { OreMark, SolMark } from "./TokenMarks";

const ORE_BPS_OPTIONS: ReadonlyArray<{ bps: bigint; label: string }> = [
  { bps: 2_500n, label: "25%" },
  { bps: 5_000n, label: "50%" },
  { bps: 7_500n, label: "75%" },
  { bps: 10_000n, label: "MAX" },
];

type ClaimKind = "ore" | "sol" | "all";

/** Full precision, trailing zeros trimmed — dust balances must stay legible. */
const ore = (grams: bigint): string => formatOre(grams, 11).replace(/\.?0+$/, "");
const sol = (lamports: bigint): string => formatSol(lamports, 9).replace(/\.?0+$/, "");

function BalanceRow({
  mark,
  label,
  hint,
  value,
  gold = false,
}: {
  mark: React.ReactNode;
  label: string;
  hint: string;
  value: string;
  gold?: boolean;
}) {
  const empty = value === "0";
  return (
    <div className="flex items-center gap-3 py-2.5">
      {mark}
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-orbit-text-mid">{label}</div>
        <div className="text-[11px] text-orbit-muted">{hint}</div>
      </div>
      <span
        className={`num text-sm tabular-nums sm:text-base ${
          empty ? "text-orbit-disabled" : gold ? "font-semibold text-orbit-gold" : "font-semibold text-orbit-text"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

export function ClaimPanel() {
  const { publicKey } = useWallet();
  const { rewards, minerRoundId, unrecordedRoundId } = useOreRewards();
  const tx = useOreTransaction();
  const [oreBps, setOreBps] = useState<bigint>(DENOMINATOR_BPS);
  const [claiming, setClaiming] = useState<ClaimKind | null>(null);

  const solBalance = rewards?.sol ?? 0n;
  const unrefined = rewards?.unrefined ?? 0n;
  const refined = rewards?.refined ?? 0n;
  const hasOre = unrefined + refined > 0n;
  const hasClaim = solBalance > 0n || hasOre;

  const orePreview = useMemo(
    () => previewClaimOre({ refined, unrefined, bps: oreBps, totalUnclaimed: rewards?.totalUnclaimed ?? 0n }),
    [oreBps, refined, rewards?.totalUnclaimed, unrefined],
  );
  const allOrePreview = useMemo(
    () =>
      previewClaimOre({ refined, unrefined, bps: DENOMINATOR_BPS, totalUnclaimed: rewards?.totalUnclaimed ?? 0n }),
    [refined, rewards?.totalUnclaimed, unrefined],
  );

  const claim = (kind: ClaimKind): void => {
    if (publicKey === null) return;
    setClaiming(kind);
    void tx.run((c) =>
      c.buildClaimTransaction(publicKey, {
        // ClaimSOL only when the miner holds SOL; SOL that auto_return
        // sends is paid by the Checkpoint every claim starts with.
        sol: kind !== "ore" && (rewards?.solInMiner ?? 0n) > 0n,
        oreBps: kind === "sol" || !hasOre ? null : kind === "all" ? DENOMINATOR_BPS : oreBps,
        minerRoundId,
      }),
    );
  };

  const spinning = (kind: ClaimKind): boolean =>
    claiming === kind && (tx.phase === "simulating" || tx.phase === "awaiting-signature" || tx.phase === "confirming");

  return (
    <div className="panel p-5">
      <div className="mb-3 flex items-center gap-2">
        <Coins className="size-4 text-orbit-muted" aria-hidden />
        <h2 className="text-sm font-semibold">Your rewards</h2>
        <span className="ml-auto text-[10px] uppercase tracking-[0.2em] text-orbit-muted">No ORB fee</span>
      </div>

      {!hasClaim && (
        <p className="text-xs leading-relaxed text-orbit-muted">
          Winnings from your deployed squares accumulate here after each round settles. Nothing to
          claim yet{rewards === null && publicKey !== null ? " — deploy first to create your miner account." : "."}
        </p>
      )}

      {hasClaim && (
        <div className="space-y-4">
          <div className="divide-y divide-orbit-line/60 rounded-xl border border-orbit-line/70 bg-orbit-bg/30 px-3">
            <BalanceRow
              mark={<OreMark className="size-5 shrink-0" />}
              label="Unrefined ORE"
              hint="Mined · 10% refining fee when claimed"
              value={ore(unrefined)}
              gold
            />
            <BalanceRow
              mark={<OreMark className="size-5 shrink-0" />}
              label="Refined ORE"
              hint="Earned from others' refining fees · no fee"
              value={ore(refined)}
              gold
            />
            <BalanceRow
              mark={<SolMark className="size-5 shrink-0" />}
              label="SOL"
              hint="Round winnings and returned SOL"
              value={sol(solBalance)}
            />
          </div>

          {unrecordedRoundId !== null && (
            <p className="text-[11px] leading-relaxed text-orbit-muted">
              Includes round #{unrecordedRoundId.toString()} winnings the chain hasn't recorded yet — any
              claim records them first.
            </p>
          )}

          {hasOre && (
            <div className="space-y-2.5 border-t border-orbit-line pt-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-orbit-muted">
                  Claim ORE
                </span>
                <div className="flex items-center gap-1" role="group" aria-label="share of ORE to claim">
                  {ORE_BPS_OPTIONS.map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      onClick={() => setOreBps(o.bps)}
                      aria-pressed={oreBps === o.bps}
                      disabled={tx.inFlight}
                      className={`num rounded-full px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40 ${
                        oreBps === o.bps
                          ? "bg-orbit-text font-semibold text-orbit-bg"
                          : "border border-orbit-line bg-orbit-panel-2 text-orbit-text-mid"
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-orbit-muted">You receive</span>
                <span className="num font-semibold tabular-nums text-orbit-gold">{ore(orePreview.amount)} ORE</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-orbit-muted">Refining fee (10% of unrefined)</span>
                <span className="num tabular-nums text-orbit-text-mid">{ore(orePreview.fee)} ORE</span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => claim("ore")}
              disabled={tx.inFlight || !hasOre || orePreview.amount + orePreview.fee === 0n}
              className="pressable flex items-center justify-center gap-1.5 rounded-xl border border-orbit-line bg-orbit-panel-2 px-4 py-2.5 text-xs font-semibold text-orbit-text-mid hover:border-orbit-line-2 hover:bg-orbit-panel-3 hover:text-orbit-text disabled:opacity-40"
            >
              {spinning("ore") ? <Loader2 className="size-3.5 animate-spin" /> : <OreMark className="size-3.5" />}
              Claim ORE
            </button>
            <button
              type="button"
              onClick={() => claim("sol")}
              disabled={tx.inFlight || solBalance === 0n}
              className="pressable flex items-center justify-center gap-1.5 rounded-xl border border-orbit-line bg-orbit-panel-2 px-4 py-2.5 text-xs font-semibold text-orbit-text-mid hover:border-orbit-line-2 hover:bg-orbit-panel-3 hover:text-orbit-text disabled:opacity-40"
            >
              {spinning("sol") ? <Loader2 className="size-3.5 animate-spin" /> : <SolMark className="size-3.5" />}
              Claim SOL
            </button>
          </div>

          <button
            type="button"
            onClick={() => claim("all")}
            disabled={tx.inFlight}
            className="pressable flex w-full flex-col items-center gap-0.5 rounded-xl bg-gradient-to-b from-orbit-gold-bright via-orbit-gold to-[#c88f24] px-4 py-2.5 text-orbit-void shadow-[inset_0_1px_0_0_rgba(255,255,255,0.4),0_10px_24px_-12px_rgba(242,181,68,0.55)] hover:brightness-[1.07] disabled:opacity-40 disabled:shadow-none"
          >
            <span className="flex items-center gap-1.5 text-sm font-bold">
              {spinning("all") ? <Loader2 className="size-4 animate-spin" /> : <Wallet className="size-4" />}
              Claim all
            </span>
            <span className="num text-[10px] font-medium tabular-nums opacity-75">
              {[solBalance > 0n && `${sol(solBalance)} SOL`, hasOre && `${ore(allOrePreview.amount)} ORE`]
                .filter(Boolean)
                .join(" + ")}
            </span>
          </button>

          {tx.phase !== "idle" && (
            <p
              className={`text-xs ${
                tx.phase === "confirmed"
                  ? "text-orbit-green"
                  : tx.phase === "expired"
                    ? "text-orbit-gold"
                    : tx.phase === "failed"
                      ? "text-orbit-red-bright"
                      : "text-orbit-muted"
              }`}
            >
              {tx.phase === "confirmed" && "Claimed."}
              {tx.phase === "expired" && "Expired — nothing was spent. Try again."}
              {tx.phase === "failed" && (tx.error ?? "Claim failed.")}
              {tx.phase === "simulating" && "Simulating claim…"}
              {tx.phase === "awaiting-signature" && "Approve in your wallet…"}
              {tx.phase === "confirming" && "Confirming…"}
              {tx.signature !== null && tx.phase === "confirmed" && (
                <>
                  {" "}
                  <a
                    className="underline decoration-dotted underline-offset-2"
                    href={`https://solscan.io/tx/${tx.signature}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Solscan
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
