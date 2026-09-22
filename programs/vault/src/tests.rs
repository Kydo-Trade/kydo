//! Property-style unit tests for the pure maths (section 5.1–section 5.3). Run with
//! `cargo test -p vault` (host build; no validator needed).
#![cfg(test)]

use crate::constants::*;
use crate::math::*;
use crate::risk;
use crate::state::*;

fn pool_with(accounted: u64) -> Pool {
    let mut p = Pool {
        trader: Default::default(),
        profile: Default::default(),
        index: 0,
        mandate: Mandate::Perps,
        status: PoolStatus::Live,
        lock_reason: 0,
        venue: Venue::MockPerps,
        vault: Default::default(),
        venue_account: Default::default(),
        name: [0; 32],
        strategy_hash: [0; 32],
        target_size: 0,
        tier: 1,
        tier_start_ts: 0,
        tier_start_nps: 0,
        live_days_at_tier: 0,
        last_live_day: 0,
        accounted_usdc: accounted,
        total_shares: DEAD_SHARES,
        hwm_nps: 0,
        peak_nav: accounted,
        day_start_nav: accounted,
        day_epoch: 0,
        realized_pnl: 0,
        venue_fees_paid: 0,
        escrow: [EscrowBucket::default(); ESCROW_SLOTS],
        escrow_total: 0,
        vested_claimable: 0,
        positions: [Position::default(); MAX_POSITIONS],
        open_positions: 0,
        trades_today: 0,
        total_trades: 0,
        pending_redemption_shares: 0,
        created_at: 0,
        activated_at: 0,
        locked_at: 0,
        last_mark_ts: 0,
        last_mark_nav: 0,
        bump: 0,
        vault_bump: 0,
        ends_at: 0,
        platform_fee_owed: 0,
        stops: [StopOrder::default(); MAX_POSITIONS],
        venue_accounted_quote: 0,
        first_loss_seed: 0,
        investor_principal: 0,
    };
    p.total_shares = shares_for_deposit(accounted, 0, 0).unwrap();
    p
}

fn px(price: u64) -> crate::oracle::OraclePrice {
    crate::oracle::OraclePrice { price, conf: 0, slot: 0, publish_time: 0 }
}

/// Open `positions` on the pool and build the `Marks` the guard would see.
fn with_positions(p: &mut Pool, specs: &[(u16, u8, u64, u64, u64)]) -> risk::Marks {
    let mut prices = Vec::new();
    let mut gross = 0u64;
    for (i, &(market_id, side_, qty, entry, mark)) in specs.iter().enumerate() {
        p.positions[i] = Position { market_id, side: side_, cluster: 1, base_qty: qty, entry_price: entry, opened_at: 0 };
        prices.push((market_id, px(mark)));
        gross += notional(qty, mark).unwrap();
    }
    p.recount_positions();
    risk::Marks { prices, unrealized: 0, gross_notional: gross }
}

/// A tiny deterministic PRNG so the property tests are reproducible without deps.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 11
    }
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }
}

#[test]
fn shares_round_down_and_never_favour_the_depositor() {
    let mut rng = Lcg(7);
    for _ in 0..20_000 {
        let nav = rng.range(1_000_000, 50_000_000_000); // $1 .. $50k
        let shares = rng.range(1_000_000_000, 60_000_000_000_000) as u128;
        let dep = rng.range(1, 5_000_000_000);
        let minted = shares_for_deposit(dep, shares, nav).unwrap();
        // value of minted shares at post-deposit NAV must not exceed the deposit
        let value = value_for_shares(minted, shares + minted, nav + dep).unwrap();
        assert!(value <= dep, "depositor extracted value: dep {dep} value {value}");
        // and rounding loss is bounded by one share's worth
        let one_share = (nav as u128 / shares.max(1)) as u64 + 1;
        assert!(dep - value <= one_share.max(1) + 1, "rounding loss too large: {}", dep - value);
    }
}

#[test]
fn dead_shares_block_first_depositor_inflation() {
    // Attacker seeds 1 USDC (dead shares), then donates 1,000 USDC directly (not accounted. NAV ignores it).
    // A victim depositing 100 USDC must get a fair share of *accounted* NAV.
    let p = pool_with(SEED_DEPOSIT);
    let victim = 100_000_000u64;
    let minted = shares_for_deposit(victim, p.total_shares, p.accounted_usdc).unwrap();
    let value = value_for_shares(minted, p.total_shares + minted, p.accounted_usdc + victim).unwrap();
    assert!(victim - value <= 1, "victim lost {} to inflation", victim - value);
}

#[test]
fn nav_per_share_is_invariant_under_deposits() {
    let mut rng = Lcg(11);
    for _ in 0..5_000 {
        let nav = rng.range(1_000_000, 30_000_000_000);
        let shares = rng.range(1_000_000_000, 30_000_000_000_000) as u128;
        let dep = rng.range(50_000_000, 5_000_000_000);
        let before = nav_per_share(nav, shares).unwrap();
        let minted = shares_for_deposit(dep, shares, nav).unwrap();
        let after = nav_per_share(nav + dep, shares + minted).unwrap();
        // nps may only rise by rounding (the pool keeps dust), never fall
        assert!(after >= before, "nps fell {before} -> {after}");
        assert!(after - before <= before / 1_000 + 1, "nps jumped {before} -> {after}");
    }
}

#[test]
fn clawback_drains_nearest_unlock_first_and_never_goes_negative() {
    let mut p = pool_with(10_000_000_000);
    // Three profitable days at different vesting horizons
    risk::apply_profit_split(&mut p, 1_000_000_000, 100, 14).unwrap(); // +1000 → 800 escrow, unlock 114
    risk::apply_profit_split(&mut p, 500_000_000, 101, 30).unwrap(); // +500 → 400, unlock 131
    risk::apply_profit_split(&mut p, 250_000_000, 102, 3).unwrap(); // +250 → 200, unlock 105 (nearest)
    assert_eq!(p.escrow_total, 1_400_000_000);
    // A 300 loss claws back 240: all of the unlock-105 bucket (200) then 40 from unlock-114
    risk::apply_profit_split(&mut p, -300_000_000, 102, 14).unwrap();
    assert_eq!(p.escrow_total, 1_160_000_000);
    let b105 = p.escrow.iter().find(|b| b.unlock_day == 105).map(|b| b.amount).unwrap_or(0);
    let b114 = p.escrow.iter().find(|b| b.unlock_day == 114).map(|b| b.amount).unwrap();
    assert_eq!(b105, 0);
    assert_eq!(b114, 760_000_000);
    // A catastrophic loss cannot take more than what is escrowed
    risk::apply_profit_split(&mut p, -100_000_000_000, 102, 14).unwrap();
    assert_eq!(p.escrow_total, 0);
    assert!(p.escrow.iter().all(|b| b.amount == 0));
}

#[test]
fn a_losing_round_trip_earns_the_trader_nothing() {
    let mut p = pool_with(10_000_000_000);
    // +1000 then -1000 inside one vesting window: cumulative realized is back
    // to zero, so the trader is owed nothing and the platform fee unwinds too.
    risk::apply_profit_split(&mut p, 1_000_000_000, 100, 14).unwrap();
    assert_eq!(p.escrow_total, 800_000_000);
    assert_eq!(p.platform_fee_owed, 50_000_000);
    risk::apply_profit_split(&mut p, -1_000_000_000, 100, 14).unwrap();
    assert_eq!(p.escrow_total, 0, "the clawback exactly reverses the accrual");
    assert_eq!(p.platform_fee_owed, 0);
    assert_eq!(p.realized_pnl, 0);
}

#[test]
fn profit_that_only_reduces_a_loss_accrues_nothing() {
    let mut p = pool_with(10_000_000_000);
    // 5000 down, then a 1000 winner. Still 4000 down: nothing is earned, and
    // splitting per winning trade would have paid 800 on it.
    risk::apply_profit_split(&mut p, -5_000_000_000, 100, 14).unwrap();
    assert_eq!(p.escrow_total, 0);
    risk::apply_profit_split(&mut p, 1_000_000_000, 101, 14).unwrap();
    assert_eq!(p.escrow_total, 0, "still under water. No net new profit");
    assert_eq!(p.platform_fee_owed, 0);
    assert_eq!(p.realized_pnl, -4_000_000_000);
}

#[test]
fn only_the_part_that_clears_the_previous_high_accrues() {
    let mut p = pool_with(10_000_000_000);
    risk::apply_profit_split(&mut p, -1_000_000_000, 100, 14).unwrap();
    // +1500 takes cumulative realized from -1000 to +500. Only the 500 above
    // water is split, not the whole 1500.
    risk::apply_profit_split(&mut p, 1_500_000_000, 101, 14).unwrap();
    assert_eq!(p.escrow_total, 400_000_000);
    assert_eq!(p.platform_fee_owed, 25_000_000);
    assert_eq!(p.realized_pnl, 500_000_000);
}

#[test]
fn a_loss_below_water_does_not_drain_escrow_twice() {
    let mut p = pool_with(10_000_000_000);
    risk::apply_profit_split(&mut p, 1_000_000_000, 100, 14).unwrap();
    // -1500 takes cumulative from +1000 to -500. The clawback reverses the
    // 1000 that was accrued and stops there; the 500 below water was never
    // the trader's to give back.
    risk::apply_profit_split(&mut p, -1_500_000_000, 100, 14).unwrap();
    assert_eq!(p.escrow_total, 0);
    // A further loss finds nothing left to take and must not go negative.
    risk::apply_profit_split(&mut p, -1_000_000_000, 100, 14).unwrap();
    assert_eq!(p.escrow_total, 0);
    assert_eq!(p.realized_pnl, -1_500_000_000);
}

#[test]
fn a_later_depositor_can_never_be_rounded_to_zero_shares() {
    // The CommonPool has no dead shares: `init_common_pool` leaves total_shares
    // at 0, and the first deposit mints `amount * SHARE_SCALE`. What blocks the
    // classic first-depositor inflation attack here is the share SCALE, not a
    // dead share, and that is an accidental property of two numbers unless
    // something asserts it, which is what this does.
    //
    // Worst case an attacker can construct: be first in at the minimum deposit,
    // then inflate NAV as far as the type allows.
    let min_deposit: u64 = 50_000_000; // config/platform.jsonc: minDepositUsd 50
    let attacker = shares_for_deposit(min_deposit, 0, 0).unwrap();
    let victim = shares_for_deposit(min_deposit, attacker, u64::MAX).unwrap();
    assert!(
        victim > 0,
        "a minimum deposit must mint shares even against a NAV inflated to u64::MAX; \
         if this fails, SHARE_SCALE was lowered or min_deposit raised past the margin"
    );
    // The same at one base unit of NAV inflation per unit deposited, i.e. the
    // ordinary case, must not be degenerate either.
    assert!(shares_for_deposit(min_deposit, attacker, min_deposit).unwrap() >= attacker);
}

#[test]
fn vesting_moves_only_matured_buckets() {
    let mut p = pool_with(10_000_000_000);
    risk::apply_profit_split(&mut p, 1_000_000_000, 100, 14).unwrap();
    risk::apply_profit_split(&mut p, 1_000_000_000, 101, 30).unwrap();
    assert_eq!(risk::vest(&mut p, 113), 0);
    assert_eq!(risk::vest(&mut p, 114), 800_000_000);
    assert_eq!(p.vested_claimable, 800_000_000);
    assert_eq!(p.escrow_total, 800_000_000);
    assert_eq!(risk::vest(&mut p, 131), 800_000_000);
    assert_eq!(p.escrow_total, 0);
}

#[test]
fn ring_buffer_slot_reuse_after_thirty_days() {
    let mut p = pool_with(10_000_000_000);
    risk::apply_profit_split(&mut p, 100_000_000, 40, 30).unwrap(); // slot 10, unlock 70
    // 30 days later the same slot is reused: the old bucket must have vested first
    risk::apply_profit_split(&mut p, 100_000_000, 70, 30).unwrap(); // vest(70) clears slot 10, then rewrite
    assert_eq!(p.vested_claimable, 80_000_000);
    assert_eq!(p.escrow_total, 80_000_000);
    let b = p.escrow[70 % ESCROW_SLOTS];
    assert_eq!((b.amount, b.unlock_day), (80_000_000, 100));
}

fn test_config() -> PlatformConfig {
    PlatformConfig {
        admin: Default::default(),
        usdc_mint: Default::default(),
        trial_attestor: Default::default(),
        price_authority: Default::default(),
        entry_fee: 0,
        bounty_per_pool: 0,
        keeper_bounty: 0,
        activation_floor: 0,
        min_deposit: 0,
        tier_caps: [0; 3],
        vest_days: [14, 30, 30],
        risk: RiskParams::mvp_defaults(),
        trial: TrialCriteria::mvp_defaults(),
        paused: false,
        allow_mock_oracle: true,
        bump: 0,
        treasury_bump: 0,
        treasury_vault_bump: 0,
        min_first_loss_bps: 1_294,
    }
}

#[test]
fn breach_detection_matches_spec_thresholds() {
    let mut cfg = test_config();
    let p = pool_with(10_000_000_000);
    assert_eq!(risk::breach(&p, 9_600_000_000, &cfg), lock_reason::NONE); // exactly −4%: not a breach
    assert_eq!(risk::breach(&p, 9_599_999_999, &cfg), lock_reason::DAILY_LOSS);
    cfg.risk.daily_loss_bps = 10_000; // disable daily to isolate drawdown
    assert_eq!(risk::breach(&p, 9_000_000_000, &cfg), lock_reason::NONE);
    assert_eq!(risk::breach(&p, 8_999_999_999, &cfg), lock_reason::DRAWDOWN);

    // Tier 0 (instant funding) breaches at the tighter 3% daily / 8% drawdown
    // floors even though the platform-wide limits are 4% / 10%.
    let mut p0 = p.clone();
    p0.tier = 0;
    assert_eq!(risk::breach(&p0, 9_700_000_000, &cfg), lock_reason::NONE); // exactly −3%
    assert_eq!(risk::breach(&p0, 9_699_999_999, &cfg), lock_reason::DAILY_LOSS);
    p0.day_start_nav = 0; // day floor -> 0: isolate the drawdown floor
    assert_eq!(risk::breach(&p0, 9_200_000_000, &cfg), lock_reason::NONE); // exactly −8%
    assert_eq!(risk::breach(&p0, 9_199_999_999, &cfg), lock_reason::DRAWDOWN);
}

#[test]
fn epoch_day_uses_the_configured_clock() {
    assert_eq!(risk::epoch_day(86_399, 86_400), 0);
    assert_eq!(risk::epoch_day(86_400, 86_400), 1);
    assert_eq!(risk::epoch_day(1_000, 20), 50);
    assert_eq!(risk::epoch_day(1_000, 0), 1_000); // day_secs=0 is treated as 1, never divides by zero
}

#[test]
fn pnl_sign_and_notional_scaling() {
    let long = Position { market_id: 1, side: side::LONG, cluster: 1, base_qty: 2 * QTY_SCALE, entry_price: 100 * PRICE_SCALE, opened_at: 0 };
    let short = Position { side: side::SHORT, ..long };
    assert_eq!(pnl(&long, long.base_qty, 110 * PRICE_SCALE).unwrap(), 20 * PRICE_SCALE as i64);
    assert_eq!(pnl(&short, short.base_qty, 110 * PRICE_SCALE).unwrap(), -(20 * PRICE_SCALE as i64));
    assert_eq!(notional(long.base_qty, 110 * PRICE_SCALE).unwrap(), 220 * PRICE_SCALE);
    // round trip qty ↔ notional never creates value
    let q = qty_for_notional(1_000 * PRICE_SCALE, 96_337_812).unwrap();
    assert!(notional(q, 96_337_812).unwrap() <= 1_000 * PRICE_SCALE);
}

#[test]
fn stops_never_outlive_their_position() {
    let mut p = pool_with(10_000_000_000);
    let _ = with_positions(&mut p, &[(1, side::LONG, QTY_SCALE, 100 * PRICE_SCALE, 100 * PRICE_SCALE)]);
    p.set_stop(1, 90 * PRICE_SCALE).unwrap();
    // setting the same market again replaces rather than consuming a second slot
    p.set_stop(1, 95 * PRICE_SCALE).unwrap();
    assert_eq!(p.stop_for(1), Some(95 * PRICE_SCALE));
    assert_eq!(p.stops.iter().filter(|s| s.price > 0).count(), 1);

    // a stop on a market with no position is dropped ...
    p.set_stop(2, 45 * PRICE_SCALE).unwrap();
    p.prune_stops();
    assert_eq!(p.stop_for(1), Some(95 * PRICE_SCALE));
    assert_eq!(p.stop_for(2), None);

    // ... and so is one whose position has just been closed, so it can never be
    // applied to a later, unrelated position on the same market.
    p.positions[0] = Position::default();
    p.recount_positions();
    p.prune_stops();
    assert_eq!(p.stop_for(1), None);
}

#[test]
fn venue_baseline_splits_each_realization_exactly_once() {
    // Walks the transitions `sync_venue` relies on. `observed` stands in for
    // the venue's `usdc_balance + Σ quote over flat slots`; the baseline must
    // track it exactly except for realizations still owed a profit split.
    let mut p = pool_with(10_000_000_000);

    // $2,000 posted as collateral. Capital moving in is not profit.
    let deposit = 2_000_000_000i64;
    p.venue_accounted_quote += deposit;
    let mut observed = deposit;
    assert_eq!(observed - p.venue_accounted_quote, 0, "a deposit must not read as profit");

    // The venue stops a position out for +$500 without the program's involvement.
    observed += 500_000_000;
    let delta = observed - p.venue_accounted_quote;
    assert_eq!(delta, 500_000_000);
    risk::apply_profit_split(&mut p, delta, 100, 14).unwrap();
    p.venue_accounted_quote = observed;
    assert_eq!(p.escrow_total, 400_000_000, "trader's 80% accrued once");

    // Syncing again with nothing new must not re-split it.
    assert_eq!(observed - p.venue_accounted_quote, 0);

    // The program closes a position itself for −$100 and splits it; the venue
    // then reports the same move. The baseline advance keeps it single-counted.
    risk::apply_profit_split(&mut p, -100_000_000, 100, 14).unwrap();
    risk::account_own_realization(&mut p, -100_000_000);
    observed -= 100_000_000;
    assert_eq!(observed - p.venue_accounted_quote, 0, "an own close must not be re-split");
    assert_eq!(p.escrow_total, 320_000_000, "80% of the loss clawed back, once");

    // Pulling collateral back is not a loss either.
    p.venue_accounted_quote -= 1_000_000_000;
    observed -= 1_000_000_000;
    assert_eq!(observed - p.venue_accounted_quote, 0, "a withdrawal must not read as a loss");
}

#[test]
fn promotion_cushion_comes_out_of_the_trader_s_own_earnings() {
    // The fork the design turns on: profit left in the pool becomes first-loss
    // capital and buys a bigger cap; profit taken home does not.
    let mut p = pool_with(5_000_000_000);
    p.first_loss_seed = 647_000_000; // 12.94% of the $5k Tier-1 cap, from the entry fee

    // Two profitable days: 80% of each gain lands in escrow.
    risk::apply_profit_split(&mut p, 1_000_000_000, 100, 14).unwrap();
    risk::apply_profit_split(&mut p, 1_000_000_000, 101, 14).unwrap();
    assert_eq!(p.escrow_total, 1_600_000_000);
    risk::vest(&mut p, 114); // day-100 bucket matures → withdrawable
    assert_eq!(p.vested_claimable, 800_000_000);

    // Tier 2 ($15k cap) needs 12.94% = $1,941; the pool holds $647.
    let required = 1_941_000_000u64;
    let short = required - p.first_loss_seed;
    let moved = risk::escrow_to_first_loss(&mut p, short);
    assert_eq!(moved, short, "escrow covers the shortfall");
    assert_eq!(p.first_loss_seed, required);
    // Vested is spent first. That is the money the trader gave up.
    assert_eq!(p.vested_claimable, 0);
    assert_eq!(p.escrow_total, 1_600_000_000 - 800_000_000 - (short - 800_000_000));

    // A pool without the earnings simply cannot reach the next cap.
    let mut q = pool_with(5_000_000_000);
    q.first_loss_seed = 647_000_000;
    assert_eq!(risk::escrow_to_first_loss(&mut q, short), 0, "no escrow, no promotion");
    assert_eq!(q.first_loss_seed, 647_000_000);
}

#[test]
fn liquidation_bounty_is_flat_at_every_size() {
    // Flat on purpose: the bounty is charged to the trader's first-loss seed,
    // and whatever survives goes to the investors at reap, so a bounty that
    // scaled with NAV took the most from the pools with the most real money in
    // them. A Tier-3 liquidation used to cost them $150 (2 x 25bps of $30k);
    // it costs $10 now.
    let mut cfg = test_config();
    cfg.keeper_bounty = 5_000_000; // $5
    for nav in [1_000_000_000u64, 5_000_000_000, 30_000_000_000] {
        assert_eq!(risk::liquidation_bounty(nav, &cfg).unwrap(), 5_000_000, "NAV must not change the bounty");
    }
    // The knob that remains is the flat figure itself, and it has to be worth a
    // transaction on the largest pool, not the smallest. Nothing makes a big
    // pool more attractive to liquidate any more.
    cfg.keeper_bounty = 25_000_000;
    assert_eq!(risk::liquidation_bounty(30_000_000_000, &cfg).unwrap(), 25_000_000);
}

#[test]
fn funding_a_trader_mints_no_phantom_profit_for_investors() {
    // The bug this pins: a $5,000 Tier-1 pool is funded with $4,353 of
    // CommonPool money plus $647 of the trader's entry fee. Equity is $5,000,
    // but only the $4,353 bought shares. Pricing the mint against equity marked
    // the CommonPool up 14.9% the instant the trader signed up. Profit nobody
    // had earned, redeemable by whoever pulled first, out of the very cushion
    // the liquidation buffer is sized against.
    let allocation = 4_353_000_000u64;
    let seed = 647_000_000u64;
    let mut p = pool_with(allocation); // shares minted against the allocation alone
    p.accounted_usdc = allocation + seed;
    p.first_loss_seed = seed;
    p.investor_principal = allocation;

    let flat = risk::Marks { prices: vec![], unrealized: 0, gross_notional: 0 };
    let equity = risk::compute_nav(&p, &flat);
    assert_eq!(equity, allocation + seed, "the seed is real capital, and it is in equity");
    assert_eq!(risk::investor_nav(&p, equity), allocation, "…but none of it is investor value");
    assert_eq!(
        nav_per_share(risk::investor_nav(&p, equity), p.total_shares).unwrap(),
        nav_per_share(allocation, p.total_shares).unwrap(),
        "NAV/share is exactly 1.0 at funding",
    );
}

#[test]
fn the_seed_absorbs_losses_before_investor_nav_moves() {
    let allocation = 4_353_000_000u64;
    let seed = 647_000_000u64;
    let mut p = pool_with(allocation);
    p.accounted_usdc = allocation + seed;
    p.first_loss_seed = seed;
    p.investor_principal = allocation;

    // Unrealized drawdown, walked down through and past the cushion.
    for (loss, want_left, want_inv) in [
        (0i64, seed, allocation),
        (-200_000_000, seed - 200_000_000, allocation),
        (-647_000_000, 0, allocation),
        (-800_000_000, 0, allocation - 153_000_000), // only now do investors lose
    ] {
        let marks = risk::Marks { prices: vec![], unrealized: loss, gross_notional: 0 };
        let equity = risk::compute_nav(&p, &marks);
        assert_eq!(risk::remaining_first_loss(&p, equity), want_left, "cushion left at {loss}");
        assert_eq!(risk::investor_nav(&p, equity), want_inv, "investor NAV at {loss}");
    }

    // Derived, not decremented: a recovery hands the cushion back rather than
    // leaving it spent and crediting the bounce to investors.
    let marks = risk::Marks { prices: vec![], unrealized: -100_000_000, gross_notional: 0 };
    let equity = risk::compute_nav(&p, &marks);
    assert_eq!(risk::remaining_first_loss(&p, equity), seed - 100_000_000);
    assert_eq!(risk::investor_nav(&p, equity), allocation);
}

#[test]
fn a_redemption_cannot_withdraw_the_cushion() {
    // The other half of the bug: even priced correctly, an exit must move
    // equity and principal by the same amount, or each redemption would read
    // as the cushion having been spent and the next one would be under-paid.
    let allocation = 4_353_000_000u64;
    let seed = 647_000_000u64;
    let mut p = pool_with(allocation);
    p.accounted_usdc = allocation + seed;
    p.first_loss_seed = seed;
    p.investor_principal = allocation;

    let flat = risk::Marks { prices: vec![], unrealized: 0, gross_notional: 0 };
    let half = p.total_shares / 2;
    let payout = value_for_shares(half, p.total_shares, risk::investor_nav(&p, risk::compute_nav(&p, &flat))).unwrap();
    assert_eq!(payout, allocation / 2);

    // What pay_out does.
    p.accounted_usdc -= payout;
    p.total_shares -= half;
    p.investor_principal -= payout;

    let equity = risk::compute_nav(&p, &flat);
    assert_eq!(risk::remaining_first_loss(&p, equity), seed, "the cushion is untouched");
    assert_eq!(risk::investor_nav(&p, equity), allocation - payout, "the rest is still worth par");
    assert_eq!(
        value_for_shares(p.total_shares, p.total_shares, risk::investor_nav(&p, equity)).unwrap(),
        allocation - payout,
        "the last investor out is paid the same price as the first",
    );
}


#[test]
fn the_high_water_gate_is_measured_on_investor_value_not_equity() {
    // `claim_trader_fees` may only pay while investor NAV/share is at its
    // high-water mark. `hwm_nps` is written by `risk::mark` from
    // `investor_nav`, so the gate has to be read the same way: comparing
    // equity/share against it compares two different numbers and leaves the
    // check loose by the whole remaining first-loss seed.
    let allocation = 4_353_000_000u64;
    let seed = 647_000_000u64;
    let mut p = pool_with(allocation);
    p.accounted_usdc = allocation + seed;
    p.first_loss_seed = seed;
    p.investor_principal = allocation;
    // Mint on the funding path's basis (DEAD_SHARES per SEED_DEPOSIT), not
    // `pool_with`'s 1e12-per-base-unit shortcut: that one puts NAV/share at 1,
    // where integer division flattens every price difference this test is about.
    p.total_shares = (allocation as u128) * DEAD_SHARES / SEED_DEPOSIT as u128;

    // A $1,000 winning day: 80% to escrow, 5% to the platform, 15% compounds.
    p.accounted_usdc += 1_000_000_000;
    risk::apply_profit_split(&mut p, 1_000_000_000, 100, 14).unwrap();
    assert_eq!(p.escrow_total, 800_000_000);
    assert_eq!(p.platform_fee_owed, 50_000_000);

    let flat = risk::Marks { prices: vec![], unrealized: 0, gross_notional: 0 };
    let equity = risk::compute_nav(&p, &flat);
    assert_eq!(equity, 5_150_000_000);
    risk::mark(&mut p, equity, 0).unwrap(); // the mark that sets the HWM
    let hwm = p.hwm_nps;
    assert_eq!(hwm, nav_per_share(4_503_000_000, p.total_shares).unwrap());

    // The escrow matures, so there is something to claim.
    risk::vest(&mut p, 114);
    assert_eq!(p.vested_claimable, 800_000_000);

    // Then the book gives $400 back. The loss lands on the cushion, so investor
    // value falls to par. Below the high-water mark it reached on the winning
    // day, which is exactly when the trader must not be able to take money out.
    let down = risk::Marks { prices: vec![], unrealized: -400_000_000, gross_notional: 0 };
    let equity = risk::compute_nav(&p, &down);
    assert_eq!(equity, 4_750_000_000);

    let investor_nps = nav_per_share(risk::investor_nav(&p, equity), p.total_shares).unwrap();
    assert!(investor_nps < hwm, "investor value is below its high-water mark: the claim must be refused");

    // The number the gate used to read. It is above the HWM here purely because
    // it still contains the trader's own cushion, so the claim would have been
    // allowed while investors sat under water.
    let equity_nps = nav_per_share(equity, p.total_shares).unwrap();
    assert!(equity_nps > hwm, "equity/share and the HWM are not comparable quantities");
}

#[test]
fn a_redemption_unwind_splits_its_realization_exactly_once() {
    // `unwind_for_redemption` closes the exiting investor's pro-rata slice and
    // runs the result through the profit split itself. On a venue with its own
    // account (Drift) that same realization then shows up in
    // `observed_realized_basis`, so the baseline has to move with the split.
    // Otherwise the next `sync_venue` reads it as a fresh delta and splits it
    // a second time.
    let mut p = pool_with(10_000_000_000);
    let deposit = 2_000_000_000i64;
    p.venue_accounted_quote += deposit;
    let mut observed = deposit;

    // The unwind closes a slice for +$500 net of fees, and splits it.
    let net = 500_000_000i64;
    risk::apply_profit_split(&mut p, net, 100, 14).unwrap(); // advances realized_pnl itself
    risk::account_own_realization(&mut p, net); // <- the half that was missing
    assert_eq!(p.escrow_total, 400_000_000, "trader's 80% accrued once");

    // The venue now reports the close. Nothing new is owed a split.
    observed += net;
    assert_eq!(observed - p.venue_accounted_quote, 0, "an unwind's own close must not be re-split");

    // Without the baseline advance the delta would have been the whole
    // realization again, doubling the escrow the clawback later has to reach.
    let unaccounted = observed - (p.venue_accounted_quote - net);
    assert_eq!(unaccounted, net, "this is what sync_venue would have double-counted");
}

#[test]
fn a_forfeited_fee_is_never_dropped_by_a_re_application() {
    use crate::instructions::trader::forfeit_held_fee;
    let mut p = TraderProfile {
        wallet: Default::default(),
        status: TraderStatus::Trial,
        attempts: 1,
        trial_root: [0; 32],
        trial_start_ts: 0,
        trial_days_committed: 0,
        tier: 0,
        tier_start_ts: 0,
        live_days_at_tier: 0,
        pools_created: 0,
        pools_locked: 0,
        trials_failed: 0,
        cooldown_until: 0,
        active_pool: Default::default(),
        bump: 0,
        instant_cap: 0,
        fee_paid: 800_000_000, // $800 entry fee, held in treasury custody
        fee_forfeited: 0,
    };

    // Attempt 1 fails. The fee stops being earmarked for a seed and becomes
    // CommonPool value awaiting `sweep_forfeited_fee`.
    forfeit_held_fee(&mut p);
    assert_eq!(p.fee_paid, 0);
    assert_eq!(p.fee_forfeited, 800_000_000);

    // The trader re-applies before anyone swept. `apply_as_trader` overwrites
    // `fee_paid`, which is exactly what used to strand the first fee, since
    // the profile was the only record that the treasury vault held it.
    p.fee_paid = 800_000_000;
    assert_eq!(p.fee_forfeited, 800_000_000, "attempt 1's fee is still owed to the investors");

    // Attempt 2 fails too: both are owed, neither is lost.
    forfeit_held_fee(&mut p);
    assert_eq!(p.fee_paid, 0);
    assert_eq!(p.fee_forfeited, 1_600_000_000);

    // What the sweep drains, and what a short treasury vault leaves behind.
    let owed = p.fee_forfeited + p.fee_paid;
    let amount = owed.min(1_000_000_000); // vault only covers $1,000 of the $1,600
    let mut rest = amount;
    let from_paid = p.fee_paid.min(rest);
    p.fee_paid -= from_paid;
    rest -= from_paid;
    p.fee_forfeited -= rest;
    assert_eq!(p.fee_forfeited, 600_000_000, "the remainder stays claimable by a later call");
}
