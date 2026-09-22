/**
 * Cross-pool monitoring (section 4.6, Vault Ledger section 7 "Collusion"): flag pools holding
 * opposing positions opened within a short window at similar notional. Two
 * scopes: the same market (the classic hedge) and the same correlated cluster
 * (majors / L1 / memes. An ETH-short against a BTC-long is the same trade in
 * disguise). Alerts are additionally annotated with Sybil linkage. Investors
 * who deposited into BOTH pools. Since the CommonPool's automatic FIFO funding
 * removes the human due-diligence step that would otherwise catch paired
 * identities. Cannot be blocked on-chain. This alert + the admin pause is the
 * MVP defence.
 */
import { env } from "./config";
import type { Store, TradeRow } from "./store";
import { f, USD, QTY } from "./views";

export interface HedgeAlert {
  type: "cross_pool_hedge";
  /** "market" = opposite sides of the same market; "cluster" = opposite sides within one correlated cluster. */
  scope: "market" | "cluster";
  poolA: string;
  poolB: string;
  /** The newly-opened trade's market; for cluster-scope hits the opposing market. */
  marketId: number;
  marketIdA: number;
  openedWithinSecs: number;
  notionalA: number;
  notionalB: number;
  ts: number;
}

export function notionalOf(t: TradeRow) {
  return (f(t.baseQty) / QTY) * (f(t.fillPrice) / USD);
}

/** Pure detector. Exported for tests. `clusterOf` widens matching to the market's correlated cluster. */
export function detectHedges(
  open: TradeRow,
  candidates: TradeRow[],
  windowSecs = env.hedgeWindowSecs,
  tol = env.hedgeNotionalTolerance,
  clusterOf?: (marketId: number) => number | undefined,
): HedgeAlert[] {
  const out: HedgeAlert[] = [];
  const nA = notionalOf(open);
  const openCluster = clusterOf?.(open.marketId);
  for (const c of candidates) {
    if (c.pool === open.pool || c.isClose || c.side === open.side) continue;
    const sameMarket = c.marketId === open.marketId;
    const sameCluster = !sameMarket && openCluster !== undefined && clusterOf?.(c.marketId) === openCluster;
    if (!sameMarket && !sameCluster) continue;
    const dt = Math.abs(open.ts - c.ts);
    if (dt > windowSecs) continue;
    const nB = notionalOf(c);
    const rel = Math.abs(nA - nB) / Math.max(nA, nB, 1e-9);
    if (rel > tol) continue;
    out.push({
      type: "cross_pool_hedge",
      scope: sameMarket ? "market" : "cluster",
      poolA: c.pool,
      poolB: open.pool,
      marketId: open.marketId,
      marketIdA: c.marketId,
      openedWithinSecs: dt,
      notionalA: nB,
      notionalB: nA,
      ts: open.ts,
    });
  }
  return out;
}

/** Detector output enriched with the trader wallets behind each pool and any Sybil linkage. */
export interface HedgeAlertWithTraders extends HedgeAlert {
  traderA: string | null;
  traderB: string | null;
  /** Investors holding positions in BOTH pools. Paired identities funded from one wallet show up here. */
  sharedDepositors: string[];
}

/** Investors with a position in both pools (capped. The count is the signal, not the roster). */
async function sharedDepositorsOf(store: Store, poolA: string, poolB: string, cap = 5): Promise<string[]> {
  try {
    const [a, b] = await Promise.all([store.investorPositions({ pool: poolA }), store.investorPositions({ pool: poolB })]);
    const inA = new Set(a.map((r) => r.data?.investor ?? r.address));
    const both = b.map((r) => r.data?.investor ?? r.address).filter((w) => inA.has(w));
    return [...new Set(both)].slice(0, cap);
  } catch {
    return [];
  }
}

export async function checkForHedges(
  store: Store,
  open: TradeRow,
  markets: { marketId: number; cluster?: number }[] = [],
): Promise<HedgeAlertWithTraders[]> {
  if (open.isClose) return [];
  const clusterOf = (id: number) => markets.find((m) => m.marketId === id)?.cluster;
  const since = open.ts - env.hedgeWindowSecs;
  // Candidates: same market, plus every other market in the same cluster.
  const openCluster = clusterOf(open.marketId);
  const marketIds = new Set<number>([open.marketId]);
  if (openCluster !== undefined) {
    for (const m of markets) if (m.cluster === openCluster) marketIds.add(m.marketId);
  }
  const batches = await Promise.all([...marketIds].map((id) => store.recentOpens(id, since)));
  const recent = batches.flat();

  const out: HedgeAlertWithTraders[] = [];
  for (const a of detectHedges(open, recent, env.hedgeWindowSecs, env.hedgeNotionalTolerance, clusterOf)) {
    const [pa, pb, shared] = await Promise.all([
      store.pool(a.poolA),
      store.pool(a.poolB),
      sharedDepositorsOf(store, a.poolA, a.poolB),
    ]);
    out.push({ ...a, traderA: pa?.data?.trader ?? null, traderB: pb?.data?.trader ?? null, sharedDepositors: shared });
  }
  return out;
}
