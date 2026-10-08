/**
 * Static documentation page for the ORB protocol. Every number here is a
 * protocol constant mirrored from the program (economics v2) — the UI's
 * live panels compute the same values with the SDK's integer math, so the
 * docs only ever restate what the chain enforces, never invent numbers.
 *
 * Presentation notes:
 *  · the page had eight panels whose icons were ALL tinted
 *    `text-orbit-text`, which is the same as having no tint: nothing
 *    distinguished the payout rules from the fairness argument. Each
 *    section now carries its own accent from the app's semantic set, so
 *    colour is a wayfinding device instead of decoration;
 *  · the payout split was four lines of text claiming percentages. It is
 *    the single most important fact in the product ("89% always comes
 *    back"), so it is now also a bar — the proportions are visible before
 *    a word is read;
 *  · this page gets the app's one serif voice, in the title only. Long-
 *    form reading is what a serif is for, and rationing it to a single
 *    element is what keeps it from reading as ornament.
 */

import { ORB_CLUSTER } from "@orbit-jackpot/sdk";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import {
  Bot,
  Coins,
  Gavel,
  Gift,
  HandCoins,
  Landmark,
  ShieldCheck,
  Swords,
  Zap,
} from "lucide-react";
import { RAFFLE_RULES_HREF } from "../lib/router";

/** `--d` is read by the `stagger` utility (styles.css). */
const delay = (ms: number): CSSProperties => ({ "--d": `${ms}ms` }) as CSSProperties;

function Panel({
  icon: Icon,
  tint,
  title,
  index,
  children,
}: {
  icon: typeof Coins;
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

/** Inline emphasis for a protocol constant. */
function K({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <span className={`font-semibold text-orbit-text ${mono ? "num" : ""}`}>{children}</span>
  );
}

const SPLIT = [
  {
    label: "refund pool",
    pct: "89%",
    weight: 89,
    tone: "#5591ff",
    tint: "text-orbit-blue",
    note: "back to every losing entry, pro-rata",
  },
  {
    label: "winner",
    pct: "9%",
    weight: 9,
    tone: "#ffd07a",
    tint: "text-orbit-gold-bright",
    note: "of the losers' money, plus the winner's whole stake back",
  },
  {
    label: "mega-pot",
    pct: "1%",
    weight: 1,
    tone: "#f2b544",
    tint: "text-orbit-gold",
    note: "of the losers' money, to the progressive pot",
  },
  {
    label: "admin",
    pct: "1%",
    weight: 1,
    tone: "#38455a",
    tint: "text-orbit-muted",
    note: "protocol treasury",
  },
] as const;

/** The pot, to scale. The whole product thesis in one 10px-tall object. */
function SplitBar() {
  return (
    <div
      className="flex h-2.5 overflow-hidden rounded-full border border-orbit-line bg-orbit-bg shadow-[inset_0_1px_3px_rgba(0,0,0,0.6)]"
      role="img"
      aria-label="pot split: 89% refund pool, 9% winner, 1% mega-pot, 1% admin"
    >
      {SPLIT.map((s) => (
        <span
          key={s.label}
          title={`${s.pct} ${s.label}`}
          className="h-full first:rounded-l-full last:rounded-r-full"
          style={{
            width: `${s.weight}%`,
            backgroundColor: s.tone,
            boxShadow: `inset 0 1px 0 0 rgb(255 255 255 / 0.3)`,
          }}
        />
      ))}
    </div>
  );
}

export function DocsPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header className="stagger pt-2 text-center sm:pt-6" style={delay(0)}>
        <p className="text-[10px] font-bold tracking-[0.3em] text-orbit-gold">DOCS</p>
        <h1 className="mt-2.5 font-hero text-4xl leading-[1.05] tracking-[-0.02em] text-orbit-text sm:text-5xl">
          How ORB works
        </h1>
        <span
          aria-hidden
          className="mx-auto mt-4 block h-px w-24 bg-gradient-to-r from-transparent via-orbit-gold/60 to-transparent"
        />
        <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-orbit-text-mid">
          ORB is a pari-mutuel jackpot wheel on Solana. Every deposit mints a ticket interval on
          the wheel; when the round locks, on-chain randomness draws one ticket. The winner gets{" "}
          <K>their whole stake back plus 9% of everyone else&rsquo;s</K> — and a losing stake
          still gets <K>89% back</K>.
        </p>
      </header>

      <Panel icon={Swords} tint="text-orbit-cyan" title="THE ROUND" index={1}>
        <p>
          A round opens with a deposit window and a live countdown. Each deposit adds the player's
          stake to the pot and assigns a contiguous ticket interval{" "}
          <K mono>[start, end)</K> — odds are always exactly your stake over the pot, computed in
          integer math on-chain.
        </p>
        <p>
          In the final seconds a deposit extends the clock (anti-snipe), so last-moment entries
          can't snipe the draw. When the window closes the round locks, verifiable randomness is
          requested, and the wheel lands on the winning ticket.
        </p>
      </Panel>

      <Panel icon={Coins} tint="text-orbit-gold" title="THE PAYOUT SPLIT" index={2}>
        <p>
          Every settled round splits the <K>losing</K> stakes four ways (economics v3). The
          winner&rsquo;s own stake is never charged, so winning always pays — however much of the
          pot is yours:
        </p>
        <SplitBar />
        <div className="space-y-1.5 rounded-xl border border-orbit-line bg-orbit-bg/60 px-3 py-2.5">
          {SPLIT.map((s) => (
            <Row key={s.label}>
              <span className="flex min-w-0 items-baseline text-orbit-text">
                <span
                  aria-hidden
                  className="mr-2 size-2 shrink-0 translate-y-[-1px] rounded-full"
                  style={{ backgroundColor: s.tone }}
                />
                <span className={`w-10 shrink-0 font-semibold ${s.tint}`}>{s.pct}</span>
                <span className="ml-1 font-sans font-medium text-orbit-text-mid">{s.label}</span>
                <span className="ml-2 truncate font-sans text-orbit-muted">— {s.note}</span>
              </span>
            </Row>
          ))}
        </div>
        <p>
          The refund pool is the core promise: <K>89% of every losing stake comes back</K>,
          pro-rata. Example: 0.1 SOL against 0.01 SOL — win and you take home 0.1009 SOL; lose and
          you get 0.0089 SOL back. The wheel&rsquo;s slices and every estimate in the UI use the same
          integer formulas the program enforces.
        </p>
        <p>
          The exemption covers the <K>winning entry</K>, not the wallet. If you hold two entries
          in one round, say a manual deposit and an auto-play deposit, and one of them wins, the
          other one is a losing entry and is charged like any other.
        </p>
      </Panel>

      <Panel icon={Zap} tint="text-orbit-gold-bright" title="THE MEGA-POT" index={3}>
        <p>
          The 1% accrues into a progressive pot that can pop any round at{" "}
          <K mono>1-in-625</K>. When it pops, 90% of the accrued pot is awarded on the spot:{" "}
          <K>50% to the round's winner, 40% split pro-rata across the whole field</K>, and 10%
          carries into the next cycle.
        </p>
        <p>
          The award is capped at <K mono>8×</K> the current round&rsquo;s losing stakes — a bigger
          field unlocks a bigger jackpot. The HUD shows the full accrued pot; the cap applies when the pot actually
          pops.
        </p>
      </Panel>

      <Panel icon={Landmark} tint="text-orbit-text-mid" title="COSTS & FEES" index={4}>
        <p>
          Your first-ever bet pays a <K>one-time account-open fee</K> (it seeds the jackpot) plus
          refundable account rent — the deposit panel breaks both out as separate lines before you
          sign. After that, depositing is just stake + network fees.
        </p>
        <p>
          The auto-play escrow quotes the <K>true cost</K> up front: per round it spends stake +
          entry rent (returned to the escrow when the round's entries close) + a keeper tip (not
          returned), and a one-time rent floor stays locked while the escrow exists.
        </p>
      </Panel>

      <Panel icon={HandCoins} tint="text-orbit-blue" title="CLAIMS & REFUNDS" index={5}>
        <p>
          Settled rounds pay out automatically: the keeper batch-closes entries and delivers each
          player's refund share. You can also claim your own refund permissionlessly at any time —
          the instruction pays <K>you</K>, whoever signs it.
        </p>
        <p>
          Winners have a 30-day window to claim the prize before it sweeps into the pot. A round
          with a sole depositor — or an oracle failure — cancels and refunds every entry in full.
        </p>
      </Panel>

      <Panel icon={ShieldCheck} tint="text-orbit-green" title="FAIRNESS" index={6}>
        <p>
          The winning ticket comes from verifiable on-chain randomness, and the wheel is drawn
          straight from the ticket book: slice angles are the integer ticket boundaries themselves,
          so the animation can only land where the math says — it never picks a winner.
        </p>
        <p>
          No floats in the money paths: odds, refunds, and payouts are bigint lamport math,
          identical in the program, the SDK, and this UI.
        </p>
      </Panel>

      <Panel icon={Bot} tint="text-orbit-violet" title="AUTO-PLAY ESCROW" index={7}>
        <p>
          Fund an escrow once and the keeper enters you every round at your declared stake, for as
          many rounds as you set. Winnings and refunds collect in the escrow rather than buying
          more rounds, and you can withdraw anything unspent at any time.
        </p>
      </Panel>

      <a
        href={RAFFLE_RULES_HREF}
        className="stagger pressable panel panel-live flex items-center gap-2.5 p-5 text-left"
        style={delay(480)}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-orbit-line bg-orbit-panel-2 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]">
          <Gift className="size-4 text-orbit-gold" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-bold tracking-[0.12em] text-orbit-text">
            ENTRY DRAW RULES
          </span>
          <span className="mt-1 block text-sm leading-relaxed text-orbit-text-mid">
            How playing earns entries into the weekly prize draw, what the caps are, and how to
            check the draw yourself.
          </span>
        </span>
      </a>

      <footer
        className="stagger flex items-center justify-center gap-2 px-4 pb-2 pt-1 text-center text-[11px] leading-relaxed text-orbit-muted"
        style={delay(540)}
      >
        <Gavel className="size-3.5 shrink-0 text-orbit-muted" />
        live on Solana {ORB_CLUSTER === "mainnet" ? "mainnet" : "devnet"} — every number in the UI is computed with the same integer math the
        program enforces on-chain
      </footer>
    </div>
  );
}
