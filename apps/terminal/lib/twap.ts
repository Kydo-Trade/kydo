"use client";
/**
 * Client-side TWAP (section 4.5-style "Pro" order): a large notional is sliced into N market
 * orders sent at a fixed interval by this browser tab. Each slice goes through the
 * normal placeOrder path (guard, fees, and (in live mode) a wallet signature unless a
 * session key is active). Runs are remembered per wallet/mode so a reload resumes them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { OrderSide, TradingBackend } from "./backend/types";

export interface TwapFill {
  ts: number;
  usd: number;
  px?: number;
}

export interface TwapRun {
  id: string;
  marketId: number;
  symbol: string;
  side: OrderSide;
  totalUsd: number;
  slices: number;
  intervalMs: number;
  filledUsd: number;
  done: number;
  status: "running" | "done" | "cancelled" | "error";
  startedAt: number;
  nextAt: number;
  errors: number;
  lastError?: string;
  fills: TwapFill[];
  /** Stop carried by every slice. A live pool's guard rejects a trade without
   *  one. Fixed for the run: each slice replaces the stop on the position it is
   *  adding to, so they must all agree. */
  stopPx?: number;
}

export interface TwapStart {
  marketId: number;
  symbol: string;
  side: OrderSide;
  totalUsd: number;
  slices: number;
  durationMs: number;
  stopPx?: number;
}

const MAX_CONSECUTIVE_ERRORS = 3;
const key = (scope: string) => `kydo.twap.${scope}`;

function load(k: string): TwapRun[] {
  try {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as TwapRun[]) : [];
  } catch {
    return [];
  }
}

export function useTwap(backend: TradingBackend | null, scope: string) {
  const k = key(scope);
  const [runs, setRuns] = useState<TwapRun[]>([]);
  const runsRef = useRef<TwapRun[]>([]);
  const busy = useRef<Set<string>>(new Set());

  const persist = useCallback(
    (next: TwapRun[]) => {
      runsRef.current = next;
      setRuns(next);
      try {
        localStorage.setItem(k, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    },
    [k],
  );

  useEffect(() => {
    // a reload picks running TWAPs up again; their next slice fires at the next tick
    persist(load(k).map((r) => (r.status === "running" ? { ...r, nextAt: Math.min(r.nextAt, Date.now() + 1000) } : r)));
  }, [k, persist]);

  const update = useCallback((id: string, patch: Partial<TwapRun> | ((r: TwapRun) => Partial<TwapRun>)) => persist(runsRef.current.map((r) => (r.id === id ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) } : r))), [persist]);

  const start = useCallback(
    (a: TwapStart): TwapRun => {
      const slices = Math.max(1, Math.floor(a.slices));
      const run: TwapRun = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        marketId: a.marketId,
        symbol: a.symbol,
        side: a.side,
        totalUsd: a.totalUsd,
        slices,
        intervalMs: Math.max(1000, Math.floor(a.durationMs / slices)),
        filledUsd: 0,
        done: 0,
        status: "running",
        startedAt: Date.now(),
        nextAt: Date.now(), // first slice immediately
        errors: 0,
        fills: [],
        stopPx: a.stopPx,
      };
      persist([run, ...runsRef.current]);
      return run;
    },
    [persist],
  );

  const cancel = useCallback((id: string) => update(id, (r) => (r.status === "running" ? { status: "cancelled" } : {})), [update]);
  const clearFinished = useCallback(() => persist(runsRef.current.filter((r) => r.status === "running")), [persist]);

  // the runner
  useEffect(() => {
    if (!backend) return;
    const tick = () => {
      const now = Date.now();
      for (const r of runsRef.current) {
        if (r.status !== "running" || r.nextAt > now || busy.current.has(r.id)) continue;
        const remaining = r.totalUsd - r.filledUsd;
        const slice = Math.min(remaining, r.totalUsd / r.slices);
        if (slice <= 0.01 || r.done >= r.slices) {
          update(r.id, { status: "done" });
          continue;
        }
        busy.current.add(r.id);
        backend
          .placeOrder({ marketId: r.marketId, side: r.side, notionalUsd: Number(slice.toFixed(2)), stopPx: r.stopPx })
          .then((res) => {
            update(r.id, (cur) => {
              const filledUsd = cur.filledUsd + slice;
              const done = cur.done + 1;
              const finished = done >= cur.slices || cur.totalUsd - filledUsd <= 0.01;
              return { filledUsd, done, errors: 0, lastError: undefined, nextAt: now + cur.intervalMs, status: finished ? "done" : "running", fills: [...cur.fills, { ts: now, usd: slice, px: res.fillPrice }].slice(-100) };
            });
          })
          .catch((e) => {
            const msg = (e as Error)?.message ?? String(e);
            update(r.id, (cur) => {
              const errors = cur.errors + 1;
              return { errors, lastError: msg, nextAt: now + cur.intervalMs, status: errors >= MAX_CONSECUTIVE_ERRORS ? "error" : "running" };
            });
          })
          .finally(() => busy.current.delete(r.id));
      }
    };
    const t = setInterval(tick, 1000);
    tick();
    return () => clearInterval(t);
  }, [backend, update]);

  return { runs, start, cancel, clearFinished };
}

export type TwapApi = ReturnType<typeof useTwap>;
