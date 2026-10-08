/**
 * GET /api/raffle/status — the page's read surface (directive §7 P9).
 *
 * The directive specifies four write endpoints and no read ones, but
 * the P9 page needs an epoch progress bar, a leaderboard and a "your
 * entries" panel. Those are one screen, so they are one request: three
 * round trips to render one page would be three chances to show a
 * half-updated epoch.
 *
 * Nothing here is a secret. Entry counts and the wallets holding them
 * are published in full at the draw anyway — this endpoint only shows
 * them earlier. It is a GET with no body, and it still runs the
 * forbidden-field guard, because `?amount=` in a query string is the
 * same bad idea as `amount` in a body.
 *
 * It also publishes the purchase TERMS — where to pay, the price, the
 * per-wallet ceiling. The buy card reads them from here rather than
 * baking them into the bundle: a stale treasury address in a cached
 * page would send someone's SOL to a wallet the server no longer
 * counts, and a payment the server does not count is simply lost.
 */

import type { RaffleConfig } from "../env";
import { loadConfig } from "../env";
import { raffleDb, type RaffleDb } from "../db";
import {
  epochStatus,
  leaderboard,
  walletProgress,
  walletSummary,
  type EpochStatusRow,
} from "../store";
import {
  guardRequest,
  json,
  type JsonResponse,
  type RaffleRequest,
} from "../http";

/** Base58 is 32–44 characters for a 32-byte key; reject anything else. */
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const LEADERBOARD_SIZE = 10;

export interface StatusStore {
  epochStatus(): Promise<EpochStatusRow | null>;
  leaderboard(epochId: number, limit: number): Promise<Array<{ wallet: string; entries: number }>>;
  walletSummary(epochId: number, wallet: string): Promise<Array<{ source: string; entries: number }>>;
  walletProgress(epochId: number, wallet: string): Promise<Array<{ source: string; lamports: number }>>;
}

/**
 * How far a wallet is along one earned source this epoch. Entries are
 * issued each time the running total crosses another whole
 * lamportsPerEntry (R5, raffle_submit_earned_event), and each source
 * keeps its own total — ORE deploys and ORB play never pool.
 */
export interface SourceProgress {
  source: string;
  /** SOL spent through this source this epoch, in lamports. */
  lamports: number;
  /** Lamports already counted toward the next entry. */
  intoNext: number;
  /** Lamports still needed for the next entry. */
  toNext: number;
}

export function sourceProgress(source: string, lamports: number, lamportsPerEntry: number): SourceProgress {
  const intoNext = lamports % lamportsPerEntry;
  return { source, lamports, intoNext, toNext: lamportsPerEntry - intoNext };
}

export function postgrestStatusStore(db: RaffleDb): StatusStore {
  return {
    epochStatus: () => epochStatus(db),
    leaderboard: (epochId, limit) => leaderboard(db, epochId, limit),
    walletSummary: (epochId, wallet) => walletSummary(db, epochId, wallet),
    walletProgress: (epochId, wallet) => walletProgress(db, epochId, wallet),
  };
}

export interface StatusDeps {
  config: RaffleConfig;
  store: StatusStore;
}

export function defaultStatusDeps(config: RaffleConfig = loadConfig()): StatusDeps {
  return { config, store: postgrestStatusStore(raffleDb(config)) };
}

function queryParam(req: RaffleRequest, name: string): string | null {
  const raw = req.query?.[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function statusEndpoint(deps: StatusDeps) {
  return async function handleStatus(req: RaffleRequest): Promise<JsonResponse> {
    guardRequest(req, { method: "GET" });

    const epoch = await deps.store.epochStatus();
    if (epoch === null) {
      // No epoch has ever been opened. Not an error — the promotion
      // simply has not started, and the page says so.
      return json(200, { epoch: null, leaderboard: [], wallet: null });
    }

    const board = await deps.store.leaderboard(epoch.epochId, LEADERBOARD_SIZE);

    // The wallet panel is optional: the page renders for a visitor who
    // has not connected one. A malformed wallet is ignored rather than
    // rejected — a bad query string should not blank the leaderboard.
    const asked = queryParam(req, "wallet");
    const wallet = asked !== null && PUBKEY_RE.test(asked) ? asked : null;

    let walletPanel: {
      pubkey: string;
      total: number;
      bySource: Record<string, number>;
      lamportsPerEntry: number;
      progress: SourceProgress[];
    } | null = null;
    if (wallet !== null) {
      const rows = await deps.store.walletSummary(epoch.epochId, wallet);
      const bySource: Record<string, number> = {};
      let total = 0;
      for (const row of rows) {
        bySource[row.source] = row.entries;
        total += row.entries;
      }
      const per = deps.config.lamportsPerEntry;
      const progress = (await deps.store.walletProgress(epoch.epochId, wallet))
        .filter((p) => p.lamports > 0)
        .sort((a, b) => a.source.localeCompare(b.source))
        .map((p) => sourceProgress(p.source, p.lamports, per));
      walletPanel = { pubkey: wallet, total, bySource, lamportsPerEntry: per, progress };
    }

    return json(200, {
      purchase: {
        treasury: deps.config.raffleTreasuryPubkey,
        priceLamports: deps.config.entryPriceLamports,
        perWalletCap: deps.config.purchaseCapPerWallet,
      },
      epoch: {
        id: epoch.epochId,
        status: epoch.status,
        cap: epoch.cap,
        entriesIssued: epoch.entriesIssued,
        purchasedIssued: epoch.purchasedIssued,
        purchaseCap: epoch.purchaseCap,
        startsAt: epoch.startsAt,
        endsAt: epoch.endsAt,
      },
      leaderboard: board,
      wallet: walletPanel,
    });
  };
}
