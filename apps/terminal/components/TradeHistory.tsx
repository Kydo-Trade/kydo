"use client";
/**
 * Trade history.
 *
 * Twelve columns of equal weight. Time, Market, Side, Action, Qty, Fill,
 * Oracle, Slip, Fee, Realized, NAV after, Ref. With the one number a trader
 * opens this tab for, Realized, sitting tenth. Three of those columns were the
 * same derivation twice over: Side and Action say one thing ("closed long"),
 * and Slip is Fill measured against Oracle.
 *
 * And it had no totals. A ledger with no totals asks you to add forty rows by
 * eye to learn what the month did.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, Skeleton } from "@kydo/ui";
import type { HistoryRow, Mode, TradingBackend } from "@/lib/backend/types";
import { explainError } from "@/lib/errors";
import { price as fmtPrice, qty as fmtQty, time, usd } from "@/lib/format";

export function TradeHistory({ backend, refreshKey, indexerOnline, mode }: { backend: TradingBackend | null; refreshKey: number; indexerOnline: boolean; mode: Mode | "none" }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!backend) {
      setRows(null);
      return;
    }
    let alive = true;
    setLoading(true);
    backend
      .history()
      .then((r) => {
        if (!alive) return;
        setRows(r);
        setErr(null);
      })
      .catch((e) => alive && setErr(explainError(e).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [backend, refreshKey, tick]);

  /* A ledger's first job is its bottom line. These are the four figures you
     would otherwise reconstruct by scrolling: what the fills cost, what they
     made, and how often they worked. Win rate counts closes only. An open has
     no realized PnL and would drag the denominator.

     This sits above every early return below, and must stay there. It used to
     live next to the markup that reads it, after four `return`s that fire
     while `rows` is null, so the first render with data ran one more hook
     than the render before it and React threw #310 ("rendered more hooks than
     during the previous render"), taking the whole tab down. `rows` is null
     until the fetch lands, so that transition happened every time a trader
     with history opened this panel. */
  const totals = useMemo(() => {
    const list = rows ?? [];
    const closes = list.filter((r) => r.action === "close");
    const won = closes.filter((r) => r.realizedPnl > 0).length;
    return {
      trades: list.length,
      realized: list.reduce((a, r) => a + r.realizedPnl, 0),
      fees: list.reduce((a, r) => a + r.fee, 0),
      winRate: closes.length ? (won / closes.length) * 100 : null,
      closes: closes.length,
    };
  }, [rows]);

  if (!backend) {
    return (
      <EmptyState icon="◷" title="No trading account">
        Trade history appears once you are in a trial or have a live pool.
      </EmptyState>
    );
  }
  if (loading && rows === null) {
    return (
      <div className="p-2 flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-3 w-1/2" />
        <Skeleton lines={4} />
      </div>
    );
  }
  if (err && !rows?.length) {
    const offline = mode === "live" && !indexerOnline;
    return (
      <EmptyState
        icon="⚠"
        title={offline ? "Indexer offline" : "History unavailable"}
        action={
          <button className="btn btn-sm" onClick={reload} disabled={loading}>
            {loading ? "Retrying…" : "Retry"}
          </button>
        }
      >
        {offline ? "Live history is built from on-chain TradeFilled events served by the indexer. Positions and the risk HUD keep working from the chain directly." : err}
      </EmptyState>
    );
  }
  if (!rows || rows.length === 0) {
    return (
      <EmptyState icon="◷" title="No trades yet">
        {mode === "trial" ? "Every simulated fill is recorded as a signed, hash-chained entry and shows up here." : "Fills emit on-chain events carrying oracle price, fill price and fee. The equity curve is built from these."}
      </EmptyState>
    );
  }

  const GRID = "grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 px-3";

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-3 py-2.5">
        <Total l="Fills" v={String(totals.trades)} />
        <Total l="Realized" v={usd(totals.realized, { sign: true })} tone={totals.realized < 0 ? "text-down" : totals.realized > 0 ? "text-up" : undefined} />
        <Total l="Fees paid" v={usd(totals.fees)} />
        <Total l="Win rate" v={totals.winRate === null ? "—" : `${totals.winRate.toFixed(0)}%`} sub={totals.closes ? `of ${totals.closes} close${totals.closes === 1 ? "" : "s"}` : undefined} />
      </div>

      <div className={`${GRID} h-8 border-y border-fig-stroke text-h11 font-medium uppercase tracking-wider text-fig-text-600`}>
        <span>Trade</span>
        <span>Fill</span>
        <span className="text-right">Realized</span>
      </div>

      {rows.map((r) => {
        const slipBps = r.oraclePrice ? ((r.fillPrice - r.oraclePrice) / r.oraclePrice) * 10000 : 0;
        const long = r.side === "long";
        const base = r.symbol.split("-")[0] || r.symbol;
        const closed = r.action === "close";
        const tone = r.realizedPnl < 0 ? "text-down" : r.realizedPnl > 0 ? "text-up" : "text-fig-text-700";
        return (
          <div key={r.id} className={`${GRID} border-b border-fig-text-900 py-2.5 last:border-0`} title={`ref ${r.id}`}>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-sans text-h10 font-medium text-fg">{base}</span>
                <span className={`pill h-[18px] shrink-0 px-1.5 text-[10px] uppercase ${long ? "border-up/40 text-up" : "border-down/40 text-down"}`}>{closed ? "closed" : "opened"} {r.side}</span>
              </span>
              <span className="num truncate text-h11 text-muted">
                {time(r.ts)} · {fmtQty(r.baseQty)} {base}
              </span>
            </span>

            <span className="flex min-w-0 flex-col gap-1">
              <span className="num truncate text-h10 text-fg">{fmtPrice(r.fillPrice)}</span>
              {/* Slip is the fill measured against the oracle. Shown as the
                  one number rather than as two columns to subtract. */}
              <span className="num truncate text-h11 text-muted" title={`Oracle ${fmtPrice(r.oraclePrice)} at fill`}>
                {slipBps > 0 ? "+" : ""}
                {slipBps.toFixed(1)} bps vs oracle
              </span>
            </span>

            <span className="flex min-w-0 flex-col items-end gap-1">
              <span className={`num truncate text-h10 font-medium ${tone}`}>{closed ? usd(r.realizedPnl, { sign: true }) : "—"}</span>
              <span className="num truncate text-h11 text-muted">
                fee {usd(r.fee)} · nav {usd(r.navAfter)}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Total({ l, v, sub, tone }: { l: string; v: string; sub?: string; tone?: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-h11 font-medium uppercase tracking-wider text-fig-text-600">{l}</span>
      <span className="flex items-baseline gap-1.5">
        <span className={`num text-h9 font-semibold ${tone ?? "text-fg"}`}>{v}</span>
        {sub && <span className="text-h11 text-muted">{sub}</span>}
      </span>
    </span>
  );
}
