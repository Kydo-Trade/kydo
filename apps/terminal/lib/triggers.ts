"use client";
/** Client-side stop-loss / take-profit (section 4.5 MVP): watched by the app and executed as market closes. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Position } from "./api";
import { usePrices } from "./prices";
import type { TradingBackend } from "./backend/types";

export interface Trigger {
  marketId: number;
  side: "long" | "short";
  stopLoss?: number;
  takeProfit?: number;
}

export interface TriggerEvent {
  ts: number;
  marketId: number;
  kind: "sl" | "tp";
  price: number;
  ok: boolean;
  message: string;
}

const key = (mode: string, wallet: string) => `kydo.triggers.${mode}.${wallet}`;

function load(k: string): Trigger[] {
  try {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as Trigger[]) : [];
  } catch {
    return [];
  }
}

export function useTriggers(mode: string, wallet: string | null, backend: TradingBackend | null, positions: Position[]) {
  const k = key(mode, wallet ?? "none");
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [log, setLog] = useState<TriggerEvent[]>([]);
  const prices = usePrices();
  const firing = useRef<Set<number>>(new Set());
  const retryAt = useRef<Record<number, number>>({});

  useEffect(() => {
    setTriggers(load(k));
  }, [k]);

  const save = useCallback(
    (next: Trigger[]) => {
      setTriggers(next);
      try {
        localStorage.setItem(k, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    },
    [k],
  );

  const setTrigger = useCallback(
    (t: Trigger) => {
      const rest = triggers.filter((x) => x.marketId !== t.marketId);
      if (t.stopLoss === undefined && t.takeProfit === undefined) save(rest);
      else save([...rest, t]);
    },
    [triggers, save],
  );

  const clearTrigger = useCallback((marketId: number) => save(triggers.filter((x) => x.marketId !== marketId)), [triggers, save]);

  // drop triggers whose position is gone
  useEffect(() => {
    if (!positions.length && !triggers.length) return;
    const open = new Set(positions.map((p) => p.marketId));
    const next = triggers.filter((t) => open.has(t.marketId));
    if (next.length !== triggers.length) save(next);
  }, [positions, triggers, save]);

  // watch prices
  useEffect(() => {
    if (!backend) return;
    for (const t of triggers) {
      const pos = positions.find((p) => p.marketId === t.marketId);
      const tick = prices.prices[t.marketId];
      if (!pos || !tick) continue;
      if (firing.current.has(t.marketId)) continue;
      if ((retryAt.current[t.marketId] ?? 0) > Date.now()) continue;
      const px = tick.price;
      let kind: "sl" | "tp" | null = null;
      if (pos.side === "long") {
        if (t.stopLoss !== undefined && px <= t.stopLoss) kind = "sl";
        else if (t.takeProfit !== undefined && px >= t.takeProfit) kind = "tp";
      } else {
        if (t.stopLoss !== undefined && px >= t.stopLoss) kind = "sl";
        else if (t.takeProfit !== undefined && px <= t.takeProfit) kind = "tp";
      }
      if (!kind) continue;
      firing.current.add(t.marketId);
      const k2 = kind;
      backend
        .closeOrder({ marketId: t.marketId })
        .then((r) => {
          setLog((l) => [{ ts: Date.now(), marketId: t.marketId, kind: k2, price: px, ok: true, message: `closed @ ${r.fillPrice ?? "market"}` }, ...l].slice(0, 50));
          save(triggers.filter((x) => x.marketId !== t.marketId));
        })
        .catch((e) => {
          const msg = (e as Error).message ?? String(e);
          setLog((l) => [{ ts: Date.now(), marketId: t.marketId, kind: k2, price: px, ok: false, message: msg }, ...l].slice(0, 50));
          // min-hold or oracle issues: retry in 15s
          retryAt.current[t.marketId] = Date.now() + 15_000;
        })
        .finally(() => firing.current.delete(t.marketId));
    }
  }, [prices, triggers, positions, backend, save]);

  return { triggers, setTrigger, clearTrigger, log };
}
