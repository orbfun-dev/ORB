/**
 * Public rules for the weekly entry draw (directive §7 P10).
 *
 * Every rule here is the rule the server actually enforces — the rates,
 * the caps and the gates restate the raffle engine's own SQL and
 * nothing on this page is aspirational. Where a rule will read as
 * unfair at first glance (a refunded round earning nothing), the page
 * gives the reason rather than only the rule, because the reason is the
 * part that answers the support ticket.
 *
 * Note for future edits: the P1 isolation gate greps every file under
 * apps/web/src for the engine's package name and source path, so do not
 * write either of them here — not even in a comment. That bluntness is
 * deliberate (R1: the browser holds no database credential, ever), and
 * a prose reference is not worth loosening it for.
 *
 * Presentation notes:
 *  · this page deliberately borrows DocsPage's panel idiom — same icon
 *    plate, same accent-per-section, same stagger. A reader moving
 *    between docs and rules should not feel they changed product, and
 *    that consistency outranks any novelty a rules page could want;
 *  · the one bold object is the pool bar: 30% of an epoch can be bought
 *    and 70% can only be earned. That ratio is the promotion's central
 *    defence against someone buying a win, so it is shown to scale
 *    before it is described, the same way DocsPage draws the payout
 *    split;
 *  · the unit is an ENTRY throughout. "Ticket" is load-bearing
 *    vocabulary in the game itself (a round has a winning ticket), and
 *    using it here for a promo unit would be a support nightmare.
 */

import { ORB_CLUSTER } from "@orbit-jackpot/sdk";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import {
  BadgeCheck,
  Ban,
  CalendarClock,
  Gift,
  Pickaxe,
  Receipt,
  ShoppingCart,
  Sigma,
} from "lucide-react";

/** `--d` is read by the `stagger` utility (styles.css). */
const delay = (ms: number): CSSProperties => ({ "--d": `${ms}ms` }) as CSSProperties;

function Panel({
  icon: Icon,
  tint,
  title,
  index,
  children,
}: {
  icon: typeof Gift;
  /** Tailwind text colour for the glyph — the section's accent. */
  tint: string;
  title: string;
  /** Entrance order, also the printed section number. */
  index: number;
  children: ReactNode;
}) {
  return (
    <section className="stagger panel panel-live p-5" style={delay(index * 60)}>
      <h2 className="flex items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-orbit-line bg-orbit-panel-2 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]">
          <Icon className={`size-4 ${tint}`} />
        </span>
        <span className="text-[13px] font-bold tracking-[0.12em] text-orbit-text">{title}</span>
        <span className="num ml-auto text-[10px] text-orbit-muted/80">
          {String(index).padStart(2, "0")}
        </span>
      </h2>
      <div className="mt-3.5 space-y-2.5 text-sm leading-relaxed text-orbit-text-mid">
        {children}
      </div>
    </section>
  );
}

function Row(props: ComponentProps<"div">) {
  return <div {...props} className="num flex items-baseline justify-between gap-4 text-xs" />;
}

/** Inline emphasis for a rule's constant. */
function K({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return <span className={`font-semibold text-orbit-text ${mono ? "num" : ""}`}>{children}</span>;
}

/** One earning path: what you do, what it pays, and what gates it. */
function Earn({
  icon: Icon,
  tint,
  action,
  rate,
  gate,
}: {
  icon: typeof Gift;
  tint: string;
  action: string;
  rate: string;
  /** The condition that can stop this path paying out, in plain words. */
  gate: string;
}) {
  return (
    <div className="flex gap-3 rounded-xl border border-orbit-line bg-orbit-panel-2/60 p-3">
      <Icon className={`mt-0.5 size-4 shrink-0 ${tint}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-[13px] font-semibold text-orbit-text">{action}</span>
          <span className="num shrink-0 text-xs text-orbit-gold">{rate}</span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-orbit-muted">{gate}</p>
      </div>
    </div>
  );
}

/**
 * The pool, to scale. 70% of an epoch is earnable only — the reason
 * nobody can simply buy a week.
 */
function PoolBar() {
  return (
    <div>
      <div className="flex h-2.5 overflow-hidden rounded-full border border-orbit-line bg-orbit-bg shadow-[inset_0_1px_3px_rgba(0,0,0,0.6)]">
        <div style={{ width: "70%", background: "#5591ff" }} />
        <div style={{ width: "30%", background: "#f2b544" }} />
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-4 text-[11px]">
        <span className="text-orbit-blue">
          <K mono>700</K> earned only
        </span>
        <span className="text-orbit-gold">
          <K mono>300</K> buyable, at most
        </span>
      </div>
    </div>
  );
}

export function RaffleRulesPage() {
  return (
    // Container matches DocsPage exactly — AppShell's <main> already
    // supplies the page gutters, so adding any here would indent this
    // page further than the one it is linked from.
    <div className="mx-auto max-w-2xl space-y-5">
      <header className="stagger pt-2 text-center sm:pt-6" style={delay(0)}>
        {/* The eyebrow names the section, the title names the page —
            DocsPage's logic. "RULES" above "Entry draw rules" would just
            be the title twice. */}
        <p className="text-[10px] font-bold tracking-[0.3em] text-orbit-gold">RAFFLE</p>
        <h1 className="mt-2.5 font-hero text-4xl leading-[1.05] tracking-[-0.02em] text-orbit-text sm:text-5xl">
          Entry draw rules
        </h1>
        <span
          aria-hidden
          className="mx-auto mt-4 block h-px w-24 bg-gradient-to-r from-transparent via-orbit-gold/60 to-transparent"
        />
        <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-orbit-text-mid">
          Spend real SOL in ORE mining, or buy an entry outright, and you collect entries into a
          prize draw. Every entry
          traces back to a confirmed Solana transaction that the server checked for itself —{" "}
          <K>your browser cannot tell it you earned anything</K>.
        </p>
      </header>

      <Panel icon={CalendarClock} tint="text-orbit-cyan" title="WHEN AN EPOCH ENDS" index={1}>
        <p>
          An epoch closes after <K mono>7 days</K> or <K mono>1,000 entries</K>, whichever comes
          first. Entries stop the moment it closes, a winner is drawn from everything issued, and
          the next epoch opens immediately.
        </p>
        <p>
          Entries never carry into the next epoch. Neither do part-earned amounts — see{" "}
          <K>partial amounts add up</K> below for what that means for a deposit that lands just
          under the line.
        </p>
      </Panel>

      <Panel icon={Gift} tint="text-orbit-gold" title="WHAT EARNS AN ENTRY" index={2}>
        <div className="space-y-2">
          <Earn
            icon={BadgeCheck}
            tint="text-orbit-green"
            action="Play a round of ORB"
            rate={ORB_CLUSTER === "mainnet" ? "1 per 1 SOL" : "not yet"}
            gate={
              ORB_CLUSTER === "mainnet"
                ? "Paid automatically about a minute after the round settles, for everything you deposited into it — win or lose. A cancelled round earns nothing (see below). Auto-play deposits count for the wallet that owns the escrow."
                : "Starts when ORB moves to mainnet. Today's rounds run on devnet, where SOL is free, so they cannot earn prize entries. Once live: 1 per 1 SOL, paid when the round settles — a cancelled round earns nothing (see below)."
            }
          />
          <Earn
            icon={Pickaxe}
            tint="text-orbit-cyan"
            action="Deploy SOL into ORE mining on playorb"
            rate="1 per 1 SOL"
            gate="Only deploys made on playorb's ORE tab count — deploys on other sites or by automation earn nothing. Pays automatically within about a minute. Counts your whole deploy — the per-square amount times the squares you took."
          />
          <Earn
            icon={ShoppingCart}
            tint="text-orbit-gold"
            action="Buy an entry outright"
            rate="0.05 SOL each"
            gate="Capped: 25 per wallet, and 30% of the epoch across everyone. Proceeds buy ORB back."
          />
          <Earn
            icon={Receipt}
            tint="text-orbit-blue"
            action="Refer someone"
            rate="1 per referral"
            gate="Pays when your referee's first qualifying action reaches 1 SOL. Up to 25 per epoch."
          />
        </div>
        <p className="pt-1">
          There is nothing to claim for ORE. Every deploy made on playorb pays its platform fee in
          the same transaction, and the server reads the fee wallet&rsquo;s history straight off
          the chain to find them. It only counts a transaction once it is <K>finalized</K>, so
          entries show up about a minute after you deploy.
        </p>
      </Panel>

      <Panel icon={Ban} tint="text-orbit-red" title="CANCELLED ROUNDS EARN NOTHING" index={3}>
        <p>
          If you are the only depositor in an ORB round, the round cancels and you get{" "}
          <K>every lamport back, with no fees taken</K>. That round earns no entries, and no appeal
          changes it.
        </p>
        <p>
          The reason is arithmetic, not policy. A fully refunded round costs you nothing but
          network fees — roughly <K mono>0.015 SOL</K> would collect a whole 1,000-entry epoch that
          costs <K mono>50 SOL</K> to buy. Entries have to be minted by money you actually parted
          with, so the rule is simply: the round has to settle.
        </p>
        <p>
          Your claim is still recorded, marked as rejected with its reason, so the history is
          auditable rather than silently missing. A cancelled round also does not use up your
          referral bonus.
        </p>
      </Panel>

      <Panel icon={Sigma} tint="text-orbit-blue" title="PARTIAL AMOUNTS ADD UP" index={4}>
        <p>
          Amounts accumulate within an epoch before they are divided, so{" "}
          <K mono>0.6 SOL</K> then <K mono>0.5 SOL</K> earns <K>1 entry</K> — not zero. The
          leftover <K mono>0.1 SOL</K> stays on your balance for the rest of the epoch.
        </p>
        <p>
          Each source keeps its own running total: ORB play and ORE deploys do not pool together.
          Whatever is left over when the epoch closes does not carry into the next one.
        </p>
      </Panel>

      <Panel icon={Receipt} tint="text-orbit-blue" title="REFERRALS" index={5}>
        <p>
          Share your link, and when someone arrives through it their wallet is tied to yours the
          first time they connect. <K>First touch wins and it cannot be changed later</K> — not by
          you, not by them, not by a second link.
        </p>
        <p>
          You earn an entry when that wallet&rsquo;s <K>first ever qualifying action</K> reaches{" "}
          <K mono>1 SOL</K>. If their first action is smaller, the bonus is gone — so send the link
          before they start, not after. You can earn up to <K mono>25</K> referral entries an
          epoch.
        </p>
        <p>
          Referring yourself does not work, and neither does referring a wallet you funded (or one
          that funded you) — that pairing is checked on-chain and refused.
        </p>
      </Panel>

      <Panel icon={ShoppingCart} tint="text-orbit-gold" title="BUYING HAS A CEILING" index={6}>
        <PoolBar />
        <p className="pt-1">
          At <K mono>0.05 SOL</K> an entry, <K mono>50 SOL</K> would buy all 1,000 and guarantee a
          win. So purchases are capped twice: <K mono>25</K> per wallet, and{" "}
          <K mono>30%</K> of the epoch across every buyer combined.
        </p>
        <p>
          Both ceilings are applied in the same instant an entry is issued, so they cannot be
          raced. Once the 30% share is reached, purchases stop for the rest of the epoch while
          earned entries carry on as normal.
        </p>
      </Panel>

      <Panel icon={BadgeCheck} tint="text-orbit-green" title="HOW THE WINNER IS DRAWN" index={7}>
        <p>
          When an epoch closes, the full entry list is hashed into a single fingerprint and
          published on-chain, together with a <K>future</K> Solana slot — about 8 minutes out.
          Neither we nor you know that slot&rsquo;s hash yet.
        </p>
        <p>
          When the slot arrives, its blockhash and the fingerprint are combined to pick the winning
          entry number. The on-chain timestamp proves the entry list was fixed before the
          deciding hash existed, so neither side can be chosen to suit the other.
        </p>
        <Row>
          <span className="text-orbit-muted">verify it yourself</span>
          <span className="text-orbit-text">scripts/raffle/verify-draw.ts</span>
        </Row>
        <p className="pt-1">
          The entry list, the fingerprint and the blockhash are all published. The verification
          script shares no code with the system that ran the draw — it recomputes the result from
          scratch, which is the only kind of check worth anything.
        </p>
      </Panel>

      <Panel icon={Receipt} tint="text-orbit-gold-bright" title="WHAT HAPPENS TO THE SOL" index={8}>
        <p>
          Entry purchases fund an ORB buyback. The wording is{" "}
          <K>100% of proceeds, net of network and swap costs</K> — and that qualifier is there
          because swap fees, slippage and gas mean 100% of a 0.05 SOL payment cannot physically
          reach ORB. Anyone claiming otherwise is rounding in their own favour.
        </p>
        <p>
          Every buyback transaction signature is published against its epoch, so the figure is
          checkable rather than asserted.
        </p>
      </Panel>

      <footer
        className="stagger flex items-center justify-center gap-2 px-4 pb-2 pt-1 text-center text-[11px] leading-relaxed text-orbit-muted"
        style={delay(540)}
      >
        <CalendarClock className="size-3.5 shrink-0 text-orbit-muted" />
        a draw for a prize is regulated differently depending on where you live — check your own
        rules before entering
      </footer>
    </div>
  );
}
