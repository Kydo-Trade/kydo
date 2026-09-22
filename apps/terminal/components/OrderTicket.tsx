"use client";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import BN from "bn.js";
import Link from "next/link";
import { ChevronDown, MoreVertical } from "lucide-react";
import { BPS, PRICE_SCALE, MOCK_FEE_BPS, MOCK_SPREAD_BPS, preTradeCheck, type MarketLike } from "@kydo/sdk";
import type { BackendState, OrderSide, TradingBackend } from "@/lib/backend/types";
import { poolName, riskLike, type ChainRisk } from "@/lib/chain";
import { usePlatform } from "@/lib/platform";
import { usePrices } from "@/lib/prices";
import { useSession } from "@/lib/session";
import { useTx } from "@/lib/hooks";
import { fromPrice, price as fmtPrice, pct, usd, usdWhole, qty as fmtQty } from "@/lib/format";
import { ZERO, clusterName, lockFloors, ratio, sizingRoom, utilText } from "@/lib/sizing";
import type { Trigger } from "@/lib/triggers";
import { trial as trialApi } from "@/lib/api";
import { AccountDialog, LeveragePanel, MarginModeDialog, useTradeSettings } from "./TradeSettings";

export interface OrderTicketProps {
  state: BackendState | null;
  market: MarketLike | null;
  risk: ChainRisk | null;
  backend: TradingBackend | null;
  limitPrefill: number | null;
  onPlaced: () => void;
  setTrigger: (t: Trigger) => void;
  /** Why there is nothing to trade against (no trial, no live pool, wallet can't sign…). */
  noBackendReason?: string | null;
}

/** "600.4" style string for the size input from a 1e6 BN (exact: 6 dp max). */
const bnToInput = (x: BN) => fromPrice(x).toString();
/** Parse the size input into an exact 1e6 BN (0 for junk/negative). */
const inputToBN = (s: string) => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? new BN(Math.round(n * PRICE_SCALE)) : ZERO;
};

type Unit = "usd" | "base";

export function OrderTicket({ state, market, risk, backend, limitPrefill, onPlaced, setTrigger, noBackendReason }: OrderTicketProps) {
  const [type, setType] = useState<"market" | "limit">("market");
  const [side, setSide] = useState<OrderSide>("long");
  const [notional, setNotional] = useState<string>("1000"); // canonical size, USD
  const [unit, setUnit] = useState<Unit>("usd");
  const [limit, setLimit] = useState<string>("");
  const [sl, setSl] = useState<string>("");
  const [tp, setTp] = useState<string>("");
  const [tpslOn, setTpslOn] = useState(false);
  const [pnlUnit, setPnlUnit] = useState<"%" | "usd">("%");
  const [tif, setTif] = useState<"GTC" | "IOC" | "ALO">("GTC");
  const [depthCaps, setDepthCaps] = useState<Record<number, number> | null>(null);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [dialog, setDialog] = useState<null | "margin" | "account">(null);
  // Leverage is not a dialog: the design expands it in place inside the panel
  // ("Form Container"), so the slider is one click away in the side panel
  // instead of behind a modal.
  const [levOpen, setLevOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const snap = usePrices();
  const action = useTx();
  const { wallet: walletPk } = usePlatform();
  const session = useSession(walletPk);

  const live = state?.mode === "live";
  // bulk-style one-click: with an active session key the order signs locally. No popup, no interstitial
  const oneClick = live && !!session && session.expiresAt * 1000 > Date.now();
  const tick = market ? snap.prices[market.marketId] : undefined;
  const oracle = tick?.price ?? 0;
  const baseSym = market?.symbol.split("-")[0] ?? "";
  const current = market ? (state?.positions.find((x) => x.marketId === market.marketId) ?? null) : null;
  const marketMaxLev = market ? market.maxLeverageBps / BPS : 0;
  const platformMaxLev = risk ? risk.maxLeverageBps / BPS : 0;
  const maxLev = market && risk ? Math.min(marketMaxLev, platformMaxLev) : marketMaxLev || platformMaxLev;
  const [settings, setSettings] = useTradeSettings(market?.marketId ?? null, maxLev || 1);
  const leverage = Math.max(0.1, Math.min(maxLev || settings.leverage || 1, settings.leverage || maxLev || 1));

  const fmtLimit = (px: number) => px.toFixed(px >= 1000 ? 2 : 4);

  // Section 4.2: the trial venue rejects any order above 10% of visible depth. Learn the caps once so the
  // ticket clamps up front instead of letting a guard-approved size die with ExceedsDepth at submit.
  useEffect(() => {
    if (live || !backend) return;
    let alive = true;
    trialApi
      .markets()
      .then((r) => alive && setDepthCaps(Object.fromEntries(r.markets.map((m) => [m.marketId, m.maxOrderUsd]))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [live, backend]);

  useEffect(() => {
    if (limitPrefill && limitPrefill > 0) {
      setType("limit");
      setLimit(fmtLimit(limitPrefill));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limitPrefill]);

  // A limit price belongs to one market: when the selected market changes, drop the
  // stale value (otherwise e.g. a SOL price stays in the box for BTC and fails the band check).
  useEffect(() => {
    setLimit("");
    setReduceOnly(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market?.marketId]);

  // The confirmation summary is for one exact order: any change to what it describes dismisses it.
  useEffect(() => {
    setConfirming(false);
  }, [market?.marketId, side, type, notional, limit, reduceOnly]);

  // Reduce-only means closing: the side is the opposite of the open position.
  useEffect(() => {
    if (reduceOnly && current) setSide(current.side === "long" ? "short" : "long");
  }, [reduceOnly, current]);

  const limitNum = type === "limit" ? Number(limit) || 0 : 0;
  const bandBps = risk?.limitBandBps ?? 200;
  const bandLo = oracle * (1 - bandBps / 10000);
  const bandHi = oracle * (1 + bandBps / 10000);
  const openSide: OrderSide = reduceOnly && current ? current.side : side; // the side the guard sizes for
  const sideNum = openSide === "short" ? 2 : 1;
  const oracleBN = useMemo(() => new BN(Math.round(oracle * PRICE_SCALE)), [oracle]);
  // Tier 0 (instant funding) trades under tighter loss limits than `risk`
  // advertises. Without this the ticket green-lights orders the on-chain guard
  // rejects with DailyLossBreach. No pool = the trial account, which runs at
  // the platform limits.
  const poolTier = state?.pool?.tier ?? 1;

  // Stops are a trader tool, not a risk control. The platform enforces its
  // loss limits by liquidation instead, so TP/SL is opt-in again.
  const tpslOpen = tpslOn;
  const slNum = tpslOpen ? Number(sl) || 0 : 0;
  const tpNum = tpslOpen ? Number(tp) || 0 : 0;
  const slWarn = slNum > 0 && oracle > 0 && ((openSide === "long" && slNum >= oracle) || (openSide === "short" && slNum <= oracle)) ? "stop-loss is on the wrong side of the price" : null;
  const tpWarn = tpNum > 0 && oracle > 0 && ((openSide === "long" && tpNum <= oracle) || (openSide === "short" && tpNum >= oracle)) ? "take-profit is on the wrong side of the price" : null;

  // ---- how much the guard will accept for this market/side (same 1e6 inputs as preTradeCheck) ----
  const room = useMemo(() => {
    if (!state || !state.ready || !risk || !market || !oracle) return null;
    return sizingRoom({
      risk: riskLike(risk, poolTier),
      nav: state.raw.nav,
      dayStartNav: state.raw.dayStartNav,
      peakNav: state.raw.peakNav,
      positions: state.raw.positions,
      marks: state.raw.marks,
      marketId: market.marketId,
      cluster: market.cluster,
      side: sideNum,
      oraclePrice: oracleBN,
      marketMaxLeverageBps: market.maxLeverageBps,
    });
  }, [state, risk, market, oracle, oracleBN, sideNum]);

  /**
   * Cap: the guard's maximum when opening (further capped by an isolated-mode allocation),
   * the open position when reducing.
   */
  const isolatedRoom = settings.marginMode === "isolated" && settings.allocationUsd > 0 ? Math.max(0, settings.allocationUsd - (current?.notional ?? 0)) : null;
  let maxBN = reduceOnly
    ? current
      ? new BN(Math.round(current.notional * PRICE_SCALE))
      : ZERO
    : room
      ? isolatedRoom !== null
        ? BN.min(room.maxNotional, new BN(Math.round(isolatedRoom * PRICE_SCALE)))
        : room.maxNotional
      : null;
  let limitedByLabel = room && isolatedRoom !== null && maxBN && maxBN.lt(room.maxNotional) ? "isolated allocation" : room?.limitedBy?.label;
  // trial venue depth cap (section 4.2). Closes are exempt, matching the engine
  const depthCapUsd = !live && !reduceOnly && market && depthCaps ? depthCaps[market.marketId] : undefined;
  if (depthCapUsd !== undefined && maxBN) {
    const cap = new BN(Math.round(depthCapUsd * PRICE_SCALE));
    if (cap.lt(maxBN)) {
      maxBN = cap;
      limitedByLabel = "venue depth (10% of visible book)";
    }
  }
  const typedBN = useMemo(() => inputToBN(notional), [notional]);
  const clamped = !!maxBN && typedBN.gt(maxBN);
  /** exact notional that will be sent */
  const effBN = clamped && maxBN ? maxBN : typedBN;
  const effUsd = fromPrice(effBN);

  const estFill = oracle ? oracle * (1 + ((side === "long" ? 1 : -1) * MOCK_SPREAD_BPS) / 10000) : 0;
  const estQty = estFill ? effUsd / estFill : 0;
  const estFee = (effUsd * MOCK_FEE_BPS) / 10000;
  /** base quantity for reduce-only closes (never more than the position) */
  const closeQty = reduceOnly && current && oracle ? Math.min(current.baseQty, effUsd / oracle) : 0;
  const closesAll = reduceOnly && current ? closeQty >= current.baseQty * 0.999999 : false;

  // ---- post-trade preview ----
  const post = useMemo(() => {
    if (!state || !risk || !market || !room) return null;
    const nav = state.raw.nav;
    const delta = reduceOnly ? effBN.neg() : effBN;
    const grossAfter = BN.max(room.exposure.gross.add(delta), ZERO);
    const clusterAfter = BN.max((room.exposure.byCluster[market.cluster] ?? ZERO).add(delta), ZERO);
    const nPos = state.raw.positions.length + (reduceOnly ? (closesAll ? -1 : 0) : room.existing ? 0 : 1);
    return {
      lev: nav.isZero() ? 0 : ratio(grossAfter, nav),
      levUtil: ratio(grossAfter, nav.muln(risk.maxLeverageBps).divn(BPS)),
      clusterPct: nav.isZero() ? 0 : ratio(clusterAfter, nav),
      clusterUtil: ratio(clusterAfter, nav.muln(risk.maxClusterBps).divn(BPS)),
      nPos,
      posUtil: nPos / risk.maxPositions,
      floors: lockFloors(riskLike(risk, poolTier), state.raw.dayStartNav, state.raw.peakNav),
      grossNow: room.exposure.gross,
    };
  }, [state, risk, market, room, effBN, reduceOnly, closesAll]);

  /** Final gate: exact guard reason (SDK mirror of guard steps 8–15) on the clamped notional. */
  const preflight = useMemo((): string | null => {
    if (reduceOnly || !state || !risk || !market || !oracle || effBN.isZero()) return null;
    return preTradeCheck({
      risk: riskLike(risk, poolTier),
      nav: state.raw.nav,
      dayStartNav: state.raw.dayStartNav,
      peakNav: state.raw.peakNav,
      positions: state.raw.positions,
      marks: state.raw.marks,
      marketId: market.marketId,
      cluster: market.cluster,
      side: sideNum,
      notionalUsd: effBN,
      oraclePrice: oracleBN,
      limitPx: limitNum > 0 ? new BN(Math.round(limitNum * PRICE_SCALE)) : undefined,
      marketMaxLeverageBps: market.maxLeverageBps,
    });
  }, [reduceOnly, state, risk, market, oracle, oracleBN, effBN, sideNum, limitNum]);

  /** Reasons the trader cannot fix by sizing. These disable the button. */
  const blocker = useMemo((): string | null => {
    if (!backend) return noBackendReason ?? "no trading account on this network";
    if (!state || !state.ready) return state?.tradableReason ?? "loading…";
    if (!state.tradable) return state.tradableReason ?? "not tradable";
    if (!market) return "select a market";
    if (!market.enabled) return "market is disabled";
    if (!oracle) return "no oracle price";
    if (reduceOnly) {
      if (!current) return "no open position in this market to reduce";
      if (closeQty <= 0) return "enter a size to close";
      return null;
    }
    if (risk && state.tradesToday >= risk.maxTradesPerDay) return `max ${risk.maxTradesPerDay} trades per day reached`;
    if (room?.block) return room.block;
    if (type === "limit" && !(limitNum > 0)) return "enter a limit price";
    if (maxBN && maxBN.isZero()) return `no room left. ${limitedByLabel ?? "limit"} is fully used`;
    if (effBN.isZero()) return "enter a size";
    return preflight;
  }, [backend, noBackendReason, state, market, oracle, risk, room, type, limitNum, maxBN, effBN, preflight, reduceOnly, current, closeQty, limitedByLabel, slNum]);

  const disabled = !!blocker || action.busy || !!slWarn || !!tpWarn;
  const disabledReason = blocker ?? slWarn ?? tpWarn ?? (action.busy ? "sending…" : undefined);
  const verb = reduceOnly ? "Close" : side === "long" ? "Buy" : "Sell";

  const submit = async () => {
    if (!backend || !market || blocker) return;
    if (reduceOnly) {
      if (!current || closeQty <= 0) return;
      const r = await action.run(
        `${live ? "Signing" : "Placing"} close ${market.symbol} ${fmtQty(closeQty)}…`,
        () => backend.closeOrder({ marketId: market.marketId, baseQty: closesAll ? undefined : closeQty, limitPx: limitNum > 0 ? limitNum : undefined }),
        (res) => ({
          title: `${closesAll ? "Closed" : "Reduced"} ${market.symbol}`,
          detail: `${fmtQty(res.baseQty ?? closeQty)} ${baseSym}${res.fillPrice ? ` @ ${fmtPrice(res.fillPrice)}` : ""}${res.realizedPnl !== undefined ? ` · realised ${usd(res.realizedPnl, { sign: true })}` : ""}${res.fee ? ` · fee ${usd(res.fee)}` : ""}`,
          sig: live ? res.sig : null,
        }),
      );
      setConfirming(false);
      if (r) onPlaced();
      return;
    }
    if (effBN.isZero()) return;
    const r = await action.run(
      live ? `Signing ${verb.toLowerCase()} ${market.symbol} ${usd(effUsd)}…` : `Placing ${verb.toLowerCase()} ${market.symbol} ${usd(effUsd)}…`,
      () => backend.placeOrder({ marketId: market.marketId, side, notionalUsd: effUsd, notionalRaw: effBN, limitPx: limitNum > 0 ? limitNum : undefined, stopPx: slNum > 0 ? slNum : undefined }),
      (res) => ({
        title: `${verb} ${market.symbol} filled`,
        detail: `${usd(effUsd)}${res.fillPrice ? ` @ ${fmtPrice(res.fillPrice)}` : ""}${res.baseQty ? ` · ${fmtQty(res.baseQty)} ${baseSym}` : ""}${res.fee ? ` · fee ${usd(res.fee)}` : ""}${!live && res.sig ? ` · entry ${res.sig.slice(0, 8)}…` : ""}`,
        sig: live ? res.sig : null,
      }),
    );
    setConfirming(false);
    if (r) {
      // The stop is enforced by the backend now (on-chain live, in the
      // simulator for the trial), so only the take-profit stays a
      // browser-watched trigger.
      if (tpNum > 0) setTrigger({ marketId: market.marketId, side, takeProfit: tpNum });
      onPlaced();
    }
  };

  const onPrimary = () => {
    if (disabled) return;
    if (live && !oneClick) setConfirming(true);
    else void submit();
  };

  const pctOfMax = (p: number) => maxBN && !maxBN.isZero() && setNotional(bnToInput(maxBN.muln(Math.round(p * 100)).divn(100)));

  const poolLabel = state?.pool ? poolName(state.pool) || `#${state.pool.index}` : "—";

  /* ---- slider: always % of what can actually be sent ----
     100% is the largest order this ticket will submit, in every mode: the open
     position when reducing, otherwise the guard's maximum further capped by an
     isolated allocation and, on the trial venue, by 10% of visible depth.

     Trial used to divide by NAV instead. With a $50,000 simulated balance and a
     $5,000 depth cap on the non-major markets (TRIAL_DEPTH_OTHER=50000 → 10% of
     it), only the first tenth of the track did anything: past 10% the size field
     froze at the cap while the thumb kept travelling, and the row below still
     advertised the whole $50,000 as available. The limit was real and correctly
     enforced. Only the slider disagreed with it. */
  const sliderPct =
    maxBN && !maxBN.isZero() ? Math.min(100, Math.round(Number(effBN.muln(100).div(maxBN).toString()))) : 0;
  const setPct = (p: number) => pctOfMax(p / 100);
  const sliderDisabled = !maxBN || maxBN.isZero();
  const availableUsd = reduceOnly ? (current ? current.notional : 0) : maxBN ? fromPrice(maxBN) : null;
  const limitBad = limitNum > 0 && (limitNum < bandLo || limitNum > bandHi);

  // ---- size unit (USD ↔ base) ----
  const sizeShown = unit === "usd" ? notional : oracle && Number(notional) > 0 ? (Number(notional) / oracle).toFixed(6).replace(/\.?0+$/, "") : "";
  const onSizeChange = (v: string) => {
    if (unit === "usd") return setNotional(v);
    const q = Number(v);
    setNotional(Number.isFinite(q) && q > 0 && oracle ? (q * oracle).toFixed(2) : "0");
  };

  // ---- leverage (per-market setting): margin read-out and the "Max at L×" size ----
  const navUsd = state?.nav ?? 0;
  const grossNowUsd = post ? fromPrice(post.grossNow) : 0;
  const levNow = navUsd > 0 ? grossNowUsd / navUsd : 0;
  const sizeAtLeverage = navUsd > 0 ? Math.max(0, leverage * navUsd - grossNowUsd) : 0;
  const useLeverageMax = () => {
    if (navUsd <= 0) return;
    setReduceOnly(false);
    setNotional(sizeAtLeverage.toFixed(2));
  };
  const marginRequired = leverage > 0 ? effUsd / leverage : 0;

  /**
   * How close this account is to ending, and what this order does about it.
   *
   * Both loss floors are NAV thresholds, so the room left is NAV minus
   * whichever binds first. Expressing the order against that room. The adverse
   * move that would reach it. Is the only form of this number a trader can act
   * on: "$1,840 left" says nothing about whether the size in the box is
   * reckless, and "−2.4% ends the account" says it immediately.
   */
  const floorRoom = (() => {
    if (!post || !state) return null;
    const nav = state.nav;
    const daily = Math.max(0, nav - fromPrice(post.floors.daily));
    const drawdown = Math.max(0, nav - fromPrice(post.floors.drawdown));
    const binding = Math.min(daily, drawdown);
    const which = daily <= drawdown ? "today's loss limit" : "the drawdown floor";
    // Budget used so far, for the bar: how much of the binding allowance is gone.
    const allowance = daily <= drawdown ? (state.dayStartNav * (risk?.dailyLossBps ?? 400)) / 10_000 : (state.peakNav * (risk?.maxDrawdownBps ?? 1000)) / 10_000;
    const used = allowance > 0 ? Math.max(0, Math.min(1, (allowance - binding) / allowance)) : 0;
    // Loss ≈ notional × adverse move, so the move that spends what is left.
    const movePct = effUsd > 0 ? (binding / effUsd) * 100 : null;
    return { binding, which, used, movePct };
  })();
  const accountMode = !backend ? "No account" : live ? "Pool" : "Trial";

  // ---- TP / SL price ⇄ gain / loss (Hyperliquid layout): linked through the expected entry ----
  const entryRef = estFill || oracle || 0;
  const dir = openSide === "long" ? 1 : -1;
  const qtyRef = entryRef ? effUsd / entryRef : 0;
  const fmtPnl = (v: number) => (Number.isFinite(v) && v !== 0 ? (pnlUnit === "%" ? v.toFixed(2) : v.toFixed(2)) : "");
  /** gain for a TP at `px` (positive when in profit) */
  const gainOf = (px: number) => (entryRef ? (pnlUnit === "%" ? ((px - entryRef) / entryRef) * 100 * dir : (px - entryRef) * qtyRef * dir) : 0);
  /** loss for an SL at `px` (positive number) */
  const lossOf = (px: number) => (entryRef ? (pnlUnit === "%" ? ((entryRef - px) / entryRef) * 100 * dir : (entryRef - px) * qtyRef * dir) : 0);
  const gainShown = Number(tp) > 0 ? fmtPnl(gainOf(Number(tp))) : "";
  const lossShown = Number(sl) > 0 ? fmtPnl(lossOf(Number(sl))) : "";
  const onGainChange = (v: string) => {
    const g = Number(v);
    if (!entryRef || !Number.isFinite(g) || v.trim() === "") return setTp("");
    const px = pnlUnit === "%" ? entryRef * (1 + (g / 100) * dir) : entryRef + (qtyRef ? (g / qtyRef) * dir : 0);
    setTp(px > 0 ? fmtLimit(px) : "");
  };
  const onLossChange = (v: string) => {
    const l = Number(v);
    if (!entryRef || !Number.isFinite(l) || v.trim() === "") return setSl("");
    const px = pnlUnit === "%" ? entryRef * (1 - (l / 100) * dir) : entryRef - (qtyRef ? (l / qtyRef) * dir : 0);
    setSl(px > 0 ? fmtLimit(px) : "");
  };

  /* The gain / loss boxes read back off the price, so while one is focused it
     has to show what was typed rather than what the derivation makes of it.
     Without a draft the field fights the typist twice: `fmtPnl` reformats to
     two decimals on every keystroke, so typing "3" turns the box into "3.00"
     under the caret and the next digit lands in the middle of it; and
     `entryRef` is the live oracle, so a gain recomputes on its own as the
     market moves. Set 3.00% and it reads 2.99% a tick later. The draft is
     dropped on blur, when the derived value is the honest one again. */
  const [gainDraft, setGainDraft] = useState<string | null>(null);
  const [lossDraft, setLossDraft] = useState<string | null>(null);

  /* Arrow-key stepping. One press moves a price by roughly a tick at that
     magnitude and a gain/loss by a tenth of a percent (or a dollar); Shift
     multiplies by ten. From an empty price box the first press starts at the
     expected entry, which is where a trader is reasoning from anyway. */
  const priceStep = (v: number) => {
    const a = Math.abs(v);
    return a >= 1000 ? 1 : a >= 100 ? 0.1 : a >= 1 ? 0.01 : 0.0001;
  };
  const onPriceKey = (e: ReactKeyboardEvent<HTMLInputElement>, current: string, set: (s: string) => void) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const typed = Number(current);
    const from = current.trim() !== "" && Number.isFinite(typed) ? typed : entryRef;
    if (!from) return;
    const step = priceStep(from) * (e.shiftKey ? 10 : 1);
    const next = from + (e.key === "ArrowUp" ? step : -step);
    set(next > 0 ? fmtLimit(next) : "");
  };
  const onPnlKey = (
    e: ReactKeyboardEvent<HTMLInputElement>,
    current: string,
    setDraft: (s: string | null) => void,
    commit: (s: string) => void,
  ) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    if (!entryRef) return;
    const typed = Number(current);
    const from = current.trim() !== "" && Number.isFinite(typed) ? typed : 0;
    const step = (pnlUnit === "%" ? 0.1 : 1) * (e.shiftKey ? 10 : 1);
    const next = Number((from + (e.key === "ArrowUp" ? step : -step)).toFixed(2));
    const s = String(next);
    setDraft(s);
    commit(s);
  };

  return (
    <div className="panel flex flex-col" aria-label="Order ticket" data-tour="ticket">
      <MarginModeDialog open={dialog === "margin"} onClose={() => setDialog(null)} symbol={market?.symbol ?? ""} navUsd={navUsd} settings={settings} onSave={setSettings} />
      <AccountDialog open={dialog === "account"} onClose={() => setDialog(null)} state={state} noBackendReason={noBackendReason} />

      {/* order type: underline tabs, with the design's ⋮ overflow on the right */}
      <div className="hl-tabs" role="radiogroup" aria-label="Order type">
        {(["market", "limit"] as const).map((t) => (
          <button
            key={t}
            className="hl-tab"
            role="radio"
            aria-checked={type === t}
            aria-selected={type === t}
            onClick={() => {
              setType(t);
              if (t === "limit" && !limit && oracle) setLimit(fmtLimit(oracle));
            }}
          >
            {t === "market" ? "Market" : "Limit"}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-1 pr-1">
          <span className="text-xxs text-muted">{!backend ? "no account" : state?.mode === "trial" ? "simulated" : "investor capital"}</span>
          {/* The design's ⋮ (Figma 121:143625). Margin mode and the account
              panel moved in here when the chip row came out. */}
          <TicketMenu
            items={[
              { label: settings.marginMode === "isolated" ? "Margin: Isolated" : "Margin: Cross", onClick: () => setDialog("margin"), disabled: !market },
              { label: `Account: ${accountMode}`, onClick: () => setDialog("account") },
            ]}
          />
        </span>
      </div>

      <div className="panel-body flex flex-col gap-2">
        {/* Side first, as the design has it: the direction is chosen before the
            order is sized, and the action button at the bottom takes its colour
            from here. The selected chip is the design's white pill. The same
            treatment as Trade/Invest in the nav and All/Funding/Live on the
            invest page, so "selected" looks the same everywhere; green/red
            carries on the button that actually places the order. Reduce-only
            owns the side (a close is the opposite of the open position), so the
            control locks. */}
        <div className="seg" role="radiogroup" aria-label="Side">
          {(["long", "short"] as const).map((sd) => (
            <button
              key={sd}
              type="button"
              role="radio"
              aria-checked={side === sd}
              disabled={reduceOnly}
              className={`seg__btn ${side === sd ? "seg__btn--on" : ""} disabled:opacity-60`}
              onClick={() => setSide(sd)}
              title={reduceOnly ? "Reduce-only closes the open position. The side is fixed" : sd === "long" ? "Buy / long" : "Sell / short"}
            >
              {sd === "long" ? "Buy / Long" : "Sell / Short"}
            </button>
          ))}
        </div>

        {/* the design's two read-out rows */}
        <div className="flex flex-col gap-1.5 font-sans text-xs">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted" title={reduceOnly ? "Open position you can reduce" : live ? `Largest notional the 14-step guard accepts right now${room?.limitedBy ? `. Bound by ${room.limitedBy.label}` : ""}` : "Simulated NAV backs every order"}>
              {reduceOnly ? "Reducible" : "Available to Trade"}
            </span>
            <span className={`num ${availableUsd === 0 ? "text-down" : "text-fg"}`}>{availableUsd === null ? "—" : usd(availableUsd)}</span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted">Current Position</span>
            <span className={`num ${current ? (current.side === "long" ? "text-up" : "text-down") : "text-fg"}`}>
              {current ? `${current.side === "long" ? "+" : "−"}${fmtQty(current.baseQty)} ${baseSym}` : `0 ${baseSym}`}
            </span>
          </div>
        </div>

        {type === "limit" && (
          <label className={`hl-field ${limitBad ? "hl-field--bad" : ""}`} title={`Band ${fmtPrice(bandLo)} – ${fmtPrice(bandHi)} (±${bandBps} bps around the oracle)`}>
            <span className="hl-field__label">Price (USD)</span>
            {/* Same arrow stepping as TP/SL. A trader who finds it on one
                price box will reach for it here first. From empty, the first
                press starts at the oracle, which is what Mid sets. */}
            <input value={limit} onChange={(e) => setLimit(e.target.value)} onKeyDown={(e) => onPriceKey(e, limit, setLimit)} inputMode="decimal" placeholder={oracle ? fmtLimit(oracle) : ""} aria-invalid={limitBad || undefined} aria-label="Limit price" />
            <button type="button" className="text-xxs text-amber hover:underline" onClick={() => oracle && setLimit(fmtLimit(oracle))} disabled={!oracle} title="Set the limit to the current oracle price">
              Mid
            </button>
          </label>
        )}

        {/* Leverage: a field row that expands the panel in place (Figma "Form
            Container"), not a modal. */}
        <button
          type="button"
          className="hl-field w-full disabled:opacity-50"
          onClick={() => setLevOpen((o) => !o)}
          aria-expanded={levOpen}
          disabled={!market}
          title={`Leverage used for sizing ${market?.symbol ?? ""} · now ${levNow.toFixed(2)}× open · market max ${marketMaxLev.toFixed(0)}×`}
        >
          <span className="hl-field__label">Leverage</span>
          <span className="flex items-center gap-1">
            <span className="num text-h11 text-fg">{leverage.toFixed(leverage >= 10 ? 0 : 1)}x</span>
            <ChevronDown size={14} className={`text-fig-text-700 transition-transform ${levOpen ? "rotate-180" : ""}`} />
          </span>
        </button>
        {levOpen && market && (
          <LeveragePanel
            symbol={market.symbol}
            maxLev={maxLev || 1}
            platformMaxLev={platformMaxLev}
            navUsd={navUsd}
            settings={{ ...settings, leverage }}
            onSave={setSettings}
            onClose={() => setLevOpen(false)}
          />
        )}

        {/* size with unit switch */}
        <label className={`hl-field ${clamped ? "hl-field--warn" : ""}`}>
          {/* The "Size" label lives in the placeholder, as the design has it. A
              separate label column does not fit a 272 px panel. */}
          <input value={sizeShown} onChange={(e) => onSizeChange(e.target.value)} onBlur={() => clamped && maxBN && setNotional(bnToInput(maxBN))} inputMode="decimal" placeholder="Size" aria-invalid={clamped || undefined} aria-label={unit === "usd" ? "Size in USD notional" : `Size in ${baseSym}`} />
          {!reduceOnly && (
            <button type="button" className="text-xxs text-amber hover:underline" onClick={useLeverageMax} disabled={navUsd <= 0} title={`Size to ${leverage.toFixed(1)}× leverage: ${usd(sizeAtLeverage)} (then clamped by the guard)`}>
              Max
            </button>
          )}
          <button type="button" className="inline-flex items-center gap-0.5 text-xxs text-muted hover:text-fg" onClick={() => setUnit((u) => (u === "usd" ? "base" : "usd"))} title="Switch between USD notional and base quantity" disabled={!oracle}>
            {unit === "usd" ? "USD" : baseSym || "base"}
            <ChevronDown size={12} />
          </button>
        </label>

        <div className="flex items-center gap-3" aria-label={reduceOnly ? "Size as % of the position" : live ? "Size as % of the allowed maximum" : "Size as % of NAV"}>
          <div className={`range-wrap flex-1 ${sliderDisabled ? "range-wrap--disabled" : ""}`}>
            <div className="range-track" aria-hidden>
              <div className="range-fill" style={{ width: `${sliderPct}%` }} />
            </div>
            <div className="range-ticks" aria-hidden>
              {[0, 25, 50, 75, 100].map((t) => (
                <span key={t} className={t <= sliderPct ? "range-tick range-tick--on" : "range-tick"} />
              ))}
            </div>
            <div className="range-thumb" style={{ left: `calc(10px + (100% - 20px) * ${sliderPct / 100})` }} aria-hidden />
            <input type="range" className="range-input" min={0} max={100} step={1} value={sliderPct} disabled={sliderDisabled} onChange={(e) => setPct(Number(e.target.value))} aria-valuetext={`${sliderPct}%`} aria-label="Size percent" />
          </div>
          {/* The design draws this one as a small rounded-4 chip with a light border
              (Figma 127:155633), not the pill .hl-field otherwise gives. */}
          <span className="hl-field h-7 w-[72px] shrink-0 rounded-[4px] border-fg bg-fig-bg-750 px-2 shadow-[inset_0_-1px_6px_0_rgba(0,0,0,0.12),inset_0_2px_4px_0_rgba(0,0,0,0.12)]">
            <input className="w-full" value={sliderPct} onChange={(e) => setPct(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} inputMode="numeric" disabled={sliderDisabled} aria-label="Percent" />
            <span className="hl-field__unit">%</span>
          </span>
        </div>
        {clamped && maxBN && (
          <div className="font-sans text-xxs text-amber" role="status">
            Capped at {usd(fromPrice(maxBN))}. {reduceOnly ? "open position" : limitedByLabel ?? "guard limit"}.
          </div>
        )}

        {/* options. Square checks (bulk-style); still mutually exclusive: a reduce-only close cannot carry TP/SL */}
        <div className="flex flex-col gap-1.5" role="group" aria-label="Order options">
          <div className="flex items-center justify-between gap-2">
            <label className={`flex items-center gap-2 text-xs ${current ? "cursor-pointer" : "text-muted"}`} title={current ? "Only reduce the open position (a close on the opposite side); never opens a new one" : "No open position in this market to reduce"}>
              <input
                type="checkbox"
                className="tick"
                checked={reduceOnly}
                disabled={!current}
                onChange={(e) => {
                  setReduceOnly(e.target.checked);
                  if (e.target.checked) setTpslOn(false);
                }}
              />
              Reduce Only
            </label>
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <span className="group relative">
                <div className="tv-tip" role="tooltip">
                  <div className="font-semibold text-fg mb-2">Time In Force</div>
                  <p className="mb-2"><b className="text-fg">GTC</b> (Good Til Cancel): order rests on the book until filled or cancelled.</p>
                  <p className="mb-2"><b className="text-fg">IOC</b> (Immediate Or Cancel): any portion not filled immediately is cancelled.</p>
                  <p className="mb-2"><b className="text-fg">ALO</b> (Add Liquidity Only): rests as a maker order only. Post-only.</p>
                  <p className="text-muted">This venue fills atomically inside the transaction, so every choice executes as IOC until a resting-book venue (Drift) is live.</p>
                </div>
                <span className="underline decoration-dotted decoration-muted/60 underline-offset-2 cursor-help">TIF</span>
              </span>
              <select className="bg-panel2 border border-line rounded h-6 px-1 text-xs text-fg cursor-pointer" value={tif} onChange={(e) => setTif(e.target.value as typeof tif)} aria-label="Time in force">
                <option value="GTC">GTC</option>
                <option value="IOC">IOC</option>
                <option value="ALO">ALO</option>
              </select>
            </span>
          </div>
          <label
            className="flex items-center gap-2 text-xs cursor-pointer"
            title="Optional take-profit / stop-loss. A stop is placed at the venue when set; the platform's own loss limits are enforced by liquidation either way." 
          >
            <input
              type="checkbox"
              className="tick"
              checked={tpslOpen}
              onChange={(e) => {
                setTpslOn(e.target.checked);
                if (e.target.checked) setReduceOnly(false);
              }}
            />
            Take Profit / Stop Loss
          </label>
        </div>
        {tpslOpen && !reduceOnly && (
          <div className="grid grid-cols-2 gap-1" aria-label="Take profit / stop loss">
            {/* TP price ⇄ gain */}
            <label className={`hl-field ${tpWarn ? "hl-field--warn" : ""}`}>
              <input value={tp} onChange={(e) => setTp(e.target.value)} onKeyDown={(e) => onPriceKey(e, tp, setTp)} inputMode="decimal" placeholder="TP Price" aria-label="Take-profit price (client-side)" className="!text-left" />
            </label>
            <label className="hl-field">
              <input
                value={gainDraft ?? gainShown}
                onChange={(e) => {
                  setGainDraft(e.target.value);
                  onGainChange(e.target.value);
                }}
                onKeyDown={(e) => onPnlKey(e, gainDraft ?? gainShown, setGainDraft, onGainChange)}
                onBlur={() => setGainDraft(null)}
                inputMode="decimal"
                placeholder="Gain"
                aria-label={`Take-profit gain in ${pnlUnit === "%" ? "percent" : "USD"}`}
                className="!text-left"
                disabled={!entryRef}
              />
              <button type="button" className="inline-flex items-center gap-0.5 text-xxs text-muted hover:text-fg" onClick={() => setPnlUnit((u) => (u === "%" ? "usd" : "%"))} title="Express gain / loss as a percent of the entry price or in USD">
                {pnlUnit === "%" ? "%" : "USD"}
                <ChevronDown size={12} />
              </button>
            </label>
            {/* SL price ⇄ loss */}
            <label className={`hl-field ${slWarn ? "hl-field--warn" : ""}`}>
              <input
                value={sl}
                onChange={(e) => setSl(e.target.value)}
                onKeyDown={(e) => onPriceKey(e, sl, setSl)}
                inputMode="decimal"
                placeholder="SL Price"
                aria-label="Stop-loss price"
                className="!text-left"
              />
            </label>
            <label className="hl-field">
              <input
                value={lossDraft ?? lossShown}
                onChange={(e) => {
                  setLossDraft(e.target.value);
                  onLossChange(e.target.value);
                }}
                onKeyDown={(e) => onPnlKey(e, lossDraft ?? lossShown, setLossDraft, onLossChange)}
                onBlur={() => setLossDraft(null)}
                inputMode="decimal"
                placeholder="Loss"
                aria-label={`Stop-loss in ${pnlUnit === "%" ? "percent" : "USD"}`}
                className="!text-left"
                disabled={!entryRef}
              />
              <button type="button" className="inline-flex items-center gap-0.5 text-xxs text-muted hover:text-fg" onClick={() => setPnlUnit((u) => (u === "%" ? "usd" : "%"))} title="Express gain / loss as a percent of the entry price or in USD">
                {pnlUnit === "%" ? "%" : "USD"}
                <ChevronDown size={12} />
              </button>
            </label>
          </div>
        )}
        {(slWarn || tpWarn) && <div className="notice notice-warn">{slWarn ?? tpWarn}</div>}

        {/* The consequence, next to the action that causes it. Everything else
            in this panel is about the order; this is about the account. */}
        {floorRoom && !reduceOnly && (
          <div className="flex flex-col gap-2 rounded-[16px] border border-fig-stroke bg-fig-bg-additional px-3 py-2.5 shadow-[inset_0_6px_16px_0_rgba(0,0,0,0.16)]">
            <div className="flex items-baseline justify-between gap-2 text-h11">
              <span className="text-fig-text-600">Room before this account locks</span>
              <span className={`num ${floorRoom.used >= 0.75 ? "text-down" : floorRoom.used >= 0.5 ? "text-amber" : "text-fg"}`}>{usd(floorRoom.binding)}</span>
            </div>
            <div className="flex h-2 w-full overflow-hidden rounded-sm bg-fig-bg-750" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(floorRoom.used * 100)} aria-label="Loss budget used">
              <div
                style={{
                  width: `${floorRoom.used * 100}%`,
                  backgroundImage: `repeating-linear-gradient(90deg, ${floorRoom.used >= 0.75 ? "var(--fig-red-400)" : floorRoom.used >= 0.5 ? "var(--fig-yellow-500)" : "var(--fig-red-300)"} 0 3px, transparent 3px 5px)`,
                }}
              />
            </div>
            <p className="text-h11 leading-double text-fig-text-600">
              {floorRoom.movePct === null ? (
                <>Bound by {floorRoom.which}. A breach locks the account permanently. There is no liquidation of single positions.</>
              ) : (
                <>
                  This size reaches {floorRoom.which} on a{" "}
                  <span className={`num ${floorRoom.movePct < 2 ? "text-down" : floorRoom.movePct < 5 ? "text-amber" : "text-fg"}`}>
                    {floorRoom.movePct < 0.1 ? "<0.1" : floorRoom.movePct.toFixed(1)}%
                  </span>{" "}
                  move against you. A breach locks the account permanently.
                </>
              )}
            </p>
          </div>
        )}

        {/* primary action */}
        {!backend ? (
          <Link href="/" className="btn btn-cta" title={noBackendReason ?? "Apply on Home to start trading"}>
            Enable trading
          </Link>
        ) : live && confirming && market && state ? (
          <div className="flex flex-col gap-2 rounded-[16px] border border-amber/50 bg-amber/[0.06] p-3 shadow-[inset_0_6px_16px_0_rgba(0,0,0,0.16)]" role="region" aria-label="Confirm order">
            <div className="label text-amber">Confirm. You are trading investor capital</div>
            <div className="kv-list flex flex-col text-xxs">
              <div className="kv">
                <span>Pool</span>
                <span>{poolLabel}</span>
              </div>
              <div className="kv">
                <span>Investor capital</span>
                <span>{usd(state.nav)}</span>
              </div>
              <div className="kv">
                <span>Order</span>
                <span className={`font-semibold ${reduceOnly ? "text-muted" : side === "long" ? "text-up" : "text-down"}`}>
                  {verb} {market.symbol} {type}
                  {reduceOnly ? ` · ${closesAll ? "full" : "partial"}` : ""}
                </span>
              </div>
              <div className="kv">
                <span>Notional / qty</span>
                <span>
                  {usd(effUsd)} · {fmtQty(reduceOnly ? closeQty : estQty)} {baseSym}
                </span>
              </div>
              <div className="kv">
                <span>{type === "limit" ? "Limit / est. fill" : "Est. fill"}</span>
                <span>{type === "limit" ? `${fmtPrice(limitNum)} / ${fmtPrice(estFill)}` : fmtPrice(estFill)}</span>
              </div>
              <div className="kv">
                <span>Fee</span>
                <span>{usd(estFee)}</span>
              </div>
              {post && risk && (
                <>
                  <div className="kv">
                    <span>Leverage / positions after</span>
                    <span>
                      {post.lev.toFixed(2)}× of {risk.maxLeverageBps / BPS}× · {post.nPos} / {risk.maxPositions}
                    </span>
                  </div>
                  <div className="kv">
                    <span>Locks below</span>
                    <span className="text-amber">
                      {usdWhole(fromPrice(post.floors.daily))} daily · {usdWhole(fromPrice(post.floors.drawdown))} drawdown
                    </span>
                  </div>
                </>
              )}
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-1 mt-1">
              <button className={`btn ${reduceOnly ? "btn-primary" : side === "long" ? "btn-up" : "btn-down"} h-9 text-sm font-semibold`} disabled={disabled} onClick={() => void submit()} title={disabledReason}>
                {action.busy ? "Waiting for wallet…" : "Sign with wallet"}
              </button>
              <button className="btn h-9" disabled={action.busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          /* One button, coloured by the side chosen above (the design's single
             action row). Reduce-only keeps the neutral CTA. A close is not a
             direction. */
          <button
            className={`btn-cta ${reduceOnly || side === "long" ? "" : "btn-cta--sell"}`}
            disabled={disabled}
            onClick={onPrimary}
            title={disabledReason}
            aria-busy={action.busy}
          >
            {/* Wrapped so it can ellipsise: "Close 15.0158 SOL · $1,672.50" is
                wider than a 248 px column, and a bare text node inside a flex
                button is an anonymous item that `text-overflow` cannot reach. */}
            <span className="min-w-0 truncate">
              {action.busy
                ? "Sending…"
                : reduceOnly
                  ? `Close ${closesAll ? "all" : fmtQty(closeQty)} ${baseSym}${effUsd ? ` · ${usd(effUsd)}` : ""}`
                  : `${side === "long" ? "Buy / Long" : "Sell / Short"}${effUsd ? ` · ${usd(effUsd)}` : ""}`}
            </span>
          </button>
        )}

        {/* pre-flight: inline only when something blocks. A clean ticket stays quiet (bulk-style) */}
        {backend && blocker && (
          <div className="notice notice-bad" role="status" aria-live="polite">
            blocked: {blocker}
          </div>
        )}

        {/* summary: the three numbers every order needs; the deeper read-outs fold away (bulk.trade-style) */}
        <div className="kv-list mt-1 flex flex-col border-t border-dashed border-fig-stroke pt-3 text-h11">
          <div className="kv">
            <span>Order value</span>
            <span>{usd(effUsd)}</span>
          </div>
          <div className="kv">
            <span className="underline decoration-dotted decoration-muted/60 underline-offset-2" title={`Order value ÷ your leverage setting (${leverage.toFixed(1)}×). The share of pool NAV this order ties up`}>
              Margin required
            </span>
            <span>{leverage ? usd(marginRequired) : "—"}</span>
          </div>
          <div className="kv">
            <span className="underline decoration-dotted decoration-muted/60 underline-offset-2" title={`Mock venue fills at oracle ± ${MOCK_SPREAD_BPS} bps; limit orders must sit within ±${bandBps} bps of the oracle`}>
              Est. slippage
            </span>
            <span>
              {(MOCK_SPREAD_BPS / 100).toFixed(2)}% <span className="text-muted">/ {(bandBps / 100).toFixed(2)}%</span>
            </span>
          </div>
          <div className="kv">
            <span>Fees</span>
            <span>
              {usd(estFee)} <span className="text-muted">({MOCK_FEE_BPS} bps)</span>
            </span>
          </div>
        </div>
        <details className="disclosure">
          <summary>More details</summary>
          <div className="kv-list flex flex-col text-xxs pt-1">
            <div className="kv">
              <span className="underline decoration-dotted decoration-muted/60 underline-offset-2" title="There is no liquidation. The keeper locks the whole pool when NAV falls below these floors. Trading halts, investors redeem at NAV.">
                Lock floor (daily / drawdown)
              </span>
              <span className={post ? "text-amber" : ""}>{post ? `${usdWhole(fromPrice(post.floors.daily))} / ${usdWhole(fromPrice(post.floors.drawdown))}` : "—"}</span>
            </div>
            <div className="kv">
              <span>Est. fill / qty</span>
              <span>
                {fmtPrice(estFill || undefined)} <span className="text-muted">· {fmtQty(reduceOnly ? closeQty : estQty)} {baseSym}</span>
              </span>
            </div>
            {post && risk ? (
              <>
                <div className="kv">
                  <span>Leverage after</span>
                  <span className={utilText(post.levUtil)}>
                    {post.lev.toFixed(2)}× / {risk.maxLeverageBps / BPS}×
                  </span>
                </div>
                <div className="kv">
                  <span>{market ? clusterName(market.cluster) : "Cluster"} after</span>
                  <span className={utilText(post.clusterUtil)}>
                    {pct(post.clusterPct, 1)} / {risk.maxClusterBps / 100}%
                  </span>
                </div>
                <div className="kv">
                  <span>Positions after</span>
                  <span className={utilText(post.posUtil)}>
                    {post.nPos} / {risk.maxPositions}
                  </span>
                </div>
              </>
            ) : (
              <div className="kv">
                <span>NAV after fee</span>
                <span>{usd(state ? state.nav - estFee : undefined)}</span>
              </div>
            )}
          </div>
          <div className="pt-1 text-h11 leading-double text-muted">SL/TP are watched by this browser tab and sent as market closes. Min hold {risk?.minHoldSecs ?? 60}s applies.</div>
        </details>

      </div>
    </div>
  );
}

/**
 * The ⋮ at the top-right of the ticket (Figma 121:143625). Home for the two
 * settings the design has no room for on the face of the panel: margin mode
 * (its allocation input needs a dialog) and the account panel.
 */
function TicketMenu({ items }: { items: { label: string; onClick: () => void; disabled?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="flex size-6 items-center justify-center rounded text-fig-text-600 transition-colors hover:text-fg"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Ticket settings"
        onClick={() => setOpen((o) => !o)}
      >
        <MoreVertical size={14} />
      </button>
      {open && (
        <div className="popover right-0 z-40 min-w-[160px]" role="menu">
          <div className="flex flex-col gap-0.5">
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                className="rounded px-2 py-1.5 text-left text-h11 text-fg transition-colors hover:bg-panel2 disabled:opacity-50"
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
