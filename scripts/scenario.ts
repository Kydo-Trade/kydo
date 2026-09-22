/**
 * Runnable trace: a $5,000 pool that breaches its daily loss limit.
 *
 * Not a test - it asserts almost nothing. It walks the real instructions on a
 * local validator and prints the ledger after each one, so the money can be
 * followed rather than described.
 *
 * It lives in scripts/ rather than tests/ because Anchor.toml globs every .ts
 * under tests/, and a second describe() that re-initialises the platform would
 * break the suite.
 *
 * Run it: see docs/scenario.md
 */
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Env, MARKETS, usd, USD } from "../tests/helpers";

const money = (n: number) => `$${n.toFixed(2).padStart(10)}`;

/** Mirrors `common_nav` on-chain: idle + the CommonPool's slice of each staked
 *  pool, valued at that pool's INVESTOR nav (equity minus the intact cushion). */
async function commonNav(env: Env, pools: PublicKey[]) {
  const cp: any = await env.commonPool();
  let nav = Number(cp.accountedIdle) / USD;
  for (const pk of pools) {
    const p: any = await env.pool(pk);
    if (Number(p.totalShares) === 0) continue;
    const equity =
      (Number(p.accountedUsdc) - Number(p.escrowTotal) - Number(p.vestedClaimable) - Number(p.platformFeeOwed)) / USD;
    const left = Math.min(Math.max(0, equity - Number(p.investorPrincipal) / USD), Number(p.firstLossSeed) / USD);
    const stake: any = await env.investor(pk, env.pda.commonPool());
    if (stake) nav += ((equity - left) * Number(stake.shares)) / Number(p.totalShares);
  }
  const shares = Number(cp.totalShares) / 1e18;
  return { nav, shares, idle: Number(cp.accountedIdle) / USD, nps: shares ? nav / shares : 0 };
}
const line = (s = "") => console.log(s);
const rule = (t: string) => { line(); line(`── ${t} ${"─".repeat(Math.max(0, 66 - t.length))}`); };

describe("scenario", () => {
  const env = new Env();
  let trader: Keypair, investor: Keypair, keeper: Keypair, pool: PublicKey;

  it("a $5,000 pool breaches the daily loss limit and settles", async () => {
    await env.createUsdc();
    // 1-second days so the 30-day trial completes; lengthened to real days in
    // step 3, before any position is opened, so roll_day cannot reset
    // day_start_nav out from under the 4% floor.
    await env.initPlatform({ daySecs: 1, graceDays: 400, minHold: 0, lockup: 0 });
    await env.registerMarkets();
    await env.initCommonPool(1_000, true);
    trader = await env.newWallet(5, 3_000);
    investor = await env.newWallet(5, 20_000);
    keeper = await env.newWallet(5, 1);

    await env.setMinFirstLoss(1571); // match the deployed config, not the harness default
    const cfg = await env.config();
    const CAP = Number(cfg.tierCaps[0]) / USD;
    const FEE = Number(cfg.entryFee) / USD;
    const MFL = cfg.minFirstLossBps;
    const cushion = (CAP * MFL) / 10_000;

    rule("SETUP");
    line(`  Tier-1 cap              ${money(CAP)}`);
    line(`  entry fee (trial)       ${money(FEE)}`);
    line(`  minFirstLossBps         ${MFL}  ->  required cushion ${money(cushion)}`);
    line(`  daily loss limit        ${cfg.risk.dailyLossBps / 100}%   drawdown ${cfg.risk.maxDrawdownBps / 100}%`);

    // ---------------------------------------------------------------- 1
    rule("STEP 1. Trader applies (trial path, $800)");
    const tBefore = await env.usdcBalance(trader.publicKey);
    await env.apply(trader);
    const tAfter = await env.usdcBalance(trader.publicKey);
    let prof = await env.profile(trader.publicKey);
    let treas = await env.treasury();
    line(`  trader wallet           ${money(tBefore)} -> ${money(tAfter)}   (paid ${money(tBefore - tAfter)})`);
    line(`  profile.fee_paid        ${money(Number(prof.feePaid) / USD)}   <- CUSTODY, not revenue`);
    line(`  treasury.revenue        ${money(Number(treas.revenue) / USD)}`);
    line(`  treasury.bountyReserve  ${money(Number(treas.bountyReserve) / USD)}`);
    line(`  trader status           ${Object.keys(prof.status)[0]}`);

    // ---------------------------------------------------------------- 2
    rule("STEP 2. Trader passes the 30-day trial");
    // makeEligible() applies internally; the trader has already applied above,
    // so run only the trial half of it.
    await env.passTrialOnly(trader);
    prof = await env.profile(trader.publicKey);
    line(`  trader status           ${Object.keys(prof.status)[0]}  tier ${prof.tier}   (tier 1 => 4% daily / 10% drawdown)`);
    line(`  fee still held          ${money(Number(prof.feePaid) / USD)}   nothing has moved`);

    // ---------------------------------------------------------------- 3
    rule("STEP 3. Switch to real-length days, then an investor deposits");
    await env.setDaySecs(86_400);
    line(`  trial.daySecs           1 -> 86400   (the 4% floor now measures a real day)`);
    const iBefore = await env.usdcBalance(investor.publicKey);
    await env.depositCommon(investor, 10_000);
    let cp: any = await env.commonPool();
    line(`  investor wallet         ${money(iBefore)} -> ${money(await env.usdcBalance(investor.publicKey))}`);
    line(`  commonPool.idle         ${money(Number(cp.accountedIdle) / USD)}`);
    line(`  shares outstanding      ${(Number(cp.totalShares) / 1e18).toFixed(2)} "dollars" of claim`);

    // ---------------------------------------------------------------- 4
    rule("STEP 4. The queue funds the pool");
    await env.queueForFunding(trader, trader.publicKey);
    pool = await env.fundNextInQueue(keeper, trader.publicKey);
    let p: any = await env.pool(pool);
    cp = await env.commonPool();
    treas = await env.treasury();
    prof = await env.profile(trader.publicKey);
    const seed = Number(p.firstLossSeed) / USD;
    const principal = Number(p.investorPrincipal) / USD;
    line(`  pool vault (equity)     ${money(Number(p.accountedUsdc) / USD)}   = the cap exactly`);
    line(`    first_loss_seed       ${money(seed)}   trader's, mints NO shares`);
    line(`    investor_principal    ${money(principal)}   CommonPool's, holds every share`);
    line(`  platform surplus kept   ${money(Number(treas.revenue) / USD + Number(treas.bountyReserve) / USD)}   (${money(FEE - seed)} of the fee)`);
    line(`  commonPool.idle         ${money(Number(cp.accountedIdle) / USD)}   (10,000 - ${principal.toFixed(2)})`);
    line(`  profile.fee_paid        ${money(Number(prof.feePaid) / USD)}   fully consumed`);
    line(`  NAV/share               ${(Number(p.hwmNps) / 1e9).toFixed(6)}   <- exactly 1.0, no phantom profit`);

    // ---------------------------------------------------------------- 5
    rule("STEP 5. The trader opens a position");
    await env.setPrice(MARKETS.SOL.id, 150);
    await env.placeTrade(trader, pool, MARKETS.SOL.id, 1, 2_000); // long $2,000
    p = await env.pool(pool);
    const dayStart = Number(p.dayStartNav) / USD;
    line(`  long SOL                ${money(2_000)} notional @ $150`);
    line(`  day_start_nav           ${money(dayStart)}   <- the 4% floor is measured off this`);
    line(`  daily floor (4%)        ${money(dayStart * 0.96)}`);
    line(`  peak_nav                ${money(Number(p.peakNav) / USD)}   drawdown floor ${money((Number(p.peakNav) / USD) * 0.9)}`);
    line(`  -> the DAILY floor binds first (it is the higher of the two)`);

    // ---------------------------------------------------------------- 6
    rule("STEP 6. SOL falls; the pool crosses the daily floor");
    await env.setPrice(MARKETS.SOL.id, 133.5); // -11% on a $2,000 long
    p = await env.pool(pool);
    line(`  SOL $150 -> $133.50     (-11% on a ${money(2_000)} long = about -${money(220)})`);
    line(`  last marked equity      ${money(Number(p.lastMarkNav) / USD)}`);
    line(`  status before keeper    ${Object.keys(p.status)[0]}`);

    // ---------------------------------------------------------------- 7
    rule("STEP 7. The keeper evaluates and locks");
    const kBefore = await env.usdcBalance(keeper.publicKey);
    await env.evaluateRisk(keeper, pool);
    p = await env.pool(pool);
    const kAfterLock = await env.usdcBalance(keeper.publicKey);
    line(`  status                  ${Object.keys(p.status)[0]}   lockReason ${p.lockReason}  (1 = daily loss)`);
    line(`  equity at lock          ${money(Number(p.lastMarkNav) / USD)}`);
    line(`  escrow cleared          ${money(Number(p.escrowTotal) / USD)}  vested ${money(Number(p.vestedClaimable) / USD)}`);
    line(`  lock bounty to keeper   ${money(kAfterLock - kBefore)}   charged to the seed`);
    line(`  first_loss_seed         ${money(seed)} -> ${money(Number(p.firstLossSeed) / USD)}`);
    prof = await env.profile(trader.publicKey);
    line(`  trader profile          ${Object.keys(prof.status)[0]}  tier ${prof.tier}  poolsLocked ${prof.poolsLocked}`);

    // ---------------------------------------------------------------- 8
    rule("STEP 8. Unwind: every position closed at market");
    await env.unwindAll(keeper, pool);
    p = await env.pool(pool);
    const kAfterUnwind = await env.usdcBalance(keeper.publicKey);
    line(`  open positions          ${p.openPositions}`);
    line(`  unwind bounty           ${money(kAfterUnwind - kAfterLock)}   also from the seed`);
    line(`  first_loss_seed left    ${money(Number(p.firstLossSeed) / USD)}`);
    line(`  pool equity             ${money(Number(p.accountedUsdc) / USD)}`);
    line(`  realized pnl            ${money(Number(p.realizedPnl) / USD)}`);
    line(`  platform_fee_owed       ${money(Number(p.platformFeeOwed) / USD)}`);

    // ---------------------------------------------------------------- 9
    rule("STEP 9. Who owns what now");
    p = await env.pool(pool);
    const equity = Number(p.accountedUsdc) / USD - Number(p.escrowTotal) / USD - Number(p.vestedClaimable) / USD - Number(p.platformFeeOwed) / USD;
    const seedLeft = Math.min(Math.max(0, equity - Number(p.investorPrincipal) / USD), Number(p.firstLossSeed) / USD);
    const invNav = equity - seedLeft;
    line(`  pool equity             ${money(equity)}`);
    line(`    cushion still left    ${money(seedLeft)}   trader's, absorbs loss first`);
    line(`    investor NAV          ${money(invNav)}   what the CommonPool can redeem`);
    line(`  investor principal was  ${money(principal)}`);
    line(`  investors are ${invNav >= principal ? "WHOLE" : "down " + money(principal - invNav)}`);

    // ---------------------------------------------------------------- 10
    rule("STEP 10. The CommonPool's capital comes home (permissionless)");
    let cn = await commonNav(env, [pool]);
    line(`  BEFORE   idle ${money(cn.idle)}  + stake ${money(cn.nav - cn.idle)}  = NAV ${money(cn.nav)}   NAV/share ${cn.nps.toFixed(6)}`);

    // The pool is Locked, so the pull needs no redemption backlog. Anyone can
    // bring the capital home. No investor action required.
    await env.requestCommonPull(keeper, pool);
    await env.settleCommonPull(keeper, pool);

    cn = await commonNav(env, [pool]);
    p = await env.pool(pool);
    line(`  pull settled -> idle ${money(cn.idle)}   pool shares left ${Number(p.totalShares) / 1e12}`);
    line(`  AFTER    idle ${money(cn.idle)}  + stake ${money(cn.nav - cn.idle)}  = NAV ${money(cn.nav)}   NAV/share ${cn.nps.toFixed(6)}`);
    line(`  -> the transfer itself does NOT move NAV: value just relocates from stake to idle`);

    // ---------------------------------------------------------------- 11
    rule("STEP 11. Reap: the unspent cushion follows it");
    p = await env.pool(pool);
    const leftover = Number(p.accountedUsdc) / USD;
    const navBefore = (await commonNav(env, [pool])).nav;
    const npsBefore = (await commonNav(env, [pool])).nps;
    line(`  pool vault still holds  ${money(leftover)}   (the cushion the loss never reached)`);
    await env.reapPool(keeper, pool);
    cn = await commonNav(env, []);
    line(`  reaped -> commonPool.idle ${money(cn.idle)}`);
    line(`  CommonPool NAV          ${money(navBefore)} -> ${money(cn.nav)}   (+${money(cn.nav - navBefore)})`);
    line(`  CommonPool NAV/share    ${npsBefore.toFixed(6)} -> ${cn.nps.toFixed(6)}`);
    line(`  -> THIS is new value: no shares minted against it, so NAV/share RISES`);

    // ---------------------------------------------------------------- 12
    rule("STEP 12. The investor redeems, and is paid");
    const iPre = await env.usdcBalance(investor.publicKey);
    const pos: any = await env.commonPosition(investor.publicKey);
    await env.redeemCommon(investor, new BN(pos.shares.toString()), []);
    // Idle covers it, so redeem_common pays immediately and closes the position;
    // only a shortfall would leave something to settle.
    if (await env.commonPosition(investor.publicKey)) await env.settleCommonRedemption(investor, []);
    const iPost = await env.usdcBalance(investor.publicKey);
    line(`  investor wallet         ${money(iPre)} -> ${money(iPost)}   (+${money(iPost - iPre)})`);
    line(`  deposited originally    ${money(10_000)}`);
    line(`  net                     ${iPost - iPre >= 10_000 ? "+" : ""}${money(iPost - iPre - 10_000)}`);

    rule("NET SETTLEMENT");
    const traderOut = tBefore - (await env.usdcBalance(trader.publicKey));
    line(`  trader     paid ${money(traderOut)}, keeps ${money(0)}. Fee spent on the loss and the bounties`);
    line(`  keeper     earned ${money(kAfterUnwind - kBefore)} for lock + unwind, plus ${money(5)} for funding = ${money(kAfterUnwind - kBefore + 5)}`);
    const tr: any = await env.treasury();
    line(`  platform   ${money(FEE - seed)} fee surplus, less the ${money(5)} funding bounty = ${money(Number(tr.revenue) / USD + Number(tr.bountyReserve) / USD)} held`);
    line(`  investors  ${money(invNav)} of ${money(principal)} principal`);
    line();
  });
});
