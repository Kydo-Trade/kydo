"use client";
/**
 * Global price store: latest oracle tick per market + 1-minute candles built
 * client-side from the tick stream. Fed by the WS feed (`lib/ws.ts`), the
 * `/prices` poll fallback and (when the indexer is down) the on-chain mock
 * oracles (`lib/platform.tsx`).
 */
import { useSyncExternalStore } from "react";

export interface Tick {
  price: number;
  conf: number;
  ts: number; // unix seconds
}

export interface Candle {
  time: number; // unix seconds, minute bucket
  open: number;
  high: number;
  low: number;
  close: number;
  /** Base-asset volume. Present on exchange-kline backfill bars, absent on oracle-tick bars. */
  volume?: number;
}

export interface PriceSnapshot {
  prices: Record<number, Tick>;
  version: number;
  lastUpdate: number; // ms
  source: "ws" | "poll" | "chain" | "none";
}

const MAX_CANDLES = 10_080; // 7 days of 1-minute candles. Enough for a multi-day 5m/1H/4H view
const BUCKET = 60;

class PriceStore {
  private prices: Record<number, Tick> = {};
  private candles: Record<number, Candle[]> = {};
  private listeners = new Set<() => void>();
  private snapshot: PriceSnapshot = { prices: {}, version: 0, lastUpdate: 0, source: "none" };

  get(marketId: number): Tick | undefined {
    return this.prices[marketId];
  }

  getSnapshot = (): PriceSnapshot => this.snapshot;

  getCandles(marketId: number): Candle[] {
    return this.candles[marketId] ?? (this.candles[marketId] = []);
  }

  update(marketId: number, tick: Tick, source: PriceSnapshot["source"]) {
    const prev = this.prices[marketId];
    // ignore out-of-order or duplicate ticks
    if (prev && tick.ts < prev.ts) return;
    if (prev && tick.ts === prev.ts && prev.price === tick.price) return;
    this.prices[marketId] = tick;
    this.pushCandle(marketId, tick);
    this.publish(source);
  }

  bulk(map: Record<string, Tick>, source: PriceSnapshot["source"]) {
    let changed = false;
    for (const [k, t] of Object.entries(map)) {
      const id = Number(k);
      if (!t || !Number.isFinite(t.price) || t.price <= 0) continue;
      const prev = this.prices[id];
      if (prev && (t.ts < prev.ts || (t.ts === prev.ts && prev.price === t.price))) continue;
      this.prices[id] = t;
      this.pushCandle(id, t);
      changed = true;
    }
    if (changed) this.publish(source);
  }

  /**
   * Seed full OHLC history (e.g. exchange klines) BEFORE whatever candles live ticks already
   * built: only bars older than the earliest existing candle are inserted, so the oracle-tick
   * candles always win for the recent range.
   */
  backfillCandles(marketId: number, bars: Candle[]) {
    if (!bars.length) return;
    const sorted = [...bars].sort((a, b) => a.time - b.time);
    const existing = this.getCandles(marketId);
    const firstExisting = existing.length ? existing[0].time : Number.MAX_SAFE_INTEGER;
    const older = sorted.filter((b) => b.time < firstExisting && Number.isFinite(b.close) && b.close > 0);
    if (!older.length) return;
    const rebuilt = [...older, ...existing];
    if (rebuilt.length > MAX_CANDLES) rebuilt.splice(0, rebuilt.length - MAX_CANDLES);
    this.candles[marketId] = rebuilt;
    this.publish(this.snapshot.source === "none" ? "poll" : this.snapshot.source);
  }

  /** Seed candles from historical ticks (oldest → newest). Does not move the latest tick unless newer. */
  backfill(marketId: number, ticks: { ts: number; price: number }[]) {
    if (!ticks.length) return;
    const sorted = [...ticks].sort((a, b) => a.ts - b.ts);
    const existing = this.getCandles(marketId);
    const firstExisting = existing.length ? existing[0].time : Number.MAX_SAFE_INTEGER;
    // rebuild: history first, then whatever live candles we already had
    const rebuilt: Candle[] = [];
    this.candles[marketId] = rebuilt;
    for (const t of sorted) {
      if (Math.floor(t.ts / BUCKET) * BUCKET >= firstExisting) break;
      this.pushCandle(marketId, { price: t.price, conf: 0, ts: t.ts });
    }
    for (const c of existing) rebuilt.push(c);
    if (rebuilt.length > MAX_CANDLES) rebuilt.splice(0, rebuilt.length - MAX_CANDLES);
    const last = sorted[sorted.length - 1];
    const prev = this.prices[marketId];
    if (!prev || last.ts > prev.ts) this.prices[marketId] = { price: last.price, conf: prev?.conf ?? 0, ts: last.ts };
    this.publish(this.snapshot.source === "none" ? "poll" : this.snapshot.source);
  }

  private pushCandle(marketId: number, tick: Tick) {
    const arr = this.getCandles(marketId);
    const bucket = Math.floor(tick.ts / BUCKET) * BUCKET;
    const last = arr[arr.length - 1];
    if (last && last.time === bucket) {
      last.high = Math.max(last.high, tick.price);
      last.low = Math.min(last.low, tick.price);
      last.close = tick.price;
    } else if (!last || bucket > last.time) {
      arr.push({ time: bucket, open: last ? last.close : tick.price, high: tick.price, low: tick.price, close: tick.price });
      if (arr.length > MAX_CANDLES) arr.splice(0, arr.length - MAX_CANDLES);
    }
  }

  private publish(source: PriceSnapshot["source"]) {
    this.snapshot = {
      prices: { ...this.prices },
      version: this.snapshot.version + 1,
      lastUpdate: Date.now(),
      source,
    };
    for (const l of this.listeners) l();
  }

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
}

export const priceStore = new PriceStore();

const EMPTY: PriceSnapshot = { prices: {}, version: 0, lastUpdate: 0, source: "none" };

export function usePrices(): PriceSnapshot {
  return useSyncExternalStore(priceStore.subscribe, priceStore.getSnapshot, () => EMPTY);
}
