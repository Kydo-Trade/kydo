/**
 * High-level client around the Anchor program. Every instruction builder
 * returns a `TransactionInstruction`-producing MethodsBuilder so callers can
 * compose (priority fees, Jito bundles) before sending.
 */
import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { AccountMeta, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { VAULT_PROGRAM_ID } from "./constants";
import { pdas } from "./pda";
import IDL_JSON from "./idl/vault.json";

export type VaultIdl = Idl;

export interface MarketLike {
  marketId: number;
  oracle: PublicKey;
  enabled: boolean;
  cluster: number;
  maxLeverageBps: number;
  symbol: string;
  feedId: number[];
  venueMarketIndex: number;
}

export function decodeSymbol(sym: number[] | Uint8Array): string {
  return Buffer.from(sym).toString("utf8").replace(/\0+$/, "");
}

export function encodeName(s: string, len = 32): number[] {
  const b = Buffer.alloc(len);
  b.write(s.slice(0, len), "utf8");
  return [...b];
}

export class VaultClient {
  readonly program: Program;
  readonly pda: ReturnType<typeof pdas>;

  constructor(readonly provider: AnchorProvider, programId: PublicKey = VAULT_PROGRAM_ID) {
    const idl = { ...(IDL_JSON as Idl), address: programId.toBase58() } as Idl;
    this.program = new Program(idl, provider);
    this.pda = pdas(programId);
  }

  /** Read-only client (browser-safe: no dependency on Anchor's Node-only `Wallet`). */
  static readonly(connection: Connection, programId?: PublicKey): VaultClient {
    const kp = Keypair.generate();
    const wallet = {
      publicKey: kp.publicKey,
      signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => tx,
      signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => txs,
    };
    return new VaultClient(new AnchorProvider(connection, wallet, { commitment: "confirmed" }), programId);
  }

  get programId() {
    return this.program.programId;
  }

  // ---------- account fetchers ----------
  async config() {
    return (this.program.account as any).platformConfig.fetch(this.pda.platform());
  }
  async registry(): Promise<{ markets: MarketLike[]; count: number }> {
    const r = await (this.program.account as any).marketRegistry.fetch(this.pda.registry());
    const markets = (r.markets as any[]).slice(0, r.count).map((m) => ({
      ...m,
      symbol: decodeSymbol(m.symbol),
    }));
    return { markets, count: r.count };
  }
  async treasury() {
    return (this.program.account as any).treasury.fetch(this.pda.treasury());
  }
  async trader(wallet: PublicKey) {
    return (this.program.account as any).traderProfile.fetchNullable(this.pda.trader(wallet));
  }
  async pool(pool: PublicKey) {
    return (this.program.account as any).pool.fetch(pool);
  }
  async allPools() {
    return (this.program.account as any).pool.all();
  }
  async investorPosition(pool: PublicKey, investor: PublicKey) {
    return (this.program.account as any).investorPosition.fetchNullable(this.pda.investor(pool, investor));
  }
  async investorPositions(investor: PublicKey) {
    return (this.program.account as any).investorPosition.all([
      { memcmp: { offset: 8 + 32, bytes: investor.toBase58() } },
    ]);
  }
  /** Active session key for a trader (null if none). */
  async sessionKey(trader: PublicKey) {
    return (this.program.account as any).sessionKey.fetchNullable(this.pda.session(trader));
  }
  async mockOracle(marketId: number) {
    return (this.program.account as any).mockOracle.fetchNullable(this.pda.mockOracle(marketId));
  }

  /** Oracle accounts for the pool's open positions (+ optional extra market), as remaining accounts. */
  oracleMetas(markets: MarketLike[], pool: any, extraMarketId?: number): AccountMeta[] {
    const ids = new Set<number>();
    for (const p of pool.positions as any[]) if (p.side !== 0 && !new BN(p.baseQty).isZero()) ids.add(p.marketId);
    if (extraMarketId !== undefined) ids.add(extraMarketId);
    const metas: AccountMeta[] = [];
    for (const id of ids) {
      const m = markets.find((x) => x.marketId === id);
      if (!m) throw new Error(`market ${id} not in registry`);
      metas.push({ pubkey: m.oracle, isSigner: false, isWritable: false });
    }
    return metas;
  }

  usdcAta(owner: PublicKey, mint: PublicKey) {
    return getAssociatedTokenAddressSync(mint, owner, true);
  }

  // ---------- instruction builders ----------
  initPlatform(admin: PublicKey, usdcMint: PublicKey, args: any) {
    return this.program.methods.initPlatform(args).accounts({
      admin,
      config: this.pda.platform(),
      registry: this.pda.registry(),
      treasury: this.pda.treasury(),
      treasuryVault: this.pda.treasuryVault(),
      usdcMint,
    });
  }
  updateRiskParams(admin: PublicKey, args: any) {
    return this.program.methods.updateRiskParams(args).accounts({ admin, config: this.pda.platform() });
  }

  // ---- CommonPool crowdsourced funding (Vault Ledger section 1–section 3) ----
  initCommonPool(admin: PublicKey, usdcMint: PublicKey, params: { reserveBps: number; depositEnabled: boolean }) {
    return this.program.methods.initCommonPool(params).accounts({
      admin,
      config: this.pda.platform(),
      commonPool: this.pda.commonPool(),
      commonVault: this.pda.commonVault(),
      usdcMint,
    });
  }
  updateCommonPoolParams(admin: PublicKey, params: { reserveBps: number; depositEnabled: boolean }) {
    return this.program.methods
      .updateCommonPoolParams(params)
      .accounts({ admin, config: this.pda.platform(), commonPool: this.pda.commonPool() });
  }
  /** Stake pairs + trailing oracle metas for `deposit_common` / `redeem_common` /
   *  `settle_common_redemption`. `stakedPools` must be every pool the CommonPool
   *  holds a stake in; `oracles` the oracle accounts for their open positions. */
  private commonStakeAccounts(stakedPools: PublicKey[], oracles: AccountMeta[]) {
    const cp = this.pda.commonPool();
    const pairs = [...stakedPools].sort((a, b) => a.toBuffer().compare(b.toBuffer()));
    return [
      ...pairs.flatMap((pool) => [
        { pubkey: pool, isSigner: false, isWritable: false },
        { pubkey: this.pda.investor(pool, cp), isSigner: false, isWritable: false },
      ]),
      ...oracles,
    ];
  }
  depositCommon(investor: PublicKey, investorUsdc: PublicKey, amount: BN | number, stakedPools: PublicKey[] = [], oracles: AccountMeta[] = []) {
    return this.program.methods
      .depositCommon(new BN(amount))
      .accounts({
        investor,
        commonPool: this.pda.commonPool(),
        commonVault: this.pda.commonVault(),
        position: this.pda.commonInvestor(investor),
        investorUsdc,
        config: this.pda.platform(),
        registry: this.pda.registry(),
      })
      .remainingAccounts(this.commonStakeAccounts(stakedPools, oracles));
  }
  redeemCommon(investor: PublicKey, investorUsdc: PublicKey, shares: BN, stakedPools: PublicKey[] = [], oracles: AccountMeta[] = []) {
    return this.program.methods
      .redeemCommon(shares)
      .accounts({
        investor,
        commonPool: this.pda.commonPool(),
        commonVault: this.pda.commonVault(),
        position: this.pda.commonInvestor(investor),
        investorUsdc,
        config: this.pda.platform(),
        registry: this.pda.registry(),
      })
      .remainingAccounts(this.commonStakeAccounts(stakedPools, oracles));
  }
  settleCommonRedemption(investor: PublicKey, investorUsdc: PublicKey, stakedPools: PublicKey[] = [], oracles: AccountMeta[] = []) {
    return this.program.methods
      .settleCommonRedemption()
      .accounts({
        investor,
        commonPool: this.pda.commonPool(),
        commonVault: this.pda.commonVault(),
        position: this.pda.commonInvestor(investor),
        investorUsdc,
        config: this.pda.platform(),
        registry: this.pda.registry(),
      })
      .remainingAccounts(this.commonStakeAccounts(stakedPools, oracles));
  }
  requestCommonPull(caller: PublicKey, pool: PublicKey) {
    return this.program.methods.requestCommonPull().accounts({
      caller,
      commonPool: this.pda.commonPool(),
      pool,
      stake: this.pda.investor(pool, this.pda.commonPool()),
      config: this.pda.platform(),
    });
  }
  settleCommonPull(caller: PublicKey, pool: PublicKey, oracles: AccountMeta[] = []) {
    return this.program.methods
      .settleCommonPull()
      .accounts({
        caller,
        commonPool: this.pda.commonPool(),
        commonVault: this.pda.commonVault(),
        pool,
        stake: this.pda.investor(pool, this.pda.commonPool()),
        vault: this.pda.poolVault(pool),
        config: this.pda.platform(),
        registry: this.pda.registry(),
      })
      .remainingAccounts(oracles);
  }
  /** Permissionless unjam: close a head-of-queue ticket whose trader can no longer be funded. */
  skipDeadTicket(caller: PublicKey, trader: PublicKey, rentTo: PublicKey) {
    return this.program.methods.skipDeadTicket().accounts({
      caller,
      commonPool: this.pda.commonPool(),
      ticket: this.pda.ticket(trader),
      rentTo,
      profile: this.pda.trader(trader),
    });
  }
  collectPlatformFee(caller: PublicKey, pool: PublicKey) {
    return this.program.methods.collectPlatformFee().accounts({
      caller,
      pool,
      vault: this.pda.poolVault(pool),
      treasury: this.pda.treasury(),
      treasuryVault: this.pda.treasuryVault(),
    });
  }
  queueForFunding(caller: PublicKey, trader: PublicKey) {
    return this.program.methods.queueForFunding().accounts({
      caller,
      trader,
      profile: this.pda.trader(trader),
      commonPool: this.pda.commonPool(),
      ticket: this.pda.ticket(trader),
      config: this.pda.platform(),
    });
  }
  /** `poolIndex` = the trader profile's `pools_created` at funding time; `rentTo` = the ticket's payer. */
  fundNextInQueue(caller: PublicKey, callerUsdc: PublicKey, trader: PublicKey, poolIndex: number, rentTo: PublicKey, usdcMint: PublicKey) {
    const pool = this.pda.pool(trader, poolIndex);
    return this.program.methods.fundNextInQueue().accounts({
      caller,
      commonPool: this.pda.commonPool(),
      commonVault: this.pda.commonVault(),
      ticket: this.pda.ticket(trader),
      rentTo,
      profile: this.pda.trader(trader),
      config: this.pda.platform(),
      pool,
      vault: this.pda.poolVault(pool),
      stake: this.pda.investor(pool, this.pda.commonPool()),
      usdcMint,
      treasury: this.pda.treasury(),
      treasuryVault: this.pda.treasuryVault(),
      callerUsdc,
    });
  }
  registerMarket(admin: PublicKey, args: any) {
    return this.program.methods
      .registerMarket(args)
      .accounts({ admin, config: this.pda.platform(), registry: this.pda.registry() });
  }
  setMarketEnabled(admin: PublicKey, marketId: number, enabled: boolean) {
    return this.program.methods
      .setMarketEnabled(marketId, enabled)
      .accounts({ admin, config: this.pda.platform(), registry: this.pda.registry() });
  }
  /** Drops a market from the registry. It must be disabled first, and no pool
   *  may hold an open position in it. A pool whose market vanishes cannot be
   *  marked, traded, unwound or redeemed from. `scripts/remove-market.ts`
   *  checks both before sending. */
  removeMarket(admin: PublicKey, marketId: number) {
    return this.program.methods
      .removeMarket(marketId)
      .accounts({ admin, config: this.pda.platform(), registry: this.pda.registry() });
  }
  pause(admin: PublicKey) {
    return this.program.methods.pause().accounts({ admin, config: this.pda.platform() });
  }
  unpause(admin: PublicKey) {
    return this.program.methods.unpause().accounts({ admin, config: this.pda.platform() });
  }
  initMockOracle(priceAuthority: PublicKey, marketId: number) {
    return this.program.methods.initMockOracle(marketId).accounts({
      priceAuthority,
      config: this.pda.platform(),
      oracle: this.pda.mockOracle(marketId),
    });
  }
  setMockPrice(priceAuthority: PublicKey, marketId: number, price: BN, conf: BN, expo = -6) {
    return this.program.methods.setMockPrice(price, conf, expo).accounts({
      priceAuthority,
      config: this.pda.platform(),
      oracle: this.pda.mockOracle(marketId),
    });
  }

  /** `instantCap` > 0 skips the trial: the trader buys that funding cap for max(entryFee, 12% of cap). 0 = normal trial. Requires the instant-capable program. */
  applyAsTrader(trader: PublicKey, usdcMint: PublicKey, instantCap: BN = new BN(0)) {
    return this.program.methods.applyAsTrader(instantCap).accounts({
      trader,
      profile: this.pda.trader(trader),
      config: this.pda.platform(),
      treasury: this.pda.treasury(),
      treasuryVault: this.pda.treasuryVault(),
      traderUsdc: this.usdcAta(trader, usdcMint),
    });
  }
  commitTrialRoot(trader: PublicKey, day: number, root: Buffer | number[]) {
    return this.program.methods
      .commitTrialRoot(day, [...root])
      .accounts({ trader, profile: this.pda.trader(trader), config: this.pda.platform() });
  }
  finalizeTrial(attestor: PublicKey, trader: PublicKey, metrics: any) {
    return this.program.methods
      .finalizeTrial(metrics)
      .accounts({ attestor, trader, profile: this.pda.trader(trader), config: this.pda.platform() });
  }

  createPool(trader: PublicKey, usdcMint: PublicKey, poolIndex: number, args: any) {
    const pool = this.pda.pool(trader, poolIndex);
    return this.program.methods.createPool(args).accounts({
      trader,
      profile: this.pda.trader(trader),
      config: this.pda.platform(),
      pool,
      vault: this.pda.poolVault(pool),
      usdcMint,
      traderUsdc: this.usdcAta(trader, usdcMint),
    });
  }
  /** `profile` = the pool trader's TraderProfile PDA (activation now injects the held fee as first-loss seed). */
  activatePool(pool: PublicKey, profile: PublicKey) {
    return this.program.methods.activatePool().accounts({
      pool,
      profile,
      vault: this.pda.poolVault(pool),
      config: this.pda.platform(),
      treasury: this.pda.treasury(),
      treasuryVault: this.pda.treasuryVault(),
    });
  }
  /** `trader` signs: promotion spends their vested escrow as first-loss seed, which is not withdrawable. */
  promoteTier(trader: PublicKey, pool: PublicKey, profile: PublicKey, oracles: AccountMeta[]) {
    return this.program.methods
      .promoteTier()
      .accounts({ trader, pool, profile, config: this.pda.platform(), registry: this.pda.registry() })
      .remainingAccounts(oracles);
  }
  /** `caller` must be the pool's trader, or anyone once the pool's end date has passed. `trader` = the pool's trader (profile derivation). */
  closePool(caller: PublicKey, pool: PublicKey, trader: PublicKey = caller) {
    return this.program.methods.closePool().accounts({ trader: caller, pool, profile: this.pda.trader(trader) });
  }
  /** Splits whatever is left in the pool's vault. The unspent first-loss seed
   *  plus dust. REAP_PLATFORM_BPS to the treasury and the rest to the
   *  CommonPool's idle balance, then reclaims the rent. The investor half lands
   *  against unchanged shares, so it raises NAV/share rather than paying anyone.
   *  The uncollected platform fee is paid to the treasury first, and the whole
   *  remainder falls back to the treasury when the CommonPool has no shares
   *  outstanding (nobody to own it). */
  reapPool(caller: PublicKey, pool: PublicKey) {
    return this.program.methods.reapPool().accounts({
      caller,
      config: this.pda.platform(),
      pool,
      vault: this.pda.poolVault(pool),
      treasury: this.pda.treasury(),
      treasuryVault: this.pda.treasuryVault(),
      commonPool: this.pda.commonPool(),
      commonVault: this.pda.commonVault(),
    });
  }

  /**
   * Seed a trader's **own** pool to the activation floor.
   *
   * Not an investor path: the program rejects any signer that is not
   * `pool.trader` with `DirectDepositDisabled`. Investors deposit into the
   * CommonPool (`depositCommon`), which funds traders in FIFO order; the stake
   * that creates is minted inside `fundNextInQueue`, not here.
   *
   * The parameter keeps the name `investor` because the position it mints is an
   * ordinary `InvestorPosition`. A self-seeding trader holds investor shares in
   * their own pool and redeems them like any other holder.
   */
  deposit(investor: PublicKey, pool: PublicKey, usdcMint: PublicKey, amount: BN, oracles: AccountMeta[]) {
    return this.program.methods
      .deposit(amount)
      .accounts({
        investor,
        pool,
        position: this.pda.investor(pool, investor),
        vault: this.pda.poolVault(pool),
        investorUsdc: this.usdcAta(investor, usdcMint),
        config: this.pda.platform(),
        registry: this.pda.registry(),
      })
      .remainingAccounts(oracles);
  }
  requestRedemption(investor: PublicKey, pool: PublicKey, usdcMint: PublicKey, shares: BN, oracles: AccountMeta[]) {
    return this.program.methods
      .requestRedemption(shares)
      .accounts({
        investor,
        pool,
        position: this.pda.investor(pool, investor),
        vault: this.pda.poolVault(pool),
        investorUsdc: this.usdcAta(investor, usdcMint),
        config: this.pda.platform(),
        registry: this.pda.registry(),
      })
      .remainingAccounts(oracles);
  }
  unwindForRedemption(caller: PublicKey, pool: PublicKey, investor: PublicKey, usdcMint: PublicKey, oracles: AccountMeta[]) {
    return this.program.methods
      .unwindForRedemption()
      .accounts({
        caller,
        pool,
        position: this.pda.investor(pool, investor),
        config: this.pda.platform(),
        registry: this.pda.registry(),
        treasury: this.pda.treasury(),
        treasuryVault: this.pda.treasuryVault(),
        callerUsdc: this.usdcAta(caller, usdcMint),
      })
      .remainingAccounts(oracles);
  }
  settleRedemption(investor: PublicKey, pool: PublicKey, usdcMint: PublicKey, oracles: AccountMeta[]) {
    return this.program.methods
      .settleRedemption()
      .accounts({
        investor,
        pool,
        position: this.pda.investor(pool, investor),
        vault: this.pda.poolVault(pool),
        investorUsdc: this.usdcAta(investor, usdcMint),
        config: this.pda.platform(),
        registry: this.pda.registry(),
      })
      .remainingAccounts(oracles);
  }

  /** Accounts for trade instructions. `sessionSigner` = an authorised session key signing instead of the wallet. */
  private tradeAccounts(trader: PublicKey, pool: PublicKey, sessionSigner?: PublicKey) {
    return {
      signer: sessionSigner ?? trader,
      trader,
      session: sessionSigner ? this.pda.session(trader) : null,
      pool,
      config: this.pda.platform(),
      registry: this.pda.registry(),
    } as any; // `session: null` is valid for an optional account at runtime; Anchor's generic typing rejects null
  }
  placeTrade(trader: PublicKey, pool: PublicKey, args: { marketId: number; side: number; notional: BN; limitPx: BN; stopPx: BN }, oracles: AccountMeta[], sessionSigner?: PublicKey) {
    return this.program.methods.placeTrade(args).accounts(this.tradeAccounts(trader, pool, sessionSigner)).remainingAccounts(oracles);
  }
  /** Move the stop on an open position without trading. Re-runs the same
   *  worst-case check as `placeTrade`, so tightening always succeeds. */
  setStop(trader: PublicKey, pool: PublicKey, args: { marketId: number; stopPx: BN }, oracles: AccountMeta[], sessionSigner?: PublicKey) {
    return this.program.methods.setStop(args).accounts(this.tradeAccounts(trader, pool, sessionSigner)).remainingAccounts(oracles);
  }
  closeTrade(trader: PublicKey, pool: PublicKey, args: { marketId: number; baseQty: BN; limitPx: BN }, oracles: AccountMeta[], sessionSigner?: PublicKey) {
    return this.program.methods.closeTrade(args).accounts(this.tradeAccounts(trader, pool, sessionSigner)).remainingAccounts(oracles);
  }
  /**
   * Legacy trade instructions for a deployed program that predates session keys
   * (accounts: trader signer, pool, config, registry). Instruction data is identical,
   * so only the account metas differ. Used by clients as a fallback until the
   * on-chain program is upgraded.
   */
  private legacyTradeIx(name: "placeTrade" | "closeTrade", trader: PublicKey, pool: PublicKey, args: any, oracles: AccountMeta[]): TransactionInstruction {
    const data = (this.program.coder.instruction as any).encode(name, { args });
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: trader, isSigner: true, isWritable: false },
        { pubkey: pool, isSigner: false, isWritable: true },
        { pubkey: this.pda.platform(), isSigner: false, isWritable: false },
        { pubkey: this.pda.registry(), isSigner: false, isWritable: false },
        ...oracles,
      ],
      data,
    });
  }
  placeTradeLegacyIx(trader: PublicKey, pool: PublicKey, args: { marketId: number; side: number; notional: BN; limitPx: BN; stopPx: BN }, oracles: AccountMeta[]) {
    return this.legacyTradeIx("placeTrade", trader, pool, args, oracles);
  }
  closeTradeLegacyIx(trader: PublicKey, pool: PublicKey, args: { marketId: number; baseQty: BN; limitPx: BN }, oracles: AccountMeta[]) {
    return this.legacyTradeIx("closeTrade", trader, pool, args, oracles);
  }
  vestEscrow(pool: PublicKey) {
    return this.program.methods.vestEscrow().accounts({ pool, config: this.pda.platform() });
  }
  claimTraderFees(trader: PublicKey, pool: PublicKey, usdcMint: PublicKey, oracles: AccountMeta[]) {
    return this.program.methods
      .claimTraderFees()
      .accounts({
        trader,
        pool,
        vault: this.pda.poolVault(pool),
        traderUsdc: this.usdcAta(trader, usdcMint),
        config: this.pda.platform(),
        registry: this.pda.registry(),
        profile: this.pda.trader(trader),
        treasury: this.pda.treasury(),
        treasuryVault: this.pda.treasuryVault(),
      })
      .remainingAccounts(oracles);
  }

  /** Authorise a browser-held keypair to sign trade instructions for `ttlSecs` (≤ 86 400). */
  setSessionKey(trader: PublicKey, key: PublicKey, ttlSecs: number) {
    return this.program.methods
      .setSessionKey(key, new BN(ttlSecs))
      .accounts({ trader, profile: this.pda.trader(trader), session: this.pda.session(trader) });
  }
  revokeSessionKey(trader: PublicKey) {
    return this.program.methods.revokeSessionKey().accounts({ trader, session: this.pda.session(trader) });
  }

  private riskAccounts(caller: PublicKey, pool: PublicKey, profile: PublicKey, usdcMint: PublicKey) {
    return {
      caller,
      pool,
      profile,
      config: this.pda.platform(),
      registry: this.pda.registry(),
      vault: this.pda.poolVault(pool),
      treasury: this.pda.treasury(),
      treasuryVault: this.pda.treasuryVault(),
      callerUsdc: this.usdcAta(caller, usdcMint),
    };
  }
  evaluateRisk(caller: PublicKey, pool: PublicKey, profile: PublicKey, usdcMint: PublicKey, oracles: AccountMeta[]) {
    return this.program.methods.evaluateRisk().accounts(this.riskAccounts(caller, pool, profile, usdcMint)).remainingAccounts(oracles);
  }
  lockPool(caller: PublicKey, pool: PublicKey, profile: PublicKey, usdcMint: PublicKey, oracles: AccountMeta[]) {
    return this.program.methods.lockPool().accounts(this.riskAccounts(caller, pool, profile, usdcMint)).remainingAccounts(oracles);
  }
  unwindAll(caller: PublicKey, pool: PublicKey, profile: PublicKey, usdcMint: PublicKey, oracles: AccountMeta[]) {
    return this.program.methods.unwindAll().accounts(this.riskAccounts(caller, pool, profile, usdcMint)).remainingAccounts(oracles);
  }

  withdrawTreasury(admin: PublicKey, destination: PublicKey, amount: BN) {
    return this.program.methods.withdrawTreasury(amount).accounts({
      admin,
      config: this.pda.platform(),
      treasury: this.pda.treasury(),
      treasuryVault: this.pda.treasuryVault(),
      destination,
    });
  }
  sweepDust(caller: PublicKey, pool: PublicKey) {
    return this.program.methods.sweepDust().accounts({
      caller,
      pool,
      vault: this.pda.poolVault(pool),
      treasury: this.pda.treasury(),
      treasuryVault: this.pda.treasuryVault(),
    });
  }
}
