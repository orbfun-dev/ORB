/**
 * `Deposited` event integration: instant pot/entry updates and the
 * anti-snipe cue. The reducer filters by round and applies the optimistic
 * patch; `extended: true` (the on-chain flag emitted precisely for this
 * UI purpose) arms the clock's EXTENDED cue, and the entriesVersion bump
 * schedules the authoritative refetch.
 */

import type { RoundDispatch } from "../context/RoundDataProvider";
import { useOrbitEventSubscription } from "../context/OrbitClientProvider";

interface UseDepositFeedArgs {
  enabled: boolean;
  dispatch: RoundDispatch;
}

export function useDepositFeed({ enabled, dispatch }: UseDepositFeedArgs): void {
  useOrbitEventSubscription(
    "Deposited",
    ({ event }) => {
      if (event.name === "Deposited") dispatch({ type: "DEPOSITED", event: event.data });
    },
    { enabled },
  );
}
