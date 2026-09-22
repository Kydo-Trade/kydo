/** Minimal typed fetchers for the indexer's public REST API: just what the landing shows. */
import { API_URL } from "./config";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export interface PoolSummary {
  status: "funding" | "live" | "locked" | "closed" | string;
  tvl: number;
}

export interface MarketJson {
  marketId: number;
  symbol: string;
  maxLeverageBps: number;
  enabled: boolean;
  price?: { price: number; ts: number };
}

export interface CandleJson {
  time: number;
  close: number;
}

/** The platform parameters the program enforces (subset of GET /config). */
export interface ConfigJson {
  entryFee: number;
  tierCaps: number[];
  vestDays: number[];
  activationFloor: number;
  minDeposit: number;
  risk: {
    maxLeverageBps: number;
    maxPositions: number;
    dailyLossBps: number;
    maxDrawdownBps: number;
    maxTradesPerDay: number;
    limitBandBps: number;
    redemptionLockupSecs: number;
    cooldownSecs: number;
    promotionDays: number;
  };
  trial: {
    startingBalance: number;
    profitTargetBps: number;
    maxDrawdownBps: number;
    dailyLossBps: number;
    minActiveDays: number;
    minTrades: number;
    maxDayProfitShareBps: number;
  };
}

export const indexer = {
  pools: () => getJson<{ pools: PoolSummary[]; total: number }>("/pools"),
  markets: () => getJson<{ markets: MarketJson[] }>("/markets"),
  prices: () => getJson<Record<string, { price: number; ts: number }>>("/prices"),
  candles: (marketId: number, tf: string, limit: number) => getJson<{ candles: CandleJson[] }>(`/candles?marketId=${marketId}&tf=${tf}&limit=${limit}`),
  config: () => getJson<ConfigJson>("/config"),
};

/**
 * Fallback platform parameters when the indexer is unreachable. The
 * production-shaped spec values from config/platform.jsonc (section 4–section 5).
 * The live /config response wins whenever it loads.
 */
export const SPEC_CONFIG: ConfigJson = {
  entryFee: 500,
  tierCaps: [5000, 15000, 30000],
  vestDays: [14, 30, 30],
  activationFloor: 1000,
  minDeposit: 50,
  risk: {
    maxLeverageBps: 100000,
    maxPositions: 5,
    dailyLossBps: 400,
    maxDrawdownBps: 1000,
    maxTradesPerDay: 100,
    limitBandBps: 200,
    redemptionLockupSecs: 86400,
    cooldownSecs: 604800,
    promotionDays: 30,
  },
  trial: {
    startingBalance: 50000,
    profitTargetBps: 800,
    maxDrawdownBps: 1000,
    dailyLossBps: 400,
    minActiveDays: 15,
    minTrades: 20,
    maxDayProfitShareBps: 4000,
  },
};
