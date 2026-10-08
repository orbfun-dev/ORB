/**
 * The current Round account (same snapshot query as useOreBoard — no extra
 * polling). Also exposes the DEPLOYED headline, summed in integer math.
 */

import type { OreRound } from "../codec";
import { sumRoundDeployed } from "../codec";
import { useOreSnapshot } from "./useOreBoard";

export interface OreRoundView {
  status: "loading" | "error" | "ready";
  round: OreRound | null;
  roundId: bigint | null;
  /** `sum(round.deployed)` — the headline pot, in lamports. */
  deployedTotalLamports: bigint | null;
}

export function useOreRound(): OreRoundView {
  const { data, status } = useOreSnapshot();
  return {
    status: status === "success" ? "ready" : status === "error" ? "error" : "loading",
    round: data?.round ?? null,
    roundId: data?.board.roundId ?? null,
    deployedTotalLamports:
      data?.round != null ? sumRoundDeployed(data.round) : null,
  };
}
