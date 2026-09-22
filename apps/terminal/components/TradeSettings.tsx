"use client";
/**
 * What sits behind the order ticket's chip row:
 *   Leverage     . An inline panel (LeveragePanel), not a dialog: the design
 *                   expands it in place in the side panel
 *   Margin mode  . Cross (pool NAV is the collateral) or Isolated (a self-imposed
 *                   per-market cap); the dialog carries the allocation input
 *   Account      , which account is trading, its pool, 1-click status, links
 * Settings are per market and remembered in this browser.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useToast } from "@kydo/ui";
import type { BackendState } from "@/lib/backend/types";
import { poolName } from "@/lib/chain";
import { poolRecordUrl } from "@/lib/config";
import { fromPrice, shortAddr, usd } from "@/lib/format";
import { useStoredState } from "@/lib/hooks";
import { usePlatform } from "@/lib/platform";
import { SessionKeyButton } from "./SessionKeyButton";

export type MarginMode = "cross" | "isolated";
export interface MarketTradeSettings {
  marginMode: MarginMode;
  /** isolated mode: max notional (USD) this market may use */
  allocationUsd: number;
  /** target gross leverage used for sizing / margin read-out */
  leverage: number;
}

export function useTradeSettings(marketId: number | null, defaultLeverage: number) {
  const [all, setAll] = useStoredState<Record<string, MarketTradeSettings>>("kydo.tradeSettings", {});
  const key = String(marketId ?? "none");
  const s: MarketTradeSettings = all[key] ?? { marginMode: "cross", allocationUsd: 0, leverage: defaultLeverage };
  const set = (patch: Partial<MarketTradeSettings>) => setAll((prev) => ({ ...prev, [key]: { ...(prev[key] ?? s), ...patch } }));
  return [s, set] as const;
}

/* ------------------------------------------------------------------ shell */
function Modal({ open, title, onClose, children, footer, width = 440 }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    setTimeout(() => boxRef.current?.querySelector<HTMLElement>("button, input, [href]")?.focus(), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal__overlay" onMouseDown={onClose} role="presentation">
      <div ref={boxRef} className="modal" style={{ width }} role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div id={titleId} className="modal__title">
            {title}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="text-xs text-fg/90 leading-relaxed flex flex-col gap-3">{children}</div>
        {footer && <div className="flex justify-end gap-2 pt-1">{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ margin mode */
export function MarginModeDialog({ open, onClose, symbol, navUsd, settings, onSave }: { open: boolean; onClose: () => void; symbol: string; navUsd: number; settings: MarketTradeSettings; onSave: (s: Partial<MarketTradeSettings>) => void }) {
  const [mode, setMode] = useState<MarginMode>(settings.marginMode);
  const [alloc, setAlloc] = useState<string>(settings.allocationUsd ? String(settings.allocationUsd) : "");
  useEffect(() => {
    if (open) {
      setMode(settings.marginMode);
      setAlloc(settings.allocationUsd ? String(settings.allocationUsd) : "");
    }
  }, [open, settings.marginMode, settings.allocationUsd]);
  const allocNum = Number(alloc) || 0;
  const ok = mode === "cross" || allocNum > 0;
  const Card = ({ value, title, children }: { value: MarginMode; title: string; children: ReactNode }) => (
    <button type="button" role="radio" aria-checked={mode === value} onClick={() => setMode(value)} className={`rounded-[16px] border p-4 text-left transition-colors ${mode === value ? "border-accent bg-accent/10" : "border-fig-stroke hover:border-fig-text-800"}`}>
      <div className="flex items-center gap-2 font-semibold text-sm">
        <span className={`w-3.5 h-3.5 rounded-full border-2 ${mode === value ? "border-accent bg-accent" : "border-line2"}`} aria-hidden />
        {title}
      </div>
      <div className="text-muted mt-1 leading-relaxed">{children}</div>
    </button>
  );
  return (
    <Modal
      open={open}
      title={`${symbol} margin mode`}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary font-semibold"
          disabled={!ok}
          onClick={() => {
            onSave({ marginMode: mode, allocationUsd: mode === "isolated" ? allocNum : settings.allocationUsd });
            onClose();
          }}
        >
          Confirm
        </button>
      }
    >
      <div className="grid gap-2" role="radiogroup" aria-label="Margin mode">
        <Card value="cross" title="Cross">
          All positions share the pool&apos;s NAV as collateral. The platform limits. Gross leverage, cluster and single-position caps, the daily-loss and drawdown floors. Are measured against the whole pool. If a floor is breached the keeper locks the pool; there is no per-position liquidation.
        </Card>
        <Card value="isolated" title="Isolated">
          Cap how much of the pool this market may use. The ticket refuses any size that would push {symbol}&apos;s open notional above your allocation. A self-imposed limit on top of the on-chain guard. Margin is not actually segregated and nothing is liquidated.
        </Card>
      </div>
      {mode === "isolated" && (
        <div className="flex flex-col gap-1.5">
          <label className="hl-field">
            <span className="hl-field__label">Allocation for {symbol}</span>
            <input value={alloc} onChange={(e) => setAlloc(e.target.value)} inputMode="decimal" placeholder={navUsd ? (navUsd * 0.25).toFixed(0) : "0"} aria-label="Allocation in USD notional" />
            <span className="hl-field__unit">USD</span>
          </label>
          <div className="grid grid-cols-4 gap-1">
            {[0.1, 0.25, 0.5, 1].map((p) => (
              <button key={p} type="button" className="btn btn-sm" disabled={!navUsd} onClick={() => setAlloc((navUsd * p).toFixed(0))} title={navUsd ? usd(navUsd * p) : "NAV unknown"}>
                {p * 100}% NAV
              </button>
            ))}
          </div>
          <div className="text-xxs text-muted">Max open notional in this market. Positions already above it can still be reduced.</div>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------ leverage (inline panel) */
/**
 * The design's "Form Container": leverage expanded *inside* the side panel
 * rather than behind a modal. Margin mode, the value, a slider and Confirm,
 * all in 240 px. The Figma draws "Liquidation at $64,510 (est.)" under the
 * number; this platform has no liquidation (the keeper locks the whole pool on
 * a loss floor instead), so that line renders the two figures that are true
 * here: what the leverage buys, and what actually ends the account.
 *
 * It replaces the modal the ticket used to open. One slider, in the panel.
 */
export function LeveragePanel({
  symbol,
  maxLev,
  platformMaxLev,
  navUsd,
  settings,
  onSave,
  onClose,
}: {
  symbol: string;
  maxLev: number;
  platformMaxLev: number;
  navUsd: number;
  settings: MarketTradeSettings;
  onSave: (s: Partial<MarketTradeSettings>) => void;
  onClose: () => void;
}) {
  const [lev, setLev] = useState(settings.leverage);
  const [mode, setMode] = useState<MarginMode>(settings.marginMode);
  useEffect(() => {
    setLev(Math.min(settings.leverage || 1, maxLev || 1));
    setMode(settings.marginMode);
  }, [settings.leverage, settings.marginMode, maxLev]);
  // Whole-number leverage only: 1x .. market max, no fractional steps.
  const clampLev = (v: number) => Math.max(1, Math.min(maxLev || 1, Math.round(Number.isFinite(v) ? v : 1)));
  const shown = clampLev(lev);
  const pctPos = maxLev > 1 ? Math.min(1, Math.max(0, (shown - 1) / (maxLev - 1))) : 0;
  const capped = settings.marginMode === "isolated" && settings.allocationUsd > 0 ? Math.min(navUsd * shown, settings.allocationUsd) : navUsd * shown;
  return (
    <div className="flex flex-col gap-3 rounded-[20px] border border-fig-stroke bg-fig-bg-700 p-3" aria-label={`Leverage for ${symbol}`}>
      <div className="seg" role="radiogroup" aria-label="Margin mode">
        {(["cross", "isolated"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className={`seg__btn ${mode === m ? "seg__btn--on" : ""}`}
            onClick={() => setMode(m)}
            title={
              m === "cross"
                ? "Cross. Every position shares the pool's NAV as collateral; the platform limits are measured against the whole pool"
                : "Isolated. A self-imposed cap on how much of the pool this market may use. Set the amount in the Isolated dialog."
            }
          >
            {m === "cross" ? "Cross" : "Isolated"}
          </button>
        ))}
      </div>

      <div className="flex flex-col items-center gap-0.5 pt-1">
        <span className="num text-h4 font-semibold leading-none text-fg">{shown}x</span>
        <span className="text-h11 text-fig-text-600">{navUsd > 0 ? <>Buys {usd(capped)} of open notional</> : <>No NAV yet. Leverage applies once funded</>}</span>
        <span className="text-h11 text-fig-text-700">No liquidation · the pool locks on its loss floors</span>
      </div>

      <div className="flex items-center gap-3">
        <div className={`range-wrap flex-1 ${maxLev <= 1 ? "range-wrap--disabled" : ""}`}>
          <div className="range-track" aria-hidden>
            <div className="range-fill" style={{ width: `${pctPos * 100}%` }} />
          </div>
          <div className="range-ticks" aria-hidden>
            {[0, 0.25, 0.5, 0.75, 1].map((t) => (
              <span key={t} className={t <= pctPos + 1e-9 ? "range-tick range-tick--on" : "range-tick"} />
            ))}
          </div>
          <div className="range-thumb" style={{ left: `calc(10px + (100% - 20px) * ${pctPos})` }} aria-hidden />
          <input
            type="range"
            className="range-input"
            min={1}
            max={maxLev || 1}
            step={1}
            value={shown}
            disabled={maxLev <= 1}
            onChange={(e) => setLev(clampLev(Number(e.target.value)))}
            aria-label="Leverage"
            aria-valuetext={`${shown}x`}
          />
        </div>
        {/* same chip as the size slider's % box (Figma 127:155633) */}
        <span className="hl-field h-7 w-[60px] shrink-0 rounded-[4px] border-fg bg-fig-bg-750 px-2 shadow-[inset_0_-1px_6px_0_rgba(0,0,0,0.12),inset_0_2px_4px_0_rgba(0,0,0,0.12)]">
          <input className="w-full" value={String(shown)} onChange={(e) => setLev(clampLev(Number(e.target.value)))} inputMode="numeric" aria-label="Leverage" />
          <span className="hl-field__unit">x</span>
        </span>
      </div>

      <div className="text-h11 leading-double text-fig-text-700">
        Market max <span className="num text-fg">{(maxLev || 1).toFixed(0)}x</span>
        {platformMaxLev < maxLev ? <> · platform cap <span className="num text-fg">{platformMaxLev.toFixed(0)}x</span></> : null}. Open notional ÷ pool NAV. It drives Margin required and the Max size.
      </div>

      <button
        type="button"
        className="btn-cta"
        onClick={() => {
          onSave({ leverage: clampLev(lev), marginMode: mode });
          onClose();
        }}
      >
        Confirm
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- account */
export function AccountDialog({ open, onClose, state, noBackendReason }: { open: boolean; onClose: () => void; state: BackendState | null; noBackendReason?: string | null }) {
  const p = usePlatform();
  const toast = useToast();
  const live = state?.mode === "live";
  const pool = state?.pool ?? null;
  const poolAddr = state?.poolAddress ?? null;
  const copyLink = async () => {
    if (!poolAddr) return;
    const url = poolRecordUrl(poolAddr);
    try {
      await navigator.clipboard.writeText(url);
      toast.push({ kind: "success", title: "Pool link copied", detail: url });
    } catch {
      toast.push({ kind: "info", title: "Pool link", detail: url });
    }
  };
  const modeLabel = !state ? "No trading account" : live ? "Live pool · investor capital" : "Simulated trial";
  return (
    <Modal
      open={open}
      title="Account mode"
      onClose={onClose}
      width={460}
      footer={
        <>
          {poolAddr && (
            <button type="button" className="btn" onClick={copyLink}>
              Copy pool link
            </button>
          )}
          <Link href="/" className="btn" onClick={onClose}>
            Home
          </Link>
          <button type="button" className="btn btn-primary font-semibold" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {/* Hyperliquid's Unified / Separate choice. Here the unified layout is the only one that exists */}
      <div className="grid gap-2" role="radiogroup" aria-label="Account mode">
        <div role="radio" aria-checked="true" className="rounded-[16px] border border-accent bg-accent/10 p-4 text-left">
          <div className="flex items-center gap-2 font-semibold text-sm">
            <span className="w-3.5 h-3.5 rounded-full border-2 border-accent bg-accent" aria-hidden />
            Unified
          </div>
          <div className="text-muted mt-1 leading-relaxed">One balance backs everything you trade: the pool&apos;s NAV when live, the simulated balance during the trial. Every position, fee and escrow accrual settles against that single account.</div>
        </div>
        <div role="radio" aria-checked="false" aria-disabled="true" className="rounded-[16px] border border-fig-stroke p-4 text-left opacity-60" title="Not available on this platform">
          <div className="flex items-center gap-2 font-semibold text-sm">
            <span className="w-3.5 h-3.5 rounded-full border-2 border-line2" aria-hidden />
            Separate spot / perps
            <span className="pill ml-auto">not available</span>
          </div>
          <div className="text-muted mt-1 leading-relaxed">Traders here never hold a spot wallet inside the platform (capital comes from investors and leaves through escrow) so there is no second balance to keep separate.</div>
        </div>
      </div>

      <div className="kv-list flex flex-col">
        <div className="kv">
          <span>Wallet</span>
          <span title={p.wallet?.toBase58()}>{p.wallet ? shortAddr(p.wallet.toBase58(), 6) : "not connected"}</span>
        </div>
        <div className="kv">
          <span>Mode</span>
          <span className={live ? "text-up" : state ? "text-amber" : "text-muted"}>{modeLabel}</span>
        </div>
        <div className="kv">
          <span>Trader status</span>
          <span>
            {p.status}
            {p.profile && p.profile.tier > 0 ? ` · Tier ${p.profile.tier}` : ""}
          </span>
        </div>
        {pool && (
          <>
            <div className="kv">
              <span>Pool</span>
              <span title={poolAddr ?? undefined}>
                {poolName(pool) || `#${pool.index}`} · {poolAddr ? shortAddr(poolAddr, 4) : ""}
              </span>
            </div>
            <div className="kv">
              <span>Pool status</span>
              <span className={state?.poolStatus === "live" ? "text-up" : "text-amber"}>{state?.poolStatus ?? "—"}</span>
            </div>
            <div className="kv">
              <span>Investor capital (NAV)</span>
              <span>{usd(state?.nav)}</span>
            </div>
            <div className="kv">
              <span>Escrow · claimable</span>
              <span>
                {usd(fromPrice(pool.escrowTotal))} · <span className="text-up">{usd(fromPrice(pool.vestedClaimable))}</span>
              </span>
            </div>
          </>
        )}
        {!live && state && (
          <div className="kv">
            <span>Simulated balance</span>
            <span>{usd(state.nav)}</span>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 rounded-[16px] border border-fig-stroke p-3">
        <div>
          <div className="font-semibold">1-click trading</div>
          <div className="text-muted">A session key signs trades locally so the wallet stops prompting for every order. Trade-only; revocable any time.</div>
        </div>
        <SessionKeyButton size="md" />
      </div>
      {!state && (
        <div className="notice notice-info">{noBackendReason ?? "Apply on Home to start the 30-day trial; a live pool follows once the trial passes."}</div>
      )}
    </Modal>
  );
}
