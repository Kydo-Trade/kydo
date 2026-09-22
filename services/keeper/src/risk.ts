/**
 * Off-chain mirror of the program's NAV and breach maths so the keeper can
 * decide *before* sending whether a pool needs `lock_pool` (critical path,
 * Jito) or a plain `evaluate_risk` mark.
 */
import BN from "bn.js";
import { effectiveRisk, notional, positionPnl } from "@kydo/sdk";

export interface PoolLike {
  accountedUsdc: BN;
  escrowTotal: BN;
  vestedClaimable: BN;
  /** Uncollected platform performance fee. Excluded from NAV on-chain, so it
   *  must be excluded here too. Absent on pre-upgrade pools → 0. */
  platformFeeOwed?: BN;
  dayStartNav: BN;
  /** Platform day `dayStartNav` was last set for. Stale ⇒ `breach()` is
   *  measuring today against yesterday's floor. See the caller in index.ts. */
  dayEpoch?: number;
  peakNav: BN;
  /** 0 = instant-funded, which runs tighter loss limits (see `effectiveRisk`). */
  tier: number;
  positions: { marketId: number; side: number; baseQty: BN; entryPrice: BN }[];
}

export interface RiskLike {
  dailyLossBps: number;
  maxDrawdownBps: number;
}

export function openPositions(p: PoolLike) {
  return p.positions.filter((x) => x.side !== 0 && !new BN(x.baseQty).isZero());
}

/**
 * Total pool equity, mirroring `risk::compute_nav` on-chain term for term:
 * `accounted + venue equity − escrow − vested claimable − uncollected platform
 * fee`. Every one of those subtractions has to be here. Dropping one
 * overstates NAV, which reads as headroom the pool does not have and delays the
 * lock the keeper exists to send.
 *
 * The trader's first-loss seed is deliberately NOT subtracted, and must stay
 * that way: the liquidation triggers measure equity so they fire while the
 * cushion is still there to absorb the overshoot. Subtracting it would delay
 * every lock until it was already spent, which is exactly the case the buffer
 * exists for. Investor-redeemable NAV (`investorNav` in @kydo/sdk) is a display
 * and settlement number, never a trigger.
 *
 * **MockPerps only.** `unrealized` here is the sum of position PnL, which is
 * what `read_account_equity` returns for the mock. Its mirror *is* the book.
 * For Drift that function also adds the collateral held at the venue, which
 * this file never reads, so a Drift pool's NAV comes out short by its entire
 * margin balance and reads as a permanent breach. The caller in `index.ts`
 * therefore refuses to act on this number for a Drift pool and defers to the
 * program; do not remove that guard without teaching this function to read the
 * Drift `User` account.
 */
export function computeNav(p: PoolLike, marks: Map<number, BN>): { nav: BN; gross: BN; missing: number[] } {
  let unrealized = new BN(0);
  let gross = new BN(0);
  const missing: number[] = [];
  for (const pos of openPositions(p)) {
    const m = marks.get(pos.marketId);
    if (!m) {
      missing.push(pos.marketId);
      continue;
    }
    unrealized = unrealized.add(positionPnl(pos.side, new BN(pos.entryPrice), new BN(pos.baseQty), m));
    gross = gross.add(notional(new BN(pos.baseQty), m));
  }
  const nav = new BN(p.accountedUsdc)
    .add(unrealized)
    .sub(new BN(p.escrowTotal))
    .sub(new BN(p.vestedClaimable))
    .sub(new BN(p.platformFeeOwed ?? 0));
  return { nav: nav.isNeg() ? new BN(0) : nav, gross, missing };
}

export type Breach = "none" | "daily_loss" | "drawdown";

/**
 * Both of these take the PLATFORM risk params and narrow them to the pool's
 * tier themselves, so a caller cannot forget: an instant-funded pool breaches
 * at 3% / 8%, not 4% / 10%, and missing that means the keeper sits on a pool
 * the chain already considers liquidatable.
 */
export function breach(p: PoolLike, nav: BN, risk: RiskLike): Breach {
  const r = effectiveRisk(risk, p.tier);
  const dailyFloor = new BN(p.dayStartNav).muln(10_000 - r.dailyLossBps).divn(10_000);
  if (nav.lt(dailyFloor)) return "daily_loss";
  const ddFloor = new BN(p.peakNav).muln(10_000 - r.maxDrawdownBps).divn(10_000);
  if (nav.lt(ddFloor)) return "drawdown";
  return "none";
}

/** Fraction of the tighter limit already consumed (0..1+). */
export function utilisation(p: PoolLike, nav: BN, risk: RiskLike): number {
  const r = effectiveRisk(risk, p.tier);
  const pct = (num: BN, den: BN) => (den.isZero() ? 0 : Number(num.muln(10_000).div(den)) / 10_000);
  const dayStart = new BN(p.dayStartNav);
  const peak = new BN(p.peakNav);
  const daily = dayStart.gt(nav) ? pct(dayStart.sub(nav), dayStart) / (r.dailyLossBps / 10_000) : 0;
  const dd = peak.gt(nav) ? pct(peak.sub(nav), peak) / (r.maxDrawdownBps / 10_000) : 0;
  return Math.max(daily, dd);
}
