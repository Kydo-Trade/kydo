"use client";
import { useEffect, useRef, useState } from "react";
import { ColorType, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { indexer, type EquityPoint } from "@/lib/api";
import { useFeedMessage } from "@/lib/ws";
import type { HistoryRow, Mode } from "@/lib/backend/types";
import { pct, usd } from "@/lib/format";
import { CHART_DARK, CHART_DOWN, CHART_FONT, CHART_FONT_SIZE, CHART_UP } from "@/lib/chartTheme";

/**
 * Equity curve: live pools load `/pools/:address/equity` and append WS `nav`
 * messages; the trial has no history endpoint, so the curve is the session's
 * NAV samples.
 */
export function EquityChart({ mode, poolAddress, nav, ready, indexerOnline, fills = [] }: { mode: Mode | "none"; poolAddress?: string; nav: number; ready: boolean; indexerOnline: boolean; fills?: HistoryRow[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const pointsRef = useRef<EquityPoint[]>([]);
  const [count, setCount] = useState(0);
  const [source, setSource] = useState<string>("session");

  /** Trade markers on the curve: snapped to the nearest NAV point at or before the fill. */
  const applyMarkers = () => {
    const pts = pointsRef.current;
    const series = seriesRef.current;
    if (!series || !pts.length) return;
    const markers = fills
      .map((f) => {
        if (f.ts < pts[0].ts) return null;
        let lo = 0;
        let hi = pts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (pts[mid].ts <= f.ts) lo = mid;
          else hi = mid - 1;
        }
        const buy = f.side === "long";
        const close = f.action === "close";
        return {
          time: pts[lo].ts as UTCTimestamp,
          position: close ? ("aboveBar" as const) : ("belowBar" as const),
          shape: close ? ("circle" as const) : buy ? ("arrowUp" as const) : ("arrowDown" as const),
          color: close ? (f.realizedPnl >= 0 ? CHART_UP : CHART_DOWN) : buy ? CHART_UP : CHART_DOWN,
          size: 1,
          text: close ? `Close ${f.symbol} ${usd(f.realizedPnl, { sign: true })}` : `${buy ? "Buy" : "Sell"} ${f.symbol}`,
        };
      })
      .filter((m): m is NonNullable<typeof m> => !!m)
      .sort((a, b) => Number(a.time) - Number(b.time));
    series.setMarkers(markers as any);
  };

  useEffect(() => {
    if (!ref.current) return;
    const skin = CHART_DARK;
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: skin.bg }, textColor: skin.text, fontSize: CHART_FONT_SIZE, fontFamily: CHART_FONT },
      grid: { vertLines: { color: skin.grid }, horzLines: { color: skin.grid } },
      rightPriceScale: { borderColor: skin.border },
      timeScale: { borderColor: skin.border, timeVisible: true, secondsVisible: true },
    });
    const series = chart.addAreaSeries({ lineColor: CHART_UP, topColor: "rgba(0,208,91,0.30)", bottomColor: "rgba(0,208,91,0.02)", lineWidth: 2 });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // The series rejects out-of-order times, and history loads race live appends.
  // One ref tracks the newest time actually plotted, and setAll normalises input.
  const lastTsRef = useRef(0);
  const setAll = (raw: EquityPoint[]) => {
    const pts: EquityPoint[] = [];
    for (const p of [...raw].sort((a, b) => a.ts - b.ts)) {
      if (pts.length && pts[pts.length - 1].ts === p.ts) pts[pts.length - 1] = p; // dedupe: last sample of a second wins
      else pts.push(p);
    }
    pointsRef.current = pts;
    lastTsRef.current = pts.length ? pts[pts.length - 1].ts : 0;
    seriesRef.current?.setData(pts.map((p) => ({ time: p.ts as UTCTimestamp, value: p.nav })));
    chartRef.current?.timeScale().fitContent();
    setCount(pts.length);
    applyMarkers();
  };

  // re-place markers whenever the fills change (a new trade) or the curve gains points
  useEffect(() => {
    applyMarkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fills, count]);
  const append = (p: EquityPoint) => {
    const arr = pointsRef.current;
    if (p.ts < lastTsRef.current) return; // stale sample from before the last plotted point
    try {
      const last = arr[arr.length - 1];
      if (last && p.ts === last.ts) last.nav = p.nav;
      else arr.push(p);
      seriesRef.current?.update({ time: p.ts as UTCTimestamp, value: p.nav });
      lastTsRef.current = p.ts;
      setCount(arr.length);
    } catch {
      // the series and our buffer diverged (reset/history race). Rebuild from the buffer
      arr.push(p);
      setAll(arr);
    }
  };

  // load history for live pools
  useEffect(() => {
    pointsRef.current = [];
    lastTsRef.current = 0;
    seriesRef.current?.setData([]);
    setCount(0);
    setSource("session");
    if (mode !== "live" || !poolAddress) return;
    let alive = true;
    indexer
      .poolEquity(poolAddress)
      .then((r) => {
        if (!alive) return;
        setAll(r.points.slice().sort((a, b) => a.ts - b.ts));
        setSource("indexer");
      })
      .catch(() => setSource("session (indexer offline)"));
    return () => {
      alive = false;
    };
  }, [mode, poolAddress]);

  useFeedMessage(
    "nav",
    (m) => {
      if (mode === "live" && m.pool === poolAddress) append({ ts: m.ts, nav: m.nav, navPerShare: m.navPerShare });
    },
    [mode, poolAddress],
  );

  // session samples (both modes; live only when the indexer did not supply data recently)
  useEffect(() => {
    if (!ready || !Number.isFinite(nav) || nav <= 0) return;
    const now = Math.floor(Date.now() / 1000);
    const last = pointsRef.current[pointsRef.current.length - 1];
    if (last && now - last.ts < 5) return;
    append({ ts: now, nav, navPerShare: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav, ready]);

  // a fresh fill always adds a point right away so the curve reacts to the trade, not to the next timer tick
  useEffect(() => {
    if (!ready || !Number.isFinite(nav) || nav <= 0 || !fills.length) return;
    append({ ts: Math.floor(Date.now() / 1000), nav, navPerShare: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fills.length]);

  const first = pointsRef.current[0]?.nav;
  const lastPt = pointsRef.current[pointsRef.current.length - 1]?.nav;
  const chg = first && lastPt ? lastPt - first : 0;
  const chgPct = first && lastPt ? lastPt / first - 1 : 0;
  return (
    <div className="panel flex flex-col h-full min-h-[120px]" aria-label="Equity curve">
      <div className="panel-title">
        <span className="flex items-center gap-2 min-w-0">
          Equity curve
          <span className="meta">
            {source} · <span className="num">{count}</span> pts
          </span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {mode === "live" && !indexerOnline && (
            <span className="pill pill-amber" title="The indexer serves NAV history; session samples continue meanwhile">
              indexer offline
            </span>
          )}
          <span className={`num normal-case tracking-normal ${chg < 0 ? "text-down" : chg > 0 ? "text-up" : "text-muted"}`} title="Change over the loaded curve">
            {usd(chg, { sign: true })} ({pct(chgPct, 2, true)})
          </span>
        </span>
      </div>
      <div className="relative flex-1 min-h-[90px]">
        <div ref={ref} className="absolute inset-0" />
        {count === 0 && <div className="absolute inset-0 flex items-center justify-center text-xxs text-muted bg-panel/60">{mode === "none" ? "no account" : ready ? "collecting NAV samples…" : "loading…"}</div>}
      </div>
    </div>
  );
}
