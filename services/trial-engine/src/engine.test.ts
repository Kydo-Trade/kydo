import assert from "node:assert/strict";
import { test } from "node:test";
import nacl from "tweetnacl";
import { verifyChain, verifyProof } from "@kydo/sdk";
import { Criteria, dayRoot, execute, Market, metrics, mark, newAccount, proofs, Risk, TrialError } from "./engine";

const risk: Risk = { maxLeverageBps: 30_000, maxPositions: 5, maxSingleBps: 4_000, maxClusterBps: 6_000, dailyLossBps: 400, maxDrawdownBps: 1_000, minHoldSecs: 60, maxTradesPerDay: 100, limitBandBps: 200 };
const c: Criteria = { startingBalance: 50_000, profitTargetBps: 800, maxDrawdownBps: 1_000, dailyLossBps: 400, minActiveDays: 15, minTrades: 20, maxDayProfitShareBps: 4_000, daySecs: 86_400 };
const SOL: Market = { marketId: 1, symbol: "SOL-PERP", cluster: 2, enabled: true, maxLeverageBps: 30_000, depthUsd: 250_000 };
const BTC: Market = { marketId: 2, symbol: "BTC-PERP", cluster: 1, enabled: true, maxLeverageBps: 30_000, depthUsd: 250_000 };
const ETH: Market = { marketId: 3, symbol: "ETH-PERP", cluster: 1, enabled: true, maxLeverageBps: 30_000, depthUsd: 250_000 };
const kp = nacl.sign.keyPair();
const T0 = 1_700_000_000;

test("fills cross the spread and pay fees; log is hash-chained and provable", () => {
  const acc = newAccount("W", T0, c);
  const p = { 1: 150, 2: 60_000, 3: 3_000 };
  const { fill } = execute(acc, { marketId: 1, side: "long", action: "open", notional: 10_000, stopPx: 148.5 }, SOL, p, T0 + 10, risk, c, kp.secretKey);
  assert.ok(fill.fillPrice > 150 && fill.fillPrice < 150.2);
  assert.ok(Math.abs(fill.fee - 5) < 0.01);
  execute(acc, { marketId: 1, side: "long", action: "close" }, SOL, { ...p, 1: 165 }, T0 + 100, risk, c, kp.secretKey);
  assert.equal(acc.positions.length, 0);
  assert.ok(acc.balance > 50_900 && acc.balance < 51_000, `balance ${acc.balance}`);
  assert.ok(verifyChain(acc.entries));
  const pr = proofs(acc);
  assert.ok(pr.every((x, i) => verifyProof(x, acc.entries[i])));
  assert.equal(pr[0].root, dayRoot(acc, 0).toString("hex"));
});

test("guard mirrors the on-chain limits", () => {
  const acc = newAccount("W", T0, c);
  const p = { 1: 150, 2: 60_000, 3: 3_000 };
  const t = (n: number) => T0 + n;
  assert.throws(() => execute(acc, { marketId: 1, side: "long", action: "open", notional: 21_000, stopPx: 148.5 }, SOL, p, t(1), risk, c, kp.secretKey), (e: any) => e.code === "SinglePositionExceeded");
  execute(acc, { marketId: 2, side: "long", action: "open", notional: 19_000, stopPx: 59_400 }, BTC, p, t(2), risk, c, kp.secretKey);
  assert.throws(() => execute(acc, { marketId: 3, side: "long", action: "open", notional: 15_000, stopPx: 2_970 }, ETH, p, t(3), risk, c, kp.secretKey), (e: any) => e.code === "ClusterExceeded");
  assert.throws(() => execute(acc, { marketId: 2, side: "short", action: "open", notional: 1_000, stopPx: 60_600 }, BTC, p, t(4), risk, c, kp.secretKey), (e: any) => e.code === "OppositeSide");
  assert.throws(() => execute(acc, { marketId: 2, side: "long", action: "close" }, BTC, p, t(5), risk, c, kp.secretKey), (e: any) => e.code === "MinHoldTime");
  assert.throws(() => execute(acc, { marketId: 1, side: "long", action: "open", notional: 30_000, stopPx: 148.5 }, SOL, p, t(6), risk, c, kp.secretKey), (e: any) => e.code === "ExceedsDepth");
  assert.throws(() => execute(acc, { marketId: 1, side: "long", action: "open", notional: 1_000, limitPx: 160, stopPx: 148.5 }, SOL, p, t(7), risk, c, kp.secretKey), (e: any) => e.code === "LimitOutOfBand");
});

test("a 4% daily loss locks the trial and unwinds, and the metrics fail", () => {
  const acc = newAccount("W", T0, c);
  const p = { 1: 150 };
  execute(acc, { marketId: 1, side: "long", action: "open", notional: 20_000, stopPx: 148.5 }, SOL, p, T0 + 1, risk, c, kp.secretKey);
  const reason = mark(acc, { 1: 150 * 0.88 }, T0 + 500, risk, c); // −12% on 40% notional ≈ −4.8%
  assert.equal(reason, "daily_loss");
  assert.equal(acc.locked, true);
  assert.equal(acc.positions.length, 0);
  const m = metrics(acc, { 1: 132 }, c);
  assert.equal(m.passing.dailyLoss, false);
  assert.ok(m.maxDailyLossBps > 400);
  assert.throws(() => execute(acc, { marketId: 1, side: "long", action: "open", notional: 100, stopPx: 148.5 }, SOL, p, T0 + 600, risk, c, kp.secretKey), (e: any) => e instanceof TrialError);
});

test("section 5.4 metrics: consistency and activity filters", () => {
  const acc = newAccount("W", T0, c);
  const p = { 1: 150 };
  // 20 days, 1 round trip per day, each +1% on 10k → 100 gross… keep profits even across days
  for (let d = 0; d < 20; d++) {
    const t = T0 + d * 86_400;
    execute(acc, { marketId: 1, side: "long", action: "open", notional: 10_000, stopPx: 148.5 }, SOL, { 1: 150 }, t + 1, risk, c, kp.secretKey);
    execute(acc, { marketId: 1, side: "long", action: "close" }, SOL, { 1: 154 }, t + 100, risk, c, kp.secretKey);
  }
  const m = metrics(acc, { 1: 154 }, c);
  assert.equal(m.activeDays, 20);
  assert.equal(m.trades, 40);
  assert.ok(m.profitPct > 0.08, `profit ${m.profitPct}`);
  assert.ok(m.maxDayProfitShareBps < 1000);
  assert.equal(m.passing.all, true);
});

test("a stop is optional, side-checked, and fires on a mark", () => {
  const acc = newAccount("W", T0, c);
  const p = { 1: 150 };
  // no stop at all is fine. The platform enforces its limits by liquidation
  execute(acc, { marketId: 1, side: "long", action: "open", notional: 1_000 }, SOL, p, T0 + 1, risk, c, kp.secretKey);
  assert.equal(acc.positions.length, 1);
  execute(acc, { marketId: 1, side: "long", action: "close" }, SOL, p, T0 + 100, risk, c, kp.secretKey);
  // a stop on the wrong side is still rejected
  assert.throws(
    () => execute(acc, { marketId: 1, side: "long", action: "open", notional: 1_000, stopPx: 151 }, SOL, p, T0 + 200, risk, c, kp.secretKey),
    (e: any) => e.code === "StopWrongSide",
  );
  // and a stop that is set fires on a mark through it, with nothing else running
  // 15k, not 20k: the round trip above shaved equity by fees, so 20k no longer
  // fits under the 40% single-position cap.
  execute(acc, { marketId: 1, side: "long", action: "open", notional: 15_000, stopPx: 148.5 }, SOL, p, T0 + 300, risk, c, kp.secretKey);
  assert.equal(acc.positions.length, 1);
  mark(acc, { 1: 148 }, T0 + 400, risk, c);
  assert.equal(acc.positions.length, 0);
  assert.equal(acc.locked, false);
});
