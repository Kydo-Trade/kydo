/** Typed views over Anchor-decoded accounts (all u64/i64/u128 arrive as BN). */
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { PRICE_SCALE, QTY_SCALE, effectiveRisk, positionPnl, notional as notionalOf, navPerShare, type PositionLike, type RiskLike } from "@kydo/sdk";
import type { Tick } from "./prices";
import { decodeBytesString, fromPrice, fromQty, npsToFloat } from "./format";
import type { Position } from "./api";

export type AnchorEnum = Record<string, Record<string, never>>;
export const enumKey = (e: AnchorEnum | undefined | null): string => (e ? Object.keys(e)[0] ?? "" : "");

export type TraderStatus = "none" | "applied" | "trial" | "failed" | "eligible" | "frozen";

export interface ChainProfile {
  wallet: PublicKey;
  status: AnchorEnum;
  attempts: number;
  trialRoot: number[];
  trialStartTs: BN;
  trialDaysCommitted: number;
  tier: number;
  tierStartTs: BN;
  liveDaysAtTier: number;
  poolsCreated: number;
  poolsLocked: number;
  trialsFailed: number;
  cooldownUntil: BN;
  activePool: PublicKey;
  bump: number;
  /** Instant funding (tier 0): the cap paid for at apply; absent on pre-upgrade profiles. */
  instantCap?: BN;
}

export interface ChainRisk {
  maxLeverageBps: number;
  maxPositions: number;
  maxSingleBps: number;
  maxClusterBps: number;
  dailyLossBps: number;
  maxDrawdownBps: number;
  minHoldSecs: number;
  maxTradesPerDay: number;
  oracleMaxAgeSlots: BN;
  oracleMaxConfBps: number;
  limitBandBps: number;
  redemptionLockupSecs: number;
  cooldownSecs: number;
  promotionDays: number;
}

export interface ChainTrialCriteria {
  startingBalance: BN;
  profitTargetBps: number;
  maxDrawdownBps: number;
  dailyLossBps: number;
  minActiveDays: number;
  minTrades: number;
  maxDayProfitShareBps: number;
  daySecs: number;
  commitGraceDays: number;
}

export interface ChainConfig {
  admin: PublicKey;
  usdcMint: PublicKey;
  trialAttestor: PublicKey;
  priceAuthority: PublicKey;
  entryFee: BN;
  bountyPerPool: BN;
  keeperBounty: BN;
  activationFloor: BN;
  minDeposit: BN;
  tierCaps: BN[];
  vestDays: number[];
  risk: ChainRisk;
  trial: ChainTrialCriteria;
  paused: boolean;
  allowMockOracle: boolean;
  /** Trader first-loss required to fund a pool, bps of the tier cap. Absent on
   *  configs from before the liquidation model. */
  minFirstLossBps?: number;
  /** Liquidation bounty, bps of pool NAV, floored at keeperBounty. */
}

export interface ChainPosition {
  marketId: number;
  side: number;
  cluster: number;
  baseQty: BN;
  entryPrice: BN;
  openedAt: BN;
}

export interface ChainEscrowBucket {
  amount: BN;
  unlockDay: number;
}

export interface ChainStopOrder {
  marketId: number;
  /** trigger price, 1e6; 0 = free slot */
  price: BN;
}

export interface ChainPool {
  trader: PublicKey;
  profile: PublicKey;
  index: number;
  mandate: AnchorEnum;
  status: AnchorEnum;
  lockReason: number;
  venue: AnchorEnum;
  vault: PublicKey;
  venueAccount: PublicKey;
  name: number[];
  strategyHash: number[];
  targetSize: BN;
  tier: number;
  tierStartTs: BN;
  tierStartNps: BN;
  liveDaysAtTier: number;
  lastLiveDay: number;
  accountedUsdc: BN;
  totalShares: BN;
  hwmNps: BN;
  peakNav: BN;
  dayStartNav: BN;
  dayEpoch: number;
  realizedPnl: BN;
  venueFeesPaid: BN;
  escrow: ChainEscrowBucket[];
  escrowTotal: BN;
  vestedClaimable: BN;
  /** Uncollected 5% platform performance fee. Excluded from NAV. */
  platformFeeOwed?: BN;
  positions: ChainPosition[];
  openPositions: number;
  tradesToday: number;
  totalTrades: number;
  pendingRedemptionShares: BN;
  createdAt: BN;
  activatedAt: BN;
  lockedAt: BN;
  lastMarkTs: BN;
  lastMarkNav: BN;
  bump: number;
  vaultBump: number;
  /** Unix seconds the pool expires (0 / absent = open-ended). Absent on pools from the pre-duration program. */
  endsAt?: BN;
  /** Optional stop per open position, keyed by market. A trader tool. The
   *  platform bounds risk by liquidation, not by mandating stops. */
  stops?: ChainStopOrder[];
  /** Baseline for venue-side realizations already run through the profit
   *  split. Drift pools only; 0 and unused on MockPerps. */
  venueAccountedQuote?: BN;
  /** Trader capital in front of investors. Holds no shares, spent first. */
  firstLossSeed?: BN;
  /** Investor cash in the pool (allocation + deposits − payouts). The seed is
   *  measured against this: `remaining = clamp(equity − principal, 0, seed)`
   *  and investor NAV is `equity − remaining`, so the cushion is neither
   *  redeemable nor counted as profit. */
  investorPrincipal?: BN;
}

/** `Treasury` PDA: entry-fee revenue (admin-withdrawable) + ring-fenced keeper bounty reserve. */
export interface ChainTreasury {
  revenue: BN;
  bountyReserve: BN;
  dustSwept: BN;
  bountiesPaid: BN;
  bump: number;
  vaultBump: number;
}

export interface ChainMockOracle {
  marketId: number;
  price: BN;
  conf: BN;
  expo: number;
  publishTime: BN;
  slot: BN;
}

export const profileStatus = (p: ChainProfile | null | undefined): TraderStatus =>
  p ? ((enumKey(p.status) || "none") as TraderStatus) : "none";

export const poolStatus = (p: ChainPool): "funding" | "live" | "locked" | "settled" =>
  enumKey(p.status) as "funding" | "live" | "locked" | "settled";

export const poolName = (p: ChainPool) => decodeBytesString(p.name);

/**
 * True when `pool.name` is the placeholder the program writes, not a name a
 * trader chose. `fund_next_in_queue` sets `pool.name = "CommonPool-funded"` on
 * every pool the Common Pool funds, so the string is an implementation detail
 * of the funding path. It identifies nothing and reads as noise wherever it is
 * shown as a title.
 */
export const DEFAULT_POOL_NAME = "CommonPool-funded";
export const isDefaultPoolName = (name: string) => name.trim() === DEFAULT_POOL_NAME;

export const openPositions = (p: ChainPool): ChainPosition[] =>
  p.positions.filter((x) => x.side !== 0 && !new BN(x.baseQty).isZero());

export const isDefaultKey = (k: PublicKey) => k.equals(PublicKey.default);

/**
 * Platform risk params → the SDK's `RiskLike`, narrowed to the pool's tier.
 *
 * `tier` is required on purpose: an instant-funded (tier 0) pool trades under
 * tighter loss limits than `config.risk` advertises, so anything that shows a
 * floor, a utilisation bar or a pre-trade verdict has to pass the tier through
 * or it will promise headroom the chain will not honour. Pass 1 where there is
 * no pool (the trial account runs at the platform limits).
 */
export const riskLike = (r: ChainRisk, tier: number): RiskLike =>
  effectiveRisk(
    {
      maxLeverageBps: r.maxLeverageBps,
      maxPositions: r.maxPositions,
      maxSingleBps: r.maxSingleBps,
      maxClusterBps: r.maxClusterBps,
      dailyLossBps: r.dailyLossBps,
      maxDrawdownBps: r.maxDrawdownBps,
      limitBandBps: r.limitBandBps,
    },
    tier,
  );

/** The stop attached to `marketId`, or undefined when the pool has none. */
export const stopFor = (p: ChainPool, marketId: number): BN | undefined => {
  const s = (p.stops ?? []).find((x) => !new BN(x.price).isZero() && x.marketId === marketId);
  return s ? new BN(s.price) : undefined;
};

export const toPositionLike = (p: ChainPosition, stopPx?: BN): PositionLike => ({
  marketId: p.marketId,
  side: p.side,
  cluster: p.cluster,
  baseQty: new BN(p.baseQty),
  entryPrice: new BN(p.entryPrice),
  stopPx,
});

export const tickToBN = (t: Tick) => new BN(Math.round(t.price * PRICE_SCALE));

export interface LiveMarks {
  /** nav in 1e6 units */
  nav: BN;
  unrealized: BN;
  grossNotional: BN;
  marks: Record<number, BN>;
  /** true when every open position had a fresh mark */
  complete: boolean;
}

/** Mirror of `risk::compute_nav` for MockPerps: accounted + Σ pnl − escrow − claimable, floored at 0. */
export function computeLiveMarks(pool: ChainPool, prices: Record<number, Tick>): LiveMarks {
  let unrealized = new BN(0);
  let gross = new BN(0);
  const marks: Record<number, BN> = {};
  let complete = true;
  for (const p of openPositions(pool)) {
    const t = prices[p.marketId];
    if (!t) {
      complete = false;
      continue;
    }
    const mark = tickToBN(t);
    marks[p.marketId] = mark;
    unrealized = unrealized.add(positionPnl(p.side, new BN(p.entryPrice), new BN(p.baseQty), mark));
    gross = gross.add(notionalOf(new BN(p.baseQty), mark));
  }
  // Total pool equity, mirroring `risk::compute_nav`. The trader's first-loss
  // seed is part of it. `liveNps` strips the unspent part back out to price
  // shares, but the risk read-outs want it in.
  let nav = new BN(pool.accountedUsdc)
    .add(unrealized)
    .sub(new BN(pool.escrowTotal))
    .sub(new BN(pool.vestedClaimable))
    .sub(new BN(pool.platformFeeOwed ?? 0));
  if (!complete) nav = new BN(pool.lastMarkNav);
  if (nav.isNeg()) nav = new BN(0);
  return { nav, unrealized, grossNotional: gross, marks, complete };
}

export function chainPositionsToView(pool: ChainPool, prices: Record<number, Tick>, symbols: Record<number, string>): Position[] {
  return openPositions(pool).map((p) => {
    const t = prices[p.marketId];
    const entry = fromPrice(p.entryPrice);
    const q = fromQty(p.baseQty);
    const mark = t ? t.price : entry;
    const pnl = (mark - entry) * q * (p.side === 2 ? -1 : 1);
    return {
      marketId: p.marketId,
      symbol: symbols[p.marketId] ?? `#${p.marketId}`,
      side: p.side === 2 ? "short" : "long",
      cluster: p.cluster,
      baseQty: q,
      entryPrice: entry,
      markPrice: mark,
      notional: q * mark,
      unrealizedPnl: pnl,
      openedAt: Number(p.openedAt.toString()),
    };
  });
}

/** NAV per share from total `equity`: the unspent first-loss seed is deducted
 *  first, because it holds no shares and a redemption cannot reach it. */
export function liveNps(pool: ChainPool, equity: BN): number {
  const seed = new BN(pool.firstLossSeed ?? 0);
  const gap = equity.sub(new BN(pool.investorPrincipal ?? 0));
  const left = gap.isNeg() ? new BN(0) : BN.min(gap, seed);
  return npsToFloat(navPerShare(equity.sub(left), new BN(pool.totalShares)));
}

export const PRICE_SCALE_N = PRICE_SCALE;
export const QTY_SCALE_N = QTY_SCALE;
