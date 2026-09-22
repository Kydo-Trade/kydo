/**
 * Read-model builders: Anchor-decoded accounts + prices → the JSON shapes in
 * the interface contract.
 */
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { MarketLike, decodeSymbol, effectiveRisk, healthFactor, distanceToLiquidation, liquidationFloors, remainingFirstLoss, investorNav } from "@kydo/sdk";
import type { Price } from "./chain";
import type { NavMarkRow, TradeRow } from "./store";

export const USD = 1e6;
export const QTY = 1e9;
export const NPS_BASE = 1e9; // nav_per_share at pool creation: 1 USDC × 1e12 / 1e9 dead shares

export const f = (x: BN | string | number | bigint | undefined | null): number => (x == null ? 0 : Number(x.toString()));
export const usd = (x: any) => f(x) / USD;

export const statusOf = (s: any): string => Object.keys(s ?? {})[0] ?? "unknown";
export const lockReasonOf = (r: number) => (["none", "daily_loss", "drawdown", "voluntary"][r] ?? "none");
export const sideOf = (s: number) => (s === 2 ? "short" : "long");

export const RISK_DISCLOSURE =
  "Investors bear 100% of losses. There is no loss backstop, no protocol cushion and no insurance fund. " +
  "If the pool settles below zero after a venue liquidation gap or ADL event, investors bear it. " +
  "Profits split 80% trader / 15% investors / 5% platform; the trader's share vests over 14–30 days and is clawed back by later losses. " +
  "The pool locks permanently on a 4% daily loss or a 10% drawdown from peak NAV. 3% and 8% for an instant-funded (tier 0) pool, " +
  "until its first promotion; positions are then unwound at market. " +
  "Deposits are locked for 24 hours; a redemption that exceeds free collateral closes your pro-rata slice of every open position " +
  "and you bear the slippage of that unwind. Nothing here is a promise of return.";

export function symbolOf(markets: MarketLike[], id: number) {
  const m = markets.find((x) => x.marketId === id);
  return m ? (typeof m.symbol === "string" ? m.symbol : decodeSymbol(m.symbol as any)) : `#${id}`;
}

export function positionsView(pool: any, markets: MarketLike[], prices: Map<number, Price>) {
  return (pool.positions as any[])
    .filter((p) => p.side !== 0 && f(p.baseQty) > 0)
    .map((p) => {
      const mark = prices.get(p.marketId)?.price ?? usd(p.entryPrice);
      const qty = f(p.baseQty) / QTY;
      const entry = usd(p.entryPrice);
      const upnl = (mark - entry) * qty * (p.side === 2 ? -1 : 1);
      return {
        marketId: p.marketId,
        symbol: symbolOf(markets, p.marketId),
        side: sideOf(p.side),
        cluster: p.cluster,
        baseQty: qty,
        entryPrice: entry,
        markPrice: mark,
        notional: qty * mark,
        unrealizedPnl: upnl,
        openedAt: f(p.openedAt),
      };
    });
}

export function navOf(pool: any, positions: ReturnType<typeof positionsView>): { nav: number; gross: number; unreal: number } {
  const unreal = positions.reduce((a, p) => a + p.unrealizedPnl, 0);
  const gross = positions.reduce((a, p) => a + p.notional, 0);
  // Mirror the on-chain compute_nav exactly: accounted + venue equity − escrow
  // − vested claimable − uncollected platform fee (all excluded from NAV).
  const nav = usd(pool.accountedUsdc) + unreal - usd(pool.escrowTotal) - usd(pool.vestedClaimable) - usd(pool.platformFeeOwed ?? 0);
  return { nav: Math.max(0, nav), gross, unreal };
}

export function npsOf(nav: number, totalShares: any): number {
  const shares = f(totalShares);
  if (!shares) return 0;
  // nav (USD) × 1e6 × 1e12 / shares → relative to base 1e9
  return (nav * USD * 1e12) / shares / NPS_BASE;
}

export function traderSummary(wallet: string, prof: any | null) {
  if (!prof) {
    return { wallet, status: "none", attempts: 0, trialsFailed: 0, poolsCreated: 0, poolsLocked: 0, tier: 0, liveDaysAtTier: 0 };
  }
  return {
    wallet,
    status: statusOf(prof.status),
    attempts: prof.attempts,
    trialsFailed: prof.trialsFailed,
    poolsCreated: prof.poolsCreated,
    poolsLocked: prof.poolsLocked,
    tier: prof.tier,
    liveDaysAtTier: prof.liveDaysAtTier,
  };
}

export function maxDrawdownOf(marks: NavMarkRow[]): number {
  let peak = 0;
  let worst = 0;
  for (const m of marks) {
    const nps = f(m.nps);
    if (nps > peak) peak = nps;
    if (peak > 0) worst = Math.max(worst, 1 - nps / peak);
  }
  return worst;
}

export function poolSummary(args: {
  address: string;
  pool: any;
  markets: MarketLike[];
  prices: Map<number, Price>;
  profile: any | null;
  strategy: string | null;
  tierCaps: number[];
  investorCount: number;
  maxDrawdown: number;
  now: number;
  /** Platform risk params, for the liquidation floors. Absent → health omitted. */
  risk?: { dailyLossBps: number; maxDrawdownBps: number } | null;
}) {
  const { address, pool, markets, prices, profile, strategy, tierCaps, investorCount, maxDrawdown, now, risk } = args;
  const positions = positionsView(pool, markets, prices);
  const { nav, gross, unreal } = navOf(pool, positions);
  // `nav` above is total pool *equity*. It includes the trader's first-loss
  // seed, which is what the loss limits, the drawdown and the health factor
  // must measure. Investor value is equity minus whatever is left of that
  // cushion, and that is what prices shares.
  const firstLossSeed = usd(pool.firstLossSeed ?? 0);
  const firstLossLeft = remainingFirstLoss(nav, usd(pool.investorPrincipal ?? 0), firstLossSeed);
  const invNav = investorNav(nav, usd(pool.investorPrincipal ?? 0), firstLossSeed);
  const nps = npsOf(invNav, pool.totalShares);
  // Funding baseline: NAV/share at tier start. Since the seed no longer mints
  // shares, this is 1.0 for a pool funded under the current program and
  // `perf` is simply the honest ROI. The fields stay for pools funded before
  // the fix, whose baseline sits above 1.0 by their forfeited fee.
  const fundingNps = f(pool.tierStartNps) / NPS_BASE || 1;
  const seedCushion = Math.max(0, fundingNps - 1); // head start from forfeited fees, not performance
  const perf = fundingNps > 0 ? nps / fundingNps - 1 : 0; // true trading performance since funding
  const tradingPnl = usd(pool.realizedPnl) + unreal; // realized (closed) + unrealized (open), USD
  const peak = usd(pool.peakNav);
  const dayStart = usd(pool.dayStartNav);
  const status = statusOf(pool.status);
  const activatedAt = f(pool.activatedAt) || null;
  // The floors an instant-funded (tier 0) pool actually locks at are tighter
  // than the platform-wide ones, so the health factor bots rank on, and the
  // "room before liquidation" shown to investors. Has to be narrowed to the
  // pool's tier first. Reading `risk` straight overstates a tier-0 pool's
  // headroom by a third.
  const effRisk = risk ? effectiveRisk(risk, pool.tier) : null;
  return {
    summary: {
      address,
      trader: new PublicKey(pool.trader).toBase58(),
      index: pool.index,
      name: Buffer.from(pool.name).toString("utf8").replace(/\0+$/, ""),
      strategy,
      mandate: statusOf(pool.mandate),
      status,
      lockReason: lockReasonOf(pool.lockReason),
      tier: pool.tier,
      cap: pool.tier === 0 ? usd(pool.targetSize) : (tierCaps[Math.max(0, Math.min(2, pool.tier - 1))] ?? 0) / USD,
      liveDaysAtTier: pool.liveDaysAtTier,
      tierStartTs: f(pool.tierStartTs),
      /** Total pool equity, trader cushion included. Risk measures this. */
      nav,
      tvl: nav,
      /** What the investors' shares are actually worth: `nav` minus the
       *  unspent part of the trader's seed. Redemptions pay this. */
      investorNav: invNav,
      navPerShare: nps,
      roi: nps > 0 ? nps - 1 : 0, // lifetime NAV/share − 1 (includes the seed cushion); kept for back-compat
      fundingNps,
      seedCushion,
      perf, // trading performance since funding. The honest ROI
      tradingPnl, // realized + unrealized, USD
      unrealizedPnl: unreal,
      maxDrawdown,
      currentDrawdown: peak > 0 ? Math.max(0, 1 - nav / peak) : 0,
      dailyPnlPct: dayStart > 0 ? nav / dayStart - 1 : 0,
      // Liquidation health. The single number a bot ranks on. <= 1 means the
      // pool is liquidatable right now; the floors say which limit binds.
      healthFactor: effRisk ? healthFactor(nav, dayStart, peak, effRisk) : null,
      distanceToLiquidation: effRisk ? distanceToLiquidation(nav, dayStart, peak, effRisk) : null,
      liquidationFloors: effRisk ? liquidationFloors(dayStart, peak, effRisk) : null,
      /** Trader capital standing in front of investors (no shares). */
      firstLossSeed,
      /** How much of it is still standing. It falls with every adverse tick
       *  and is what actually backs the liquidation buffer right now. */
      firstLossRemaining: firstLossLeft,
      investorPrincipal: usd(pool.investorPrincipal ?? 0),
      openPositions: pool.openPositions,
      totalTrades: pool.totalTrades,
      realizedPnl: usd(pool.realizedPnl),
      escrowTotal: usd(pool.escrowTotal),
      vestedClaimable: usd(pool.vestedClaimable),
      createdAt: f(pool.createdAt),
      activatedAt,
      lockedAt: f(pool.lockedAt) || null,
      lastMarkTs: f(pool.lastMarkTs),
      ageDays: activatedAt ? (now - activatedAt) / 86_400 : 0,
      investorCount,
      grossNotional: gross,
      traderProfile: traderSummary(new PublicKey(pool.trader).toBase58(), profile),
    },
    positions,
    extra: {
      hwmNps: f(pool.hwmNps) / NPS_BASE,
      peakNav: peak,
      dayStartNav: dayStart,
      escrowBuckets: (pool.escrow as any[]).filter((b) => f(b.amount) > 0).map((b) => ({ amount: usd(b.amount), unlockDay: b.unlockDay })),
      pendingRedemptionShares: new BN(pool.pendingRedemptionShares).toString(),
      riskDisclosure: RISK_DISCLOSURE,
    },
  };
}

export function tradeView(t: TradeRow, markets: MarketLike[]) {
  return {
    sig: t.sig,
    ts: t.ts,
    pool: t.pool,
    marketId: t.marketId,
    symbol: symbolOf(markets, t.marketId),
    side: sideOf(t.side),
    isClose: t.isClose,
    baseQty: f(t.baseQty) / QTY,
    fillPrice: usd(t.fillPrice),
    oraclePrice: usd(t.oraclePrice),
    oracleSlot: t.oracleSlot,
    fee: usd(t.fee),
    realizedPnl: usd(t.realizedPnl),
    navAfter: usd(t.navAfter),
    positionQtyAfter: f(t.positionQtyAfter) / QTY,
  };
}

export function equityView(m: NavMarkRow) {
  return { ts: m.ts, nav: usd(m.nav), navPerShare: f(m.nps) / NPS_BASE };
}

/** JSON-safe copy of an Anchor-decoded account (BN → string, PublicKey → base58). */
export function plain(x: any): any {
  if (x == null) return x;
  if (BN.isBN(x)) return x.toString();
  if (x instanceof PublicKey) return x.toBase58();
  if (Array.isArray(x)) return x.map(plain);
  if (typeof x === "object") {
    const o: any = {};
    for (const k of Object.keys(x)) o[k] = plain(x[k]);
    return o;
  }
  return x;
}
