"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { EmptyState, Skeleton, useToast } from "@kydo/ui";
import { verifyChain, verifyProof, hashEntry, merkleRoot, type TrialOrderEntry } from "@kydo/sdk";
import { trial as trialApi, type TrialExport } from "@/lib/api";
import { explainError } from "@/lib/errors";
import { bytesToHex, price as fmtPrice, qty as fmtQty, shortAddr, time, usd } from "@/lib/format";
import { usePlatform } from "@/lib/platform";

interface DayRow {
  day: number;
  entries: number;
  engineRoot: string;
  recomputedRoot: string;
  chainRoot: string | null;
  chainSource: "indexer" | "profile" | null;
  match: boolean | null;
}

export default function TrialExportPage() {
  const p = usePlatform();
  const toast = useToast();
  const [data, setData] = useState<TrialExport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!p.wallet) return;
    setLoading(true);
    setErr(null);
    try {
      setData(await trialApi.export(p.wallet.toBase58()));
    } catch (e) {
      setErr(explainError(e).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [p.wallet]);

  useEffect(() => {
    void load();
  }, [load]);

  const verification = useMemo(() => {
    if (!data) return null;
    const entries = data.entries;
    const chainOk = verifyChain(entries);
    const proofResults = entries.map((e, i) => {
      const proof = data.proofs[i];
      if (!proof) return { ok: false, reason: "missing proof" };
      const dayRoot = data.dayRoots.find((d) => d.day === e.day)?.root;
      const ok = verifyProof(proof, e) && (!dayRoot || proof.root === dayRoot);
      return { ok, reason: ok ? "" : proof.root !== dayRoot ? "proof root ≠ day root" : "proof invalid" };
    });
    // on-chain roots: indexer history (all days) or the profile's latest root
    const chainRoots = new Map<number, { root: string; source: "indexer" | "profile" }>();
    for (const r of p.traderDetail?.profile.trialRoots ?? []) chainRoots.set(r.day, { root: r.root.toLowerCase(), source: "indexer" });
    if (p.profile && p.profile.trialDaysCommitted > 0) {
      const latest = bytesToHex(p.profile.trialRoot);
      const day = p.profile.trialDaysCommitted - 1;
      if (!chainRoots.has(day)) chainRoots.set(day, { root: latest, source: "profile" });
    }
    const days: DayRow[] = data.dayRoots
      .slice()
      .sort((a, b) => a.day - b.day)
      .map((d) => {
        const dayEntries = entries.filter((e) => e.day === d.day);
        const recomputed = merkleRoot(dayEntries).toString("hex");
        const c = chainRoots.get(d.day);
        return {
          day: d.day,
          entries: dayEntries.length,
          engineRoot: d.root.toLowerCase(),
          recomputedRoot: recomputed,
          chainRoot: c?.root ?? null,
          chainSource: c?.source ?? null,
          match: c ? c.root === d.root.toLowerCase() : null,
        };
      });
    const allProofs = proofResults.every((r) => r.ok);
    const allRecomputed = days.every((d) => d.recomputedRoot === d.engineRoot);
    const chainMismatch = days.some((d) => d.match === false);
    return { chainOk, proofResults, days, allProofs, allRecomputed, chainMismatch };
  }, [data, p.traderDetail, p.profile]);

  const download = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify({ ...data, verifiedAt: new Date().toISOString(), verification: verification && { chain: verification.chainOk, proofs: verification.allProofs, days: verification.days } }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trial-${data.wallet}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.push({ kind: "success", title: "Trial log downloaded", detail: `${data.entries.length} entries with merkle proofs. The investor app verifies them client-side.` });
  };

  if (!p.wallet) {
    return (
      <div className="panel max-w-xl mx-auto mt-8">
        <EmptyState icon="◎" title="Connect a wallet to export your trial log">
          The export carries every signed, hash-chained order entry with a merkle proof against its day root.
        </EmptyState>
      </div>
    );
  }
  // Instant funding skips the trial. This wallet has no trial log to export.
  if (p.profile && Number((p.profile.instantCap ?? 0).toString()) > 0) {
    return (
      <div className="panel max-w-xl mx-auto mt-8">
        <EmptyState icon="⚡" title="No trial log. This account used Instant Funding">
          Instant-funded traders skip the evaluation, so there is no hash-chained trial record here. Your live track record is public on your pool page instead.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="panel">
        <div className="panel-title">
          <span>Trial export &amp; verification</span>
          <span className="meta num" title={p.wallet.toBase58()}>
            {shortAddr(p.wallet.toBase58(), 8)}
          </span>
        </div>
        <div className="panel-body flex items-center gap-3">
          <div className="text-muted leading-relaxed">
            Every simulated order is a signed, hash-chained entry; one merkle root per day is committed on-chain. This page recomputes the chain, the proofs and the day roots and compares them with the roots on-chain.
          </div>
          <div className="flex-1" />
          <button className="btn" onClick={load} disabled={loading} title="Fetch the export from the trial engine again">
            {loading ? "Loading…" : "Reload"}
          </button>
          <button className="btn btn-primary" onClick={download} disabled={!data} title={data ? "Download the log with proofs and this verification as JSON" : "Nothing loaded yet"}>
            Download JSON
          </button>
        </div>
      </div>

      {loading && !data && (
        <div className="grid grid-cols-4 gap-2" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="panel p-3 flex flex-col gap-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3" />
            </div>
          ))}
        </div>
      )}

      {err && !data && /no trial account/i.test(err) && p.trialOnline ? (
        <div className="panel">
          <EmptyState
            icon="◎"
            title={p.status === "none" ? "No trial yet" : "No trial log held for this wallet"}
            action={
              p.status === "none" ? (
                <Link href="/" className="btn btn-sm btn-primary">
                  Apply on Home
                </Link>
              ) : (
                <button className="btn btn-sm" onClick={load} disabled={loading}>
                  Retry
                </button>
              )
            }
          >
            {p.status === "none" ? (
              <>Apply on the Home page to start the 30-day simulated trial; every order you place in the terminal appears here with its merkle proof.</>
            ) : (
              <>
                The trial engine has no sandbox log for this wallet. This attempt&apos;s entries were not persisted (the engine was running in-memory when it restarted). The on-chain attestation still stands:{" "}
                <span className="num text-fg">{p.profile?.trialDaysCommitted ?? 0}</span> day roots committed
                {p.profile && p.profile.trialDaysCommitted > 0 && (
                  <>
                    , latest root <span className="num text-fg">{bytesToHex(p.profile.trialRoot).slice(0, 16)}…</span>
                  </>
                )}
                . Trial logs are now stored in Postgres, so new trials survive restarts.
              </>
            )}
          </EmptyState>
        </div>
      ) : err && !data ? (
        <div className="panel">
          <EmptyState
            icon="⚠"
            title={p.trialOnline ? "Export unavailable" : "Trial engine offline"}
            action={
              <button className="btn btn-sm" onClick={load} disabled={loading}>
                Retry
              </button>
            }
          >
            {err}
          </EmptyState>
        </div>
      ) : null}

      {data && verification && (
        <>
          <div className="grid grid-cols-4 gap-2">
            <Check ok={verification.chainOk} label="Hash chain" detail={`${data.entries.length} entries, each prevHash = sha256(previous)`} />
            <Check ok={verification.allProofs} label="Merkle proofs" detail={`${verification.proofResults.filter((r) => r.ok).length} / ${data.entries.length} verify against their day root`} />
            <Check ok={verification.allRecomputed} label="Day roots" detail="recomputed from entries = engine roots" />
            <Check
              ok={!verification.chainMismatch}
              label="On-chain roots"
              detail={
                verification.days.some((d) => d.chainRoot)
                  ? `${verification.days.filter((d) => d.match).length} matched · ${verification.days.filter((d) => d.match === null).length} not yet committed`
                  : p.indexerOnline
                    ? "no roots committed on-chain yet"
                    : "indexer offline. Only the latest root (from the profile) can be compared"
              }
            />
          </div>

          <div className="panel">
            <div className="panel-title">
              <span>Day roots</span>
              <span className="meta num">start {time(data.startTs)}</span>
            </div>
            {verification.days.length === 0 ? (
              <EmptyState icon="◷" title="No days yet">
                Day roots appear once the first simulated day has entries.
              </EmptyState>
            ) : (
              <table className="tbl num">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="text-right">Entries</th>
                    <th>Engine root</th>
                    <th>Recomputed</th>
                    <th>On-chain root</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {verification.days.map((d) => (
                    <tr key={d.day}>
                      <td>{d.day}</td>
                      <td className="text-right">{d.entries}</td>
                      <td className="text-xxs">{d.engineRoot}</td>
                      <td className={`text-xxs ${d.recomputedRoot === d.engineRoot ? "text-up" : "text-down"}`}>{d.recomputedRoot === d.engineRoot ? "= engine" : d.recomputedRoot}</td>
                      <td className="text-xxs">
                        {d.chainRoot ?? <span className="text-muted">not committed</span>}
                        {d.chainSource && <span className="text-muted"> ({d.chainSource})</span>}
                      </td>
                      <td>
                        <span className={`pill ${d.match === true ? "pill-up" : d.match === false ? "pill-down" : ""}`}>{d.match === true ? "match" : d.match === false ? "mismatch" : "pending"}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel max-h-[520px] flex flex-col">
            <div className="panel-title">
              <span>
                Entries <span className="meta num">({data.entries.length})</span>
              </span>
            </div>
            <div className="overflow-auto min-h-0">
              {data.entries.length === 0 ? (
                <EmptyState icon="◷" title="No entries yet">
                  Place an order in the terminal to create the first hash-chained entry.
                </EmptyState>
              ) : (
                <table className="tbl tbl-dense num">
                  <thead>
                    <tr>
                      <th>Seq</th>
                      <th>Day</th>
                      <th>Time</th>
                      <th>Market</th>
                      <th>Side</th>
                      <th>Action</th>
                      <th className="text-right">Qty</th>
                      <th className="text-right">Oracle</th>
                      <th className="text-right">Fill</th>
                      <th className="text-right">Fee</th>
                      <th className="text-right">Realized</th>
                      <th className="text-right">Equity after</th>
                      <th>Leaf</th>
                      <th>Proof</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.entries.map((e: TrialOrderEntry, i) => {
                      const r = verification.proofResults[i];
                      return (
                        <tr key={e.seq}>
                          <td>{e.seq}</td>
                          <td>{e.day}</td>
                          <td className="text-muted">{time(e.ts > 1e12 ? Math.floor(e.ts / 1000) : e.ts)}</td>
                          <td className="font-sans font-medium">{p.symbols[e.marketId] ?? `#${e.marketId}`}</td>
                          <td className={e.side === "long" ? "text-up" : "text-down"}>{e.side}</td>
                          <td className="font-sans">{e.action}</td>
                          <td className="text-right">{fmtQty(Number(e.baseQty))}</td>
                          <td className="text-right">{fmtPrice(Number(e.oraclePrice))}</td>
                          <td className="text-right">{fmtPrice(Number(e.fillPrice))}</td>
                          <td className="text-right">{usd(Number(e.fee))}</td>
                          <td className={`text-right ${Number(e.realizedPnl) < 0 ? "text-down" : Number(e.realizedPnl) > 0 ? "text-up" : ""}`}>{usd(Number(e.realizedPnl), { sign: true })}</td>
                          <td className="text-right">{usd(Number(e.equityAfter))}</td>
                          <td className="text-xxs text-muted" title={hashEntry(e).toString("hex")}>
                            {hashEntry(e).toString("hex").slice(0, 10)}…
                          </td>
                          <td className={r?.ok ? "text-up" : "text-down"}>{r?.ok ? "ok" : r?.reason ?? "?"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className={`panel p-3 ${ok ? "border-up/50" : "border-down/60"}`} role="status">
      <div className={`text-sm font-semibold flex items-center gap-2 ${ok ? "text-up" : "text-down"}`}>
        <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold text-ink ${ok ? "bg-up" : "bg-down"}`} aria-hidden>
          {ok ? "✓" : "✗"}
        </span>
        {label}
      </div>
      <div className="text-xxs text-muted mt-1">{detail}</div>
    </div>
  );
}
