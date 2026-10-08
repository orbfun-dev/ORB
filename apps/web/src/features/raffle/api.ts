/**
 * The raffle's HTTP client — the browser's ONLY contact with the entry
 * ledger (R1).
 *
 * There is no database client here and there must never be one. No
 * database credential of any kind reaches this bundle — not a public
 * one, not a restricted one — because the surest way to avoid
 * misconfiguring a browser-usable key is to never issue one.
 * Everything goes through /api/raffle/*, which holds the privileged
 * key server-side.
 *
 * The P1 gate greps every file under apps/web/src for the database
 * vendor's name in any spelling, so do not write it here, including in
 * a comment. The bluntness is the point: a rule with no judgement
 * calls in it cannot be argued around at 2am.
 *
 * The write bodies carry a signature and a wallet and nothing else
 * that matters (R2). Sending an amount or an entry count is not merely
 * ignored — the server rejects the whole request with 400, so there is
 * no point adding one here.
 */

import { referralConsentMessage } from "@orbit-jackpot/sdk";

export interface RaffleEpoch {
  id: number;
  status: "open" | "locked" | "drawn";
  cap: number;
  entriesIssued: number;
  purchasedIssued: number;
  purchaseCap: number;
  startsAt: string;
  endsAt: string;
}

/** One earned source's progress toward its next entry, all in lamports. */
export interface SourceProgress {
  source: string;
  lamports: number;
  intoNext: number;
  toNext: number;
}

/**
 * Where and how to buy entries, published by the server so a cached page
 * can never pay a stale address (the card reads nothing from the bundle).
 */
export interface PurchaseTerms {
  /** The raffle treasury — the only destination a purchase counts at. */
  treasury: string;
  /** Lamports per entry (0.05 SOL by default). */
  priceLamports: number;
  /** Entries one wallet may buy per epoch. */
  perWalletCap: number;
}

export interface RaffleStatus {
  /** Absent from older servers and before the first epoch — no card then. */
  purchase?: PurchaseTerms;
  epoch: RaffleEpoch | null;
  leaderboard: Array<{ wallet: string; entries: number }>;
  wallet: {
    pubkey: string;
    total: number;
    bySource: Record<string, number>;
    /** Lamports per entry (1 SOL by default). Absent from older servers. */
    lamportsPerEntry?: number;
    /**
     * Running SOL totals per earned source this epoch, and how far each
     * is toward its next entry. Absent from older servers.
     */
    progress?: SourceProgress[];
  } | null;
}

/**
 * A purchase's real outcomes. `pending` is not a failure: the server
 * refuses to award on anything short of `finalized` commitment, so a
 * purchase sent seconds after it lands is EXPECTED to answer pending,
 * and the caller re-polls. (ORE deploys have no client-side call at
 * all — the server indexes them.)
 */
export type ClaimResult =
  | { kind: "awarded"; awarded: number }
  | { kind: "nothing"; reason: string }
  /**
   * `awarded` can be non-zero here: one transaction may carry several
   * qualifying events, and a settled one pays immediately while a
   * still-open round keeps the rest waiting. Those entries are already
   * banked — the row must say so rather than reading as a plain wait.
   */
  | { kind: "pending"; unlocksAtRound: number | null; awarded: number }
  | { kind: "error"; message: string };

async function postJson(path: string, body: unknown): Promise<{ status: number; payload: any }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  return { status: res.status, payload };
}

export async function fetchRaffleStatus(wallet: string | null): Promise<RaffleStatus> {
  const query = wallet === null ? "" : `?wallet=${encodeURIComponent(wallet)}`;
  const res = await fetch(`/api/raffle/status${query}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`raffle status: ${res.status}`);
  }
  return (await res.json()) as RaffleStatus;
}

export async function submitPurchase(signature: string, wallet: string): Promise<ClaimResult> {
  const { status, payload } = await postJson("/api/raffle/purchase", { signature, wallet });
  if (status === 202) return { kind: "pending", unlocksAtRound: null, awarded: 0 };
  if (status === 200) {
    const awarded = Number(payload?.awarded ?? 0);
    return awarded > 0
      ? { kind: "awarded", awarded }
      : { kind: "nothing", reason: String(payload?.reason ?? "cap_reached") };
  }
  return {
    kind: "error",
    message: String(payload?.message ?? payload?.error ?? `purchase failed (${status})`),
  };
}

export type BindResult = "bound" | "already_bound" | "refused";

/**
 * Ties a wallet to its referrer. First touch wins and never changes, so
 * the server demands proof that the wallet's owner consents: a signature
 * over `referralConsentMessage` (AUDIT R-3). `signMessage` is the wallet
 * adapter's; the user sees one signature prompt, no transaction.
 */
export async function bindReferral(
  wallet: string,
  ref: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<BindResult> {
  const issuedAt = new Date().toISOString();
  const message = new TextEncoder().encode(referralConsentMessage(wallet, ref, issuedAt));
  const signed = await signMessage(message);
  const signature = btoa(String.fromCharCode(...signed)); // base64, 64 bytes
  const { status, payload } = await postJson("/api/raffle/referral", { wallet, ref, issuedAt, signature });
  if (status === 200) {
    return payload?.status === "bound" ? "bound" : "already_bound";
  }
  // 400 self-referral, 409 already bound, 422 one-hop funding — all of
  // them mean the same thing to the page: stop asking.
  return "refused";
}
