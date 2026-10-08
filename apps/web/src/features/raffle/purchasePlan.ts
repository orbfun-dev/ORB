/**
 * How many entries a wallet may buy right now — pure, so the money rule
 * is testable without a wallet or a network.
 *
 * The server prices a purchase from the SOL that actually moved and then
 * clamps it to the R7 ceilings (25 per wallet, 30% of the epoch). SOL
 * sent past a ceiling buys nothing and is not refunded. So the card must
 * never offer a count the server would clamp: every limb of the ceiling
 * is applied HERE, before anyone signs, and re-applied on fresh status
 * just before the transfer is built.
 */

import type { PurchaseTerms, RaffleEpoch } from "./api";

/**
 * Buying pauses this long before the epoch's scheduled end. A transfer
 * is only counted once FINALIZED and then posted by the page; one that
 * finalizes after the lock earns nothing, so the last minutes are not
 * worth the risk to the buyer.
 */
export const CLOSING_MARGIN_MS = 10 * 60_000;

export type BuyBlocker =
  | "epoch-closed" // locked/drawn, or the pool itself is full
  | "closing-soon" // inside CLOSING_MARGIN_MS of endsAt
  | "share-full" // bought entries hit the epoch's purchase share
  | "wallet-full"; // this wallet hit its per-wallet ceiling

export interface BuyLimit {
  /** The largest count the server would award in full. 0 when blocked. */
  max: number;
  blocker: BuyBlocker | null;
  /** Purchases this wallet has left under its own ceiling. */
  walletLeft: number;
  /** Purchases left in the epoch's shared purchase allowance. */
  shareLeft: number;
}

export function buyLimit(
  terms: PurchaseTerms,
  epoch: RaffleEpoch,
  walletBought: number,
  nowMs: number,
): BuyLimit {
  const walletLeft = Math.max(0, terms.perWalletCap - walletBought);
  const shareLeft = Math.max(0, epoch.purchaseCap - epoch.purchasedIssued);
  const poolLeft = Math.max(0, epoch.cap - epoch.entriesIssued);
  const blocked = (blocker: BuyBlocker): BuyLimit => ({ max: 0, blocker, walletLeft, shareLeft });

  if (epoch.status !== "open" || poolLeft === 0) return blocked("epoch-closed");
  const endsAt = new Date(epoch.endsAt).getTime();
  if (Number.isNaN(endsAt) || endsAt - nowMs < CLOSING_MARGIN_MS) return blocked("closing-soon");
  if (shareLeft === 0) return blocked("share-full");
  if (walletLeft === 0) return blocked("wallet-full");

  return { max: Math.min(walletLeft, shareLeft, poolLeft), blocker: null, walletLeft, shareLeft };
}

/** The picker's value pulled into [1, max] (or 0 when nothing is buyable). */
export function clampCount(count: number, max: number): number {
  if (max <= 0) return 0;
  if (!Number.isFinite(count)) return 1;
  return Math.min(max, Math.max(1, Math.floor(count)));
}

/** Exact lamports for `count` entries — bigint so no price ever rounds. */
export function purchaseLamports(terms: PurchaseTerms, count: number): bigint {
  return BigInt(terms.priceLamports) * BigInt(count);
}
