"use client";
import BN from "bn.js";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Skeleton } from "@kydo/ui";
import { PRICE_SCALE, riskUtilisation, healthFactor } from "@kydo/sdk";
import type { BackendState } from "@/lib/backend/types";
import { riskLike, type ChainRisk } from "@/lib/chain";
import { pct, usd } from "@/lib/format";
import { Gauge } from "./Gauge";

function Stat({ label, value, cls = "", hint, loading }: { label: string; value: string; cls?: string; hint?: string; loading?: boolean }) {
  return (
    <div className="px-2.5 first:pl-1 min-w-[88px]" title={hint}>
      <div className="label">{label}</div>
      {loading ? <Skeleton className="mt-1 h-3 w-16" /> : <div className={`num text-xs ${cls}`}>{value}</div>}
    </div>
  );
}

/** Label · value row in the expanded panel (Figma 123:155151). */
function Row({ label, value, cls = "", hint }: { label: string; value: string; cls?: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between" title={hint}>
      <span className="text-h10 font-medium text-fig-text-600">{label}</span>
      <span className={`num text-h10 font-medium ${cls || "text-fg"}`}>{value}</span>
    </div>
  );
}

const DEFAULT_RISK: ChainRisk = {
  // Matches `RiskParams::mvp_defaults()` in programs/vault. A placeholder
  // for a risk ceiling has to be the real default, not a rounder number.
  maxLeverageBps: 50000,
  maxPositions: 5,
  maxSingleBps: 4000,
  maxClusterBps: 6000,
  dailyLossBps: 400,
  maxDrawdownBps: 1000,
  minHoldSecs: 60,
  maxTradesPerDay: 100,
  oracleMaxAgeSlots: new BN(25),
  oracleMaxConfBps: 50,
  limitBandBps: 200,
  redemptionLockupSecs: 86400,
  cooldownSecs: 604800,
  promotionDays: 30,
};

/**
 * Tone ladder for the two loss figures. The design draws them in Red/200
 * (daily loss) and Red/400 (drawdown) at rest. A healthy account showing a
 * hard red would misread, so the resting shade is the design's lighter red and
 * it escalates through amber to Red/400 as the limit is approached and breached.
 */
function lossTone(ratio: number): string {
  if (ratio >= 1) return "text-fig-red-400";
  if (ratio >= 0.75) return "text-amber";
  return "text-fig-red-200";
}

export interface RiskHudProps {
  state: BackendState | null;
  risk: ChainRisk | null;
  loading?: boolean;
  /**
   * The account's funded size, shown as "Starting Balance" in the expanded
   * panel. BackendState has no such field. Day-start and peak NAV are both
   * different things, so the page passes it explicitly. Omitted renders "—".
   */
  startingBalance?: number;
  /** Start expanded. Collapsed is the terminal's default (Figma 121:143656). */
  defaultOpen?: boolean;
}

/**
 * Risk HUD. Collapsed strip (Figma 121:143656 "overview-collapsed") that
 * expands to the full panel (121:149353 "overview-expanded").
 *
 *   collapsed  Account Equity · Daily loss · Drawdown, one 46 px row
 *   expanded   equity, starting balance, uPnL, the two limit bars with their
 *              captions, then the remaining stats and gauges
 *
 * Amber at ≥ 75 % of any limit (warning, no enforcement), red at breach
 * (the keeper locks the pool).
 */
export function RiskHud({ state, risk, loading = false, startingBalance, defaultOpen = false }: RiskHudProps) {
  const [open, setOpen] = useState(defaultOpen);
  const r = risk ?? DEFAULT_RISK;
  const s = state?.ready ? state : null;
  // Instant-funded (tier 0) pools run tighter floors than `risk` carries, so
  // the bars and the health factor below must be read at the pool's tier or
  // they show room the keeper will not honour. No pool = trial = platform limits.
  const tier = state?.pool?.tier ?? 1;
  const rEff = riskLike(r, tier);
  const util = s
    ? riskUtilisation({
        risk: rEff,
        nav: s.raw.nav,
        dayStartNav: s.raw.dayStartNav,
        peakNav: s.raw.peakNav,
        grossNotional: new BN(Math.round(s.grossNotional * PRICE_SCALE)),
      })
    : { daily: 0, drawdown: 0, leverage: 0, warn: false };
  const dailyLoss = s && s.dayStartNav > 0 ? Math.max(0, (s.dayStartNav - s.nav) / s.dayStartNav) : 0;
  const dd = s && s.peakNav > 0 ? Math.max(0, (s.peakNav - s.nav) / s.peakNav) : 0;
  const lev = s && s.nav > 0 ? s.grossNotional / s.nav : 0;
  const nPos = s?.positions.length ?? 0;
  const nTrades = s?.tradesToday ?? 0;
  // One monotone number for "how close to liquidation", the same definition the
  // indexer ranks bots' work queue on.
  const health = s && s.dayStartNav > 0 && s.peakNav > 0 ? healthFactor(s.nav, s.dayStartNav, s.peakNav, rEff) : null;
  const breached = util.daily >= 1 || util.drawdown >= 1;
  const dayPnl = s ? s.nav - s.dayStartNav : 0;
  const pending = loading || (!!state && !state.ready);

  // The design states both limits in dollars rather than percentages.
  const dailyCapUsd = s ? (s.dayStartNav * r.dailyLossBps) / 10000 : 0;
  const ddCapUsd = s ? (s.peakNav * r.maxDrawdownBps) / 10000 : 0;
  const dailyUsedUsd = s ? Math.max(0, s.dayStartNav - s.nav) : 0;
  const ddUsedUsd = s ? Math.max(0, s.peakNav - s.nav) : 0;

  /**
   * A locked account is standing state, not an event. The toast that announced
   * it is long gone by the next visit, and every number below it is frozen. The
   * HUD is where account state lives, so it says so, in both states.
   */
  const locked = state?.poolStatus === "locked" || state?.poolStatus === "settled";
  const lockLabel = state?.poolStatus === "settled" ? "Settled" : "Locked";

  // rounded-[24px] gradient shell, shared by both states (Figma 121:143656).
  const shell = `rounded-[24px] bg-gradient-to-t from-fig-bg-pattern-900 to-fig-bg-600 p-1 ${
    locked || breached ? "ring-1 ring-down" : util.warn ? "ring-1 ring-amber" : ""
  }`;

  if (!open) {
    return (
      <div className={shell} role="region" aria-label="Risk overview">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          className="flex w-full items-center justify-between rounded-[20px] px-4 py-3 text-left transition-colors hover:bg-white/[0.02]"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-1">
            {locked && (
              <span className="inline-flex items-center gap-2 rounded-full border border-down px-3 py-1 text-h11 font-medium text-down">
                <span className="size-1.5 rounded-full bg-down" aria-hidden />
                {lockLabel}. Trading has stopped
              </span>
            )}
            <CollapsedStat label="Account Equity" value={usd(s?.nav)} cls="text-fg" loading={pending} />
            <CollapsedStat label="Daily loss" value={pct(dailyLoss)} cls={lossTone(util.daily)} loading={pending} />
            <CollapsedStat label="Drawdown" value={pct(dd)} cls={lossTone(util.drawdown)} loading={pending} />
          </div>
          <ChevronDown className="size-4 shrink-0 text-fg" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div className={shell} role="region" aria-label="Risk overview">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="flex min-w-0 items-center gap-2 text-h10 font-medium text-fg">
          Overview
          {locked && (
            <span className="inline-flex items-center gap-2 rounded-full border border-down px-3 py-1 text-h11 font-medium text-down">
              <span className="size-1.5 rounded-full bg-down" aria-hidden />
              {lockLabel}. Trading has stopped
            </span>
          )}
        </span>
        <button type="button" onClick={() => setOpen(false)} aria-expanded aria-label="Collapse overview" className="grid size-4 place-items-center text-fg">
          <ChevronDown className="size-4 rotate-180" aria-hidden />
        </button>
      </div>

      <div className="m-1 mt-0 flex flex-col gap-5 rounded-[20px] bg-fig-bg-950 p-5">
        {/* equity, large */}
        <div>
          <div className="text-h10 font-medium text-fig-text-600">Account Equity</div>
          {pending ? <Skeleton className="mt-2 h-10 w-52" /> : <div className="num mt-1 text-h2 font-semibold text-fg">{usd(s?.nav)}</div>}
        </div>

        <div className="flex flex-col gap-2">
          <Row label="Starting Balance" value={startingBalance === undefined ? "—" : usd(startingBalance)} hint="The account's funded size" />
          <Row
            label="Unrealized PnL"
            value={usd(s?.unrealizedPnl, { sign: true })}
            cls={(s?.unrealizedPnl ?? 0) < 0 ? "text-down" : (s?.unrealizedPnl ?? 0) > 0 ? "text-up" : ""}
            hint="Unrealised PnL of open positions at oracle marks"
          />
        </div>

        {/* the two limits that can end the account */}
        <div className="flex flex-col gap-4">
          <LimitBlock
            label="Today&rsquo;s loss limit"
            value={`${usd(-dailyUsedUsd, { sign: true })} / ${usd(dailyCapUsd)}`}
            ratio={util.daily}
            caption={`Resets at 00:00 UTC · ${usd(dailyCapUsd)} on this account`}
            hint={`Losing more than ${r.dailyLossBps / 100}% of the day-start NAV locks the pool (00:00 UTC boundary).`}
          />
          <LimitBlock
            label="Total drawdown limit"
            value={`${usd(-ddUsedUsd, { sign: true })} / ${usd(ddCapUsd)}`}
            ratio={util.drawdown}
            caption={`Tier ceiling ${usd(ddCapUsd)} · breach ends this account`}
            hint={`A ${r.maxDrawdownBps / 100}% fall from peak NAV locks the pool permanently.`}
          />
        </div>

        {/* everything the collapsed strip and the two bars above don't cover */}
        <div className="flex flex-wrap items-stretch gap-x-3 gap-y-1.5 border-t border-dashed border-fig-stroke pt-4">
          <div className="flex shrink-0 items-center divide-x divide-line">
            <Stat
              label="Day P&L"
              value={s ? `${usd(dayPnl, { sign: true })} (${pct(s.dayStartNav ? dayPnl / s.dayStartNav : 0, 2, true)})` : "—"}
              cls={dayPnl < 0 ? "text-down" : dayPnl > 0 ? "text-up" : ""}
              loading={pending}
              hint="NAV change since 00:00 UTC day start"
            />
            <Stat label="Day start" value={usd(s?.dayStartNav)} loading={pending} hint="NAV at the 00:00 UTC day boundary. The daily-loss cap is measured from here" />
            <Stat label="Peak NAV" value={usd(s?.peakNav)} loading={pending} hint="Highest NAV ever recorded. The drawdown limit is measured from here" />
            <Stat
              label="Health"
              value={health === null ? "—" : health >= 10 ? "10+" : health.toFixed(2)}
              cls={health !== null && health <= 1 ? "text-down" : health !== null && health <= 1.1 ? "text-amber" : ""}
              loading={pending}
              hint="NAV divided by whichever loss floor binds first. 1.00 is the liquidation trigger. At or below it any bot can lock and unwind this pool."
            />
            {s?.mode === "live" && <Stat label="NAV/share" value={s.navPerShare?.toFixed(6) ?? "—"} hint="Net asset value per investor share" />}
            {s?.mode === "live" && (
              <Stat
                label="HWM"
                value={s.hwmNps?.toFixed(6) ?? "—"}
                cls={s.navPerShare !== undefined && s.hwmNps !== undefined && s.navPerShare < s.hwmNps ? "text-amber" : "text-up"}
                hint="High-water mark of NAV/share. Trader fees only vest above it"
              />
            )}
          </div>
          <div className="grid min-w-[280px] flex-1 grid-cols-3 items-center gap-3">
            <Gauge label="Gross leverage" value={`${lev.toFixed(2)}× / ${(r.maxLeverageBps / 10000).toFixed(0)}×`} ratio={util.leverage} hint={`Total open notional may not exceed ${r.maxLeverageBps / 10000}× NAV after any trade.`} />
            <Gauge label="Positions" value={`${nPos} / ${r.maxPositions}`} ratio={nPos / r.maxPositions} hint={`At most ${r.maxPositions} concurrent positions; a trade that opens a new market beyond that fails.`} />
            <Gauge label="Trades today" value={`${nTrades} / ${r.maxTradesPerDay}`} ratio={nTrades / r.maxTradesPerDay} hint={`Anti-spam cap of ${r.maxTradesPerDay} trades per UTC day.`} />
          </div>
          <div className="shrink-0 self-center text-right">
            {breached ? (
              <span className="pill pill-down">breach</span>
            ) : util.warn ? (
              <span className="pill pill-amber" title="≥ 75 % of a limit. No enforcement yet">
                warning
              </span>
            ) : s ? (
              <span className="pill pill-up">within limits</span>
            ) : (
              <span className="pill">{pending ? "loading" : "no account"}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One label · value pair in the collapsed strip. */
/**
 * `Account Equity: $4,994.74`. Label and figure at the same size, the same
 * weight, and joined by a colon, so the eye read one text run and had to parse
 * it as a sentence. Same shape as the account page's header line. The colon
 * goes, the label drops to 12 px and recedes, the figure goes up to 16 px
 * semibold: a stat you can take in without reading it.
 */
function CollapsedStat({ label, value, cls, loading }: { label: string; value: string; cls: string; loading?: boolean }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-h11 text-fig-text-600">{label}</span>
      {loading ? <Skeleton className="h-4 w-16" /> : <span className={`num text-h9 font-semibold ${cls}`}>{value}</span>}
    </span>
  );
}

/**
 * One loss limit: label, figure, the design's segmented bar, and a single
 * dot-separated caption (Figma "overview-expanded" 121:149353).
 */
function LimitBlock({ label, value, ratio, caption, hint }: { label: string; value: string; ratio: number; caption: string; hint?: string }) {
  const over = ratio >= 1;
  const warn = ratio >= 0.75;
  return (
    <div className="flex flex-col gap-2" title={hint}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-h9 font-medium text-fg">{label}</span>
        <span className={`num text-h9 font-medium ${over ? "text-fig-red-400" : warn ? "text-amber" : "text-fg"}`}>{value}</span>
      </div>
      <StripeBar ratio={ratio} tone={over ? "bad" : warn ? "warn" : "used"} />
      <span className="text-h11 text-fig-text-600">{caption}</span>
    </div>
  );
}

/**
 * The segmented fill the design uses for every meter. Thin vertical ticks,
 * coloured up to the used fraction and grey beyond it.
 */
function StripeBar({ ratio, tone }: { ratio: number; tone: "used" | "warn" | "bad" }) {
  const pctUsed = Math.max(0, Math.min(100, (Number.isFinite(ratio) ? ratio : 0) * 100));
  const fill = tone === "bad" ? "var(--fig-red-400)" : tone === "warn" ? "var(--fig-yellow-500, #ffdd00)" : "var(--fig-red-300)";
  return (
    <div className="flex h-3.5 w-full overflow-hidden rounded-sm" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pctUsed)}>
      <div style={{ width: `${pctUsed}%`, backgroundImage: `repeating-linear-gradient(90deg, ${fill} 0 3px, transparent 3px 5px)` }} />
      <div
        className="flex-1"
        style={{ backgroundImage: "repeating-linear-gradient(90deg, var(--fig-text-800) 0 3px, transparent 3px 5px)" }}
      />
    </div>
  );
}
