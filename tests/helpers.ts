import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotent,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { AccountMeta, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createHash } from "crypto";
import { pdas } from "../packages/sdk/src/pda";

export const USD = 1_000_000;
export const usd = (x: number) => new BN(Math.round(x * USD));
export const SHARE_SCALE = new BN("1000000000000");
/** Mirrors `constants.rs` REAP_PLATFORM_BPS. The platform's share of what a reaped pool leaves behind. */
export const REAP_PLATFORM_BPS = 5_000;

export const MARKETS = {
  SOL: { id: 1, symbol: "SOL-PERP", cluster: 2, lev: 30_000, price: 150 },
  BTC: { id: 2, symbol: "BTC-PERP", cluster: 1, lev: 30_000, price: 60_000 },
  ETH: { id: 3, symbol: "ETH-PERP", cluster: 1, lev: 30_000, price: 3_000 },
};

export class Env {
  provider: anchor.AnchorProvider;
  program: Program;
  pda: ReturnType<typeof pdas>;
  admin: Keypair;
  attestor: Keypair;
  priceAuthority: Keypair;
  usdc!: PublicKey;
  /** last price set per market. Re-sent by `freshen()` so mock oracles never go stale mid-test */
  prices = new Map<number, number>();

  constructor() {
    this.provider = anchor.AnchorProvider.env();
    anchor.setProvider(this.provider);
    this.program = anchor.workspace.Vault as Program;
    this.pda = pdas(this.program.programId);
    this.admin = (this.provider.wallet as anchor.Wallet).payer;
    // Distinct keys per privileged role, NOT `this.admin`.
    //
    // These were all the same keypair, which meant no test in this suite could
    // fail on a privilege-separation defect: every instruction was signed by a
    // key that satisfied every `has_one`, so a missing or wrong authority check
    // was indistinguishable from a correct one. That is exactly the class the
    // audit's key findings belong to, and the fixture made the suite blind to
    // it. Funded in `initPlatform`. `init_mock_oracle` has the price authority
    // as its rent payer.
    this.attestor = Keypair.generate();
    this.priceAuthority = Keypair.generate();
  }

  get conn() {
    return this.provider.connection;
  }

  async airdrop(pk: PublicKey, sol = 10) {
    const sig = await this.conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    await this.conn.confirmTransaction(sig, "confirmed");
  }

  async newWallet(sol = 10, usdcAmount = 0): Promise<Keypair> {
    const kp = Keypair.generate();
    // fund from admin to avoid airdrop rate limits
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: this.admin.publicKey, toPubkey: kp.publicKey, lamports: sol * LAMPORTS_PER_SOL }),
    );
    await this.provider.sendAndConfirm(tx);
    if (usdcAmount > 0) await this.fundUsdc(kp.publicKey, usdcAmount);
    return kp;
  }

  async createUsdc() {
    this.usdc = await createMint(this.conn, this.admin, this.admin.publicKey, null, 6);
    return this.usdc;
  }

  ata(owner: PublicKey) {
    return getAssociatedTokenAddressSync(this.usdc, owner, true);
  }

  async fundUsdc(owner: PublicKey, amount: number) {
    const ata = await createAssociatedTokenAccountIdempotent(this.conn, this.admin, this.usdc, owner);
    await mintTo(this.conn, this.admin, this.usdc, ata, this.admin, BigInt(Math.round(amount * USD)));
    return ata;
  }

  async usdcBalance(owner: PublicKey): Promise<number> {
    try {
      const acc = await getAccount(this.conn, this.ata(owner));
      return Number(acc.amount) / USD;
    } catch {
      return 0;
    }
  }

  async tokenBalance(addr: PublicKey): Promise<number> {
    const acc = await getAccount(this.conn, addr);
    return Number(acc.amount) / USD;
  }

  // ---------- accounts ----------
  config() {
    return (this.program.account as any).platformConfig.fetch(this.pda.platform());
  }
  registry() {
    return (this.program.account as any).marketRegistry.fetch(this.pda.registry());
  }
  treasury() {
    return (this.program.account as any).treasury.fetch(this.pda.treasury());
  }
  profile(wallet: PublicKey) {
    return (this.program.account as any).traderProfile.fetch(this.pda.trader(wallet));
  }
  pool(pool: PublicKey) {
    return (this.program.account as any).pool.fetch(pool);
  }
  investor(pool: PublicKey, investor: PublicKey) {
    return (this.program.account as any).investorPosition.fetchNullable(this.pda.investor(pool, investor));
  }

  oracleMetas(...marketIds: number[]): AccountMeta[] {
    return [...new Set(marketIds)].map((id) => ({ pubkey: this.pda.mockOracle(id), isSigner: false, isWritable: false }));
  }

  async openMarketIds(pool: PublicKey): Promise<number[]> {
    const p = await this.pool(pool);
    return (p.positions as any[]).filter((x) => x.side !== 0 && !new BN(x.baseQty).isZero()).map((x) => x.marketId);
  }

  // ---------- setup ----------
  async initPlatform(overrides: Partial<{ daySecs: number; graceDays: number; minHold: number; lockup: number }> = {}) {
    const risk = {
      maxLeverageBps: 30_000,
      maxPositions: 5,
      maxSingleBps: 4_000,
      maxClusterBps: 6_000,
      dailyLossBps: 400,
      maxDrawdownBps: 1_000,
      minHoldSecs: overrides.minHold ?? 0,
      maxTradesPerDay: 100,
      oracleMaxAgeSlots: new BN(25),
      oracleMaxConfBps: 50,
      limitBandBps: 200,
      redemptionLockupSecs: overrides.lockup ?? 0,
      cooldownSecs: 7 * 86_400,
      promotionDays: 30,
    };
    const trial = {
      startingBalance: usd(50_000),
      profitTargetBps: 800,
      maxDrawdownBps: 1_000,
      dailyLossBps: 400,
      minActiveDays: 15,
      minTrades: 20,
      maxDayProfitShareBps: 4_000,
      daySecs: overrides.daySecs ?? 1,
      commitGraceDays: overrides.graceDays ?? 60, // strict (< 365): the funnel tests exercise the real root path
    };
    // Fund the two role keys from admin (not airdrop: rate limits).
    await this.provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: this.admin.publicKey, toPubkey: this.attestor.publicKey, lamports: LAMPORTS_PER_SOL }),
        SystemProgram.transfer({ fromPubkey: this.admin.publicKey, toPubkey: this.priceAuthority.publicKey, lamports: LAMPORTS_PER_SOL }),
      ),
    );
    await this.program.methods
      .initPlatform({
        trialAttestor: this.attestor.publicKey,
        priceAuthority: this.priceAuthority.publicKey,
        entryFee: usd(800),
        bountyPerPool: usd(20),
        keeperBounty: usd(5),
        activationFloor: usd(1_000),
        minDeposit: usd(50),
        tierCaps: [usd(5_000), usd(15_000), usd(30_000)],
        vestDays: [14, 30, 30],
        allowMockOracle: true,
        minFirstLossBps: 1_294,
        risk,
        trial,
      })
      .accounts({
        admin: this.admin.publicKey,
        config: this.pda.platform(),
        registry: this.pda.registry(),
        treasury: this.pda.treasury(),
        treasuryVault: this.pda.treasuryVault(),
        usdcMint: this.usdc,
      })
      .rpc();
  }

  async registerMarkets() {
    for (const m of Object.values(MARKETS)) {
      await this.program.methods
        .initMockOracle(m.id)
        .accounts({ priceAuthority: this.priceAuthority.publicKey, config: this.pda.platform(), oracle: this.pda.mockOracle(m.id) })
        .signers([this.priceAuthority])
        .rpc();
      await this.setPrice(m.id, m.price);
      const symbol = Buffer.alloc(8);
      symbol.write(m.symbol);
      await this.program.methods
        .registerMarket({
          marketId: m.id,
          symbol: [...symbol],
          oracle: this.pda.mockOracle(m.id),
          feedId: new Array(32).fill(0),
          maxLeverageBps: m.lev,
          cluster: m.cluster,
          venueMarketIndex: 0,
        })
        .accounts({ admin: this.admin.publicKey, config: this.pda.platform(), registry: this.pda.registry() })
        .rpc();
    }
  }

  private priceIx(marketId: number, price: number, confBps = 5) {
    const p = new BN(Math.round(price * USD));
    return this.program.methods
      .setMockPrice(p, p.muln(confBps).divn(10_000), -6)
      .accounts({ priceAuthority: this.priceAuthority.publicKey, config: this.pda.platform(), oracle: this.pda.mockOracle(marketId) })
      .instruction();
  }

  async setPrice(marketId: number, price: number, confBps = 5) {
    this.prices.set(marketId, price);
    await this.provider.sendAndConfirm(new Transaction().add(await this.priceIx(marketId, price, confBps)), [this.priceAuthority]);
  }

  /** Re-publish every known price in one transaction (oracle max age is 25 slots ≈ 10 s). */
  async freshen() {
    const ixs = await Promise.all([...this.prices.entries()].map(([id, px]) => this.priceIx(id, px)));
    if (ixs.length) await this.provider.sendAndConfirm(new Transaction().add(...ixs), [this.priceAuthority]);
  }

  async setRisk(partial: Record<string, unknown>) {
    const cfg = await this.config();
    await this.program.methods
      .updateRiskParams({
        risk: { ...cfg.risk, ...partial }, trial: null, tierCaps: null, vestDays: null, entryFee: null,
        activationFloor: null, minDeposit: null, keeperBounty: null, bountyPerPool: null, trialAttestor: null, priceAuthority: null, minFirstLossBps: null,
      })
      .accounts({ admin: this.admin.publicKey, config: this.pda.platform() })
      .rpc();
  }

  // ---------- trader flow ----------
  async apply(trader: Keypair, instantCapUsd = 0) {
    await this.program.methods
      .applyAsTrader(usd(instantCapUsd))
      .accounts({
        trader: trader.publicKey,
        profile: this.pda.trader(trader.publicKey),
        config: this.pda.platform(),
        treasury: this.pda.treasury(),
        treasuryVault: this.pda.treasuryVault(),
        traderUsdc: this.ata(trader.publicKey),
      })
      .signers([trader])
      .rpc();
  }

  // ---------- CommonPool funding queue (Vault Ledger section 1–section 3) ----------
  commonPool() {
    return (this.program.account as any).commonPool.fetch(this.pda.commonPool());
  }
  commonPosition(investor: PublicKey) {
    return (this.program.account as any).commonPosition.fetchNullable(this.pda.commonInvestor(investor));
  }

  async initCommonPool(reserveBps = 1_000, depositEnabled = true) {
    await this.program.methods
      .initCommonPool({ reserveBps, depositEnabled })
      .accounts({
        admin: this.admin.publicKey,
        config: this.pda.platform(),
        commonPool: this.pda.commonPool(),
        commonVault: this.pda.commonVault(),
        usdcMint: this.usdc,
      })
      .rpc();
  }

  /** Stake pairs (sorted) + trailing oracle metas for the CommonPool NAV instructions. */
  async commonStakeMetas(stakedPools: PublicKey[]): Promise<AccountMeta[]> {
    const cp = this.pda.commonPool();
    const pairs = [...stakedPools].sort((a, b) => a.toBuffer().compare(b.toBuffer()));
    const ids = new Set<number>();
    for (const pool of stakedPools) for (const id of await this.openMarketIds(pool)) ids.add(id);
    return [
      ...pairs.flatMap((pool) => [
        { pubkey: pool, isSigner: false, isWritable: false },
        { pubkey: this.pda.investor(pool, cp), isSigner: false, isWritable: false },
      ]),
      ...this.oracleMetas(...ids),
    ];
  }

  commonAccounts(investor: PublicKey) {
    return {
      investor,
      commonPool: this.pda.commonPool(),
      commonVault: this.pda.commonVault(),
      position: this.pda.commonInvestor(investor),
      investorUsdc: this.ata(investor),
      config: this.pda.platform(),
      registry: this.pda.registry(),
    };
  }

  /** `stakedPools` must list every pool the CommonPool holds a stake in (any order). */
  async depositCommon(investor: Keypair, amount: number, stakedPools: PublicKey[] = []) {
    await this.freshen();
    await this.program.methods
      .depositCommon(usd(amount))
      .accounts(this.commonAccounts(investor.publicKey))
      .remainingAccounts(await this.commonStakeMetas(stakedPools))
      .signers([investor])
      .rpc();
  }

  async redeemCommon(investor: Keypair, shares: BN, stakedPools: PublicKey[] = []) {
    await this.freshen();
    await this.program.methods
      .redeemCommon(shares)
      .accounts(this.commonAccounts(investor.publicKey))
      .remainingAccounts(await this.commonStakeMetas(stakedPools))
      .signers([investor])
      .rpc();
  }

  async settleCommonRedemption(investor: Keypair, stakedPools: PublicKey[] = []) {
    await this.freshen();
    await this.program.methods
      .settleCommonRedemption()
      .accounts(this.commonAccounts(investor.publicKey))
      .remainingAccounts(await this.commonStakeMetas(stakedPools))
      .signers([investor])
      .rpc();
  }

  async requestCommonPull(caller: Keypair, pool: PublicKey) {
    await this.program.methods
      .requestCommonPull()
      .accounts({
        caller: caller.publicKey,
        commonPool: this.pda.commonPool(),
        pool,
        stake: this.pda.investor(pool, this.pda.commonPool()),
        config: this.pda.platform(),
      })
      .signers([caller])
      .rpc();
  }

  async settleCommonPull(caller: Keypair, pool: PublicKey) {
    await this.freshen();
    const ids = await this.openMarketIds(pool);
    await this.program.methods
      .settleCommonPull()
      .accounts({
        caller: caller.publicKey,
        commonPool: this.pda.commonPool(),
        commonVault: this.pda.commonVault(),
        pool,
        stake: this.pda.investor(pool, this.pda.commonPool()),
        vault: this.pda.poolVault(pool),
        config: this.pda.platform(),
        registry: this.pda.registry(),
      })
      .remainingAccounts(this.oracleMetas(...ids))
      .signers([caller])
      .rpc();
  }

  async skipDeadTicket(caller: Keypair, trader: PublicKey, rentTo: PublicKey) {
    await this.program.methods
      .skipDeadTicket()
      .accounts({
        caller: caller.publicKey,
        commonPool: this.pda.commonPool(),
        ticket: this.pda.ticket(trader),
        rentTo,
        profile: this.pda.trader(trader),
      })
      .signers([caller])
      .rpc();
  }

  async collectPlatformFee(caller: Keypair, pool: PublicKey) {
    await this.program.methods
      .collectPlatformFee()
      .accounts({
        caller: caller.publicKey,
        pool,
        vault: this.pda.poolVault(pool),
        treasury: this.pda.treasury(),
        treasuryVault: this.pda.treasuryVault(),
      })
      .signers([caller])
      .rpc();
  }

  async queueForFunding(caller: Keypair, trader: PublicKey) {
    await this.program.methods
      .queueForFunding()
      .accounts({
        caller: caller.publicKey,
        trader,
        profile: this.pda.trader(trader),
        commonPool: this.pda.commonPool(),
        ticket: this.pda.ticket(trader),
        config: this.pda.platform(),
      })
      .signers([caller])
      .rpc();
  }

  async fundNextInQueue(caller: Keypair, trader: PublicKey): Promise<PublicKey> {
    const prof = await this.profile(trader);
    const ticket = await (this.program.account as any).fundingTicket.fetch(this.pda.ticket(trader));
    const pool = this.pda.pool(trader, prof.poolsCreated);
    await this.program.methods
      .fundNextInQueue()
      .accounts({
        caller: caller.publicKey,
        commonPool: this.pda.commonPool(),
        commonVault: this.pda.commonVault(),
        ticket: this.pda.ticket(trader),
        rentTo: ticket.payer,
        profile: this.pda.trader(trader),
        config: this.pda.platform(),
        pool,
        vault: this.pda.poolVault(pool),
        stake: this.pda.investor(pool, this.pda.commonPool()),
        usdcMint: this.usdc,
        treasury: this.pda.treasury(),
        treasuryVault: this.pda.treasuryVault(),
        callerUsdc: this.ata(caller.publicKey),
      })
      .signers([caller])
      .rpc();
    return pool;
  }

  async commitDay(trader: Keypair, day: number) {
    const root = createHash("sha256").update(`day-${day}`).digest();
    await this.program.methods
      .commitTrialRoot(day, [...root])
      .accounts({ trader: trader.publicKey, profile: this.pda.trader(trader.publicKey), config: this.pda.platform() })
      .signers([trader])
      .rpc();
  }

  async finalize(trader: PublicKey, metrics: Partial<any> = {}) {
    await this.program.methods
      .finalizeTrial({
        finalEquity: usd(55_000),
        maxDrawdownBps: 500,
        maxDailyLossBps: 200,
        activeDays: 20,
        trades: 40,
        maxDayProfitShareBps: 2_000,
        ...metrics,
      })
      .accounts({ attestor: this.attestor.publicKey, trader, profile: this.pda.trader(trader), config: this.pda.platform() })
      .signers([this.attestor])
      .rpc();
  }

  /** Full path: apply → 30 commits → finalize(pass). Requires daySecs=1 and a wide grace. */
  /** The trial half of `makeEligible`, for a trader who has already applied. */
  async passTrialOnly(trader: Keypair) {
    await new Promise((r) => setTimeout(r, 31_000));
    for (let d = 0; d < 30; d++) await this.commitDay(trader, d);
    await this.finalize(trader.publicKey);
  }

  /** Lengthen the platform day after the trial. The trial needs 1-second days to
   *  complete in a test; the daily-loss floor needs days long enough that
   *  `roll_day` does not reset `day_start_nav` between opening a position and
   *  the price moving against it. */
  async setDaySecs(daySecs: number) {
    const cfg = await this.config();
    await this.program.methods
      .updateRiskParams({
        risk: null, trial: { ...cfg.trial, daySecs }, tierCaps: null, vestDays: null, entryFee: null,
        activationFloor: null, minDeposit: null, keeperBounty: null, bountyPerPool: null,
        trialAttestor: null, priceAuthority: null, minFirstLossBps: null,
      })
      .accounts({ admin: this.admin.publicKey, config: this.pda.platform() })
      .rpc();
  }

  /** minFirstLossBps is not part of `setRisk`'s risk struct. It is a top-level field. */
  async setMinFirstLoss(bps: number) {
    await this.program.methods
      .updateRiskParams({
        risk: null, trial: null, tierCaps: null, vestDays: null, entryFee: null,
        activationFloor: null, minDeposit: null, keeperBounty: null, bountyPerPool: null,
        trialAttestor: null, priceAuthority: null, minFirstLossBps: bps,
      })
      .accounts({ admin: this.admin.publicKey, config: this.pda.platform() })
      .rpc();
  }

  async makeEligible(trader: Keypair) {
    await this.apply(trader);
    await new Promise((r) => setTimeout(r, 31_000));
    for (let d = 0; d < 30; d++) await this.commitDay(trader, d);
    await this.finalize(trader.publicKey);
  }

  async createPool(trader: Keypair, target = 5_000, name = "alpha") {
    const prof = await this.profile(trader.publicKey);
    const pool = this.pda.pool(trader.publicKey, prof.poolsCreated);
    const nameBuf = Buffer.alloc(32);
    nameBuf.write(name);
    await this.program.methods
      .createPool({
        name: [...nameBuf],
        mandate: { perps: {} },
        targetSize: usd(target),
        strategyHash: new Array(32).fill(1),
        venue: { mockPerps: {} },
      })
      .accounts({
        trader: trader.publicKey,
        profile: this.pda.trader(trader.publicKey),
        config: this.pda.platform(),
        pool,
        vault: this.pda.poolVault(pool),
        usdcMint: this.usdc,
        traderUsdc: this.ata(trader.publicKey),
      })
      .signers([trader])
      .rpc();
    return pool;
  }

  async activate(pool: PublicKey, trader: PublicKey) {
    await this.program.methods
      .activatePool()
      .accounts({
        pool,
        profile: this.pda.trader(trader),
        vault: this.pda.poolVault(pool),
        config: this.pda.platform(),
        treasury: this.pda.treasury(),
        treasuryVault: this.pda.treasuryVault(),
      })
      .rpc();
  }

  async deposit(investor: Keypair, pool: PublicKey, amount: number) {
    await this.freshen();
    const ids = await this.openMarketIds(pool);
    await this.program.methods
      .deposit(usd(amount))
      .accounts({
        investor: investor.publicKey,
        pool,
        position: this.pda.investor(pool, investor.publicKey),
        vault: this.pda.poolVault(pool),
        investorUsdc: this.ata(investor.publicKey),
        config: this.pda.platform(),
        registry: this.pda.registry(),
      })
      .remainingAccounts(this.oracleMetas(...ids))
      .signers([investor])
      .rpc();
  }

  async requestRedemption(investor: Keypair, pool: PublicKey, shares: BN) {
    await this.freshen();
    const ids = await this.openMarketIds(pool);
    await this.program.methods
      .requestRedemption(shares)
      .accounts({
        investor: investor.publicKey,
        pool,
        position: this.pda.investor(pool, investor.publicKey),
        vault: this.pda.poolVault(pool),
        investorUsdc: this.ata(investor.publicKey),
        config: this.pda.platform(),
        registry: this.pda.registry(),
      })
      .remainingAccounts(this.oracleMetas(...ids))
      .signers([investor])
      .rpc();
  }

  async unwindForRedemption(caller: Keypair, pool: PublicKey, investor: PublicKey) {
    await this.freshen();
    const ids = await this.openMarketIds(pool);
    await this.program.methods
      .unwindForRedemption()
      .accounts({
        caller: caller.publicKey,
        pool,
        position: this.pda.investor(pool, investor),
        config: this.pda.platform(),
        registry: this.pda.registry(),
        treasury: this.pda.treasury(),
        treasuryVault: this.pda.treasuryVault(),
        callerUsdc: this.ata(caller.publicKey),
      })
      .remainingAccounts(this.oracleMetas(...ids))
      .signers([caller])
      .rpc();
  }

  async settleRedemption(investor: Keypair, pool: PublicKey) {
    await this.freshen();
    const ids = await this.openMarketIds(pool);
    await this.program.methods
      .settleRedemption()
      .accounts({
        investor: investor.publicKey,
        pool,
        position: this.pda.investor(pool, investor.publicKey),
        vault: this.pda.poolVault(pool),
        investorUsdc: this.ata(investor.publicKey),
        config: this.pda.platform(),
        registry: this.pda.registry(),
      })
      .remainingAccounts(this.oracleMetas(...ids))
      .signers([investor])
      .rpc();
  }

  async placeTrade(trader: Keypair, pool: PublicKey, marketId: number, side: 1 | 2, notional: number, limitPx = 0, fresh = true, stopPx?: number) {
    if (fresh) await this.freshen();
    const ids = await this.openMarketIds(pool);
    await this.program.methods
      .placeTrade({ marketId, side, notional: usd(notional), limitPx: usd(limitPx), stopPx: usd(stopPx ?? 0) })
      .accounts({ signer: trader.publicKey, trader: trader.publicKey, session: null, pool, config: this.pda.platform(), registry: this.pda.registry() })
      .remainingAccounts(this.oracleMetas(marketId, ...ids))
      .signers([trader])
      .rpc();
  }

  /** Place a trade signed by `signer` on behalf of `trader` (session-key path). */
  async placeTradeAs(signer: Keypair, trader: PublicKey, pool: PublicKey, marketId: number, side: 1 | 2, notional: number) {
    await this.freshen();
    const ids = await this.openMarketIds(pool);
    await this.program.methods
      .placeTrade({ marketId, side, notional: usd(notional), limitPx: usd(0), stopPx: usd(0) })
      .accounts({ signer: signer.publicKey, trader, session: this.pda.session(trader), pool, config: this.pda.platform(), registry: this.pda.registry() })
      .remainingAccounts(this.oracleMetas(marketId, ...ids))
      .signers([signer])
      .rpc();
  }

  async setSessionKey(trader: Keypair, key: PublicKey, ttlSecs: number) {
    await this.program.methods
      .setSessionKey(key, new BN(ttlSecs))
      .accounts({ trader: trader.publicKey, profile: this.pda.trader(trader.publicKey), session: this.pda.session(trader.publicKey) })
      .signers([trader])
      .rpc();
  }

  async revokeSessionKey(trader: Keypair) {
    await this.program.methods
      .revokeSessionKey()
      .accounts({ trader: trader.publicKey, session: this.pda.session(trader.publicKey) })
      .signers([trader])
      .rpc();
  }

  async closeTrade(trader: Keypair, pool: PublicKey, marketId: number, baseQty = new BN(0), limitPx = 0) {
    await this.freshen();
    const ids = await this.openMarketIds(pool);
    await this.program.methods
      .closeTrade({ marketId, baseQty, limitPx: usd(limitPx) })
      .accounts({ signer: trader.publicKey, trader: trader.publicKey, session: null, pool, config: this.pda.platform(), registry: this.pda.registry() })
      .remainingAccounts(this.oracleMetas(marketId, ...ids))
      .signers([trader])
      .rpc();
  }

  riskAccounts(caller: Keypair, pool: PublicKey, profile: PublicKey) {
    return {
      caller: caller.publicKey,
      pool,
      profile,
      config: this.pda.platform(),
      registry: this.pda.registry(),
      vault: this.pda.poolVault(pool),
      treasury: this.pda.treasury(),
      treasuryVault: this.pda.treasuryVault(),
      callerUsdc: this.ata(caller.publicKey),
    };
  }

  async evaluateRisk(caller: Keypair, pool: PublicKey) {
    await this.freshen();
    const p = await this.pool(pool);
    const ids = await this.openMarketIds(pool);
    await this.program.methods
      .evaluateRisk()
      .accounts(this.riskAccounts(caller, pool, p.profile))
      .remainingAccounts(this.oracleMetas(...ids))
      .signers([caller])
      .rpc();
  }

  async lockPool(caller: Keypair, pool: PublicKey) {
    await this.freshen();
    const p = await this.pool(pool);
    const ids = await this.openMarketIds(pool);
    await this.program.methods
      .lockPool()
      .accounts(this.riskAccounts(caller, pool, p.profile))
      .remainingAccounts(this.oracleMetas(...ids))
      .signers([caller])
      .rpc();
  }

  async unwindAll(caller: Keypair, pool: PublicKey) {
    await this.freshen();
    const p = await this.pool(pool);
    const ids = await this.openMarketIds(pool);
    await this.program.methods
      .unwindAll()
      .accounts(this.riskAccounts(caller, pool, p.profile))
      .remainingAccounts(this.oracleMetas(...ids))
      .signers([caller])
      .rpc();
  }

  async vest(pool: PublicKey) {
    await this.program.methods.vestEscrow().accounts({ pool, config: this.pda.platform() }).rpc();
  }

  async claimFees(trader: Keypair, pool: PublicKey) {
    await this.freshen();
    const ids = await this.openMarketIds(pool);
    await this.program.methods
      .claimTraderFees()
      .accounts({
        trader: trader.publicKey,
        pool,
        vault: this.pda.poolVault(pool),
        traderUsdc: this.ata(trader.publicKey),
        config: this.pda.platform(),
        registry: this.pda.registry(),
        profile: this.pda.trader(trader.publicKey),
        treasury: this.pda.treasury(),
        treasuryVault: this.pda.treasuryVault(),
      })
      .remainingAccounts(this.oracleMetas(...ids))
      .signers([trader])
      .rpc();
  }

  async closePool(trader: Keypair, pool: PublicKey) {
    await this.program.methods
      .closePool()
      .accounts({ trader: trader.publicKey, pool, profile: this.pda.trader(trader.publicKey) })
      .signers([trader])
      .rpc();
  }

  /** Registers a throwaway market. The oracle is never read. Nothing trades it. */
  async registerMarket(marketId: number, symbolStr: string) {
    const symbol = Buffer.alloc(8);
    symbol.write(symbolStr);
    await this.program.methods
      .registerMarket({
        marketId,
        symbol: [...symbol],
        oracle: this.pda.mockOracle(marketId),
        feedId: new Array(32).fill(0),
        maxLeverageBps: 50_000,
        cluster: 0,
        venueMarketIndex: 0,
      })
      .accounts({ admin: this.admin.publicKey, config: this.pda.platform(), registry: this.pda.registry() })
      .rpc();
  }

  async setMarketEnabled(marketId: number, enabled: boolean) {
    await this.program.methods
      .setMarketEnabled(marketId, enabled)
      .accounts({ admin: this.admin.publicKey, config: this.pda.platform(), registry: this.pda.registry() })
      .rpc();
  }

  async removeMarket(marketId: number) {
    await this.program.methods
      .removeMarket(marketId)
      .accounts({ admin: this.admin.publicKey, config: this.pda.platform(), registry: this.pda.registry() })
      .rpc();
  }

  async reapPool(caller: Keypair, pool: PublicKey) {
    await this.program.methods
      .reapPool()
      .accounts({
        caller: caller.publicKey,
        config: this.pda.platform(),
        pool,
        vault: this.pda.poolVault(pool),
        treasury: this.pda.treasury(),
        treasuryVault: this.pda.treasuryVault(),
        commonPool: this.pda.commonPool(),
        commonVault: this.pda.commonVault(),
      })
      .signers([caller])
      .rpc();
  }

  /** Permissionless: a dead attempt's held fee → CommonPool idle (investor value). */
  async sweepForfeitedFee(caller: Keypair, trader: PublicKey) {
    await this.program.methods
      .sweepForfeitedFee()
      .accounts({
        caller: caller.publicKey,
        trader,
        profile: this.pda.trader(trader),
        commonPool: this.pda.commonPool(),
        commonVault: this.pda.commonVault(),
        config: this.pda.platform(),
        treasury: this.pda.treasury(),
        treasuryVault: this.pda.treasuryVault(),
      })
      .signers([caller])
      .rpc();
  }
}

/** Expect an Anchor error with the given error code name. */
export async function expectError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e: any) {
    const msg = e?.error?.errorCode?.code ?? e?.message ?? String(e);
    if (String(msg).includes(code)) return;
    throw new Error(`expected error ${code}, got: ${msg}`);
  }
  throw new Error(`expected error ${code}, but call succeeded`);
}

export const nav = (p: any) => Number(p.lastMarkNav.toString()) / USD;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
