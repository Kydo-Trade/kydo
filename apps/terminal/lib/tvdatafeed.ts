"use client";
/**
 * TradingView Advanced Charts Datafeed (JS API) backed by this platform:
 *   history  → indexer GET /candles (Binance klines, display-only)
 *   realtime → the oracle tick stream in `priceStore` (WS / poll / chain fallback)
 * One datafeed instance serves one market. The terminal recreates the widget
 * when the selected market changes (our MarketStrip is the symbol switcher).
 */
import { API_URL } from "./config";
import { priceStore } from "./prices";
import type { HistoryRow } from "./backend/types";
import { CHART_CLOSE, CHART_DARK, CHART_DOWN, CHART_UP } from "@/lib/chartTheme";

interface Bar {
  time: number; // ms
  open: number;
  high: number;
  low: number;
  close: number;
}

/** TV resolution → { indexer tf, seconds }. The *base* resolutions the indexer stores. */
const RESOLUTIONS: Record<string, { tf: string; secs: number }> = {
  "1": { tf: "1m", secs: 60 },
  "5": { tf: "5m", secs: 300 },
  "15": { tf: "15m", secs: 900 },
  "60": { tf: "1h", secs: 3600 },
  "240": { tf: "4h", secs: 14400 },
  "1D": { tf: "1d", secs: 86400 },
};

/**
 * Everything the bulk-style timeframe menu offers. The library aggregates the
 * non-base ones client-side from `intraday_multipliers` / daily bars (3m from
 * 1m, 30m from 15m, 2H..12H from 1H/4H, 3D/1W/1M from 1D), so getBars only
 * ever sees the base resolutions above.
 */
export const SUPPORTED_RESOLUTIONS = ["1", "3", "5", "15", "30", "60", "120", "240", "360", "480", "720", "1D", "3D", "1W", "1M"];

/** Optional live hooks: `fills` feeds B/S/C chart marks, `tickPrice` overrides the streamed price (mark vs oracle). */
export interface DatafeedHooks {
  fills?: () => HistoryRow[];
  tickPrice?: (oracle: number) => number;
}

/** Chart legend reads the description. Bulk shows "ETHEREUM / US DOLLAR · 5 · Pyth". */
const FULL_NAMES: Record<string, string> = { BTC: "BITCOIN", ETH: "ETHEREUM", SOL: "SOLANA" };

export function makeDatafeed(marketId: number, symbol: string, hooks: DatafeedHooks = {}) {
  const ticker = `${symbol}-USD`;
  const subs = new Map<string, { unsub: () => void }>();
  const lastBar = new Map<string, Bar>(); // per listenerGuid, seeded by getBars

  return {
    onReady(cb: (config: unknown) => void) {
      setTimeout(() => cb({ supported_resolutions: SUPPORTED_RESOLUTIONS, supports_marks: true, supports_timescale_marks: false, supports_time: true }), 0);
    },

    searchSymbols(_input: string, _exchange: string, _type: string, onResult: (r: unknown[]) => void) {
      onResult([]); // symbol switching happens through the terminal's own market picker
    },

    resolveSymbol(_name: string, onResolve: (info: unknown) => void, onError: (r: string) => void) {
      const px = priceStore.get(marketId)?.price ?? 0;
      if (!px) {
        // price arrives within a snapshot interval; TV retries via onError
        setTimeout(() => onError("no price yet"), 0);
        return;
      }
      const pricescale = px >= 1000 ? 100 : px >= 1 ? 10_000 : 1_000_000;
      setTimeout(
        () =>
          onResolve({
            name: ticker,
            ticker,
            description: `${FULL_NAMES[symbol] ?? symbol} / US DOLLAR`,
            type: "crypto",
            session: "24x7",
            timezone: "Etc/UTC",
            exchange: "Pyth",
            listed_exchange: "Pyth",
            format: "price",
            minmov: 1,
            pricescale,
            has_intraday: true,
            intraday_multipliers: ["1", "5", "15", "60", "240"],
            has_daily: true,
            daily_multipliers: ["1"],
            has_weekly_and_monthly: true,
            volume_precision: 2,
            data_status: "streaming",
            supported_resolutions: SUPPORTED_RESOLUTIONS,
          }),
        0,
      );
    },

    async getBars(
      _symbolInfo: unknown,
      resolution: string,
      // New API passes a periodParams object; pre-v20 builds pass positional
      // (from, to, onResult, onError, firstDataRequest). Accept both.
      a3: { from: number; to: number; firstDataRequest: boolean; countBack?: number } | number,
      a4: unknown,
      a5: unknown,
      a6?: unknown,
      a7?: unknown,
    ) {
      let period: { from: number; to: number; firstDataRequest: boolean; countBack?: number };
      let onResult: (bars: Bar[], meta: { noData: boolean }) => void;
      let onError: (r: string) => void;
      if (typeof a3 === "object") {
        period = a3;
        onResult = a4 as typeof onResult;
        onError = a5 as typeof onError;
      } else {
        period = { from: a3, to: a4 as number, firstDataRequest: !!a7 };
        onResult = a5 as typeof onResult;
        onError = (a6 ?? (() => {})) as typeof onError;
      }
      const res = RESOLUTIONS[resolution];
      if (!res) return onError(`unsupported resolution ${resolution}`);
      try {
        const limit = Math.min(4320, Math.max(period.countBack ?? 0, Math.ceil((period.to - period.from) / res.secs)) + 2);
        const r = await fetch(`${API_URL}/candles?marketId=${marketId}&tf=${res.tf}&from=${period.from}&to=${period.to}&limit=${limit}`);
        if (!r.ok) throw new Error(`indexer ${r.status}`);
        const body = (await r.json()) as { candles: { time: number; open: number; high: number; low: number; close: number }[] };
        const bars: Bar[] = body.candles.map((c) => ({ time: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close }));
        if (period.firstDataRequest && bars.length) lastBar.set(resolution, { ...bars[bars.length - 1] });
        onResult(bars, { noData: bars.length === 0 });
      } catch (e) {
        onError(String((e as Error).message ?? e));
      }
    },

    /**
     * B / S / C trade discs on the bars (bulk draws fills the same way). The
     * library asks once per visible range; TVChart calls refreshMarks() when
     * the fill list changes.
     */
    getMarks(_symbolInfo: unknown, from: number, to: number, onData: (marks: unknown[]) => void, _resolution: string) {
      const fills = hooks.fills?.() ?? [];
      const marks = fills
        .filter((f) => f.ts >= from && f.ts <= to)
        .map((f) => {
          const kind = f.action === "close" ? "close" : f.side === "long" ? "buy" : "sell";
          const color = kind === "close" ? CHART_CLOSE : kind === "buy" ? CHART_UP : CHART_DOWN;
          return {
            id: f.id,
            time: f.ts,
            color: { border: color, background: color },
            label: kind === "close" ? "C" : kind === "buy" ? "B" : "S",
            labelFontColor: CHART_DARK.labelText,
            minSize: 18,
            text: `${kind === "close" ? "Close" : kind === "buy" ? "Buy" : "Sell"} ${f.baseQty} @ ${f.fillPrice}`,
          };
        });
      onData(marks);
    },

    subscribeBars(_symbolInfo: unknown, resolution: string, onTick: (bar: Bar) => void, guid: string) {
      const res = RESOLUTIONS[resolution];
      if (!res) return;
      const unsub = priceStore.subscribe(() => {
        const t0 = priceStore.get(marketId);
        if (!t0) return;
        const t = { ...t0, price: hooks.tickPrice ? hooks.tickPrice(t0.price) : t0.price };
        const bucketMs = Math.floor(t.ts / res.secs) * res.secs * 1000;
        const prev = lastBar.get(resolution);
        let bar: Bar;
        if (!prev || bucketMs > prev.time) {
          bar = { time: bucketMs, open: prev?.close ?? t.price, high: t.price, low: t.price, close: t.price };
        } else {
          bar = { ...prev, high: Math.max(prev.high, t.price), low: Math.min(prev.low, t.price), close: t.price };
        }
        lastBar.set(resolution, bar);
        onTick(bar);
      });
      subs.set(guid, { unsub });
    },

    unsubscribeBars(guid: string) {
      subs.get(guid)?.unsub();
      subs.delete(guid);
    },
  };
}
