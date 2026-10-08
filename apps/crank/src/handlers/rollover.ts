/**
 * Round rollover: keep exactly one `Open` round accepting deposits.
 *
 * `open_round` is permissionless and only needs the previous (active)
 * round to have left `Open` — the protocol intentionally lets round N+1
 * collect deposits while N settles. The active round is presented as the
 * fail-closed tail account; when no round ever opened (or the newest was
 * fully closed and retired), the tail is omitted entirely.
 */

import { roundKey, type GlobalConfigData, type RoundData } from "@orbit-jackpot/sdk";
import type { CrankAction } from "../actions";
import type { HandlerCtx } from "../context";

export function evalRollover(
  ctx: HandlerCtx,
  config: GlobalConfigData,
  activeRound: RoundData | null,
): CrankAction | null {
  if (config.paused) return null;
  if (activeRound !== null && activeRound.state === "open") return null;

  const nextId = config.nextRoundId;
  const previous =
    activeRound !== null && config.activeRoundId !== nextId
      ? roundKey(config.activeRoundId)
      : undefined;
  const keeper = ctx.keeper;
  return {
    kind: "open_round",
    // The round being opened — the post-action refresh must read THIS
    // account (it did not exist when the tick's snapshots were taken).
    roundId: nextId,
    label: `open_round ${nextId}`,
    build: () => ctx.client.buildOpenRoundTx(keeper.publicKey, nextId, previous),
  };
}
