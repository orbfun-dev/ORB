/**
 * The permissionless community crank (Phase 12.5): when the keeper is
 * late, ANY player can advance the cheap, single-transaction steps —
 * `lock_round` on a round with money in it, `sweep_unclaimed_prize` past
 * the claim deadline, `close_round` on a fully-pruned terminal round.
 * The signer gains NOTHING (these instructions pay no one); the point is
 * liveness. Modelled closely on useCloseEntry.
 *
 * STRICT BROWSER-SAFETY RULES (R4/R6):
 *  - NEVER the Switchboard settle pipeline. For `locked` /
 *    `awaitingRandomness` rounds the UI's job is STATUS, not a button —
 *    the operator's recovery path is `npm run devnet:settle` (runbook).
 *  - An empty expired round offers nothing to a direct bettor: the program
 *    rolls its window in place on their first bet. The ONE exception is a
 *    viewer whose auto-play escrow is starving — `crank_auto_deposit`
 *    cannot roll the window, so for them the roll IS the needed action
 *    (see `hasStarvingEscrow`).
 *  - Chain time only (`state.nowMs + state.clockOffsetMs`) — a skewed
 *    local clock must not conjure a button the chain would reject — and
 *    a 20 s keeper grace past each on-chain gate, so this stays a
 *    fallback, never a race with the keeper.
 *  - `simulateTransaction` BEFORE the wallet prompt, and an exponential
 *    post-failure cooldown (5 s → 30 s → 120 s, keyed `roundId:kind`) so
 *    a failing action cannot be spam-clicked into a fee fountain.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { rentReclaimDestination, type GlobalConfigData, type RoundData } from "@orbit-jackpot/sdk";
import { useWallet } from "@solana/wallet-adapter-react";
import { useOrbitClient } from "../context/OrbitClientProvider";
import { useRoundData } from "../context/RoundDataProvider";
import { useToast } from "../context/ToastProvider";
import { confirmSignature, shortSignature } from "../lib/tx";

/** The keeper's head start on every chain-time gate. */
export const MANUAL_CRANK_GRACE_SECS = 20n;

/** Post-failure cooldown ladder (ms), keyed `${roundId}:${kind}`. */
const COOLDOWN_LADDER_MS = [5_000, 30_000, 120_000] as const;

export type ManualCrankAction =
  | { kind: "lock_round"; roundId: bigint }
  | { kind: "sweep_unclaimed_prize"; roundId: bigint }
  | { kind: "close_round"; roundId: bigint };

/** The one decision this whole feature makes — PURE, so the availability
 * matrix is unit-testable without a provider, a wallet, or a chain. */
export function manualCrankAvailability(
  round: RoundData,
  config: GlobalConfigData,
  chainNowSecs: bigint,
  /**
   * The viewer holds a funded, non-depleted auto-play escrow. This is the
   * ONE case where an empty expired round is worth cranking: `deposit`
   * revives a dead window in the bettor's own transaction
   * (deposit.rs:117-129), but `crank_auto_deposit` deliberately never
   * writes `end_ts` (crank_auto_deposit.rs:18) — so an escrow owner on an
   * idle game cannot revive it and starves until somebody rolls it. The
   * roll is `lock_round`, permissionless and pays the signer nothing
   * (lock_round.rs:61).
   */
  hasStarvingEscrow = false,
): {
  action: ManualCrankAction | null;
  because: string | null;
  /** Overrides the button's default per-kind label when the same
   *  instruction does something materially different (a window ROLL is
   *  not a window CLOSE). */
  label?: string;
} {
  const overdue = (gate: bigint): string => {
    const secs = chainNowSecs - gate;
    if (secs < 90n) return `${secs}s`;
    return `${secs / 60n}m ${secs % 60n}s`;
  };
  const none = { action: null, because: null };

  if (round.state === "open") {
    // Empty rounds offer nothing to a direct bettor: their own deposit
    // revives the window in place. An auto-play escrow owner is the
    // exception — see `hasStarvingEscrow`.
    if (round.totalLamports === 0n) {
      if (!hasStarvingEscrow) return none;
      if (chainNowSecs < round.endTs + MANUAL_CRANK_GRACE_SECS) return none;
      return {
        action: { kind: "lock_round", roundId: round.roundId },
        because:
          `this round's window died ${overdue(round.endTs)} ago with nothing in the pot, and ` +
          "your escrow cannot revive it on its own — rolling the window forward costs one " +
          "signature, pays the signer nothing, and lets your auto-play resume",
        label: "start next round",
      };
    }
    if (chainNowSecs < round.endTs + MANUAL_CRANK_GRACE_SECS) return none;
    return {
      action: { kind: "lock_round", roundId: round.roundId },
      because:
        `keeper has not locked this round for ${overdue(round.endTs)} past its window — ` +
        "closing it is permissionless and pays the signer nothing",
    };
  }

  if (round.state === "settled") {
    if (!round.prizeClaimed) {
      const deadline = round.settleTs + config.claimDeadlineSecs;
      if (chainNowSecs < deadline + MANUAL_CRANK_GRACE_SECS) return none;
      return {
        action: { kind: "sweep_unclaimed_prize", roundId: round.roundId },
        because:
          `the claim deadline lapsed ${overdue(deadline)} ago without the keeper sweeping — ` +
          "the unclaimed prize reroutes to the mega-pot; the signer is paid nothing",
      };
    }
    if (round.entriesClosed !== round.entryCount) return none;
    return {
      action: { kind: "close_round", roundId: round.roundId },
      because:
        "every entry is refunded and the round is fully pruned — closing it returns the " +
        "parked rent to whoever opened the round; the signer is paid nothing",
    };
  }

  if (round.state === "cancelled") {
    if (round.entriesClosed !== round.entryCount) return none;
    return {
      action: { kind: "close_round", roundId: round.roundId },
      because:
        "every refund is delivered and the round is fully pruned — the signer is paid nothing",
    };
  }

  // locked / awaitingRandomness: keeper-only territory (ADR-4 pipeline).
  return none;
}

/** `"Error Code: SomeAnchorError"` out of simulation logs, if present. */
function anchorErrorCode(logs: string[] | undefined | null): string | null {
  if (logs === null || logs === undefined) return null;
  for (const line of logs) {
    const hit = line.match(/Error Code: ([A-Za-z0-9_]+)/);
    if (hit !== null) return hit[1]!;
  }
  return null;
}

export function useManualCrank(
  /** See `manualCrankAvailability`'s parameter of the same name. The caller
   *  supplies it so this hook adds no account subscription of its own. */
  hasStarvingEscrow = false,
): {
  /** The single action currently available, or null. Chain-time gated. */
  available: ManualCrankAction | null;
  /** Human-readable reason the control is showing. */
  because: string | null;
  run: () => Promise<boolean>;
  pending: boolean;
  /** Seconds remaining on the post-failure cooldown, or 0. */
  cooldownSecs: number;
  /** See `manualCrankAvailability`'s `label`. */
  label?: string;
} {
  const { client } = useOrbitClient();
  const { state } = useRoundData();
  const { publicKey, connected, sendTransaction } = useWallet();
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const cooldowns = useRef(new Map<string, { untilMs: number; level: number }>());

  const round = state.round;
  const config = state.config;
  const decision = useMemo(() => {
    if (round === null || config === null) {
      return { action: null, because: null, label: undefined };
    }
    // Chain time, never local time — a skewed clock must not conjure a
    // button for a transaction the chain would reject.
    const chainNowSecs = BigInt(Math.floor((state.nowMs + state.clockOffsetMs) / 1000));
    return manualCrankAvailability(round, config, chainNowSecs, hasStarvingEscrow);
  }, [round, config, state.nowMs, state.clockOffsetMs, hasStarvingEscrow]);

  const cooldownSecs = useMemo(() => {
    if (decision.action === null) return 0;
    const key = `${decision.action.roundId}:${decision.action.kind}`;
    const cd = cooldowns.current.get(key);
    if (cd === undefined) return 0;
    return Math.max(0, Math.ceil((cd.untilMs - state.nowMs) / 1000));
  }, [decision, state.nowMs]);

  const bumpCooldown = (key: string): void => {
    const cd = cooldowns.current.get(key) ?? { untilMs: 0, level: 0 };
    const level = Math.min(cd.level, COOLDOWN_LADDER_MS.length - 1);
    cooldowns.current.set(key, {
      untilMs: Date.now() + COOLDOWN_LADDER_MS[level]!,
      level: Math.min(cd.level + 1, COOLDOWN_LADDER_MS.length - 1),
    });
  };

  const run = useCallback(async (): Promise<boolean> => {
    const action = decision.action;
    if (action === null || round === null || config === null || pending) return false;
    if (!connected || publicKey === null) {
      toast.push("warning", "connect a signing wallet to crank this step");
      return false;
    }
    const key = `${action.roundId}:${action.kind}`;
    const cd = cooldowns.current.get(key);
    if (cd !== undefined && Date.now() < cd.untilMs) return false;

    setPending(true);
    try {
      const tx = new Transaction();
      if (action.kind === "lock_round") {
        tx.add(client.buildLockRoundTx(action.roundId, publicKey));
      } else if (action.kind === "sweep_unclaimed_prize") {
        tx.add(client.buildSweepUnclaimedPrizeTx(action.roundId, publicKey));
      } else {
        tx.add(
          client.buildCloseRoundTx(
            action.roundId,
            rentReclaimDestination(round, config),
            publicKey,
          ),
        );
      }
      // Simulate BEFORE the wallet prompt: a doomed transaction should
      // never cost a signature. Anchor's named error rides the logs.
      const blockhash = await client.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash.blockhash;
      tx.feePayer = publicKey;
      const sim = await client.connection.simulateTransaction(tx);
      if (sim.value.err !== null) {
        const code = anchorErrorCode(sim.value.logs);
        toast.push(
          "error",
          `simulation rejected this ${action.kind}`,
          code ?? JSON.stringify(sim.value.err).slice(0, 160),
        );
        bumpCooldown(key);
        return false;
      }
      const signature = await sendTransaction(tx, client.connection);
      toast.push("info", `${action.kind} sent — confirming…`, shortSignature(signature));
      await confirmSignature(client.connection, signature);
      toast.push("success", `${action.kind} landed`, shortSignature(signature));
      cooldowns.current.delete(key);
      return true;
    } catch (err) {
      toast.push(
        "error",
        `${action.kind} failed`,
        err instanceof Error ? err.message.slice(0, 160) : String(err),
      );
      bumpCooldown(key);
      return false;
    } finally {
      setPending(false);
    }
  }, [client, config, connected, decision, pending, publicKey, round, sendTransaction, toast]);

  return {
    available: decision.action,
    because: decision.because,
    run,
    pending,
    cooldownSecs,
    label: decision.label,
  };
}
