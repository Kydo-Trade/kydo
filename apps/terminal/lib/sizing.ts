/**
 * Order-sizing helpers: how much notional the pre-trade guard will accept for a
 * given market/side, and where the pool's lock floors sit. All maths in 1e6 BN
 * (same inputs as `preTradeCheck`) so the number we show is the number we send.
 */
import BN from "bn.js";
import { BPS, bpsOf, notional, type PositionLike, type RiskLike } from "@kydo/sdk";

const CLUSTER_NAMES: Record<number, string> = { 0: "Other", 1: "Majors", 2: "L1", 3: "Memes" };
export const clusterName = (c: number) => CLUSTER_NAMES[c] ?? `Cluster ${c}`;

export const ZERO = new BN(0);
export const bnMin = (...xs: BN[]) => xs.reduce((a, b) => (b.lt(a) ? b : a));
export const bnMax0 = (x: BN) => (x.isNeg() ? ZERO : x);

export interface Exposure {
  /** Σ |position notional| at mark */
  gross: BN;
  byCluster: Record<number, BN>;
  byMarket: Record<number, BN>;
  /** first market without a fresh mark (guard would reject) */
  missingMark: number | null;
}

export function exposure(positions: PositionLike[], marks: Record<number, BN>): Exposure {
  let gross = new BN(0);
  const byCluster: Record<number, BN> = {};
  const byMarket: Record<number, BN> = {};
  let missingMark: number | null = null;
  for (const p of positions) {
    const m = marks[p.marketId];
    if (!m) {
      if (missingMark === null) missingMark = p.marketId;
      continue;
    }
    const n = notional(p.baseQty, m);
    gross = gross.add(n);
    byCluster[p.cluster] = (byCluster[p.cluster] ?? ZERO).add(n);
    byMarket[p.marketId] = (byMarket[p.marketId] ?? ZERO).add(n);
  }
  return { gross, byCluster, byMarket, missingMark };
}

export type RoomKey = "single" | "market" | "cluster" | "gross";

export interface Room {
  key: RoomKey;
  /** short human label, e.g. "single position 40%" */
  label: string;
  limit: BN;
  used: BN;
  room: BN;
}

export interface SizingRoom {
  /** largest notional the guard accepts for this market/side (0 when nothing fits) */
  maxNotional: BN;
  /** the binding constraint */
  limitedBy: Room | null;
  rooms: Room[];
  /** a reason the order can never pass regardless of size, or null */
  block: string | null;
  existing: PositionLike | null;
  exposure: Exposure;
}

export interface SizingArgs {
  risk: RiskLike;
  nav: BN;
  dayStartNav: BN;
  peakNav: BN;
  positions: PositionLike[];
  marks: Record<number, BN>;
  marketId: number;
  cluster: number;
  /** 1 long, 2 short */
  side: number;
  oraclePrice: BN;
  marketMaxLeverageBps?: number;
}

/**
 * Mirrors the guard's single / market-leverage / cluster / gross checks and
 * solves each for the largest additional notional. Adding to a same-side
 * position counts the existing notional (at oracle) toward single & market caps;
 * cluster & gross use marks like the guard does.
 */
export function sizingRoom(a: SizingArgs): SizingRoom {
  const { risk, nav } = a;
  const exp = exposure(a.positions, a.marks);
  const existing = a.positions.find((p) => p.marketId === a.marketId) ?? null;
  const existingAtOracle = existing ? notional(existing.baseQty, a.oraclePrice) : ZERO;

  let block: string | null = null;
  if (nav.isZero()) block = "NAV is zero";
  else if (nav.lt(bpsOf(a.dayStartNav, BPS - risk.dailyLossBps))) block = "daily-loss floor breached. Pool will lock";
  else if (nav.lt(bpsOf(a.peakNav, BPS - risk.maxDrawdownBps))) block = "drawdown floor breached. Pool will lock";
  else if (existing && existing.side !== a.side) block = `you are ${existing.side === 2 ? "short" : "long"} this market. Close it instead of opening the opposite side`;
  else if (!existing && a.positions.length >= risk.maxPositions) block = `all ${risk.maxPositions} position slots are used. Close one first`;
  else if (exp.missingMark !== null) block = `no mark for open market #${exp.missingMark}`;

  const singleLimit = bpsOf(nav, risk.maxSingleBps);
  const clusterLimit = bpsOf(nav, risk.maxClusterBps);
  const grossLimit = bpsOf(nav, risk.maxLeverageBps);
  const clusterUsed = exp.byCluster[a.cluster] ?? ZERO;

  const rooms: Room[] = [
    { key: "single", label: `single position ${risk.maxSingleBps / 100}%`, limit: singleLimit, used: existingAtOracle, room: bnMax0(singleLimit.sub(existingAtOracle)) },
    { key: "cluster", label: `${clusterName(a.cluster)} cluster ${risk.maxClusterBps / 100}%`, limit: clusterLimit, used: clusterUsed, room: bnMax0(clusterLimit.sub(clusterUsed)) },
    { key: "gross", label: `gross ${risk.maxLeverageBps / BPS}× leverage`, limit: grossLimit, used: exp.gross, room: bnMax0(grossLimit.sub(exp.gross)) },
  ];
  if (a.marketMaxLeverageBps) {
    const mLimit = bpsOf(nav, a.marketMaxLeverageBps);
    rooms.splice(1, 0, { key: "market", label: `market cap ${a.marketMaxLeverageBps / BPS}×`, limit: mLimit, used: existingAtOracle, room: bnMax0(mLimit.sub(existingAtOracle)) });
  }
  let limitedBy: Room | null = null;
  for (const r of rooms) if (!limitedBy || r.room.lt(limitedBy.room)) limitedBy = r;
  // 0.5% safety margin: marks move between the client's calculation and on-chain execution,
  // and the guard re-values existing positions at the *current* oracle. Sitting exactly on a
  // cap (e.g. 60.0% cluster) fails with ClusterExceeded a few seconds later.
  const maxNotional = block ? ZERO : (limitedBy?.room ?? ZERO).muln(995).divn(1000);
  return { maxNotional, limitedBy, rooms, block, existing, exposure: exp };
}

export interface LockFloors {
  /** NAV below which the keeper locks for daily loss */
  daily: BN;
  /** NAV below which the keeper locks for drawdown */
  drawdown: BN;
}

export function lockFloors(risk: RiskLike, dayStartNav: BN, peakNav: BN): LockFloors {
  return {
    daily: bpsOf(dayStartNav, BPS - risk.dailyLossBps),
    drawdown: bpsOf(peakNav, BPS - risk.maxDrawdownBps),
  };
}

/** used/limit as a plain ratio (0 when the limit is zero). */
export const ratio = (used: BN, limit: BN): number => (limit.isZero() ? 0 : Number(used.muln(10_000).div(limit)) / 10_000);

/** Colour class for a utilisation ratio: amber ≥75%, red at breach. */
export const utilText = (r: number) => (r >= 1 ? "text-down" : r >= 0.75 ? "text-amber" : "text-fg");
export const utilBg = (r: number) => (r >= 1 ? "bg-down" : r >= 0.75 ? "bg-amber" : "bg-up");
