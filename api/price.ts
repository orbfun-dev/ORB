/**
 * GET /api/price — live USD prices for the header tickers (ORE, SOL).
 *
 * Server-side for one reason: the Jupiter key. A VITE_ variable would be
 * inlined into the public bundle; JUPITER_API_KEY lives only in the
 * function's environment. The CDN cache below makes every visitor share
 * one upstream call per window, so the key's rate limit never scales with
 * traffic.
 *
 * Self-contained on purpose (no imports): the web app's vite config mounts
 * `pricesResponse` for local dev/preview, and Vercel builds this file as a
 * standalone function.
 */

export const PRICE_MINTS = {
  ORE: "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp",
  SOL: "So11111111111111111111111111111111111111112",
} as const;

export type PriceSymbol = keyof typeof PRICE_MINTS;

export interface TokenPrice {
  usd: number;
  /** Percent over 24h, as Jupiter reports it; null when absent. */
  change24h: number | null;
}

export interface PricesPayload {
  prices: Partial<Record<PriceSymbol, TokenPrice>>;
  /** Server time of the upstream read, ms. */
  ts: number;
}

const JUPITER_PRICE_URL = "https://api.jup.ag/price/v3";
/** Fresh for 10s at the edge, then served stale for up to 30s more while one request refreshes. */
const CACHE_CONTROL = "public, s-maxage=10, stale-while-revalidate=30";

/** Pure: Jupiter's `{ [mint]: { usdPrice, priceChange24h } }` → our payload. */
export function parseJupiterPrices(body: unknown, ts: number): PricesPayload {
  const prices: PricesPayload["prices"] = {};
  if (body !== null && typeof body === "object") {
    const byMint = body as Record<string, { usdPrice?: unknown; priceChange24h?: unknown } | null>;
    for (const symbol of Object.keys(PRICE_MINTS) as PriceSymbol[]) {
      const row = byMint[PRICE_MINTS[symbol]];
      if (row && typeof row.usdPrice === "number" && Number.isFinite(row.usdPrice)) {
        prices[symbol] = {
          usd: row.usdPrice,
          change24h: typeof row.priceChange24h === "number" ? row.priceChange24h : null,
        };
      }
    }
  }
  return { prices, ts };
}

export async function pricesResponse(apiKey: string | undefined): Promise<Response> {
  if (apiKey === undefined || apiKey === "") {
    return Response.json({ error: "price feed not configured" }, { status: 503 });
  }
  try {
    const ids = Object.values(PRICE_MINTS).join(",");
    const upstream = await fetch(`${JUPITER_PRICE_URL}?ids=${ids}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(8_000),
    });
    if (!upstream.ok) {
      return Response.json({ error: `upstream ${upstream.status}` }, { status: 502 });
    }
    return Response.json(parseJupiterPrices(await upstream.json(), Date.now()), {
      headers: { "Cache-Control": CACHE_CONTROL },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export function GET(): Promise<Response> {
  return pricesResponse(process.env.JUPITER_API_KEY);
}
