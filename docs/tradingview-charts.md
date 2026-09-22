# TradingView Advanced Charts in the terminal

The terminal ships two chart engines:

1. **Built-in** (`components/Chart.tsx`, lightweight-charts). Always works, no licence.
2. **TradingView Advanced Charts** (`components/TVChart.tsx`). The full TradingView chart
   (drawing toolbar, magnet mode, 100+ indicators). Used automatically as soon as the
   licensed library files are installed; otherwise the terminal falls back to the built-in
   chart with no code change.

## Getting the library (one-time, site owner only)

1. Apply at <https://www.tradingview.com/advanced-charts/> (free licence; TradingView
   reviews each application. Usually days, sometimes weeks).
2. Conditions: keep the TradingView attribution visible; the site must be publicly
   accessible (not private/internal or behind a paywall).
3. Approval grants access to the private `tradingview/charting_library` GitHub repo.

## Installing it

Copy the `charting_library/` folder from that repo into the terminal's public dir:

```
apps/terminal/public/charting_library/
├── charting_library.standalone.js
├── bundles/
└── …
```

That's it. `useTradingViewLib()` probes `/charting_library/charting_library.standalone.js`
at runtime: found → `TVChart` renders; 404 → built-in chart. The folder is gitignored.
The licence does not allow redistributing the files.

## How it's wired

- **History**: TV `getBars` → indexer `GET /candles?marketId&tf&from&to` → Binance spot
  klines (`1m 5m 15m 1h 4h 1d`). Display-only; the on-chain risk math only ever reads
  oracles.
- **Realtime**: `subscribeBars` builds bars from the oracle tick stream (`lib/prices.ts`.
  WS, poll, or chain fallback), so the live candle is the platform's own price.
- **Overlays**: the open position's entry is a locked horizontal line (coloured by PnL
  sign); fills are execution arrows (green buy / red sell / purple close).
- **Symbols**: the widget is single-symbol; switching markets goes through the terminal's
  market picker, which recreates the widget (`lib/tvdatafeed.ts` is per-market).

Datafeed adapter: `apps/terminal/lib/tvdatafeed.ts`. Supported resolutions:
1, 5, 15, 60, 240, 1D.
