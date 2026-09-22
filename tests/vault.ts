/**
 * End-to-end tests for the vault program against the MockPerps venue.
 * Covers the trader funnel, pool lifecycle, NAV/shares, the pre-trade guard,
 * the 80/20 split with clawback and vesting, redemptions, and the risk lock.
 */
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { Env, expectError, MARKETS, REAP_PLATFORM_BPS, SHARE_SCALE, sleep, usd, USD } from "./helpers";

describe("vault", () => {
  const env = new Env();
  let trader: Keypair;
  let investorA: Keypair;
  let investorB: Keypair;
  let keeper: Keypair;
  let pool: PublicKey;
  /** Fails the trial in the funnel suite; their forfeited fee is swept into the
   *  CommonPool much later, once there are investors to credit it to. */
  let loser: Keypair;

  before(async () => {
    await env.createUsdc();
    await env.initPlatform({ daySecs: 1, graceDays: 60, minHold: 0, lockup: 0 }); // strict grace (< 365): keep the real root path under test
    await env.registerMarkets();
    await env.fundUsdc(env.admin.publicKey, 1_000);
    // Two $800 applications across the suite, plus the seed capital: since
    // `deposit` is now the trader seeding their own pool (investors reach a
    // trader only through the CommonPool), the trader is the only wallet that
    // can put money into this pool.
    trader = await env.newWallet(5, 8_000);
    investorA = await env.newWallet(5, 20_000);
    investorB = await env.newWallet(5, 20_000);
    keeper = await env.newWallet(5, 1);
    // `reap_pool` returns a dead pool's remainder here, so the CommonPool has
    // to exist from the start. Not just for the queue tests further down.
    await env.initCommonPool(1_000, true); // 10% idle reserve, deposits enabled (test money)
  });

  describe("platform setup", () => {
    it("stores config, registry and treasury", async () => {
      const cfg = await env.config();
      expect(cfg.entryFee.toString()).to.eq(usd(800).toString());
      expect(cfg.tierCaps.map((x: BN) => x.toString())).to.deep.eq([usd(5_000), usd(15_000), usd(30_000)].map((x) => x.toString()));
      expect(cfg.risk.maxLeverageBps).to.eq(30_000);
      const reg = await env.registry();
      expect(reg.count).to.eq(3);
      expect(Buffer.from(reg.markets[0].symbol).toString().replace(/\0+$/, "")).to.eq("SOL-PERP");
    });

    it("rejects an entry fee below the section 5.2 invariant", async () => {
      await expectError(
        env.program.methods
          .updateRiskParams({
            risk: null, trial: null, tierCaps: null, vestDays: null,
            entryFee: usd(300), activationFloor: null, minDeposit: null,
            keeperBounty: null, bountyPerPool: null, trialAttestor: null, priceAuthority: null,
            minFirstLossBps: null,
          })
          .accounts({ admin: env.admin.publicKey, config: env.pda.platform() })
          .rpc(),
        "InvalidArgument",
      );
    });
  });

  describe("trader funnel", () => {
    it("apply holds $800 in treasury custody. Not revenue, not bounty (Vault Ledger fee model)", async () => {
      const before = await env.usdcBalance(trader.publicKey);
      await env.apply(trader);
      const after = await env.usdcBalance(trader.publicKey);
      expect(before - after).to.eq(800);
      // The fee is future first-loss seed capital, so neither ledger moves…
      const t = await env.treasury();
      expect(t.bountyReserve.toString()).to.eq("0");
      expect(t.revenue.toString()).to.eq("0");
      // …but the vault physically holds it, and the profile tracks it.
      expect(await env.tokenBalance(env.pda.treasuryVault())).to.eq(800);
      const prof = await env.profile(trader.publicKey);
      expect(prof.feePaid.toString()).to.eq(usd(800).toString());
      expect(prof.status).to.deep.eq({ trial: {} });
      expect(prof.attempts).to.eq(1);
    });

    it("cannot apply twice while in trial", async () => {
      await expectError(env.apply(trader), "InvalidTraderStatus");
    });

    it("cannot commit a day that has not ended, nor out of order", async () => {
      await expectError(env.commitDay(trader, 1), "TrialDayOutOfOrder");
    });

    it("cannot finalize before 30 committed days", async () => {
      await expectError(env.finalize(trader.publicKey), "TrialNotComplete");
    });

    it("commits 30 daily roots and passes the trial", async () => {
      await sleep(31_000);
      for (let d = 0; d < 30; d++) await env.commitDay(trader, d);
      const prof = await env.profile(trader.publicKey);
      expect(prof.trialDaysCommitted).to.eq(30);
      await env.finalize(trader.publicKey);
      const after = await env.profile(trader.publicKey);
      expect(after.status).to.deep.eq({ eligible: {} });
      expect(after.tier).to.eq(1);
    }).timeout(120_000);

    it("a failing trial sets Failed + cooldown, and forfeits the held fee", async () => {
      loser = await env.newWallet(5, 1_000);
      await env.apply(loser);
      await sleep(31_000);
      for (let d = 0; d < 30; d++) await env.commitDay(loser, d);
      const tBefore = await env.treasury();
      const heldBefore = await env.tokenBalance(env.pda.treasuryVault());
      await env.finalize(loser.publicKey, { finalEquity: usd(51_000) }); // +2% < +8% target
      const prof = await env.profile(loser.publicKey);
      expect(prof.status).to.deep.eq({ failed: {} });
      expect(prof.cooldownUntil.toNumber()).to.be.greaterThan(Math.floor(Date.now() / 1000) + 6 * 86_400);
      await expectError(env.apply(loser), "InCooldown");

      // The fee stops being earmarked as future seed capital and becomes a debt
      // to the investors. Nothing has moved yet: it is still sitting in the
      // treasury vault, and it is still NOT the platform's revenue.
      expect(prof.feePaid.toString()).to.eq("0");
      expect(prof.feeForfeited.toString()).to.eq(usd(800).toString());
      const tAfter = await env.treasury();
      expect(tAfter.revenue.toString()).to.eq(tBefore.revenue.toString());
      expect(tAfter.bountyReserve.toString()).to.eq(tBefore.bountyReserve.toString());
      expect(await env.tokenBalance(env.pda.treasuryVault())).to.eq(heldBefore);
    }).timeout(120_000);

    it("only the attestor can finalize", async () => {
      const other = await env.newWallet(1, 0);
      await expectError(
        env.program.methods
          .finalizeTrial({ finalEquity: usd(60_000), maxDrawdownBps: 0, maxDailyLossBps: 0, activeDays: 30, trades: 50, maxDayProfitShareBps: 1000 })
          .accounts({ attestor: other.publicKey, trader: trader.publicKey, profile: env.pda.trader(trader.publicKey), config: env.pda.platform() })
          .signers([other])
          .rpc(),
        "Unauthorized",
      );
    });
  });

  describe("pool creation and funding", () => {
    it("creates a Tier-1 pool with dead shares against a 1 USDC seed", async () => {
      pool = await env.createPool(trader, 5_000);
      const p = await env.pool(pool);
      expect(p.status).to.deep.eq({ funding: {} });
      expect(p.tier).to.eq(1);
      expect(p.totalShares.toString()).to.eq("1000000000");
      expect(p.accountedUsdc.toString()).to.eq(USD.toString());
      const prof = await env.profile(trader.publicKey);
      expect(prof.activePool.toBase58()).to.eq(pool.toBase58());
    });

    it("rejects a second pool for the same trader", async () => {
      await expectError(env.createPool(trader, 5_000), "PoolAlreadyExists");
    });

    it("rejects a target above the tier cap", async () => {
      const t2 = await env.newWallet(5, 1_000);
      await env.apply(t2);
      await expectError(env.createPool(t2, 6_000), "NotEligible");
    });

    it("a market can be removed only once disabled, and the registry shrinks", async () => {
      // Nothing else can shrink the registry: register_market replaces by id or
      // appends, and `count` only grows, so a retired market kept a live feed
      // id in the indexer's Hermes batch and an unfed oracle reading $0.0000.
      const before = await env.registry();
      await env.registerMarket(99, "TMP");
      expect((await env.registry()).count).to.eq(before.count + 1);
      // Enabled markets are refused: a pool holding a position in one would
      // become unmarkable and unwindable the moment it vanished.
      await expectError(env.removeMarket(99), "MarketStillEnabled");
      await env.setMarketEnabled(99, false);
      await env.removeMarket(99);
      const after = await env.registry();
      expect(after.count).to.eq(before.count);
      expect(after.markets.slice(0, after.count).some((m: any) => m.marketId === 99)).to.eq(false);
      // The other markets survive the swap-remove intact.
      for (const m of before.markets.slice(0, before.count))
        expect(after.markets.slice(0, after.count).some((x: any) => x.marketId === m.marketId)).to.eq(true);
    });

    it("refuses a deposit from anyone but the pool's own trader", async () => {
      // The invariant: investors fund the CommonPool, which funds traders in
      // queue order. Nobody buys into one trader, so `deposit` is the trader
      // seeding their own pool and nothing else.
      await expectError(env.deposit(investorA, pool, 500), "DirectDepositDisabled");
      await expectError(env.deposit(investorB, pool, 500), "DirectDepositDisabled");
    });

    it("rejects deposits below $50 and cannot activate under $1,000", async () => {
      await expectError(env.deposit(trader, pool, 10), "DepositTooSmall");
      await env.deposit(trader, pool, 500);
      await expectError(env.activate(pool, trader.publicKey), "BelowActivationFloor");
    });

    it("mints shares at NAV/share and activates at ≥ $1,000", async () => {
      await env.deposit(trader, pool, 1_500);
      const p = await env.pool(pool);
      // nav = 1 + 500 + 1500 = 2001 USDC; shares 1e9 per USDC
      expect(p.accountedUsdc.toString()).to.eq(usd(2_001).toString());
      expect(p.totalShares.toString()).to.eq(new BN(2_001).mul(new BN(1_000_000_000)).toString());
      await env.activate(pool, trader.publicKey);
      const live = await env.pool(pool);
      expect(live.status).to.deep.eq({ live: {} });
      // Activation injected the trader's held $800 fee as no-shares first-loss
      // seed (Vault Ledger section 2): NAV jumps 2,001 → 2,801 with no new shares.
      expect(live.accountedUsdc.toString()).to.eq(usd(2_801).toString());
      expect(live.peakNav.toString()).to.eq(usd(2_801).toString());
      expect(live.dayStartNav.toString()).to.eq(usd(2_801).toString());
      const prof = await env.profile(trader.publicKey);
      expect(prof.feePaid.toString()).to.eq("0"); // consumed as seed
    });

    it("rejects deposits above the tier cap", async () => {
      await expectError(env.deposit(trader, pool, 3_500), "ExceedsTierCap");
      await env.deposit(trader, pool, 1_700); // nav 4001 (the $800 fee seed already added 300)
    });
  });

  describe("pre-trade guard", () => {
    it("only the trader delegate can trade", async () => {
      await expectError(env.placeTrade(investorA, pool, MARKETS.SOL.id, 1, 100), "NotTraderDelegate");
    });

    it("rejects > 40% single position", async () => {
      await expectError(env.placeTrade(trader, pool, MARKETS.SOL.id, 1, 2_000), "SinglePositionExceeded");
    });

    it("rejects > 60% cluster exposure (BTC+ETH are 'majors')", async () => {
      await env.placeTrade(trader, pool, MARKETS.BTC.id, 1, 1_500);
      await expectError(env.placeTrade(trader, pool, MARKETS.ETH.id, 1, 1_500), "ClusterExceeded");
      await env.closeTrade(trader, pool, MARKETS.BTC.id);
    });

    it("rejects gross leverage above the cap", async () => {
      // With three markets the cluster caps bound gross at ~100% of NAV, so 3× can't be reached;
      // tighten leverage to 1× to exercise step 11 (checked before the cluster step 13).
      await env.setRisk({ maxLeverageBps: 10_000 });
      await env.placeTrade(trader, pool, MARKETS.SOL.id, 1, 1_500);
      await env.placeTrade(trader, pool, MARKETS.BTC.id, 2, 1_500);
      await expectError(env.placeTrade(trader, pool, MARKETS.ETH.id, 1, 1_700), "LeverageExceeded");
      await env.setRisk({ maxLeverageBps: 30_000 });
      for (const id of [MARKETS.SOL.id, MARKETS.BTC.id]) await env.closeTrade(trader, pool, id);
    });

    it("rejects a limit price outside 200 bps of oracle", async () => {
      await expectError(env.placeTrade(trader, pool, MARKETS.SOL.id, 1, 500, 160), "LimitOutOfBand");
    });

    it("rejects a stale oracle", async () => {
      // A mock price set > 25 slots ago is stale. The local validator's slot time drifts
      // above 400 ms on laptops, so wait long enough to be sure ~40 slots have passed.
      await sleep(20_000);
      await expectError(env.placeTrade(trader, pool, MARKETS.SOL.id, 1, 500, 0, false), "OracleStale");
      await env.setPrice(MARKETS.SOL.id, 150);
    }).timeout(45_000);

    it("rejects a disabled market for opening but not for closing", async () => {
      await env.placeTrade(trader, pool, MARKETS.SOL.id, 1, 500);
      await env.program.methods
        .setMarketEnabled(MARKETS.SOL.id, false)
        .accounts({ admin: env.admin.publicKey, config: env.pda.platform(), registry: env.pda.registry() })
        .rpc();
      await expectError(env.placeTrade(trader, pool, MARKETS.SOL.id, 1, 100), "MarketDisabled");
      await env.closeTrade(trader, pool, MARKETS.SOL.id);
      await env.program.methods
        .setMarketEnabled(MARKETS.SOL.id, true)
        .accounts({ admin: env.admin.publicKey, config: env.pda.platform(), registry: env.pda.registry() })
        .rpc();
    });

    it("rejects an opposite-side order on an open position", async () => {
      await env.placeTrade(trader, pool, MARKETS.SOL.id, 1, 500);
      await expectError(env.placeTrade(trader, pool, MARKETS.SOL.id, 2, 100), "OppositeSide");
      await env.closeTrade(trader, pool, MARKETS.SOL.id);
    });
  });

  describe("session keys (1-click trading)", () => {
    let session: Keypair;

    it("a random key cannot trade the pool", async () => {
      const stranger = await env.newWallet(1, 0);
      await expectError(env.placeTradeAs(stranger, trader.publicKey, pool, MARKETS.SOL.id, 1, 100), "AccountNotInitialized");
    });

    it("the trader authorises a session key (≤ 24 h) and it can place and close trades", async () => {
      session = await env.newWallet(1, 0);
      await expectError(env.setSessionKey(trader, session.publicKey, 25 * 3600), "InvalidArgument");
      await env.setSessionKey(trader, session.publicKey, 3600);
      await env.placeTradeAs(session, trader.publicKey, pool, MARKETS.SOL.id, 1, 300);
      const p = await env.pool(pool);
      expect(p.openPositions).to.eq(1);
      await env.closeTrade(trader, pool, MARKETS.SOL.id);
    });

    it("a session key cannot claim fees or close the pool", async () => {
      // Rejected by the account constraints (pool.has_one = trader / profile seeds) before any handler runs.
      try {
        await env.program.methods
          .closePool()
          .accounts({ trader: session.publicKey, pool, profile: env.pda.trader(trader.publicKey) })
          .signers([session])
          .rpc();
        throw new Error("close_pool by a session key should have been rejected");
      } catch (e: any) {
        const code = e?.error?.errorCode?.code ?? String(e);
        expect(["ConstraintHasOne", "ConstraintSeeds", "NotTraderDelegate", "NotPoolTrader"].some((c) => String(code).includes(c)), code).to.eq(true);
      }
    });

    it("revoking the session key stops it immediately", async () => {
      await env.revokeSessionKey(trader);
      await expectError(env.placeTradeAs(session, trader.publicKey, pool, MARKETS.SOL.id, 1, 100), "AccountNotInitialized");
    });

    it("an expired session key is rejected", async () => {
      await env.setSessionKey(trader, session.publicKey, 1);
      await sleep(2_500);
      await expectError(env.placeTradeAs(session, trader.publicKey, pool, MARKETS.SOL.id, 1, 100), "NotTraderDelegate");
      await env.revokeSessionKey(trader);
    });
  });

  describe("profit split, clawback, vesting, HWM", () => {
    let navBefore: number;

    it("a winning close accrues 80% of net realized PnL to escrow", async () => {
      const p0 = await env.pool(pool);
      navBefore = Number(p0.accountedUsdc) / USD;
      const realized0 = Number(p0.realizedPnl) / USD;
      const escrow0 = Number(p0.escrowTotal) / USD;
      await env.setPrice(MARKETS.SOL.id, 150);
      await env.placeTrade(trader, pool, MARKETS.SOL.id, 1, 1_000); // ~6.66 SOL @ 150.075
      await env.setPrice(MARKETS.SOL.id, 165); // +10%
      await env.closeTrade(trader, pool, MARKETS.SOL.id);
      const p1 = await env.pool(pool);
      const realized = Number(p1.realizedPnl) / USD - realized0;
      expect(realized).to.be.greaterThan(90).and.lessThan(100); // ≈ +99 minus spread and fee
      // The split is on NET NEW profit, not on the winning trade: the pool has
      // been paying spread and fees since it opened, so `realized0` is negative
      // and the first part of this win only climbs back to flat. Nothing is
      // earned until cumulative realized PnL is above water.
      const accruable = Math.max(0, realized0 + realized) - Math.max(0, realized0);
      expect(accruable).to.be.lessThan(realized); // i.e. this test is actually exercising the rule
      const escrow = Number(p1.escrowTotal) / USD - escrow0;
      expect(escrow).to.be.closeTo(accruable * 0.8, 0.01);
      // Vault Ledger section 6: 5% of net new profit accrues as the platform fee
      // (carved from the pool's former 20%. Investors keep 15%).
      const feeDelta = (Number(p1.platformFeeOwed) - Number(p0.platformFeeOwed)) / USD;
      expect(feeDelta).to.be.closeTo(accruable * 0.05, 0.01);
      const bucket = (p1.escrow as any[]).find((b) => Number(b.amount) > 0);
      expect(bucket.unlockDay - p1.dayEpoch).to.eq(14); // Tier 1 vests in 14 days
      expect(p1.hwmNps.gt(p0.hwmNps)).to.eq(true);
    });

    it("a losing close claws back from escrow, nearest unlock first", async () => {
      await env.setPrice(MARKETS.SOL.id, 165);
      await env.placeTrade(trader, pool, MARKETS.SOL.id, 1, 1_000);
      await env.setPrice(MARKETS.SOL.id, 150); // −9%
      await env.closeTrade(trader, pool, MARKETS.SOL.id);
      const p = await env.pool(pool);
      // The ≈91 loss takes cumulative realized PnL from ≈+90 back to ≈flat, so
      // under net-new-high the clawback reverses the WHOLE accrual and escrow
      // lands on zero.
      //
      // This previously expected ≈6 left over, because the clawback was 80% of
      // the losing trade while the accrual had been 80% of the winning one and
      // the two did not have to agree. That residue was the bug: escrow held
      // against a trader who was no longer up on the pool at all, carved out of
      // investor NAV, and (on a voluntary close) unclaimable below the HWM.
      const cum = Number(p.realizedPnl) / USD;
      expect(cum).to.be.lessThan(1); // back to flat or just under
      expect(Number(p.escrowTotal) / USD).to.eq(0);
    });

    it("claim is blocked while NAV/share is below the high-water mark", async () => {
      // With 1-second test "days" the bucket may already have vested; either way the
      // claim must not pay: nothing vested, or NAV/share is below the HWM after the loss.
      await env.vest(pool);
      try {
        await env.claimFees(trader, pool);
        throw new Error("claim should have been rejected");
      } catch (e: any) {
        const code = e?.error?.errorCode?.code ?? String(e);
        expect(["NothingToClaim", "BelowHighWaterMark"].some((c) => String(code).includes(c)), code).to.eq(true);
      }
    });
  });

  /**
   * One holder, not two. `deposit` is now gated to the pool's own trader, so a
   * pool can only ever have the trader's seed position and the CommonPool's
   * stake, and the CommonPool's is redeemed through `settle_common_pull`, not
   * here. The two-investor pro-rata scenario these tests used to describe is
   * unreachable by construction.
   *
   * The dollar ranges that went with it are gone too: they were derived from
   * $500/$1,500/$1,700 split across two wallets. What is asserted instead is
   * the property those numbers were standing in for. A redemption is priced on
   * *investor* NAV, so it must come in below a naive share-of-equity figure,
   * because the trader's fee seed sits in equity and mints no shares.
   */
  describe("redemption", () => {
    /** What this many shares would be worth if equity were shared pro-rata.
        The figure a redemption must come in *below*, because the fee seed is in
        equity and mints no shares. Read before the call. */
    const shareOfEquity = async (part: BN) => {
      const p = await env.pool(pool);
      const frac = Number(part.toString()) / Number(p.totalShares.toString());
      return (frac * Number(p.accountedUsdc)) / USD;
    };

    it("pays immediately from free collateral and burns shares", async () => {
      const pos = await env.investor(pool, trader.publicKey);
      const part = new BN(pos.shares).divn(4);
      const naive = await shareOfEquity(part);
      const before = await env.usdcBalance(trader.publicKey);
      await env.requestRedemption(trader, pool, part);
      const after = await env.usdcBalance(trader.publicKey);
      const paid = after - before;
      expect(paid).to.be.greaterThan(0);
      // Below the naive figure: the $800 fee seed is in equity, mints no shares
      // and is excluded from investor NAV, so it never marks this stake up.
      expect(paid).to.be.lessThan(naive);
      const pos2 = await env.investor(pool, trader.publicKey);
      expect(new BN(pos2.shares).toString()).to.eq(new BN(pos.shares).sub(part).toString());
    });

    it("queues, unwinds pro-rata, and settles when free collateral is insufficient", async () => {
      // With only three test markets the cluster caps bound gross at ~100% of NAV, which at 3×
      // leaves free collateral ≈ 67% of NAV. Tighten leverage to 1× so 78% notional leaves ~22% free.
      await env.setRisk({ maxLeverageBps: 10_000 });
      await env.setPrice(MARKETS.SOL.id, 150);
      await env.setPrice(MARKETS.BTC.id, 60_000);
      const p = await env.pool(pool);
      const navNow = Number(p.accountedUsdc) / USD;
      await env.placeTrade(trader, pool, MARKETS.SOL.id, 1, navNow * 0.39);
      await env.placeTrade(trader, pool, MARKETS.BTC.id, 2, navNow * 0.39);
      const pos = await env.investor(pool, trader.publicKey);
      // Three quarters, not all of it: the unwind_all test further down still
      // needs a holder to redeem at final NAV, and with one holder per pool
      // there is nobody else to be it.
      const part = new BN(pos.shares).muln(3).divn(4);
      await env.requestRedemption(trader, pool, part); // far above free collateral → queues
      const queued = await env.investor(pool, trader.publicKey);
      expect(new BN(queued.pendingShares).gt(new BN(0))).to.eq(true);

      await expectError(env.settleRedemption(trader, pool), "UnwindRequired");
      const keeperBefore = await env.usdcBalance(keeper.publicKey);
      await env.unwindForRedemption(keeper, pool, trader.publicKey);
      // Vault Ledger fee model: the bounty reserve has no funding source, so the
      // permissionless call succeeds but pays nothing (the flagged open gap).
      expect((await env.usdcBalance(keeper.publicKey)) - keeperBefore).to.eq(0);
      const p2 = await env.pool(pool);
      const solQty = Number((p2.positions as any[]).find((x) => x.marketId === MARKETS.SOL.id).baseQty);
      const solQtyBefore = Number((p.positions as any[]).find((x) => x.marketId === MARKETS.SOL.id)?.baseQty ?? 0);
      expect(solQty).to.be.lessThan(Number(solQtyBefore) || Infinity);

      const before = await env.usdcBalance(trader.publicKey);
      await env.settleRedemption(trader, pool);
      const after = await env.usdcBalance(trader.publicKey);
      // Paid out, net of the unwind cost this redemption bears.
      expect(after - before).to.be.greaterThan(0);
      const left = await env.investor(pool, trader.publicKey);
      expect(new BN(left.pendingShares).isZero()).to.eq(true); // settled
      expect(new BN(left.shares).toString()).to.eq(new BN(pos.shares).sub(part).toString());
      for (const id of [MARKETS.SOL.id, MARKETS.BTC.id]) await env.closeTrade(trader, pool, id);
      await env.setRisk({ maxLeverageBps: 30_000 });
    });
  });

  describe("risk lock", () => {
    it("keeper mark with no breach does nothing but update NAV", async () => {
      await env.evaluateRisk(keeper, pool);
      const p = await env.pool(pool);
      expect(p.status).to.deep.eq({ live: {} });
    });

    it("lock_pool errors when there is no breach", async () => {
      await expectError(env.lockPool(keeper, pool), "NoBreach");
    });

    it("a 10% drawdown from peak locks the pool, freezes the trader and pays the bounty", async () => {
      for (const id of await env.openMarketIds(pool)) await env.closeTrade(trader, pool, id);
      await env.setPrice(MARKETS.SOL.id, 150);
      await env.setPrice(MARKETS.ETH.id, 3_000);
      const p = await env.pool(pool);
      const navNow = Number(p.accountedUsdc) / USD;
      await env.placeTrade(trader, pool, MARKETS.SOL.id, 1, navNow * 0.39);
      await env.placeTrade(trader, pool, MARKETS.ETH.id, 1, navNow * 0.39);
      // 78% notional long; a 15% drop ≈ −11.7% NAV → breaches both daily (4%) and drawdown (10%).
      await env.setPrice(MARKETS.SOL.id, 127.5);
      await env.setPrice(MARKETS.ETH.id, 2_550);
      // Shorten the cooldown BEFORE the lock stamps it. Cooldown_until is an
      // absolute timestamp, so changing cooldownSecs later cannot unstick it.
      await env.setRisk({ cooldownSecs: 2 });
      // trader can no longer open: guard catches it first. With 1-second test "days" the
      // day-start NAV may have rolled already, so either loss limit is a valid rejection.
      try {
        await env.placeTrade(trader, pool, MARKETS.BTC.id, 1, 100);
        throw new Error("trade should have been rejected");
      } catch (e: any) {
        const code = e?.error?.errorCode?.code ?? String(e);
        expect(["DailyLossBreach", "DrawdownBreach"].some((c) => String(code).includes(c)), code).to.eq(true);
      }
      const keeperBefore = await env.usdcBalance(keeper.publicKey);
      const seedBefore = Number((await env.pool(pool)).firstLossSeed);
      await env.evaluateRisk(keeper, pool);
      const locked = await env.pool(pool);
      expect(locked.status).to.deep.eq({ locked: {} });
      expect([1, 2]).to.include(locked.lockReason); // 1 = daily loss, 2 = drawdown (day may have rolled)
      expect(Number(locked.escrowTotal)).to.eq(0); // unvested escrow returned to the pool
      // The bounty is self-funded: it comes out of the trader's first-loss seed,
      // not the (unfunded) shared reserve and not investor NAV. That is what
      // makes an independent liquidator worth running at all.
      const paid = (await env.usdcBalance(keeper.publicKey)) - keeperBefore;
      expect(paid).to.be.greaterThan(0);
      expect(seedBefore - Number(locked.firstLossSeed)).to.eq(paid * USD);
      const prof = await env.profile(trader.publicKey);
      expect(prof.status).to.deep.eq({ frozen: {} });
      expect(prof.tier).to.eq(0);
      expect(prof.poolsLocked).to.eq(1);
      expect(prof.activePool.toBase58()).to.eq(PublicKey.default.toBase58());
      // Cooldown-after-lock (Vault Ledger section 5): the breach stamps a cooldown
      // (2 s here. See setRisk above; 7 days on the real config) and an
      // immediate re-apply (including instant funding) is rejected.
      expect(prof.cooldownUntil.toNumber()).to.be.greaterThan(0);
      await expectError(env.apply(trader), "InCooldown");
      await expectError(env.apply(trader, 5_000), "InCooldown");
    });

    it("trading is halted on a locked pool", async () => {
      await expectError(env.placeTrade(trader, pool, MARKETS.BTC.id, 1, 100), "InvalidPoolStatus");
      await expectError(env.closeTrade(trader, pool, MARKETS.SOL.id), "InvalidPoolStatus");
    });

    it("unwind_all closes every position at market and investors redeem at final NAV", async () => {
      await env.unwindAll(keeper, pool);
      const p = await env.pool(pool);
      expect(p.openPositions).to.eq(0);
      const held = await env.investor(pool, trader.publicKey);
      const before = await env.usdcBalance(trader.publicKey);
      await env.requestRedemption(trader, pool, new BN(held.shares));
      const after = await env.usdcBalance(trader.publicKey);
      expect(after - before).to.be.greaterThan(0);
      const p2 = await env.pool(pool);
      // Only dead shares remain
      expect(p2.totalShares.toString()).to.eq("1000000000");
    });

    it("reap_pool falls back to the treasury when the common pool has no investors", async () => {
      // The leftover is the unspent part of the trader's first-loss seed, and it
      // belongs to the investors, but there are none yet: the CommonPool has
      // been initialized and holds no shares, so idle value would sit unowned
      // and go to whoever deposited next. It goes to the treasury instead. The
      // investor path is covered at the end of the CommonPool suite.
      expect((await env.commonPool()).totalShares.toString()).to.eq("0");
      const tBefore = await env.treasury();
      const cpBefore = await env.commonPool();
      await env.reapPool(keeper, pool);
      const tAfter = await env.treasury();
      const swept = new BN(tAfter.dustSwept.toString()).sub(new BN(tBefore.dustSwept.toString()));
      // Positive, and no more than the $800 seed that was posted: the trader's
      // losses, the liquidation bounty and the platform's 5% all came out of it
      // first.
      expect(swept.gtn(0)).to.eq(true);
      expect(swept.lte(usd(800))).to.eq(true);
      expect((await env.commonPool()).accountedIdle.toString()).to.eq(cpBefore.accountedIdle.toString());
      expect(await (env.program.account as any).pool.fetchNullable(pool)).to.eq(null);
    });

    it("a frozen trader re-applies at tier 0 once the lock's cooldown elapses", async () => {
      await sleep(3_000); // the 2 s cooldown stamped at lock time
      await env.apply(trader);
      const prof = await env.profile(trader.publicKey);
      expect(prof.status).to.deep.eq({ trial: {} });
      expect(prof.attempts).to.eq(2);
      expect(prof.tier).to.eq(0);
      await env.setRisk({ cooldownSecs: 7 * 86_400 });
    });
  });

  describe("safety", () => {
    it("pause blocks deposits; unpause restores", async () => {
      await env.program.methods.pause().accounts({ admin: env.admin.publicKey, config: env.pda.platform() }).rpc();
      await expectError(env.apply(await env.newWallet(1, 1_000)), "Paused");
      await env.program.methods.unpause().accounts({ admin: env.admin.publicKey, config: env.pda.platform() }).rpc();
    });

    it("admin can withdraw revenue only. Never held fees or the bounty reserve", async () => {
      // Under the Vault Ledger fee model revenue is the platform's 5% cut,
      // swept at reap; the held entry fees sitting in the vault are out of
      // reach, and the reaped pool's remainder now goes to the CommonPool.
      const t = await env.treasury();
      const dest = env.ata(env.admin.publicKey);
      await expectError(
        env.program.methods
          .withdrawTreasury(new BN(t.revenue).add(new BN(1)))
          .accounts({ admin: env.admin.publicKey, config: env.pda.platform(), treasury: env.pda.treasury(), treasuryVault: env.pda.treasuryVault(), destination: dest })
          .rpc(),
        "BountyReserveProtected",
      );
      const revenue = Number(t.revenue) / USD;
      expect(revenue).to.be.greaterThan(0); // reap swept the uncollected 5% performance fee here
      const before = await env.usdcBalance(env.admin.publicKey);
      await env.program.methods
        .withdrawTreasury(new BN(t.revenue))
        .accounts({ admin: env.admin.publicKey, config: env.pda.platform(), treasury: env.pda.treasury(), treasuryVault: env.pda.treasuryVault(), destination: dest })
        .rpc();
      expect((await env.usdcBalance(env.admin.publicKey)) - before).to.be.closeTo(revenue, 0.001);
    });
  });

  describe("CommonPool funding queue (Vault Ledger section 1–section 3)", () => {
    let investorC: Keypair;
    let instantA: Keypair;
    let instantB: Keypair;
    let instantC: Keypair;
    let poolA: PublicKey;
    let poolB: PublicKey;
    let selfmade: Keypair;

    /** Mirrors `common_nav` on-chain: idle + the CommonPool's slice of each
     *  staked pool at that pool's *investor* NAV. Base units. */
    const commonNav = async (pools: PublicKey[]) => {
      const cp = await env.commonPool();
      let sum = Number(cp.accountedIdle);
      for (const pk of pools) {
        const p = await env.pool(pk);
        const equity =
          Number(p.accountedUsdc) - Number(p.escrowTotal) - Number(p.vestedClaimable) - Number(p.platformFeeOwed);
        const left = Math.min(Math.max(0, equity - Number(p.investorPrincipal)), Number(p.firstLossSeed));
        const stake = await env.investor(pk, env.pda.commonPool());
        sum += ((equity - left) * Number(stake.shares)) / Number(p.totalShares);
      }
      return sum;
    };

    it("admin initializes the CommonPool", async () => {
      investorC = await env.newWallet(5, 20_000);
      instantA = await env.newWallet(5, 2_000);
      instantB = await env.newWallet(5, 2_000);
      instantC = await env.newWallet(5, 2_000);
      const cp = await env.commonPool();
      expect(cp.reserveBps).to.eq(1_000);
      expect(cp.depositEnabled).to.eq(true);
    });

    it("investors deposit into the shared pool at NAV (no stakes yet)", async () => {
      await expectError(env.depositCommon(investorC, 10), "DepositTooSmall");
      await env.depositCommon(investorC, 12_000);
      const cp = await env.commonPool();
      expect(cp.accountedIdle.toString()).to.eq(usd(12_000).toString());
      expect(cp.totalShares.toString()).to.eq(usd(12_000).mul(SHARE_SCALE).toString());
      const pos = await env.commonPosition(investorC.publicKey);
      expect(pos.shares.toString()).to.eq(cp.totalShares.toString());
      expect(pos.costBasis.toString()).to.eq(usd(12_000).toString());
    });

    it("an instant trader pays the flat 1.5× fee at the Tier-1 cap, held for seeding, and is Eligible at tier 0", async () => {
      const before = await env.usdcBalance(instantA.publicKey);
      await env.apply(instantA, 5_000);
      // Flat: instant_cap is pinned to tierCaps[0], and 1.5 × 800 > 20% × 5,000
      // so the floor is what binds. There is no cap to choose any more.
      expect(before - (await env.usdcBalance(instantA.publicKey))).to.eq(1_200);
      const prof = await env.profile(instantA.publicKey);
      expect(prof.status).to.deep.eq({ eligible: {} });
      expect(prof.tier).to.eq(0);
      expect(prof.feePaid.toString()).to.eq(usd(1_200).toString());
    });

    it("queue_for_funding is permissionless, FIFO-numbered, and double-queue-proof", async () => {
      await env.queueForFunding(keeper, instantA.publicKey); // ticket 0, queued by a third party
      try {
        await env.queueForFunding(keeper, instantA.publicKey);
        throw new Error("second queue attempt should have failed");
      } catch (e: any) {
        expect(String(e?.message ?? e)).to.not.include("should have failed"); // ticket PDA already exists
      }
      await env.apply(instantB, 5_000);
      await env.queueForFunding(keeper, instantB.publicKey); // ticket 1
      await env.apply(instantC, 5_000);
      await env.queueForFunding(keeper, instantC.publicKey); // ticket 2
      const cp = await env.commonPool();
      expect(Number(cp.nextTicket)).to.eq(3);
      expect(Number(cp.nextToFund)).to.eq(0);
    });

    it("instant funding is one product: a cap other than the Tier-1 cap is rejected", async () => {
      // The chooser it used to present could not change the price. The fee
      // floor (1.5 × entry fee) binds at every cap Tier 1 allows, so a smaller
      // cap bought less capital for the same money.
      const w = await env.newWallet(5, 2_000);
      await expectError(env.apply(w, 2_500), "InvalidArgument");
      await expectError(env.apply(w, 6_000), "InvalidArgument");
    });

    it("strict FIFO: funding a later ticket first is rejected", async () => {
      await expectError(env.fundNextInQueue(keeper, instantB.publicKey), "TicketOutOfOrder");
    });

    it("a dead head ticket (trader no longer Eligible) can be skipped, but a live one cannot", async () => {
      // instantA is Eligible with no pool → its head ticket is fundable, never skippable.
      await expectError(env.skipDeadTicket(keeper, instantA.publicKey, keeper.publicKey), "InvalidTraderStatus");
    });

    it("funds the head: pool goes straight to Live at exactly the tier cap, the fee carved out of it as no-shares seed", async () => {
      poolA = await env.fundNextInQueue(keeper, instantA.publicKey);
      const p = await env.pool(poolA);
      expect(p.status).to.deep.eq({ live: {} });
      expect(p.tier).to.eq(0);
      expect(p.targetSize.toString()).to.eq(usd(5_000).toString());
      expect(p.accountedUsdc.toString()).to.eq(usd(5_000).toString()); // the cap: 4,353 allocation + 647 fee seed
      // Seeded-pool share basis: 1e9 shares per USDC (DEAD_SHARES per SEED_DEPOSIT).
      expect(p.totalShares.toString()).to.eq(new BN(4_353).mul(new BN(1_000_000_000)).toString());
      // NAV/share starts at exactly 1.0 (1e9-scaled). Pool *equity* is 5,000, but
      // only the 4,353 allocation bought shares: `investor_principal = 4,353`
      // makes the 647 cushion (12.94% of cap, the rest of the $1,200 instant fee
      // being platform revenue + bounty reserve) first loss rather than profit.
      // Pricing this mint at 5,000/4,353 = 1.1486 was the phantom profit. It
      // marked the CommonPool up 14.9% the moment a trader was funded, letting
      // whoever redeemed first walk away with the cushion the liquidation buffer
      // depends on. The cushion still has to fully burn before the stake is
      // worth less than it paid; that now happens through investor NAV.
      expect(p.hwmNps.toString()).to.eq("1000000000");
      expect(p.investorPrincipal.toString()).to.eq(usd(4_353).toString());
      expect(p.firstLossSeed.toString()).to.eq(usd(647).toString());
      const stake = await env.investor(poolA, env.pda.commonPool());
      expect(stake.investor.toBase58()).to.eq(env.pda.commonPool().toBase58());
      expect(stake.shares.toString()).to.eq(p.totalShares.toString());
      const cp = await env.commonPool();
      expect(cp.accountedIdle.toString()).to.eq(usd(7_647).toString()); // 12,000 − 4,353 allocation
      expect(cp.activeStakes).to.eq(1);
      expect(Number(cp.nextToFund)).to.eq(1);
      const prof = await env.profile(instantA.publicKey);
      expect(prof.activePool.toBase58()).to.eq(poolA.toBase58());
      expect(prof.feePaid.toString()).to.eq("0"); // consumed as seed
    });

    it("the queue-funded trader can trade immediately", async () => {
      await env.placeTrade(instantA, poolA, MARKETS.SOL.id, 1, 500);
      expect((await env.pool(poolA)).openPositions).to.eq(1);
      await env.closeTrade(instantA, poolA, MARKETS.SOL.id);
    });

    it("funds ticket 1; ticket 2 is cleanly rejected once idle minus the reserve can't cover it", async () => {
      // The invariant this whole change exists for: funding a trader moves
      // capital from idle into a stake, it does not create value. NAV must not
      // move, so the sitting investors are not marked up by the incoming
      // trader's cushion, which is what let the earliest of them redeem it out
      // from under the pool that had just been funded.
      const navBefore = await commonNav([poolA]);
      poolB = await env.fundNextInQueue(keeper, instantB.publicKey);
      const navAfter = await commonNav([poolA, poolB]);
      expect(Math.abs(navAfter - navBefore)).to.be.lessThan(10_000); // < $0.01, i.e. rounding only
      const cp = await env.commonPool();
      expect(cp.accountedIdle.toString()).to.eq(usd(3_294).toString());
      expect(cp.activeStakes).to.eq(2);
      // 3,294 − 10% reserve = 2,965 < the 4,353 allocation. The caller retries once capital frees up.
      await expectError(env.fundNextInQueue(keeper, instantC.publicKey), "InsufficientIdleReserve");
    });

    it("deposit_common demands exactly one (pool, position) pair per active stake", async () => {
      await expectError(env.depositCommon(investorC, 1_000), "WrongStakeAccounts");
      await expectError(env.depositCommon(investorC, 1_000, [poolA]), "WrongStakeAccounts");
      const before = await env.commonPool();
      await env.depositCommon(investorC, 1_000, [poolA, poolB]);
      const cp = await env.commonPool();
      expect(cp.accountedIdle.toString()).to.eq(usd(4_294).toString());
      // NAV = idle 3,294 + 2 × 4,353 investor value = 12,000 against 12,000
      // USD-shares, so $1,000 mints ~1,000 USD-shares. The two traders' 647
      // cushions are NOT in that NAV: priced at equity this would have minted
      // ~857, handing the sitting investor a 14.9% markup for every trader the
      // pool funded. Slightly under 1,000 here only because poolA paid trading
      // fees. Its own cushion absorbed them, but the book is still short.
      const minted = new BN(cp.totalShares.toString()).sub(new BN(before.totalShares.toString()));
      const navBefore = (await commonNav([poolA, poolB])) - 1_000 * USD;
      const expected = usd(1_000).mul(new BN(before.totalShares.toString())).div(new BN(Math.round(navBefore)));
      expect(minted.sub(expected).abs().lten(1_000)).to.eq(true); // exact but for integer rounding
      expect(minted.lte(usd(1_000).mul(SHARE_SCALE))).to.eq(true);
      expect(minted.gt(usd(995).mul(SHARE_SCALE))).to.eq(true);
    });

    it("deposits can be gated off until redemption ships (the Ledger's testnet flag)", async () => {
      const adminAccounts = { admin: env.admin.publicKey, config: env.pda.platform(), commonPool: env.pda.commonPool() };
      await env.program.methods.updateCommonPoolParams({ reserveBps: 1_000, depositEnabled: false }).accounts(adminAccounts).rpc();
      await expectError(env.depositCommon(investorC, 1_000, [poolA, poolB]), "CommonDepositsDisabled");
      await env.program.methods.updateCommonPoolParams({ reserveBps: 1_000, depositEnabled: true }).accounts(adminAccounts).rpc();
    });

    // ---- Phase B: platform fee, mark-to-market pricing, redemption cascade ----

    it("a winning close accrues the 5% platform fee; collecting it splits to bounty reserve + revenue", async () => {
      await env.setPrice(MARKETS.SOL.id, 150);
      const p0 = await env.pool(poolA);
      await env.placeTrade(instantA, poolA, MARKETS.SOL.id, 1, 500);
      await env.setPrice(MARKETS.SOL.id, 165); // +10%
      await env.closeTrade(instantA, poolA, MARKETS.SOL.id);
      const p1 = await env.pool(poolA);
      const realized = (Number(p1.realizedPnl) - Number(p0.realizedPnl)) / USD;
      expect(realized).to.be.greaterThan(30);
      // 5% of NET NEW profit. `poolA` is carrying spread and fees from the
      // trades above, so part of this win only returns it to flat.
      const cum0 = Number(p0.realizedPnl) / USD;
      const accruable = Math.max(0, cum0 + realized) - Math.max(0, cum0);
      const feeDelta = (Number(p1.platformFeeOwed) - Number(p0.platformFeeOwed)) / USD;
      expect(feeDelta).to.be.closeTo(accruable * 0.05, 0.01);
      // What `collect_platform_fee` will actually take is the whole standing
      // balance, not this trade's delta. The assertions below measure that.
      const owed = Number(p1.platformFeeOwed) / USD;

      const tBefore = await env.treasury();
      await env.collectPlatformFee(keeper, poolA);
      const tAfter = await env.treasury();
      const bountyDelta = (Number(tAfter.bountyReserve) - Number(tBefore.bountyReserve)) / USD;
      const revenueDelta = (Number(tAfter.revenue) - Number(tBefore.revenue)) / USD;
      expect(bountyDelta).to.be.closeTo(owed / 2, 0.01); // the bounty reserve is funded again
      expect(bountyDelta + revenueDelta).to.be.closeTo(owed, 0.01);
      const p2 = await env.pool(poolA);
      expect(p2.platformFeeOwed.toString()).to.eq("0");
      expect(Number(p1.accountedUsdc) - Number(p2.accountedUsdc)).to.be.closeTo(owed * USD, USD * 0.01);
    });

    it("CommonPool NAV is mark-to-market: an open position demands its oracle", async () => {
      await env.setPrice(MARKETS.SOL.id, 150);
      await env.placeTrade(instantA, poolA, MARKETS.SOL.id, 1, 500);
      // Pairs without the SOL oracle → the strict deposit pricing must refuse.
      const cp = env.pda.commonPool();
      const pairs = [poolA, poolB]
        .sort((a, b) => a.toBuffer().compare(b.toBuffer()))
        .flatMap((p) => [
          { pubkey: p, isSigner: false, isWritable: false },
          { pubkey: env.pda.investor(p, cp), isSigner: false, isWritable: false },
        ]);
      await expectError(
        env.program.methods
          .depositCommon(usd(1_000))
          .accounts(env.commonAccounts(investorC.publicKey))
          .remainingAccounts(pairs)
          .signers([investorC])
          .rpc(),
        "OracleMissing",
      );
      // With the oracle supplied (helper gathers it) the marked deposit goes through.
      await env.depositCommon(investorC, 1_000, [poolA, poolB]);
      await env.closeTrade(instantA, poolA, MARKETS.SOL.id);
    });

    it("redeem_common pays immediately while the idle reserve covers it", async () => {
      const pos0 = await env.commonPosition(investorC.publicKey);
      const shares = new BN(pos0.shares.toString()).divn(20); // ~5%
      const before = await env.usdcBalance(investorC.publicKey);
      await env.redeemCommon(investorC, shares, [poolA, poolB]);
      const after = await env.usdcBalance(investorC.publicKey);
      expect(after - before).to.be.greaterThan(500); // ~5% of a ~$14–15k NAV
      const pos1 = await env.commonPosition(investorC.publicKey);
      expect(new BN(pos1.shares.toString()).toString()).to.eq(new BN(pos0.shares.toString()).sub(shares).toString());
      expect(pos1.pendingShares.toString()).to.eq("0");
    });

    it("a large redemption queues and a LIVE pool is never pulled to satisfy it", async () => {
      // The rule: a healthy pool is never redeemed out from under its trader.
      // Pulling from a live pool meant unwind_for_redemption force-closing part
      // of a working book because somebody unrelated wanted out.
      const pos0 = await env.commonPosition(investorC.publicKey);
      const shares = new BN(pos0.shares.toString()).muln(8).divn(10); // 80% of the book
      await env.redeemCommon(investorC, shares, [poolA, poolB]);
      const cp0 = await env.commonPool();
      expect(cp0.pendingRedemptionShares.toString()).to.eq(shares.toString());

      // Idle cannot cover it, and neither live pool can be tapped. Not even
      // with a backlog outstanding, which is what used to authorise the pull.
      await expectError(env.settleCommonRedemption(investorC, [poolA, poolB]), "IdleShortfall");
      await expectError(env.requestCommonPull(keeper, poolA), "PoolNotLocked");
      await expectError(env.requestCommonPull(keeper, poolB), "PoolNotLocked");

      // Both traders keep every position. That is the whole point.
      for (const pk of [poolA, poolB]) {
        const p = await env.pool(pk);
        expect(Object.keys(p.status)[0]).to.eq("live");
        const stake = await env.investor(pk, env.pda.commonPool());
        expect(new BN(stake.shares.toString()).gt(new BN(0))).to.eq(true);
        expect(stake.pendingShares.toString()).to.eq("0");
      }

      // The backlog is served as the pools end. Each trader closes out on their
      // own terms, and only then does that pool's capital come home.
      const idleBefore = Number((await env.commonPool()).accountedIdle);
      for (const [trader, pk] of [[instantA, poolA], [instantB, poolB]] as [Keypair, PublicKey][]) {
        await env.closePool(trader, pk);
        expect(Object.keys((await env.pool(pk)).status)[0]).to.eq("locked");
        await env.requestCommonPull(keeper, pk);
        await env.settleCommonPull(keeper, pk);
        // A locked pool is pulled in FULL. Nothing is stranded in a dead pool.
        expect(await env.investor(pk, env.pda.commonPool())).to.eq(null);
      }
      const cp1 = await env.commonPool();
      expect(Number(cp1.accountedIdle)).to.be.greaterThan(idleBefore);
      expect(cp1.activeStakes).to.eq(0);

      const before = await env.usdcBalance(investorC.publicKey);
      await env.settleCommonRedemption(investorC);
      const after = await env.usdcBalance(investorC.publicKey);
      expect(after - before).to.be.greaterThan(1_000);
      expect((await env.commonPool()).pendingRedemptionShares.toString()).to.eq("0");
    });

    it("both tracks converge: a trial-passer funds through the same queue", async () => {
      // A genuine trial-passer (not instant). The Ledger's Track A into funding.
      const passer = await env.newWallet(5, 1_000);
      await env.makeEligible(passer);
      const prof0 = await env.profile(passer.publicKey);
      expect(prof0.status).to.deep.eq({ eligible: {} });
      expect(prof0.tier).to.eq(1);

      await env.queueForFunding(passer, passer.publicKey); // ticket 3 (behind instantC's unfunded #2)
      // Top up idle so both the still-queued head (instantC #2) and the passer (#3) fit.
      await env.depositCommon(investorC, 12_000); // poolA/poolB were pulled dry above
      // Strict FIFO: the head (instantC) funds first, then the passer.
      await env.fundNextInQueue(keeper, instantC.publicKey);
      const funded = await env.fundNextInQueue(keeper, passer.publicKey);
      const fp = await env.pool(funded);
      expect(fp.status).to.deep.eq({ live: {} });
      expect(fp.tier).to.eq(1);
      expect(fp.targetSize.toString()).to.eq(usd(5_000).toString());
      // Funded to exactly the tier cap: the $800 trial fee is carved out of the
      // 5,000 as no-shares seed, leaving a 4,500 CommonPool allocation.
      expect(fp.accountedUsdc.toString()).to.eq(usd(5_000).toString());
      const prof1 = await env.profile(passer.publicKey);
      expect(prof1.activePool.toBase58()).to.eq(funded.toBase58());
      expect(prof1.feePaid.toString()).to.eq("0");
    });

    it("a head ticket whose trader self-created a pool is skippable, unjamming the queue", async () => {
      // Queue two: a trader who will self-create a pool (dead), then instantC behind them.
      selfmade = await env.newWallet(5, 1_600);
      await env.makeEligible(selfmade);
      await env.queueForFunding(selfmade, selfmade.publicKey);
      const cp0 = await env.commonPool();
      const headTicket = Number(cp0.nextToFund);

      // selfmade leaves the queue's reach by creating their own pool.
      await env.createPool(selfmade, 5_000);
      const prof = await env.profile(selfmade.publicKey);
      expect(prof.activePool.toBase58()).to.not.eq(PublicKey.default.toBase58());

      // The head ticket now blocks the line; anyone may skip it. Rent returns to
      // the ticket's payer (selfmade self-queued), enforced by the address constraint.
      await env.skipDeadTicket(keeper, selfmade.publicKey, selfmade.publicKey);
      const cp1 = await env.commonPool();
      expect(Number(cp1.nextToFund)).to.eq(headTicket + 1);
    });

    it("a forfeited entry fee is swept into the CommonPool as investor profit", async () => {
      // `loser` failed their trial back in the funnel suite. Their $800 has been
      // sitting in treasury custody ever since. Not revenue, not the bounty
      // reserve, and no longer earmarked to seed any pool. It belongs to the
      // investors who were funding traders while that attempt ran, so it lands
      // in idle with NO shares minted against it.
      const prof0 = await env.profile(loser.publicKey);
      expect(prof0.feeForfeited.toString()).to.eq(usd(800).toString());

      const cp0 = await env.commonPool();
      const t0 = await env.treasury();
      const vault0 = await env.tokenBalance(env.pda.commonVault());
      expect(Number(cp0.totalShares)).to.be.greaterThan(0);

      // Permissionless: the keeper does it, not the admin and not the trader.
      await env.sweepForfeitedFee(keeper, loser.publicKey);

      const cp1 = await env.commonPool();
      const t1 = await env.treasury();
      // CommonPool NAV is `accountedIdle + Σ stakes`. The sweep touches no
      // stake, so a rise in idle IS a rise in NAV, and with share count flat,
      // that is a rise in NAV/share: profit for everyone already in.
      expect(Number(cp1.accountedIdle) - Number(cp0.accountedIdle)).to.eq(usd(800).toNumber());
      expect(cp1.totalShares.toString()).to.eq(cp0.totalShares.toString());
      expect(cp1.activeStakes).to.eq(cp0.activeStakes);
      // Accounted, not donated: the vault really holds it, and `common_nav`
      // reads the accounted figure rather than the raw balance.
      expect((await env.tokenBalance(env.pda.commonVault())) - vault0).to.eq(800);
      // Not a penny to the platform.
      expect(t1.revenue.toString()).to.eq(t0.revenue.toString());
      expect(t1.bountyReserve.toString()).to.eq(t0.bountyReserve.toString());

      // Drained, and not payable twice.
      const prof1 = await env.profile(loser.publicKey);
      expect(prof1.feeForfeited.toString()).to.eq("0");
      expect(prof1.feePaid.toString()).to.eq("0");
      await expectError(env.sweepForfeitedFee(keeper, loser.publicKey), "FeeNotForfeited");
    });

    it("a live attempt's fee is never swept", async () => {
      // Still in trial: that $800 is earmarked to become this trader's own
      // first-loss seed, so it is not the investors' to take yet.
      const live = await env.newWallet(5, 1_000);
      await env.apply(live);
      const prof = await env.profile(live.publicKey);
      expect(prof.feePaid.toString()).to.eq(usd(800).toString());
      expect(prof.feeForfeited.toString()).to.eq("0");
      await expectError(env.sweepForfeitedFee(keeper, live.publicKey), "FeeNotForfeited");
    });

    it("reap_pool splits a dead pool's remainder between the common pool and the platform", async () => {
      // The other side of the fallback in the risk-lock suite: here the
      // CommonPool has shares outstanding, so the remainder is real value for
      // real investors and REAP_PLATFORM_BPS of it is the platform's cut for
      // carrying the liquidation. selfmade's pool never activated, so what is
      // left is just its $1 seed deposit.
      const dead = env.pda.pool(selfmade.publicKey, 0);
      await env.closePool(selfmade, dead);
      const cpBefore = await env.commonPool();
      const tBefore = await env.treasury();
      expect(new BN(cpBefore.totalShares.toString()).gtn(0)).to.eq(true);
      const vaultUsd = await env.tokenBalance(env.pda.poolVault(dead));
      expect(vaultUsd).to.be.greaterThan(0);

      await env.reapPool(keeper, dead);

      const cpAfter = await env.commonPool();
      const tAfter = await env.treasury();
      const total = new BN(Math.round(vaultUsd * USD));
      const platform = total.muln(REAP_PLATFORM_BPS).divn(10_000);
      const investors = total.sub(platform);

      // Investors' half raises idle against unchanged shares, so it lifts
      // NAV/share rather than paying anyone in particular.
      const delta = new BN(cpAfter.accountedIdle.toString()).sub(new BN(cpBefore.accountedIdle.toString()));
      expect(delta.toString()).to.eq(investors.toString());
      expect(cpAfter.totalShares.toString()).to.eq(cpBefore.totalShares.toString());

      // The platform's half is withdrawable revenue, not bounty reserve, and it
      // is not counted as dust. Dust is only the no-investor fallback.
      const revenue = new BN(tAfter.revenue.toString()).sub(new BN(tBefore.revenue.toString()));
      expect(revenue.toString()).to.eq(platform.toString());
      expect(tAfter.dustSwept.toString()).to.eq(tBefore.dustSwept.toString());
      expect(tAfter.bountyReserve.toString()).to.eq(tBefore.bountyReserve.toString());

      // Nothing stranded: the two halves sum to exactly what the vault held.
      expect(delta.add(revenue).toString()).to.eq(total.toString());
      expect(await (env.program.account as any).pool.fetchNullable(dead)).to.eq(null);
    });
  });
});
