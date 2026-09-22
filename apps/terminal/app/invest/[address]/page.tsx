"use client";
/**
 * Pool detail (section 6.2). A trader's **record**, not a funding page.
 *
 * Investors cannot deposit into one trader: capital goes into the Common Pool,
 * which deploys it in FIFO order (`fund_next_in_queue`), so this page shows
 * what a record page shows. Performance against drawdown, the trader's own
 * first-loss capital, the strategy, the equity curve, open positions and every
 * trade, and offers no deposit.
 *
 * Redeem and settle stay, rendered only when the connected wallet actually
 * holds shares here. That is not a normal investor's position any more, but a
 * wallet that holds one must never be stranded with no way out.
 *
 * On-chain actions go through the wallet; reads come from the indexer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { Pill, Skeleton } from "@kydo/ui";
import { ColorType, createChart, type UTCTimestamp } from "lightweight-charts";
import { indexer, type InvestorPositionJson, type PoolDetail } from "@/lib/api";
import { countdown, pct, shortAddr, time, usd } from "@/lib/format";
import { useTx } from "@/lib/hooks";
import { usePlatform } from "@/lib/platform";
import { useVaultClient } from "@/lib/solana";
import { CHART_ACCENT, CHART_DARK, CHART_FONT_SIZE } from "@/lib/chartTheme";

export default function InvestPoolPage() {
  const { address } = useParams<{ address: string }>();
  const p = usePlatform();
  const { client } = useVaultClient();
  const [pool, setPool] = useState<PoolDetail | null | undefined>(undefined);
  const [mine, setMine] = useState<InvestorPositionJson | null>(null);
  const [redeemPct, setRedeemPct] = useState(100);
  const redeemTx = useTx();
  const settleTx = useTx();

  const load = useCallback(() => {
    indexer
      .pool(address)
      .then((r) => setPool((r as { pool?: PoolDetail }).pool ?? (r as unknown as PoolDetail)))
      .catch(() => setPool(null));
    if (p.wallet)
      indexer
        .investor(p.wallet.toBase58())
        .then((r) => setMine(r.positions.find((x) => x.pool.address === address) ?? null))
        .catch(() => setMine(null));
  }, [address, p.wallet]);
  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const isTrader = !!p.wallet && !!pool && pool.trader === p.wallet.toBase58();

  const onchain = async () => {
    if (!client || !p.usdcMint || !p.registry) throw new Error("chain state not ready");
    const poolPk = new PublicKey(address);
    const acct = await client.pool(poolPk);
    return { poolPk, oracles: client.oracleMetas(p.registry.markets, acct) };
  };

  const doRedeem = () =>
    redeemTx.run(
      "Requesting redemption…",
      async () => {
        if (!client || !p.wallet || !p.usdcMint || !mine) throw new Error("no position");
        const shares = new BN(mine.shares).muln(Math.round(redeemPct)).divn(100);
        if (shares.isZero()) throw new Error("nothing to redeem");
        const { poolPk, oracles } = await onchain();
        const sig = await client.requestRedemption(p.wallet, poolPk, p.usdcMint, shares, oracles).rpc();
        load();
        return sig;
      },
      (sig) => ({
        title: "Redemption requested",
        detail: pool && pool.openPositions > 0 ? "Your pro-rata slice of each open position unwinds first (keeper), then settle." : "No open positions. Settle now to receive USDC.",
        sig,
      }),
    );

  const doSettle = () =>
    settleTx.run(
      "Settling redemption…",
      async () => {
        if (!client || !p.wallet || !p.usdcMint) throw new Error("wallet not ready");
        const { poolPk, oracles } = await onchain();
        const sig = await client.settleRedemption(p.wallet, poolPk, p.usdcMint, oracles).rpc();
        load();
        return sig;
      },
      (sig) => ({ title: "Redemption settled", detail: "USDC paid at post-unwind NAV; shares burned.", sig }),
    );

  const locked = mine ? mine.lockupEndsAt * 1000 > Date.now() : false;
  const pending = mine?.pendingShares && mine.pendingShares !== "0";
  const dd = pool ? Math.max(pool.maxDrawdown, pool.currentDrawdown) : 0;

  // Liquidation health. The indexer has computed this on every pool summary
  // since the liquidation model shipped; until now nothing displayed it, so the
  // people whose capital is actually at risk could not see how close the pool
  // was to being unwound. <= 1 means liquidatable right now.
  const health = pool?.healthFactor ?? null;
  const floors = pool?.liquidationFloors ?? null;
  const binding = floors ? (floors.daily >= floors.drawdown ? "daily loss" : "drawdown") : null;
  const healthTone = health === null ? undefined : health <= 1 ? "down" : health < 1.05 ? "warn" : "up";
  const cushionLeft = pool?.firstLossRemaining ?? null;
  const cushionPosted = pool?.firstLossSeed ?? 0;

  return (
    <div className="page">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Link href="/invest" className="hover:text-fg">← All pools</Link>
      </div>
      {pool === undefined && <Skeleton lines={8} />}
      {pool === null && <div className="notice notice-bad">Pool not found (indexer offline or bad address).</div>}
      {pool && (
        <>
          {/* ---- header ---- */}
          <section className="panel">
            <div className="panel-body p-3 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold text-fg">{pool.name || `Pool #${pool.index}`}</h1>
                <Pill tone={pool.status === "live" ? "good" : pool.status === "funding" ? "info" : "bad"}>{pool.status}{pool.lockReason !== "none" ? ` · ${pool.lockReason}` : ""}</Pill>
                <Pill tone={pool.tier === 0 ? "warn" : undefined}>{pool.tier === 0 ? "Instant · no trial record" : `Tier ${pool.tier}`} · {pool.liveDaysAtTier}d</Pill>
                {isTrader && <Pill tone="warn">your pool</Pill>}
                <span className="num text-xxs text-muted" title={pool.trader}>trader {shortAddr(pool.trader)}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                <Tile l="Performance" v={pct(pool.perf, 2, true)} sub="trading, since funding" tone={pool.perf > 0 ? "up" : pool.perf < 0 ? "down" : undefined} />
                <Tile l="P&L" v={usd(pool.tradingPnl, { sign: true })} sub="realized + unrealized" tone={pool.tradingPnl > 0 ? "up" : pool.tradingPnl < 0 ? "down" : undefined} />
                <Tile l="TVL / cap" v={`${usd(pool.tvl)} / ${usd(pool.cap)}`} />
                <Tile l="NAV / share" v={pool.navPerShare.toFixed(4)} sub={pool.seedCushion > 0.0001 ? `funded at ${pool.fundingNps.toFixed(4)}` : "investor value"} />
                <Tile l="Drawdown" v={pct(-dd, 1)} />
                <Tile
                  l="Liquidation health"
                  v={health === null ? "—" : health.toFixed(3)}
                  sub={health === null ? "not marked yet" : health <= 1 ? "liquidatable now" : `${usd(pool.distanceToLiquidation ?? 0)} to the ${binding} floor`}
                  tone={healthTone}
                />
              </div>
              {cushionPosted > 0 && (
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xxs text-muted">
                  <span>
                    Trader cushion{" "}
                    <span className={`num ${cushionLeft !== null && cushionLeft < cushionPosted ? "text-down" : "text-amber"}`}>
                      {usd(cushionLeft ?? cushionPosted)}
                    </span>{" "}
                    of {usd(cushionPosted)} posted. Spent before your capital is
                  </span>
                  <span>
                    Investors <span className="num text-fg">{pool.investorCount}</span>
                  </span>
                  {floors && (
                    <span>
                      Locks at <span className="num text-fg">{usd(floors.trigger)}</span> NAV ({binding})
                    </span>
                  )}
                </div>
              )}
              {(pool.firstLossSeed ?? 0) > 0 && (
                <p className="text-h11 leading-double text-muted">
                  First-loss cushion{" "}
                  <span className={`num ${(pool.firstLossRemaining ?? 0) < (pool.firstLossSeed ?? 0) ? "text-down" : "text-amber"}`}>
                    {usd(pool.firstLossRemaining ?? 0)}
                  </span>{" "}
                  of {usd(pool.firstLossSeed ?? 0)} posted. The trader forfeited their entry fee into this pool as seed capital. It holds no shares, so it is excluded from NAV/share and from what a redemption pays: the pool's equity is{" "}
                  <span className="num">{usd(pool.nav)}</span> but investor value is{" "}
                  <span className="num">{usd(pool.investorNav ?? pool.nav)}</span>. Losses consume it before investor capital moves at all, and whatever survives is returned to the common pool when the trader's account is closed.
                  {pool.seedCushion > 0.0001 && ` This pool was funded before that split existed, at NAV/share ${pool.fundingNps.toFixed(4)} rather than 1.0000; performance above is measured against that baseline.`}
                </p>
              )}
              {pool.strategy ? (
                <p className="text-xs text-muted leading-relaxed border-l-2 border-line pl-2">{pool.strategy}</p>
              ) : (
                <p className="text-h11 leading-double text-muted">No strategy description posted.</p>
              )}
              <p className="text-h11 leading-double text-muted">
                This is a record, not a funding page. You cannot deposit into one trader —{" "}
                <Link href="/invest" className="text-accent hover:underline">
                  the Common Pool
                </Link>{" "}
                funds every trader in turn, and your claim is on the pool rather than on any one of them.
              </p>
              <p className="text-h11 leading-double text-amber">
                Investors bear 100% of losses and receive 15% of gains (trader 80% · platform 5%). There is no backstop fund. A risk breach locks the pool permanently and unwinds at market.
              </p>
            </div>
          </section>

          {/* The record runs full width unless this wallet holds shares here,
              in which case the redeem panel takes a rail beside it. */}
          <div className={`grid items-start gap-3 ${mine ? "xl:grid-cols-[minmax(0,1fr)_400px]" : ""}`}>
            {/* ---- your position ----
                 Only when there is one. Investors fund the Common Pool, not a
                 trader, so a direct holding here is legacy or the Common Pool's
                 own stake; an empty "no shares yet" panel would imply a deposit
                 button that no longer exists. */}
            {mine && (
              <div className="flex flex-col gap-3 xl:col-start-2">
                <section className="panel" aria-label="Your position">
                  <div className="panel-title">
                    <span>Your position</span>
                    <span className="meta num">{usd(mine.value)}</span>
                  </div>
                  <div className="panel-body flex flex-col gap-2">
                    <div className="kv-list flex flex-col text-xxs">
                      <div className="kv"><span>Value / cost</span><span>{usd(mine.value)} <span className="text-muted">/ {usd(mine.costBasis)}</span></span></div>
                      <div className="kv"><span>PnL</span><span className={mine.pnl >= 0 ? "text-up" : "text-down"}>{usd(mine.pnl, { sign: true })}</span></div>
                      <div className="kv"><span>Lockup</span><span>{locked ? `ends in ${countdown(mine.lockupEndsAt)}` : "over"}</span></div>
                      {mine.lastDepositTs > 0 && <div className="kv"><span>Last deposit</span><span className="text-muted">{time(mine.lastDepositTs)}</span></div>}
                    </div>
                    {pending ? (
                      <button className="btn btn-primary h-9 font-semibold" disabled={settleTx.busy} onClick={doSettle} title="Pays out at post-unwind NAV and burns the shares">
                        {settleTx.busy ? "Settling…" : "Settle pending redemption"}
                      </button>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <input type="range" min={1} max={100} value={redeemPct} onChange={(e) => setRedeemPct(Number(e.target.value))} className="flex-1" aria-label="Redeem percent" />
                          <span className="num text-xs w-10 text-right">{redeemPct}%</span>
                        </div>
                        <button className="btn h-9" disabled={locked || redeemTx.busy} onClick={doRedeem} title={locked ? `Redemption lockup ends in ${countdown(mine.lockupEndsAt)}` : "Request redemption. No path but the global pause can block it"}>
                          {redeemTx.busy ? "Requesting…" : `Redeem ${redeemPct}% of shares`}
                        </button>
                      </>
                    )}
                    <p className="text-h11 leading-double text-muted">
                      Direct shares in a single pool. New capital goes into the Common Pool, so this position can only be redeemed.
                    </p>
                  </div>
                </section>
              </div>
            )}

            {/* main column: the record */}
            <div className="flex flex-col gap-3 min-w-0 xl:col-start-1 xl:row-start-1">
          {/* ---- equity curve (section 6.2) ---- */}
          {pool.equity.length > 1 && (
            <section className="panel" aria-label="Equity curve">
              <div className="panel-title"><span>Equity curve</span><span className="meta num">{pool.equity.length} marks · NAV/share</span></div>
              <EquityMini points={pool.equity} />
            </section>
          )}

          {/* ---- open positions ---- */}
          {pool.positions.length > 0 && (
            <section className="panel" aria-label="Open positions">
              <div className="panel-title"><span>Open positions</span></div>
              <div className="panel-body p-0 overflow-x-auto">
                <table className="tbl w-full">
                  <thead><tr><th>Market</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>uPnL</th></tr></thead>
                  <tbody>
                    {pool.positions.map((x) => (
                      <tr key={x.marketId}>
                        <td className="font-medium">{x.symbol}</td>
                        <td className={x.side === "long" ? "text-up" : "text-down"}>{x.side}</td>
                        <td className="num">{x.baseQty}</td>
                        <td className="num">{usd(x.entryPrice)}</td>
                        <td className="num">{usd(x.markPrice)}</td>
                        <td className={`num ${x.unrealizedPnl >= 0 ? "text-up" : "text-down"}`}>{usd(x.unrealizedPnl, { sign: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ---- recent trades ---- */}
          {pool.trades.length > 0 && (
            <section className="panel" aria-label="Trade history">
              <div className="panel-title"><span>Trade history</span><span className="meta num">{pool.totalTrades} lifetime</span></div>
              <div className="panel-body p-0 overflow-x-auto max-h-[320px] overflow-y-auto">
                <table className="tbl w-full">
                  <thead><tr><th>Time</th><th>Action</th><th>Market</th><th>Qty</th><th>Fill</th><th>Fee</th></tr></thead>
                  <tbody>
                    {pool.trades.map((t) => (
                      <tr key={t.sig}>
                        <td className="num text-muted">{time(t.ts)}</td>
                        <td className={t.isClose ? "text-accent" : t.side === "long" ? "text-up" : "text-down"}>{t.isClose ? "close" : t.side === "long" ? "buy" : "sell"}</td>
                        <td>{t.symbol}</td>
                        <td className="num">{t.baseQty}</td>
                        <td className="num">{usd(t.fillPrice)}</td>
                        <td className="num text-muted">{usd(t.fee)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ---- more metrics ---- */}
          <details className="disclosure panel px-3 py-2">
            <summary>More metrics</summary>
            <div className="kv-list flex flex-col text-xxs pt-1 max-w-md">
              <div className="kv"><span>NAV / share HWM</span><span className="num">{pool.hwmNps.toFixed(4)}</span></div>
              <div className="kv"><span>Peak / day-start NAV</span><span className="num">{usd(pool.peakNav)} / {usd(pool.dayStartNav)}</span></div>
              <div className="kv"><span>Daily PnL</span><span className={pool.dailyPnlPct >= 0 ? "text-up" : "text-down"}>{pct(pool.dailyPnlPct, 2, true)}</span></div>
              <div className="kv"><span>Trader escrow (vesting)</span><span className="num">{usd(pool.escrowTotal)} <span className="text-muted">· {usd(pool.vestedClaimable)} claimable</span></span></div>
              <div className="kv"><span>Realized PnL</span><span className={pool.realizedPnl >= 0 ? "text-up" : "text-down"}>{usd(pool.realizedPnl, { sign: true })}</span></div>
              <div className="kv"><span>Live days at tier</span><span className="num">{pool.liveDaysAtTier}</span></div>
            </div>
          </details>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Compact NAV/share area chart from the indexer's equity marks. */
function EquityMini({ points }: { points: PoolDetail["equity"] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || points.length < 2) return;
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: CHART_DARK.text, fontSize: CHART_FONT_SIZE },
      grid: { vertLines: { color: CHART_DARK.grid }, horzLines: { color: CHART_DARK.grid } },
      rightPriceScale: { borderColor: CHART_DARK.border },
      timeScale: { borderColor: CHART_DARK.border, timeVisible: true, secondsVisible: false },
    });
    const series = chart.addAreaSeries({ lineColor: CHART_ACCENT, topColor: "rgba(183,255,0,0.18)", bottomColor: "rgba(183,255,0,0.02)", lineWidth: 2, priceFormat: { type: "price", precision: 4, minMove: 0.0001 } });
    const seen = new Set<number>();
    const data = points.filter((pt) => (seen.has(pt.ts) ? false : (seen.add(pt.ts), true))).map((pt) => ({ time: pt.ts as UTCTimestamp, value: pt.navPerShare }));
    series.setData(data);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);
  return <div ref={ref} className="h-[180px] w-full" />;
}

/** `warn` exists for the band just above a liquidation trigger: still safe, but
 *  close enough that green would be misleading. */
function Tile({ l, v, sub, tone }: { l: string; v: string; sub?: string; tone?: "up" | "down" | "warn" }) {
  const toneCls = tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-amber" : "text-fg";
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-line bg-panel2 px-2 py-1.5">
      <span className="text-xxs text-muted">{l}</span>
      <span className={`num text-sm font-medium ${toneCls}`}>{v}</span>
      {sub && <span className="text-[10px] text-muted leading-tight">{sub}</span>}
    </div>
  );
}
