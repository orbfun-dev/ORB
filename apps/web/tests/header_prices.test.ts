/**
 * The header price feed: Jupiter's per-mint payload → our {ORE, SOL}
 * payload (junk rows dropped, never NaN on screen), the no-key 503, and
 * the USD formatting the tickers print.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { PRICE_MINTS, parseJupiterPrices, pricesResponse } from "../../../api/price";
import { formatUsd } from "../src/hooks/useLivePrices";

describe("parseJupiterPrices", () => {
  it("maps mints to symbols with price and 24h change", () => {
    const out = parseJupiterPrices(
      {
        [PRICE_MINTS.SOL]: { usdPrice: 115.88, priceChange24h: -4.38, decimals: 9 },
        [PRICE_MINTS.ORE]: { usdPrice: 111.04, priceChange24h: -6.6, decimals: 11 },
      },
      42,
    );
    expect(out).toEqual({
      prices: {
        SOL: { usd: 115.88, change24h: -4.38 },
        ORE: { usd: 111.04, change24h: -6.6 },
      },
      ts: 42,
    });
  });

  it("drops missing, null and non-numeric rows instead of inventing a price", () => {
    const out = parseJupiterPrices(
      { [PRICE_MINTS.SOL]: { usdPrice: "115" }, [PRICE_MINTS.ORE]: null },
      1,
    );
    expect(out.prices).toEqual({});
    expect(parseJupiterPrices(null, 1).prices).toEqual({});
    expect(
      parseJupiterPrices({ [PRICE_MINTS.ORE]: { usdPrice: Number.NaN } }, 1).prices,
    ).toEqual({});
  });

  it("keeps a price whose 24h change is absent", () => {
    const out = parseJupiterPrices({ [PRICE_MINTS.ORE]: { usdPrice: 2 } }, 1);
    expect(out.prices.ORE).toEqual({ usd: 2, change24h: null });
  });
});

describe("pricesResponse", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses with 503 and never calls upstream when the key is unset", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect((await pricesResponse(undefined)).status).toBe(503);
    expect((await pricesResponse("")).status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the key as a header and sets an edge cache", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({ [PRICE_MINTS.ORE]: { usdPrice: 111.04, priceChange24h: 1 } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const res = await pricesResponse("k");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("s-maxage");
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    expect(((await res.json()) as { prices: unknown }).prices).toEqual({
      ORE: { usd: 111.04, change24h: 1 },
    });
  });

  it("maps an upstream failure to 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    expect((await pricesResponse("bad")).status).toBe(502);
  });
});

describe("formatUsd", () => {
  it("prints dollars and cents, grouped", () => {
    expect(formatUsd(114.756)).toBe("$114.76");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });

  it("keeps three significant digits under a dollar", () => {
    expect(formatUsd(0.012345)).toBe("$0.0123");
  });
});
