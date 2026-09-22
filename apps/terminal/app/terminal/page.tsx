"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, useToast } from "@kydo/ui";
import { Chart } from "@/components/Chart";
import { TickerStrip } from "@/components/TickerStrip";
import { TVChart, useTradingViewLib } from "@/components/TVChart";
import { EquityChart } from "@/components/EquityChart";
import { EscrowPanel } from "@/components/EscrowPanel";
import { MarketStrip } from "@/components/MarketStrip";
import { OrderBook } from "@/components/OrderBook";
import { OrderTicket } from "@/components/OrderTicket";
import { PoolManagement } from "@/components/PoolManagement";
import { RiskHud } from "@/components/RiskHud";
import { PoolCapital } from "@/components/PoolCapital";
import { Balances } from "@/components/Balances";
import { OpenOrders } from "@/components/OpenOrders";
import { Positions } from "@/components/Positions";
import { TradeHistory } from "@/components/TradeHistory";
import { LiveBackend } from "@/lib/backend/live";
import { TrialBackend } from "@/lib/backend/trial";
import type { BackendState, HistoryRow, TradingBackend } from "@/lib/backend/types";
import { fromPrice } from "@/lib/format";
import { traderMode } from "@/lib/mode";
import { usePlatform } from "@/lib/platform";
import { useSigner, useVaultClient } from "@/lib/solana";
import { useTriggers } from "@/lib/triggers";
import { useFeedMessage } from "@/lib/ws";

type Tab = "positions" | "orders" | "history" | "escrow" | "pool";

export default function TerminalPage() {
  const p = usePlatform();
  const { client } = useVaultClient();
  const signer = useSigner();
  const toast = useToast();
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("positions");
  const [chartTab, setChartTab] = useState<"price" | "equity">("price");
  // TradingView Advanced Charts when the user has installed the licensed library (docs/tradingview-charts.md).
  // Must sit with the top hooks: the component has early returns (wallet gate) further down.
  const tvLib = useTradingViewLib();
  const [state, setState] = useState<BackendState | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [limitPrefill, setLimitPrefill] = useState<number | null>(null);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ positions: null, orders: null, history: null, escrow: null, pool: null });

  const markets = p.registry?.markets ?? [];
  useEffect(() => {
    if (selected === null && markets.length) setSelected(markets[0].marketId);
  }, [markets, selected]);
  const market = markets.find((m) => m.marketId === selected) ?? null;

  // ---- mode from on-chain status (section 6.1): Trial → trial engine; active pool → live ----
  const mode = useMemo(() => traderMode(p.status, p.profile), [p.status, p.profile]);

  const backend: TradingBackend | null = useMemo(() => {
    if (mode === "trial" && signer) return new TrialBackend(signer, p.symbols);
    if (mode === "live" && client && p.wallet && p.profile && p.registry && p.config) {
      return new LiveBackend({ client, trader: p.wallet, pool: p.profile.activePool, markets: p.registry.markets, config: p.config, symbols: p.symbols });
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, signer, client, p.wallet, p.profile?.activePool.toBase58(), p.registry, p.config, p.symbols]);

  useEffect(() => {
    if (!backend) {
      setState(null);
      return;
    }
    const unsub = backend.subscribe(setState);
    return () => {
      unsub();
      backend.dispose();
    };
  }, [backend]);

  useFeedMessage(
    "lock",
    (m) => {
      if (state?.poolAddress && m.pool === state.poolAddress) {
        // Sticky: a lock is permanent and the trader has to see it. The risk
        // HUD carries the standing state; this is the moment it happened.
        toast.push({ kind: "error", title: "Pool locked", detail: `${m.reason.replace("_", " ")} at NAV $${m.nav.toFixed(2)}. Trading has stopped and positions unwind.` });
      }
    },
    [state?.poolAddress],
  );

  const positions = state?.positions ?? [];
  const trig = useTriggers(mode, p.wallet?.toBase58() ?? null, backend, positions);
  const bump = () => setHistoryKey((k) => k + 1);

  // Fills feed the trade markers on the price chart and the equity curve; refreshed after every order.
  const [fills, setFills] = useState<HistoryRow[]>([]);
  useEffect(() => {
    if (!backend) {
      setFills([]);
      return;
    }
    let alive = true;
    backend
      .history()
      .then((rows) => alive && setFills(rows))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [backend, historyKey]);
  const marketFills = useMemo(() => (selected === null ? [] : fills.filter((f) => f.marketId === selected)), [fills, selected]);

  const noBackendReason =
    mode === "none"
      ? p.status === "eligible"
        ? "you passed the trial but have no active pool. Trading needs one. Create a pool on Home, then Seed & activate it."
        : `no trial and no live pool for this wallet on ${process.env.NEXT_PUBLIC_NETWORK ?? "this network"}. Go to Home and Apply to start the 30-day trial`
      : mode === "trial" && !signer
        ? "wallet does not support signMessage. Trial orders cannot be signed"
        : !backend
          ? "loading chain state…"
          : null;

  // A backend read that fails leaves every number on screen stale, so it is
  // worth interrupting for. Once per distinct error, not once per poll.
  const lastBackendError = useRef<string | null>(null);
  useEffect(() => {
    const e = state?.error ?? null;
    if (e && e !== lastBackendError.current) toast.push({ kind: "error", title: "Account state is stale", detail: e });
    lastBackendError.current = e;
  }, [state?.error, toast]);

  const loading = !!backend && !state?.ready && !state?.error;
  const escrowCount = state?.pool ? state.pool.escrow.filter((b) => Number(b.amount.toString()) > 0).length : 0;
  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "positions", label: "Positions", count: positions.length },
    { key: "orders", label: "Open Orders", count: trig.triggers.length },
    { key: "history", label: "Trade History", count: state?.totalTrades },
    ...(mode === "live" ? [{ key: "escrow" as Tab, label: "Escrow", count: escrowCount }, { key: "pool" as Tab, label: state?.poolStatus ? `Pool · ${state.poolStatus}` : "Pool" }] : []),
  ];
  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "Home" ? -i : e.key === "End" ? tabs.length - 1 - i : 0;
    if (!dir) return;
    e.preventDefault();
    const next = tabs[(i + dir + tabs.length) % tabs.length].key;
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  if (!p.wallet) {
    return (
      <div className="panel max-w-xl mx-auto mt-8">
        <EmptyState icon="◎" title="Connect a wallet to open the terminal">
          The same terminal serves the simulated trial and your live pool. Connect Phantom or Solflare using the button in the header.
        </EmptyState>
      </div>
    );
  }

  // Chart / Equity-curve tabs live in the chart toolbar's right end (TradingView's Chart · Depth · Margin slot)
  const chartTabs = (
    <div className="flex items-center gap-1" role="tablist" aria-label="Chart panels">
      <button role="tab" aria-selected={chartTab === "price"} className="chart-tab" onClick={() => setChartTab("price")}>
        Chart
      </button>
      <button role="tab" aria-selected={chartTab === "equity"} className="chart-tab" onClick={() => setChartTab("equity")}>
        Equity curve
      </button>
    </div>
  );
  const markPrice = market && state?.raw?.marks?.[market.marketId] ? fromPrice(state.raw.marks[market.marketId]) : undefined;
  // "Starting Balance" in the HUD is the account's funded size: the pool's
  // target when live, the trial engine's configured opening balance otherwise.
  // Both come from config/chain. Neither is a literal.
  const startingBalance =
    state?.mode === "live" && state.pool ? fromPrice(state.pool.targetSize) : p.config ? fromPrice(p.config.trial.startingBalance) : undefined;

  return (
    // The terminal is the one full-bleed screen: a 44 px gutter edge to edge
    // (Figma 121:143654 sits at x=44 in a 1440 frame) rather than the 1312 px
    // `.page` container the other screens share with the nav bar. gap-2 is its
    // 8 px rhythm.
    <div className="flex min-h-full flex-col gap-2 px-4 py-2 md:px-6 xl:h-full xl:px-11">
      {/* The mode strip that used to sit here is gone. Every pill in it had a
          designed home already, and a row of ad-hoc bordered pills above the
          chart is exactly the "messages wedged into the layout" the rest of
          this app was cleaned of:

            LIVE · pool · tier · capital · cap  →  the header's account cluster
                                                   (mode + balance) and the risk
                                                   HUD (equity, starting size)
            wallet cannot sign / no pool        →  `noBackendReason`, which the
                                                   order ticket already renders
                                                   as its blocked notice
            tradableReason                      →  the same ticket blocker
            PLATFORM PAUSED                     →  the header's service dot,
                                                   which already goes red on it
            backend error                       →  a toast, below
            pool LOCKED                         →  a toast, and the risk HUD's
                                                   own locked state
            "updated HH:MM:SS"                  →  dropped; staleness is what
                                                   the service dot is for */}

      {/* ---- Hyperliquid layout: chart | order book | order form, account panel under the form, tabs under chart+book ---- */}
      {/* bulk.trade-style ticker: one-click market switching */}
      <TickerStrip markets={markets} selected={selected} onSelect={setSelected} />
      {/* Side panels are 272 px each per the design (Figma: orderbook 272×593,
          order ticket 272×951, sitting side by side in a 552 px right column).
          Three columns need 1280 px to be worth having. A 390 px chart is not
          a chart. Below xl everything stacks into one scrolling column rather
          than squeezing, which is also what makes the terminal survive a
          tablet. `<main>` owns the scroll.

          Height contract, which four bugs came out of getting wrong:

          1. The ticket column spans both rows and its content (ticket +
             Account + Pool capital) is ~1000 px tall. If either row is
             intrinsically sized. `auto`, or `1fr` in a grid whose own block
             size is indefinite, which degrades to max-content. That column
             sizes the row, the chart grows past the viewport, the book is
             stretched taller than its levels and the tabs fall below the fold.
             So `xl:h-full` on the page makes the grid's height definite; the
             spanning column then contributes to neither row and scrolls inside
             itself.

          2. Definite is not the same as *fitting*. The rows used to be
             `minmax(420px,1fr)` and a hard `240px`: 420 + 8 + 240 = 668 px of
             grid, which needs a 788 px viewport before the header, the 16 px
             of page padding and the ticker are counted. Below that the 1fr
             clamped to its 420 px floor and the grid overflowed its own
             container. The chart ran past the fold and Positions went with
             it. Both rows can now give ground: the tabs row is
             `minmax(148px,228px)`, so it takes its full height whenever there
             is room and yields it before anything overflows. Track sizing
             maximises the non-flexible row first, so the tabs reach 228 px
             before the chart gets any of the remainder, which is what you
             want, since a chart absorbs a hundred spare pixels gracefully and
             a four-row table does not. Floor is now 300 + 8 + 148 = 456 px of
             grid, i.e. a ~576 px viewport. */}
      <div
        className={`grid min-h-0 flex-1 grid-cols-1 gap-2 xl:grid-cols-[minmax(0,1fr)_272px_272px] ${
          tab === "pool" ? "xl:grid-rows-[minmax(300px,1fr)_minmax(220px,440px)]" : "xl:grid-rows-[minmax(300px,1fr)_minmax(148px,228px)]"
        }`}
      >
        <div className="min-w-0 min-h-0 flex flex-col gap-2">
          {/* overview-collapsed (Figma 121:143656). Expands to the full HUD */}
          <RiskHud state={state} risk={p.config?.risk ?? null} loading={!state} startingBalance={startingBalance} />
          <MarketStrip markets={markets} selected={selected} onSelect={setSelected} loading={!p.registry && !p.chainError} venue={mode === "trial" ? "Simulated" : mode === "live" ? "Perps · investor capital" : "Perps"} mark={markPrice} />
          {/* Chart | Equity curve tabs. The chart gets the whole column height */}
          <div className="panel panel-nest flex-1 min-h-0 flex flex-col">
            {chartTab === "price" ? (
              tvLib === "ready" ? (
                <TVChart marketId={selected} symbol={market?.symbol ?? ""} fills={marketFills} position={positions.find((x) => x.marketId === selected) ?? null} mark={markPrice} tabs={chartTabs} />
              ) : (
                <Chart marketId={selected} symbol={market?.symbol ?? ""} fills={marketFills} position={positions.find((x) => x.marketId === selected) ?? null} triggers={trig.triggers} mark={markPrice} tabs={chartTabs} />
              )
            ) : (
              <>
                <div className="flex items-center justify-end h-9 px-2 border-b border-line shrink-0">{chartTabs}</div>
                <div className="flex-1 min-h-0">
                  <EquityChart mode={mode} poolAddress={state?.poolAddress} nav={state?.nav ?? 0} ready={!!state?.ready} indexerOnline={p.indexerOnline} fills={fills} />
                </div>
              </>
            )}
          </div>
        </div>
        <div className="flex min-h-[420px] flex-col xl:min-h-0">
          <OrderBook marketId={selected} symbol={market?.symbol ?? ""} cluster={market?.cluster ?? 0} onPick={(px) => setLimitPrefill(px)} backend={backend} refreshKey={historyKey} />
        </div>
        <div className="flex min-h-0 flex-col gap-2 overflow-visible xl:row-span-2 xl:overflow-auto">
          <OrderTicket state={state} market={market} risk={p.config?.risk ?? null} backend={backend} limitPrefill={limitPrefill} onPlaced={bump} setTrigger={trig.setTrigger} noBackendReason={noBackendReason} />
          {/* design reference: the Account panel (balances + Claim USDC) sits right under the ticket */}
          <section className="panel shrink-0" aria-label="Account balances" data-tour="account">
            <div className="panel-title">
              <span>Account</span>
            </div>
            <Balances state={state} />
          </section>
          {mode === "live" && state?.ready && p.config && <PoolCapital state={state} markets={markets} config={p.config} client={client} wallet={p.wallet} onOpenEscrow={() => setTab("escrow")} />}
        </div>

      {/* ---- bottom tabs (under chart + book) ---- */}
      <div className={`panel flex min-w-0 flex-col xl:col-span-2 xl:h-auto xl:min-h-0 ${tab === "pool" ? "h-[440px]" : "h-[228px]"}`}>
        <div className="panel-title">
          <div className="tabs" role="tablist" aria-label="Account panels">
            {tabs.map((t, i) => (
              <button
                key={t.key}
                ref={(el) => {
                  tabRefs.current[t.key] = el;
                }}
                role="tab"
                id={`tab-${t.key}`}
                aria-selected={tab === t.key}
                aria-controls={`panel-${t.key}`}
                tabIndex={tab === t.key ? 0 : -1}
                className="tab"
                onClick={() => setTab(t.key)}
                onKeyDown={(e) => onTabKey(e, i)}
              >
                {t.label}
                {t.count !== undefined && <span className="count">{t.count}</span>}
              </button>
            ))}
          </div>
          <span className="meta">{mode === "trial" ? "trial engine log · hash-chained, merkle-attested daily" : mode === "live" ? "on-chain TradeFilled events via indexer" : ""}</span>
        </div>
        <div className="overflow-auto flex-1 min-h-0" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === "positions" && (
            <Positions
              positions={positions}
              backend={backend}
              loading={loading}
              onClosed={bump}
              triggers={trig.triggers}
              setTrigger={trig.setTrigger}
              clearTrigger={trig.clearTrigger}
              triggerLog={trig.log}
              minHoldSecs={p.config?.risk.minHoldSecs ?? 60}
              maxPositions={p.config?.risk.maxPositions ?? 5}
              state={state}
              risk={p.config?.risk ?? null}
            />
          )}
          {tab === "orders" && <OpenOrders triggers={trig.triggers} clearTrigger={trig.clearTrigger} positions={positions} />}
          {tab === "history" && <TradeHistory backend={backend} refreshKey={historyKey} indexerOnline={p.indexerOnline} mode={mode} />}
          {tab === "escrow" &&
            mode === "live" &&
            (state && backend instanceof LiveBackend ? (
              <EscrowPanel state={state} backend={backend} usdcMint={p.usdcMint} />
            ) : (
              <EmptyState icon="◌" title="Pool not loaded">
                Escrow buckets appear once the pool account is fetched from the chain.
              </EmptyState>
            ))}
          {tab === "pool" &&
            mode === "live" &&
            (state && backend instanceof LiveBackend && p.config ? (
              <PoolManagement state={state} backend={backend} config={p.config} usdcMint={p.usdcMint} onChanged={() => void p.refreshProfile()} onOpenEscrow={() => setTab("escrow")} />
            ) : (
              <EmptyState icon="◌" title="Pool not loaded">
                Pool controls appear once the pool account is fetched from the chain.
              </EmptyState>
            ))}
        </div>
      </div>
      </div>
    </div>
  );
}
