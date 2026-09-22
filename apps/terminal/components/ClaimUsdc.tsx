"use client";
/**
 * "Claim USDC" (design reference: the Account panel's claim button): one
 * instant-funding seat's worth of test USDC per claim, once per cooldown
 * window, both enforced by the indexer. The size is read from `/faucet/status`
 * rather than written here, so the button never advertises a figure the faucet
 * would not actually pay. The compact form is a single button; `history` adds
 * the design's Account-History-style rows (Completed / Failed · reason).
 */
import { useCallback, useEffect, useState } from "react";
import { useToast } from "@kydo/ui";
import { indexer } from "@/lib/api";
import { ago, countdown, time, usd as fmtUsd } from "@/lib/format";
import { usePlatform } from "@/lib/platform";

export function ClaimUsdc({ history = false, className = "", variant = "primary" }: { history?: boolean; className?: string; variant?: "primary" | "ghost" }) {
  const { wallet, indexerOnline } = usePlatform();
  const toast = useToast();
  const [st, setSt] = useState<Awaited<ReturnType<typeof indexer.faucetStatus>> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!wallet) return setSt(null);
    indexer
      .faucetStatus(wallet.toBase58())
      .then(setSt)
      .catch(() => setSt(null));
  }, [wallet]);
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (!wallet || (!st && !indexerOnline)) return null;

  const cooling = st ? !st.canClaim : false;
  const claim = async () => {
    if (!wallet || busy) return;
    setBusy(true);
    try {
      const r = await indexer.faucetClaim(wallet.toBase58());
      toast.push({ kind: "success", title: `Claimed ${fmtUsd(r.usd)} test USDC`, detail: `${r.sol > 0 ? `+${r.sol} SOL · ` : ""}next claim in ${st?.cooldownHours ?? 72}h.${r.note ? ` ${r.note}` : ""}` });
      window.dispatchEvent(new CustomEvent("kydo:funded"));
    } catch (e) {
      toast.push({ kind: "error", title: "Claim failed", detail: (e as Error).message });
    } finally {
      setBusy(false);
      load();
    }
  };

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <button
        type="button"
        className={variant === "ghost" ? "btn btn-ell h-8 text-xs" : "btn btn-ell btn-primary h-9 font-semibold"}
        disabled={busy || cooling || !st}
        onClick={() => void claim()}
        title={cooling && st ? `Once per ${st.cooldownHours}h. Next claim in ${countdown(st.nextAt)}` : st ? `${fmtUsd(st.claimUsd)} test USDC to your wallet (devnet)` : "Faucet unavailable"}
      >
        <span>{busy ? "Claiming…" : cooling && st ? `Claim USDC · ${countdown(st.nextAt)}` : "Claim USDC"}</span>
      </button>
      {history && st && st.history.length > 0 && (
        <div className="kv-list flex flex-col text-xxs" aria-label="Claim history">
          {st.history.map((h, i) => (
            <div key={i} className="kv">
              <span className="num text-muted" title={time(h.ts)}>
                {ago(h.ts)} ago
              </span>
              <span>
                {fmtUsd(h.usd)}{" "}
                {h.ok ? (
                  <span className="text-up">Completed</span>
                ) : (
                  <span className="text-down" title={h.error}>
                    Failed{h.error ? `. ${h.error}` : ""}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
