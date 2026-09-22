"use client";
import { useEffect, useMemo, useState } from "react";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { BPS, valueForShares, type MarketLike, type VaultClient } from "@kydo/sdk";
import { useToast } from "@kydo/ui";
import { indexer } from "@/lib/api";
import type { BackendState } from "@/lib/backend/types";
import { poolName, riskLike, type ChainConfig } from "@/lib/chain";
import { CHAIN_POLL_MS, poolRecordUrl } from "@/lib/config";
import { fromPrice, pct, usd, usdWhole } from "@/lib/format";
import { ZERO, bnMax0, clusterName, exposure, lockFloors, ratio, utilText } from "@/lib/sizing";
import { Gauge } from "./Gauge";

export interface PoolCapitalProps {
  state: BackendState;
  markets: MarketLike[];
  config: ChainConfig;
  client: VaultClient | null;
  wallet: PublicKey | null;
  /** Switch the bottom panel to the Escrow tab. */
  onOpenEscrow?: () => void;
}

interface InvestorPositionLike {
  shares: BN;
  costBasis: BN;
}

/** Live mode only: whose money this is, how much of it can still be deployed, and the exact dollar limits. */
export function PoolCapital({ state, markets, config, client, wallet, onOpenEscrow }: PoolCapitalProps) {
  const toast = useToast();
  const [investors, setInvestors] = useState<number | null>(null);
  const [stake, setStake] = useState<InvestorPositionLike | null>(null);
  const addr = state.poolAddress;
  const pool = state.pool;
  const risk = config.risk;

  // investor count from the indexer (optional service. Fall back silently)
  useEffect(() => {
    if (!addr) return;
    let alive = true;
    const load = () =>
      indexer
        .pool(addr)
        .then((d) => alive && setInvestors(typeof d.investorCount === "number" ? d.investorCount : null))
        .catch(() => alive && setInvestors(null));
    void load();
    const t = setInterval(load, CHAIN_POLL_MS * 6);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [addr, state.totalTrades]);

  // trader's own InvestorPosition (traders may seed their pool)
  useEffect(() => {
    if (!addr || !client || !wallet) return;
    let alive = true;
    const load = () =>
      client
        .investorPosition(new PublicKey(addr), wallet)
        .then((p: InvestorPositionLike | null) => alive && setStake(p && !new BN(p.shares).isZero() ? { shares: new BN(p.shares), costBasis: new BN(p.costBasis) } : null))
        .catch(() => alive && setStake(null));
    void load();
    const t = setInterval(load, CHAIN_POLL_MS * 2);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [addr, client, wallet]);

  const view = useMemo(() => {
    const nav = state.raw.nav;
    const exp = exposure(state.raw.positions, state.raw.marks);
    // Narrowed to the pool's tier: an instant-funded pool locks at 3% / 8%.
    const r = riskLike(risk, state.pool?.tier ?? 1);
    const grossLimit = nav.muln(risk.maxLeverageBps).divn(BPS);
    const singleLimit = nav.muln(risk.maxSingleBps).divn(BPS);
    const clusterLimit = nav.muln(risk.maxClusterBps).divn(BPS);
    const largest = Object.values(exp.byMarket).reduce((a, b) => (b.gt(a) ? b : a), ZERO);
    const clusters = Array.from(new Set(markets.map((m) => m.cluster))).sort((a, b) => a - b);
    const floors = lockFloors(r, state.raw.dayStartNav, state.raw.peakNav);
    const lossAllowedDay = bnMax0(state.raw.dayStartNav.sub(floors.daily));
    const lossAllowedPeak = bnMax0(state.raw.peakNav.sub(floors.drawdown));
    const lossDay = bnMax0(state.raw.dayStartNav.sub(nav));
    const lossPeak = bnMax0(state.raw.peakNav.sub(nav));
    return {
      nav,
      gross: exp.gross,
      grossLimit,
      available: bnMax0(grossLimit.sub(exp.gross)),
      single: { limit: singleLimit, used: largest },
      clusters: clusters.map((c) => ({ id: c, used: exp.byCluster[c] ?? ZERO, limit: clusterLimit })),
      floors,
      dayDist: nav.sub(floors.daily),
      peakDist: nav.sub(floors.drawdown),
      dayUtil: ratio(lossDay, lossAllowedDay),
      peakUtil: ratio(lossPeak, lossAllowedPeak),
    };
  }, [state.raw, risk, markets]);

  const stakeValue = stake && pool ? valueForShares(stake.shares, new BN(pool.totalShares), view.nav) : null;
  const stakePct = stake && pool && !new BN(pool.totalShares).isZero() ? Number(stake.shares.muln(10_000).div(new BN(pool.totalShares))) / 10_000 : 0;
  const tierCap = pool ? fromPrice(config.tierCaps[Math.max(0, Math.min(2, pool.tier - 1))]) : 0;
  const navUsd = fromPrice(view.nav);
  const deployedRatio = ratio(view.gross, view.grossLimit);

  const copyLink = async () => {
    if (!addr) return;
    const url = poolRecordUrl(addr);
    try {
      await navigator.clipboard.writeText(url);
      toast.push({ kind: "success", title: "Pool link copied", detail: url });
    } catch {
      toast.push({ kind: "info", title: "Pool link", detail: url });
    }
  };

  return (
    <div className="panel flex flex-col" aria-label="Account">
      <div className="panel-body flex flex-col gap-3">
        {/* Hyperliquid's Deposit / Withdraw slot. There is no deposit here: the
            pool is funded by the Common Pool, not by investors picking this
            trader, so the slot carries the public record link and the payout. */}
        <div className="grid grid-cols-2 gap-1.5">
          <button type="button" className="btn btn-primary h-9 font-semibold" onClick={copyLink} title="This pool's public record. Performance, trades and risk, verifiable on-chain">
            Pool link
          </button>
          <button type="button" className="btn h-9" onClick={onOpenEscrow} disabled={!onOpenEscrow} title="Your payout: vest and claim fees in the Escrow tab">
            Escrow · claim
          </button>
        </div>

        <div>
          <div className="text-sm font-semibold mb-1">Account Equity</div>
          <div className="kv-list flex flex-col">
            <div className="kv">
              <span>Investor capital (NAV)</span>
              <span className="text-fg font-medium">{usd(navUsd)}</span>
            </div>
            <div className="kv">
              <span>Deployed notional</span>
              <span className={utilText(deployedRatio)}>{usd(fromPrice(view.gross))}</span>
            </div>
            <div className="kv">
              <span>Available to deploy</span>
              <span>{usd(fromPrice(view.available))}</span>
            </div>
            <div className="kv">
              <span>Your stake</span>
              <span>{stakeValue ? `${usd(fromPrice(stakeValue))} · ${pct(stakePct, 1)}` : "none"}</span>
            </div>
            <div className="kv">
              <span>Investors</span>
              <span>{investors === null ? "—" : investors}</span>
            </div>
            <div className="kv">
              <span>Pool</span>
              <span title={addr}>
                {pool ? poolName(pool) || `#${pool.index}` : "—"} · Tier {pool?.tier ?? "—"} · cap {usdWhole(tierCap)}
              </span>
            </div>
          </div>
        </div>

        <Gauge label="Leverage used" value={`${usdWhole(fromPrice(view.gross))} of ${usdWhole(fromPrice(view.grossLimit))}`} ratio={deployedRatio} hint={`Gross notional vs the ${risk.maxLeverageBps / BPS}× leverage ceiling`} />

        <details className="disclosure">
          <summary>Risk limits &amp; lock floors</summary>
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-2 gap-y-1 text-xxs num pt-2">
            <span className="label">limit</span>
            <span className="label text-right">used / max</span>
            <span className="label text-right">room</span>
            <Row label={`Per position (${risk.maxSingleBps / 100}%)`} used={view.single.used} limit={view.single.limit} room={view.single.limit} hint="largest open" />
            {view.clusters.map((c) => (
              <Row key={c.id} label={`${clusterName(c.id)} cluster (${risk.maxClusterBps / 100}%)`} used={c.used} limit={c.limit} room={bnMax0(c.limit.sub(c.used))} />
            ))}
            <Row label={`Gross (${risk.maxLeverageBps / BPS}×)`} used={view.gross} limit={view.grossLimit} room={view.available} />
            <Count label="Positions" used={state.positions.length} limit={risk.maxPositions} />
            <Count label="Trades today" used={state.tradesToday} limit={risk.maxTradesPerDay} />
            <Floor label={`Daily-loss floor (−${risk.dailyLossBps / 100}%)`} floor={view.floors.daily} dist={view.dayDist} nav={view.nav} util={view.dayUtil} />
            <Floor label={`Drawdown floor (−${risk.maxDrawdownBps / 100}%)`} floor={view.floors.drawdown} dist={view.peakDist} nav={view.nav} util={view.peakUtil} />
          </div>
          <div className="pt-2 text-h11 leading-double text-muted">You trade the pool&apos;s vault and can never withdraw it. 80% of realised gains accrue to your escrow; losses claw it back.</div>
        </details>
      </div>
    </div>
  );
}

function Row({ label, used, limit, room, hint }: { label: string; used: BN; limit: BN; room: BN; hint?: string }) {
  const r = ratio(used, limit);
  return (
    <>
      <span className="text-muted font-sans truncate">{label}</span>
      <span className={`text-right ${utilText(r)}`}>
        {usdWhole(fromPrice(used))}
        {hint ? <span className="text-muted font-sans"> {hint}</span> : null} / {usdWhole(fromPrice(limit))}
      </span>
      <span className={`text-right ${room.isZero() ? "text-down" : "text-fg"}`}>{usdWhole(fromPrice(room))}</span>
    </>
  );
}

function Count({ label, used, limit }: { label: string; used: number; limit: number }) {
  const r = limit ? used / limit : 0;
  return (
    <>
      <span className="text-muted font-sans">{label}</span>
      <span className={`text-right ${utilText(r)}`}>
        {used} / {limit}
      </span>
      <span className={`text-right ${used >= limit ? "text-down" : "text-fg"}`}>{Math.max(0, limit - used)}</span>
    </>
  );
}

function Floor({ label, floor, dist, nav, util }: { label: string; floor: BN; dist: BN; nav: BN; util: number }) {
  const distUsd = fromPrice(dist);
  const distPct = nav.isZero() ? 0 : distUsd / fromPrice(nav);
  return (
    <>
      <span className="text-muted font-sans truncate">{label}</span>
      <span className={`text-right ${utilText(util)}`}>locks at {usdWhole(fromPrice(floor))}</span>
      <span className={`text-right ${utilText(util)}`}>{dist.isNeg() ? "breached" : `${usdWhole(distUsd)} (${pct(distPct, 1)})`}</span>
    </>
  );
}
