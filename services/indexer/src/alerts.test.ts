import assert from "node:assert/strict";
import { test } from "node:test";
import { detectHedges } from "./alerts";
import type { TradeRow } from "./store";

const mk = (o: Partial<TradeRow>): TradeRow => ({
  sig: "s", idx: 0, ts: 1000, pool: "A", marketId: 1, side: 1, isClose: false,
  baseQty: (10 * 1e9).toString(), fillPrice: (150 * 1e6).toString(), oraclePrice: "0", oracleSlot: 0,
  fee: "0", realizedPnl: "0", navAfter: "0", positionQtyAfter: "0", ...o,
});

test("opposing sides, same market, similar size, within window → alert", () => {
  const open = mk({ pool: "B", side: 2, ts: 1100 });
  const alerts = detectHedges(open, [mk({ pool: "A", side: 1, ts: 1000 })], 300, 0.25);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].openedWithinSecs, 100);
});

test("same side, or outside window, or size mismatch → no alert", () => {
  const open = mk({ pool: "B", side: 2, ts: 1100 });
  assert.equal(detectHedges(open, [mk({ pool: "A", side: 2 })], 300, 0.25).length, 0);
  assert.equal(detectHedges(open, [mk({ pool: "A", side: 1, ts: 100 })], 300, 0.25).length, 0);
  assert.equal(detectHedges(open, [mk({ pool: "A", side: 1, baseQty: (3 * 1e9).toString() })], 300, 0.25).length, 0);
  assert.equal(detectHedges(open, [mk({ pool: "B", side: 1 })], 300, 0.25).length, 0, "same pool ignored");
});

test("opposing sides across correlated markets → cluster-scope alert", () => {
  // BTC (1) and ETH (2) share cluster 1; SOL (3) sits in cluster 2.
  const clusterOf = (id: number) => ({ 1: 1, 2: 1, 3: 2 } as Record<number, number>)[id];
  const open = mk({ pool: "B", side: 2, marketId: 2, ts: 1100 });
  const alerts = detectHedges(open, [mk({ pool: "A", side: 1, marketId: 1, ts: 1000 })], 300, 0.25, clusterOf);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].scope, "cluster");
  assert.equal(alerts[0].marketIdA, 1);
  assert.equal(alerts[0].marketId, 2);
});

test("opposing sides in unrelated clusters, or without a cluster map → no cluster alert", () => {
  const clusterOf = (id: number) => ({ 1: 1, 2: 1, 3: 2 } as Record<number, number>)[id];
  const open = mk({ pool: "B", side: 2, marketId: 3, ts: 1100 });
  assert.equal(detectHedges(open, [mk({ pool: "A", side: 1, marketId: 1, ts: 1000 })], 300, 0.25, clusterOf).length, 0);
  assert.equal(detectHedges(open, [mk({ pool: "A", side: 1, marketId: 1, ts: 1000 })], 300, 0.25).length, 0, "no cluster map → market scope only");
});

test("same-market hit keeps market scope", () => {
  const clusterOf = () => 1;
  const open = mk({ pool: "B", side: 2, ts: 1100 });
  const alerts = detectHedges(open, [mk({ pool: "A", side: 1, ts: 1000 })], 300, 0.25, clusterOf);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].scope, "market");
});
