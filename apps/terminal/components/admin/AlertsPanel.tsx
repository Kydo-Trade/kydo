"use client";
/** section 4.6 alerts: cross-pool hedges, pool locks, pause events. From `/alerts`, live-appended from the WS `alert` feed, ack via POST. */
import { useCallback, useEffect, useState } from "react";
import { EmptyState, Skeleton, useToast } from "@kydo/ui";
import { indexer, type Alert } from "@/lib/api";
import { explainError } from "@/lib/errors";
import { time, usd } from "@/lib/format";
import { usePlatform } from "@/lib/platform";
import { useFeedMessage } from "@/lib/ws";
import { PoolLink, Section, TraderLink, sigShort } from "./common";

const LABEL: Record<Alert["type"], { text: string; cls: string }> = {
  cross_pool_hedge: { text: "CROSS-POOL HEDGE", cls: "pill-down" },
  pool_locked: { text: "POOL LOCKED", cls: "pill-amber" },
  platform_paused: { text: "PAUSE", cls: "pill-accent" },
};

export function AlertsPanel() {
  const toast = useToast();
  const { indexerOnline } = usePlatform();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hideAcked, setHideAcked] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await indexer.alerts({ limit: 200 });
      setAlerts(r.alerts);
      setErr(null);
    } catch (e) {
      setErr(explainError(e).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // live: new alerts prepend (dedupe by id), acks from other admin sessions update in place
  useFeedMessage("alert", (m) => {
    setAlerts((prev) => (prev?.some((a) => a.id === m.alert.id) ? prev : [m.alert, ...(prev ?? [])]));
    toast.push({ kind: "error", title: `Alert · ${LABEL[m.alert.type]?.text ?? m.alert.type}`, detail: `#${m.alert.id}. See the Alerts panel`, ttl: 15_000 });
  });
  useFeedMessage("alert_ack", (m) => setAlerts((prev) => prev?.map((a) => (a.id === m.id ? { ...a, acked: true } : a)) ?? prev));

  const ack = async (id: number) => {
    setBusyId(id);
    const tid = toast.push({ kind: "pending", title: `Acknowledging alert #${id}…` });
    try {
      const r = await indexer.ackAlert(id);
      setAlerts((prev) => prev?.map((a) => (a.id === id ? { ...a, ...r.alert, acked: true } : a)) ?? prev);
      setErr(null);
      toast.update(tid, { kind: "success", title: `Alert #${id} acknowledged` });
    } catch (e) {
      toast.update(tid, { kind: "error", title: `Ack #${id} failed`, detail: explainError(e).message });
    } finally {
      setBusyId(null);
    }
  };

  const rows = (alerts ?? []).filter((a) => !hideAcked || !a.acked);
  const open = (alerts ?? []).filter((a) => !a.acked).length;

  return (
    <Section
      title="Alerts"
      right={
        <>
          <span className={`pill ${open ? "pill-down" : ""}`}>{open} unacknowledged</span>
          <label className="flex items-center gap-1 text-muted cursor-pointer h-7">
            <input type="checkbox" checked={hideAcked} onChange={(e) => setHideAcked(e.target.checked)} /> hide acked
          </label>
          <button className="btn btn-sm btn-ghost" onClick={load} title="Reload alerts">
            refresh
          </button>
        </>
      }
      bodyClassName="p-0"
    >
      {alerts === null && !err ? (
        <div className="p-2 flex flex-col gap-2" aria-busy="true">
          <Skeleton lines={3} />
        </div>
      ) : err && !alerts ? (
        <EmptyState
          icon="⚠"
          title={indexerOnline ? "Alerts unavailable" : "Indexer offline"}
          action={
            <button className="btn btn-sm" onClick={load}>
              Retry
            </button>
          }
        >
          {err}
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState icon="✓" title={hideAcked ? "No unacknowledged alerts" : "No alerts yet"}>
          Hedge detection runs on every TradeFilled open; locks and pauses land here too.
        </EmptyState>
      ) : (
        <div className="max-h-[360px] overflow-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Details</th>
                <th className="text-right">Ack</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className={a.acked ? "opacity-50" : ""}>
                  <td className="num text-muted align-top">
                    {time(a.ts)}
                    <div className="text-xxs">#{a.id}</div>
                  </td>
                  <td className="align-top">
                    <span className={`pill ${LABEL[a.type]?.cls ?? ""}`}>{LABEL[a.type]?.text ?? a.type}</span>
                  </td>
                  <td className="!whitespace-normal align-top">
                    <AlertBody a={a} />
                  </td>
                  <td className="text-right align-top">
                    {a.acked ? (
                      <span className="text-xxs text-muted">acked</span>
                    ) : (
                      <button className="btn btn-sm" disabled={busyId === a.id} onClick={() => ack(a.id)} title="Mark as acknowledged for every admin session">
                        {busyId === a.id ? "…" : "ack"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function AlertBody({ a }: { a: Alert }) {
  switch (a.type) {
    case "cross_pool_hedge":
      return (
        <div className="flex flex-col gap-0.5">
          <div>
            <b>{a.symbol}</b> · opposing positions <span className="num">{usd(a.notionalA)}</span> vs <span className="num">{usd(a.notionalB)}</span> opened <span className="num">{a.openedWithinSecs}s</span> apart
          </div>
          <div className="grid grid-cols-2 gap-x-4 text-muted">
            <span>
              pool A <PoolLink pool={a.poolA} n={6} /> · trader <TraderLink wallet={a.traderA} n={6} />
            </span>
            <span>
              pool B <PoolLink pool={a.poolB} n={6} /> · trader <TraderLink wallet={a.traderB} n={6} />
            </span>
          </div>
        </div>
      );
    case "pool_locked":
      return (
        <div className="flex flex-col gap-0.5">
          <div>
            reason <b>{a.reason.replace("_", " ")}</b> · NAV at lock <span className="num">{usd(a.nav)}</span> · escrow returned <span className="num">{usd(a.escrowReturned)}</span>
          </div>
          <div className="text-muted">
            pool <PoolLink pool={a.pool} n={6} /> · trader <TraderLink wallet={a.trader} n={6} /> · tx <span className="num">{sigShort(a.sig)}</span>
          </div>
        </div>
      );
    case "platform_paused":
      return (
        <div>
          platform <b className={a.paused ? "text-down" : "text-up"}>{a.paused ? "PAUSED" : "unpaused"}</b> · tx <span className="num">{sigShort(a.sig)}</span>
        </div>
      );
    default:
      return <pre className="text-xxs text-muted">{JSON.stringify(a)}</pre>;
  }
}
