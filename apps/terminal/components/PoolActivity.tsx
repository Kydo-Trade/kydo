"use client";
/**
 * UNUSED since the Home status panel was decluttered (19 Sep 2026).
 *
 * "What is happening in my pool right now". Open positions marked with the
 * live price feed, plus the last few fills. Both were already on the terminal's
 * Positions and Trade History tabs, live and fuller, so two more tables inside
 * a status panel were duplication rather than information. The panel links out
 * instead.
 *
 * Kept because it is self-contained and a pool-detail surface could want it;
 * delete it if nothing claims it.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { indexer, type Trade } from "@/lib/api";
import { chainPositionsToView, type ChainPool } from "@/lib/chain";
import { price as fmtPrice, qty as fmtQty, usd } from "@/lib/format";
import { usePlatform } from "@/lib/platform";
import { usePrices } from "@/lib/prices";

const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function PoolActivity({ pool, poolAddr }: { pool: ChainPool; poolAddr: string }) {
  const p = usePlatform();
  const { prices } = usePrices();
  const [trades, setTrades] = useState<Trade[] | null | undefined>(undefined);

  const symbols = useMemo(() => Object.fromEntries((p.registry?.markets ?? []).map((m) => [m.marketId, m.symbol])) as Record<number, string>, [p.registry]);
  const positions = useMemo(() => chainPositionsToView(pool, prices, symbols), [pool, prices, symbols]);
  const unrealized = positions.reduce((s, x) => s + x.unrealizedPnl, 0);

  useEffect(() => {
    if (!p.indexerOnline) {
      setTrades(null);
      return;
    }
    let alive = true;
    const load = () =>
      indexer
        .poolTrades(poolAddr, { limit: 6 })
        .then((r) => alive && setTrades(r.trades))
        .catch(() => alive && setTrades(null));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [poolAddr, p.indexerOnline, pool.totalTrades]);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 border-t border-line pt-2 mt-1">
      {/* ---- open positions (chain + live marks) ---- */}
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="label">Open positions · {positions.length}</span>
          {positions.length > 0 && (
            <span className={`num text-xxs ${unrealized >= 0 ? "text-up" : "text-down"}`} title="Unrealised PnL at the live mark">
              uPnL {usd(unrealized, { sign: true })}
            </span>
          )}
        </div>
        {positions.length === 0 ? (
          <div className="text-xs text-muted py-2">
            No open positions.{" "}
            <Link href="/terminal" className="text-fg underline underline-offset-2">
              open the terminal
            </Link>{" "}
            to trade investor capital.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl tbl-dense">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Side</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Entry</th>
                  <th className="text-right">Mark</th>
                  <th className="text-right">uPnL</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((x) => (
                  <tr key={x.marketId}>
                    <td className="font-medium">{x.symbol}</td>
                    <td className={x.side === "long" ? "text-up" : "text-down"}>{x.side.toUpperCase()}</td>
                    <td className="num text-right">{fmtQty(x.baseQty)}</td>
                    <td className="num text-right">{fmtPrice(x.entryPrice)}</td>
                    <td className="num text-right">{prices[x.marketId] ? fmtPrice(x.markPrice) : "—"}</td>
                    <td className={`num text-right ${x.unrealizedPnl >= 0 ? "text-up" : "text-down"}`}>{usd(x.unrealizedPnl, { sign: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---- recent fills (indexer) ---- */}
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="label">Recent fills</span>
          <span className="num text-xxs text-muted">
            {pool.totalTrades} lifetime · {pool.tradesToday} today
          </span>
        </div>
        {trades === undefined ? (
          <div className="text-xs text-muted py-2">Loading…</div>
        ) : trades === null ? (
          <div className="text-xs text-muted py-2">Indexer offline. Fills are unavailable; positions above come straight from the chain.</div>
        ) : trades.length === 0 ? (
          <div className="text-xs text-muted py-2">No fills yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl tbl-dense">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Market</th>
                  <th>Action</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Fill</th>
                  <th className="text-right">Realised</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.sig}>
                    <td className="num text-muted">{clock(t.ts)}</td>
                    <td className="font-medium">{t.symbol}</td>
                    <td className={t.isClose ? "text-muted" : t.side === "long" ? "text-up" : "text-down"}>{t.isClose ? "close" : t.side}</td>
                    <td className="num text-right">{fmtQty(t.baseQty)}</td>
                    <td className="num text-right">{fmtPrice(t.fillPrice)}</td>
                    <td className={`num text-right ${t.realizedPnl > 0 ? "text-up" : t.realizedPnl < 0 ? "text-down" : "text-muted"}`}>{t.isClose ? usd(t.realizedPnl, { sign: true }) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
