/** One interface serves both the simulated trial and the on-chain live pool. */
import type BN from "bn.js";
import type { PositionLike } from "@kydo/sdk";
import type { Position, TrialState } from "../api";
import type { ChainPool } from "../chain";

export type Mode = "trial" | "live";
export type OrderSide = "long" | "short";

export interface PlaceOrderArgs {
  marketId: number;
  side: OrderSide;
  /** USD notional */
  notionalUsd: number;
  /** exact 1e6-scaled notional; when present it is what goes on-chain (no float round-trip) */
  notionalRaw?: BN;
  /** 0 / undefined = market order */
  limitPx?: number;
  /** Stop trigger price. Mandatory on the live path. The on-chain guard
   *  rejects a trade without one and sizes it against the pool's loss budget. */
  stopPx?: number;
}

export interface CloseOrderArgs {
  marketId: number;
  /** base units; undefined/0 = close all */
  baseQty?: number;
  limitPx?: number;
}

export interface OrderResult {
  sig?: string;
  fillPrice?: number;
  baseQty?: number;
  fee?: number;
  realizedPnl?: number;
}

export interface HistoryRow {
  id: string;
  ts: number;
  marketId: number;
  symbol: string;
  side: OrderSide;
  action: "open" | "close";
  baseQty: number;
  fillPrice: number;
  oraclePrice: number;
  fee: number;
  realizedPnl: number;
  navAfter: number;
}

export interface BackendState {
  mode: Mode;
  label: string;
  /** USD floats */
  nav: number;
  dayStartNav: number;
  peakNav: number;
  grossNotional: number;
  unrealizedPnl: number;
  positions: Position[];
  tradesToday: number;
  totalTrades: number;
  /** live only */
  navPerShare?: number;
  hwmNps?: number;
  tierStartNps?: number;
  pool?: ChainPool;
  poolAddress?: string;
  poolStatus?: "funding" | "live" | "locked" | "settled";
  /** trial only */
  trial?: TrialState;
  /** exact 1e6-scaled inputs for `preTradeCheck` */
  raw: {
    nav: BN;
    dayStartNav: BN;
    peakNav: BN;
    positions: PositionLike[];
    marks: Record<number, BN>;
  };
  /** true once the first fetch succeeded */
  ready: boolean;
  /** true when trading is possible in this state (pool live / trial active) */
  tradable: boolean;
  tradableReason?: string;
  updatedAt: number;
  error?: string;
}

export interface TradingBackend {
  readonly mode: Mode;
  getState(): BackendState | null;
  placeOrder(args: PlaceOrderArgs): Promise<OrderResult>;
  closeOrder(args: CloseOrderArgs): Promise<OrderResult>;
  subscribe(cb: (s: BackendState) => void): () => void;
  refresh(): Promise<void>;
  history(): Promise<HistoryRow[]>;
  dispose(): void;
}
