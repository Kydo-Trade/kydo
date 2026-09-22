/** Typed fetchers for the indexer (C5) and trial engine (C3). */
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { PublicKey } from "@solana/web3.js";
import type { MerkleProof, TrialOrderEntry } from "@kydo/sdk";
import { API_URL, TRIAL_URL } from "./config";

// ---------- shapes ----------
export type Status = "funding" | "live" | "locked" | "settled";
export type LockReason = "none" | "daily_loss" | "drawdown" | "voluntary";
export type Mandate = "spot" | "perps";
export type TraderStatusJson = "applied" | "trial" | "failed" | "eligible" | "frozen";

export interface TraderSummary {
  wallet: string;
  status: TraderStatusJson;
  attempts: number;
  trialsFailed: number;
  poolsCreated: number;
  poolsLocked: number;
  tier: number;
  liveDaysAtTier: number;
}

export interface PoolSummary {
  address: string;
  trader: string;
  index: number;
  name: string;
  strategy: string | null;
  mandate: Mandate;
  status: Status;
  lockReason: LockReason;
  tier: number;
  cap: number;
  liveDaysAtTier: number;
  tierStartTs: number;
  /** Total pool equity, the trader's first-loss seed included. This is what
   *  the loss limits, the drawdown and the health factor measure. */
  nav: number;
  tvl: number;
  /** What the shares are actually worth: `nav` minus the unspent cushion.
   *  Deposits are priced and redemptions paid at this. */
  investorNav?: number;
  navPerShare: number;
  roi: number; // lifetime NAV/share − 1 (includes the first-loss seed cushion)
  fundingNps: number; // NAV/share at funding (post fee-seed). The performance baseline
  seedCushion: number; // fundingNps − 1: head start from the trader's forfeited fee, not performance
  perf: number; // trading performance since funding. The honest ROI
  tradingPnl: number; // realized + unrealized, USD
  unrealizedPnl: number;
  maxDrawdown: number;
  currentDrawdown: number;
  dailyPnlPct: number;
  /** NAV / the binding loss floor. <= 1 means liquidatable now; null before the
   *  pool has marked. The same number the liquidation queue ranks on. */
  healthFactor?: number | null;
  /** USD the pool can still lose before it is liquidatable. */
  distanceToLiquidation?: number | null;
  liquidationFloors?: { daily: number; drawdown: number; trigger: number } | null;
  /** Trader capital standing in front of investor capital. Spent first. */
  firstLossSeed?: number;
  /** How much of it survives at the current mark. Falls with every adverse
   *  tick; this is what actually backs the liquidation buffer right now. */
  firstLossRemaining?: number;
  /** Investor cash in the pool. The reference the cushion is measured from. */
  investorPrincipal?: number;
  openPositions: number;
  totalTrades: number;
  realizedPnl: number;
  escrowTotal: number;
  vestedClaimable: number;
  createdAt: number;
  activatedAt: number | null;
  lockedAt: number | null;
  lastMarkTs: number;
  ageDays: number;
  investorCount: number;
  traderProfile: TraderSummary;
}

export interface Position {
  marketId: number;
  symbol: string;
  side: "long" | "short";
  cluster: number;
  baseQty: number;
  entryPrice: number;
  markPrice: number;
  notional: number;
  unrealizedPnl: number;
  openedAt: number;
}

export interface Trade {
  sig: string;
  ts: number;
  pool: string;
  marketId: number;
  symbol: string;
  side: "long" | "short";
  isClose: boolean;
  baseQty: number;
  fillPrice: number;
  oraclePrice: number;
  oracleSlot: number;
  fee: number;
  realizedPnl: number;
  navAfter: number;
  positionQtyAfter: number;
}

export interface EquityPoint {
  ts: number;
  nav: number;
  navPerShare: number;
}

export interface InvestorPositionJson {
  pool: PoolSummary;
  /** 1e12-scaled share count as a decimal string */
  shares: string;
  value: number;
  costBasis: number;
  pnl: number;
  lastDepositTs: number;
  lockupEndsAt: number;
  pendingShares?: string;
  unwound?: boolean;
  unwindCost?: number;
}

export interface PoolDetail extends PoolSummary {
  positions: Position[];
  equity: EquityPoint[];
  trades: Trade[];
  hwmNps: number;
  peakNav: number;
  dayStartNav: number;
  escrowBuckets: { amount: number; unlockDay: number }[];
  pendingRedemptionShares: string;
  riskDisclosure: string;
}

export interface RiskJson {
  maxLeverageBps: number;
  maxPositions: number;
  maxSingleBps: number;
  maxClusterBps: number;
  dailyLossBps: number;
  maxDrawdownBps: number;
  minHoldSecs: number;
  maxTradesPerDay: number;
  oracleMaxAgeSlots: number;
  oracleMaxConfBps: number;
  limitBandBps: number;
  redemptionLockupSecs: number;
  cooldownSecs: number;
  promotionDays: number;
}

export interface TrialCriteriaJson {
  startingBalance: number;
  profitTargetBps: number;
  maxDrawdownBps: number;
  dailyLossBps: number;
  minActiveDays: number;
  minTrades: number;
  maxDayProfitShareBps: number;
  daySecs: number;
  commitGraceDays: number;
}

export interface ConfigJson {
  programId: string;
  usdcMint: string;
  entryFee: number;
  tierCaps: [number, number, number];
  vestDays: [number, number, number];
  activationFloor: number;
  minDeposit: number;
  keeperBounty: number;
  paused: boolean;
  risk: RiskJson;
  trial: TrialCriteriaJson;
}

export interface PriceJson {
  price: number;
  conf: number;
  ts: number;
}

export interface MarketJson {
  marketId: number;
  symbol: string;
  oracle: string;
  cluster: number;
  maxLeverageBps: number;
  enabled: boolean;
  venueMarketIndex: number;
  price: PriceJson | null;
  /** Open interest: total open position notional across all pools (USD). */
  oiUsd?: number;
}

export interface HealthJson {
  ok: boolean;
  slot: number;
  lagMs: number;
  lastEventTs: number;
  wsClients?: number;
  cluster?: "localnet" | "devnet" | "testnet" | "mainnet" | "custom";
  rpcUrl?: string;
  faucet?: boolean;
  usdcMint?: string | null;
  /** Age of the freshest served price, seconds. Null when no price is known. */
  priceAgeSecs?: number | null;
  /** Where the served prices came from this cycle. `chain` means the on-chain
   *  oracles are fresh. Anything else means the keeper is behind and the
   *  indexer is papering over it for display only, while the program (and
   *  therefore trading) still sees stale oracles. */
  priceSource?: "chain" | "hermes" | "exchange" | "mixed" | "none";
  /** which alert sinks the indexer has configured (ALERT_WEBHOOK_URL / ALERT_SLACK_WEBHOOK_URL) */
  alerts?: { webhook: boolean; slack: boolean };
}

export interface TrialRootJson {
  day: number;
  root: string;
  ts: number;
  sig: string;
}

export interface TraderDetail {
  profile: TraderSummary & {
    trialStartTs: number;
    trialDaysCommitted: number;
    trialRoot: string;
    cooldownUntil: number;
    activePool: string | null;
    trialRoots: TrialRootJson[];
  };
  pools: PoolSummary[];
  events: { type: string; ts: number; sig: string; data: unknown }[];
}

interface AlertBase {
  id: number;
  ts: number;
  acked: boolean;
}
/** section 4.6 cross-pool hedge: opposing positions in one market, similar notional, opened within the window. */
export interface HedgeAlert extends AlertBase {
  type: "cross_pool_hedge";
  poolA: string;
  poolB: string;
  traderA: string | null;
  traderB: string | null;
  marketId: number;
  symbol: string;
  openedWithinSecs: number;
  notionalA: number;
  notionalB: number;
}
export interface PoolLockedAlert extends AlertBase {
  type: "pool_locked";
  pool: string;
  trader: string | null;
  reason: LockReason;
  nav: number;
  escrowReturned: number;
  caller: string | null;
  sig: string;
}
export interface PlatformPausedAlert extends AlertBase {
  type: "platform_paused";
  paused: boolean;
  sig: string;
}
export type Alert = HedgeAlert | PoolLockedAlert | PlatformPausedAlert;

export interface EventJson {
  name: string;
  ts: number;
  sig: string;
  slot: number;
  data: unknown;
}

// trial engine
export interface TrialMetrics {
  finalEquity: number;
  profitPct: number;
  maxDrawdownBps: number;
  maxDailyLossBps: number;
  activeDays: number;
  trades: number;
  maxDayProfitShareBps: number;
  passing: {
    profitTarget: boolean;
    drawdown: boolean;
    dailyLoss: boolean;
    activeDays: boolean;
    trades: boolean;
    consistency: boolean;
    all: boolean;
  };
}

export interface TrialState {
  wallet: string;
  exists: boolean;
  onChainStatus: "none" | TraderStatusJson;
  startTs: number;
  daySecs: number;
  day: number;
  daysCommitted: number;
  balance: number;
  equity: number;
  dayStartEquity: number;
  peakEquity: number;
  positions: Position[];
  metrics: TrialMetrics;
  riskUtil: { daily: number; drawdown: number; leverage: number; warn: boolean };
  dayRoots: { day: number; root: string; entries: number; committed: boolean }[];
  tradesToday: number;
}

export interface TrialFill {
  fillPrice: number;
  baseQty: number;
  fee: number;
  realizedPnl: number;
  oraclePrice: number;
}

export interface TrialOrderRequest {
  marketId: number;
  side: "long" | "short";
  action: "open" | "close";
  notional?: number;
  baseQty?: number;
  limitPx?: number;
  /** Stop trigger (open only). Required by the trial engine, as on-chain. */
  stopPx?: number;
}

export interface TrialOrderResponse {
  ok: true;
  fill: TrialFill;
  entry: TrialOrderEntry;
  state: TrialState;
}

export interface TrialExport {
  wallet: string;
  startTs: number;
  entries: TrialOrderEntry[];
  dayRoots: { day: number; root: string }[];
  proofs: MerkleProof[];
}

export interface TrialFinalizeResponse {
  ok: boolean;
  sig?: string;
  passed?: boolean;
  forced?: boolean;
  failReason?: string | number;
  error?: string;
}

// ---------- WS message shapes ----------
export type WsMessage =
  | { type: "price"; marketId: number; symbol: string; price: number; conf: number; ts: number }
  | { type: "nav"; pool: string; nav: number; navPerShare: number; peakNav: number; dayStartNav: number; grossNotional: number; ts: number }
  | { type: "trade"; trade: Trade }
  | { type: "lock"; pool: string; reason: LockReason; nav: number; ts: number }
  | { type: "event"; name: string; pool?: string; ts: number; data: unknown }
  | { type: "alert"; alert: Alert }
  | { type: "alert_ack"; id: number; ts: number };

// ---------- fetch helpers ----------
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

async function getJson<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, { cache: "no-store", ...init });
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body as any)?.error ?? (body as any)?.message ?? `${res.status} ${res.statusText}`;
    throw new ApiError(String(msg), res.status, body);
  }
  return body as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  return p.length ? "?" + p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&") : "";
};

// ---------- indexer ----------
/**
 * `GET /common-pool`. Whether the shared funding pool can fund a trader right
 * now, and how many are ahead of them. The onboarding flow needs this to say
 * "funded instantly" or "queued" without guessing; the indexer mirrors
 * `fund_next_in_queue`'s own arithmetic so the two can't disagree.
 */
export interface CommonPoolCapacityJson {
  ready: boolean;
  idleUsd?: number;
  deployableUsd?: number;
  reserveBps?: number;
  minFirstLossBps?: number;
  depositEnabled?: boolean;
  activeStakes?: number;
  depositedTotalUsd?: number;
  fundedTotalUsd?: number;
  queueDepth?: number;
  nextTicket?: number;
  nextToFund?: number;
  maxFundableCapUsd?: number;
  fundableByTier?: { tier: number; capUsd: number; fundable: boolean }[];
}

export const indexer = {
  health: () => getJson<HealthJson>(API_URL, "/health"),
  /** Claim cooldown + history for the design-style Claim USDC button. */
  faucetStatus: (wallet: string) =>
    getJson<{ ok: boolean; cooldownHours: number; claimUsd: number; canClaim: boolean; nextAt: number; history: { ts: number; usd: number; sol: number; ok: boolean; error?: string }[] }>(API_URL, `/faucet/status${qs({ wallet })}`),
  faucetClaim: (wallet: string) =>
    getJson<{ ok: boolean; usd: number; sol: number; note?: string }>(API_URL, "/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet }) }),
  priceHistory: (marketId?: number, from?: number) =>
    getJson<{ history: Record<string, { ts: number; price: number }[]> }>(API_URL, `/prices/history${qs({ marketId, from })}`),
  /** OHLC chart history (Binance klines via the indexer). Display-only. tf: 1m|5m|15m|1h|4h|1d; from/to unix secs. */
  candles: (marketId: number, opts: { tf?: string; from?: number; to?: number; limit?: number } = {}) =>
    getJson<{ marketId: number; tf: string; candles: { time: number; open: number; high: number; low: number; close: number; v?: number }[] }>(API_URL, `/candles${qs({ marketId, ...opts })}`),
  config: () => getJson<ConfigJson>(API_URL, "/config"),
  commonPool: () => getJson<CommonPoolCapacityJson>(API_URL, "/common-pool"),
  markets: () => getJson<{ markets: MarketJson[] }>(API_URL, "/markets"),
  prices: () => getJson<Record<string, PriceJson>>(API_URL, "/prices"),
  /** The connected wallet's investor positions across all pools (value, PnL, lockup, pending redemption). */
  investor: (wallet: string) => getJson<{ positions: InvestorPositionJson[] }>(API_URL, `/investors/${wallet}`),
  pools: (params: {
    status?: Status;
    mandate?: Mandate;
    sort?: "roi" | "drawdown" | "age" | "tvl";
    order?: "asc" | "desc";
    minAgeDays?: number;
    maxDrawdown?: number;
    limit?: number;
    offset?: number;
  } = {}) => getJson<{ pools: PoolSummary[]; total: number }>(API_URL, `/pools${qs(params)}`),
  pool: (address: string) => getJson<PoolDetail>(API_URL, `/pools/${address}`),
  poolTrades: (address: string, params: { limit?: number; before?: number } = {}) =>
    getJson<{ trades: Trade[] }>(API_URL, `/pools/${address}/trades${qs(params)}`),
  poolEquity: (address: string, params: { from?: number; to?: number } = {}) =>
    getJson<{ points: EquityPoint[] }>(API_URL, `/pools/${address}/equity${qs(params)}`),
  trader: (wallet: string) => getJson<TraderDetail>(API_URL, `/traders/${wallet}`),
  alerts: (params: { since?: number; limit?: number; acked?: "false"; type?: Alert["type"] } = {}) =>
    getJson<{ alerts: Alert[] }>(API_URL, `/alerts${qs(params)}`),
  ackAlert: (id: number) => getJson<{ ok: boolean; alert: Alert }>(API_URL, `/alerts/${id}/ack`, { method: "POST" }),
  events: (params: { pool?: string; type?: string; limit?: number } = {}) =>
    getJson<{ events: EventJson[] }>(API_URL, `/events${qs(params)}`),
  postStrategy: (address: string, text: string) =>
    getJson<{ ok: boolean }>(API_URL, `/pools/${address}/strategy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
};

// ---------- trial engine (signed requests) ----------
export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

export interface Signer {
  publicKey: PublicKey;
  signMessage: SignMessage;
}

/**
 * Signed POST: `x-wallet` + `x-signature` = bs58(ed25519 over the exact UTF-8 body bytes).
 * The body always carries `ts` (unix ms).
 */
export async function signedPost<T>(base: string, path: string, signer: Signer, body: Record<string, unknown>): Promise<T> {
  const payload = JSON.stringify({ ...body, ts: Date.now() });
  const bytes = new TextEncoder().encode(payload);
  const sig = await signer.signMessage(bytes);
  // sanity: the wallet must have produced a valid signature over exactly these bytes
  if (!nacl.sign.detached.verify(bytes, sig, signer.publicKey.toBytes())) {
    throw new Error("Wallet signature did not verify over the request body");
  }
  return getJson<T>(base, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wallet": signer.publicKey.toBase58(),
      "x-signature": bs58.encode(sig),
    },
    body: payload,
  });
}

export const trial = {
  health: () => getJson<{ ok: boolean; devForcePass?: boolean }>(TRIAL_URL, "/health"),
  /** section 4.2 venue depth per market. MaxOrderUsd is the 10%-of-visible-depth order cap. */
  markets: () => getJson<{ markets: { marketId: number; symbol: string; cluster: number; enabled: boolean; depthUsd: number; maxOrderUsd: number }[] }>(TRIAL_URL, "/markets"),
  state: (wallet: string) => getJson<TrialState>(TRIAL_URL, `/trial/${wallet}`),
  orders: (wallet: string, day?: number) =>
    getJson<{ entries: TrialOrderEntry[] }>(TRIAL_URL, `/trial/${wallet}/orders${qs({ day })}`),
  root: (wallet: string, day: number) =>
    getJson<{ day: number; root: string; entries: number }>(TRIAL_URL, `/trial/${wallet}/roots/${day}`),
  export: (wallet: string) => getJson<TrialExport>(TRIAL_URL, `/trial/${wallet}/export`),
  metrics: (wallet: string) => getJson<TrialMetrics>(TRIAL_URL, `/trial/${wallet}/metrics`),
  placeOrder: (signer: Signer, req: TrialOrderRequest) =>
    signedPost<TrialOrderResponse>(TRIAL_URL, `/trial/${signer.publicKey.toBase58()}/orders`, signer, { ...req }),
  finalize: (signer: Signer, force = false) =>
    signedPost<TrialFinalizeResponse>(TRIAL_URL, `/trial/${signer.publicKey.toBase58()}/finalize`, signer, force ? { force: true } : {}),
};
