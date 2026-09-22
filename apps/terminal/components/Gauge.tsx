"use client";
import type { ReactNode } from "react";

export interface GaugeProps {
  label: ReactNode;
  /** "used / limit" text, already formatted. */
  value: ReactNode;
  /** 0..1+. Fraction of the limit used (kind="limit") or of the goal reached (kind="goal"). */
  ratio: number;
  /**
   * limit: amber ≥ 75 %, red at breach (risk rules).
   * goal:  accent while progressing, green once reached (trial criteria, funding).
   */
  kind?: "limit" | "goal";
  warnAt?: number;
  /** One-sentence explanation shown as a tooltip. */
  hint?: string;
  className?: string;
}

export function gaugeTone(ratio: number, kind: "limit" | "goal" = "limit", warnAt = 0.75): "ok" | "warn" | "bad" | "progress" {
  if (kind === "goal") return ratio >= 1 ? "ok" : "progress";
  return ratio >= 1 ? "bad" : ratio >= warnAt ? "warn" : "ok";
}

const FILL: Record<ReturnType<typeof gaugeTone>, string> = { ok: "bg-up", warn: "bg-amber", bad: "bg-down", progress: "bg-accent" };
const TEXT: Record<ReturnType<typeof gaugeTone>, string> = { ok: "text-fg", warn: "text-amber", bad: "text-down", progress: "text-fg" };

/** Compact labelled bar: label · value on one line, fill below. Colour follows utilisation. */
export function Gauge({ label, value, ratio, kind = "limit", warnAt = 0.75, hint, className = "" }: GaugeProps) {
  const r = Number.isFinite(ratio) ? Math.max(0, ratio) : 0;
  const tone = gaugeTone(r, kind, warnAt);
  return (
    <div className={`gauge ${className}`} title={hint} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(100, r * 100))}>
      <div className="gauge__head">
        <span className="gauge__label">{label}</span>
        <span className={`gauge__val ${TEXT[tone]}`}>{value}</span>
      </div>
      <div className="gauge__track">
        <div className={`gauge__fill ${FILL[tone]}`} style={{ width: `${Math.min(100, r * 100)}%` }} />
      </div>
    </div>
  );
}

/** ✓ / ✗ row for a pass criterion; optional bar underneath. */
export function Check({ ok, label, value, ratio, kind = "goal", hint, pending = false }: { ok: boolean; label: ReactNode; value?: ReactNode; ratio?: number; kind?: "limit" | "goal"; hint?: string; pending?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5" title={hint}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold shrink-0 ${pending ? "bg-line text-muted" : ok ? "bg-up text-ink" : "bg-down/80 text-ink"}`} aria-hidden>
            {pending ? "·" : ok ? "✓" : "✗"}
          </span>
          <span className="sr-only">{pending ? "pending" : ok ? "passing" : "failing"}</span>
          <span className="truncate">{label}</span>
        </span>
        {value !== undefined && <span className={`num whitespace-nowrap ${pending ? "text-muted" : ok ? "text-fg" : "text-down"}`}>{value}</span>}
      </div>
      {ratio !== undefined && (
        <div className="gauge__track !mt-0 ml-[22px]">
          <div className={`gauge__fill ${pending ? "bg-line2" : kind === "goal" ? (ok ? "bg-up" : "bg-accent") : ok ? (ratio >= 0.75 ? "bg-amber" : "bg-up") : "bg-down"}`} style={{ width: `${Math.min(100, Math.max(0, ratio) * 100)}%` }} />
        </div>
      )}
    </div>
  );
}
