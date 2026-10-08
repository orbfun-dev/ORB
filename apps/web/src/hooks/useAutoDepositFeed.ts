/**
 * `AutoDeposited` event integration (Phase 10 §6.8): instant participant
 * patches, exactly as `Deposited` — with ONE structural difference: no
 * `endTs` touch and no anti-snipe cue, because `crank_auto_deposit` never
 * extends the round (the on-chain R3, mirrored optimistically here).
 */

import type { AutoDepositedEvent } from "@orbit-jackpot/sdk";
import type { RoundDispatch } from "../context/RoundDataProvider";
import { useOrbitEventSubscription } from "../context/OrbitClientProvider";

interface UseAutoDepositFeedArgs {
  enabled: boolean;
  dispatch: RoundDispatch;
}

export function useAutoDepositFeed({ enabled, dispatch }: UseAutoDepositFeedArgs): void {
  useOrbitEventSubscription(
    "AutoDeposited",
    ({ event }) => {
      if (event.name === "AutoDeposited") dispatch({ type: "AUTO_DEPOSITED", event: event.data as AutoDepositedEvent });
    },
    { enabled },
  );
}
