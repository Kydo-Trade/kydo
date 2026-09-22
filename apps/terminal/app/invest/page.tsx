"use client";
/**
 * Invest (section 6.2): the Common Pool hero, then the browse/filter grid, full width
 * as the design draws it (Figma "Investor" 40:63817). Sans for names/labels,
 * mono for figures.
 *
 * There is no right rail. It held "Your pool" and "Your investments"; the
 * design has neither, and both were duplicates. A trader's own pool is the
 * Account page's whole job, and a position in a pool is on that pool's page,
 * next to the deposit and redeem controls that act on it.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { EmptyState, Skeleton } from "@kydo/ui";
import { indexer, type PoolSummary } from "@/lib/api";
import { ago, pct, shortAddr, usd, usdCompact } from "@/lib/format";
import { usePlatform } from "@/lib/platform";
import { CommonPoolPanel } from "@/components/CommonPoolPanel";
import { PoolAvatar } from "@/components/brand/PoolAvatar";

// `perf` (trading performance since funding) leads, not `roi`: roi is lifetime
// NAV/share - 1, which for any pool funded before the first-loss split shipped
// still carries the trader's seed cushion as though it were a return. Health
// ranks pools by how close they are to being unwound. The one number an
// investor most wants to sort on and could not.
const SORTS = [
  { key: "perf", label: "Performance" },
  { key: "health", label: "Health" },
  { key: "drawdown", label: "Drawdown" },
  { key: "age", label: "Age" },
  { key: "tvl", label: "TVL" },
] as const;

/** Status segmented control (Figma 40:64027). "Locked" maps to no indexer
    filter (the indexer only serves funding/live) so it is filtered client-side. */
const STATUS_TABS = [
  { key: "", label: "All" },
  { key: "funding", label: "Funding" },
  { key: "live", label: "Live" },
  { key: "locked", label: "Locked" },
] as const;

/** Status as plain coloured text. The design has no pill here, just the word
    in its tone colour (Figma 54:15813: "LIVE" in Green/600). */
const statusTone = (s: PoolSummary["status"]) => (s === "live" ? "text-up" : s === "funding" ? "text-amber" : "text-down");

export default function InvestPage() {
  const p = usePlatform();
  const [pools, setPools] = useState<PoolSummary[] | null>(null);
  const [sort, setSort] = useState<(typeof SORTS)[number]["key"]>("perf");
  const [mandate, setMandate] = useState<"" | "perps" | "spot">("");
  const [status, setStatus] = useState<"" | "funding" | "live" | "locked">("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      indexer
        .pools({ sort, ...(mandate ? { mandate } : {}), ...(status && status !== "locked" ? { status } : {}) } as never)
        .then((r) => alive && (setPools(status === "locked" ? r.pools.filter((x) => x.status === "locked") : r.pools), setErr(null)))
        .catch((e) => alive && setErr((e as Error).message));
    };
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sort, mandate, status, p.wallet]);

  const w = p.wallet?.toBase58();

  return (
    <div className="page">
      {/* The Common Pool hero is the page header (Figma "Investor" 40:63817). */}
      <CommonPoolPanel />

      {/* The grid below is a record, not a second way in. Say so: a wall of
          pool cards under a Deposit button reads as a menu to choose from, and
          there is no choosing. The Common Pool funds traders in FIFO order. */}
      <p className="text-h11 leading-double text-fig-text-600">
        <span className="text-fg">Where your deposit goes.</span> The Common Pool funds every trader below, in order, as capacity allows. You cannot deposit into one trader, and no trader can raise capital from you directly. These are their records: performance, drawdown, and how much of their own money is at risk ahead of yours.
        {pools ? (
          <>
            {" "}
            <span className="num text-fg">{pools.length}</span> pool{pools.length === 1 ? "" : "s"} funded so far.
          </>
        ) : null}
      </p>

      {/* Filter row (Figma 40:64027): a status segmented control, and sort on
          the right. Mandate keeps a pill select. The design omits it, but
          dropping the filter would lose function. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Status">
          {STATUS_TABS.map((t) => {
            const on = status === t.key;
            return (
              <button
                key={t.label}
                role="radio"
                aria-checked={on}
                onClick={() => setStatus(t.key)}
                className={`h-9 rounded-full px-5 text-h11 font-medium transition-colors ${
                  on ? "bg-fig-bg-500 text-fig-text-950" : "bg-fig-bg-800 text-fig-text-600 hover:text-fg"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-9 rounded-full border border-fig-stroke bg-fig-bg-additional px-4 text-h11 text-fg outline-none"
            value={mandate}
            onChange={(e) => setMandate(e.target.value as never)}
            aria-label="Mandate filter"
          >
            <option value="">All mandates</option>
            <option value="perps">Perps</option>
            <option value="spot">Spot</option>
          </select>
          <select
            className="h-9 rounded-full border border-fig-stroke bg-fig-bg-additional px-4 text-h11 text-fg outline-none"
            value={sort}
            onChange={(e) => setSort(e.target.value as never)}
            aria-label="Sort by"
          >
            {SORTS.map((o) => (
              <option key={o.key} value={o.key}>
                Sort by {o.label.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
      </div>

      {err && <div className="notice notice-bad">indexer unreachable: {err}</div>}
      {!pools && !err && <Skeleton lines={8} />}
      {pools && pools.length === 0 && (
        <EmptyState icon="◎" title={status || mandate ? "No pools match these filters" : "No traders funded yet"}>
          {status || mandate ? (
            <>
              Clear the filters to see every trader the Common Pool has funded.{" "}
              <button type="button" className="text-accent hover:underline" onClick={() => (setStatus(""), setMandate(""))}>
                Show all
              </button>
            </>
          ) : (
            <>Traders appear here as the Common Pool funds them, in queue order. Deposits into the pool are what move the queue.</>
          )}
        </EmptyState>
      )}
      {pools && pools.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {pools.map((x) => {
            const dd = Math.max(x.maxDrawdown, x.currentDrawdown);
            const fill = x.cap > 0 ? Math.min(1, x.tvl / x.cap) : 0;
            return (
              <Link key={x.address} href={`/invest/${x.address}`} className="group flex flex-col gap-3 rounded-[24px] bg-gradient-to-t from-fig-bg-pattern-900 to-fig-bg-600 p-3 transition-colors hover:to-fig-bg-750" aria-label={`Pool ${x.name}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2">
                    {/* 19 px avatar per the design (Figma 54:15805); dark glyph. The
                        lime/green gradient is far too bright for white. */}
<PoolAvatar seed={x.address} size={22} />
                    <span className="flex min-w-0 flex-col leading-double">
                      <span className="truncate text-h9 font-medium text-fg transition-colors group-hover:text-accent">{x.name || `Pool #${x.index}`}</span>
                      <span className="num truncate text-h11 text-fig-text-600">
                        {x.trader === w ? "you" : shortAddr(x.trader)} · {x.mandate}
                      </span>
                    </span>
                  </div>
                  <span className={`shrink-0 text-h10 font-medium uppercase ${statusTone(x.status)}`}>{x.status}</span>
                </div>
                {/* inner panel (Figma 54:15814). The stats sit on their own surface */}
                <div className="flex flex-col gap-3 rounded-[20px] bg-fig-bg-additional p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`num text-h5 font-semibold tracking-tight ${x.perf > 0 ? "text-up" : x.perf < 0 ? "text-down" : "text-fg"}`}
                      title="Trading performance since funding (NAV/share vs its funded baseline). Excludes the first-loss seed"
                    >
                      {pct(x.perf, 2, true)}
                    </span>
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-up px-2 py-1 text-h11 text-up"
                      title={x.tier === 0 ? "Instant funding. No trial record" : `Tier ${x.tier} cap`}
                    >
                      <CheckDot />
                      <span className="num">{usd(x.cap).replace(".00", "")}</span>
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-2 text-h11 text-fig-text-600">
                    <span className="truncate">
                      <span className="num">{x.investorCount}</span> investor{x.investorCount === 1 ? "" : "s"} · <span className="num">{x.totalTrades}</span> trades
                    </span>
                    <span className="shrink-0">{x.activatedAt ? ago(x.activatedAt) : ago(x.createdAt)}</span>
                  </div>
                  <div className="border-t border-dashed border-fig-stroke" />
                  <div className="flex flex-col gap-2">
                    <Row
                      l="Tier"
                      v={x.tier === 0 ? "Instant · no trial" : `Tier ${x.tier}`}
                      cls={x.tier === 0 ? "text-amber" : undefined}
                      title={
                        x.tier === 0
                          ? "Instant funding. This trader skipped the trial (paid a premium up front for the Tier 1 cap, tighter loss limits); no trial record exists"
                          : `Cap set by Tier ${x.tier}`
                      }
                    />
                    <Row l="Max drawdown" v={pct(-dd, 1)} />
                    {(x.firstLossSeed ?? 0) > 0 && (
                      <Row
                        l="Trader's own money"
                        v={usd(x.firstLossRemaining ?? x.firstLossSeed ?? 0)}
                        cls="text-amber"
                        title="Posted up front by the trader. Losses spend it before any investor capital moves."
                      />
                    )}
                    <Row l="PnL" v={usd(x.tradingPnl, { sign: true })} cls={x.tradingPnl < 0 ? "text-down" : "text-up"} />
                    {x.healthFactor != null && x.status === "live" && (
                      <Row
                        l="Health"
                        v={`${x.healthFactor.toFixed(2)}${x.distanceToLiquidation != null ? ` · ${usdCompact(x.distanceToLiquidation)} room` : ""}`}
                        cls={x.healthFactor <= 1 ? "text-down" : x.healthFactor < 1.05 ? "text-amber" : undefined}
                        title={
                          x.healthFactor <= 1
                            ? "Liquidatable now. NAV is at or below the binding loss floor"
                            : `NAV divided by the binding loss floor; 1.00 is the trigger. ${usd(x.distanceToLiquidation ?? 0)} of room before the keeper locks and unwinds this pool.`
                        }
                      />
                    )}
                    <div className="flex flex-col gap-1.5">
                      <Row l="Funded" v={`${usd(x.tvl)} of ${usd(x.cap)}`} />
                      <div className="h-1 overflow-hidden rounded-full bg-fig-bg-750" aria-hidden>
                        <div className={`h-full rounded-full ${x.status === "live" ? "bg-up" : "bg-accent"}`} style={{ width: `${Math.max(2, fill * 100)}%` }} />
                      </div>
                    </div>
                  </div>
                </div>
                <span className="btn-pill" aria-hidden>
                  View Pool
                </span>
              </Link>
            );
          })}
        </div>
      )}
      <p className="font-sans text-h11 leading-double text-muted">
        Investors bear all losses. There is no backstop fund. Returns are NAV-per-share since inception; every deposit into the Common Pool restarts your redemption lockup.
      </p>
    </div>
  );
}

/** Label · value row inside a pool card (Figma 54:17758 area). */
function Row({ l, v, cls, title }: { l: string; v: string; cls?: string; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-h11" title={title}>
      <span className="text-fig-text-600">{l}</span>
      <span className={`num ${cls ?? "text-fg"}`}>{v}</span>
    </div>
  );
}

/** The small check inside the cap chip. */
function CheckDot() {
  return (
    <svg viewBox="0 0 12 12" className="size-3 shrink-0" aria-hidden>
      <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M3.6 6.2l1.7 1.7 3.1-3.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
