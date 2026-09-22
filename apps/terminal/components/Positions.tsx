"use client";
/**
 * Open positions.
 *
 * This was a ten-column table in which nothing outranked anything else.
 * MARKET, SIDE, QTY, ENTRY, MARK, NOTIONAL, UPNL, OPENED, SL/TP, CLOSE, all in
 * the same 14 px mono, plus six always-on controls per row, which for three
 * positions meant eighteen interactive elements, most of them empty inputs that
 * read as an unfinished form. A trader scanning this asks three questions in
 * order: am I up or down, how big is this, how do I get out. The table answered
 * them in the order a database would.
 *
 * What changed:
 *
 *  - **Still a grid, no longer a spreadsheet.** One CSS grid shared by the
 *    header and every row, so prices and sizes still line up column-wise.
 *    That alignment is the one thing a table is genuinely good at and cards
 *    would have thrown it away. Within each cell the fields are ranked: the
 *    market carries its quantity, entry carries mark, notional carries a bar.
 *  - **uPnL is the headline.** 16 px semibold against 14 px for everything
 *    else, because it is the number the row exists to deliver.
 *  - **Size you can see.** A bar under the notional, scaled to the largest
 *    open position, so "which of these is the big one" is a glance and not
 *    three subtractions.
 *  - **Entry → Mark is one cell.** Two columns to show the arithmetic behind a
 *    third column is the reader doing the work.
 *  - **The controls collapse.** Close stays on the row, because that is the
 *    action you came for. Stop-loss, take-profit and partial close move into a
 *    drawer that opens on click. Not hover, which does not exist on touch.
 *    An armed stop still shows on the collapsed row, otherwise hiding the
 *    fields would hide the state.
 *  - **The drawer carries the consequence.** How far this position can move
 *    against you before the account locks: the same thing the order ticket now
 *    says before you open a position, said again while you hold it.
 */
import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { EmptyState, Skeleton, useToast } from "@kydo/ui";
import { ConfirmDialog } from "./ConfirmDialog";
import { TokenIcon } from "./TokenIcon";
import type { Position } from "@/lib/api";
import type { BackendState, TradingBackend } from "@/lib/backend/types";
import type { ChainRisk } from "@/lib/chain";
import { explorerTxUrl } from "@/lib/config";
import { explainError } from "@/lib/errors";
import { ago, price as fmtPrice, qty as fmtQty, time, usd } from "@/lib/format";
import type { Trigger, TriggerEvent } from "@/lib/triggers";

/* One grid for the header and every row. The columns line up without a table.
   `minmax(0,…)` on all four text columns so a long value truncates instead of
   widening the track and knocking the other rows out of alignment. */
const GRID = "grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.25fr)_minmax(0,1.2fr)_minmax(0,1fr)_auto] items-center gap-x-3 px-3";

export function Positions({
  positions,
  backend,
  loading = false,
  onClosed,
  triggers,
  setTrigger,
  clearTrigger,
  triggerLog,
  minHoldSecs,
  maxPositions,
  state = null,
  risk = null,
}: {
  positions: Position[];
  backend: TradingBackend | null;
  loading?: boolean;
  onClosed: () => void;
  triggers: Trigger[];
  setTrigger: (t: Trigger) => void;
  clearTrigger: (marketId: number) => void;
  triggerLog: TriggerEvent[];
  minHoldSecs: number;
  maxPositions: number;
  /** For the drawer's "how far can this move before the account locks" line. */
  state?: BackendState | null;
  risk?: ChainRisk | null;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const [partial, setPartial] = useState<Record<number, string>>({});
  const [editing, setEditing] = useState<Record<number, { sl: string; tp: string }>>({});
  const [open, setOpen] = useState<number | null>(null);
  const live = backend?.mode === "live";

  const close = async (p: Position, qty?: number) => {
    if (!backend) return;
    const part = qty && qty > 0 && qty < p.baseQty ? qty : undefined;
    setBusy(p.marketId);
    const id = toast.push({ kind: "pending", title: `Closing ${part ? `${fmtQty(part)} of ` : ""}${p.symbol} ${p.side}…` });
    try {
      const r = await backend.closeOrder({ marketId: p.marketId, baseQty: part });
      toast.update(id, {
        kind: "success",
        title: `${p.symbol} ${part ? "partially closed" : "closed"}`,
        detail: `${r.fillPrice ? `@ ${fmtPrice(r.fillPrice)}` : "at market"}${r.realizedPnl !== undefined ? ` · realized ${usd(r.realizedPnl, { sign: true })}` : ""}${r.fee ? ` · fee ${usd(r.fee)}` : ""}`,
        link: live && r.sig ? { label: `View ${r.sig.slice(0, 8)}… on Explorer`, href: explorerTxUrl(r.sig) } : undefined,
      });
      if (!part) setPartial((x) => ({ ...x, [p.marketId]: "" }));
      onClosed();
    } catch (e) {
      const ex = explainError(e);
      toast.update(id, { kind: "error", title: `Close ${p.symbol} failed${ex.code ? ` · ${ex.code}` : ""}`, detail: ex.message });
    } finally {
      setBusy(null);
    }
  };

  const [confirmAll, setConfirmAll] = useState(false);
  const closeAll = async () => {
    if (!backend || positions.length === 0) return;
    setConfirmAll(false);
    for (const p of positions) await close(p);
  };

  const now = Date.now() / 1000;
  /* The size bar is relative to the largest position open right now, not to the
     gross limit: the question it answers is "which of these is the big one",
     and scaling to a limit nobody is near would flatten every bar to a stub. */
  const biggest = useMemo(() => Math.max(1, ...positions.map((p) => p.notional)), [positions]);

  /* Distance to whichever floor binds first, in dollars. Same arithmetic the
     order ticket uses before you open. Restated here while you hold. */
  const roomToFloor = useMemo(() => {
    if (!state || !risk) return null;
    const daily = state.dayStartNav * (1 - risk.dailyLossBps / 10_000);
    const drawdown = state.peakNav * (1 - risk.maxDrawdownBps / 10_000);
    const binding = Math.max(daily, drawdown);
    return { usd: Math.max(0, state.nav - binding), which: daily >= drawdown ? "today's loss limit" : "the drawdown floor" };
  }, [state, risk]);

  if (loading && positions.length === 0) {
    return (
      <div className="p-3 flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton lines={3} />
      </div>
    );
  }

  if (positions.length === 0) {
    return (
      <>
        <EmptyState icon="◫" title="No open positions">
          {backend ? `Use the order ticket to open one. Up to ${maxPositions} concurrent positions, ${minHoldSecs}s minimum hold.` : "Open positions appear here once you have a trading account."}
        </EmptyState>
        <TriggerLog log={triggerLog} />
      </>
    );
  }

  return (
    <div>
      {positions.length > 1 && (
        <div className="flex items-center justify-end px-3 h-9">
          <button className="btn btn-sm btn-outline-down" disabled={busy !== null || !backend} onClick={() => setConfirmAll(true)}>
            Close all {positions.length}
          </button>
          <ConfirmDialog open={confirmAll} title={`Close all ${positions.length} open positions?`} tone="danger" confirmLabel="Close all at market" onCancel={() => setConfirmAll(false)} onConfirm={closeAll}>
            <p>Each position is closed with a separate market order (one wallet signature each in live mode). Fees and spread apply; realized PnL goes through the 80/15/5 split (trader / investors / platform).</p>
            <ul className="num text-xxs text-muted list-disc pl-4">
              {positions.map((p) => (
                <li key={p.marketId}>
                  {p.symbol} {p.side} · {fmtQty(p.baseQty)} · uPnL {usd(p.unrealizedPnl, { sign: true })}
                </li>
              ))}
            </ul>
          </ConfirmDialog>
        </div>
      )}

      <div className={`${GRID} h-8 border-y border-fig-stroke text-h11 font-medium uppercase tracking-wider text-fig-text-600`} role="row">
        <span>Position</span>
        <span>Entry → Mark</span>
        <span>Size</span>
        <span className="text-right">Unrealised</span>
        {/* matches the action cluster's width so the header rule runs clean */}
        <span className="w-[118px]" />
      </div>

      {positions.map((p) => {
        const t = triggers.find((x) => x.marketId === p.marketId);
        const e = editing[p.marketId] ?? { sl: t?.stopLoss?.toString() ?? "", tp: t?.takeProfit?.toString() ?? "" };
        const held = now - p.openedAt;
        const canClose = held >= minHoldSecs;
        const holdLeft = Math.ceil(minHoldSecs - held);
        const partQty = Number(partial[p.marketId]) || 0;
        const closeTitle = !backend ? "No trading account" : !canClose ? `Minimum hold ${minHoldSecs}s not elapsed (${holdLeft}s left)` : undefined;
        const long = p.side === "long";
        const tone = p.unrealizedPnl < 0 ? "text-down" : p.unrealizedPnl > 0 ? "text-up" : "text-fg";
        const base = p.symbol.split("-")[0] || p.symbol;
        const expanded = open === p.marketId;
        const movePct = roomToFloor && p.notional > 0 ? (roomToFloor.usd / p.notional) * 100 : null;
        // Loud only when this one position could reach the floor on a move a
        // market can make in an afternoon. Otherwise it is noise on every row.
        const nearFloor = movePct !== null && movePct < 10;

        return (
          <div key={p.marketId} className={`border-b border-fig-text-900 transition-colors last:border-0 ${expanded ? "bg-fig-bg-additional" : "hover:bg-fig-bg-additional/50"}`}>
            <div className={`${GRID} py-2.5`}>
              {/* Cols 1-4 are one control, not a div with a click handler: the
                  row is the expand affordance the user reaches for, and a
                  <button> gets that keyboard and screen-reader behaviour for
                  free. `grid-cols-subgrid` lets it span four tracks while the
                  cells inside still line up with the header and every other
                  row. The alignment is the reason this is a grid at all. */}
              <button
                type="button"
                className="col-span-4 grid grid-cols-subgrid items-center gap-x-3 text-left"
                aria-expanded={expanded}
                aria-controls={`pos-${p.marketId}-detail`}
                onClick={() => setOpen(expanded ? null : p.marketId)}
              >
              {/* identity. The market, what side, how much of it */}
              <span className="flex min-w-0 items-center gap-2.5">
                <TokenIcon symbol={base} size={26} className="shrink-0" />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-sans text-h10 font-medium text-fg">{base}</span>
                    <span className={`pill h-[18px] shrink-0 px-1.5 text-[10px] uppercase ${long ? "border-up/40 text-up" : "border-down/40 text-down"}`}>{p.side}</span>
                    {t && <span className="pill h-[18px] shrink-0 border-amber/40 px-1.5 text-[10px] uppercase text-amber" title={`Armed client-side: ${t.stopLoss ? `SL ${fmtPrice(t.stopLoss)}` : ""}${t.stopLoss && t.takeProfit ? " · " : ""}${t.takeProfit ? `TP ${fmtPrice(t.takeProfit)}` : ""}`}>sl/tp</span>}
                  </span>
                  <span className="num truncate text-h11 text-muted">
                    {fmtQty(p.baseQty)} {base}
                  </span>
                </span>
              </span>

              {/* where it went. One cell, because mark only means something against entry */}
              <span className="flex min-w-0 flex-col gap-1">
                <span className="num truncate text-h10 text-fg">
                  {fmtPrice(p.entryPrice)} <span className="text-fig-text-700">→</span> {fmtPrice(p.markPrice)}
                </span>
                <span className="truncate text-h11 text-muted" title={time(p.openedAt)}>
                  {ago(p.openedAt)} ago
                  {!canClose && <span className="text-amber"> · hold {holdLeft}s</span>}
                </span>
              </span>

              {/* how big, against the biggest thing open */}
              <span className="flex min-w-0 flex-col gap-1.5">
                <span className="num truncate text-h10 text-fg">{usd(p.notional)}</span>
                <span className="block h-1 overflow-hidden rounded-full bg-fig-bg-750">
                  <span className={`block h-full rounded-full ${nearFloor ? "bg-amber" : "bg-fig-text-700"}`} style={{ width: `${Math.max(4, (p.notional / biggest) * 100)}%` }} />
                </span>
              </span>

              {/* the headline */}
              <span className="flex min-w-0 flex-col items-end gap-0.5">
                <span className={`num truncate text-h9 font-semibold ${tone}`}>{usd(p.unrealizedPnl, { sign: true })}</span>
                <span className={`num truncate text-h11 ${tone}`}>{((p.unrealizedPnl / (p.notional || 1)) * 100).toFixed(2)}%</span>
              </span>
              </button>

              <div className="flex w-[118px] shrink-0 items-center justify-end gap-1.5">
                <button className="btn btn-sm" disabled={busy === p.marketId || !backend || !canClose} title={closeTitle ?? `Close the whole ${base} position at market`} onClick={() => close(p)}>
                  {busy === p.marketId ? "Closing…" : "Close"}
                </button>
                <button className="btn btn-sm px-2" tabIndex={-1} aria-hidden onClick={() => setOpen(expanded ? null : p.marketId)}>
                  <ChevronDown size={14} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
                </button>
              </div>
            </div>

            {expanded && (
              <div id={`pos-${p.marketId}-detail`} className="grid gap-2 px-3 pb-3 lg:grid-cols-3">
                <Box label="Stop loss / take profit">
                  <div className="flex items-center gap-1.5">
                    <input className="input min-w-0 flex-1" placeholder="SL" aria-label={`${base} stop-loss`} value={e.sl} onChange={(ev) => setEditing({ ...editing, [p.marketId]: { ...e, sl: ev.target.value } })} />
                    <input className="input min-w-0 flex-1" placeholder="TP" aria-label={`${base} take-profit`} value={e.tp} onChange={(ev) => setEditing({ ...editing, [p.marketId]: { ...e, tp: ev.target.value } })} />
                    <button
                      className="btn btn-sm shrink-0"
                      onClick={() => {
                        const sl = Number(e.sl) || undefined;
                        const tp = Number(e.tp) || undefined;
                        if (!sl && !tp) {
                          clearTrigger(p.marketId);
                          toast.push({ kind: "info", title: `${base} SL/TP cleared` });
                        } else {
                          setTrigger({ marketId: p.marketId, side: p.side, stopLoss: sl, takeProfit: tp });
                          toast.push({ kind: "success", title: `${base} SL/TP armed`, detail: `${sl ? `SL ${fmtPrice(sl)}` : ""}${sl && tp ? " · " : ""}${tp ? `TP ${fmtPrice(tp)}` : ""}. Watched by this tab` });
                        }
                      }}
                    >
                      {t ? "Update" : "Arm"}
                    </button>
                  </div>
                  <p className="text-h11 leading-double text-muted">Watched by this browser tab, not by the chain. It fires only while the terminal is open. Clear both and arm to disarm.</p>
                </Box>

                <Box label="Close part of it">
                  <div className="flex items-center gap-1.5">
                    <input className="input min-w-0 flex-1" placeholder={fmtQty(p.baseQty)} aria-label={`${base} quantity to close`} value={partial[p.marketId] ?? ""} onChange={(ev) => setPartial({ ...partial, [p.marketId]: ev.target.value })} />
                    <button className="btn btn-sm shrink-0" disabled={busy === p.marketId || !backend || !canClose || !(partQty > 0)} title={closeTitle ?? (!(partQty > 0) ? "Enter a quantity, or pick a fraction" : `Close ${fmtQty(partQty)} ${base} at market`)} onClick={() => close(p, partQty)}>
                      Close part
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {[0.25, 0.5, 0.75].map((f) => (
                      <button key={f} type="button" className="btn btn-sm flex-1" onClick={() => setPartial({ ...partial, [p.marketId]: fmtQty(p.baseQty * f) })}>
                        {f * 100}%
                      </button>
                    ))}
                  </div>
                </Box>

                <Box label="Room before the account locks">
                  {roomToFloor && movePct !== null ? (
                    <>
                      <span className={`num text-h8 font-semibold ${nearFloor ? "text-amber" : "text-fg"}`}>{usd(roomToFloor.usd)}</span>
                      <p className="text-h11 leading-double text-muted">
                        This position reaches {roomToFloor.which} on a <span className={`num ${nearFloor ? "text-amber" : "text-fg"}`}>{movePct.toFixed(1)}%</span> move against you. A breach locks the account permanently.
                      </p>
                    </>
                  ) : (
                    <p className="text-h11 leading-double text-muted">Account state not loaded. The distance to the lock floors is unavailable.</p>
                  )}
                </Box>
              </div>
            )}
          </div>
        );
      })}
      <TriggerLog log={triggerLog} />
    </div>
  );
}

/** One inset group inside an expanded row. */
function Box({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-fig-stroke bg-fig-bg-900 p-3">
      <span className="text-h11 font-medium uppercase tracking-wider text-fig-text-600">{label}</span>
      {children}
    </div>
  );
}

function TriggerLog({ log }: { log: TriggerEvent[] }) {
  if (!log.length) return null;
  return (
    <div className="border-t border-fig-stroke px-3 py-2 text-xxs text-muted">
      <div className="label mb-0.5">SL/TP executions</div>
      {log.slice(0, 5).map((l, i) => (
        <div key={i} className={`num ${l.ok ? "text-up" : "text-amber"}`}>
          {new Date(l.ts).toISOString().slice(11, 19)} · #{l.marketId} {l.kind.toUpperCase()} @ {fmtPrice(l.price)}. {l.message}
        </div>
      ))}
    </div>
  );
}
