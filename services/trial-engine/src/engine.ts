/**
 * Trial simulation engine (section 4.2). Pure, deterministic given prices + time so
 * it is unit-testable; persistence and HTTP live elsewhere.
 *
 *  - $50,000 virtual balance, live oracle prices
 *  - fills cross a 5 bps half-spread + size-dependent impact, pay a 5 bps fee,
 *    and may not consume more than 10% of visible top-of-book depth
 *  - the LIVE risk limits (section 5.3) apply exactly as on-chain; a breach of the
 *    daily cap / drawdown "locks" the trial (positions closed, trading halted)
 *  - every order is a signed, hash-chained `TrialOrderEntry`; each day's
 *    entries roll into a merkle root for `commit_trial_root`
 *  - section 5.4 metrics are computed continuously
 */
import nacl from "tweetnacl";
import { hashEntry, merkleRoot, merkleProof, MerkleProof, TrialOrderEntry } from "@kydo/sdk";

export const BPS = 10_000;
export const HALF_SPREAD_BPS = 5;
export const FEE_BPS = 5;
export const IMPACT_BPS_AT_FULL_DEPTH = 10;
export const MAX_DEPTH_SHARE = 0.10;
/** Assumed fill slippage past a stop trigger, for the display helper below. */
export const STOP_SLIPPAGE_BPS = 100;

export interface Market {
  marketId: number;
  symbol: string;
  cluster: number;
  enabled: boolean;
  maxLeverageBps: number;
  depthUsd: number;
}

export interface Risk {
  maxLeverageBps: number;
  maxPositions: number;
  maxSingleBps: number;
  maxClusterBps: number;
  dailyLossBps: number;
  maxDrawdownBps: number;
  minHoldSecs: number;
  maxTradesPerDay: number;
  limitBandBps: number;
}

export interface Criteria {
  startingBalance: number; // USD
  profitTargetBps: number;
  maxDrawdownBps: number;
  dailyLossBps: number;
  minActiveDays: number;
  minTrades: number;
  maxDayProfitShareBps: number;
  daySecs: number;
}

export interface Position {
  marketId: number;
  side: "long" | "short";
  cluster: number;
  baseQty: number;
  entryPrice: number;
  openedAt: number;
  /** Trigger price, when the trader set one. */
  stopPx?: number;
}

export interface DayStats {
  day: number;
  startEquity: number;
  minEquity: number;
  realized: number;
  trades: number;
}

export interface TrialAccount {
  wallet: string;
  startTs: number;
  balance: number;
  peakEquity: number;
  positions: Position[];
  entries: TrialOrderEntry[];
  days: Record<number, DayStats>;
  maxDrawdownBps: number;
  locked: boolean;
  lockReason: string | null;
  lastPrices: Record<number, number>;
}

export interface OrderRequest {
  marketId: number;
  side: "long" | "short";
  action: "open" | "close";
  notional?: number; // USD (open)
  baseQty?: number; // close (omit = all)
  limitPx?: number;
  /** Optional stop trigger (open only). Honoured by `mark` when set. */
  stopPx?: number;
}

export interface Fill {
  fillPrice: number;
  baseQty: number;
  fee: number;
  realizedPnl: number;
  oraclePrice: number;
}

export class TrialError extends Error {
  constructor(public code: string, msg?: string) {
    super(msg ?? code);
  }
}

export function newAccount(wallet: string, startTs: number, criteria: Criteria): TrialAccount {
  return {
    wallet,
    startTs,
    balance: criteria.startingBalance,
    peakEquity: criteria.startingBalance,
    positions: [],
    entries: [],
    days: {},
    maxDrawdownBps: 0,
    locked: false,
    lockReason: null,
    lastPrices: {},
  };
}

export const dayOf = (acc: TrialAccount, now: number, c: Criteria) => Math.max(0, Math.floor((now - acc.startTs) / c.daySecs));

export function unrealized(acc: TrialAccount, prices: Record<number, number>): number {
  let u = 0;
  for (const p of acc.positions) {
    const mark = prices[p.marketId] ?? p.entryPrice;
    u += (mark - p.entryPrice) * p.baseQty * (p.side === "short" ? -1 : 1);
  }
  return u;
}

export function equity(acc: TrialAccount, prices: Record<number, number>) {
  return acc.balance + unrealized(acc, prices);
}

export function grossNotional(acc: TrialAccount, prices: Record<number, number>) {
  return acc.positions.reduce((a, p) => a + p.baseQty * (prices[p.marketId] ?? p.entryPrice), 0);
}

function dayStats(acc: TrialAccount, day: number, eq: number): DayStats {
  if (!acc.days[day]) acc.days[day] = { day, startEquity: eq, minEquity: eq, realized: 0, trades: 0 };
  return acc.days[day];
}

/** Loss when `baseQty` exits at `stopPx` from `mark`, with the fill slipping
 *  STOP_SLIPPAGE_BPS past the trigger. Informational: stops are optional. */
export function lossToStop(side: "long" | "short", baseQty: number, markPx: number, stopPx: number): number {
  const slip = (stopPx * STOP_SLIPPAGE_BPS) / BPS;
  const exit = side === "long" ? stopPx - slip : stopPx + slip;
  const diff = side === "long" ? markPx - exit : exit - markPx;
  return diff > 0 ? diff * baseQty : 0;
}

/**
 * Mark to market: update peak / drawdown / intraday minimum, and lock the
 * trial if a live limit is breached. Exactly what the keeper would do to a
 * funded pool. Returns the lock reason if one fired now.
 */
export function mark(acc: TrialAccount, prices: Record<number, number>, now: number, risk: Risk, c: Criteria): string | null {
  acc.lastPrices = { ...acc.lastPrices, ...prices };
  // Stops fire before the breach check. On a funded pool the venue closes
  // these with no involvement from the platform, so the trial must too, or it
  // teaches a risk profile the funded account will never actually allow.
  if (!acc.locked) {
    const d0 = dayOf(acc, now, c);
    for (const p of [...acc.positions]) {
      const px = acc.lastPrices[p.marketId];
      if (!px || !p.stopPx) continue;
      const hit = p.side === "long" ? px <= p.stopPx : px >= p.stopPx;
      if (hit) closeAt(acc, p, p.baseQty, px, now, d0, undefined);
    }
  }
  const eq = equity(acc, acc.lastPrices);
  const day = dayOf(acc, now, c);
  const ds = dayStats(acc, day, eq);
  ds.minEquity = Math.min(ds.minEquity, eq);
  if (eq > acc.peakEquity) acc.peakEquity = eq;
  const dd = acc.peakEquity > 0 ? Math.round(((acc.peakEquity - eq) / acc.peakEquity) * BPS) : 0;
  acc.maxDrawdownBps = Math.max(acc.maxDrawdownBps, dd);
  if (acc.locked) return null;
  const dailyLoss = ds.startEquity > 0 ? ((ds.startEquity - eq) / ds.startEquity) * BPS : 0;
  let reason: string | null = null;
  if (dailyLoss > risk.dailyLossBps) reason = "daily_loss";
  else if (dd > risk.maxDrawdownBps) reason = "drawdown";
  if (reason) {
    acc.locked = true;
    acc.lockReason = reason;
    // unwind at market, like unwind_all
    for (const p of [...acc.positions]) {
      closeAt(acc, p, p.baseQty, acc.lastPrices[p.marketId] ?? p.entryPrice, now, day, undefined);
    }
  }
  return reason;
}

function fillPrice(oracle: number, isBuy: boolean, notional: number, depth: number, limitPx?: number): number {
  const impactBps = (notional / depth) * IMPACT_BPS_AT_FULL_DEPTH;
  const totalBps = HALF_SPREAD_BPS + impactBps;
  const px = isBuy ? oracle * (1 + totalBps / BPS) : oracle * (1 - totalBps / BPS);
  if (limitPx && limitPx > 0) {
    const ok = isBuy ? px <= limitPx : px >= limitPx;
    if (!ok) throw new TrialError("LimitNotMet", "limit price not reached");
  }
  return px;
}

function closeAt(acc: TrialAccount, p: Position, qty: number, oracle: number, now: number, day: number, limitPx: number | undefined, depth = 250_000): Fill {
  const isBuy = p.side === "short";
  const notional = qty * oracle;
  const px = fillPrice(oracle, isBuy, notional, depth, limitPx);
  const fee = qty * px * (FEE_BPS / BPS);
  const realized = (px - p.entryPrice) * qty * (p.side === "short" ? -1 : 1);
  p.baseQty -= qty;
  if (p.baseQty <= 1e-12) acc.positions = acc.positions.filter((x) => x !== p);
  acc.balance += realized - fee;
  const ds = dayStats(acc, day, equity(acc, acc.lastPrices));
  ds.realized += realized - fee;
  return { fillPrice: px, baseQty: qty, fee, realizedPnl: realized, oraclePrice: oracle };
}

/** The on-chain pre-trade guard (section 5.3), mirrored. Throws a TrialError with the same code names. */
export function guard(acc: TrialAccount, req: OrderRequest, market: Market, prices: Record<number, number>, now: number, risk: Risk, c: Criteria) {
  if (acc.locked) throw new TrialError("InvalidPoolStatus", `trial locked (${acc.lockReason})`);
  const oracle = prices[market.marketId];
  if (!oracle) throw new TrialError("OracleMissing");
  const eq = equity(acc, prices);
  if (eq <= 0) throw new TrialError("DrawdownBreach");
  const day = dayOf(acc, now, c);
  const ds = dayStats(acc, day, eq);
  if (ds.trades >= risk.maxTradesPerDay) throw new TrialError("TooManyTrades");
  if (req.limitPx && req.limitPx > 0 && Math.abs(req.limitPx - oracle) / oracle > risk.limitBandBps / BPS) throw new TrialError("LimitOutOfBand");
  const existing = acc.positions.find((p) => p.marketId === market.marketId);

  if (req.action === "close") {
    if (!existing) throw new TrialError("PositionNotFound");
    if (now - existing.openedAt < risk.minHoldSecs) throw new TrialError("MinHoldTime");
    return { oracle, existing, eq, day };
  }

  if (!market.enabled) throw new TrialError("MarketDisabled");
  if (eq < ds.startEquity * (1 - risk.dailyLossBps / BPS)) throw new TrialError("DailyLossBreach");
  if (eq < acc.peakEquity * (1 - risk.maxDrawdownBps / BPS)) throw new TrialError("DrawdownBreach");
  if (existing && existing.side !== req.side) throw new TrialError("OppositeSide");
  if (!existing && acc.positions.length >= risk.maxPositions) throw new TrialError("TooManyPositions");
  const notional = req.notional ?? 0;
  if (notional <= 0) throw new TrialError("SizeTooSmall");
  if (notional > market.depthUsd * MAX_DEPTH_SHARE) throw new TrialError("ExceedsDepth", `order exceeds 10% of visible depth ($${(market.depthUsd * MAX_DEPTH_SHARE).toFixed(0)})`);
  const gross = grossNotional(acc, prices);
  if (gross + notional > eq * (risk.maxLeverageBps / BPS)) throw new TrialError("LeverageExceeded");
  const single = (existing ? existing.baseQty * oracle : 0) + notional;
  if (single > eq * (risk.maxSingleBps / BPS)) throw new TrialError("SinglePositionExceeded");
  if (single > eq * (market.maxLeverageBps / BPS)) throw new TrialError("LeverageExceeded");
  const cluster = acc.positions.filter((p) => p.cluster === market.cluster).reduce((a, p) => a + p.baseQty * (prices[p.marketId] ?? p.entryPrice), 0) + notional;
  if (cluster > eq * (risk.maxClusterBps / BPS)) throw new TrialError("ClusterExceeded");
  // A stop is the trader's own tool, not a condition of trading. The funded
  // account enforces its loss limits by liquidation, so the trial does too.
  // Only sanity-check the side when one is actually set.
  const stopPx = req.stopPx ?? 0;
  if (stopPx > 0) {
    const stopOk = req.side === "long" ? stopPx < oracle : stopPx > oracle;
    if (!stopOk) throw new TrialError("StopWrongSide", "stop must sit below the mark on a long and above it on a short");
  }
  return { oracle, existing, eq, day };
}

export function execute(
  acc: TrialAccount,
  req: OrderRequest,
  market: Market,
  prices: Record<number, number>,
  now: number,
  risk: Risk,
  c: Criteria,
  signer: Uint8Array, // engine ed25519 secret key
): { fill: Fill; entry: TrialOrderEntry } {
  mark(acc, prices, now, risk, c);
  const { oracle, existing, day } = guard(acc, req, market, prices, now, risk, c);
  const ds = dayStats(acc, day, equity(acc, prices));
  let fill: Fill;
  if (req.action === "open") {
    const notional = req.notional!;
    const isBuy = req.side === "long";
    const px = fillPrice(oracle, isBuy, notional, market.depthUsd, req.limitPx);
    const qty = notional / px;
    const fee = notional * (FEE_BPS / BPS);
    if (existing) {
      existing.entryPrice = (existing.entryPrice * existing.baseQty + px * qty) / (existing.baseQty + qty);
      existing.baseQty += qty;
      existing.stopPx = req.stopPx; // the new stop covers the whole enlarged position
    } else {
      acc.positions.push({ marketId: market.marketId, side: req.side, cluster: market.cluster, baseQty: qty, entryPrice: px, openedAt: now, stopPx: req.stopPx });
    }
    acc.balance -= fee;
    ds.realized -= fee;
    fill = { fillPrice: px, baseQty: qty, fee, realizedPnl: 0, oraclePrice: oracle };
  } else {
    const qty = req.baseQty && req.baseQty > 0 ? Math.min(req.baseQty, existing!.baseQty) : existing!.baseQty;
    fill = closeAt(acc, existing!, qty, oracle, now, day, req.limitPx, market.depthUsd);
  }
  ds.trades += 1;

  const prev = acc.entries.length ? hashEntry(acc.entries[acc.entries.length - 1]).toString("hex") : "0".repeat(64);
  const entry: TrialOrderEntry = {
    seq: acc.entries.length,
    day,
    ts: now,
    trader: acc.wallet,
    marketId: market.marketId,
    side: req.side,
    action: req.action,
    baseQty: fill.baseQty.toFixed(9),
    oraclePrice: oracle.toFixed(6),
    fillPrice: fill.fillPrice.toFixed(6),
    fee: fill.fee.toFixed(6),
    realizedPnl: fill.realizedPnl.toFixed(6),
    equityAfter: equity(acc, prices).toFixed(6),
    prevHash: prev,
  };
  entry.signature = Buffer.from(nacl.sign.detached(hashEntry(entry), signer)).toString("hex");
  acc.entries.push(entry);
  mark(acc, prices, now, risk, c);
  return { fill, entry };
}

export function dayEntries(acc: TrialAccount, day: number) {
  return acc.entries.filter((e) => e.day === day);
}

export function dayRoot(acc: TrialAccount, day: number): Buffer {
  return merkleRoot(dayEntries(acc, day));
}

export function proofs(acc: TrialAccount): MerkleProof[] {
  const byDay = new Map<number, TrialOrderEntry[]>();
  for (const e of acc.entries) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
  return acc.entries.map((e) => {
    const list = byDay.get(e.day)!;
    return merkleProof(list, list.indexOf(e));
  });
}

export interface Metrics {
  finalEquity: number;
  profitPct: number;
  maxDrawdownBps: number;
  maxDailyLossBps: number;
  activeDays: number;
  trades: number;
  maxDayProfitShareBps: number;
  passing: { profitTarget: boolean; drawdown: boolean; dailyLoss: boolean; activeDays: boolean; trades: boolean; consistency: boolean; all: boolean };
}

/** section 5.4 pass criteria, computed from the account's day stats. */
export function metrics(acc: TrialAccount, prices: Record<number, number>, c: Criteria): Metrics {
  const finalEquity = equity(acc, prices);
  const days = Object.values(acc.days);
  const maxDailyLossBps = Math.max(0, ...days.map((d) => (d.startEquity > 0 ? Math.round(((d.startEquity - d.minEquity) / d.startEquity) * BPS) : 0)));
  const activeDays = days.filter((d) => d.trades > 0).length;
  const trades = acc.entries.length;
  const totalProfit = days.reduce((a, d) => a + Math.max(0, d.realized), 0);
  const maxDay = Math.max(0, ...days.map((d) => d.realized));
  const maxDayProfitShareBps = totalProfit > 0 ? Math.round((maxDay / totalProfit) * BPS) : 0;
  const profitPct = finalEquity / c.startingBalance - 1;
  const passing = {
    profitTarget: profitPct >= c.profitTargetBps / BPS,
    drawdown: acc.maxDrawdownBps <= c.maxDrawdownBps,
    dailyLoss: maxDailyLossBps <= c.dailyLossBps,
    activeDays: activeDays >= c.minActiveDays,
    trades: trades >= c.minTrades,
    consistency: maxDayProfitShareBps <= c.maxDayProfitShareBps,
    all: false,
  };
  passing.all = Object.entries(passing).filter(([k]) => k !== "all").every(([, v]) => v);
  return { finalEquity, profitPct, maxDrawdownBps: acc.maxDrawdownBps, maxDailyLossBps, activeDays, trades, maxDayProfitShareBps, passing };
}
