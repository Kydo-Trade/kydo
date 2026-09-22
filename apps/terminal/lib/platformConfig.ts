/**
 * `config/platform*.jsonc` → `update_risk_params` arguments, in the browser.
 * Mirrors `stripJsonc` / `loadPlatformFile` / `toChainParams` in
 * scripts/bootstrap-devnet.ts (kept in sync by hand. The script is not importable here).
 */
import BN from "bn.js";
import { PRICE_SCALE } from "@kydo/sdk";
import type { ChainConfig } from "./chain";

const usd = (x: number) => new BN(Math.round(x * PRICE_SCALE));

export interface PlatformFile {
  entryFeeUsd: number;
  bountyPerPoolUsd: number;
  keeperBountyUsd: number;
  activationFloorUsd: number;
  minDepositUsd: number;
  tiers: { capsUsd: [number, number, number]; vestDays: [number, number, number]; promotionDays: number };
  daySecs: number;
  risk: Record<string, number>;
  trial: Record<string, number>;
}

/** JSONC → JSON: strip line comments and block comments (outside strings), then trailing commas. */
export function stripJsonc(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n;
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const RISK_KEYS = [
  "maxLeverageBps", "maxPositions", "maxSingleBps", "maxClusterBps", "dailyLossBps", "maxDrawdownBps", "minHoldSecs",
  "maxTradesPerDay", "oracleMaxAgeSlots", "oracleMaxConfBps", "limitBandBps", "redemptionLockupSecs", "cooldownSecs",
] as const;
const TRIAL_KEYS = ["startingBalanceUsd", "profitTargetBps", "maxDrawdownBps", "dailyLossBps", "minActiveDays", "minTrades", "maxDayProfitShareBps", "commitGraceDays"] as const;

/** Parse + validate the file text (same checks as the bootstrap loader, plus shape checks). Throws with a readable message. */
export function parsePlatformFile(text: string): PlatformFile {
  let cfg: PlatformFile;
  try {
    cfg = JSON.parse(stripJsonc(text));
  } catch (e) {
    throw new Error(`not valid JSONC: ${(e as Error).message}`);
  }
  const num = (v: unknown, path: string) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${path} must be a non-negative number`);
    return v;
  };
  for (const k of ["entryFeeUsd", "bountyPerPoolUsd", "keeperBountyUsd", "activationFloorUsd", "minDepositUsd", "daySecs"] as const) num(cfg[k], k);
  if (!cfg.tiers || typeof cfg.tiers !== "object") throw new Error("tiers missing");
  if (!Array.isArray(cfg.tiers.capsUsd) || cfg.tiers.capsUsd.length !== 3) throw new Error("tiers.capsUsd must have 3 entries");
  if (!Array.isArray(cfg.tiers.vestDays) || cfg.tiers.vestDays.length !== 3) throw new Error("tiers.vestDays must have 3 entries");
  cfg.tiers.capsUsd.forEach((v, i) => num(v, `tiers.capsUsd[${i}]`));
  cfg.tiers.vestDays.forEach((v, i) => num(v, `tiers.vestDays[${i}]`));
  num(cfg.tiers.promotionDays, "tiers.promotionDays");
  if (!cfg.risk || typeof cfg.risk !== "object") throw new Error("risk missing");
  if (!cfg.trial || typeof cfg.trial !== "object") throw new Error("trial missing");
  for (const k of RISK_KEYS) num(cfg.risk[k], `risk.${k}`);
  for (const k of TRIAL_KEYS) num(cfg.trial[k], `trial.${k}`);
  if (cfg.daySecs < 1) throw new Error("daySecs must be ≥ 1");
  if (cfg.bountyPerPoolUsd > cfg.entryFeeUsd) throw new Error("bountyPerPoolUsd must be ≤ entryFeeUsd");
  // Section 5.2 invariant enforced by the loader: the entry fee covers 80% of the worst Tier-1 loss
  const floor = cfg.tiers.capsUsd[0] * 0.8 * (cfg.risk.maxDrawdownBps / 10_000);
  if (cfg.entryFeeUsd < floor) throw new Error(`entryFeeUsd ${cfg.entryFeeUsd} < 80% × maxDrawdown × Tier-1 cap = ${floor} (section 5.2 invariant)`);
  return cfg;
}

export interface ChainParams {
  risk: {
    maxLeverageBps: number;
    maxPositions: number;
    maxSingleBps: number;
    maxClusterBps: number;
    dailyLossBps: number;
    maxDrawdownBps: number;
    minHoldSecs: number;
    maxTradesPerDay: number;
    oracleMaxAgeSlots: BN;
    oracleMaxConfBps: number;
    limitBandBps: number;
    redemptionLockupSecs: number;
    cooldownSecs: number;
    promotionDays: number;
  };
  trial: {
    startingBalance: BN;
    profitTargetBps: number;
    maxDrawdownBps: number;
    dailyLossBps: number;
    minActiveDays: number;
    minTrades: number;
    maxDayProfitShareBps: number;
    daySecs: number;
    commitGraceDays: number;
  };
  entryFee: BN;
  bountyPerPool: BN;
  keeperBounty: BN;
  activationFloor: BN;
  minDeposit: BN;
  tierCaps: [BN, BN, BN];
  vestDays: [number, number, number];
}

/** JSON file → on-chain argument shapes (BN for u64, numbers otherwise). Same mapping as the bootstrap script. */
export function toChainParams(c: PlatformFile): ChainParams {
  const risk = {
    maxLeverageBps: c.risk.maxLeverageBps,
    maxPositions: c.risk.maxPositions,
    maxSingleBps: c.risk.maxSingleBps,
    maxClusterBps: c.risk.maxClusterBps,
    dailyLossBps: c.risk.dailyLossBps,
    maxDrawdownBps: c.risk.maxDrawdownBps,
    minHoldSecs: c.risk.minHoldSecs,
    maxTradesPerDay: c.risk.maxTradesPerDay,
    oracleMaxAgeSlots: new BN(c.risk.oracleMaxAgeSlots),
    oracleMaxConfBps: c.risk.oracleMaxConfBps,
    limitBandBps: c.risk.limitBandBps,
    redemptionLockupSecs: c.risk.redemptionLockupSecs,
    cooldownSecs: c.risk.cooldownSecs,
    promotionDays: c.tiers.promotionDays,
  };
  const trial = {
    startingBalance: usd(c.trial.startingBalanceUsd),
    profitTargetBps: c.trial.profitTargetBps,
    maxDrawdownBps: c.trial.maxDrawdownBps,
    dailyLossBps: c.trial.dailyLossBps,
    minActiveDays: c.trial.minActiveDays,
    minTrades: c.trial.minTrades,
    maxDayProfitShareBps: c.trial.maxDayProfitShareBps,
    daySecs: c.daySecs,
    commitGraceDays: c.trial.commitGraceDays,
  };
  return {
    risk,
    trial,
    entryFee: usd(c.entryFeeUsd),
    bountyPerPool: usd(c.bountyPerPoolUsd),
    keeperBounty: usd(c.keeperBountyUsd),
    activationFloor: usd(c.activationFloorUsd),
    minDeposit: usd(c.minDepositUsd),
    tierCaps: c.tiers.capsUsd.map(usd) as [BN, BN, BN],
    vestDays: c.tiers.vestDays,
  };
}

/** `update_risk_params` argument object (attestor / price authority untouched). */
export function toUpdateArgs(p: ChainParams) {
  return {
    risk: p.risk,
    trial: p.trial,
    tierCaps: p.tierCaps,
    vestDays: p.vestDays,
    entryFee: p.entryFee,
    activationFloor: p.activationFloor,
    minDeposit: p.minDeposit,
    keeperBounty: p.keeperBounty,
    bountyPerPool: p.bountyPerPool,
    trialAttestor: null,
    priceAuthority: null,
  };
}

// ---------- flat views for the diff table ----------
export type FlatParams = Record<string, string>;

const n = (x: BN | number | string) => new BN(x.toString()).toString();
const dollars = (x: BN | number | string) => `$${(Number(new BN(x.toString()).toString()) / PRICE_SCALE).toLocaleString("en-US")}`;

/** Every tunable as `group.key → display string`; identical keys on both sides so rows line up. */
export function flattenParams(p: ChainParams): FlatParams {
  const out: FlatParams = {};
  out["entryFee"] = dollars(p.entryFee);
  out["bountyPerPool"] = dollars(p.bountyPerPool);
  out["keeperBounty"] = dollars(p.keeperBounty);
  out["activationFloor"] = dollars(p.activationFloor);
  out["minDeposit"] = dollars(p.minDeposit);
  p.tierCaps.forEach((c, i) => (out[`tierCaps[${i}]`] = dollars(c)));
  p.vestDays.forEach((d, i) => (out[`vestDays[${i}]`] = String(d)));
  for (const [k, v] of Object.entries(p.risk)) out[`risk.${k}`] = n(v as BN | number);
  for (const [k, v] of Object.entries(p.trial)) out[`trial.${k}`] = k === "startingBalance" ? dollars(v as BN) : n(v as BN | number);
  return out;
}

export function flattenChainConfig(c: ChainConfig): FlatParams {
  return flattenParams({
    risk: { ...c.risk, oracleMaxAgeSlots: new BN(c.risk.oracleMaxAgeSlots.toString()) },
    trial: { ...c.trial, startingBalance: new BN(c.trial.startingBalance.toString()) },
    entryFee: new BN(c.entryFee.toString()),
    bountyPerPool: new BN(c.bountyPerPool.toString()),
    keeperBounty: new BN(c.keeperBounty.toString()),
    activationFloor: new BN(c.activationFloor.toString()),
    minDeposit: new BN(c.minDeposit.toString()),
    tierCaps: c.tierCaps.map((x) => new BN(x.toString())) as [BN, BN, BN],
    vestDays: c.vestDays.slice(0, 3) as [number, number, number],
  });
}

export interface DiffRow {
  key: string;
  onChain: string;
  file: string;
  changed: boolean;
}

export function diffParams(chain: ChainConfig, file: ChainParams): DiffRow[] {
  const a = flattenChainConfig(chain);
  const b = flattenParams(file);
  return Object.keys(b).map((key) => ({ key, onChain: a[key] ?? "—", file: b[key], changed: a[key] !== b[key] }));
}
