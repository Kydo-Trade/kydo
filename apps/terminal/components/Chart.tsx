"use client";
/**
 * Price chart, TradingView / Drift layout:
 *   toolbar   1m 5m 15m 1H 4H 1D · style · ƒx Indicators · [Mark | Oracle] · (tabs slot) · fullscreen
 *   legend    SYMBOL-USDC · tf · Pyth   O H L C  Δ (Δ%)
 *   marks     B / S / C discs above (buy, close) or below (sell) the fill's candle, hover bubble "Buy at $…"
 *   entry     dashed line at the open position's entry with a "PNL … | Size …" tag and an axis label
 *   footer    oracle-tick note · UTC clock · % / log / auto price-scale modes
 * Candles are built client-side from oracle ticks (lib/prices); "Mark" overlays the on-chain mark
 * price as the last-price line. There is no mark-price history to draw candles from.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Skeleton } from "@kydo/ui";
import { ColorType, CrosshairMode, LineStyle, PriceScaleMode, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { priceStore, usePrices, type Candle } from "@/lib/prices";
import type { HistoryRow } from "@/lib/backend/types";
import type { Position } from "@/lib/api";
import type { Trigger } from "@/lib/triggers";
import { price as fmtPrice, pct, qty as fmtQty, time, usd } from "@/lib/format";
import { ChartArea, ChartCandlestick, Maximize2, Minimize2, SquareFunction } from "lucide-react";
import { CHART_ACCENT, CHART_CLOSE, CHART_DARK, CHART_DOWN, CHART_FONT, CHART_FONT_SIZE, CHART_MARK, CHART_UP } from "@/lib/chartTheme";

type Kind = "candles" | "bars" | "ha" | "area" | "baseline";
const KINDS: { kind: Kind; label: string; hint: string }[] = [
  { kind: "candles", label: "Candles", hint: "Japanese candlesticks" },
  { kind: "bars", label: "Bars", hint: "OHLC bars" },
  { kind: "ha", label: "Heikin Ashi", hint: "Trend-smoothed candles (averaged OHLC)" },
  { kind: "area", label: "Area", hint: "Close-price area" },
  { kind: "baseline", label: "Baseline", hint: "Green above / red below the first loaded close" },
];
type Src = "mark" | "oracle";
type Tf = 1 | 5 | 15 | 60 | 240 | 1440;
const TFS: { tf: Tf; label: string }[] = [
  { tf: 1, label: "1m" },
  { tf: 5, label: "5m" },
  { tf: 15, label: "15m" },
  { tf: 60, label: "1H" },
  { tf: 240, label: "4H" },
  { tf: 1440, label: "1D" },
];
type IndKey = "sma20" | "ema50";
const INDICATORS: { key: IndKey; label: string; n: number; ema: boolean; color: string }[] = [
  { key: "sma20", label: "SMA 20", n: 20, ema: false, color: CHART_ACCENT },
  { key: "ema50", label: "EMA 50", n: 50, ema: true, color: CHART_ACCENT },
];

const UP = CHART_UP;
const DOWN = CHART_DOWN;
const CLOSE = CHART_CLOSE;
const MARK = CHART_MARK;

/** Structural chart colours per theme (candle green/red stay identical in both, like bulk). */
export const CHART_SKINS = { dark: CHART_DARK } as const;

const baseOptions = (skin: (typeof CHART_SKINS)[keyof typeof CHART_SKINS]) => ({
  layout: { background: { type: ColorType.Solid, color: skin.bg }, textColor: skin.text, fontSize: CHART_FONT_SIZE, fontFamily: CHART_FONT },
  grid: { vertLines: { color: skin.grid }, horzLines: { color: skin.grid } },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: skin.text, style: LineStyle.Dashed, width: 1 as const, labelBackgroundColor: skin.labelBg },
    horzLine: { color: skin.text, style: LineStyle.Dashed, width: 1 as const, labelBackgroundColor: skin.labelBg },
  },
  rightPriceScale: { borderColor: skin.border, scaleMargins: { top: 0.12, bottom: 0.08 } },
  timeScale: { borderColor: skin.border, timeVisible: true, secondsVisible: false, rightOffset: 6 },
  localization: { priceFormatter: (p: number) => fmtPrice(p) },
});

/** Heikin-Ashi transform. Each bar averages its own OHLC with the previous HA bar. */
function heikinAshi(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const close = (c.open + c.high + c.low + c.close) / 4;
    const open = i === 0 ? (c.open + c.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({ time: c.time, open, high: Math.max(c.high, open, close), low: Math.min(c.low, open, close), close, volume: c.volume });
  }
  return out;
}

/** Bollinger Bands (n, k σ) over the closes. Middle SMA plus upper/lower envelopes. */
function bollinger(candles: Candle[], n: number, k: number): { time: UTCTimestamp; middle: number; upper: number; lower: number }[] {
  const out: { time: UTCTimestamp; middle: number; upper: number; lower: number }[] = [];
  if (candles.length < n) return out;
  for (let i = n - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += candles[j].close;
    const mean = sum / n;
    let varsum = 0;
    for (let j = i - n + 1; j <= i; j++) varsum += (candles[j].close - mean) ** 2;
    const sd = Math.sqrt(varsum / n);
    out.push({ time: candles[i].time as UTCTimestamp, middle: mean, upper: mean + k * sd, lower: mean - k * sd });
  }
  return out;
}

/** Roll 1-minute candles up into `tf`-minute candles (oldest → newest). */
function aggregate(candles: Candle[], tf: Tf): Candle[] {
  if (tf === 1) return candles;
  const size = tf * 60;
  const out: Candle[] = [];
  for (const c of candles) {
    const bucket = Math.floor(c.time / size) * size;
    const last = out[out.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      if (c.volume !== undefined) last.volume = (last.volume ?? 0) + c.volume;
    } else out.push({ time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
  }
  return out;
}

/** Simple / exponential moving average of the closes; undefined until `n` candles exist. */
function movingAverage(candles: Candle[], n: number, ema: boolean): { time: UTCTimestamp; value: number }[] {
  const out: { time: UTCTimestamp; value: number }[] = [];
  if (candles.length < n) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += candles[i].close;
  let prev = sum / n;
  out.push({ time: candles[n - 1].time as UTCTimestamp, value: prev });
  const k = 2 / (n + 1);
  for (let i = n; i < candles.length; i++) {
    if (ema) prev = candles[i].close * k + prev * (1 - k);
    else {
      sum += candles[i].close - candles[i - n].close;
      prev = sum / n;
    }
    out.push({ time: candles[i].time as UTCTimestamp, value: prev });
  }
  return out;
}

interface TradeMark {
  id: string;
  x: number;
  y: number;
  fill: HistoryRow;
}

/** Snap a fill to the candle it belongs to; undefined when it predates the loaded candles. */
function candleAt(ts: number, candles: Candle[]): Candle | undefined {
  if (!candles.length || ts < candles[0].time) return undefined;
  let lo = 0;
  let hi = candles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid].time <= ts) lo = mid;
    else hi = mid - 1;
  }
  return candles[lo];
}

function utcClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19) + " UTC";
}

export function Chart({
  marketId,
  symbol,
  fills = [],
  position = null,
  mark,
  tabs,
  triggers = [],
}: {
  marketId: number | null;
  symbol: string;
  fills?: HistoryRow[];
  position?: Position | null;
  /** On-chain mark price (undefined while unknown). Drives the Mark / Oracle toggle */
  mark?: number;
  /** Right-hand toolbar slot: the page's Chart / Equity-curve tabs, like TradingView's Chart · Depth · … */
  tabs?: ReactNode;
  /** Client-side SL/TP triggers (section 4.5). Drawn as dashed price lines like resting orders. */
  triggers?: Trigger[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Area"> | null>(null);
  const entryLineRef = useRef<IPriceLine | null>(null);
  const markLineRef = useRef<IPriceLine | null>(null);
  const [kind, setKind] = useState<Kind>("candles");
  const [tf, setTf] = useState<Tf>(5);
  const [src, setSrc] = useState<Src>("oracle");
  const [inds, setInds] = useState<Record<IndKey, boolean>>({ sma20: false, ema50: false });
  const [showVol, setShowVol] = useState(false);
  const [showBB, setShowBB] = useState(false);
  const [scaleMode, setScaleMode] = useState<"normal" | "percent" | "log">("normal");
  const [autoScale, setAutoScale] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [hover, setHover] = useState<Candle | null>(null);
  const [marks, setMarks] = useState<TradeMark[]>([]);
  const [entryY, setEntryY] = useState<number | null>(null);
  const [hoverMark, setHoverMark] = useState<string | null>(null);
  const [clock, setClock] = useState<string>("");
  const snap = usePrices();
  const tick = marketId !== null ? snap.prices[marketId] : undefined;

  useEffect(() => setHover(null), [marketId]);

  // native <details> popovers don't close on outside click. Do it for them
  useEffect(() => {
    const close = (e: Event) => {
      document.querySelectorAll<HTMLDetailsElement>("details.tv-dd[open]").forEach((d) => {
        if (e instanceof KeyboardEvent || !d.contains(e.target as Node)) d.removeAttribute("open");
      });
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(e);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // UTC clock in the footer (TradingView draws one under the price scale)
  useEffect(() => {
    const t = setInterval(() => setClock(utcClock(Date.now())), 1000);
    setClock(utcClock(Date.now()));
    return () => clearInterval(t);
  }, []);

  // fullscreen state follows the browser (Esc leaves it too)
  useEffect(() => {
    const h = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", h);
    return () => document.removeEventListener("fullscreenchange", h);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen?.();
  };

  // create chart
  useEffect(() => {
    if (!ref.current) return;
    const chart = createChart(ref.current, { ...baseOptions(CHART_DARK), autoSize: true });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.applyOptions({}));
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      entryLineRef.current = null;
      markLineRef.current = null;
    };
  }, []);

  // price-scale modes (%, log, auto). The same three switches TradingView keeps under the axis
  useEffect(() => {
    chartRef.current?.applyOptions({
      rightPriceScale: { mode: scaleMode === "percent" ? PriceScaleMode.Percentage : scaleMode === "log" ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal, autoScale },
    });
  }, [scaleMode, autoScale]);

  // (re)build series on market / kind / timeframe / indicator change and stream updates
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || marketId === null) return;
    const ohlcKind = kind === "candles" || kind === "bars" || kind === "ha";
    const firstClose = priceStore.getCandles(marketId)[0]?.close ?? 0;
    const series =
      kind === "candles" || kind === "ha"
        ? chart.addCandlestickSeries({ upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false, priceLineStyle: LineStyle.Dotted })
        : kind === "bars"
          ? chart.addBarSeries({ upColor: UP, downColor: DOWN, thinBars: false, priceLineStyle: LineStyle.Dotted })
          : kind === "baseline"
            ? chart.addBaselineSeries({
                baseValue: { type: "price", price: firstClose },
                topLineColor: UP,
                topFillColor1: "rgba(0, 208, 91,0.25)",
                topFillColor2: "rgba(0, 208, 91,0.02)",
                bottomLineColor: DOWN,
                bottomFillColor1: "rgba(255, 95, 46,0.02)",
                bottomFillColor2: "rgba(255, 95, 46,0.25)",
                lineWidth: 2,
                priceLineStyle: LineStyle.Dotted,
              })
            : chart.addAreaSeries({ lineColor: CHART_ACCENT, topColor: "rgba(183,255,0,0.22)", bottomColor: "rgba(183,255,0,0.02)", lineWidth: 2, priceLineStyle: LineStyle.Dotted });
    seriesRef.current = series as ISeriesApi<"Candlestick">;
    const toPoint = (c: Candle) => (ohlcKind ? { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close } : { time: c.time as UTCTimestamp, value: c.close });
    const data = () => {
      const agg = aggregate(priceStore.getCandles(marketId), tf);
      return kind === "ha" ? heikinAshi(agg) : agg;
    };
    // volume histogram in a bottom pane of the same chart (exchange-kline bars only. Oracle ticks carry no volume)
    const volSeries = showVol
      ? chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false, color: "rgba(141, 141, 141,0.4)" })
      : null;
    if (volSeries) chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const volPoint = (c: Candle) => ({ time: c.time as UTCTimestamp, value: c.volume ?? 0, color: c.close >= c.open ? "rgba(0, 208, 91,0.45)" : "rgba(255, 95, 46,0.45)" });
    // Bollinger Bands (20, 2σ)
    const bbSeries = showBB
      ? (["upper", "middle", "lower"] as const).map((band) => ({
          band,
          series: chart.addLineSeries({
            color: band === "middle" ? "rgba(152,162,176,0.9)" : "rgba(152,162,176,0.45)",
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          }),
        }))
      : [];
    const overlays = INDICATORS.filter((d) => inds[d.key]).map((d) => ({ def: d, series: chart.addLineSeries({ color: d.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }) }));

    // Trade discs and the entry tag are DOM elements laid over the pane. Repositioned whenever the
    // visible range, data or size changes. Buys / closes sit above the candle, sells below it.
    const layout = () => {
      const candles = data();
      if (!candles.length) {
        setMarks([]);
        setEntryY(null);
        return;
      }
      const ts = chart.timeScale();
      const out: TradeMark[] = [];
      fills.forEach((f, i) => {
        const c = candleAt(f.ts, candles);
        if (!c) return;
        const x = ts.timeToCoordinate(c.time as UTCTimestamp);
        const above = f.side === "long" || f.action === "close";
        const edge = series.priceToCoordinate(above ? c.high : c.low);
        if (x === null || edge === null) return;
        const y = above ? edge - 18 : edge + 18;
        const h = ref.current?.clientHeight ?? 0;
        if (y < -24 || (h > 0 && y > h + 24)) return; // off-pane price → no disc
        out.push({ id: `${f.id}-${i}`, x, y, fill: f });
      });
      setMarks(out);
      const ey = position ? series.priceToCoordinate(position.entryPrice) : null;
      const paneH = ref.current?.clientHeight ?? 0;
      setEntryY(ey !== null && ey >= 0 && (paneH === 0 || ey <= paneH) ? ey : null);
      // a scroll / drag on the axis switches auto-scale off inside the library; mirror it in the footer switch
      try {
        setAutoScale(series.priceScale().options().autoScale);
      } catch {
        /* the pane is gone (chart torn down between a resize and this callback) */
      }
    };
    let disposed = false;
    const onRange = () => {
      if (!disposed) layout();
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    const ro = new ResizeObserver(onRange);
    if (ref.current) ro.observe(ref.current);

    // entry line of the open position in this market (colour follows the PnL sign, see below)
    if (position) {
      entryLineRef.current = series.createPriceLine({
        price: position.entryPrice,
        color: position.unrealizedPnl < 0 ? DOWN : UP,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "",
      });
    }
    // Section 4.5 client-side SL/TP. Dashed "resting order" lines at their trigger prices
    const trigLines: IPriceLine[] = [];
    for (const t of triggers) {
      if (t.marketId !== marketId) continue;
      if (t.stopLoss) trigLines.push(series.createPriceLine({ price: t.stopLoss, color: DOWN, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "SL" }));
      if (t.takeProfit) trigLines.push(series.createPriceLine({ price: t.takeProfit, color: UP, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "TP" }));
    }

    // Mark mode: the series' own last-price line goes away and the mark price takes its place
    series.applyOptions({ priceLineVisible: src === "oracle", lastValueVisible: src === "oracle" });
    if (src === "mark" && mark) {
      markLineRef.current = series.createPriceLine({ price: mark, color: MARK, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "" });
    }

    const push = () => {
      const candles = data();
      if (!candles.length) return;
      (series as ISeriesApi<"Candlestick">).setData(candles.map(toPoint) as any);
      for (const o of overlays) o.series.setData(movingAverage(candles, o.def.n, o.def.ema));
      if (volSeries) volSeries.setData(candles.map(volPoint));
      if (bbSeries.length) {
        const bands = bollinger(candles, 20, 2);
        for (const b of bbSeries) b.series.setData(bands.map((x) => ({ time: x.time, value: x[b.band] })));
      }
    };
    push();
    chart.timeScale().fitContent();
    const t0 = setTimeout(onRange, 0);
    let lastLen = data().length;
    const unsub = priceStore.subscribe(() => {
      const candles = data();
      const last = candles[candles.length - 1];
      if (!last) return;
      if (kind === "ha" || (candles.length !== lastLen && candles.length !== lastLen + 1)) push(); // HA bars depend on their predecessors. Rebuild
      else {
        (series as ISeriesApi<"Candlestick">).update(toPoint(last) as any);
        for (const o of overlays) {
          const pts = movingAverage(candles, o.def.n, o.def.ema);
          if (pts.length) o.series.update(pts[pts.length - 1]);
        }
        if (volSeries) volSeries.update(volPoint(last));
        if (bbSeries.length) {
          const bands = bollinger(candles, 20, 2);
          const b0 = bands[bands.length - 1];
          if (b0) for (const b of bbSeries) b.series.update({ time: b0.time, value: b0[b.band] });
        }
      }
      lastLen = candles.length;
      layout();
    });
    // crosshair → OHLC read-out
    const onMove = (param: any) => {
      const d = param?.seriesData?.get(series) as any;
      if (!d || !param.time) return setHover(null);
      setHover({ time: Number(param.time), open: d.open ?? d.value, high: d.high ?? d.value, low: d.low ?? d.value, close: d.close ?? d.value });
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      disposed = true;
      clearTimeout(t0);
      unsub();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      ro.disconnect();
      chart.unsubscribeCrosshairMove(onMove);
      entryLineRef.current = null;
      markLineRef.current = null;
      // the create-chart effect above cleans up first on unmount. Its chart.remove() already took the series with it
      if (chartRef.current === chart) {
        for (const l of trigLines) series.removePriceLine(l);
        for (const o of overlays) chart.removeSeries(o.series);
        if (volSeries) chart.removeSeries(volSeries);
        for (const b of bbSeries) chart.removeSeries(b.series);
        chart.removeSeries(series as ISeriesApi<"Candlestick">);
      }
      seriesRef.current = null;
      setMarks([]);
      setEntryY(null);
    };
  }, [marketId, kind, tf, fills, inds, showVol, showBB, src, position?.entryPrice, position?.side, position?.baseQty, JSON.stringify(triggers)]);

  // live updates that must not rebuild the series: mark price and the entry line's PnL colour
  useEffect(() => {
    if (mark && markLineRef.current) markLineRef.current.applyOptions({ price: mark });
  }, [mark]);
  const pnlNeg = (position?.unrealizedPnl ?? 0) < 0;
  useEffect(() => {
    entryLineRef.current?.applyOptions({ color: pnlNeg ? DOWN : UP });
  }, [pnlNeg]);

  const candles = useMemo(() => (marketId !== null ? aggregate(priceStore.getCandles(marketId), tf) : []), [marketId, tf, snap.version]);
  const last = candles[candles.length - 1];
  const shown = hover ?? last;
  const barChg = shown ? shown.close - shown.open : 0;
  const barCls = barChg > 0 ? "text-up" : barChg < 0 ? "text-down" : "text-muted";
  const tfLabel = TFS.find((t) => t.tf === tf)?.label ?? "5m";
  const indCount = INDICATORS.filter((d) => inds[d.key]).length + (showBB ? 1 : 0) + (showVol ? 1 : 0);
  const entryColor = pnlNeg ? DOWN : UP;

  return (
    <div ref={rootRef} className="flex flex-col h-full min-h-[220px] bg-panel" aria-label="Price chart">
      {/* toolbar: timeframes · style · indicators · Mark / Oracle · tabs · fullscreen */}
      <div className="flex items-center gap-0.5 px-2 h-9 border-b border-line shrink-0">
        <span className="flex items-center" role="radiogroup" aria-label="Timeframe">
          {TFS.map((t) => (
            <button key={t.tf} className={`tv-btn ${tf === t.tf ? "tv-btn--on" : ""}`} role="radio" aria-checked={tf === t.tf} onClick={() => setTf(t.tf)}>
              {t.label}
            </button>
          ))}
        </span>
        <span className="tv-sep" aria-hidden />
        <details className="relative tv-dd">
          <summary className="tv-btn list-none" aria-label="Chart style" title={KINDS.find((k) => k.kind === kind)?.label}>
            {kind === "area" || kind === "baseline" ? <ChartArea size={16} aria-hidden /> : <ChartCandlestick size={16} aria-hidden />}
            <span className="hidden lg:inline">{KINDS.find((k) => k.kind === kind)?.label}</span>
          </summary>
          <div className="popover left-0 min-w-[160px]" role="radiogroup" aria-label="Chart style">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                role="radio"
                aria-checked={kind === k.kind}
                className={`flex items-center gap-2 w-full h-7 px-1 rounded text-left hover:bg-panel2 ${kind === k.kind ? "text-amber" : ""}`}
                title={k.hint}
                onClick={(e) => {
                  setKind(k.kind);
                  (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
                }}
              >
                {k.kind === "area" || k.kind === "baseline" ? <ChartArea size={14} aria-hidden /> : <ChartCandlestick size={14} aria-hidden />}
                {k.label}
              </button>
            ))}
          </div>
        </details>
        <span className="tv-sep" aria-hidden />
        <details className="relative tv-dd">
          <summary className={`tv-btn list-none ${indCount ? "tv-btn--on" : ""}`} aria-label="Indicators">
            <SquareFunction size={16} aria-hidden />
            <span className="hidden md:inline">Indicators{indCount ? ` · ${indCount}` : ""}</span>
          </summary>
          <div className="popover left-0 min-w-[180px]" role="group" aria-label="Indicators">
            {INDICATORS.map((d) => (
              <label key={d.key} className="flex items-center gap-2 h-7 px-1 rounded cursor-pointer hover:bg-panel2">
                <input type="checkbox" className="accent-accent" checked={inds[d.key]} onChange={(e) => setInds((s) => ({ ...s, [d.key]: e.target.checked }))} />
                <span className="w-2 h-2 rounded-full" style={{ background: d.color }} aria-hidden />
                {d.label}
              </label>
            ))}
            <label className="flex items-center gap-2 h-7 px-1 rounded cursor-pointer hover:bg-panel2" title="Bollinger Bands. SMA 20 ± 2σ envelopes">
              <input type="checkbox" className="accent-accent" checked={showBB} onChange={(e) => setShowBB(e.target.checked)} />
              <span className="w-2 h-2 rounded-full" style={{ background: CHART_MARK }} aria-hidden />
              BB 20 · 2σ
            </label>
            <label className="flex items-center gap-2 h-7 px-1 rounded cursor-pointer hover:bg-panel2" title="Volume histogram. Exchange-kline bars only; live oracle-tick bars carry no volume">
              <input type="checkbox" className="accent-accent" checked={showVol} onChange={(e) => setShowVol(e.target.checked)} />
              <span className="w-2 h-2 rounded-full" style={{ background: "rgba(141, 141, 141,0.7)" }} aria-hidden />
              Volume
            </label>
          </div>
        </details>
        <span className="tv-sep" aria-hidden />
        <span className="tv-seg" role="radiogroup" aria-label="Price source">
          <button role="radio" aria-checked={src === "mark"} disabled={!mark} onClick={() => setSrc("mark")} title={mark ? "Last price = on-chain mark (candles stay oracle-built)" : "Mark price unavailable"}>
            Mark
          </button>
          <button role="radio" aria-checked={src === "oracle"} onClick={() => setSrc("oracle")} title="Last price = Pyth oracle">
            Oracle
          </button>
        </span>
        <span className="flex-1" />
        {tabs}
        <button className="tv-btn ml-1" onClick={toggleFullscreen} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} title={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
          {fullscreen ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
        </button>
      </div>

      <div className="relative flex-1 min-h-[180px] overflow-hidden">
        <div ref={ref} className="absolute inset-0" />

        {/* entry tag: PNL | Size, on the entry line's left end */}
        {position && entryY !== null && (
          <div className="absolute left-2 z-[2] pointer-events-none select-none" style={{ top: entryY, transform: "translateY(-50%)" }}>
            <span className="num inline-block px-1.5 h-5 leading-5 rounded-sm text-xxs font-bold text-ink" style={{ background: entryColor }} title={`${position.side === "long" ? "Long" : "Short"} entry ${fmtPrice(position.entryPrice)}`}>
              PNL {usd(position.unrealizedPnl, { sign: true })} | Size {fmtQty(position.baseQty)}
            </span>
          </div>
        )}

        {/* trade discs (B / S / C) with hover bubbles */}
        <div className="absolute inset-0 pointer-events-none z-[3]" aria-hidden={marks.length === 0}>
          {marks.map((m) => {
            const f = m.fill;
            const buy = f.side === "long";
            const close = f.action === "close";
            const color = close ? CLOSE : buy ? UP : DOWN;
            const verb = close ? "Close" : buy ? "Buy" : "Sell";
            const active = hoverMark === m.id;
            const flip = m.x < 240;
            return (
              <div key={m.id} className="absolute" style={{ left: m.x, top: m.y, transform: "translate(-50%, -50%)", zIndex: active ? 10 : 1 }}>
                <button
                  type="button"
                  className="tv-disc pointer-events-auto"
                  style={{ background: color }}
                  onMouseEnter={() => setHoverMark(m.id)}
                  onMouseLeave={() => setHoverMark((h) => (h === m.id ? null : h))}
                  onFocus={() => setHoverMark(m.id)}
                  onBlur={() => setHoverMark((h) => (h === m.id ? null : h))}
                  aria-label={`${verb} ${fmtQty(f.baseQty)} ${symbol} at ${fmtPrice(f.fillPrice)}`}
                >
                  {verb[0]}
                </button>
                {active && (
                  <div className={`tv-bubble ${flip ? "tv-bubble--right" : "tv-bubble--left"}`} role="tooltip">
                    <div className="text-sm text-fg whitespace-nowrap">
                      {verb} at {usd(f.fillPrice)}
                    </div>
                    <div className="num text-xxs text-muted whitespace-nowrap">
                      {fmtQty(f.baseQty)} {symbol} · {time(f.ts, false)} UTC
                      {close && (
                        <>
                          {" · "}
                          <span className={f.realizedPnl >= 0 ? "text-up" : "text-down"}>{usd(f.realizedPnl, { sign: true })}</span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* legend: SYMBOL · tf · source  O H L C Δ */}
        <div className="absolute left-2 top-2 z-[2] flex items-center gap-2 pointer-events-none select-none">
          <span className="inline-flex items-center h-7 px-2 rounded border border-line2 bg-panel/80 text-sm font-medium text-fg whitespace-nowrap">
            {symbol ? `${symbol}-USDC` : "—"} · {tfLabel} · {src === "mark" ? "Mark" : "Pyth"}
          </span>
          {shown ? (
            <span className={`num text-xs ${barCls} whitespace-nowrap`}>
              <span className="text-muted">O</span> {fmtPrice(shown.open)} <span className="text-muted">H</span> {fmtPrice(shown.high)} <span className="text-muted">L</span> {fmtPrice(shown.low)} <span className="text-muted">C</span> {fmtPrice(shown.close)}
              {barChg !== 0 && ` ${barChg > 0 ? "+" : ""}${fmtPrice(barChg)} (${pct(shown.open ? barChg / shown.open : 0, 2, true)})`}
            </span>
          ) : (
            <Skeleton className="w-40 h-3" />
          )}
        </div>

        {candles.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-xxs text-muted bg-panel/60" aria-busy="true">
            {marketId === null ? "select a market" : "waiting for price ticks…"}
          </div>
        )}
      </div>

      {/* footer: source note · UTC clock · price-scale modes */}
      <div className="flex items-center gap-1 px-2 h-6 border-t border-line shrink-0 text-xxs">
        <span className="text-muted truncate" title="History: Binance 1m klines · live candles: oracle ticks · discs: your fills in this market">
          Binance history + oracle ticks{fills.length ? ` · ${fills.length} fill${fills.length === 1 ? "" : "s"}` : ""}
          {tick && src === "mark" && mark ? ` · mark ${fmtPrice(mark)} / oracle ${fmtPrice(tick.price)}` : ""}
        </span>
        <span className="flex-1" />
        <span className="num text-muted mr-2" aria-label="UTC time">
          {clock}
        </span>
        <button className={`tv-foot ${scaleMode === "percent" ? "tv-foot--on" : ""}`} aria-pressed={scaleMode === "percent"} onClick={() => setScaleMode((m) => (m === "percent" ? "normal" : "percent"))} title="Percentage scale">
          %
        </button>
        <button className={`tv-foot ${scaleMode === "log" ? "tv-foot--on" : ""}`} aria-pressed={scaleMode === "log"} onClick={() => setScaleMode((m) => (m === "log" ? "normal" : "log"))} title="Logarithmic scale">
          log
        </button>
        <button className={`tv-foot ${autoScale ? "tv-foot--amber" : ""}`} aria-pressed={autoScale} onClick={() => setAutoScale((a) => !a)} title="Auto-fit the price scale to the visible candles">
          auto
        </button>
      </div>
    </div>
  );
}
