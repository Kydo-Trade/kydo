"use client";
/**
 * UNUSED. Nothing renders this. The market picker the trader actually sees is
 * the dropdown inside `MarketStrip`, which is where the session sparkline went.
 * Left in the tree rather than deleted, like `ModeBadge` and `PoolActivity`, in
 * case a sidebar layout comes back. Do not "fix" it in place and expect the
 * change to show up anywhere.
 */
import type { MarketLike } from "@kydo/sdk";
import { EmptyState, Skeleton } from "@kydo/ui";
import { priceStore, usePrices } from "@/lib/prices";
import { ago, price as fmtPrice, pct } from "@/lib/format";
import { clusterName } from "@/lib/sizing";

export function MarketList({ markets, selected, onSelect, loading = false }: { markets: MarketLike[]; selected: number | null; onSelect: (id: number) => void; loading?: boolean }) {
  const snap = usePrices();
  const feed = snap.source === "ws" ? { text: "websocket", tone: "pill-up" } : snap.source === "poll" ? { text: "polling", tone: "pill-amber" } : snap.source === "chain" ? { text: "chain oracle", tone: "pill-amber" } : { text: "no feed", tone: "pill-down" };
  return (
    <div className="panel flex flex-col h-full min-h-0" aria-label="Markets">
      <div className="panel-title">
        <span>Markets</span>
        <span className={`pill ${feed.tone}`} title="Price feed source">
          {feed.text}
        </span>
      </div>
      <div className="overflow-auto min-h-0 flex-1">
        {loading ? (
          <div className="p-2 flex flex-col gap-2" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex justify-between gap-2">
                <Skeleton className="w-14 h-3" />
                <Skeleton className="w-16 h-3" />
              </div>
            ))}
          </div>
        ) : markets.length === 0 ? (
          <EmptyState icon="◫" title="No markets">
            Registry is empty or the chain is unreachable.
          </EmptyState>
        ) : (
          <table className="tbl" aria-label="Select a market">
            <thead>
              <tr>
                <th>Symbol</th>
                <th className="text-right">Price</th>
                <th className="text-right">Δ sess</th>
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => {
                const t = snap.prices[m.marketId];
                const candles = priceStore.getCandles(m.marketId);
                const first = candles[0]?.open;
                const chg = t && first ? t.price / first - 1 : 0;
                const stale = t ? Date.now() / 1000 - t.ts > 30 : true;
                const isSel = selected === m.marketId;
                return (
                  <tr
                    key={m.marketId}
                    aria-selected={isSel}
                    tabIndex={0}
                    onClick={() => onSelect(m.marketId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(m.marketId);
                      }
                    }}
                    className={`cursor-pointer ${!m.enabled ? "opacity-50" : ""}`}
                    title={`${clusterName(m.cluster)} · single-position cap ${(m.maxLeverageBps / 10000).toFixed(0)}× (the platform gross cap may bind lower) · ${t ? `updated ${ago(t.ts)} ago` : "no price"}${m.enabled ? "" : " · DISABLED"}`}
                  >
                    <td className={isSel ? "border-l-2 border-l-accent" : "border-l-2 border-l-transparent"}>
                      <div className="font-medium">{m.symbol}</div>
                      <div className="text-xxs text-muted">
                        {clusterName(m.cluster)}
                        {!m.enabled ? " · off" : ""}
                      </div>
                    </td>
                    <td className={`text-right num ${stale ? "text-muted" : ""}`}>
                      {t ? fmtPrice(t.price) : <Skeleton className="w-12 h-3" />}
                      {t && <div className="text-xxs text-muted">±{((t.conf / t.price) * 10000).toFixed(1)} bps</div>}
                    </td>
                    <td className={`text-right num ${chg > 0 ? "text-up" : chg < 0 ? "text-down" : "text-muted"}`}>{pct(chg, 2, true)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
