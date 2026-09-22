/**
 * UNUSED since the terminal's mode strip was removed (19 Sep 2026).
 *
 * What it showed (mode, pool, tier, capital, cap) is carried by the header's
 * account cluster and the risk HUD now. Kept because it is a clean component
 * and a future surface may want a single mode chip; delete it if that never
 * happens.
 */
"use client";
import type { Mode } from "@/lib/backend/types";

/**
 * Mode pill. The label is rendered as-is (mode word already uppercase) so dollar
 * figures and pool names keep their case. `size="md"` for page headers.
 */
export function ModeBadge({ mode, label, size = "sm", title }: { mode: Mode | "none"; label: string; size?: "sm" | "md"; title?: string }) {
  const cls =
    mode === "trial"
      ? "bg-amber/10 border-amber/60 text-amber"
      : mode === "live"
        ? "bg-up/10 border-up/60 text-up"
        : "bg-panel2 border-line text-muted";
  const dot = mode === "trial" ? "bg-amber" : mode === "live" ? "bg-up" : "bg-muted";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border font-semibold tracking-wider whitespace-nowrap max-w-full ${size === "md" ? "h-7 px-2.5 text-xs" : "h-6 px-2 text-xxs"} ${cls}`}
      title={title ?? label}
    >
      <span className={`dot ${dot}`} aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}
