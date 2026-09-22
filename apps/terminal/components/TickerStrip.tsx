"use client";
/**
 * bulk.trade-style ticker strip. Favourites only: star a market in the
 * market strip and it pins here with its live session change, one click to
 * switch. No stars, no bar.
 */
import { useEffect, useState } from "react";
import type { MarketLike } from "@kydo/sdk";
import { priceStore, usePrices } from "@/lib/prices";
import { pct, price as fmtPrice } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";

function readFavs(markets: MarketLike[]): Set<number> {
  try {
    return new Set(markets.filter((m) => localStorage.getItem(`kydo.fav.${m.marketId}`) === "1").map((m) => m.marketId));
  } catch {
    return new Set();
  }
}

export function TickerStrip({ markets, selected, onSelect }: { markets: MarketLike[]; selected: number | null; onSelect: (id: number) => void }) {
  const snap = usePrices();
  const [favs, setFavs] = useState<Set<number>>(new Set());
  useEffect(() => {
    const load = () => setFavs(readFavs(markets));
    load();
    window.addEventListener("kydo:fav", load);
    return () => window.removeEventListener("kydo:fav", load);
  }, [markets]);
  const shown = markets.filter((m) => favs.has(m.marketId));
  if (!shown.length) return null;
  return (
    <div className="ticker" role="tablist" aria-label="Favourite markets">
      {shown.map((m) => {
        const t = snap.prices[m.marketId];
        const candles = priceStore.getCandles(m.marketId);
        const dayAgo = Date.now() / 1000 - 86_400;
        const c0 = (candles.find((c) => c.time >= dayAgo) ?? candles[0])?.open;
        const ch = t && c0 ? t.price / c0 - 1 : 0;
        const sel = m.marketId === selected;
        return (
          <button key={m.marketId} type="button" role="tab" aria-selected={sel} className="ticker__item" onClick={() => onSelect(m.marketId)} title={t ? `${m.symbol}-USDC · ${fmtPrice(t.price)}` : `${m.symbol}-USDC`}>
            <TokenIcon symbol={m.symbol} size={14} />
            <span className={sel ? "font-semibold" : ""}>{m.symbol}-USDC</span>
            <span className={`num ${ch > 0 ? "text-up" : ch < 0 ? "text-down" : "text-muted"}`}>{t && c0 ? pct(ch, 2, true) : "—"}</span>
          </button>
        );
      })}
    </div>
  );
}
