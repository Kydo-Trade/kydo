"use client";
/** Platform status: pause flag + Pause/Unpause, indexer health (cluster/RPC), keeper liveness (last NavMarked). */
import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { indexer, type HealthJson } from "@/lib/api";
import { HEALTH_POLL_MS, NETWORK } from "@/lib/config";
import { ago, time } from "@/lib/format";
import { useNow, useTx } from "@/lib/hooks";
import { usePlatform } from "@/lib/platform";
import { useRpcUrl, useVaultClient } from "@/lib/solana";
import { useFeedMessage } from "@/lib/ws";
import { Addr, Row, Section } from "./common";

export function StatusPanel() {
  const { config, wallet, indexerOnline, refreshPlatform } = usePlatform();
  const { client } = useVaultClient();
  const rpcUrl = useRpcUrl();
  const now = useNow(1000);
  const pauseAct = useTx();
  const [confirm, setConfirm] = useState<"pause" | "unpause" | null>(null);
  const [health, setHealth] = useState<HealthJson | null>(null);
  const [lastMark, setLastMark] = useState<{ ts: number; pool?: string } | null | undefined>(undefined);

  // indexer health + keeper liveness (latest NavMarked event), then live updates from the WS nav feed
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const [h, e] = await Promise.allSettled([indexer.health(), indexer.events({ type: "NavMarked", limit: 1 })]);
      if (!alive) return;
      setHealth(h.status === "fulfilled" ? h.value : null);
      if (e.status === "fulfilled") {
        const ev = e.value.events[0];
        setLastMark((prev) => (ev ? (!prev || ev.ts >= prev.ts ? { ts: ev.ts, pool: (ev.data as any)?.pool } : prev) : null));
      }
    };
    void tick();
    const t = setInterval(tick, HEALTH_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  useFeedMessage("nav", (m) => setLastMark({ ts: m.ts, pool: m.pool }));

  const paused = config?.paused ?? false;
  const markAge = lastMark ? Math.max(0, Math.floor(now / 1000) - lastMark.ts) : null;
  const keeperCls = markAge === null ? "text-muted" : markAge < 30 ? "text-up" : markAge < 120 ? "text-amber" : "text-down";

  // Oracle freshness, which is NOT the same question as "is the indexer alive".
  // `priceSource` other than `chain` means the keeper is not landing pushes and
  // the indexer is substituting a live feed for display. Charts keep moving
  // while the program sees stale oracles and every trade reverts on OracleStale.
  // That divergence is invisible without this row.
  const oracleWindowSecs = config ? (Number(config.risk.oracleMaxAgeSlots.toString()) * 400) / 1000 : null;
  const priceAge = health?.priceAgeSecs ?? null;
  const priceSource = health?.priceSource;
  const oracleStale = priceAge !== null && oracleWindowSecs !== null && priceAge > oracleWindowSecs;
  const oracleCls = priceAge === null ? "text-muted" : oracleStale ? "text-down" : "text-up";
  const sourceCls = !priceSource || priceSource === "none" ? "text-muted" : priceSource === "chain" ? "text-up" : "text-down";
  const sourceNote =
    priceSource === "chain"
      ? "on-chain oracles are fresh. Trading works"
      : priceSource === "none"
        ? "no prices at all"
        : "the keeper is not landing price pushes; these prices are a display-only substitute and the program still sees stale oracles";

  const run = (which: "pause" | "unpause") =>
    pauseAct
      .run(
        which === "pause" ? "Pausing platform…" : "Unpausing platform…",
        async () => {
          if (!client || !wallet) throw new Error("wallet not ready");
          const sig = await (which === "pause" ? client.pause(wallet) : client.unpause(wallet)).rpc();
          await refreshPlatform();
          return sig;
        },
        (sig) => ({ title: which === "pause" ? "Platform paused" : "Platform unpaused", detail: which === "pause" ? "Trading, deposits, activation, promotion and trial lifecycle are blocked." : "All actions resumed.", sig }),
      )
      .then((r) => r && setConfirm(null));

  return (
    <Section
      title="Status"
      right={
        <span className={`pill ${paused ? "pill-down" : "pill-up"}`}>
          <span className={`dot ${paused ? "bg-down" : "bg-up"}`} aria-hidden />
          {paused ? "PAUSED" : "active"}
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
        <div className="flex flex-col gap-1">
          <div className="label">Chain</div>
          <Row l="Network" v={NETWORK} />
          <Row l="Wallet RPC" v={<span title={rpcUrl}>{rpcUrl}</span>} />
          <Row l="Admin" v={<Addr a={config?.admin.toBase58()} n={6} />} />
          <Row l="Price authority" v={<Addr a={config?.priceAuthority.toBase58()} n={6} />} />
          <Row l="Trial attestor" v={<Addr a={config?.trialAttestor.toBase58()} n={6} />} />
          <Row l="Mock oracles" v={config?.allowMockOracle ? "allowed (devnet)" : "disabled"} cls={config?.allowMockOracle ? "text-amber" : ""} />
        </div>
        <div className="flex flex-col gap-1">
          <div className="label">Indexer · keeper</div>
          <Row l="Indexer" v={indexerOnline ? "online" : "offline"} cls={indexerOnline ? "text-up" : "text-down"} />
          <Row l="Cluster / RPC" v={health ? <span title={health.rpcUrl}>{health.cluster ?? "?"} · {health.rpcUrl ?? "?"}</span> : "—"} />
          <Row l="Snapshot lag" v={health ? `${health.lagMs} ms` : "—"} cls={health && health.lagMs > 2000 ? "text-amber" : ""} />
          <Row l="Last event" v={health?.lastEventTs ? `${ago(health.lastEventTs)} ago` : "—"} />
          <Row
            l="Oracle age"
            v={priceAge === null ? "—" : `${priceAge}s${oracleWindowSecs !== null ? ` / ${oracleWindowSecs}s window` : ""}`}
            cls={oracleCls}
            title={oracleStale ? "Older than oracleMaxAgeSlots. Evaluate_risk and every trade will revert with OracleStale" : "Inside the staleness window"}
          />
          <Row l="Price source" v={priceSource ?? "—"} cls={sourceCls} title={sourceNote} />
          <Row l="WS clients" v={health?.wsClients ?? "—"} />
          <Row
            l="Alert sinks"
            v={health?.alerts ? [health.alerts.webhook && "webhook", health.alerts.slack && "slack"].filter(Boolean).join(" + ") || "none (log only)" : "—"}
            cls={health?.alerts && !health.alerts.webhook && !health.alerts.slack ? "text-amber" : ""}
            title="ALERT_WEBHOOK_URL / ALERT_SLACK_WEBHOOK_URL on the indexer"
          />
          <Row
            l="Keeper (last NavMarked)"
            v={lastMark === undefined ? "—" : lastMark === null ? "no marks yet" : `${ago(lastMark.ts)} ago · ${time(lastMark.ts, false)}`}
            cls={keeperCls}
            title={lastMark?.pool ? `pool ${lastMark.pool}` : "the keeper marks every live pool every ~3 s; no live pools → no marks"}
          />
        </div>
      </div>

      <div className="border-t border-line mt-2 pt-2 flex flex-col gap-2">
        <div className="text-muted leading-relaxed">
          Global pause: blocks trading, deposits, activation, promotion, the trial lifecycle, and every redemption path. <b className="text-fg">Investors cannot exit while paused.</b> Permissionless locks and unwinds keep working. The MVP defence against a confirmed cross-pool hedge.
        </div>
        <div className="flex gap-2 items-center">
          <button className="btn btn-down font-semibold" disabled={paused || !client || pauseAct.busy} onClick={() => setConfirm("pause")} title={paused ? "Already paused" : "Pause every pool (type PAUSE to confirm)"}>
            {pauseAct.busy && confirm === "pause" ? "Pausing…" : "Pause platform"}
          </button>
          <button className="btn btn-up font-semibold" disabled={!paused || !client || pauseAct.busy} onClick={() => setConfirm("unpause")} title={!paused ? "Platform is not paused" : "Resume all activity"}>
            {pauseAct.busy && confirm === "unpause" ? "Unpausing…" : "Unpause"}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirm === "pause"}
        title="Pause the whole platform?"
        tone="danger"
        confirmLabel="Pause"
        typeToConfirm="PAUSE"
        busy={pauseAct.busy}
        error={pauseAct.error}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void run("pause")}
      >
        <p>Every trader is blocked from opening or closing positions until you unpause. Open positions keep marking and can still be locked/unwound by the keeper.</p>
        <ul className="list-disc pl-4 text-muted">
          <li>Investors can still redeem (unwinds still run).</li>
          <li>
            Deposits, pool activation, tier promotion, trial apply/commit/finalize are rejected with <span className="num">Paused</span>.
          </li>
          <li>
            A <span className="num">PlatformPaused</span> event is emitted and delivered to the alert webhooks.
          </li>
        </ul>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "unpause"}
        title="Unpause the platform?"
        tone="primary"
        confirmLabel="Unpause"
        typeToConfirm="UNPAUSE"
        busy={pauseAct.busy}
        error={pauseAct.error}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void run("unpause")}
      >
        <p>Trading and lifecycle actions resume immediately for every pool.</p>
      </ConfirmDialog>
    </Section>
  );
}
