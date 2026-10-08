/**
 * Live participants feed. Colors come from the SDK's own
 * `calculateWheelSlices` — the feed recomputes the identical slice table
 * the wheel renders, so row colors and arcs are the same computation, not
 * a parallel palette mapping. The connected (or dev-overridden) wallet's
 * entries are highlighted; after settlement the integer-decided winner
 * row is crowned.
 */

import { useMemo } from "react";
import { findWinningEntry, type PlayerEntryData } from "@orbit-jackpot/sdk";
import { Users } from "lucide-react";
import { useRoundData } from "../../context/RoundDataProvider";
import { useViewedWallet } from "../../hooks/useViewedWallet";
import { useEscrowOwners } from "../../hooks/useEscrowOwners";
import { escrowAddressOf, isMyKey } from "../../lib/identity";
import { safeWheelSlices } from "../../lib/book";
import { ParticipantRow } from "./ParticipantRow";

export function ParticipantsFeed() {
  const { state } = useRoundData();
  const { round, entries, lastSettlement } = state;
  const viewed = useViewedWallet();
  const me = viewed.publicKey?.toString() ?? null;
  const live = state.mode === "live";

  // Escrow-funded participants resolve to their OWNER wallets (chunked
  // read, cached); the viewer's own escrow resolves locally — the
  // deterministic direction of the escrow↔owner mapping.
  const ownerByEscrow = useEscrowOwners(entries.map((e) => e.player), live);
  const meEscrow = me !== null ? escrowAddressOf(me) : null;
  const labelOf = (player: string): string | null => {
    if (player === me || player === meEscrow) return me; // dual identity
    const resolved = ownerByEscrow.get(player);
    return resolved !== undefined && resolved !== player ? resolved : null;
  };

  // Book-anchored slice table (see lib/book.ts): the same sanitized
  // computation the wheel renders, so row colors and arcs agree even when
  // refunds/closes have punched gaps in the book.
  const wheel = useMemo(() => safeWheelSlices(entries), [entries]);
  const total = wheel?.total ?? 0n;

  // entryIndex → wheel color (same computation the wheel runs).
  const colorByIndex = useMemo(() => {
    if (wheel === null) return new Map<number, string>();
    return new Map(
      wheel.slices
        .filter((slice) => !wheel.fillerIndexes.has(slice.entryIndex))
        .map((slice) => [slice.entryIndex, slice.color]),
    );
  }, [wheel]);

  // A settlement crowns a row only in ITS OWN round's book. The keeper's
  // settle lands ~30 s after the next round opened, and reading the old
  // round's ticket against the new book crowned a random new depositor.
  const ownSettlement =
    lastSettlement !== null && round !== null && lastSettlement.event.roundId === round.roundId
      ? lastSettlement
      : null;
  const winner = useMemo<PlayerEntryData | null>(() => {
    const ticket =
      ownSettlement !== null
        ? ownSettlement.event.winningTicket
        : round?.state === "settled"
          ? round.winningTicket
          : null;
    return ticket !== null && entries.length > 0 ? findWinningEntry(entries, ticket) : null;
  }, [entries, ownSettlement, round?.state, round?.winningTicket]);

  const showWinner = (ownSettlement !== null || round?.state === "settled") && winner !== null;

  return (
    <section className="panel flex min-h-0 flex-col p-4">
      <header className="mb-3 flex items-center justify-between gap-2 border-b border-orbit-line/70 pb-3">
        <h2 className="flex items-center gap-2 text-[13px] font-bold tracking-[0.1em] text-orbit-text">
          <Users className="size-4 text-orbit-cyan" /> PLAYERS
        </h2>
        <span className="num shrink-0 rounded-full border border-orbit-line bg-orbit-bg/60 px-2 py-0.5 text-[10px] font-semibold text-orbit-text-mid">
          {entries.length}
          {round !== null && round.entryCount > entries.length ? `/${round.entryCount}` : ""} entries
        </span>
      </header>

      {entries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-orbit-line bg-orbit-bg/30 px-3 py-7 text-center text-xs text-orbit-muted">
          no deposits yet —{" "}
          <span className="font-semibold text-orbit-text-mid">be the first on the wheel</span>
        </p>
      ) : (
        // Scroll region, with the list fading out at the top edge rather
        // than being guillotined by the header.
        <ol className="-mr-1 flex max-h-96 flex-col gap-1.5 overflow-y-auto pr-1">
          {entries.map((entry, i) => (
            <ParticipantRow
              key={`${entry.roundId.toString()}-${entry.entryIndex}`}
              // Staggered arrival, capped: a book of forty entries must not
              // take four seconds to finish appearing.
              delayMs={Math.min(i, 8) * 45}
              entry={entry}
              color={colorByIndex.get(entry.entryIndex) ?? "#8b8ba7"}
              totalLamports={total}
              isYou={isMyKey(entry.player, me)}
              isAuto={entry.player === meEscrow || (ownerByEscrow.get(entry.player) !== undefined && ownerByEscrow.get(entry.player) !== entry.player)}
              label={labelOf(entry.player)}
              isWinner={showWinner && winner !== null && winner.entryIndex === entry.entryIndex}
              refundPool={round?.state === "settled" ? round.refundPool : undefined}
              megaFieldPool={round?.state === "settled" ? round.megaFieldPool : undefined}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
