/**
 * The buy card's ceiling math. SOL sent past any ceiling buys nothing and
 * is not refunded, so the planner must never offer a count the server
 * (raffle_award) would clamp.
 */

import { describe, expect, it } from "vitest";
import type { PurchaseTerms, RaffleEpoch } from "../src/features/raffle/api";
import {
  CLOSING_MARGIN_MS,
  buyLimit,
  clampCount,
  purchaseLamports,
} from "../src/features/raffle/purchasePlan";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const TERMS: PurchaseTerms = {
  treasury: "3f1TdP6BJVAKXeSA5snpUUtfVGetDStTgWTDSmGSCm4E",
  priceLamports: 50_000_000,
  perWalletCap: 25,
};

function epoch(over: Partial<RaffleEpoch> = {}): RaffleEpoch {
  return {
    id: 1,
    status: "open",
    cap: 1000,
    entriesIssued: 0,
    purchasedIssued: 0,
    purchaseCap: 300,
    startsAt: "2026-10-08T22:42:00Z",
    endsAt: "2026-10-14T22:42:00Z",
    ...over,
  };
}

describe("buyLimit", () => {
  it("offers the full per-wallet ceiling on a fresh epoch", () => {
    expect(buyLimit(TERMS, epoch(), 0, NOW)).toEqual({
      max: 25,
      blocker: null,
      walletLeft: 25,
      shareLeft: 300,
    });
  });

  it("subtracts what this wallet already bought", () => {
    expect(buyLimit(TERMS, epoch(), 22, NOW).max).toBe(3);
  });

  it("is bound by the shared 30% allowance when that is tighter", () => {
    expect(buyLimit(TERMS, epoch({ purchasedIssued: 296 }), 0, NOW).max).toBe(4);
  });

  it("is bound by the pool itself when it is nearly full", () => {
    expect(buyLimit(TERMS, epoch({ entriesIssued: 998 }), 0, NOW).max).toBe(2);
  });

  it("blocks a wallet at its ceiling", () => {
    expect(buyLimit(TERMS, epoch(), 25, NOW)).toMatchObject({ max: 0, blocker: "wallet-full" });
  });

  it("blocks everyone once the purchase share is used up", () => {
    expect(buyLimit(TERMS, epoch({ purchasedIssued: 300 }), 0, NOW)).toMatchObject({
      max: 0,
      blocker: "share-full",
    });
  });

  it("blocks a locked or drawn epoch, and a full pool", () => {
    expect(buyLimit(TERMS, epoch({ status: "locked" }), 0, NOW).blocker).toBe("epoch-closed");
    expect(buyLimit(TERMS, epoch({ status: "drawn" }), 0, NOW).blocker).toBe("epoch-closed");
    expect(buyLimit(TERMS, epoch({ entriesIssued: 1000 }), 0, NOW).blocker).toBe("epoch-closed");
  });

  it("pauses inside the closing margin, so a payment cannot finalize after the lock", () => {
    const endsAt = new Date(NOW + CLOSING_MARGIN_MS - 1).toISOString();
    expect(buyLimit(TERMS, epoch({ endsAt }), 0, NOW)).toMatchObject({
      max: 0,
      blocker: "closing-soon",
    });
    const justOutside = new Date(NOW + CLOSING_MARGIN_MS + 1).toISOString();
    expect(buyLimit(TERMS, epoch({ endsAt: justOutside }), 0, NOW).blocker).toBeNull();
  });

  it("treats an unreadable end time as closing rather than open", () => {
    expect(buyLimit(TERMS, epoch({ endsAt: "not a date" }), 0, NOW).blocker).toBe("closing-soon");
  });

  it("never reports negative headroom when the server already overshot", () => {
    const limit = buyLimit(TERMS, epoch({ purchasedIssued: 310 }), 30, NOW);
    expect(limit.walletLeft).toBe(0);
    expect(limit.shareLeft).toBe(0);
    expect(limit.max).toBe(0);
  });
});

describe("clampCount", () => {
  it("keeps the picker within [1, max]", () => {
    expect(clampCount(0, 25)).toBe(1);
    expect(clampCount(30, 25)).toBe(25);
    expect(clampCount(7.9, 25)).toBe(7);
    expect(clampCount(Number.NaN, 25)).toBe(1);
  });

  it("is 0 when nothing can be bought", () => {
    expect(clampCount(5, 0)).toBe(0);
  });

  it("pulls a stale pick down when the ceiling shrinks under it", () => {
    expect(clampCount(10, 3)).toBe(3);
  });
});

describe("purchaseLamports", () => {
  it("is the exact price times the count, in lamports", () => {
    expect(purchaseLamports(TERMS, 1)).toBe(50_000_000n);
    expect(purchaseLamports(TERMS, 25)).toBe(1_250_000_000n);
  });
});
