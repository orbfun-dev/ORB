/**
 * The live raffle: epoch progress, how you earn, buying entries, your
 * entries, the board.
 *
 * Composition decisions:
 *
 *  · the progress bar is the hero because an epoch is a RACE — it ends
 *    at 1,000 entries or 7 days, whichever lands first, and both of
 *    those facts are only legible against each other. One bar with the
 *    countdown beside it says "how much is left" in a single read;
 *  · how-you-earn and your entries come before the leaderboard. There
 *    is nothing to claim — the server indexes deploys made on the ORE
 *    tab (the only ones that count) and awards them itself — so the
 *    page's job is to say that plainly and then show the result;
 *  · the purchase share rides INSIDE the progress bar as a second
 *    segment rather than as its own widget. It is a slice of the same
 *    1,000, and drawing it anywhere else loses that;
 *  · nothing here invents a number. Every figure is served by
 *    /api/raffle/status, which reads them from the same rows the award
 *    function writes.
 */

import { ORB_CLUSTER } from "@orbit-jackpot/sdk";
import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  Check,
  ClipboardCopy,
  Clock,
  Link2,
  Pickaxe,
  ShoppingCart,
  Ticket,
  Trophy,
} from "lucide-react";
import { ORE_HREF, RAFFLE_RULES_HREF } from "../lib/router";
import { shortAddress, groupDigits, formatSolCompact } from "../lib/format";
import { useRaffleStatus } from "../features/raffle/useRaffle";
import { BuyEntries } from "../features/raffle/BuyEntries";
import { referralLink } from "../features/raffle/useReferralCapture";
import type { RaffleEpoch, SourceProgress } from "../features/raffle/api";

/** `--d` is read by the `stagger` utility (styles.css). */
const delay = (ms: number): CSSProperties => ({ "--d": `${ms}ms` }) as CSSProperties;

function Card({
  title,
  icon: Icon,
  tint,
  action,
  children,
}: {
  title: string;
  icon: typeof Ticket;
  tint: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel panel-live p-5">
      <h2 className="flex items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-orbit-line bg-orbit-panel-2 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]">
          <Icon className={`size-4 ${tint}`} />
        </span>
        <span className="text-[13px] font-bold tracking-[0.12em] text-orbit-text">{title}</span>
        {action !== undefined && <span className="ml-auto">{action}</span>}
      </h2>
      <div className="mt-3.5 text-sm leading-relaxed text-orbit-text-mid">{children}</div>
    </section>
  );
}

/** "3d 4h" / "6h 12m" / "48m" — one unit of precision past the leading one. */
function untilText(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "—";
  if (ms <= 0) return "closing";
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

function EpochProgress({ epoch }: { epoch: RaffleEpoch }) {
  const issued = Math.min(epoch.entriesIssued, epoch.cap);
  const bought = Math.min(epoch.purchasedIssued, issued);
  const earned = issued - bought;
  const pct = (n: number): string => `${epoch.cap === 0 ? 0 : (n / epoch.cap) * 100}%`;
  const closed = epoch.status !== "open";

  return (
    <section className="panel panel-live p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-[13px] font-bold tracking-[0.12em] text-orbit-text">
          EPOCH {epoch.id}
        </span>
        <span className="num flex items-center gap-1.5 text-xs text-orbit-text-mid">
          <Clock className="size-3.5 text-orbit-muted" />
          {closed ? "drawing" : untilText(epoch.endsAt)}
        </span>
      </div>

      <div className="mt-3 flex items-baseline gap-2">
        <span className="num text-3xl font-semibold leading-none tabular-nums text-orbit-gold">
          {groupDigits(BigInt(issued))}
        </span>
        <span className="num text-sm text-orbit-muted">/ {groupDigits(BigInt(epoch.cap))} entries</span>
      </div>

      <div
        className="mt-3 flex h-2.5 overflow-hidden rounded-full border border-orbit-line bg-orbit-bg shadow-[inset_0_1px_3px_rgba(0,0,0,0.6)]"
        role="img"
        aria-label={`${issued} of ${epoch.cap} entries issued, ${bought} of them bought`}
      >
        <span
          className="h-full"
          style={{ width: pct(earned), backgroundColor: "#5591ff" }}
          title={`${earned} earned`}
        />
        <span
          className="h-full"
          style={{ width: pct(bought), backgroundColor: "#f2b544" }}
          title={`${bought} bought`}
        />
      </div>

      <div className="num mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[11px]">
        <span className="text-orbit-blue">{groupDigits(BigInt(earned))} earned</span>
        <span className="text-orbit-gold">
          {groupDigits(BigInt(bought))} bought
          <span className="text-orbit-muted"> · {epoch.purchaseCap} max</span>
        </span>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-orbit-muted">
        An epoch ends at {groupDigits(BigInt(epoch.cap))} entries or after 7 days, whichever comes
        first.{" "}
        <a className="text-orbit-text-mid underline underline-offset-2" href={RAFFLE_RULES_HREF}>
          Read the rules
        </a>
        .
      </p>
    </section>
  );
}

const PROGRESS_LABEL: Record<string, string> = {
  ore_mining: "ORE deploys",
  orb_game: "ORB rounds",
};

/**
 * One source's way to its next entry. Entries land each time the running
 * total crosses another whole entry's worth of SOL, so the bar shows only
 * the part since the last one, and the line under it says what is left.
 */
function NextEntryBar({ row, perEntry }: { row: SourceProgress; perEntry: number }) {
  const pct = Math.min(100, Math.max(row.intoNext > 0 ? 2 : 0, (row.intoNext / perEntry) * 100));
  return (
    <li>
      <div className="flex items-baseline justify-between gap-4 text-xs">
        <span className="text-orbit-muted">{PROGRESS_LABEL[row.source] ?? row.source}</span>
        <span className="num text-orbit-text">
          {formatSolCompact(BigInt(row.intoNext))} / {formatSolCompact(BigInt(perEntry))} SOL
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-orbit-panel-2">
        <div
          className="h-full rounded-full bg-orbit-cyan transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] text-orbit-muted">
        <span className="num text-orbit-text-mid">{formatSolCompact(BigInt(row.toNext))} SOL</span>{" "}
        more to your next entry
      </p>
    </li>
  );
}

export function RafflePage() {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;

  const { status, loading, error, refresh } = useRaffleStatus(wallet);
  const [copied, setCopied] = useState(false);

  const copyLink = useCallback((): void => {
    if (wallet === null) return;
    void navigator.clipboard?.writeText(referralLink(wallet)).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      },
      () => undefined,
    );
  }, [wallet]);

  const progress = status?.wallet?.progress ?? [];
  const perEntry = status?.wallet?.lamportsPerEntry ?? 1_000_000_000;

  const bySource = useMemo(() => {
    const s = status?.wallet?.bySource ?? {};
    return [
      { key: "orb_game", label: "ORB rounds" },
      { key: "ore_mining", label: "ORE deploys" },
      { key: "purchase", label: "bought" },
      { key: "referral", label: "referrals" },
    ].filter((r) => (s[r.key] ?? 0) > 0);
  }, [status]);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header className="stagger pt-2 text-center sm:pt-6" style={delay(0)}>
        <p className="text-[10px] font-bold tracking-[0.3em] text-orbit-gold">RAFFLE</p>
        <h1 className="mt-2.5 font-hero text-4xl leading-[1.05] tracking-[-0.02em] text-orbit-text sm:text-5xl">
          Win the weekly draw
        </h1>
        <span
          aria-hidden
          className="mx-auto mt-4 block h-px w-24 bg-gradient-to-r from-transparent via-orbit-gold/60 to-transparent"
        />
      </header>

      {loading && status === null ? (
        <div className="panel p-5 text-center text-sm text-orbit-muted">loading the epoch…</div>
      ) : status?.epoch == null ? (
        <div className="panel p-5 text-center text-sm text-orbit-muted">
          {error === null
            ? "The draw has not started yet. Check back shortly."
            : "Can't reach the raffle right now — it'll reappear on its own."}
        </div>
      ) : (
        <>
          <div className="stagger" style={delay(60)}>
            <EpochProgress epoch={status.epoch} />
          </div>

          <div className="stagger" style={delay(120)}>
            <Card title="HOW YOU EARN" icon={Pickaxe} tint="text-orbit-cyan">
              {ORB_CLUSTER === "mainnet" && (
                <p className="mb-2 text-orbit-muted">
                  <span className="text-orbit-text-mid">Play the wheel.</span> Every 1 SOL you
                  put into a round earns 1 entry once the round settles, win or lose. Cancelled
                  rounds earn nothing.
                </p>
              )}
              <p className="text-orbit-muted">
                Deploy SOL into ORE on the{" "}
                <a className="text-orbit-text-mid underline underline-offset-2" href={ORE_HREF}>
                  ORE tab
                </a>{" "}
                and your entries arrive here on their own, usually within a minute. There is
                nothing to claim.
              </p>
              <p className="mt-2 text-orbit-muted">
                <span className="text-orbit-text-mid">Only deploys made on playorb count.</span>{" "}
                Deploys made on other sites or by automation earn no entries.
              </p>
            </Card>
          </div>

          {status.purchase !== undefined && (
            <div className="stagger" style={delay(150)}>
              <Card title="BUY ENTRIES" icon={ShoppingCart} tint="text-orbit-gold">
                <BuyEntries
                  terms={status.purchase}
                  epoch={status.epoch}
                  walletBought={status.wallet?.bySource.purchase ?? 0}
                  onChanged={refresh}
                />
              </Card>
            </div>
          )}

          {status.wallet !== null && (status.wallet.total > 0 || progress.length > 0) && (
            <div className="stagger" style={delay(180)}>
              <Card title="YOUR ENTRIES" icon={Check} tint="text-orbit-green">
                <div className="flex items-baseline gap-2">
                  <span className="num text-2xl font-semibold text-orbit-text">
                    {status.wallet.total}
                  </span>
                  <span className="text-xs text-orbit-muted">
                    {status.wallet.total > 0 && status.epoch.entriesIssued > 0
                      ? `this epoch — ${((status.wallet.total / status.epoch.entriesIssued) * 100).toFixed(1)}% of the pool so far`
                      : "this epoch — your first one is on its way"}
                  </span>
                </div>
                {progress.length > 0 && (
                  <ul className="mt-3 space-y-3">
                    {progress.map((row) => (
                      <NextEntryBar key={row.source} row={row} perEntry={perEntry} />
                    ))}
                  </ul>
                )}
                <ul className="num mt-2.5 space-y-1 text-xs">
                  {bySource.map((r) => (
                    <li key={r.key} className="flex items-baseline justify-between gap-4">
                      <span className="font-sans text-orbit-muted">{r.label}</span>
                      <span className="text-orbit-text">{status.wallet!.bySource[r.key]}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          )}

          <div className="stagger" style={delay(240)}>
            <Card
              title="REFER A FRIEND"
              icon={Link2}
              tint="text-orbit-blue"
              action={
                wallet !== null ? (
                  <button
                    type="button"
                    onClick={copyLink}
                    className="pressable flex items-center gap-1.5 rounded-full border border-orbit-line bg-orbit-panel-2 px-3 py-1 text-[11px] font-semibold text-orbit-text"
                  >
                    {copied ? <Check className="size-3" /> : <ClipboardCopy className="size-3" />}
                    {copied ? "Copied" : "Copy link"}
                  </button>
                ) : undefined
              }
            >
              {wallet === null ? (
                <p className="text-orbit-muted">Connect a wallet to get your referral link.</p>
              ) : (
                <p className="text-orbit-muted">
                  You earn an entry when someone you referred reaches 1 SOL on their{" "}
                  <span className="text-orbit-text-mid">first</span> qualifying action, up to 25 an
                  epoch. Send the link before they start — the bonus is tied to their first move.
                </p>
              )}
            </Card>
          </div>

          <div className="stagger" style={delay(300)}>
            <Card title="LEADERBOARD" icon={Trophy} tint="text-orbit-gold-bright">
              {status.leaderboard.length === 0 ? (
                <p className="text-orbit-muted">No entries yet this epoch. First in leads.</p>
              ) : (
                <ol className="num space-y-1 text-xs">
                  {status.leaderboard.map((row, i) => {
                    const you = row.wallet === wallet;
                    return (
                      <li
                        key={row.wallet}
                        className={`flex items-baseline justify-between gap-4 rounded-lg px-2 py-1.5 ${
                          you ? "bg-orbit-gold/10 text-orbit-gold" : "text-orbit-text-mid"
                        }`}
                      >
                        <span className="flex min-w-0 items-baseline gap-2.5">
                          <span className="w-4 shrink-0 text-right text-orbit-muted">{i + 1}</span>
                          <span className="truncate">{shortAddress(row.wallet)}</span>
                          {you && <span className="font-sans text-[10px]">you</span>}
                        </span>
                        <span className="shrink-0 font-semibold text-orbit-text">
                          {row.entries}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
