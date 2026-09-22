import BN from "bn.js";
import { PRICE_SCALE, QTY_SCALE, SHARE_SCALE } from "@kydo/sdk";

const usdFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function usd(x: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  const s = usdFmt.format(Math.abs(x));
  const neg = x < 0;
  const prefix = neg ? "-" : opts.sign && x > 0 ? "+" : "";
  return `${prefix}$${s}`;
}

/** Whole dollars, e.g. "$1,501". */
export function usdWhole(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return `${x < 0 ? "-" : ""}$${Math.round(Math.abs(x)).toLocaleString("en-US")}`;
}

export function usdCompact(x: number): string {
  if (Math.abs(x) >= 1_000_000) return `$${(x / 1_000_000).toFixed(2)}M`;
  if (Math.abs(x) >= 1_000) return `$${(x / 1_000).toFixed(x % 1000 === 0 ? 0 : 1)}k`;
  return usd(x);
}

/** Prices: 2–4 dp depending on magnitude. */
export function price(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  const dp = x >= 1000 ? 2 : x >= 10 ? 3 : 4;
  return x.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function pct(frac: number | null | undefined, dp = 2, sign = false): string {
  if (frac === null || frac === undefined || Number.isNaN(frac)) return "—";
  const v = frac * 100;
  const prefix = sign && v > 0 ? "+" : "";
  return `${prefix}${v.toFixed(dp)}%`;
}

export function qty(x: number | null | undefined): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  const dp = Math.abs(x) >= 100 ? 2 : Math.abs(x) >= 1 ? 4 : 6;
  return x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

export function time(ts: number | null | undefined, withDate = true): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const t = d.toISOString().slice(11, 19);
  return withDate ? `${d.toISOString().slice(0, 10)} ${t}` : t;
}

export function timeMs(ms: number): string {
  return time(Math.floor(ms / 1000));
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function countdown(untilTs: number): string {
  const s = Math.max(0, Math.floor(untilTs - Date.now() / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

export function shortAddr(a: string | null | undefined, n = 4): string {
  if (!a) return "—";
  return `${a.slice(0, n)}…${a.slice(-n)}`;
}

// ---------- chain scale helpers ----------
export const fromPrice = (x: BN | number | string) => Number(new BN(x.toString()).toString()) / PRICE_SCALE;
export const fromQty = (x: BN | number | string) => Number(new BN(x.toString()).toString()) / QTY_SCALE;
export const toPriceBN = (x: number) => new BN(Math.round(x * PRICE_SCALE));
export const toQtyBN = (x: number) => new BN(Math.round(x * QTY_SCALE));
export const fromShares = (x: BN | string) => Number(new BN(x.toString()).toString()) / Number(SHARE_SCALE.toString());
/**
 * Share count expressed in the dollars it was minted against.
 *
 * `fromShares` divides out SHARE_SCALE and nothing else, which is the raw share
 * count. NOT a dollar figure. The first deposit mints `amount × SHARE_SCALE`
 * where `amount` is already in PRICE_SCALE units, so one `fromShares` unit is
 * worth $0.000001 at inception, not $1. Dividing a dollar NAV by `fromShares`
 * therefore lands a factor of a million low; on the Common Pool panel that
 * printed a **−100.00% return on a pool that had lost nothing**.
 *
 * Use this whenever a share count has to meet a dollar figure.
 */
export const fromSharesUsd = (x: BN | string) => fromShares(x) / PRICE_SCALE;
/** NAV/share raw = nav(1e6) × 1e12 / shares; at seed 1 USDC / 1e9 dead shares = 1e9 raw == 1.0. */
export const npsToFloat = (nps: BN | string) => Number(new BN(nps.toString()).toString()) / 1e9;

export function bytesToHex(b: number[] | Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

export function decodeBytesString(b: number[] | Uint8Array): string {
  return new TextDecoder().decode(Uint8Array.from(b)).replace(/\0+$/, "");
}

/**
 * Tier 0 is how the program marks an instant-funded account. To a trader it
 * reads as a tier below the first one, which is the opposite of what it means.
 * They paid to skip straight to the Tier 1 cap. Name it wherever it is shown.
 */
export const tierLabel = (tier: number): string => (tier === 0 ? "Instant funding" : `Tier ${tier}`);
