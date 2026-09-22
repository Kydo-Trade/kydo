/** Trial backend: HTTP to the trial engine with wallet-signed mutations. */
import BN from "bn.js";
import { PRICE_SCALE, QTY_SCALE } from "@kydo/sdk";
import { trial as trialApi, type Signer, type TrialState, type Position } from "../api";
import { TRIAL_POLL_MS } from "../config";
import { priceStore } from "../prices";
import type { BackendState, CloseOrderArgs, HistoryRow, OrderResult, PlaceOrderArgs, TradingBackend } from "./types";

const usdBN = (x: number) => new BN(Math.round(x * PRICE_SCALE));

export class TrialBackend implements TradingBackend {
  readonly mode = "trial" as const;
  private state: TrialState | null = null;
  private view: BackendState | null = null;
  private listeners = new Set<(s: BackendState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubPrices: (() => void) | null = null;
  private lastError: string | undefined;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly signer: Signer,
    private readonly symbols: Record<number, string>,
  ) {}

  getState() {
    return this.view;
  }

  subscribe(cb: (s: BackendState) => void) {
    this.listeners.add(cb);
    if (this.listeners.size === 1) {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), TRIAL_POLL_MS);
      this.unsubPrices = priceStore.subscribe(() => this.emit());
    }
    if (this.view) cb(this.view);
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubPrices?.();
    this.unsubPrices = null;
  }

  dispose() {
    this.stop();
    this.listeners.clear();
  }

  async refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        this.state = await trialApi.state(this.signer.publicKey.toBase58());
        this.lastError = undefined;
      } catch (e) {
        this.lastError = (e as Error).message;
      } finally {
        this.inflight = null;
      }
      this.emit();
    })();
    return this.inflight;
  }

  private emit() {
    this.view = this.build();
    for (const l of this.listeners) l(this.view);
  }

  private build(): BackendState {
    const s = this.state;
    const prices = priceStore.getSnapshot().prices;
    if (!s) {
      return {
        mode: "trial",
        label: "TRIAL. Simulated $50,000",
        nav: 0,
        dayStartNav: 0,
        peakNav: 0,
        grossNotional: 0,
        unrealizedPnl: 0,
        positions: [],
        tradesToday: 0,
        totalTrades: 0,
        raw: { nav: new BN(0), dayStartNav: new BN(0), peakNav: new BN(0), positions: [], marks: {} },
        ready: false,
        tradable: false,
        tradableReason: this.lastError ? `trial engine unreachable: ${this.lastError}` : "loading trial state…",
        updatedAt: Date.now(),
        error: this.lastError,
      };
    }
    // re-mark positions with the freshest price so uPnL ticks between polls
    const positions: Position[] = s.positions.map((p) => {
      const t = prices[p.marketId];
      const mark = t ? t.price : p.markPrice;
      const pnl = (mark - p.entryPrice) * p.baseQty * (p.side === "short" ? -1 : 1);
      return { ...p, symbol: p.symbol || this.symbols[p.marketId] || `#${p.marketId}`, markPrice: mark, notional: p.baseQty * mark, unrealizedPnl: pnl };
    });
    const unrealized = positions.reduce((a, p) => a + p.unrealizedPnl, 0);
    const gross = positions.reduce((a, p) => a + p.notional, 0);
    const nav = s.balance + unrealized;
    const marks: Record<number, BN> = {};
    for (const p of positions) marks[p.marketId] = usdBN(p.markPrice);
    const active = s.onChainStatus === "trial";
    return {
      mode: "trial",
      label: "TRIAL. Simulated $50,000",
      nav,
      dayStartNav: s.dayStartEquity,
      peakNav: Math.max(s.peakEquity, nav),
      grossNotional: gross,
      unrealizedPnl: unrealized,
      positions,
      tradesToday: s.tradesToday,
      totalTrades: s.metrics?.trades ?? 0,
      trial: s,
      raw: {
        nav: usdBN(nav),
        dayStartNav: usdBN(s.dayStartEquity),
        peakNav: usdBN(Math.max(s.peakEquity, nav)),
        positions: positions.map((p) => ({
          marketId: p.marketId,
          side: p.side === "short" ? 2 : 1,
          cluster: p.cluster,
          baseQty: new BN(Math.round(p.baseQty * QTY_SCALE)),
          entryPrice: usdBN(p.entryPrice),
        })),
        marks,
      },
      ready: true,
      tradable: active,
      tradableReason: active ? undefined : `trial not active (on-chain status: ${s.onChainStatus})`,
      updatedAt: Date.now(),
      error: this.lastError,
    };
  }

  private applyResponse(state: TrialState) {
    this.state = state;
    this.emit();
  }

  async placeOrder(args: PlaceOrderArgs): Promise<OrderResult> {
    const res = await trialApi.placeOrder(this.signer, {
      marketId: args.marketId,
      side: args.side,
      action: "open",
      notional: args.notionalUsd,
      ...(args.limitPx ? { limitPx: args.limitPx } : {}),
      ...(args.stopPx ? { stopPx: args.stopPx } : {}),
    });
    if (!res.ok) throw new Error((res as any).error ?? "order rejected");
    this.applyResponse(res.state);
    return { fillPrice: res.fill.fillPrice, baseQty: res.fill.baseQty, fee: res.fill.fee, realizedPnl: res.fill.realizedPnl, sig: res.entry?.signature };
  }

  async closeOrder(args: CloseOrderArgs): Promise<OrderResult> {
    const pos = this.state?.positions.find((p) => p.marketId === args.marketId);
    if (!pos) throw new Error("PositionNotFound");
    const res = await trialApi.placeOrder(this.signer, {
      marketId: args.marketId,
      side: pos.side,
      action: "close",
      ...(args.baseQty ? { baseQty: args.baseQty } : {}),
      ...(args.limitPx ? { limitPx: args.limitPx } : {}),
    });
    if (!res.ok) throw new Error((res as any).error ?? "order rejected");
    this.applyResponse(res.state);
    return { fillPrice: res.fill.fillPrice, baseQty: res.fill.baseQty, fee: res.fill.fee, realizedPnl: res.fill.realizedPnl, sig: res.entry?.signature };
  }

  async history(): Promise<HistoryRow[]> {
    const { entries } = await trialApi.orders(this.signer.publicKey.toBase58());
    return entries
      .map((e) => ({
        id: `${e.seq}`,
        ts: e.ts > 1e12 ? Math.floor(e.ts / 1000) : e.ts,
        marketId: e.marketId,
        symbol: this.symbols[e.marketId] ?? `#${e.marketId}`,
        side: e.side,
        action: e.action,
        baseQty: Number(e.baseQty),
        fillPrice: Number(e.fillPrice),
        oraclePrice: Number(e.oraclePrice),
        fee: Number(e.fee),
        realizedPnl: Number(e.realizedPnl),
        navAfter: Number(e.equityAfter),
      }))
      .sort((a, b) => b.ts - a.ts || Number(b.id) - Number(a.id));
  }
}
