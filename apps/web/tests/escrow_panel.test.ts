/**
 * Escrow cost-disclosure gates (Phase 10 §4.7): the UI must quote the
 * REAL number — `rounds × (per_round + entry_rent + tip) + one-time
 * escrow rent floor` — never `rounds × per_round`, with the three
 * components separable so the player can see what comes back.
 */

import { describe, expect, it } from "vitest";
import {
  computeAutoPlayQuote,
  ENTRY_RENT_LAMPORTS,
  ESCROW_RENT_LAMPORTS as ESCROW_RENT_FLOOR_LAMPORTS,
} from "../src/lib/autoPlay";

describe("computeAutoPlayQuote — the §4.7 worked example", () => {
  it("10 rounds at 0.1 SOL with a 200_000 tip quotes 1.01531 SOL", () => {
    const quote = computeAutoPlayQuote(100_000_000n, 10, 200_000n);
    expect(quote.roundCost).to.equal(101_403_960n);
    expect(quote.stake).to.equal(1_000_000_000n);
    expect(quote.entryRent).to.equal(10n * ENTRY_RENT_LAMPORTS);
    expect(quote.tips).to.equal(2_000_000n);
    expect(quote.floor).to.equal(ESCROW_RENT_FLOOR_LAMPORTS);
    expect(quote.total).to.equal(1_015_309_600n);
  });

  it("the naive quote (rounds × perRound) understates by rent + tips + floor", () => {
    const quote = computeAutoPlayQuote(100_000_000n, 10, 200_000n);
    expect(quote.total - 1_000_000_000n).to.equal(
      quote.entryRent + quote.tips + quote.floor,
    );
  });

  it("a zero tip is legal (test/fixture configs) and rounds clamp at 0", () => {
    const quote = computeAutoPlayQuote(50_000_000n, 3, 0n);
    expect(quote.roundCost).to.equal(50_000_000n + ENTRY_RENT_LAMPORTS);
    expect(computeAutoPlayQuote(50_000_000n, 0, 0n).total).to.equal(ESCROW_RENT_FLOOR_LAMPORTS);
  });
});
