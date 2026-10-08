/**
 * Typed PostgREST access to the raffle SQL (all parameters bound).
 *
 * Every mutation is a Postgres function call, so the FOR UPDATE epoch
 * lock (R6) and the award logic live in exactly one place — the SQL in
 * sql/002_functions.sql — no matter which endpoint triggers them.
 */

import type { RaffleDb } from "./db";

function fail(operation: string, error: { message: string; code?: string } | null): never {
  throw new Error(`raffle db: ${operation} failed: ${error?.message ?? "unknown"}`);
}

export interface SubmitEarnedEventArgs {
  signature: string;
  eventIndex: number;
  slot: number;
  blockTime: string | null;
  source: string;
  wallet: string;
  epochId: number;
  solLamports: number;
  lamportsPerEntry: number;
  orbRoundId?: number | null;
  status?: "accepted" | "rejected";
  rejectReason?: string | null;
  entryStatus?: "confirmed" | "provisional";
  referralMinLamports?: number;
  referralCap?: number;
}

/**
 * raffle_submit_earned_event's answer when the epoch is no longer open
 * (AUDIT R-11): nothing was written; retry against the next epoch.
 */
export const EPOCH_CLOSED = -1;

/** raffle_submit_earned_event — R5 accrual + R6 dedup + award, atomically. */
export async function submitEarnedEvent(db: RaffleDb, args: SubmitEarnedEventArgs): Promise<number> {
  const { data, error } = await db.rpc("raffle_submit_earned_event", {
    p_signature: args.signature,
    p_event_index: args.eventIndex,
    p_slot: args.slot,
    p_block_time: args.blockTime,
    p_source: args.source,
    p_wallet: args.wallet,
    p_epoch: args.epochId,
    p_sol_lamports: args.solLamports,
    p_lamports_per_entry: args.lamportsPerEntry,
    p_orb_round_id: args.orbRoundId ?? null,
    p_status: args.status ?? "accepted",
    p_reject_reason: args.rejectReason ?? null,
    p_entry_status: args.entryStatus ?? "confirmed",
    p_referral_min_lamports: args.referralMinLamports ?? 1_000_000_000,
    p_referral_cap: args.referralCap ?? 25,
  });
  if (error) fail("submit_earned_event", error);
  return Number(data ?? 0);
}

export type BindReferralResult = "bound" | "already_bound";

/** raffle_bind_referral — first touch wins, immutable (§6.3). */
export async function bindReferral(
  db: RaffleDb,
  wallet: string,
  ref: string,
): Promise<BindReferralResult> {
  const { data, error } = await db.rpc("raffle_bind_referral", {
    p_wallet: wallet,
    p_ref: ref,
  });
  if (error) fail("bind_referral", error);
  return Number(data) === 1 ? "bound" : "already_bound";
}

export interface EpochRef {
  id: number;
  cap: number;
  /** ISO start of the epoch (AUDIT R-5: earned events must postdate it). */
  startsAt?: string;
}

/** The single open epoch (raffle_current_epoch), or null between epochs. */
export async function currentOpenEpoch(db: RaffleDb): Promise<EpochRef | null> {
  const { data, error } = await db.rpc("raffle_current_epoch");
  if (error) fail("current_epoch", error);
  if (data === null || data === undefined) return null;
  const rows = await db
    .from("raffle_epochs")
    .select("id, cap, starts_at")
    .eq("id", Number(data))
    .limit(1);
  if (rows.error) fail("epoch lookup", rows.error);
  const row = rows.data?.[0];
  return row ? { id: Number(row.id), cap: Number(row.cap), startsAt: String(row.starts_at) } : null;
}

export type OrbRoundState = "open" | "locked" | "awaiting" | "settled" | "cancelled";

export interface OrbRoundRow {
  roundId: number;
  state: OrbRoundState;
  reason: number | null;
}

export async function getOrbRound(db: RaffleDb, roundId: number): Promise<OrbRoundRow | null> {
  const rows = await db
    .from("raffle_orb_rounds")
    .select("round_id, state, reason")
    .eq("round_id", roundId)
    .limit(1);
  if (rows.error) fail("orb_round lookup", rows.error);
  const row = rows.data?.[0];
  return row
    ? { roundId: Number(row.round_id), state: row.state as OrbRoundState, reason: row.reason ?? null }
    : null;
}

export async function upsertOrbRound(
  db: RaffleDb,
  roundId: number,
  state: OrbRoundState,
  reason: number | null,
  decidedAt: string | null,
  opts: { refreshSeenAt?: boolean } = {},
): Promise<void> {
  const refreshSeenAt = opts.refreshSeenAt ?? true;
  // Sentinel inserts (refreshSeenAt=false) keep their original seen_at —
  // that timestamp is how the 1-hour staleness gate is measured.
  const payload: Record<string, unknown> = refreshSeenAt
    ? { round_id: roundId, state, reason, decided_at: decidedAt, seen_at: new Date().toISOString() }
    : { round_id: roundId, state, reason, decided_at: decidedAt };
  const up = await db
    .from("raffle_orb_rounds")
    .upsert(payload, { onConflict: "round_id", ignoreDuplicates: false });
  if (up.error) fail("orb_round upsert", up.error);
}

/** Highest cached round id — the watermark the cache scans from. */
export async function maxOrbRoundId(db: RaffleDb): Promise<number | null> {
  const rows = await db
    .from("raffle_orb_rounds")
    .select("round_id")
    .order("round_id", { ascending: false })
    .limit(1);
  if (rows.error) fail("orb_round max", rows.error);
  const row = rows.data?.[0];
  return row ? Number(row.round_id) : null;
}

/**
 * Sentinel rows (`state='open'`) whose seen_at has not refreshed since
 * `cutoff` — the §6.2 step-3 candidates for the event-history fallback.
 */
export async function staleOpenOrbRounds(
  db: RaffleDb,
  cutoff: string,
  maxRoundId: number,
): Promise<Array<{ roundId: number }>> {
  const rows = await db
    .from("raffle_orb_rounds")
    .select("round_id")
    .eq("state", "open")
    .lt("seen_at", cutoff)
    .lte("round_id", maxRoundId)
    .limit(50);
  if (rows.error) fail("orb_round stale", rows.error);
  return (rows.data ?? []).map((r) => ({ roundId: Number(r.round_id) }));
}

// ─── epoch lifecycle + draw (§6.5, §6.6) ───────────────────────────────

export async function lockExpiredEpochs(db: RaffleDb): Promise<number> {
  const { data, error } = await db.rpc("raffle_lock_expired_epochs");
  if (error) fail("lock_expired_epochs", error);
  return Number(data ?? 0);
}

export async function openEpoch(
  db: RaffleDb,
  endsAtIso: string,
  cap: number,
): Promise<number> {
  const { data, error } = await db.rpc("raffle_open_epoch", {
    p_ends_at: endsAtIso,
    p_cap: cap,
  });
  if (error) fail("open_epoch", error);
  return Number(data);
}

/** Locked epochs without a draw commitment yet. */
export async function epochsAwaitingCommit(db: RaffleDb): Promise<number[]> {
  const rows = await db
    .from("raffle_epochs")
    .select("id, raffle_draws(epoch_id)")
    .eq("status", "locked")
    .limit(10);
  if (rows.error) fail("epochs_awaiting_commit", rows.error);
  return (rows.data ?? [])
    .filter((r: any) => !r.raffle_draws || r.raffle_draws.length === 0)
    .map((r: any) => Number(r.id));
}

/**
 * raffle_finalize_empty_epoch — a locked epoch with no entries becomes
 * 'drawn' with no draw row. Returns false when the epoch does not match
 * (already resolved, or it has entries), which makes the call idempotent.
 */
export async function finalizeEmptyEpoch(db: RaffleDb, epochId: number): Promise<boolean> {
  const { data, error } = await db.rpc("raffle_finalize_empty_epoch", { p_epoch: epochId });
  if (error) fail("finalize_empty_epoch", error);
  return data === true;
}

export interface EntryRow {
  entryNo: number;
  wallet: string;
}

/** The canonical entry list: entry_no ascending, all non-voided rows. */
export async function listEntries(db: RaffleDb, epochId: number): Promise<EntryRow[]> {
  const rows = await db
    .from("raffle_entries")
    .select("entry_no, wallet, status")
    .eq("epoch_id", epochId)
    .neq("status", "voided")
    .order("entry_no", { ascending: true });
  if (rows.error) fail("list_entries", rows.error);
  return (rows.data ?? []).map((r: any) => ({ entryNo: Number(r.entry_no), wallet: r.wallet }));
}

export async function entryWalletAt(
  db: RaffleDb,
  epochId: number,
  entryNo: number,
): Promise<string | null> {
  const rows = await db
    .from("raffle_entries")
    .select("wallet")
    .eq("epoch_id", epochId)
    .eq("entry_no", entryNo)
    .limit(1);
  if (rows.error) fail("entry_wallet", rows.error);
  return rows.data?.[0]?.wallet ?? null;
}

export async function recordDraw(
  db: RaffleDb,
  epochId: number,
  root: Buffer,
  targetSlot: number,
  commitSig: string,
): Promise<void> {
  const { error } = await db.rpc("raffle_record_draw", {
    p_epoch: epochId,
    p_root: "\\x" + root.toString("hex"),
    p_target_slot: targetSlot,
    p_commit_sig: commitSig,
  });
  if (error) fail("record_draw", error);
}

export interface PendingDraw {
  epochId: number;
  merkleRoot: Buffer;
  targetSlot: number;
  entriesIssued: number;
}

export async function pendingDraws(db: RaffleDb, nowSlot: number): Promise<PendingDraw[]> {
  const { data, error } = await db.rpc("raffle_draws_pending", { p_now_slot: nowSlot });
  if (error) fail("draws_pending", error);
  return (data ?? []).map((d: any) => ({
    epochId: Number(d.epoch_id),
    merkleRoot: Buffer.from(String(d.merkle_root).replace(/^\\x/, ""), "hex"),
    targetSlot: Number(d.target_slot),
    entriesIssued: Number(d.entries_issued),
  }));
}

/** AUDIT R-8 — reserve the draw row BEFORE the memo is sent. */
export async function reserveDraw(
  db: RaffleDb,
  epochId: number,
  root: Buffer,
  targetSlot: number,
  commitSig: string,
  lastValidHeight: number,
): Promise<boolean> {
  const { data, error } = await db.rpc("raffle_reserve_draw", {
    p_epoch: epochId,
    p_root: "\\x" + root.toString("hex"),
    p_target_slot: targetSlot,
    p_commit_sig: commitSig,
    p_last_valid_height: lastValidHeight,
  });
  if (error) fail("reserve_draw", error);
  return data === true;
}

export interface UnconfirmedDraw {
  epochId: number;
  merkleRoot: Buffer;
  targetSlot: number;
  commitSig: string;
  lastValidHeight: number | null;
}

export async function unconfirmedDraws(db: RaffleDb): Promise<UnconfirmedDraw[]> {
  const { data, error } = await db.rpc("raffle_draws_unconfirmed");
  if (error) fail("draws_unconfirmed", error);
  return (data ?? []).map((d: any) => ({
    epochId: Number(d.epoch_id),
    merkleRoot: Buffer.from(String(d.merkle_root).replace(/^\\x/, ""), "hex"),
    targetSlot: Number(d.target_slot),
    commitSig: String(d.commit_sig),
    lastValidHeight: d.commit_last_valid_height === null ? null : Number(d.commit_last_valid_height),
  }));
}

export async function confirmDrawCommit(db: RaffleDb, epochId: number, commitSig: string): Promise<boolean> {
  const { data, error } = await db.rpc("raffle_confirm_draw_commit", {
    p_epoch: epochId,
    p_commit_sig: commitSig,
  });
  if (error) fail("confirm_draw_commit", error);
  return data === true;
}

export async function replaceDrawCommit(
  db: RaffleDb,
  epochId: number,
  oldSig: string,
  newSig: string,
  targetSlot: number,
  lastValidHeight: number,
): Promise<boolean> {
  const { data, error } = await db.rpc("raffle_replace_draw_commit", {
    p_epoch: epochId,
    p_old_sig: oldSig,
    p_new_sig: newSig,
    p_target_slot: targetSlot,
    p_last_valid_height: lastValidHeight,
  });
  if (error) fail("replace_draw_commit", error);
  return data === true;
}

/** AUDIT R-7 — the reveal records which block (slot) it used. */
export async function recordDrawResult(
  db: RaffleDb,
  epochId: number,
  blockSlot: number,
  blockhash: string,
  winningNo: number,
  winner: string | null,
): Promise<boolean> {
  const { data, error } = await db.rpc("raffle_record_draw_result", {
    p_epoch: epochId,
    p_block_slot: blockSlot,
    p_blockhash: blockhash,
    p_winning_no: winningNo,
    p_winner: winner,
  });
  if (error) fail("record_draw_result", error);
  return data === true;
}

export async function setDrawResult(
  db: RaffleDb,
  epochId: number,
  blockhash: string,
  winningNo: number,
  winner: string | null,
): Promise<void> {
  const { error } = await db.rpc("raffle_set_draw_result", {
    p_epoch: epochId,
    p_blockhash: blockhash,
    p_winning_no: winningNo,
    p_winner: winner,
  });
  if (error) fail("set_draw_result", error);
}

// ─── public read surface (P9) ──────────────────────────────────────────

export interface EpochStatusRow {
  epochId: number;
  status: string;
  cap: number;
  entriesIssued: number;
  purchasedIssued: number;
  /** Derived with raffle_award's own cap expression — see 006_status.sql. */
  purchaseCap: number;
  startsAt: string;
  endsAt: string;
}

/** The epoch the UI should show: the open one, else the most recent. */
export async function epochStatus(db: RaffleDb): Promise<EpochStatusRow | null> {
  const { data, error } = await db.rpc("raffle_epoch_status");
  if (error) fail("epoch_status", error);
  const row = (data ?? [])[0];
  if (row === undefined) return null;
  return {
    epochId: Number(row.epoch_id),
    status: String(row.status),
    cap: Number(row.cap),
    entriesIssued: Number(row.entries_issued),
    purchasedIssued: Number(row.purchased_issued),
    purchaseCap: Number(row.purchase_cap),
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
  };
}

export async function leaderboard(
  db: RaffleDb,
  epochId: number,
  limit: number,
): Promise<Array<{ wallet: string; entries: number }>> {
  const { data, error } = await db.rpc("raffle_leaderboard", {
    p_epoch: epochId,
    p_limit: limit,
  });
  if (error) fail("leaderboard", error);
  return (data ?? []).map((r: any) => ({ wallet: r.wallet, entries: Number(r.entries) }));
}

/**
 * Entries a purchase signature already earned, or null if it was never
 * counted. Lets a repeated report answer with the truth ("this one got
 * you 5") instead of the dedup's bare 0, which reads like a refusal.
 */
export async function entriesForSignature(
  db: RaffleDb,
  signature: string,
  wallet?: string,
): Promise<number | null> {
  let query = db
    .from("raffle_events")
    .select("id")
    .eq("signature", signature)
    .eq("source", "purchase"); // AUDIT R-10: any index (legacy rows used 0)
  if (wallet !== undefined) query = query.eq("wallet", wallet);
  const events = await query.limit(1);
  if (events.error) fail("event lookup", events.error);
  const id = events.data?.[0]?.id;
  if (id === undefined || id === null) return null;
  const entries = await db
    .from("raffle_entries")
    .select("entry_no", { count: "exact", head: true })
    .eq("origin_event", id);
  if (entries.error) fail("entry count", entries.error);
  return entries.count ?? 0;
}

export async function walletSummary(
  db: RaffleDb,
  epochId: number,
  wallet: string,
): Promise<Array<{ source: string; entries: number }>> {
  const { data, error } = await db.rpc("raffle_wallet_summary", {
    p_epoch: epochId,
    p_wallet: wallet,
  });
  if (error) fail("wallet_summary", error);
  return (data ?? []).map((r: any) => ({ source: r.source, entries: Number(r.entries) }));
}

/**
 * One wallet's running SOL totals for an epoch, per earned source — the
 * raffle_progress rows R5 accrues into. Read straight from the table
 * (service role bypasses RLS); nothing here is derived.
 */
export async function walletProgress(
  db: RaffleDb,
  epochId: number,
  wallet: string,
): Promise<Array<{ source: string; lamports: number }>> {
  const rows = await db
    .from("raffle_progress")
    .select("source, cumulative_lamports")
    .eq("epoch_id", epochId)
    .eq("wallet", wallet);
  if (rows.error) fail("wallet progress", rows.error);
  return (rows.data ?? []).map((r: any) => ({
    source: String(r.source),
    lamports: Number(r.cumulative_lamports),
  }));
}

/** R8 — record a buyback transaction signature against its epoch. */
export async function recordBuyback(
  db: RaffleDb,
  epochId: number,
  signature: string,
  solIn: number,
  orbOut: string,
): Promise<void> {
  const up = await db.from("raffle_buybacks").insert({
    epoch_id: epochId,
    signature,
    sol_in: solIn,
    orb_out: orbOut,
  });
  if (up.error) fail("record_buyback", up.error);
}

// ─── ORE indexer (008) ─────────────────────────────────────────────────

export async function getIndexerCursor(
  db: RaffleDb,
  name: string,
): Promise<{ signature: string; slot: number } | null> {
  const rows = await db
    .from("raffle_indexer_cursors")
    .select("last_signature, last_slot")
    .eq("name", name)
    .limit(1);
  if (rows.error) fail("indexer cursor read", rows.error);
  const row = rows.data?.[0];
  return row ? { signature: String(row.last_signature), slot: Number(row.last_slot) } : null;
}

/** raffle_advance_indexer_cursor — forward only (overlapping runs). */
export async function advanceIndexerCursor(
  db: RaffleDb,
  name: string,
  cursor: { signature: string; slot: number },
): Promise<void> {
  const { error } = await db.rpc("raffle_advance_indexer_cursor", {
    p_name: name,
    p_signature: cursor.signature,
    p_slot: cursor.slot,
  });
  if (error) fail("advance_indexer_cursor", error);
}

/** The first epoch's start — the raffle's launch instant. */
export async function earliestEpochStart(db: RaffleDb): Promise<Date | null> {
  const rows = await db
    .from("raffle_epochs")
    .select("starts_at")
    .order("id", { ascending: true })
    .limit(1);
  if (rows.error) fail("earliest epoch", rows.error);
  const row = rows.data?.[0];
  return row ? new Date(String(row.starts_at)) : null;
}

/** AUDIT R-9 — the shared fixed-window counter (sql/010). */
export function postgrestRateLimiter(db: RaffleDb, windowSecs = 60) {
  return {
    async allow(buckets: Array<{ key: string; max: number }>): Promise<boolean> {
      const { data, error } = await db.rpc("raffle_rate_allow", {
        p_buckets: buckets.map((b) => b.key),
        p_limits: buckets.map((b) => b.max),
        p_window_secs: windowSecs,
      });
      if (error) fail("rate_allow", error);
      return data === true;
    },
  };
}
