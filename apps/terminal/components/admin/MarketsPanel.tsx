"use client";
/** Market registry (chain) with enable / disable toggles (`set_market_enabled`). */
import { useState } from "react";
import type { MarketLike } from "@kydo/sdk";
import { EmptyState, Skeleton } from "@kydo/ui";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useTx } from "@/lib/hooks";
import { usePlatform } from "@/lib/platform";
import { usePrices } from "@/lib/prices";
import { clusterName } from "@/lib/sizing";
import { price as fmtPrice } from "@/lib/format";
import { useVaultClient } from "@/lib/solana";
import { Addr, Section } from "./common";

export function MarketsPanel() {
  const { registry, wallet, refreshPlatform, chainError } = usePlatform();
  const { client } = useVaultClient();
  const { prices } = usePrices();
  const act = useTx();
  const [pending, setPending] = useState<MarketLike | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const toggle = (m: MarketLike) => {
    setBusyId(m.marketId);
    return act
      .run(
        `${m.enabled ? "Disabling" : "Enabling"} ${m.symbol}…`,
        async () => {
          if (!client || !wallet) throw new Error("wallet not ready");
          const sig = await client.setMarketEnabled(wallet, m.marketId, !m.enabled).rpc();
          await refreshPlatform();
          return sig;
        },
        (sig) => ({ title: `${m.symbol} ${m.enabled ? "disabled" : "enabled"}`, detail: m.enabled ? "New positions are rejected; existing ones can still be closed." : "Traders can open positions again.", sig }),
      )
      .then((r) => {
        setBusyId(null);
        if (r) setPending(null);
      });
  };

  const markets = registry?.markets ?? [];
  return (
    <Section title="Markets" right={<span>{markets.length} registered</span>} bodyClassName="p-0">
      {/* section 4.9: the listing criteria must be published in-app, not just applied silently */}
      <div className="px-3 py-2 text-xxs text-muted leading-relaxed border-b border-line">
        <span className="text-fg font-semibold">Listing criteria:</span> markets are admin-curated. A listing needs venue top-of-book depth ≥ $100k, market cap ≥ $1B, a Pyth oracle feed matching the venue&apos;s mark,
        and ≥ 90 days of listing history. 5–8 markets at launch. Disabling a market blocks <em>new</em> positions but never blocks closing an open one.
      </div>
      {!registry && !chainError ? (
        <div className="p-2" aria-busy="true">
          <Skeleton lines={3} />
        </div>
      ) : markets.length === 0 ? (
        <EmptyState icon="◫" title="Registry empty">
          {chainError ?? "No markets registered on this deployment."}
        </EmptyState>
      ) : (
        <div className="overflow-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th>
                <th>Symbol</th>
                <th>Cluster</th>
                <th className="text-right">Max lev</th>
                <th className="text-right">Price</th>
                <th>Oracle</th>
                <th>Venue idx</th>
                <th>Enabled</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => {
                const t = prices[m.marketId];
                return (
                  <tr key={m.marketId} className={m.enabled ? "" : "opacity-60"}>
                    <td className="num text-muted">{m.marketId}</td>
                    <td className="font-semibold">{m.symbol}</td>
                    <td>{clusterName(m.cluster)}</td>
                    <td className="num text-right">{(m.maxLeverageBps / 10_000).toFixed(0)}×</td>
                    <td className="num text-right">{t ? fmtPrice(t.price) : "—"}</td>
                    <td>
                      <Addr a={m.oracle.toBase58()} n={6} />
                    </td>
                    <td className="num">{m.venueMarketIndex}</td>
                    <td>
                      <span className={`pill ${m.enabled ? "pill-up" : "pill-down"}`}>{m.enabled ? "yes" : "no"}</span>
                    </td>
                    <td className="text-right">
                      <button
                        className={`btn btn-sm ${m.enabled ? "btn-outline-down" : "btn-up"}`}
                        disabled={!client || act.busy}
                        title={!client ? "Connect the admin wallet" : m.enabled ? `Disable ${m.symbol} for new positions` : `Enable ${m.symbol}`}
                        onClick={() => (m.enabled ? setPending(m) : void toggle(m))}
                      >
                        {act.busy && busyId === m.marketId ? "…" : m.enabled ? "disable" : "enable"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={!!pending}
        title={`Disable ${pending?.symbol ?? ""}?`}
        tone="danger"
        confirmLabel="Disable market"
        busy={act.busy}
        error={act.error}
        onCancel={() => setPending(null)}
        onConfirm={() => pending && void toggle(pending)}
      >
        <p>
          New positions in {pending?.symbol} are rejected with <span className="num">MarketDisabled</span>. Existing positions can still be closed, marked and unwound. Re-enable at any time.
        </p>
      </ConfirmDialog>
    </Section>
  );
}
