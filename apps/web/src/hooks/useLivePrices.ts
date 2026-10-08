/**
 * Live ORE / SOL USD prices for the header tickers, from our own
 * `/api/price` (which holds the Jupiter key server-side and is CDN-cached
 * for ~10s). Polls while the tab is visible; a failed poll keeps the last
 * good price on screen rather than blanking it.
 */

import { useQuery } from "@tanstack/react-query";
import type { PricesPayload } from "../../../../api/price";

export type { PriceSymbol, TokenPrice } from "../../../../api/price";

const POLL_MS = 15_000;

async function fetchPrices(): Promise<PricesPayload> {
  const res = await fetch("/api/price");
  if (!res.ok) throw new Error(`price feed ${res.status}`);
  return (await res.json()) as PricesPayload;
}

export function useLivePrices() {
  return useQuery({
    queryKey: ["header-prices"],
    queryFn: fetchPrices,
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
    retry: 1,
  });
}

/** `$114.76` — two decimals, grouped; under a dollar, 3 significant digits (`$0.0123`). */
export function formatUsd(usd: number): string {
  if (usd < 1) return `$${usd.toPrecision(3)}`;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
