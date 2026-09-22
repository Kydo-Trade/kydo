"use client";
/** Every pool from the indexer (`/pools`), refreshed on WS lock / trade events. */
import { useCallback, useEffect, useState } from "react";
import { EmptyState, Skeleton } from "@kydo/ui";
import { indexer, type PoolSummary, type Status } from "@/lib/api";
import { HEALTH_POLL_MS } from "@/lib/config";
import { explainError } from "@/lib/errors";
import { ago, pct, usd } from "@/lib/format";
import { usePlatform } from "@/lib/platform";
import { useFeedMessage } from "@/lib/ws";
import { PoolLink, Section, TraderLink } from "./common";

const STATUS_PILL: Record<Status, string> = { funding: "pill-amber", live: "pill-up", locked: "pill-down", settled: "" };

export function PoolsPanel() {
  const { indexerOnline } = usePlatform();
  const [pools, setPools] = useState<PoolSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | "">("");

  const load = useCallback(async () => {
    try {
      const r = await indexer.pools({ status: status || undefined, sort: "tvl", order: "desc", limit: 200 });
      setPools(r.pools);
      setTotal(r.total);
      setErr(null);
    } catch (e) {
      setErr(explainError(e).message);
    }
  }, [status]);

  useEffect(() => {
    void load();
    const t = setInterval(load, HEALTH_POLL_MS);
    return () => clearInterval(t);
  }, [load]);
  useFeedMessage("lock", () => void load(), [load]);
  useFeedMessage("trade", () => void load(), [load]);

  const counts = (pools ?? []).reduce<Record<string, number>>((m, p) => ({ ...m, [p.status]: (m[p.status] ?? 0) + 1 }), {});

  return (
    <Section
      title="Pools"
      right={
        <>
          <span className="num">
            {total} total{status ? "" : ` · ${["funding", "live", "locked", "settled"].map((s) => `${counts[s] ?? 0} ${s}`).join(" · ")}`}
          </span>
          <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value as Status | "")} aria-label="Filter by status">
            <option value="">all</option>
            <option value="funding">funding</option>
            <option value="live">live</option>
            <option value="locked">locked</option>
            <option value="settled">settled</option>
          </select>
          <button className="btn btn-sm btn-ghost" onClick={load} title="Reload pools">
            refresh
          </button>
        </>
      }
      bodyClassName="p-0"
    >
      {pools === null && !err ? (
        <div className="p-2" aria-busy="true">
          <Skeleton lines={4} />
        </div>
      ) : err && !pools ? (
        <EmptyState
          icon="⚠"
          title={indexerOnline ? "Pools unavailable" : "Indexer offline"}
          action={
            <button className="btn btn-sm" onClick={load}>
              Retry
            </button>
          }
        >
          {err}
        </EmptyState>
      ) : pools && pools.length === 0 ? (
        <EmptyState icon="◫" title={status ? `No ${status} pools` : "No pools yet"}>
          Pools appear once an eligible trader creates one.
        </EmptyState>
      ) : (
        <div className="overflow-auto max-h-[480px]">
          {err && <div className="notice notice-warn m-2">{err}</div>}
          <table className="tbl">
            <thead>
              <tr>
                <th>Pool</th>
                <th>Trader</th>
                <th>Status</th>
                <th>Tier</th>
                <th className="text-right">NAV</th>
                <th className="text-right">NAV/share</th>
                <th className="text-right">Today</th>
                <th className="text-right">DD now / max</th>
                <th className="text-right">Open</th>
                <th className="text-right">Trades</th>
                <th className="text-right">Investors</th>
                <th className="text-right">Escrow</th>
                <th className="text-right">Last mark</th>
              </tr>
            </thead>
            <tbody>
              {(pools ?? []).map((p) => (
                <tr key={p.address}>
                  <td>
                    <PoolLink pool={p.address} label={p.name || `#${p.index}`} />
                    <div className="text-xxs text-muted num" title={p.address}>
                      {p.address.slice(0, 8)}… · {p.mandate}
                    </div>
                  </td>
                  <td>
                    <TraderLink wallet={p.trader} n={6} />
                    <div className="text-xxs text-muted">
                      {p.traderProfile.status}
                      {p.traderProfile.poolsLocked ? ` · ${p.traderProfile.poolsLocked} locked` : ""}
                    </div>
                  </td>
                  <td>
                    <span className={`pill ${STATUS_PILL[p.status] ?? ""}`}>{p.status}</span>
                    {p.lockReason !== "none" && <div className="text-xxs text-muted">{p.lockReason.replace("_", " ")}</div>}
                  </td>
                  <td className="num">
                    T{p.tier} · {usd(p.cap)}
                    <div className="text-xxs text-muted">{p.liveDaysAtTier} live d</div>
                  </td>
                  <td className="num text-right">{usd(p.nav)}</td>
                  <td className="num text-right">{p.navPerShare.toFixed(4)}</td>
                  <td className={`num text-right ${p.dailyPnlPct < 0 ? "text-down" : p.dailyPnlPct > 0 ? "text-up" : ""}`}>{pct(p.dailyPnlPct, 2, true)}</td>
                  <td className={`num text-right ${p.currentDrawdown > 0.05 ? "text-amber" : ""}`}>
                    {pct(p.currentDrawdown, 1)} / {pct(p.maxDrawdown, 1)}
                  </td>
                  <td className="num text-right">{p.openPositions}</td>
                  <td className="num text-right">{p.totalTrades}</td>
                  <td className="num text-right">{p.investorCount}</td>
                  <td className="num text-right">{usd(p.escrowTotal)}</td>
                  <td className="num text-right text-muted">{p.lastMarkTs ? `${ago(p.lastMarkTs)} ago` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
