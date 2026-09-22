import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

/** Program id. Overridable via env for devnet redeploys. */
export const VAULT_PROGRAM_ID = new PublicKey(
  process.env.VAULT_PROGRAM_ID ??
    process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID ??
    "G4E1BiuovMpeUCgyh2222GqAQt4cW5dXSovZipFd89T1",
);

export const PYTH_RECEIVER_PROGRAM_ID = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
export const DRIFT_PROGRAM_ID = new PublicKey("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");

export const SEEDS = {
  platform: Buffer.from("platform"),
  registry: Buffer.from("registry"),
  treasury: Buffer.from("treasury"),
  treasuryVault: Buffer.from("treasury_vault"),
  trader: Buffer.from("trader"),
  pool: Buffer.from("pool"),
  poolVault: Buffer.from("pool_vault"),
  investor: Buffer.from("investor"),
  mockOracle: Buffer.from("mock_oracle"),
  session: Buffer.from("session"),
  commonPool: Buffer.from("common_pool"),
  commonVault: Buffer.from("common_vault"),
  commonInvestor: Buffer.from("common_investor"),
  ticket: Buffer.from("ticket"),
};

/** USDC has 6 decimals; prices are 1e6-scaled; base qty 1e9; shares 1e12. */
export const USDC_DECIMALS = 6;
export const PRICE_SCALE = 1_000_000;
export const QTY_SCALE = 1_000_000_000;
export const SHARE_SCALE = new BN("1000000000000");
export const DEAD_SHARES = new BN("1000000000");
export const BPS = 10_000;
export const TRIAL_DAYS = 30;
export const TRADER_SPLIT_BPS = 8_000;
/** Platform performance fee, carved out of the pool's former 20% (80/15/5). */
export const PLATFORM_FEE_BPS = 500;
/** Share of a collected platform fee that replenishes the keeper bounty reserve. */
export const PLATFORM_FEE_BOUNTY_BPS = 5_000;
export const MOCK_SPREAD_BPS = 5;
export const MOCK_FEE_BPS = 5;

/**
 * Tier 0 = instant funding. It trades under tighter loss limits than the
 * platform-wide ones until the first promotion. The price of skipping the
 * evaluation. Mirrors `INSTANT_DAILY_LOSS_BPS` / `INSTANT_MAX_DRAWDOWN_BPS` in
 * the program's `constants.rs`; apply them with `effectiveRisk`.
 */
export const INSTANT_TIER = 0;
export const INSTANT_DAILY_LOSS_BPS = 300;
export const INSTANT_MAX_DRAWDOWN_BPS = 800;
/** Assumed fill slippage past a stop trigger. Display only: stops are a trader
 *  tool now, so nothing on-chain reads this. Risk is bounded by liquidation. */
export const STOP_SLIPPAGE_BPS = 100;

export const usd = (x: number) => new BN(Math.round(x * PRICE_SCALE));
export const fromUsd = (x: BN | bigint | number) => Number(x.toString()) / PRICE_SCALE;

export enum Side {
  None = 0,
  Long = 1,
  Short = 2,
}

export enum LockReason {
  None = 0,
  DailyLoss = 1,
  Drawdown = 2,
  Voluntary = 3,
}

export enum TrialFailReason {
  None = 0,
  MissedDay = 1,
  ProfitTarget = 2,
  Drawdown = 3,
  DailyLoss = 4,
  ActiveDays = 5,
  MinTrades = 6,
  Consistency = 7,
}

export const Cluster = { Other: 0, Majors: 1, L1: 2, Memes: 3 } as const;

/**
 * Default MVP market set (section 4.9). Pyth feed ids are the canonical Hermes ids.
 *
 * Every id here must be covered by the deployment's Hermes plan. Hermes 403s an
 * entire request if any single id in it is not permitted, so one unpriceable
 * market costs every other market its price too. Check a new feed against the
 * key before adding it.
 * Ids are stable identities, not indices: 4 is absent because that market was
 * retired, and `register_market` keys on `market_id`, so the gap is deliberate
 * and must stay. Reusing 4 would rebind any position still stored against it.
 *
 * `driftIndex` is the Drift perp market index (identical on devnet and
 * mainnet, protocol-v2 v2.162.0 `DevnetPerpMarkets`/`MainnetPerpMarkets`):
 * SOL 0, BTC 1, ETH 2, DOGE 7, BNB 8. It is stored as
 * `MarketInfo.venue_market_index` and used verbatim in Drift order params.
 */
export const DEFAULT_MARKETS = [
  { marketId: 1, symbol: "SOL", feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", cluster: Cluster.L1, driftIndex: 0, maxLeverageBps: 100_000 },
  { marketId: 2, symbol: "BTC", feedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", cluster: Cluster.Majors, driftIndex: 1, maxLeverageBps: 100_000 },
  { marketId: 3, symbol: "ETH", feedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", cluster: Cluster.Majors, driftIndex: 2, maxLeverageBps: 100_000 },
  { marketId: 5, symbol: "BNB", feedId: "2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f", cluster: Cluster.L1, driftIndex: 8, maxLeverageBps: 50_000 },
  { marketId: 6, symbol: "DOGE", feedId: "dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c", cluster: Cluster.Memes, driftIndex: 7, maxLeverageBps: 50_000 },
];
