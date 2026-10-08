/**
 * Dual identity (Phase 10 design §2.1.3): a player can act as their WALLET
 * (manual deposits) or through their `PlayerEscrow` PDA (auto-deposits —
 * the entry's `player` IS the escrow). Both keys are "mine":
 *
 *   wallet ──deposit──▶ entry.player = wallet
 *   wallet ──fund──▶ escrow ──crank──▶ entry.player = escrow PDA
 *
 * The mapping is deterministic in one direction (`escrowKey(owner)`), so
 * every "is this mine?" check compares against BOTH keys. Labelling OTHER
 * people's escrow entries needs the account read (see useEscrowOwners).
 */

import { escrowKey } from "@orbit-jackpot/sdk";
import { PublicKey } from "@solana/web3.js";

/** The viewer's escrow PDA for a wallet address (base58 in, base58 out). */
export function escrowAddressOf(wallet: string): string {
  return escrowKey(new PublicKey(wallet)).toString();
}

/**
 * True when `player` is either identity of `wallet` (wallet or escrow).
 * Tolerates non-pubkey strings on EITHER side — the sparse-book sanitizer
 * routes synthetic `CLOSED_RANGE_PLAYER` markers through the same paths,
 * and fixture/test ids are not always valid base58.
 */
export function isMyKey(player: string, wallet: string | null): boolean {
  if (wallet === null) return false;
  if (player === wallet) return true;
  try {
    return player === escrowKey(new PublicKey(wallet)).toString();
  } catch {
    return false; // `wallet` is not a valid pubkey (synthetic id) — no escrow exists
  }
}

/** The entries belonging to either identity of `wallet`. */
export function myEntriesOf<T extends { player: string }>(
  entries: readonly T[],
  wallet: string | null,
): T[] {
  if (wallet === null) return [];
  return entries.filter((e) => isMyKey(e.player, wallet));
}
