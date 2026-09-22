"use client";
/**
 * Home. Disconnected: a landing. What the platform is, live numbers, how the
 * funnel works, the investor pitch. Connected: the personalised trader journey
 * (StatusCard) with the section -reference tables folded into disclosures.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { ConnectButton, Skeleton } from "@kydo/ui";
import { StatusCard } from "@/components/StatusCard";
import { indexer, type PoolSummary } from "@/lib/api";
import { fromPrice, usd, usdWhole } from "@/lib/format";
import { usePlatform } from "@/lib/platform";

export default function HomePage() {
  const { config, apiConfig, wallet, profile } = usePlatform();
  // Instant-funded trader: the dashboard talks funding, never trials.
  const instant = !!wallet && !!profile && fromPrice(profile.instantCap ?? 0) > 0;
  // Once a pool is live the account page narrates the journey twice already.
  // The summary band and the promotion card, both with real numbers. A third
  // telling in prose is what makes the page feel padded.
  const funded = !!profile && profile.poolsCreated > 0;
  const [pools, setPools] = useState<PoolSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    indexer
      .pools({})
      .then((r) => alive && setPools(r.pools))
      .catch(() => alive && setPools(null));
    return () => {
      alive = false;
    };
  }, []);
  const live = pools?.filter((x) => x.status === "live" || x.status === "funding") ?? null;
  const tvl = pools ? pools.reduce((a, x) => a + x.tvl, 0) : null;
  const fee = config ? usd(fromPrice(config.entryFee)) : "$800.00";
  const caps = config ? `${usdWhole(fromPrice(config.tierCaps[0]))} → ${usdWhole(fromPrice(config.tierCaps[2]))}` : "$5,000 → $30,000";

  const reference = (
    <>
        {/* The summary band and the promotion card both narrate this, with
            numbers, once a pool is live. A third telling in prose is padding. */}
        <details className={`disclosure rounded-[24px] bg-gradient-to-t from-fig-bg-pattern-900 to-fig-bg-600 px-5 py-4 ${funded ? "hidden" : ""}`}>
          <summary>{instant ? "Your journey" : "The funnel"}</summary>
          <ol className="flex flex-col list-decimal pl-4 pt-1 text-xs text-muted leading-relaxed [&>li]:py-1 [&>li]:border-b [&>li]:border-line/50 [&>li:last-child]:border-b-0">
            {instant ? (
              <li>
                Instant funding. Max(1.5× the trial fee, 20%) of the <span className="num text-fg">{profile ? usd(fromPrice(profile.instantCap ?? 0)) : ""}</span> Tier 1 cap, paid
              </li>
            ) : (
              <>
                <li>
                  Apply. <span className="num text-fg">{fee}</span> to the treasury
                </li>
                <li>30-day simulated trial, daily merkle root on-chain</li>
                <li>Finalize → Eligible (or 7-day cooldown)</li>
              </>
            )}
            <li>Create pool {instant ? "at your cap" : "at Tier 1"} (mandate, target, strategy)</li>
            <li>
              Funding ≥ <span className="num text-fg">{config ? usd(fromPrice(config.activationFloor)) : "$1,000"}</span> activates the pool
            </li>
            <li>Trade: 80% of net new profit escrows, vests, claims above HWM</li>
            <li>
              Promote after <span className="num text-fg">{config?.risk.promotionDays ?? 30}</span> positive live days{instant ? ". Clears the Instant badge, Tier 1 caps and vesting" : ""}
            </li>
          </ol>
        </details>
        <details className="disclosure rounded-[24px] bg-gradient-to-t from-fig-bg-pattern-900 to-fig-bg-600 px-5 py-4">
          <summary>Risk limits</summary>
          {config ? (
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 pt-1 text-xs">
              <Row l="Gross leverage" v={`≤ ${(config.risk.maxLeverageBps / 10000).toFixed(0)}×`} />
              <Row l="Concurrent positions" v={`≤ ${config.risk.maxPositions}`} />
              <Row l="Single position" v={config.risk.maxSingleBps >= 65535 ? "per-market cap" : `≤ ${config.risk.maxSingleBps / 100}% equity`} />
              <Row l="Correlated cluster" v={config.risk.maxClusterBps >= 65535 ? "uncapped" : `≤ ${config.risk.maxClusterBps / 100}% equity`} />
              <Row l="Daily loss cap" v={`${instant ? Math.min(3, config.risk.dailyLossBps / 100) : config.risk.dailyLossBps / 100}% → lock`} />
              <Row l="Max drawdown" v={`${instant ? Math.min(8, config.risk.maxDrawdownBps / 100) : config.risk.maxDrawdownBps / 100}% → lock`} />
              <Row l="Min holding time" v={`${config.risk.minHoldSecs}s`} />
              <Row l="Trades per day" v={`≤ ${config.risk.maxTradesPerDay}`} />
              <Row l="Limit band" v={`±${config.risk.limitBandBps} bps`} />
            </dl>
          ) : (
            <Skeleton lines={5} />
          )}
        </details>
        <details className="disclosure rounded-[24px] bg-gradient-to-t from-fig-bg-pattern-900 to-fig-bg-600 px-5 py-4">
          <summary>{instant ? "Instant funding terms" : "Trial pass criteria"}</summary>
          {config ? (
            instant ? (
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 pt-1 text-xs">
                <Row l="Your cap" v={profile ? usd(fromPrice(profile.instantCap ?? 0)) : "—"} />
                <Row l="Fee paid" v="max(1.5× trial fee, 20% of cap) · non-refundable" />
                <Row l="Daily loss" v="≤ 3% → lock" />
                <Row l="Max drawdown" v="≤ 8% → lock" />
                <Row l="Vesting" v="Tier 2 schedule" />
                <Row l="Badge" v="Instant, until first promotion" />
                <Row l="Platform" v={config.paused ? "PAUSED" : "active"} cls={config.paused ? "text-down" : "text-up"} />
              </dl>
            ) : (
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 pt-1 text-xs">
                <Row l="Starting balance" v={usd(fromPrice(config.trial.startingBalance))} />
                <Row l="Profit target" v={`≥ +${config.trial.profitTargetBps / 100}%`} />
                <Row l="Max drawdown" v={`≤ ${config.trial.maxDrawdownBps / 100}%`} />
                <Row l="Daily loss" v={`≤ ${config.trial.dailyLossBps / 100}%`} />
                <Row l="Active days" v={`≥ ${config.trial.minActiveDays}`} />
                <Row l="Trades" v={`≥ ${config.trial.minTrades}`} />
                <Row l="Best day share" v={`≤ ${config.trial.maxDayProfitShareBps / 100}% of profit`} />
                <Row l="Platform" v={config.paused ? "PAUSED" : "active"} cls={config.paused ? "text-down" : "text-up"} />
                {!apiConfig && <Row l="Indexer config" v="unavailable" cls="text-amber" />}
              </dl>
            )
          ) : (
            <Skeleton lines={5} />
          )}
        </details>
          </>
  );

  return (
    <div className="page gap-6">
      {!wallet && (
        <>
          {/* ================= hero ================= */}
          <section className="panel flex flex-col gap-4 px-6 py-10 lg:px-10" aria-label="Introduction">
            <h1 className="font-sans text-3xl lg:text-4xl font-semibold tracking-tight text-fg max-w-2xl leading-tight">
              Prove yourself on a 30-day trial.
              <br />
              Trade <span className="text-amber">investor capital</span> on-chain.
            </h1>
            <p className="font-sans text-sm text-muted max-w-xl leading-relaxed">
              A prop-trading platform on Solana. Pass a simulated trial under the live risk limits, open a program-owned pool, and trade capital you can never withdraw. The Common Pool funds the track record and you keep{" "}
              <span className="text-fg">80% of the profits</span>.
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <ConnectButton size="md" />
              <Link href="/invest" className="btn h-9 px-4">
                Explore pools
              </Link>
              <Link href="/guide" className="btn btn-ghost h-9 px-4">
                Rulebook
              </Link>
            </div>
          </section>

          {/* ================= live numbers ================= */}
          <section className="grid grid-cols-2 md:grid-cols-5 gap-3" aria-label="Platform numbers">
            <Tile l="Pools" v={pools === null ? null : String(pools.length)} sub={live ? `${live.length} open` : undefined} />
            <Tile l="Platform TVL" v={tvl === null ? null : usd(tvl)} sub="all pools, at NAV" />
            <Tile l="Entry fee" v={fee} sub="one attempt, to the treasury" />
            <Tile l="Pool caps" v={caps} sub="Tier 1 → Tier 3" />
            <Tile l="Profit split" v="80/15/5" sub="trader / investors / platform" />
          </section>

          {/* ================= how it works ================= */}
          <section className="grid md:grid-cols-3 gap-3" aria-label="How it works">
            <Step n={1} title="Prove it" body={`Pay ${fee} and trade a simulated $50k for 30 days against live prices. The same risk limits you'll trade under live, every order committed on-chain daily.`} />
            <Step n={2} title="Get funded" body="Pass and open your pool: the Common Pool funds it in turn, from investors backing the pool rather than picking you. The program lets you trade the vault. Never withdraw it." />
            <Step n={3} title="Earn 80%" body="80% of net new profit escrows to you, vests over 14 to 30 days with clawback, and pays out above the high-water mark. Win 1,000 and lose 1,000 and you have earned nothing. A risk breach locks the pool." />
          </section>

          {/* ================= for investors ================= */}
          <section className="panel p-5 flex flex-wrap items-center gap-4 justify-between" aria-label="For investors">
            <div className="flex flex-col gap-1 min-w-0 max-w-2xl">
              <h2 className="font-sans text-base font-semibold text-fg">Investing instead?</h2>
              <p className="font-sans text-xs text-muted leading-relaxed">
                Deposit from {usd(50).replace(".00", "")} into the Common Pool. One deposit, spread across every funded trader. You cannot fund a trader individually; the program deploys the pool in turn. An open book does not trap you: the keeper unwinds positions to free collateral. Investors bear all losses and there is no backstop fund.
              </p>
            </div>
            <Link href="/invest" className="btn btn-primary h-9 px-5 font-semibold shrink-0">
              Browse pools
            </Link>
          </section>
        </>
      )}

      {wallet && <StatusCard rail={funded ? reference : undefined} />}

      {/* Reference. Beside the promotion panel for a funded trader. That
          column ran out of content and left a hole above this band, and as
          its own row for everyone else. Same markup either way. */}
      {funded ? null : <section className="grid items-start gap-3 md:grid-cols-3" aria-label="Reference">{reference}</section>}
    </div>
  );
}

function Tile({ l, v, sub }: { l: string; v: string | null; sub?: string }) {
  return (
    <div className="panel px-4 py-3 flex flex-col gap-0.5">
      <span className="font-sans text-xxs text-muted">{l}</span>
      {v === null ? <Skeleton className="w-16 h-4 mt-1" /> : <span className="num text-lg font-semibold text-fg">{v}</span>}
      {sub && <span className="font-sans text-xxs text-muted">{sub}</span>}
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="panel p-5 flex flex-col gap-2">
      <span className="w-8 h-8 rounded-full bg-panel3 border border-line2 inline-flex items-center justify-center num text-sm font-semibold text-amber" aria-hidden>
        {n}
      </span>
      <h3 className="font-sans text-base font-semibold text-fg">{title}</h3>
      <p className="font-sans text-xs text-muted leading-relaxed">{body}</p>
    </div>
  );
}

function Row({ l, v, cls = "" }: { l: string; v: string; cls?: string }) {
  return (
    <>
      <dt className="text-muted">{l}</dt>
      <dd className={`num text-right ${cls}`}>{v}</dd>
    </>
  );
}
