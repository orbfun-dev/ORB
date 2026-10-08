/**
 * The ORE Lite page. Composes the hooks into the §6 state machine; every
 * number shown comes from `planDeploy` or a decoded account — no component
 * recomputes economics.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { Layers, Skull } from "lucide-react";
import { ORE_AUTOJOIN, PLATFORM_FEE } from "../config";
import type { FeeSpeed } from "../client";
import { estimateNetworkFeeLamports } from "../fee";
import { formatOre, formatSol, parseSolToLamports } from "../format";
import {
  ALL_SQUARES_MASK,
  CHECKPOINT_FEE_LAMPORTS,
  computeMaxTotalLamports,
  MINER_RENT_LAMPORTS,
  planAutomation,
  planDeploy,
} from "../planner";
import { useOreBoard } from "../hooks/useOreBoard";
import { useLiveSlot } from "../hooks/useLiveSlot";
import { useOreMiner } from "../hooks/useOreMiner";
import { useOreRound } from "../hooks/useOreRound";
import { useOreAutomate } from "../hooks/useOreAutomate";
import { useOreDeploy } from "../hooks/useOreDeploy";
import { AmountInput } from "./AmountInput";
import { AutomationSetup } from "./AutomationSetup";
import { AutomationStatus } from "./AutomationStatus";
import { ClaimPanel } from "./ClaimPanel";
import { DeployButton, type PageState } from "./DeployButton";
import { MineBillboard } from "./MineBillboard";
import { OreMark, SolMark } from "./TokenMarks";
import { roundPhase, RoundTimer } from "./RoundTimer";

/** Re-reads of the board while the next round is due but not yet counting. */
const NEXT_ROUND_RETRIES = 8;
const NEXT_ROUND_RETRY_MS = 1_000;

/**
 * A token amount led by its mark instead of a ticker suffix. The symbol
 * stays in the accessible name; only the glyph replaces it visually.
 */
function TokenAmount({ token, amount }: { token: "SOL" | "ORE"; amount: string }) {
  const Mark = token === "SOL" ? SolMark : OreMark;
  return (
    <>
      <Mark className="size-4 shrink-0 sm:size-6" />
      {amount}
      <span className="sr-only"> {token}</span>
    </>
  );
}

function HeadlineCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1 panel px-2 py-4 sm:px-4 sm:py-5">
      <span className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.14em] text-orbit-muted sm:text-[10px] sm:tracking-[0.22em]">
        {icon}
        {label}
      </span>
      <span className="num flex items-center gap-1.5 text-base font-semibold tabular-nums sm:gap-2 sm:text-2xl">
        {value}
      </span>
      {sub !== undefined && (
        <span className="hidden text-[11px] text-orbit-muted sm:block">{sub}</span>
      )}
    </div>
  );
}

export function OreLiteMiner() {
  // Restored on leave: this is one tab of the shared shell now, and the
  // other pages never set a title of their own.
  useEffect(() => {
    const previous = document.title;
    document.title = "ORE Lite · ORB";
    return () => {
      document.title = previous;
    };
  }, []);

  const { connected, publicKey } = useWallet();
  const boardView = useOreBoard();
  const { deployedTotalLamports } = useOreRound();
  const { miner, automation, balanceLamports } = useOreMiner();
  const deploy = useOreDeploy();
  // Estimated between polls so the timer and the open/intermission flip
  // are on time, not up to one poll late (liveSlot.ts).
  const liveSlot = useLiveSlot();
  const slot = liveSlot.slot ?? boardView.slot;

  // Refetch the board the moment the round ends and again when the next
  // one is due, instead of waiting out the 5 s poll — otherwise the timer
  // sits at 00:00 (or "—:—") until the poll happens to land.
  const queryClient = useQueryClient();
  const boundary = useMemo(() => {
    const b = boardView.board;
    if (b === null || slot === null) return null;
    const phase = roundPhase(b, slot);
    if (phase === "waiting-first-deploy") return "awaiting-first-deploy";
    if (phase !== "intermission") return null;
    const intermission = boardView.config?.intermissionSlots ?? 48n;
    return slot >= b.endSlot + intermission ? "next-round-due" : "round-ended";
  }, [boardView.board, boardView.config, slot]);
  const lastBoundary = useRef(boundary);
  useEffect(() => {
    if (boundary !== null && boundary !== lastBoundary.current) {
      void queryClient.invalidateQueries({ queryKey: ["ore-lite", "snapshot"] });
    }
    lastBoundary.current = boundary;
  }, [boundary, queryClient]);
  // The chain opens the next round a beat after it is due, and its clock
  // starts only at the first deploy, so the first read often shows the old
  // board or a round with no end slot yet. Re-read once a second (at most
  // NEXT_ROUND_RETRIES times) until it moves on — leaving that state
  // clears this interval. A quiet round with no deployer falls back to
  // the normal 5 s poll.
  useEffect(() => {
    if (boundary !== "next-round-due" && boundary !== "awaiting-first-deploy") return;
    let tries = 0;
    const id = setInterval(() => {
      if (++tries > NEXT_ROUND_RETRIES) return clearInterval(id);
      void queryClient.invalidateQueries({ queryKey: ["ore-lite", "snapshot"] });
    }, NEXT_ROUND_RETRY_MS);
    return () => clearInterval(id);
  }, [boundary, queryClient]);

  const [amount, setAmount] = useState("");
  // Priority-fee speed UI removed by user directive — deploys always send
  // at Normal; the planner and submitDeploy still consume the value.
  const speed: FeeSpeed = 1;
  const [rounds, setRounds] = useState(1);
  const automate = useOreAutomate();

  const requestedTotal = parseSolToLamports(amount.trim());
  const amountInvalid = amount.trim() !== "" && requestedTotal === null;

  // Auto-join (multi-round Automate): dark unless the executor pubkey is
  // configured (P5 gate). rounds = 1 keeps the single-round user-signed
  // path; rounds > 1 switches the card to the commitment flow. While an
  // automation exists the whole card is replaced by its status panel.
  const commitmentMode =
    ORE_AUTOJOIN.enabled && automation === null && rounds > 1 && connected && requestedTotal !== null;

  // The card's one editable figure is the TOTAL across all rounds — the
  // commitment flow's per-round figure is derived (total ÷ rounds), the
  // same division the PER ROUND row displays.
  const automationPlan = useMemo(() => {
    if (!ORE_AUTOJOIN.enabled || automation !== null || rounds <= 1 || requestedTotal === null) {
      return null;
    }
    return planAutomation({
      requestedTotalPerRound: requestedTotal / BigInt(rounds),
      rounds,
      minerExists: miner !== null,
      minerCheckpointFee: miner?.checkpointFee ?? 0n,
      walletBalanceLamports: balanceLamports,
      feeRecipientExists: boardView.feeRecipientExists ?? undefined,
      fee: PLATFORM_FEE,
    });
  }, [
    ORE_AUTOJOIN.enabled,
    automation,
    balanceLamports,
    boardView.feeRecipientExists,
    miner,
    requestedTotal,
    rounds,
  ]);

  // Pre-simulation network-fee estimate for planning/MAX (150k CU @ 1M
  // µlamports ≈ 0.000155 SOL); the real figure is set at send time.
  const networkFeeEstimate = useMemo(
    () => estimateNetworkFeeLamports(150_000 * speed, 1_000_000),
    [speed],
  );

  const plan = useMemo(() => {
    if (boardView.board === null || requestedTotal === null || slot === null) return null;
    return planDeploy({
      board: boardView.board,
      miner,
      automation,
      currentSlot: slot,
      // Deploy All: no selectedSquares — the planner defaults to the
      // whole board minus this round's own occupancy (R3 filter).
      requestedTotalLamports: requestedTotal,
      walletBalanceLamports: balanceLamports,
      feeRecipientExists: boardView.feeRecipientExists ?? undefined,
      fee: PLATFORM_FEE,
      networkFeeLamports: networkFeeEstimate,
    });
  }, [
    automation,
    balanceLamports,
    boardView.board,
    boardView.feeRecipientExists,
    miner,
    networkFeeEstimate,
    requestedTotal,
    slot,
  ]);

  const maxTotal = useMemo(() => {
    if (!connected) return null;
    return computeMaxTotalLamports({
      walletBalanceLamports: balanceLamports,
      fee: PLATFORM_FEE,
      checkpointFee: miner === null || miner.checkpointFee === 0n ? CHECKPOINT_FEE_LAMPORTS : 0n,
      minerRent: miner === null ? MINER_RENT_LAMPORTS : 0n,
      networkFeeLamports: networkFeeEstimate,
    });
  }, [balanceLamports, connected, miner, networkFeeEstimate]);

  const board = boardView.board;
  let pageState: PageState;
  if (boardView.status === "pending") pageState = "LOADING";
  else if (boardView.status === "error" || board === null) pageState = "ERROR";
  else if (!connected || publicKey === null) pageState = "WALLET_DISCONNECTED";
  else if (roundPhase(board, slot) === "intermission") pageState = "INTERMISSION";
  else if (requestedTotal === null) pageState = "AMOUNT_INVALID";
  else if (board.endSlot === 18_446_744_073_709_551_615n) pageState = "WAITING_FIRST_DEPLOY";
  else pageState = "OPEN";

  const canInteract =
    pageState === "OPEN" || pageState === "WAITING_FIRST_DEPLOY" || pageState === "AMOUNT_INVALID";

  const onMax = (): void => {
    if (maxTotal === null || maxTotal <= 0n) return;
    setAmount(formatSol(maxTotal, 9).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
  };

  return (
    <div className="mx-auto w-full max-w-xl">
      {/* headline readouts — mirror the reference UI */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <HeadlineCard
          label="Deployed"
          value={
            deployedTotalLamports === null ? (
              "…"
            ) : (
              <TokenAmount token="SOL" amount={formatSol(deployedTotalLamports, 2)} />
            )
          }
          sub={`Round #${boardView.board?.roundId.toString() ?? "…"}`}
          icon={<Layers className="size-3" aria-hidden />}
        />
        <HeadlineCard
          label="Motherlode"
          value={
            boardView.treasury === null ? (
              "…"
            ) : (
              <TokenAmount token="ORE" amount={formatOre(boardView.treasury.motherlode, 2)} />
            )
          }
          sub="1-in-500 rounds hit it"
          icon={<Skull className="size-3" aria-hidden />}
        />
        <div className="flex flex-col items-center justify-center gap-1 panel px-2 py-4 sm:px-4 sm:py-5">
          {board === null ? (
            <span className="num text-base font-semibold text-orbit-disabled sm:text-3xl">…</span>
          ) : (
            <RoundTimer
              board={board}
              config={boardView.config}
              slot={slot}
              clock={liveSlot.clock}
            />
          )}
        </div>
      </div>

      <MineBillboard className="mt-2 sm:mt-3" />

      {pageState === "ERROR" && (
        <div className="mt-4 rounded-2xl border border-orbit-red-bright/40 bg-orbit-panel p-4 text-sm">
          <p className="font-semibold text-orbit-red-bright">Could not read the ORE protocol</p>
          <p className="mt-1 text-xs leading-relaxed text-orbit-muted">
            {boardView.error instanceof Error
              ? boardView.error.message
              : "Unknown RPC error."}{" "}
            ORE exists only on mainnet-beta — check VITE_ORE_RPC_URL and retry.
          </p>
        </div>
      )}

      <div className="mt-4 space-y-4">
        {automation !== null ? (
          <AutomationStatus automation={automation} api={automate} />
        ) : (
          <>
            <section className="panel p-5">
              <AmountInput
                value={amount}
                onChange={setAmount}
                onMax={onMax}
                maxTotalLamports={maxTotal}
                invalid={amountInvalid}
                disabled={!canInteract && pageState !== "INTERMISSION"}
                totalLamports={requestedTotal}
                balanceLamports={connected ? balanceLamports : null}
                rounds={rounds}
                onRoundsChange={setRounds}
                roundsEnabled={ORE_AUTOJOIN.enabled}
              />
            </section>

            {commitmentMode && automationPlan !== null ? (
              <AutomationSetup
                plan={automationPlan}
                api={automate}
                onSetup={() => automate.submitSetup(automationPlan, ALL_SQUARES_MASK)}
                walletBalanceLamports={balanceLamports}
              />
            ) : (
              <DeployButton
                pageState={pageState}
                plan={plan}
                walletBalanceLamports={balanceLamports}
                phase={deploy.phase}
                phaseError={deploy.error}
                signature={deploy.signature}
                onDeploy={() => {
                  if (plan !== null && board !== null && plan.blocker === null) {
                    deploy.submitDeploy(plan, board, miner, speed);
                  }
                }}
                onReset={deploy.reset}
              />
            )}
          </>
        )}

        <ClaimPanel />
      </div>

      <p className="mx-auto mt-8 max-w-2xl text-center text-[11px] leading-relaxed text-orbit-muted">
        ORE Lite talks directly to the official ORE program on Solana mainnet — no proxy contract,
        no custodial backend. ORB charges a 1% platform fee on deploys only (bundled atomically;
        never charged on failures, never on claims). ORE round timing and settlement are governed
        by the protocol; this interface neither operates nor endorses any crank.
      </p>
    </div>
  );
}
