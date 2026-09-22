"use client";
/**
 * Open Orders: the stop-loss / take-profit triggers this tab is watching.
 * (Limit orders fill or reject immediately inside the oracle band, so they
 * never rest here. TWAP went with the ticket rewrite; `lib/twap.ts` is left
 * unreferenced in case the Pro tab comes back.)
 *
 * This was eight columns, four of which printed the same string on every row.
 * Type "SL / TP", Size "full position", Next "on trigger", Status "armed · this
 * tab". Half a table spent restating what the tab's own title already says, and
 * a constant repeated N times is a footnote, not a column.
 *
 * Worse, it left out the one thing a stop list exists to answer: **how close am
 * I to being taken out.** The distance from the mark to each level was one
 * subtraction away. `positions` was already in props for the symbol lookup.
 */
import { EmptyState } from "@kydo/ui";
import type { Position } from "@/lib/api";
import { price as fmtPrice } from "@/lib/format";
import type { Trigger } from "@/lib/triggers";

/** How far the mark has to travel to hit `level`, as a percentage of the mark. */
function Level({ kind, level, mark }: { kind: "sl" | "tp"; level?: number; mark?: number }) {
  if (!level) return <span className="text-fig-text-700">—</span>;
  const away = mark ? ((level - mark) / mark) * 100 : null;
  // Under 1% away is close enough that it may fire before you finish reading.
  const near = away !== null && Math.abs(away) < 1;
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className={`num truncate text-h10 ${kind === "sl" ? "text-down" : "text-up"}`}>{fmtPrice(level)}</span>
      <span className={`num truncate text-h11 ${near ? "text-amber" : "text-muted"}`}>{away === null ? "mark unknown" : `${away > 0 ? "+" : ""}${away.toFixed(2)}% away`}</span>
    </span>
  );
}

export function OpenOrders({ triggers, clearTrigger, positions }: { triggers: Trigger[]; clearTrigger: (marketId: number) => void; positions: Position[] }) {
  if (!triggers.length) {
    return (
      <EmptyState icon="◷" title="No open orders">
        Armed SL/TP triggers appear here while this tab watches them. Limit orders fill or reject immediately inside the oracle band, so nothing rests on-chain.
      </EmptyState>
    );
  }

  const GRID = "grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-x-3 px-3";

  return (
    <div className="flex flex-col">
      <div className={`${GRID} h-8 border-b border-fig-stroke text-h11 font-medium uppercase tracking-wider text-fig-text-600`}>
        <span>Market</span>
        <span>Stop loss</span>
        <span>Take profit</span>
        <span className="w-[72px]" />
      </div>

      {triggers.map((t) => {
        const pos = positions.find((p) => p.marketId === t.marketId);
        const base = (pos?.symbol ?? `#${t.marketId}`).split("-")[0];
        const long = t.side === "long";
        return (
          <div key={t.marketId} className={`${GRID} border-b border-fig-text-900 py-2.5 last:border-0`}>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-sans text-h10 font-medium text-fg">{base}</span>
                <span className={`pill h-[18px] shrink-0 px-1.5 text-[10px] uppercase ${long ? "border-up/40 text-up" : "border-down/40 text-down"}`}>{t.side}</span>
              </span>
              <span className="num truncate text-h11 text-muted">{pos ? `mark ${fmtPrice(pos.markPrice)}` : "position closed"}</span>
            </span>
            <Level kind="sl" level={t.stopLoss} mark={pos?.markPrice} />
            <Level kind="tp" level={t.takeProfit} mark={pos?.markPrice} />
            <span className="flex w-[72px] shrink-0 justify-end">
              <button className="btn btn-sm" onClick={() => clearTrigger(t.marketId)} title={`Disarm the ${base} trigger`}>
                Cancel
              </button>
            </span>
          </div>
        );
      })}

      {/* Said once, at the bottom, instead of as a pill on every row. It is a
          property of the whole feature, not of any one trigger. */}
      <p className="px-3 py-2.5 text-h11 leading-double text-muted">
        These close the <span className="text-fg">whole</span> position at market, and are watched by this browser tab. Not by the chain. They do not fire if you close the tab or go offline.
      </p>
    </div>
  );
}
