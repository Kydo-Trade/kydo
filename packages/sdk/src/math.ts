/** Off-chain mirrors of the program's NAV / share / risk maths (section 5.1–5.3). */
import BN from "bn.js";
import {
  BPS,
  INSTANT_DAILY_LOSS_BPS,
  INSTANT_MAX_DRAWDOWN_BPS,
  INSTANT_TIER,
  QTY_SCALE,
  SHARE_SCALE,
  STOP_SLIPPAGE_BPS,
  TRADER_SPLIT_BPS,
} from "./constants";

export const bn = (x: BN | bigint | number | string) => new BN(x.toString());

export function navPerShare(nav: BN, totalShares: BN): BN {
  if (totalShares.isZero()) return new BN(0);
  return nav.mul(SHARE_SCALE).div(totalShares);
}

export function sharesForDeposit(amount: BN, totalShares: BN, nav: BN): BN {
  if (totalShares.isZero() || nav.isZero()) return amount.mul(SHARE_SCALE);
  return amount.mul(totalShares).div(nav);
}

export function valueForShares(shares: BN, totalShares: BN, nav: BN): BN {
  if (totalShares.isZero()) return new BN(0);
  return shares.mul(nav).div(totalShares);
}

export function notional(baseQty: BN, price: BN): BN {
  return baseQty.mul(price).div(new BN(QTY_SCALE));
}

export function qtyForNotional(notionalUsd: BN, price: BN): BN {
  return notionalUsd.mul(new BN(QTY_SCALE)).div(price);
}

export function positionPnl(side: number, entry: BN, baseQty: BN, mark: BN): BN {
  const raw = mark.sub(entry).mul(baseQty).div(new BN(QTY_SCALE));
  return side === 2 ? raw.neg() : raw;
}

export function bpsOf(amount: BN, bps: number): BN {
  return amount.muln(bps).divn(BPS);
}

export interface RiskLike {
  maxLeverageBps: number;
  maxPositions: number;
  maxSingleBps: number;
  maxClusterBps: number;
  dailyLossBps: number;
  maxDrawdownBps: number;
  limitBandBps: number;
}

/**
 * The loss limits that actually apply to a pool at `tier`. Mirrors
 * `PlatformConfig::effective_daily_loss_bps` / `effective_max_drawdown_bps`
 * on-chain, including the `min`. Tier 0 is always tighter, never looser.
 *
 * Every off-chain consumer of a loss limit must go through this. Reading
 * `config.risk` directly is correct only for tiers 1-3, and silently overstates
 * an instant-funded pool's headroom by a third: the keeper would miss breaches
 * it is supposed to act on, the order ticket would admit orders the chain
 * rejects, and the investor view would report room a pool does not have.
 */
export function effectiveRisk<T extends { dailyLossBps: number; maxDrawdownBps: number }>(risk: T, tier: number): T {
  if (tier !== INSTANT_TIER) return risk;
  return {
    ...risk,
    dailyLossBps: Math.min(risk.dailyLossBps, INSTANT_DAILY_LOSS_BPS),
    maxDrawdownBps: Math.min(risk.maxDrawdownBps, INSTANT_MAX_DRAWDOWN_BPS),
  };
}

/**
 * Vesting period actually applied to a pool, in days.
 *
 * Mirrors `PlatformConfig::effective_vest_days` in programs/vault: instant
 * funding does **not** vest on `vestDays[0]`. It vests on `vestDays[1]`. The
 * Tier 2 schedule, because skipping the trial is paid for partly in slower
 * vesting. Reading `vestDays[tier - 1]` for tier 0 clamps to index 0 and
 * silently reports the faster Tier 1 schedule, which understates the cost of
 * instant funding to the one person who needs to know it.
 */
export function effectiveVestDays(vestDays: readonly number[], tier: number): number {
  if (tier === INSTANT_TIER) return vestDays[1] ?? vestDays[0] ?? 0;
  const i = Math.min(2, Math.max(1, tier)) - 1;
  return vestDays[i] ?? 0;
}

export interface PositionLike {
  marketId: number;
  side: number;
  cluster: number;
  baseQty: BN;
  entryPrice: BN;
  /** Trigger price, 1e6, when the trader set one. Optional and informational. */
  stopPx?: BN;
}

/** Loss on `baseQty` exiting at `stopPx` from `mark`, assuming the fill slips
 *  `STOP_SLIPPAGE_BPS` past the trigger. Display only. The platform no longer
 *  enforces stops, so this just tells a trader what a stop would risk. */
export function lossToStop(side: number, baseQty: BN, mark: BN, stopPx: BN): BN {
  const slip = bpsOf(stopPx, STOP_SLIPPAGE_BPS);
  const exit = side === 2 ? stopPx.add(slip) : stopPx.sub(slip);
  const diff = side === 2 ? exit.sub(mark) : mark.sub(exit);
  return diff.isNeg() ? new BN(0) : notional(baseQty, diff);
}

/** Client-side replica of the pre-trade guard steps 8–14 so the terminal can
 *  show why an order would fail before sending it. Returns null when OK. */
export function preTradeCheck(args: {
  risk: RiskLike;
  nav: BN;
  dayStartNav: BN;
  peakNav: BN;
  positions: PositionLike[];
  marks: Record<number, BN>;
  marketId: number;
  cluster: number;
  side: number;
  notionalUsd: BN;
  oraclePrice: BN;
  limitPx?: BN;
  marketMaxLeverageBps?: number;
}): string | null {
  const { risk, nav, positions, marks } = args;
  if (nav.isZero()) return "NAV is zero";
  if (nav.lt(bpsOf(args.dayStartNav, BPS - risk.dailyLossBps))) return "Daily loss cap breached";
  if (nav.lt(bpsOf(args.peakNav, BPS - risk.maxDrawdownBps))) return "Max drawdown breached";
  const existing = positions.find((p) => p.marketId === args.marketId);
  if (existing && existing.side !== args.side) return "Opposite side on open position: close instead";
  if (!existing && positions.length >= risk.maxPositions) return "Too many open positions";
  const qty = qtyForNotional(args.notionalUsd, args.oraclePrice);
  const add = notional(qty, args.oraclePrice);
  let gross = new BN(0);
  let cluster = new BN(0);
  for (const p of positions) {
    const m = marks[p.marketId];
    if (!m) return `Missing mark for market ${p.marketId}`;
    const n = notional(p.baseQty, m);
    gross = gross.add(n);
    if (p.cluster === args.cluster) cluster = cluster.add(n);
  }
  if (gross.add(add).gt(bpsOf(nav, risk.maxLeverageBps))) return `Gross leverage > ${risk.maxLeverageBps / BPS}×`;
  const single = (existing ? notional(existing.baseQty, args.oraclePrice) : new BN(0)).add(add);
  if (single.gt(bpsOf(nav, risk.maxSingleBps))) return `Single position > ${risk.maxSingleBps / 100}% of equity`;
  if (args.marketMaxLeverageBps && single.gt(bpsOf(nav, args.marketMaxLeverageBps))) return "Exceeds market leverage cap";
  if (cluster.add(add).gt(bpsOf(nav, risk.maxClusterBps))) return `Cluster exposure > ${risk.maxClusterBps / 100}% of equity`;
  if (args.limitPx && !args.limitPx.isZero()) {
    const band = bpsOf(args.oraclePrice, risk.limitBandBps);
    if (args.limitPx.sub(args.oraclePrice).abs().gt(band)) return `Limit price outside ${risk.limitBandBps} bps band`;
  }
  return null;
}

/** Warning threshold: 75% of any limit (section 5.3). */
export function riskUtilisation(args: {
  risk: RiskLike;
  nav: BN;
  dayStartNav: BN;
  peakNav: BN;
  grossNotional: BN;
}): { daily: number; drawdown: number; leverage: number; warn: boolean } {
  const { risk, nav, dayStartNav, peakNav, grossNotional } = args;
  const pct = (num: BN, den: BN) => (den.isZero() ? 0 : Number(num.muln(10_000).div(den)) / 10_000);
  const dailyLoss = dayStartNav.gt(nav) ? pct(dayStartNav.sub(nav), dayStartNav) : 0;
  const dd = peakNav.gt(nav) ? pct(peakNav.sub(nav), peakNav) : 0;
  const lev = pct(grossNotional, nav);
  const daily = dailyLoss / (risk.dailyLossBps / BPS);
  const drawdown = dd / (risk.maxDrawdownBps / BPS);
  const leverage = lev / (risk.maxLeverageBps / BPS);
  return { daily, drawdown, leverage, warn: Math.max(daily, drawdown, leverage) >= 0.75 };
}

/** Escrow accrual preview for a hypothetical close. */
export function traderShare(realizedPnl: BN): BN {
  return realizedPnl.isNeg() ? new BN(0) : bpsOf(realizedPnl, TRADER_SPLIT_BPS);
}

/**
 * How much of the trader's first-loss seed is still standing, given the pool's
 * total equity. Mirrors `risk::remaining_first_loss` on-chain.
 *
 * Derived from equity rather than decremented as losses book, so it falls the
 * moment an open position moves against the trader and comes back if the
 * position recovers.
 */
export function remainingFirstLoss(equity: number, investorPrincipal: number, firstLossSeed: number): number {
  return Math.min(Math.max(0, equity - investorPrincipal), firstLossSeed);
}

/**
 * Investor-redeemable NAV: equity minus whatever is left of the seed. Mirrors
 * `risk::investor_nav` on-chain.
 *
 * This is what prices shares and pays exits. At funding it equals the
 * CommonPool's allocation exactly, so NAV/share starts at 1.0 and a trader
 * being funded does not print profit for investors. Never use it for a loss
 * limit or the health factor. Those measure equity, because the seed has to
 * be *spent* before investors lose anything, and a trigger that only fired
 * once it was gone would leave nothing for the liquidation buffer.
 */
export function investorNav(equity: number, investorPrincipal: number, firstLossSeed: number): number {
  return equity - remainingFirstLoss(equity, investorPrincipal, firstLossSeed);
}

/** Where a pool's liquidation floors sit, in the same USD units as `nav`. */
export interface Floors {
  daily: number;
  drawdown: number;
  /** the binding one. Liquidation fires here */
  trigger: number;
}

export function liquidationFloors(
  dayStartNav: number,
  peakNav: number,
  risk: Pick<RiskLike, "dailyLossBps" | "maxDrawdownBps">,
): Floors {
  const daily = dayStartNav * (1 - risk.dailyLossBps / BPS);
  const drawdown = peakNav * (1 - risk.maxDrawdownBps / BPS);
  return { daily, drawdown, trigger: Math.max(daily, drawdown) };
}

/**
 * How close a pool is to being liquidated, as a single monotone number a bot
 * can rank on without simulating NAV for every pool:
 *
 *   > 1  safe, and the margin is the headroom
 *  <= 1  liquidatable right now
 *
 * It is `nav / trigger` against whichever floor binds first, so it already
 * accounts for the daily limit resetting each day while the drawdown floor
 * ratchets from peak. `Infinity` when there is no floor yet (a pool that has
 * never marked), which sorts it last. Correct, there is nothing to liquidate.
 */
export function healthFactor(
  /** total pool equity, seed included. Not `investorNav` */
  nav: number,
  dayStartNav: number,
  peakNav: number,
  risk: Pick<RiskLike, "dailyLossBps" | "maxDrawdownBps">,
): number {
  const { trigger } = liquidationFloors(dayStartNav, peakNav, risk);
  return trigger > 0 ? nav / trigger : Infinity;
}

/** USD a pool can still lose before it is liquidatable (0 when it already is). */
export function distanceToLiquidation(
  nav: number,
  dayStartNav: number,
  peakNav: number,
  risk: Pick<RiskLike, "dailyLossBps" | "maxDrawdownBps">,
): number {
  const { trigger } = liquidationFloors(dayStartNav, peakNav, risk);
  return Math.max(0, nav - trigger);
}
