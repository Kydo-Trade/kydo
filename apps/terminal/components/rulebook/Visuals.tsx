"use client";
/**
 * The Rulebook's diagrams.
 *
 * The page these replace explained the platform in paragraphs: eight numbered
 * prose blocks, a six-row comparison table and three essay cards. Everything
 * here is something prose was doing badly. A flow, a proportion, an order of
 * operations, a ladder. Drawn instead, in the same material as the rest of the
 * app (24 px cards, the hairline stroke, dashed separators, lime for the
 * platform's own colour).
 *
 * Every figure is passed in from on-chain config. Nothing here is a literal.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { Card, Figure } from "../Surface";

/* ------------------------------------------------------------- primitives */

export { Card, Figure } from "../Surface";

/**
 * The connector between flow nodes. A dashed rule with an arrowhead that lies
 * down on wide screens and stands up when the flow stacks, so the diagram
 * reflows to a phone instead of scrolling sideways.
 */
function Arrow({ label }: { label?: string }) {
  return (
    <div className="flex shrink-0 flex-col items-center justify-center gap-1 py-2 md:px-2 md:py-0">
      <div className="flex items-center justify-center">
        <span className="h-6 w-px border-l border-dashed border-fig-text-800 md:h-px md:w-10 md:border-l-0 md:border-t" aria-hidden />
        <svg viewBox="0 0 8 8" className="size-2 rotate-90 text-fig-text-700 md:rotate-0" aria-hidden>
          <path d="M1 1l5 3-5 3z" fill="currentColor" />
        </svg>
      </div>
      {label && <span className="whitespace-nowrap text-h11 text-fig-text-700">{label}</span>}
    </div>
  );
}

function Node({ title, sub, tone = "plain" }: { title: string; sub: string; tone?: "plain" | "accent" }) {
  return (
    <div
      className={`flex min-w-0 flex-1 flex-col gap-1 rounded-[20px] border p-4 text-center shadow-[inset_0_6px_16px_0_rgba(0,0,0,0.16)] ${
        tone === "accent" ? "border-accent bg-accent/[0.07]" : "border-fig-stroke bg-fig-bg-additional"
      }`}
    >
      <span className={`text-h10 font-medium ${tone === "accent" ? "text-accent" : "text-fg"}`}>{title}</span>
      <span className="text-h11 leading-double text-fig-text-600">{sub}</span>
    </div>
  );
}

/* ------------------------------------------------------------ the diagrams */

/**
 * Where money goes. The one thing every reader of this page is trying to work
 * out, and the thing the old copy needed four paragraphs and a correction to
 * say: investors do not pick a trader.
 */
export function MoneyFlow({ minDeposit }: { minDeposit: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-stretch md:flex-row md:items-center">
        <Node title="You" sub={`Deposit from ${minDeposit}`} />
        <Arrow label="deposit" />
        <Node title="Common Pool" sub="One balance, one share price" tone="accent" />
        <Arrow label="in queue order" />
        <Node title="Funded traders" sub="Each gets their own vault" />
      </div>
      <p className="rounded-[16px] border border-dashed border-fig-stroke p-4 text-h11 leading-double text-fig-text-600">
        <span className="text-fg">You never choose a trader, and no trader can raise money from you.</span> The program funds whoever is next in line, as
        capacity allows, and keeps a reserve back so redemptions do not wait on a trade closing.
      </p>
    </div>
  );
}

/** 80 / 15 / 5. A proportion, so it is drawn as one. */
export function ProfitSplit() {
  const parts = [
    { pct: 80, label: "Trader", cls: "bg-accent", text: "text-accent" },
    { pct: 15, label: "Investors", cls: "bg-up", text: "text-up" },
    { pct: 5, label: "Platform", cls: "bg-fig-text-700", text: "text-fig-text-600" },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-10 w-full overflow-hidden rounded-full" role="img" aria-label="Profit split: trader 80 percent, investors 15 percent, platform 5 percent">
        {parts.map((p) => (
          <div key={p.label} className={`${p.cls} flex items-center justify-center`} style={{ width: `${p.pct}%` }}>
            <span className="num text-h11 font-semibold text-ink">{p.pct}%</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-2 text-h11">
            <span className={`size-2 rounded-full ${p.cls}`} aria-hidden />
            <span className={p.text}>{p.label}</span>
          </span>
        ))}
      </div>
      <p className="text-h11 leading-double text-fig-text-600">
        On <span className="text-fg">winning closes only</span>. The trader&rsquo;s share sits in escrow and later losses drain it first, so closing a winner
        and dumping a loser extracts nothing.
      </p>
    </div>
  );
}

/**
 * Loss order. Not a proportion (the sizes are unknowable) so it is drawn as a
 * sequence, which is the part that matters to an investor anyway.
 */
export function LossWaterfall({ cushionPct }: { cushionPct: string }) {
  const steps = [
    { n: "1st", title: "Trader's own cushion", sub: `${cushionPct} of the account, posted up front`, ring: "border-amber", dot: "bg-amber" },
    { n: "2nd", title: "Trader's unvested escrow", sub: "Profit they earned but cannot claim yet", ring: "border-amber", dot: "bg-amber" },
    { n: "3rd", title: "Investor capital", sub: "Only once both of the above are gone", ring: "border-down", dot: "bg-down" },
  ];
  return (
    <div className="flex flex-col items-stretch md:flex-row">
      {steps.map((s, i) => (
        <div key={s.n} className="flex min-w-0 flex-1 flex-col items-stretch md:flex-row">
          <div className={`flex min-w-0 flex-1 flex-col gap-1.5 rounded-[20px] border ${s.ring} bg-fig-bg-additional p-4`}>
            <span className="flex items-center gap-2">
              <span className={`size-2 shrink-0 rounded-full ${s.dot}`} aria-hidden />
              <span className="num text-h11 text-fig-text-600">{s.n}</span>
            </span>
            <span className="text-h10 font-medium text-fg">{s.title}</span>
            <span className="text-h11 leading-double text-fig-text-600">{s.sub}</span>
          </div>
          {i < steps.length - 1 && <Arrow />}
        </div>
      ))}
    </div>
  );
}

/** Two limits, two regimes. Bars make "tighter" visible without reading. */
export function LimitBars({ rows }: { rows: { label: string; standard: number; instant: number }[] }) {
  const max = Math.max(...rows.flatMap((r) => [r.standard, r.instant]), 1);
  return (
    <div className="flex flex-col gap-5">
      {rows.map((r) => (
        <div key={r.label} className="flex flex-col gap-2">
          <span className="text-h10 font-medium text-fg">{r.label}</span>
          {[
            { k: "Standard", v: r.standard, fill: "var(--fig-red-300)" },
            { k: "Instant funding", v: r.instant, fill: "var(--fig-red-400)" },
          ].map((b) => (
            <div key={b.k} className="flex items-center gap-3">
              <span className="w-[112px] shrink-0 text-h11 text-fig-text-600">{b.k}</span>
              <div className="h-3.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-fig-bg-750">
                <div className="h-full" style={{ width: `${(b.v / max) * 100}%`, backgroundImage: `repeating-linear-gradient(90deg, ${b.fill} 0 3px, transparent 3px 5px)` }} />
              </div>
              <span className="num w-12 shrink-0 text-right text-h11 text-fg">{b.v}%</span>
            </div>
          ))}
        </div>
      ))}
      <p className="text-h11 leading-double text-fig-text-600">
        Breach either and the order simply fails. Breach it between trades and the keeper locks the account for good. Single positions are never
        liquidated, and there is no second chance on the same account.
      </p>
    </div>
  );
}

/** The tier ladder, as a ladder. */
export function TierLadder({ caps, vestDays, promotionDays }: { caps: string[]; vestDays: number[]; promotionDays: number }) {
  return (
    <div className="flex flex-col items-stretch md:flex-row">
      {caps.map((cap, i) => (
        <div key={cap + i} className="flex min-w-0 flex-1 flex-col items-stretch md:flex-row">
          <div className={`flex min-w-0 flex-1 flex-col gap-2 rounded-[20px] border p-4 ${i === 0 ? "border-accent bg-accent/[0.07]" : "border-fig-stroke bg-fig-bg-additional"}`}>
            <span className="text-h11 text-fig-text-600">Tier {i + 1}</span>
            <span className={`num text-h6 font-semibold leading-none ${i === 0 ? "text-accent" : "text-fg"}`}>{cap}</span>
            <span className="text-h11 leading-double text-fig-text-600">
              {i === 0 ? "Where everyone starts" : `${promotionDays} positive days at Tier ${i}`}
              <br />
              Vesting {vestDays[i] ?? vestDays[vestDays.length - 1]} days
            </span>
          </div>
          {i < caps.length - 1 && <Arrow />}
        </div>
      ))}
    </div>
  );
}

/**
 * A journey step. The old page gave each of these a paragraph; the line is what
 * someone scanning needs, and the rest is one click away for the two people who
 * want it.
 */
export function Step({ n, title, where, href, line, children }: { n: number; title: string; where?: string; href?: string; line: string; children?: ReactNode }) {
  return (
    <li className="flex gap-4 border-b border-dashed border-fig-stroke py-5 last:border-0">
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border border-dashed border-fig-text-700 text-h11 font-medium text-fig-text-600" aria-hidden>
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-h9 font-medium text-fg">{title}</h3>
          {where && href && (
            <Link href={href} className="text-h11 text-accent hover:underline">
              {where} →
            </Link>
          )}
        </div>
        <p className="text-h11 leading-double text-fig-text-600">{line}</p>
        {children && (
          <details className="disclosure mt-1">
            <summary>Detail</summary>
            <div className="pt-2 text-h11 leading-double text-fig-text-600">{children}</div>
          </details>
        )}
      </div>
    </li>
  );
}
