/**
 * Drift v2 helpers for `Venue::Drift` pools (C2, section 3.3).
 *
 * What lives here:
 *  - Drift PDAs (state, user, user_stats, spot market / vault, perp market, signer)
 *  - the remaining-account blocks the vault program expects for each
 *    instruction family (`driftInitAccounts`, `driftNavAccounts`, `driftTradeAccounts`)
 *  - devnet constants (USDC spot market 0, perp market indices)
 *  - a minimal decoder for Drift `User` / `SpotMarket` / `PerpMarket` accounts
 *    and a TS mirror of the program's venue-equity formula
 *  - a `settle_pnl` instruction builder for the keeper
 *
 * Layouts, discriminators and indices target protocol-v2 **v2.162.0** and
 * match `programs/vault/src/venue/drift.rs` byte for byte
 * (see the Drift integration notes).
 */
import { AccountMeta, Connection, PublicKey, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { DRIFT_PROGRAM_ID } from "./constants";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Every pool uses Drift sub-account 0 with `authority = pool PDA`. */
export const DRIFT_SUB_ACCOUNT_ID = 0;
/** USDC is Drift's quote spot market on every cluster. */
export const DRIFT_USDC_SPOT_MARKET_INDEX = 0;
/** Drift precisions. BASE 1e9 == QTY_SCALE, PRICE/QUOTE 1e6 == PRICE_SCALE. */
export const DRIFT_BASE_PRECISION = 1_000_000_000;
export const DRIFT_PRICE_PRECISION = 1_000_000;
export const DRIFT_QUOTE_PRECISION = 1_000_000;
export const DRIFT_SPOT_BALANCE_PRECISION = 1_000_000_000;
export const DRIFT_SPOT_CUMULATIVE_INTEREST_PRECISION = 10_000_000_000;

/** `sha256("global:<name>")[..8]`. Identical to `venue::drift::ix`. */
export const DRIFT_IX = {
  initializeUserStats: Buffer.from([254, 243, 72, 98, 251, 130, 168, 213]),
  initializeUser: Buffer.from([111, 17, 185, 250, 60, 122, 38, 254]),
  updateUserDelegate: Buffer.from([139, 205, 141, 141, 113, 36, 94, 187]),
  deposit: Buffer.from([242, 35, 198, 137, 82, 225, 242, 182]),
  withdraw: Buffer.from([183, 18, 70, 156, 148, 109, 161, 34]),
  placeAndTakePerpOrder: Buffer.from([213, 51, 1, 187, 108, 220, 230, 224]),
  settlePnl: Buffer.from([43, 61, 234, 45, 15, 95, 152, 153]),
} as const;

/** `sha256("account:<Name>")[..8]`. Identical to `venue::drift::acct`. */
export const DRIFT_ACCOUNT = {
  user: Buffer.from([159, 117, 95, 227, 239, 151, 58, 236]),
  userStats: Buffer.from([176, 223, 136, 27, 122, 79, 32, 227]),
  spotMarket: Buffer.from([100, 177, 8, 107, 168, 65, 65, 39]),
  perpMarket: Buffer.from([10, 223, 12, 44, 107, 245, 55, 247]),
} as const;

/** Byte offsets (from account-data start, discriminator included). See `venue::drift::layout`. */
export const DRIFT_LAYOUT = {
  USER_SIZE: 4376,
  USER_AUTHORITY: 8,
  USER_DELEGATE: 40,
  USER_SPOT_POSITIONS: 104,
  SPOT_POSITIONS_LEN: 8,
  SPOT_POSITION_SIZE: 40,
  USER_PERP_POSITIONS: 424,
  PERP_POSITIONS_LEN: 8,
  PERP_POSITION_SIZE: 96,
  USER_SETTLED_PERP_PNL: 4296,
  USER_CUMULATIVE_PERP_FUNDING: 4312,
  USER_SUB_ACCOUNT_ID: 4346,
  PP_BASE_ASSET_AMOUNT: 8,
  PP_QUOTE_ASSET_AMOUNT: 16,
  PP_QUOTE_BREAK_EVEN_AMOUNT: 24,
  PP_QUOTE_ENTRY_AMOUNT: 32,
  PP_LP_SHARES: 64,
  PP_MARKET_INDEX: 92,
  PP_OPEN_ORDERS: 94,
  SP_SCALED_BALANCE: 0,
  SP_CUMULATIVE_DEPOSITS: 24,
  SP_MARKET_INDEX: 32,
  SP_BALANCE_TYPE: 34,
  USER_STATS_SIZE: 240,
  US_TOTAL_FEE_PAID: 72,
  SPOT_MARKET_SIZE: 776,
  SM_ORACLE: 40,
  SM_MINT: 72,
  SM_VAULT: 104,
  SM_CUMULATIVE_DEPOSIT_INTEREST: 464,
  SM_DECIMALS: 680,
  SM_MARKET_INDEX: 684,
  PERP_MARKET_SIZE: 1216,
  PM_AMM_ORACLE: 40,
  PM_MARKET_INDEX: 1160,
} as const;

export interface DriftPerpMarketInfo {
  symbol: string;
  index: number;
  /** `PerpMarket.amm.oracle` as published in protocol-v2 v2.162.0 `DevnetPerpMarkets`. Prefer `fetchDriftOracles` at runtime. */
  oracle: PublicKey;
  oracleSource: string;
}

/**
 * Drift devnet constants (protocol-v2 v2.162.0 `sdk/src/constants`).
 * Perp indices are the same on mainnet; oracle accounts are devnet-only and
 * can rotate. Read them on-chain with `fetchDriftOracles` when possible.
 */
export const DRIFT_DEVNET = {
  programId: DRIFT_PROGRAM_ID,
  usdcMint: new PublicKey("8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2"),
  usdcSpotMarketIndex: DRIFT_USDC_SPOT_MARKET_INDEX,
  usdcSpotOracle: new PublicKey("9VCioxmni2gDLv11qufWzT3RDERhQE4iY5Gf7NTfYyAV"),
  perpMarkets: {
    SOL: { symbol: "SOL-PERP", index: 0, oracle: new PublicKey("3m6i4RFWEDw2Ft4tFHPJtYgmpPe21k56M3FHeWYrgGBz"), oracleSource: "PYTH_LAZER" },
    BTC: { symbol: "BTC-PERP", index: 1, oracle: new PublicKey("35MbvS1Juz2wf7GsyHrkCw8yfKciRLxVpEhfZDZFrB4R"), oracleSource: "PYTH_LAZER" },
    ETH: { symbol: "ETH-PERP", index: 2, oracle: new PublicKey("93FG52TzNKCnMiasV14Ba34BYcHDb9p4zK4GjZnLwqWR"), oracleSource: "PYTH_LAZER" },
    DOGE: { symbol: "DOGE-PERP", index: 7, oracle: new PublicKey("23y63pHVwKfYSCDFdiGRaGbTYWoyr8UzhUE7zukyf6gK"), oracleSource: "PYTH_PULL" },
    BNB: { symbol: "BNB-PERP", index: 8, oracle: new PublicKey("Dk8eWjuQHMbxJAwB9Sg7pXQPH4kgbg8qZGcUrWcD9gTm"), oracleSource: "PYTH_PULL" },
  } as Record<string, DriftPerpMarketInfo>,
};

// ---------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------

const u16le = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};

export function driftPdas(programId: PublicKey = DRIFT_PROGRAM_ID) {
  const find = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  return {
    state: () => find([Buffer.from("drift_state")]),
    /** Drift `User` for `authority` (the pool PDA) and `subAccountId` (0). */
    user: (authority: PublicKey, subAccountId = DRIFT_SUB_ACCOUNT_ID) =>
      find([Buffer.from("user"), authority.toBuffer(), u16le(subAccountId)]),
    userStats: (authority: PublicKey) => find([Buffer.from("user_stats"), authority.toBuffer()]),
    spotMarket: (marketIndex: number) => find([Buffer.from("spot_market"), u16le(marketIndex)]),
    spotMarketVault: (marketIndex: number) => find([Buffer.from("spot_market_vault"), u16le(marketIndex)]),
    perpMarket: (marketIndex: number) => find([Buffer.from("perp_market"), u16le(marketIndex)]),
    signer: () => find([Buffer.from("drift_signer")]),
  };
}

export const DRIFT_PDA = driftPdas();

// ---------------------------------------------------------------------------
// Remaining-account blocks expected by the vault program
// ---------------------------------------------------------------------------

const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });

/**
 * `create_pool` with `venue: { drift: {} }`. Appended as remaining accounts.
 * Block: [Drift program, State(mut), User PDA(mut), UserStats PDA(mut), Rent].
 * The trader pays rent for both Drift accounts (~0.035 SOL) plus Drift's
 * optional init fee.
 */
export function driftInitAccounts(pool: PublicKey, programId: PublicKey = DRIFT_PROGRAM_ID): AccountMeta[] {
  const pda = driftPdas(programId);
  return [ro(programId), rw(pda.state()), rw(pda.user(pool)), rw(pda.userStats(pool)), ro(SYSVAR_RENT_PUBKEY)];
}

/**
 * Accounts every NAV read needs on a Drift pool (deposit, evaluate_risk,
 * lock_pool, promote_tier, claim_trader_fees, and. Together with the
 * registry oracles. Anything that calls `mark_positions`):
 * the pool's Drift `User` and the USDC `SpotMarket`. Order-independent.
 */
export function driftNavAccounts(pool: PublicKey, programId: PublicKey = DRIFT_PROGRAM_ID): AccountMeta[] {
  const pda = driftPdas(programId);
  return [ro(pda.user(pool)), ro(pda.spotMarket(DRIFT_USDC_SPOT_MARKET_INDEX))];
}

export interface DriftMarketRef {
  /** Drift perp market index (`MarketInfo.venue_market_index`). */
  perpMarketIndex: number;
  /** `PerpMarket.amm.oracle`. From `DRIFT_DEVNET` or `fetchDriftOracles`. */
  oracle: PublicKey;
}

/**
 * Full Drift trade block for `place_trade`, `close_trade`, `unwind_all`,
 * `unwind_for_redemption`, `request_redemption`, `settle_redemption` and
 * `reap_pool`. Append it **after** the registry oracle metas.
 *
 * Layout (see `venue::drift::DriftAccounts`):
 *   [0] Drift program (marker)      [1] State
 *   [2] User (== pool.venue_account) [3] UserStats
 *   [4] USDC spot market vault       [5] Drift signer
 *   [6] pool USDC vault              [7] SPL token program
 *   [8…] tail forwarded to Drift, in the order Drift's `load_maps` consumes it:
 *        oracles… (USDC oracle + every perp oracle), spot markets… (USDC), perp markets…
 *
 * `markets` must include the traded market **and** every market the pool has
 * a position on (Drift needs all of them for its margin check).
 */
export function driftTradeAccounts(
  pool: PublicKey,
  poolVault: PublicKey,
  markets: DriftMarketRef[],
  usdcOracle: PublicKey = DRIFT_DEVNET.usdcSpotOracle,
  programId: PublicKey = DRIFT_PROGRAM_ID,
): AccountMeta[] {
  const pda = driftPdas(programId);
  const seenOracle = new Set<string>([usdcOracle.toBase58()]);
  const seenMarket = new Set<number>();
  const oracles: AccountMeta[] = [ro(usdcOracle)];
  const perps: AccountMeta[] = [];
  for (const m of markets) {
    if (!seenOracle.has(m.oracle.toBase58())) {
      seenOracle.add(m.oracle.toBase58());
      oracles.push(ro(m.oracle));
    }
    if (!seenMarket.has(m.perpMarketIndex)) {
      seenMarket.add(m.perpMarketIndex);
      perps.push(rw(pda.perpMarket(m.perpMarketIndex)));
    }
  }
  return [
    ro(programId),
    ro(pda.state()),
    rw(pda.user(pool)),
    rw(pda.userStats(pool)),
    rw(pda.spotMarketVault(DRIFT_USDC_SPOT_MARKET_INDEX)),
    ro(pda.signer()),
    rw(poolVault),
    ro(TOKEN_PROGRAM_ID),
    ...oracles,
    rw(pda.spotMarket(DRIFT_USDC_SPOT_MARKET_INDEX)),
    ...perps,
  ];
}

/** Read `PerpMarket.amm.oracle` for each index and the USDC `SpotMarket.oracle` on-chain. */
export async function fetchDriftOracles(
  connection: Connection,
  perpMarketIndices: number[],
  programId: PublicKey = DRIFT_PROGRAM_ID,
): Promise<{ usdcOracle: PublicKey; markets: DriftMarketRef[] }> {
  const pda = driftPdas(programId);
  const keys = [pda.spotMarket(DRIFT_USDC_SPOT_MARKET_INDEX), ...perpMarketIndices.map((i) => pda.perpMarket(i))];
  const infos = await connection.getMultipleAccountsInfo(keys);
  const spot = infos[0];
  if (!spot) throw new Error("Drift USDC spot market not found");
  const usdcOracle = decodeDriftSpotMarket(Buffer.from(spot.data)).oracle;
  const markets: DriftMarketRef[] = perpMarketIndices.map((idx, i) => {
    const info = infos[i + 1];
    if (!info) throw new Error(`Drift perp market ${idx} not found`);
    const pm = decodeDriftPerpMarket(Buffer.from(info.data));
    if (pm.marketIndex !== idx) throw new Error(`Drift perp market ${idx}: index mismatch (${pm.marketIndex})`);
    return { perpMarketIndex: idx, oracle: pm.oracle };
  });
  return { usdcOracle, markets };
}

/** Convenience: `driftTradeAccounts` with oracles read on-chain. */
export async function driftTradeAccountsFor(
  connection: Connection,
  pool: PublicKey,
  poolVault: PublicKey,
  perpMarketIndices: number[],
  programId: PublicKey = DRIFT_PROGRAM_ID,
): Promise<AccountMeta[]> {
  const { usdcOracle, markets } = await fetchDriftOracles(connection, perpMarketIndices, programId);
  return driftTradeAccounts(pool, poolVault, markets, usdcOracle, programId);
}

// ---------------------------------------------------------------------------
// Decoders (protocol-v2 v2.162.0 zero-copy layouts)
// ---------------------------------------------------------------------------

const i64 = (b: Buffer, o: number) => new BN(b.subarray(o, o + 8), "le").fromTwos(64);
const u64 = (b: Buffer, o: number) => new BN(b.subarray(o, o + 8), "le");
const u128 = (b: Buffer, o: number) => new BN(b.subarray(o, o + 16), "le");
const pk = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32));

export interface DriftPerpPosition {
  marketIndex: number;
  /** BASE_PRECISION 1e9, signed (>0 long, <0 short). */
  baseAssetAmount: BN;
  /** QUOTE_PRECISION 1e6, includes fees and funding. */
  quoteAssetAmount: BN;
  /** QUOTE_PRECISION 1e6, cost basis excluding fees/funding. */
  quoteEntryAmount: BN;
  quoteBreakEvenAmount: BN;
  lpShares: BN;
  openOrders: number;
}

export interface DriftSpotPosition {
  marketIndex: number;
  scaledBalance: BN;
  cumulativeDeposits: BN;
  balanceType: "deposit" | "borrow";
}

export interface DriftUser {
  authority: PublicKey;
  delegate: PublicKey;
  subAccountId: number;
  /** Only slots Drift considers in use (`!PerpPosition::is_available()`). */
  perpPositions: DriftPerpPosition[];
  /** Only slots with a non-zero scaled balance. */
  spotPositions: DriftSpotPosition[];
  settledPerpPnl: BN;
  cumulativePerpFunding: BN;
}

export function decodeDriftUser(data: Buffer): DriftUser {
  const L = DRIFT_LAYOUT;
  if (data.length < L.USER_SIZE || !data.subarray(0, 8).equals(DRIFT_ACCOUNT.user)) throw new Error("not a Drift User account");
  const perpPositions: DriftPerpPosition[] = [];
  for (let i = 0; i < L.PERP_POSITIONS_LEN; i++) {
    const o = L.USER_PERP_POSITIONS + i * L.PERP_POSITION_SIZE;
    const p: DriftPerpPosition = {
      marketIndex: data.readUInt16LE(o + L.PP_MARKET_INDEX),
      baseAssetAmount: i64(data, o + L.PP_BASE_ASSET_AMOUNT),
      quoteAssetAmount: i64(data, o + L.PP_QUOTE_ASSET_AMOUNT),
      quoteEntryAmount: i64(data, o + L.PP_QUOTE_ENTRY_AMOUNT),
      quoteBreakEvenAmount: i64(data, o + L.PP_QUOTE_BREAK_EVEN_AMOUNT),
      lpShares: u64(data, o + L.PP_LP_SHARES),
      openOrders: data.readUInt8(o + L.PP_OPEN_ORDERS),
    };
    if (p.baseAssetAmount.isZero() && p.quoteAssetAmount.isZero() && p.lpShares.isZero() && p.openOrders === 0) continue;
    perpPositions.push(p);
  }
  const spotPositions: DriftSpotPosition[] = [];
  for (let i = 0; i < L.SPOT_POSITIONS_LEN; i++) {
    const o = L.USER_SPOT_POSITIONS + i * L.SPOT_POSITION_SIZE;
    const scaledBalance = u64(data, o + L.SP_SCALED_BALANCE);
    if (scaledBalance.isZero()) continue;
    spotPositions.push({
      marketIndex: data.readUInt16LE(o + L.SP_MARKET_INDEX),
      scaledBalance,
      cumulativeDeposits: i64(data, o + L.SP_CUMULATIVE_DEPOSITS),
      balanceType: data.readUInt8(o + L.SP_BALANCE_TYPE) === 0 ? "deposit" : "borrow",
    });
  }
  return {
    authority: pk(data, L.USER_AUTHORITY),
    delegate: pk(data, L.USER_DELEGATE),
    subAccountId: data.readUInt16LE(L.USER_SUB_ACCOUNT_ID),
    perpPositions,
    spotPositions,
    settledPerpPnl: i64(data, L.USER_SETTLED_PERP_PNL),
    cumulativePerpFunding: i64(data, L.USER_CUMULATIVE_PERP_FUNDING),
  };
}

export interface DriftSpotMarket {
  marketIndex: number;
  oracle: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  /** SPOT_CUMULATIVE_INTEREST_PRECISION 1e10. */
  cumulativeDepositInterest: BN;
  decimals: number;
}

export function decodeDriftSpotMarket(data: Buffer): DriftSpotMarket {
  const L = DRIFT_LAYOUT;
  if (data.length < L.SPOT_MARKET_SIZE || !data.subarray(0, 8).equals(DRIFT_ACCOUNT.spotMarket)) throw new Error("not a Drift SpotMarket account");
  return {
    marketIndex: data.readUInt16LE(L.SM_MARKET_INDEX),
    oracle: pk(data, L.SM_ORACLE),
    mint: pk(data, L.SM_MINT),
    vault: pk(data, L.SM_VAULT),
    cumulativeDepositInterest: u128(data, L.SM_CUMULATIVE_DEPOSIT_INTEREST),
    decimals: data.readUInt32LE(L.SM_DECIMALS),
  };
}

export function decodeDriftPerpMarket(data: Buffer): { marketIndex: number; oracle: PublicKey } {
  const L = DRIFT_LAYOUT;
  if (data.length < L.PERP_MARKET_SIZE || !data.subarray(0, 8).equals(DRIFT_ACCOUNT.perpMarket)) throw new Error("not a Drift PerpMarket account");
  return { marketIndex: data.readUInt16LE(L.PM_MARKET_INDEX), oracle: pk(data, L.PM_AMM_ORACLE) };
}

/** `scaled_balance × cumulative_interest / 10^(19 − decimals)` (Drift `get_token_amount`, deposit rounding). */
export function driftTokenAmount(scaledBalance: BN, cumulativeInterest: BN, decimals: number): BN {
  return scaledBalance.mul(cumulativeInterest).div(new BN(10).pow(new BN(19 - decimals)));
}

/** USDC held at Drift (deposits minus borrows on spot market 0), USDC base units. */
export function driftUsdcBalance(user: DriftUser, usdcMarket: DriftSpotMarket): BN {
  let total = new BN(0);
  for (const s of user.spotPositions) {
    if (s.marketIndex !== DRIFT_USDC_SPOT_MARKET_INDEX) continue;
    const tok = driftTokenAmount(s.scaledBalance, usdcMarket.cumulativeDepositInterest, usdcMarket.decimals);
    total = s.balanceType === "deposit" ? total.add(tok) : total.sub(tok);
  }
  return total;
}

/**
 * TS mirror of `DriftAdapter::read_account_equity`:
 * USDC balance + Σ(quote_asset_amount + base × mark / 1e9).
 * `marks`: Drift perp market index → 1e6 price. Throws if a non-flat
 * position has no mark (the program errors with `VenueMarketUnknown`).
 */
export function driftVenueEquity(user: DriftUser, usdcMarket: DriftSpotMarket, marks: Map<number, BN>): BN {
  let equity = driftUsdcBalance(user, usdcMarket);
  for (const p of user.perpPositions) {
    equity = equity.add(p.quoteAssetAmount);
    if (!p.baseAssetAmount.isZero()) {
      const mark = marks.get(p.marketIndex);
      if (!mark) throw new Error(`no mark for Drift perp market ${p.marketIndex}`);
      equity = equity.add(p.baseAssetAmount.mul(mark).div(new BN(DRIFT_BASE_PRECISION)));
    }
  }
  return equity;
}

/** Average entry (1e6) from Drift's cost basis, as the program mirrors it. */
export function driftEntryPrice(p: DriftPerpPosition): BN {
  if (p.baseAssetAmount.isZero()) return new BN(0);
  return p.quoteEntryAmount.abs().mul(new BN(DRIFT_BASE_PRECISION)).div(p.baseAssetAmount.abs());
}

// ---------------------------------------------------------------------------
// Keeper: settle_pnl (permissionless on Drift; the program never CPIs it)
// ---------------------------------------------------------------------------

/**
 * Drift `settle_pnl(market_index)` for the pool's User. Any signer may call
 * it. The keeper runs it after closes so realized PnL moves from the perp
 * position into the USDC deposit, which is what `ensure_vault_liquidity`
 * can withdraw. Drift may reject it (oracle validity, AMM not updated in the
 * same slot, market status). Pair it with Drift's `update_amms` when needed.
 */
export function driftSettlePnlIx(params: {
  authority: PublicKey;
  pool: PublicKey;
  perpMarketIndex: number;
  perpOracle: PublicKey;
  usdcOracle?: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = params.programId ?? DRIFT_PROGRAM_ID;
  const pda = driftPdas(programId);
  const usdcOracle = params.usdcOracle ?? DRIFT_DEVNET.usdcSpotOracle;
  const oracles = [ro(usdcOracle)];
  if (!params.perpOracle.equals(usdcOracle)) oracles.push(ro(params.perpOracle));
  const data = Buffer.concat([DRIFT_IX.settlePnl, u16le(params.perpMarketIndex)]);
  return new TransactionInstruction({
    programId,
    keys: [
      ro(pda.state()),
      rw(pda.user(params.pool)),
      { pubkey: params.authority, isSigner: true, isWritable: false },
      ro(pda.spotMarketVault(DRIFT_USDC_SPOT_MARKET_INDEX)),
      ...oracles,
      rw(pda.spotMarket(DRIFT_USDC_SPOT_MARKET_INDEX)),
      rw(pda.perpMarket(params.perpMarketIndex)),
    ],
    data,
  });
}
