"use client";
/**
 * TradingView Advanced Charts wrapper. The full TV chart (drawing toolbar,
 * indicators, magnet mode) fed by our datafeed (lib/tvdatafeed.ts), with
 * bulk.trade's chrome: pinned timeframes + grouped picker, overlay toggles,
 * Mark | Oracle source switch, and trading primitives (position line, B/S/C
 * fill marks).
 *
 * The library itself is NOT in this repo: TradingView grants it per-site
 * (free licence, apply at https://www.tradingview.com/advanced-charts/).
 * Drop the `charting_library/` folder into apps/terminal/public/ and this
 * component takes over from the built-in chart; until then the terminal
 * falls back automatically. See docs/tradingview-charts.md.
 */
import { Camera, ChartCandlestick, ChevronDown, ListChecks, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { HistoryRow } from "@/lib/backend/types";
import type { Position } from "@/lib/api";
import { makeDatafeed } from "@/lib/tvdatafeed";
import { qty as fmtQty, usd } from "@/lib/format";
import { CHART_ACCENT, CHART_DARK, CHART_DOWN, CHART_UP } from "@/lib/chartTheme";

declare global {
  interface Window {
    TradingView?: { widget: new (options: Record<string, unknown>) => TVWidget };
  }
}
interface TVPositionLine {
  setPrice(p: number): TVPositionLine;
  setText(t: string): TVPositionLine;
  setQuantity(q: string): TVPositionLine;
  setLineColor(c: string): TVPositionLine;
  setLineStyle(s: number): TVPositionLine;
  setLineLength(n: number): TVPositionLine;
  setBodyTextColor(c: string): TVPositionLine;
  setBodyBackgroundColor(c: string): TVPositionLine;
  setBodyBorderColor(c: string): TVPositionLine;
  setQuantityTextColor(c: string): TVPositionLine;
  setQuantityBackgroundColor(c: string): TVPositionLine;
  setQuantityBorderColor(c: string): TVPositionLine;
  remove(): void;
}
interface TVWidget {
  onChartReady(cb: () => void): void;
  activeChart(): {
    createShape(point: { price: number }, options: Record<string, unknown>): unknown;
    createPositionLine?(): TVPositionLine;
    removeEntity(id: unknown): void;
    refreshMarks?(): void;
    clearMarks?(): void;
    resetData?(): void;
  };
  remove(): void;
}

// Newer releases ship charting_library.standalone.js; pre-v20 builds ship
// charting_library.min.js (same UMD global). Try both.
const LIB_SRCS = ["/charting_library/charting_library.standalone.js", "/charting_library/charting_library.min.js"];
type LibState = "loading" | "ready" | "missing";
let libPromise: Promise<boolean> | null = null;

function loadScript(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve(!!window.TradingView);
    el.onerror = () => resolve(false);
    document.head.appendChild(el);
  });
}

/** Loads the (self-hosted) library once; "missing" until the user installs it. */
export function useTradingViewLib(): LibState {
  const [state, setState] = useState<LibState>(typeof window !== "undefined" && window.TradingView ? "ready" : "loading");
  useEffect(() => {
    if (window.TradingView) return setState("ready");
    libPromise ??= (async () => {
      for (const src of LIB_SRCS) if (await loadScript(src)) return true;
      return false;
    })();
    let alive = true;
    void libPromise.then((ok) => alive && setState(ok ? "ready" : "missing"));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/* Our theme tokens (panel bg, muted text) + bulk.trade's candle/grid treatment.
   Keep in sync with globals.css --t-panel / --t-muted for both themes. */
const DARK = { bg: CHART_DARK.bg, grid: "rgba(248, 248, 248, 0.06)", cross: CHART_DARK.cross, scaleText: CHART_DARK.text, up: CHART_UP, down: CHART_DOWN };

/** The grouped picker behind the ⌄. Same groups as bulk. Aggregated client-side by the library. */
const TF_MENU: { group: string; items: { r: string; label: string }[] }[] = [
  { group: "Minutes", items: [{ r: "1", label: "1m" }, { r: "3", label: "3m" }, { r: "5", label: "5m" }, { r: "15", label: "15m" }, { r: "30", label: "30m" }] },
  { group: "Hours", items: [{ r: "60", label: "1H" }, { r: "120", label: "2H" }, { r: "240", label: "4H" }, { r: "360", label: "6H" }, { r: "480", label: "8H" }, { r: "720", label: "12H" }] },
  { group: "Days", items: [{ r: "1D", label: "1D" }, { r: "3D", label: "3D" }, { r: "1W", label: "1W" }, { r: "1M", label: "1M" }] },
];
const TF_LABELS = Object.fromEntries(TF_MENU.flatMap((g) => g.items.map((i) => [i.r, i.label])));
/** Pinned in the toolbar, like bulk; everything else lives in the ⌄ menu. */
const PINNED_TFS = ["1", "5", "15", "60", "240", "1D"];

export function TVChart({ marketId, symbol, fills = [], position = null, mark, tabs }: { marketId: number | null; symbol: string; fills?: HistoryRow[]; position?: Position | null; mark?: number; tabs?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TVWidget | null>(null);
  const [chartReady, setChartReady] = useState(false);
  // live values the datafeed hooks read without recreating the widget
  const [src, setSrc] = useState<"mark" | "oracle">("oracle");
  const [showFills, setShowFills] = useState(true);
  const [showPosition, setShowPosition] = useState(true);
  const fillsRef = useRef(fills);
  fillsRef.current = fills;
  const markRef = useRef(mark);
  markRef.current = mark;
  const srcRef = useRef(src);
  srcRef.current = src;
  const showFillsRef = useRef(showFills);
  showFillsRef.current = showFills;

  // (re)create the widget per market
  useEffect(() => {
    if (!ref.current || marketId === null || !window.TradingView) return;
    setChartReady(false);
    // Older builds (pre-v20, e.g. 2018's 1.12) take container_id; newer take container.
    if (!ref.current.id) ref.current.id = "tv-chart-container";
    const C = DARK;
    const themeOverrides = {
      "paneProperties.background": C.bg,
      "paneProperties.backgroundType": "solid",
      "paneProperties.vertGridProperties.color": C.grid,
      "paneProperties.horzGridProperties.color": C.grid,
      "paneProperties.crossHairProperties.color": C.cross,
      "paneProperties.crossHairProperties.style": 2,
      "scalesProperties.textColor": C.scaleText,
      "scalesProperties.fontSize": 12,
      "scalesProperties.lineColor": C.grid,
      "mainSeriesProperties.candleStyle.upColor": C.up,
      "mainSeriesProperties.candleStyle.downColor": C.down,
      "mainSeriesProperties.candleStyle.wickUpColor": C.up,
      "mainSeriesProperties.candleStyle.wickDownColor": C.down,
      "mainSeriesProperties.candleStyle.borderVisible": false,
    };
    const widget = new window.TradingView.widget({
      container: ref.current,
      container_id: ref.current.id,
      toolbar_bg: C.bg,
      custom_css_url: "kydo-dark.css", // pre-v20: resolved against /charting_library/static/
      library_path: "/charting_library/",
      symbol: `${symbol}-USD`,
      interval: "5",
      autosize: true,
      theme: "dark",
      timezone: "Etc/UTC",
      datafeed: makeDatafeed(marketId, symbol, {
        fills: () => (showFillsRef.current ? fillsRef.current : []),
        tickPrice: (oracle) => (srcRef.current === "mark" && markRef.current ? markRef.current : oracle),
      }),
      loading_screen: { backgroundColor: C.bg, foregroundColor: CHART_ACCENT },
      overrides: themeOverrides,
      disabled_features: ["header_widget", "header_symbol_search", "symbol_search_hot_key", "compare_symbol", "display_market_status", "popup_hints", "create_volume_indicator_by_default", "volume_force_overlay"],
      enabled_features: ["use_localstorage_for_settings"],
    });
    widgetRef.current = widget;
    widget.onChartReady(() => {
      // use_localstorage_for_settings makes chartproperties saved in earlier
      // sessions BEAT the constructor overrides. Force the theme every load.
      try {
        const w = widget as any;
        (w.applyOverrides ?? w.chart?.()?.applyOverrides)?.call(w.applyOverrides ? w : w.chart(), themeOverrides);
      } catch {
        /* stored settings will win. Cosmetic only */
      }
      setChartReady(true);
    });
    return () => {
      widgetRef.current = null;
      setChartReady(false);
      try {
        widget.remove();
      } catch {
        /* widget already torn down with the container */
      }
    };
  }, [marketId, symbol]);

  // bulk-style position line: dashed entry line + "PNL … | Size …" badge (Trading Primitives)
  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget || !chartReady) return;
    if (!position || !showPosition) return;
    const cleanups: (() => void)[] = [];
    const col = position.unrealizedPnl < 0 ? DARK.down : DARK.up;
    try {
      const chart = widget.activeChart();
      const line = chart.createPositionLine?.();
      if (line) {
        line
          .setPrice(position.entryPrice)
          .setText(`PNL ${usd(position.unrealizedPnl, { sign: true })}`)
          .setQuantity(`Size ${fmtQty(position.baseQty)}`)
          .setLineColor(col)
          .setLineStyle(2)
          .setLineLength(85)
          .setBodyTextColor(CHART_DARK.labelText)
          .setBodyBackgroundColor(col)
          .setBodyBorderColor(col)
          .setQuantityTextColor(CHART_DARK.labelText)
          .setQuantityBackgroundColor(col)
          .setQuantityBorderColor(col);
        cleanups.push(() => line.remove());
      } else {
        // primitive unavailable. Plain dashed line with a label
        const id = chart.createShape(
          { price: position.entryPrice },
          {
            shape: "horizontal_line",
            lock: true,
            disableSelection: true,
            text: `PNL ${usd(position.unrealizedPnl, { sign: true })} | Size ${fmtQty(position.baseQty)}`,
            overrides: { linecolor: col, linestyle: 2, linewidth: 1, showLabel: true, textcolor: col },
          },
        );
        cleanups.push(() => chart.removeEntity(id));
      }
    } catch {
      /* overlays are cosmetic. Never break the chart over them */
    }
    return () => {
      for (const c of cleanups)
        try {
          c();
        } catch {
          /* chart may already be gone */
        }
    };
  }, [chartReady, showPosition, position?.entryPrice, position?.side, position?.baseQty, position?.unrealizedPnl]);

  // v1.12 writes the legend as "SOLANA / US DOLLAR, 5, Pyth". Bulk (and newer TV) use " · ".
  // The iframe is same-origin, so rewrite the title span (text-only node) whenever it re-renders.
  useEffect(() => {
    if (!chartReady) return;
    const doc = ref.current?.querySelector("iframe")?.contentDocument;
    if (!doc) return;
    const fix = () => {
      doc.querySelectorAll("span.pane-legend-line.main").forEach((el) => {
        if (el.textContent?.includes(", ")) el.textContent = el.textContent.replace(/, /g, " · ");
      });
    };
    fix();
    const legend = doc.querySelector(".pane-legend");
    const mo = new MutationObserver(fix);
    if (legend) mo.observe(legend, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [chartReady]);

  // fills → B/S/C marks come from the datafeed's getMarks; poke the chart when the list changes
  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget || !chartReady) return;
    try {
      const chart = widget.activeChart();
      chart.clearMarks?.();
      chart.refreshMarks?.();
    } catch {
      /* marks are cosmetic */
    }
  }, [chartReady, fills, showFills]);

  const [res, setRes] = useState("5");
  const setResolution = (r: string) => {
    setRes(r);
    try {
      const w = widgetRef.current as any;
      (w?.activeChart?.() ?? w?.chart?.())?.setResolution?.(r, () => {});
    } catch {
      /* not ready yet */
    }
  };
  const act = (id: string) => {
    try {
      const w = widgetRef.current as any;
      (w?.activeChart?.() ?? w?.chart?.())?.executeActionById?.(id);
    } catch {
      /* not ready yet */
    }
  };
  const openIndicators = () => act("insertIndicator");
  const refreshData = () => {
    try {
      const w = widgetRef.current as any;
      (w?.activeChart?.() ?? w?.chart?.())?.resetData?.();
    } catch {
      /* not ready yet */
    }
  };
  /** Composite the chart iframe's canvases into one PNG download (the library's own screenshot needs TV servers). */
  const snapshot = () => {
    try {
      const iframe = ref.current?.querySelector("iframe");
      const doc = iframe?.contentDocument;
      if (!iframe || !doc) return;
      const canvases = [...doc.querySelectorAll("canvas")] as HTMLCanvasElement[];
      if (!canvases.length) return;
        const box = iframe.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const out = document.createElement("canvas");
      out.width = Math.round(box.width * dpr);
      out.height = Math.round(box.height * dpr);
      const ctx = out.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = DARK.bg;
      ctx.fillRect(0, 0, out.width, out.height);
      for (const c of canvases) {
        const r = c.getBoundingClientRect(); // relative to the iframe viewport
        ctx.drawImage(c, Math.round(r.left * dpr), Math.round(r.top * dpr), Math.round(r.width * dpr), Math.round(r.height * dpr));
      }
      const a = document.createElement("a");
      a.href = out.toDataURL("image/png");
      a.download = `${symbol}-USD-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.png`;
      a.click();
    } catch {
      /* cross-origin or torn-down chart. Just do nothing */
    }
  };
  // v1.x SeriesStyle enum: 0 bars · 1 candles · 2 line · 3 area · 8 heikin-ashi
  const [style, setStyle] = useState(1);
  const setChartStyle = (n: number) => {
    setStyle(n);
    try {
      const w = widgetRef.current as any;
      (w?.activeChart?.() ?? w?.chart?.())?.setChartType?.(n);
    } catch {
      /* not ready yet */
    }
  };
  const [fs, setFs] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrapRef.current?.requestFullscreen?.();
  };
  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  const STYLES: { n: number; label: string }[] = [
    { n: 1, label: "Candles" },
    { n: 0, label: "Bars" },
    { n: 8, label: "Heikin Ashi" },
    { n: 2, label: "Line" },
    { n: 3, label: "Area" },
  ];
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
  const closeDd = (e: { currentTarget: Element }) => (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
  return (
    <div ref={wrapRef} className="tv-wrap flex flex-col h-full min-h-[220px] bg-panel" aria-label="Price chart (TradingView)">
      {/* borderless toolbar over the pane, like bulk. Token colours so both themes work */}
      <div className="tv-head flex items-center gap-0.5 px-2 h-9 shrink-0">
        <span className="flex items-center" role="radiogroup" aria-label="Timeframe">
          {PINNED_TFS.map((r) => (
            <button key={r} className={`tv-btn ${res === r ? "tv-btn--on" : ""}`} role="radio" aria-checked={res === r} onClick={() => setResolution(r)}>
              {TF_LABELS[r]}
            </button>
          ))}
        </span>
        {/* grouped timeframe picker, like bulk's ⌄ (shows the active TF when it isn't pinned) */}
        <details className="relative tv-dd">
          <summary className={`tv-btn list-none px-1 ${!PINNED_TFS.includes(res) ? "tv-btn--on" : ""}`} aria-label="More timeframes">
            {!PINNED_TFS.includes(res) && <span>{TF_LABELS[res]}</span>}
            <ChevronDown size={13} aria-hidden />
          </summary>
          <div className="popover left-0 min-w-[190px]">
            {TF_MENU.map((g) => (
              <div key={g.group} className="mb-1 last:mb-0">
                <div className="flex items-center gap-2 my-1 text-xxs text-muted">
                  <span className="flex-1 h-px bg-line" />
                  {g.group}
                  <span className="flex-1 h-px bg-line" />
                </div>
                <div className="grid grid-cols-3">
                  {g.items.map((t) => (
                    <button
                      key={t.r}
                      className={`h-7 rounded text-center hover:bg-panel2 ${res === t.r ? "ring-1 ring-fg text-fg" : ""}`}
                      onClick={(e) => {
                        setResolution(t.r);
                        closeDd(e);
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
        <details className="relative tv-dd">
          <summary className="tv-btn list-none" title={STYLES.find((x) => x.n === style)?.label} aria-label="Chart style">
            <ChartCandlestick size={16} aria-hidden />
          </summary>
          <div className="popover left-0 min-w-[140px]" role="radiogroup" aria-label="Chart style">
            {STYLES.map((x) => (
              <button
                key={x.n}
                role="radio"
                aria-checked={style === x.n}
                className={`flex items-center gap-2 w-full h-7 px-1 rounded text-left hover:bg-panel2 ${style === x.n ? "text-amber" : ""}`}
                onClick={(e) => {
                  setChartStyle(x.n);
                  closeDd(e);
                }}
              >
                {x.label}
              </button>
            ))}
          </div>
        </details>
        <button className="tv-btn" onClick={openIndicators} title="Add an indicator (full TradingView library)">
          ƒx Indicators
        </button>
        {/* overlay toggles, like bulk's checklist popover */}
        <details className="relative tv-dd">
          <summary className="tv-btn list-none" title="Chart overlays" aria-label="Chart overlays">
            <ListChecks size={16} aria-hidden />
          </summary>
          <div className="popover left-0 min-w-[170px]">
            <label className="flex items-center gap-2 h-7 px-1 rounded cursor-pointer hover:bg-panel2">
              <input type="checkbox" className="accent-amber" checked={showFills} onChange={(e) => setShowFills(e.target.checked)} />
              Trade History
            </label>
            <label className="flex items-center gap-2 h-7 px-1 rounded cursor-pointer hover:bg-panel2">
              <input type="checkbox" className="accent-amber" checked={showPosition} onChange={(e) => setShowPosition(e.target.checked)} />
              Position
            </label>
          </div>
        </details>
        <button className="tv-btn" onClick={refreshData} title="Refresh chart data" aria-label="Refresh chart data">
          <RefreshCw size={14} aria-hidden />
        </button>
        <button className="tv-btn" onClick={snapshot} title="Save chart image" aria-label="Save chart image">
          <Camera size={15} aria-hidden />
        </button>
        {/* price source: on-chain mark vs Pyth oracle (bulk: exchange vs oracle data) */}
        <span className="tv-seg ml-2" role="radiogroup" aria-label="Price source">
          <button role="radio" aria-checked={src === "mark"} disabled={mark === undefined} title={mark === undefined ? "Mark price unavailable" : "Using on-chain mark price"} onClick={() => setSrc("mark")}>
            Mark
          </button>
          <button role="radio" aria-checked={src === "oracle"} title="Using Pyth oracle data" onClick={() => setSrc("oracle")}>
            Oracle
          </button>
        </span>
        <span className="flex-1" />
        {tabs}
        <button className="tv-btn ml-1" onClick={toggleFs} title={fs ? "Exit fullscreen" : "Fullscreen"} aria-label={fs ? "Exit fullscreen" : "Fullscreen"}>
          {fs ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
        </button>
      </div>
      <div ref={ref} className="flex-1 min-h-[180px]" />
    </div>
  );
}
