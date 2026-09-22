"use client";
import { useEffect, useMemo, useState, useRef } from "react";
import { EmptyState, Skeleton } from "@kydo/ui";
import type { HistoryRow, TradingBackend } from "@/lib/backend/types";
import { usePrices } from "@/lib/prices";
import { price as fmtPrice, qty as fmtQty, usdCompact } from "@/lib/format";

/* Row geometry, kept in step with `.tbl-book` in globals.css (h-5 rows under an
   h-6 head). The level count is derived from the panel's real height rather
   than fixed at 12: the book shares a grid row with the chart, so a taller
   viewport used to leave dead space under the last bid instead of more book.
   The count still has to be a whole number of levels, so up to 39 px of the
   body is left over. The table carries `h-full`, which distributes that
   remainder across the rows rather than parking it under the last bid. Without
   it the book visibly stops short of the bottom of its own panel, which is the
   one thing an order book must never do: the panel edge is what the eye reads
   as the end of the depth. */
const ROW_H = 20;
const HEAD_H = 24;
const MIN_LEVELS = 5;
const MAX_LEVELS = 20;
const STEPS_BPS = [5, 10, 25, 50] as const;
type StepBps = (typeof STEPS_BPS)[number];

/** Deterministic pseudo-random depth so the book looks like a book but never lies about being synthetic. */
function depthAt(level: number, base: number, seed: number) {
  const x = Math.sin(seed * 12.9898 + level * 78.233) * 43758.5453;
  const r = x - Math.floor(x);
  return base * (0.04 + 0.02 * level) * (0.6 + 0.8 * r);
}

interface Level {
  px: number;
  size: number;
  cum: number;
}

/** One book level; hoisted so rows keep identity (and keyboard focus) across price ticks. */
function Row({ r, side, maxCum, onPick, unit, px }: { r: Level; side: "ask" | "bid"; maxCum: number; onPick?: (px: number) => void; unit: "usd" | "base"; px: number }) {
  const show = (v: number) => (unit === "usd" ? usdCompact(v) : fmtQty(px ? v / px : 0));
  // bulk-style glimmer: a size change replays the side-tinted gradient sweep
  // (key bump restarts the CSS animation; no JS timers needed).
  const prevSize = useRef(r.size);
  const [glim, setGlim] = useState(0);
  useEffect(() => {
    if (prevSize.current === r.size) return;
    prevSize.current = r.size;
    setGlim((g) => g + 1);
  }, [r.size]);
  return (
    <tr
      key={glim}
      className={`cursor-pointer relative ob-row ${glim > 0 ? (side === "ask" ? "ob-glimmer-ask" : "ob-glimmer-bid") : ""}`}
      tabIndex={0}
      onClick={() => onPick?.(r.px)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick?.(r.px);
        }
      }}
      title={`Use ${fmtPrice(r.px)} as the limit price`}
    >
      {/* Depth is the row's own tint (Figma "terminal" 121:143601), not a bar in
          the price column, so this sits against the <tr>, which is the
          containing block, and the cell itself must not be positioned.
          Colours are Red/400 and Green/600; the old rgba values here were the
          pre-Figma crimson and teal. */}
      <td className={side === "ask" ? "text-down" : "text-up"}>
        <span
          className="absolute inset-y-0 left-0 -z-0"
          style={{
            width: `${(r.cum / maxCum) * 100}%`,
            backgroundImage:
              side === "ask"
                ? "linear-gradient(to right, rgba(255,95,46,0.28), rgba(255,95,46,0.10))"
                : "linear-gradient(to right, rgba(0,208,91,0.26), rgba(0,208,91,0.08))",
          }}
          aria-hidden
        />
        <span className="relative">{fmtPrice(r.px)}</span>
      </td>
      <td className="text-right relative">{show(r.size)}</td>
      <td className="text-right relative text-muted">{show(r.cum)}</td>
    </tr>
  );
}

type View = "book" | "trades";

export function OrderBook({
  marketId,
  symbol,
  cluster,
  onPick,
  backend,
  refreshKey = 0,
}: {
  marketId: number | null;
  symbol: string;
  cluster: number;
  onPick?: (px: number) => void;
  backend?: TradingBackend | null;
  refreshKey?: number;
}) {
  const [view, setView] = useState<View>("book");
  const [stepBps, setStepBps] = useState<StepBps>(5);
  const [unit, setUnit] = useState<"usd" | "base">("usd");
  const snap = usePrices();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [levels, setLevels] = useState(12);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // one spread row between the two sides, the rest split evenly
      const room = el.clientHeight - HEAD_H - ROW_H;
      setLevels(Math.max(MIN_LEVELS, Math.min(MAX_LEVELS, Math.floor(room / ROW_H / 2))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);
  const tick = marketId !== null ? snap.prices[marketId] : undefined;
  const mid = tick?.price ?? 0;
  const base = cluster === 1 ? 250_000 : 100_000; // top-of-book depth per side (section 4.2 fill model)
  const baseSym = symbol.split("-")[0] || "base";
  const STEP_BPS = stepBps;

  const rows = useMemo(() => {
    if (!mid) return { asks: [] as Level[], bids: [] as Level[] };
    const seed = Math.floor(mid * 100) % 997;
    const asks: Level[] = [];
    const bids: Level[] = [];
    let ca = 0;
    let cb = 0;
    for (let i = 1; i <= levels; i++) {
      const off = (STEP_BPS * i) / 10000;
      const sa = depthAt(i, base, seed);
      const sb = depthAt(i, base, seed + 1);
      ca += sa;
      cb += sb;
      asks.push({ px: mid * (1 + off), size: sa, cum: ca });
      bids.push({ px: mid * (1 - off), size: sb, cum: cb });
    }
    return { asks: asks.reverse(), bids };
  }, [mid, base, STEP_BPS, levels]);

  const maxCum = Math.max(rows.asks[0]?.cum ?? 1, rows.bids[rows.bids.length - 1]?.cum ?? 1);
  const spread = mid ? (mid * (STEP_BPS * 2)) / 10000 : 0;
  // last-price direction, held until it actually changes (not on a timer)
  const prevPx = useRef(0);
  const [dir, setDir] = useState<"up" | "down" | "flat">("flat");
  useEffect(() => {
    const px = tick?.price ?? 0;
    if (px && prevPx.current && px !== prevPx.current) setDir(px > prevPx.current ? "up" : "down");
    prevPx.current = px;
  }, [tick?.price]);

  return (
    <div className="panel flex flex-col h-full min-h-0" aria-label="Order book">
      <div className="hl-tabs hl-tabs--panel" role="tablist">
        <button role="tab" aria-selected={view === "book"} className="hl-tab" onClick={() => setView("book")}>
          Order Book
        </button>
        <button role="tab" aria-selected={view === "trades"} className="hl-tab" onClick={() => setView("trades")}>
          Trades
        </button>
        <span className="ml-auto pr-1 text-xxs text-muted num">{symbol || "—"}</span>
      </div>

      {view === "book" ? (
        <>
          {/* Hyperliquid's grouping / unit row: price step on the left, size unit on the right */}
          <div className="flex items-center justify-between px-2 h-8 text-xs text-muted border-b border-line">
            <select className="bg-transparent text-fg outline-none cursor-pointer" value={stepBps} onChange={(e) => setStepBps(Number(e.target.value) as StepBps)} aria-label="Price grouping" title="Price step between book levels">
              {STEPS_BPS.map((s) => (
                <option key={s} value={s}>
                  {s} bps
                </option>
              ))}
            </select>
            <span className="flex items-center gap-2">
              <span className="pill pill-amber h-4" title="Depth is generated around the oracle mid. The MockPerps venue has no real book">
                synthetic
              </span>
              <select className="bg-transparent text-fg outline-none cursor-pointer" value={unit} onChange={(e) => setUnit(e.target.value as "usd" | "base")} aria-label="Size unit">
                <option value="usd">USD</option>
                <option value="base">{baseSym}</option>
              </select>
            </span>
          </div>
          <div ref={bodyRef} className="flex-1 min-h-0 overflow-hidden">
            <table className="tbl tbl-book num h-full w-full table-fixed">
              <thead>
                <tr>
                  {/* The unit lives in the selector one row up; repeating it in
                      two headers is what overflowed 272 px. */}
                  <th className="w-[38%]">Price</th>
                  <th className="w-[31%] text-right" title={`Size in ${unit === "usd" ? "USD" : baseSym}`}>
                    Size
                  </th>
                  <th className="w-[31%] text-right" title={`Cumulative size in ${unit === "usd" ? "USD" : baseSym}`}>
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {mid ? (
                  <>
                    {rows.asks.map((r, i) => (
                      <Row key={`a${i}`} r={r} side="ask" maxCum={maxCum} onPick={onPick} unit={unit} px={r.px} />
                    ))}
                    <tr className="bg-panel2">
                      <td className="font-semibold text-fg">
                        {tick && (
                          <span className={`mr-2 font-semibold price-eased ${dir === "up" ? "text-up" : dir === "down" ? "text-down" : "text-fg"}`}>
                            {fmtPrice(tick.price)}
                            {dir === "up" ? " \u2191" : dir === "down" ? " \u2193" : ""}
                          </span>
                        )}
                        <span className="font-sans text-muted text-xxs mr-1">Spread</span>
                        {fmtPrice(spread)}
                      </td>
                      <td className="text-right text-muted" colSpan={2}>
                        {((spread / mid) * 100).toFixed(3)}%
                        {tick ? <span className="text-muted"> · conf ±{((tick.conf / tick.price) * 10000).toFixed(1)} bps</span> : null}
                      </td>
                    </tr>
                    {rows.bids.map((r, i) => (
                      <Row key={`b${i}`} r={r} side="bid" maxCum={maxCum} onPick={onPick} unit={unit} px={r.px} />
                    ))}
                  </>
                ) : (
                  Array.from({ length: levels * 2 + 1 }).map((_, i) => (
                    <tr key={i}>
                      <td colSpan={3} className="py-1">
                        <Skeleton className="h-2.5" />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="text-xxs text-muted px-2 py-1 border-t border-line">
            {mid ? "click a level to set a limit price" : marketId === null ? "select a market" : "waiting for an oracle price…"}
          </div>
        </>
      ) : (
        <RecentTrades backend={backend ?? null} refreshKey={refreshKey} marketId={marketId} />
      )}
    </div>
  );
}

/** Compact fills list for the Trades tab (this account's own fills. The mock venue has no public tape). */
function RecentTrades({ backend, refreshKey, marketId }: { backend: TradingBackend | null; refreshKey: number; marketId: number | null }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (!backend) {
      setRows(null);
      return;
    }
    let alive = true;
    backend
      .history()
      .then((r) => alive && setRows(r))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [backend, refreshKey]);

  const shown = (rows ?? []).filter((r) => all || marketId === null || r.marketId === marketId).slice(0, 40);
  const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  if (!backend)
    return (
      <EmptyState icon="◷" title="No trading account">
        Your fills appear here once you are in a trial or have a live pool.
      </EmptyState>
    );
  if (rows === null)
    return (
      <div className="p-2 flex flex-col gap-2" aria-busy="true">
        <Skeleton lines={5} />
      </div>
    );
  return (
    <>
      <div className="flex items-center justify-between px-2 h-6 text-xxs text-muted border-b border-line">
        <span>your fills</span>
        <button className="hover:text-fg" onClick={() => setAll((a) => !a)}>
          {all ? "this market" : "all markets"}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {shown.length === 0 ? (
          <div className="text-xxs text-muted p-3 text-center">No fills yet.</div>
        ) : (
          <table className="tbl tbl-book num w-full">
            <thead>
              <tr>
                <th>Price</th>
                <th className="text-right">Size</th>
                <th className="text-right">Time</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} title={`${r.symbol} ${r.side} ${r.action} · fee ${r.fee.toFixed(2)} · realised ${r.realizedPnl.toFixed(2)}`}>
                  <td className={r.action === "close" ? "text-muted" : r.side === "long" ? "text-up" : "text-down"}>
                    {fmtPrice(r.fillPrice)}
                    {all && <span className="font-sans text-muted text-xxs ml-1">{r.symbol}</span>}
                  </td>
                  <td className="text-right">{fmtQty(r.baseQty)}</td>
                  <td className="text-right text-muted">{clock(r.ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
