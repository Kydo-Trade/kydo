"use client";
/**
 * Platform parameters: read-only on-chain view, plus "apply config file". Paste
 * config/platform*.jsonc, see the diff vs. chain, apply with `update_risk_params`.
 */
import { useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useTx } from "@/lib/hooks";
import { usePlatform } from "@/lib/platform";
import { diffParams, flattenChainConfig, parsePlatformFile, toChainParams, toUpdateArgs, type ChainParams, type DiffRow } from "@/lib/platformConfig";
import { useVaultClient } from "@/lib/solana";
import { Section } from "./common";

const PLACEHOLDER = `// paste the contents of config/platform.jsonc or config/platform.demo.jsonc
{
  "entryFeeUsd": 500,
  "tiers": { "capsUsd": [5000, 15000, 30000], "vestDays": [14, 30, 30], "promotionDays": 30 },
  "daySecs": 86400,
  "risk": { ... },
  "trial": { ... }
}`;

export function ParamsPanel() {
  const { config, wallet, refreshPlatform } = usePlatform();
  const { client } = useVaultClient();
  const [text, setText] = useState("");
  const [confirm, setConfirm] = useState(false);
  const apply = useTx();

  const parsed = useMemo<{ params: ChainParams; diff: DiffRow[] } | { error: string } | null>(() => {
    if (!text.trim() || !config) return null;
    try {
      const params = toChainParams(parsePlatformFile(text));
      return { params, diff: diffParams(config, params) };
    } catch (e) {
      return { error: (e as Error).message ?? String(e) };
    }
  }, [text, config]);

  const changes = parsed && "diff" in parsed ? parsed.diff.filter((d) => d.changed) : [];
  const chain = useMemo(() => (config ? Object.entries(flattenChainConfig(config)) : []), [config]);

  const doApply = () =>
    apply
      .run(
        `Applying ${changes.length} parameter change${changes.length === 1 ? "" : "s"}…`,
        async () => {
          if (!client || !wallet) throw new Error("wallet not ready");
          if (!parsed || !("params" in parsed)) throw new Error("nothing to apply");
          const sig = await client.updateRiskParams(wallet, toUpdateArgs(parsed.params)).rpc();
          await refreshPlatform();
          return sig;
        },
        (sig) => ({ title: `Applied ${changes.length} change${changes.length === 1 ? "" : "s"}`, detail: "Risk limits apply to the next trade of every live pool; trial criteria to the next finalize.", sig }),
      )
      .then((r) => r && setConfirm(false));

  const daySecs = config?.trial.daySecs ?? 86400;
  const fmtDays = (days: number) => (days * daySecs >= 3600 ? `${((days * daySecs) / 3600).toFixed(1)} h` : `${((days * daySecs) / 60).toFixed(1)} min`);
  const applyTitle = !client ? "Connect the admin wallet" : changes.length === 0 ? "Paste a config file that differs from the chain" : `Write ${changes.length} change${changes.length === 1 ? "" : "s"} on chain (type APPLY to confirm)`;

  return (
    <Section
      title="Parameters"
      right={
        <span className="num">
          day = {daySecs}s · trial 30 d = {fmtDays(30)} · promotion {config?.risk.promotionDays ?? "—"} d
        </span>
      }
    >
      <div className="grid grid-cols-[1fr_1.4fr] gap-3">
        <div className="min-w-0">
          <div className="label mb-1">On chain (PlatformConfig)</div>
          <div className="max-h-[420px] overflow-auto border border-line rounded">
            <table className="tbl tbl-dense">
              <tbody>
                {chain.map(([k, v]) => (
                  <tr key={k}>
                    <td className="text-muted">{k}</td>
                    <td className="num text-right">{v}</td>
                  </tr>
                ))}
                <tr>
                  <td className="text-muted">tierCaps / vestDays (days)</td>
                  <td className="num text-right">{config?.vestDays.slice(0, 3).map(fmtDays).join(" / ") ?? "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="flex flex-col gap-2 min-w-0">
          <div className="label">Apply config file (update_risk_params)</div>
          <textarea className="input h-40 font-mono resize-y" placeholder={PLACEHOLDER} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Platform config JSONC" />
          {parsed && "error" in parsed && <div className="notice notice-bad">{parsed.error}</div>}
          {parsed && "diff" in parsed && (
            <>
              <div className="text-muted">
                {changes.length === 0 ? "file matches on-chain values. Nothing to apply" : `${changes.length} of ${parsed.diff.length} parameters differ`}
                {" · "}attestor / price authority are not touched
              </div>
              {changes.length > 0 && (
                <div className="max-h-56 overflow-auto border border-line rounded">
                  <table className="tbl tbl-dense">
                    <thead>
                      <tr>
                        <th>Parameter</th>
                        <th className="text-right">On chain</th>
                        <th className="text-right">File</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changes.map((d) => (
                        <tr key={d.key}>
                          <td>{d.key}</td>
                          <td className="num text-right text-muted line-through">{d.onChain}</td>
                          <td className="num text-right text-amber">{d.file}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          <div className="flex gap-2 items-center">
            <button className="btn btn-primary" disabled={!client || apply.busy || changes.length === 0} onClick={() => setConfirm(true)} title={applyTitle}>
              {apply.busy ? "Applying…" : `Apply${changes.length ? ` (${changes.length})` : ""}`}
            </button>
            <button className="btn" onClick={() => setText("")} disabled={!text}>
              Clear
            </button>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        title={`Apply ${changes.length} parameter change${changes.length === 1 ? "" : "s"} on chain?`}
        tone="danger"
        confirmLabel="Apply"
        typeToConfirm="APPLY"
        busy={apply.busy}
        error={apply.error}
        onCancel={() => setConfirm(false)}
        onConfirm={doApply}
      >
        <p>
          Every tunable in the file is written in one <span className="num">update_risk_params</span> transaction. Risk limits apply to the next trade of every live pool, the trial criteria to the next finalize, and day length / vesting to future buckets.
        </p>
        <ul className="list-disc pl-4 text-muted max-h-32 overflow-auto">
          {changes.map((d) => (
            <li key={d.key} className="num">
              {d.key}: {d.onChain} → {d.file}
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </Section>
  );
}
