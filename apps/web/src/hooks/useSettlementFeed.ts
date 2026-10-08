/**
 * Lifecycle event feed: everything that moves the round state machine.
 *
 * `RoundSettled` is the wheel's spin trigger (with `MegaPotTriggered`
 * riding the same transaction for the celebration); the lifecycle events
 * cover lock, rollover, terminal cancel, and claim dismissal. All events
 * dispatch — the reducer decides relevance by round id.
 */

import type { RoundDispatch } from "../context/RoundDataProvider";
import { useOrbitEventSubscription } from "../context/OrbitClientProvider";

interface UseSettlementFeedArgs {
  enabled: boolean;
  dispatch: RoundDispatch;
}

export function useSettlementFeed({ enabled, dispatch }: UseSettlementFeedArgs): void {
  useOrbitEventSubscription(
    "RoundSettled",
    ({ event }) => {
      if (event.name === "RoundSettled") dispatch({ type: "ROUND_SETTLED", event: event.data });
    },
    { enabled },
  );
  useOrbitEventSubscription(
    "MegaPotTriggered",
    ({ event }) => {
      if (event.name === "MegaPotTriggered") {
        dispatch({ type: "MEGA_POT_TRIGGERED", event: event.data });
      }
    },
    { enabled },
  );
  useOrbitEventSubscription(
    "RoundLocked",
    ({ event }) => {
      if (event.name === "RoundLocked") dispatch({ type: "ROUND_LOCKED", event: event.data });
    },
    { enabled },
  );
  useOrbitEventSubscription(
    "RoundOpened",
    ({ event }) => {
      if (event.name === "RoundOpened") dispatch({ type: "ROUND_OPENED", event: event.data });
    },
    { enabled },
  );
  useOrbitEventSubscription(
    "RoundCancelled",
    ({ event }) => {
      if (event.name === "RoundCancelled") {
        dispatch({ type: "ROUND_CANCELLED", event: event.data });
      }
    },
    { enabled },
  );
  useOrbitEventSubscription(
    "PrizeClaimed",
    ({ event }) => {
      if (event.name === "PrizeClaimed") dispatch({ type: "PRIZE_CLAIMED", event: event.data });
    },
    { enabled },
  );
  // The refund book's heartbeat: every `close_entry` (keeper batch or the
  // player's own click) announces the entry it paid, letting the reducer
  // prune that entry from the round's refund record — including records of
  // rounds that rolled over long ago.
  useOrbitEventSubscription(
    "EntryRefundPaid",
    ({ event }) => {
      if (event.name === "EntryRefundPaid") {
        dispatch({ type: "ENTRY_REFUND_PAID", event: event.data });
      }
    },
    { enabled },
  );
  // The cancelled book's heartbeat: `refund_entry` pays a full stake back
  // and closes the entry in one shot. The reducer moves that entry to the
  // round's receipt, so the row stops asking for a click and starts
  // saying where the money landed.
  useOrbitEventSubscription(
    "EntryRefunded",
    ({ event }) => {
      if (event.name === "EntryRefunded") {
        dispatch({ type: "ENTRY_REFUNDED", event: event.data, nowMs: Date.now() });
      }
    },
    { enabled },
  );
}
