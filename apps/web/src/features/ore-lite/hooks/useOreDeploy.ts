/**
 * Deploy/claim submission pipeline: build → simulate → sign → send →
 * confirm (directive §4.3). One discriminated phase drives every spinner,
 * disabled state and terminal message on the page.
 */

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { type FeeSpeed, OreClient, type PreparedTransaction } from "../client";
import type { OreBoard, OreMiner } from "../codec";
import type { DeployPlan } from "../planner";
import { useOreClient } from "./useOreBoard";

export type OreTxPhase =
  | "idle"
  | "simulating"
  | "awaiting-signature"
  | "confirming"
  | "confirmed"
  | "failed"
  | "expired";

const IN_FLIGHT: readonly OreTxPhase[] = ["simulating", "awaiting-signature", "confirming"];

export function isTxInFlight(phase: OreTxPhase): boolean {
  return IN_FLIGHT.includes(phase);
}

/** Human-readable cause — surfaces ORE program log tails, not just codes. */
function describeError(err: unknown): string {
  const withLogs = err as { logs?: string[] };
  if (withLogs?.logs?.length) {
    const tail = withLogs.logs
      .filter((line) => line.includes("Error") || line.includes("failed"))
      .slice(-2)
      .join(" · ");
    if (tail.length > 0) return `${err instanceof Error ? err.message : String(err)} — ${tail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export interface OreTransactionApi {
  phase: OreTxPhase;
  error: string | null;
  signature: string | null;
  unitsConsumed: number | null;
  inFlight: boolean;
  run: (prepare: (client: OreClient) => Promise<PreparedTransaction>) => Promise<void>;
  reset: () => void;
}

/** Shared pipeline for deploys AND claims (same shape, no fee on claims). */
export function useOreTransaction(): OreTransactionApi {
  const { publicKey, signTransaction } = useWallet();
  const client = useOreClient();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<OreTxPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [unitsConsumed, setUnitsConsumed] = useState<number | null>(null);
  const busy = useRef(false);

  const run = useCallback(
    async (prepare: (client: OreClient) => Promise<PreparedTransaction>): Promise<void> => {
      if (busy.current) return;
      if (publicKey === null) {
        setPhase("failed");
        setError("connect a wallet first");
        return;
      }
      busy.current = true;
      setPhase("simulating");
      setError(null);
      setSignature(null);
      setUnitsConsumed(null);
      try {
        const prepared = await prepare(client);
        setUnitsConsumed(prepared.unitsConsumed);
        if (signTransaction === undefined) {
          throw new Error("this wallet cannot sign versioned transactions");
        }
        setPhase("awaiting-signature");
        const signed = await signTransaction(prepared.transaction);
        setPhase("confirming");
        const sig = await client.sendSignedTransaction(
          signed,
          prepared.blockhash,
          prepared.lastValidBlockHeight,
        );
        setSignature(sig);
        setPhase("confirmed");
        // Fresh accounts for the post-deploy view (phase 3 gate).
        await queryClient.invalidateQueries({ queryKey: ["ore-lite"] });
      } catch (err) {
        const expired = err instanceof Error && err.name === "OreExpiredError";
        setPhase(expired ? "expired" : "failed");
        setError(describeError(err));
      } finally {
        busy.current = false;
      }
    },
    [client, publicKey, queryClient, signTransaction],
  );

  const reset = useCallback((): void => {
    if (!busy.current) {
      setPhase("idle");
      setError(null);
      setSignature(null);
      setUnitsConsumed(null);
    }
  }, []);

  return { phase, error, signature, unitsConsumed, inFlight: isTxInFlight(phase), run, reset };
}

export interface OreDeployApi extends OreTransactionApi {
  submitDeploy: (plan: DeployPlan, board: OreBoard, miner: OreMiner | null, speed: FeeSpeed) => void;
}

export function useOreDeploy(): OreDeployApi {
  const tx = useOreTransaction();
  const { publicKey } = useWallet();

  const submitDeploy = useCallback(
    (plan: DeployPlan, board: OreBoard, miner: OreMiner | null, speed: FeeSpeed): void => {
      if (publicKey === null) return;
      void tx.run((client) =>
        client.buildDeployTransaction({ wallet: publicKey, plan, board, miner, speed }),
      );
    },
    [publicKey, tx],
  );

  // No raffle bookkeeping here. The platform fee this deploy carries is
  // what earns raffle entries: the raffle server indexes the fee
  // wallet's history (the raffle server's ORE indexer), so a deploy
  // made on this page shows up as entries on its own, with nothing for
  // the browser to remember or submit.
  return { ...tx, submitDeploy };
}
