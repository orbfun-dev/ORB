import { useId } from "react";
import { formatUsd, useLivePrices, type PriceSymbol } from "../../hooks/useLivePrices";
import oreToken from "../../assets/ore-token.png";

/** The three-bar SOL mark in its own gradient — recognisable at 16px. */
function SolMark({ className }: { className?: string }) {
  const gradient = useId();
  return (
    <svg viewBox="0 0 24 20" className={className} aria-hidden>
      <defs>
        <linearGradient id={gradient} x1="0" y1="20" x2="24" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9945FF" />
          <stop offset="1" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <g fill={`url(#${gradient})`}>
        <polygon points="5,1.5 23,1.5 19,6 1,6" />
        <polygon points="1,8 19,8 23,12.5 5,12.5" />
        <polygon points="5,14.5 23,14.5 19,19 1,19" />
      </g>
    </svg>
  );
}

/**
 * The official ORE token disc (black, white mark). The hairline ring keeps
 * its black edge from dissolving into the dark header.
 */
function OreMark({ className }: { className?: string }) {
  return (
    <img
      src={oreToken}
      alt=""
      width={350}
      height={350}
      className={`${className ?? ""} rounded-full ring-1 ring-white/15`}
    />
  );
}

const MARKS: Record<PriceSymbol, (p: { className?: string }) => React.ReactElement> = {
  ORE: OreMark,
  SOL: SolMark,
};

/**
 * One live price: mark, symbol, USD. Holds the last good price through a
 * failed poll; shows an em dash only before the first one lands.
 * `className` owns the display (default `inline-flex`), so a caller can
 * pass `hidden lg:inline-flex` without the two fighting.
 */
export function PriceTicker({
  symbol,
  className = "inline-flex",
}: {
  symbol: PriceSymbol;
  className?: string;
}) {
  const { data } = useLivePrices();
  const price = data?.prices[symbol];
  const Mark = MARKS[symbol];
  const change = price?.change24h;

  return (
    <span
      className={`items-center gap-1.5 whitespace-nowrap text-[13px] ${className}`}
      title={
        price === undefined
          ? `${symbol} price loading`
          : `${symbol} ${formatUsd(price.usd)}${
              change === null || change === undefined
                ? ""
                : ` · 24h ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`
            } · via Jupiter`
      }
      data-testid={`price-${symbol}`}
    >
      <Mark className="size-4 shrink-0 text-orbit-text" />
      <span className="font-bold tracking-wide text-orbit-text">{symbol}</span>
      <span className="num tabular-nums text-orbit-text-mid">
        {price === undefined ? (
          <span className="animate-pulse text-orbit-muted">—</span>
        ) : (
          formatUsd(price.usd)
        )}
      </span>
    </span>
  );
}
