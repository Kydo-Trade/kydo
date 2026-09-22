/**
 * ⚠️ SUPERSEDED. Does not run against the current program.
 *
 * This trace puts three investors into one trader's pool. That is no longer
 * possible: `deposit` is gated to the pool's own trader
 * (`DirectDepositDisabled`), because investors fund the CommonPool and the
 * program deploys it to traders in FIFO order. Steps 1 and 3 below. Two
 * investors sharing one pool pro-rata, and a late entrant buying in at an
 * elevated NAV/share. Happen at the *CommonPool* level now, not per pool.
 *
 * The questions it asks are still the right ones. Re-point it at
 * `deposit_common` / `redeem_common` and the CommonPool's share price, with a
 * single trader pool funded by `fund_next_in_queue` underneath, and it becomes
 * a trace of the model that actually ships.
 *
 * Original header follows.
 *
 * Runnable trace: pool NAV and investor share accounting across multiple
 * investors, a profit distribution, and a late entrant.
 *
 * Answers three questions the ledger has to get right:
 *   1. Do two investors depositing different amounts get shares in proportion?
 *   2. When the trader earns a profit, does it reach investors pro-rata.
 *      After the 80/5 carve-out to trader escrow and the platform fee?
 *   3. When a THIRD investor joins a pool that is already up, do they buy in
 *      at the elevated NAV/share rather than diluting the first two?
 *
 * (3) is the one that matters. Minting a late investor shares at the original
 * price would hand them a slice of profit they were not there for, paid for out
 * of the existing investors' value. The trace asserts that does not happen.
 *
 * Like scripts/scenario.ts this lives in scripts/ rather than tests/, because
 * Anchor.toml globs every .ts under tests/ and a second describe() that
 * re-initialises the platform would break the suite.
 *
 * Run it: see docs/scenario.md, substituting this file.
 */
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { strict as assert } from "assert";
import { Env, MARKETS, USD } from "../tests/helpers";

const money = (n: number) => `$${n.toFixed(2).padStart(11)}`;
const line = (s = "") => console.log(s);
const rule = (t: string) => { line(); line(`── ${t} ${"─".repeat(Math.max(0, 68 - t.length))}`); };
/** A pool mints DEAD_SHARES per SEED_DEPOSIT = 1e9 shares per dollar. Print
 *  shares as the dollars of claim they were bought with, so NAV/share is 1.0
 *  at par and the numbers below can be read against the deposits directly. */
const sh = (x: any) => Number(x.toString()) / 1e9;

describe("nav-scenario", () => {
  const env = new Env();
  let trader: Keypair, A: Keypair, B: Keypair, C: Keypair, pool: PublicKey;

  /** Equity, investor NAV and NAV/share exactly as the program computes them. */
  async function nav() {
    const p: any = await env.pool(pool);
    const equity =
      (Number(p.accountedUsdc) - Number(p.escrowTotal) - Number(p.vestedClaimable) - Number(p.platformFeeOwed)) / USD;
    const seedLeft = Math.min(
      Math.max(0, equity - Number(p.investorPrincipal) / USD),
      Number(p.firstLossSeed) / USD,
    );
    const investorNav = equity - seedLeft;
    const shares = sh(p.totalShares);
    return { p, equity, investorNav, shares, nps: shares ? investorNav / shares : 0 };
  }

  /** What one investor's stake is worth right now. */
  async function stake(who: PublicKey) {
    const pos: any = await env.investor(pool, who);
    if (!pos) return { shares: 0, value: 0, basis: 0 };
    const { investorNav, shares } = await nav();
    const s = sh(pos.shares);
    return { shares: s, value: shares ? (investorNav * s) / shares : 0, basis: Number(pos.costBasis) / USD };
  }

  async function table(label: string) {
    const n = await nav();
    line(`  ${label}`);
    line(`    equity ${money(n.equity)}   escrow ${money(Number(n.p.escrowTotal) / USD)}   platformFee ${money(Number(n.p.platformFeeOwed) / USD)}`);
    line(`    investor NAV ${money(n.investorNav)}   shares ${n.shares.toFixed(4)}   NAV/share ${n.nps.toFixed(6)}`);
    for (const [name, w] of [["A", A], ["B", B], ["C", C]] as const) {
      const s = await stake(w.publicKey);
      if (s.shares > 0) line(`      ${name}  shares ${s.shares.toFixed(4).padStart(10)}   value ${money(s.value)}   paid in ${money(s.basis)}`);
    }
    return n;
  }

  it("multiple investors, a profit, and a late entrant who must not dilute", async () => {
    await env.createUsdc();
    await env.initPlatform({ daySecs: 1, graceDays: 400, minHold: 0, lockup: 0 });
    await env.registerMarkets();
    await env.initCommonPool(1_000, true);
    trader = await env.newWallet(5, 3_000);
    A = await env.newWallet(5, 50_000);
    B = await env.newWallet(5, 50_000);
    C = await env.newWallet(5, 50_000);

    rule("SETUP. Trader passes the trial, opens a pool at the Tier-1 cap");
    await env.makeEligible(trader);
    await env.setDaySecs(86_400); // real days, so roll_day can't rebase mid-trace
    const cfg = await env.config();
    const CAP = Number(cfg.tierCaps[0]) / USD;
    const MAX_SINGLE = cfg.risk.maxSingleBps / 10_000;
    line(`  Tier-1 cap ${money(CAP)}   max single position ${(MAX_SINGLE * 100).toFixed(0)}% of NAV`);
    pool = await env.createPool(trader, CAP, "nav");
    let n = await nav();
    line(`  pool created; seed deposit gives ${n.shares.toFixed(4)} dead shares at NAV/share ${n.nps.toFixed(6)}`);

    // ------------------------------------------------------------------ 1
    rule("STEP 1. Investors A and B deposit $500 and $1,500");
    await env.deposit(A, pool, 500);
    await env.deposit(B, pool, 1_500);
    await env.activate(pool, trader.publicKey);
    n = await table("after both deposits");

    const a1 = await stake(A.publicKey), b1 = await stake(B.publicKey);
    assert.ok(Math.abs(b1.shares / a1.shares - 3) < 1e-6, "B deposited 3x A, so B must hold 3x the shares");
    assert.ok(Math.abs(a1.value - 500) < 1, "A's stake must be worth what A paid");
    assert.ok(Math.abs(b1.value - 1_500) < 1, "B's stake must be worth what B paid");
    line(`    ✓ B holds exactly 3x A's shares; both priced at par`);

    // ------------------------------------------------------------------ 2
    rule("STEP 2. The trader earns a profit");
    await env.setPrice(MARKETS.SOL.id, 150);
    const size1 = Math.floor((await nav()).equity * MAX_SINGLE * 0.9); // inside the single-market guard
    line(`  long ${money(size1)} of SOL at $150, closed at $187.50 (+25%)`);
    await env.placeTrade(trader, pool, MARKETS.SOL.id, 1, size1);
    await env.setPrice(MARKETS.SOL.id, 187.5); // +25%
    await env.closeTrade(trader, pool, MARKETS.SOL.id);
    const afterProfit = await table("after the winning trade closes");

    line(`    realized PnL ${money(Number(afterProfit.p.realizedPnl) / USD)}  ->  80% escrow / 5% platform / 15% investors`);
    assert.ok(afterProfit.nps > 1, "a profitable close must raise NAV/share above par");
    const a2 = await stake(A.publicKey), b2 = await stake(B.publicKey);
    assert.ok(a2.value > a1.value && b2.value > b1.value, "both investors must gain");
    const gainRatio = (b2.value - b1.value) / (a2.value - a1.value);
    assert.ok(Math.abs(gainRatio - 3) < 1e-3, `B must gain 3x A's gain, got ${gainRatio}`);
    line(`    ✓ A +${money(a2.value - a1.value)}   B +${money(b2.value - b1.value)}   ratio ${gainRatio.toFixed(6)} (must be 3)`);

    // ------------------------------------------------------------------ 3
    rule("STEP 3. Investor C joins a pool that is ALREADY up");
    const npsBefore = afterProfit.nps;
    const headroom = CAP - afterProfit.equity;
    const CDEP = Math.floor(Math.min(1_000, headroom - 5));
    line(`  tier cap ${money(CAP)} is measured on EQUITY (${money(afterProfit.equity)}, incl. the trader's seed)`);
    line(`  so C has ${money(headroom)} of headroom; depositing ${money(CDEP)}`);
    await env.deposit(C, pool, CDEP);
    const afterC = await table(`after C's $${CDEP}`);

    const a3 = await stake(A.publicKey), b3 = await stake(B.publicKey), c3 = await stake(C.publicKey);
    line();
    line(`    NAV/share before C ${npsBefore.toFixed(6)}   after C ${afterC.nps.toFixed(6)}`);
    line(`    C paid ${money(CDEP)} and received ${c3.shares.toFixed(4)} shares`);
    line(`    at par that would have been ${CDEP}.0000 shares. C got ${(CDEP - c3.shares).toFixed(4)} fewer`);

    assert.ok(c3.shares < CDEP, "C must receive FEWER shares than dollars, because NAV/share > 1");
    assert.ok(Math.abs(c3.shares - CDEP / npsBefore) < 1e-2, "C's shares must be deposit / NAV-per-share");
    assert.ok(Math.abs(afterC.nps - npsBefore) < 1e-6, "C's entry must not move NAV/share");
    assert.ok(Math.abs(a3.value - a2.value) < 0.01, "A's value must be untouched by C joining");
    assert.ok(Math.abs(b3.value - b2.value) < 0.01, "B's value must be untouched by C joining");
    assert.ok(Math.abs(c3.value - CDEP) < 1, "C's stake must be worth exactly what C paid");
    assert.ok(a3.shares === a1.shares && b3.shares === b1.shares, "no shares minted to or taken from A or B");
    line(`    ✓ NAV/share unchanged; A and B's value unchanged; C priced at par to themselves`);

    // ------------------------------------------------------------------ 4
    rule("STEP 4. A second profit, now split three ways");
    await env.setPrice(MARKETS.SOL.id, 187.5);
    const size2 = Math.floor((await nav()).equity * MAX_SINGLE * 0.9);
    line(`  long ${money(size2)} of SOL at $187.50, closed at $206.25 (+10%)`);
    await env.placeTrade(trader, pool, MARKETS.SOL.id, 1, size2);
    await env.setPrice(MARKETS.SOL.id, 206.25); // +10%
    await env.closeTrade(trader, pool, MARKETS.SOL.id);
    await table("after the second winning trade");

    const a4 = await stake(A.publicKey), b4 = await stake(B.publicKey), c4 = await stake(C.publicKey);
    const gA = a4.value - a3.value, gB = b4.value - b3.value, gC = c4.value - c3.value;
    line(`    gains  A ${money(gA)}   B ${money(gB)}   C ${money(gC)}`);
    // Each investor's share of the second profit must match their share of the book.
    const total = a4.shares + b4.shares + c4.shares;
    for (const [name, g, s] of [["A", gA, a4.shares], ["B", gB, b4.shares], ["C", gC, c4.shares]] as const) {
      const expected = ((gA + gB + gC) * s) / total;
      assert.ok(Math.abs(g - expected) < 0.02, `${name} gain ${g} != share-weighted ${expected}`);
    }
    line(`    ✓ this profit split by share count, C now included`);

    // ------------------------------------------------------------------ 5
    rule("STEP 5. Everyone redeems; check nothing leaked");
    const before = { A: await env.usdcBalance(A.publicKey), B: await env.usdcBalance(B.publicKey), C: await env.usdcBalance(C.publicKey) };
    const owed = { A: a4.value, B: b4.value, C: c4.value };
    for (const [name, w] of [["A", A], ["B", B], ["C", C]] as const) {
      const pos: any = await env.investor(pool, w.publicKey);
      await env.requestRedemption(w, pool, pos.shares);
      const still: any = await env.investor(pool, w.publicKey);
      if (still && !new BN(still.pendingShares).isZero()) await env.settleRedemption(w, pool);
    }
    let leaked = 0;
    for (const [name, w] of [["A", A], ["B", B], ["C", C]] as const) {
      const got = (await env.usdcBalance(w.publicKey)) - (before as any)[name];
      const want = (owed as any)[name];
      leaked += want - got;
      line(`    ${name} redeemed ${money(got)}   owed ${money(want)}   diff ${money(got - want)}`);
      assert.ok(Math.abs(got - want) < 1, `${name} paid ${got}, owed ${want}`);
    }
    const end = await nav();
    line();
    line(`    total unpaid across all three ${money(leaked)}  (rounding only, must favour the pool)`);
    line(`    pool left with shares ${end.shares.toFixed(4)}   investor NAV ${money(end.investorNav)}`);
    assert.ok(leaked >= -0.01, "rounding must never over-pay investors");
    line(`    ✓ every investor paid their share value; rounding favours the pool`);
    rule("DONE. NAV and share accounting verified");
  });
});
