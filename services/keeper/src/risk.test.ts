import assert from "node:assert/strict";
import { test } from "node:test";
import BN from "bn.js";
import { breach, computeNav, utilisation } from "./risk";

const usd = (x: number) => new BN(Math.round(x * 1e6));
const qty = (x: number) => new BN(Math.round(x * 1e9));

const pool = {
  accountedUsdc: usd(10_000),
  escrowTotal: usd(0),
  vestedClaimable: usd(0),
  platformFeeOwed: usd(0),
  dayStartNav: usd(10_000),
  peakNav: usd(10_000),
  tier: 1,
  positions: [
    { marketId: 1, side: 1, baseQty: qty(20), entryPrice: usd(150) }, // long 20 SOL = $3,000
    { marketId: 2, side: 2, baseQty: qty(0.05), entryPrice: usd(60_000) }, // short 0.05 BTC = $3,000
  ],
};
const risk = { dailyLossBps: 400, maxDrawdownBps: 1000 };

test("nav = cash + unrealized; gross notional summed", () => {
  const marks = new Map([[1, usd(150)], [2, usd(60_000)]]);
  const { nav, gross } = computeNav(pool, marks);
  assert.equal(nav.toString(), usd(10_000).toString());
  assert.equal(gross.toString(), usd(6_000).toString());
});

test("a 15% SOL drop with BTC flat breaches the daily cap first", () => {
  const marks = new Map([[1, usd(127.5)], [2, usd(60_000)]]);
  const { nav } = computeNav(pool, marks); // −450 → 9,550 = −4.5%
  assert.equal(breach(pool, nav, risk), "daily_loss");
  assert.ok(utilisation(pool, nav, risk) > 1);
});

test("short BTC gains offset long SOL losses", () => {
  const marks = new Map([[1, usd(135)], [2, usd(54_000)]]);
  const { nav } = computeNav(pool, marks); // −300 + 300 = 0
  assert.equal(nav.toString(), usd(10_000).toString());
  assert.equal(breach(pool, nav, risk), "none");
});

test("drawdown fires before the daily cap when day-start already moved down", () => {
  // Day started at 9,200 after earlier losses; peak is 10,000. SOL −7.3% → −220 → NAV 8,980:
  // above the daily floor (9,200 × 96% = 8,832) but below the drawdown floor (10,000 × 90% = 9,000).
  const p = { ...pool, accountedUsdc: usd(9_200), dayStartNav: usd(9_200), peakNav: usd(10_000) };
  const marks = new Map([[1, usd(139)], [2, usd(60_000)]]);
  const { nav } = computeNav(p, marks);
  assert.equal(nav.toString(), usd(8_980).toString());
  assert.equal(breach(p, nav, risk), "drawdown");
});

test("the uncollected platform fee is excluded from NAV, as it is on-chain", () => {
  // `compute_nav` subtracts platform_fee_owed: it is the platform's money, not
  // the pool's. Leaving it in overstates NAV, which is headroom the pool does
  // not have, and the keeper would sit on a pool the chain already locks.
  const p = { ...pool, platformFeeOwed: usd(120) };
  const marks = new Map([[1, usd(150)], [2, usd(60_000)]]);
  const { nav } = computeNav(p, marks);
  assert.equal(nav.toString(), usd(9_880).toString());

  // Enough to matter: this pool is inside the daily cap on the wrong maths and
  // outside it on the right ones.
  const q = { ...pool, accountedUsdc: usd(9_650), dayStartNav: usd(10_000), platformFeeOwed: usd(100) };
  const flat = new Map([[1, usd(150)], [2, usd(60_000)]]);
  assert.equal(computeNav(q, flat).nav.toString(), usd(9_550).toString());
  assert.equal(breach(q, computeNav(q, flat).nav, risk), "daily_loss");
  assert.equal(breach(q, usd(9_650), risk), "none", "the fee is exactly what tips it over");
});

test("an instant-funded pool breaches at its own tighter floors", () => {
  // Tier 0 skipped the trial, so the program runs it at 3% daily / 8% drawdown
  // (`effective_daily_loss_bps`). The keeper takes the platform params and has
  // to narrow them itself, or it never sends the lock the chain would accept.
  const marks = new Map([[1, usd(133.5)], [2, usd(60_000)]]); // SOL −11% → −330 → NAV 9,670 = −3.3%
  const tier1 = { ...pool, tier: 1 };
  const tier0 = { ...pool, tier: 0 };
  const { nav } = computeNav(tier1, marks);
  assert.equal(nav.toString(), usd(9_670).toString());

  assert.equal(breach(tier1, nav, risk), "none", "−3.3% is inside the platform-wide 4% cap");
  assert.equal(breach(tier0, nav, risk), "daily_loss", "…but outside tier 0's 3% cap");
  assert.ok(utilisation(tier0, nav, risk) > 1);
  assert.ok(utilisation(tier1, nav, risk) < 1);

  // Drawdown, same story. −8.5% from a 10,000 peak clears the platform's 10%
  // floor and misses tier 0's 8% one. Day-start sits at 9,300 so the daily cap
  // binds for neither tier and the drawdown floor is what is actually tested.
  const deep = new Map([[1, usd(107.5)], [2, usd(60_000)]]); // −850 → 9,150
  const d = computeNav(tier1, deep).nav;
  assert.equal(d.toString(), usd(9_150).toString());
  assert.equal(breach({ ...tier1, dayStartNav: usd(9_300) }, d, risk), "none", "9,150 clears the 9,000 floor");
  assert.equal(breach({ ...tier0, dayStartNav: usd(9_300) }, d, risk), "drawdown", "…but not tier 0's 9,200");
});
