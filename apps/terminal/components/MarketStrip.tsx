"use client";
/**
 * Hyperliquid-style market header: a market picker (searchable dropdown table)
 * followed by a row of stats for the selected market. Sits above the chart.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { indexer } from "@/lib/api";
import { usdCompact } from "@/lib/format";
import type { MarketLike } from "@kydo/sdk";
import { Skeleton } from "@kydo/ui";
import { priceStore, usePrices } from "@/lib/prices";
import { ago, price as fmtPrice, pct } from "@/lib/format";
import { clusterName } from "@/lib/sizing";
import { usePlatform } from "@/lib/platform";
import { ChevronDown, Star } from "lucide-react";
import { TokenIcon } from "./TokenIcon";

function Stat({ label, value, cls = "", hint, loading }: { label: string; value: React.ReactNode; cls?: string; hint?: string; loading?: boolean }) {
  return (
    <div className="stat" title={hint}>
      <span className={`stat__label ${hint ? "underline decoration-dashed decoration-muted/50 underline-offset-[3px]" : ""}`}>{label}</span>
      {loading ? <Skeleton className="w-14 h-3 mt-0.5" /> : <span className={`stat__value ${cls}`}>{value}</span>}
    </div>
  );
}

export function MarketStrip({ markets, selected, onSelect, loading = false, venue, mark }: { markets: MarketLike[]; selected: number | null; onSelect: (id: number) => void; loading?: boolean; venue: string; mark?: number }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const snap = usePrices();
  /* Two different ceilings live in the program and only one of them was on
     screen. `trading.rs` checks BOTH on every fill:

       gross_after  <= nav x cfg.risk.max_leverage_bps   (platform, all positions)
       single_after <= nav x market.max_leverage_bps     (this market, one position)

     The picker printed the market number alone, so a registry entry of 10x read
     as "10x" while a platform cap of 5x meant no position could ever exceed 5x.
     What binds one position in one market is the lower of the two. */
  const platformLevBps = usePlatform().config?.risk.maxLeverageBps;
  const effLev = (marketBps: number) => (platformLevBps ? Math.min(marketBps, platformLevBps) : marketBps);
  const market = markets.find((m) => m.marketId === selected) ?? null;
  const tick = market ? snap.prices[market.marketId] : undefined;
  const candles = market ? priceStore.getCandles(market.marketId) : [];
  // headline price: coloured by tick direction, held until it changes (build-spec rule)
  const prevPx = useRef(0);
  const [tickDir, setTickDir] = useState<"up" | "down" | "flat">("flat");
  useEffect(() => {
    const px = tick?.price ?? 0;
    if (px && prevPx.current && px !== prevPx.current) setTickDir(px > prevPx.current ? "up" : "down");
    prevPx.current = px;
  }, [tick?.price]);
  useEffect(() => {
    prevPx.current = 0;
    setTickDir("flat");
  }, [selected]);

  const dayAgo = Date.now() / 1000 - 86_400;
  const day = candles.filter((c) => c.time >= dayAgo);
  const first = day[0] ?? candles[0];
  const chg = first && tick ? tick.price / first.open - 1 : 0;
  const hi = day.length ? Math.max(...day.map((c) => c.high)) : 0;
  const lo = day.length ? Math.min(...day.map((c) => c.low)) : 0;
  const stale = tick ? Date.now() / 1000 - tick.ts > 30 : false;
  const feed = snap.source === "ws" ? { text: "live", cls: "text-up" } : snap.source === "poll" ? { text: "polling", cls: "text-amber" } : snap.source === "chain" ? { text: "chain", cls: "text-amber" } : { text: "no feed", cls: "text-down" };

  // real open interest from the indexer (sum of open notional across pools)
  const [oiUsd, setOiUsd] = useState<number | null>(null);
  useEffect(() => {
    setOiUsd(null);
    if (selected === null) return;
    let alive = true;
    const load = () =>
      indexer
        .markets()
        .then((r) => alive && setOiUsd(r.markets.find((m) => m.marketId === selected)?.oiUsd ?? 0))
        .catch(() => alive && setOiUsd(null));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [selected]);

  // favourite star (local, per market. Pins the market to the ticker strip)
  const [fav, setFav] = useState(false);
  const [favSet, setFavSet] = useState<Set<number>>(new Set());
  useEffect(() => {
    const load = () => {
      try {
        setFav(selected !== null && localStorage.getItem(`kydo.fav.${selected}`) === "1");
        setFavSet(new Set(markets.filter((m) => localStorage.getItem(`kydo.fav.${m.marketId}`) === "1").map((m) => m.marketId)));
      } catch {
        setFav(false);
      }
    };
    load();
    window.addEventListener("kydo:fav", load);
    return () => window.removeEventListener("kydo:fav", load);
  }, [selected, markets]);
  const toggleFavFor = (id: number) => {
    try {
      const on = localStorage.getItem(`kydo.fav.${id}`) === "1";
      if (on) localStorage.removeItem(`kydo.fav.${id}`);
      else localStorage.setItem(`kydo.fav.${id}`, "1");
      window.dispatchEvent(new CustomEvent("kydo:fav"));
    } catch {
      /* private mode */
    }
  };
  const toggleFav = () => {
    if (selected === null) return;
    try {
      const v = !fav;
      setFav(v);
      if (v) localStorage.setItem(`kydo.fav.${selected}`, "1");
      else localStorage.removeItem(`kydo.fav.${selected}`);
      window.dispatchEvent(new CustomEvent("kydo:fav"));
    } catch {
      /* private mode */
    }
  };

  // 24h quote volume from the same Binance 1h klines that back the chart (display-only)
  const [vol24, setVol24] = useState<number | null>(null);
  useEffect(() => {
    setVol24(null);
    if (selected === null) return;
    let alive = true;
    const load = () =>
      indexer
        .candles(selected, { tf: "1h", limit: 24 })
        .then((r) => alive && setVol24(r.candles.reduce((a, c) => a + ((c as { v?: number }).v ?? 0) * c.close, 0)))
        .catch(() => alive && setVol24(null));
    load();
    const t = setInterval(load, 120_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [selected]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return markets.filter((m) => !needle || m.symbol.toLowerCase().includes(needle) || clusterName(m.cluster).toLowerCase().includes(needle));
  }, [markets, q]);

  // open: focus search, reset; close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    setQ("");
    setCursor(Math.max(0, markets.findIndex((m) => m.marketId === selected)));
    setTimeout(() => search.current?.focus(), 0);
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, markets, selected]);

  const pick = (id: number) => {
    onSelect(id);
    setOpen(false);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return setOpen(false);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(rows.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Enter" && rows[cursor]) {
      e.preventDefault();
      pick(rows[cursor].marketId);
    }
  };

  return (
    <div className="panel flex items-center gap-3 px-3 h-14 shrink-0 relative" aria-label="Market">
      <button type="button" className={`shrink-0 text-lg leading-none transition-colors ${fav ? "text-amber" : "text-muted hover:text-fg"}`} onClick={toggleFav} aria-pressed={fav} aria-label={fav ? "Unfavourite market" : "Favourite market"} title="Favourite">
        {fav ? "\u2605" : "\u2606"}
      </button>
      {/* picker */}
      <div ref={wrap} className="relative shrink-0" onKeyDown={onKey}>
        <button className="flex items-center gap-2 h-9 pr-2 pl-1 rounded-md hover:bg-panel2 transition-colors" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} title="Choose a market">
          <TokenIcon symbol={market?.symbol} size={28} />
          <span className="text-lg font-semibold text-fg tracking-tight">{market ? `${market.symbol}-USDC` : loading ? "Loading…" : "Select market"}</span>
          <ChevronDown size={16} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} />
        </button>

        {open && (
          <div className="absolute left-0 top-full mt-1 z-40 flex w-[520px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-md border border-line bg-panel shadow-pop" role="listbox" aria-label="Markets">
            <div className="p-2 border-b border-line">
              <input ref={search} className="input h-8" placeholder="Search markets…" value={q} onChange={(e) => (setQ(e.target.value), setCursor(0))} aria-label="Search markets" />
            </div>
            <div className="max-h-[360px] overflow-auto">
              <table className="tbl tbl-fit tbl-dense w-full">
                <thead>
                  <tr>
                    {/* Measured, not guessed: at the popover's 518 px of inner
                        width the five columns need 165/97/81/80/81 px to hold
                        both their header and their widest value ("JITOSOL-USDC"
                        with its star and icon, "81,363.36", "+14.75%", "10×",
                        "Major"). 504 px, so they fit with 14 px to spare.
                        These shares give every column its minimum plus a
                        little. Narrower than that (the popover caps at the
                        viewport) and the headers ellipsise, which is the right
                        way to fail. */}
                    <th className="w-[33%]">Symbol</th>
                    <th className="w-[19%] text-right">Last price</th>
                    <th className="w-[16%] text-right">Session</th>
                    <th className="w-[16%] text-right">Max lev</th>
                    <th className="w-[16%]">Cluster</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i}>
                        <td colSpan={5} className="py-1.5">
                          <Skeleton className="h-3" />
                        </td>
                      </tr>
                    ))
                  ) : rows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="text-center text-muted py-4">
                        No markets match “{q}”
                      </td>
                    </tr>
                  ) : (
                    rows.map((m, i) => {
                      const t = snap.prices[m.marketId];
                      const c0 = priceStore.getCandles(m.marketId)[0]?.open;
                      const ch = t && c0 ? t.price / c0 - 1 : 0;
                      const isSel = m.marketId === selected;
                      return (
                        <tr
                          key={m.marketId}
                          role="option"
                          aria-selected={isSel}
                          /* Confidence lost its column but not its meaning. It
                             decides nothing at pick time, and the headline
                             strip shows it for the market you land on. */
                          title={t ? `Oracle confidence ±${((t.conf / t.price) * 10000).toFixed(1)} bps` : undefined}
                          className={`cursor-pointer ${i === cursor ? "bg-panel2" : ""} ${!m.enabled ? "opacity-50" : ""}`}
                          onMouseEnter={() => setCursor(i)}
                          onClick={() => pick(m.marketId)}
                        >
                          <td className={`font-medium ${isSel ? "text-accent" : ""}`}>
                            <span className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                className={`inline-flex items-center justify-center w-5 h-5 rounded hover:bg-panel3 ${favSet.has(m.marketId) ? "text-amber" : "text-muted/60"}`}
                                title={favSet.has(m.marketId) ? "Remove from favourites (ticker bar)" : "Add to favourites. Pins to the ticker bar"}
                                aria-label={`${favSet.has(m.marketId) ? "Unfavourite" : "Favourite"} ${m.symbol}`}
                                aria-pressed={favSet.has(m.marketId)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleFavFor(m.marketId);
                                }}
                              >
                                <Star size={12} fill={favSet.has(m.marketId) ? "currentColor" : "none"} aria-hidden />
                              </button>
                              <TokenIcon symbol={m.symbol} size={20} />
                              {m.symbol}-USDC{!m.enabled && <span className="pill pill-down h-4">off</span>}
                            </span>
                          </td>
                          <td className="num text-right">{t ? fmtPrice(t.price) : "—"}</td>
                          <td className={`num text-right ${ch > 0 ? "text-up" : ch < 0 ? "text-down" : "text-muted"}`}>{t && c0 ? pct(ch, 2, true) : "—"}</td>
                          <td
                            className="num text-right"
                            title={
                              platformLevBps && platformLevBps < m.maxLeverageBps
                                ? `${(platformLevBps / 10000).toFixed(0)}×. The platform's gross cap binds before this market's own ${(m.maxLeverageBps / 10000).toFixed(0)}× single-position cap`
                                : `${(m.maxLeverageBps / 10000).toFixed(0)}× single-position cap on this market${platformLevBps ? ` · platform gross cap ${(platformLevBps / 10000).toFixed(0)}×` : ""}`
                            }
                          >
                            {(effLev(m.maxLeverageBps) / 10000).toFixed(0)}×
                          </td>
                          <td className="text-muted">{clusterName(m.cluster)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-2 py-1 border-t border-line text-xxs text-muted">
              {markets.length} markets · ↑↓ to move, Enter to select, Esc to close
            </div>
          </div>
        )}
      </div>
      {/* bulk.trade-style headline price */}
      {market && (
        <div className="shrink-0 flex flex-col justify-center leading-tight min-w-[90px]" aria-label="Last price">
          <span
            className={`num text-xl font-semibold price-eased ${
              tickDir === "up" ? "text-up" : tickDir === "down" ? "text-down" : chg > 0 ? "text-up" : chg < 0 ? "text-down" : "text-amber"
            }`}
          >
            {tick ? fmtPrice(tick.price) : "—"}
          </span>
          <span className={`num text-xxs ${chg > 0 ? "text-up" : chg < 0 ? "text-down" : "text-muted"}`}>
            {first && tick ? `${tick.price - first.open >= 0 ? "+" : ""}${fmtPrice(tick.price - first.open)} ${pct(chg, 2, true)}` : "\u00a0"}
          </span>
        </div>
      )}
      {market && (
        <span className="pill shrink-0 h-5 px-1.5 text-xxs" title={`${venue} · max leverage ${(effLev(market.maxLeverageBps) / 10000).toFixed(0)}× on ${market.symbol}`}>
          Perp
        </span>
      )}

      {/* stats */}
      <div className="flex items-center min-w-0 overflow-x-auto ml-2">
        {/* Four stats, not seven. "Last Price" repeated the headline price two
            centimetres to its left; "Funding/Countdown" was a permanent "—" on
            a venue that has no funding, and comes back with Drift; High and Low
            are one reading, not two. Each removal buys ~90 px, which is why the
            labels used to clip into each other. */}
        <Stat label="Oracle" value={mark ? fmtPrice(mark) : tick ? fmtPrice(tick.price) : "—"} cls={stale ? "text-muted" : ""} hint={tick ? `On-chain oracle mark (NAV basis) · confidence ±${((tick.conf / tick.price) * 10000).toFixed(1)} bps · feed ${feed.text}, updated ${ago(tick.ts)} ago` : "On-chain oracle price"} loading={!tick && loading} />
        <Stat label="24h Volume" value={vol24 === null ? "—" : usdCompact(vol24)} hint="Binance spot quote volume over the last 24h. The venue backing chart history (display-only)" loading={vol24 === null && !!market} />
        <Stat label="Open Interest" value={oiUsd === null ? "—" : usdCompact(oiUsd)} hint="Total open position notional across every pool on this market" loading={oiUsd === null && !!market} />
        <Stat
          label="24h High / Low"
          value={
            hi && lo ? (
              <>
                {fmtPrice(hi)} <span className="text-muted">/</span> {fmtPrice(lo)}
              </>
            ) : (
              "—"
            )
          }
          hint="Highest and lowest 1m candle in the last 24 hours"
        />
      </div>
    </div>
  );
}
