//! NAV computation, day roll, marks, breach detection and the trader escrow
//! (vesting + clawback). Section 5.1–section 5.3.
use crate::constants::{BPS, ESCROW_SLOTS, PLATFORM_FEE_BPS, TRADER_SPLIT_BPS};
use crate::errors::VaultError;
use crate::math;
use crate::oracle::{read_oracle, OraclePrice};
use crate::state::{lock_reason, MarketRegistry, PlatformConfig, Pool, PoolStatus};
use crate::venue::{adapter_for, Mark, VenueAccounts};
use anchor_lang::prelude::*;

/// Platform "day" index. `day_secs` is `PlatformConfig.trial.day_secs`: 86_400 in
/// production (UTC days), shorter on demo deployments so trial days, live-trading
/// days (tier promotion) and escrow vesting all run on the same accelerated clock.
pub fn epoch_day(ts: i64, day_secs: u32) -> u32 {
    (ts / day_secs.max(1) as i64) as u32
}

pub struct Marks {
    /// (market_id, price, oracle) for every open position.
    pub prices: Vec<(u16, OraclePrice)>,
    /// Venue equity contribution to NAV: Σ unrealized PnL for the mock;
    /// collateral held at the venue + unrealized PnL (fees, funding) for Drift.
    pub unrealized: i64,
    pub gross_notional: u64,
}

impl Marks {
    pub fn price_of(&self, market_id: u16) -> Option<&OraclePrice> {
        self.prices.iter().find(|(m, _)| *m == market_id).map(|(_, p)| p)
    }
}

/// Resolve oracle prices for every open position from `accounts` (the
/// instruction's remaining accounts, any order; matched by pubkey against the
/// registry) and read the venue equity. For Drift pools `accounts` must also
/// carry the pool's Drift `User` and the USDC `SpotMarket`.
pub fn mark_positions<'info>(
    pool: &Pool,
    registry: &MarketRegistry,
    config: &PlatformConfig,
    accounts: &[AccountInfo<'info>],
    clock: &Clock,
    strict: bool,
) -> Result<Marks> {
    let mut prices = Vec::with_capacity(pool.open_positions as usize);
    let mut marks: Vec<Mark> = Vec::with_capacity(pool.open_positions as usize);
    let mut gross: u64 = 0;
    for p in pool.positions.iter().filter(|p| p.is_open()) {
        let market = registry.find(p.market_id).ok_or(VaultError::MarketNotFound)?;
        let acc = accounts
            .iter()
            .find(|a| a.key() == market.oracle)
            .ok_or(VaultError::OracleMissing)?;
        let px = read_oracle(acc, market, config, &config.risk, clock, strict)?;
        gross = gross
            .checked_add(math::notional(p.base_qty, px.price)?)
            .ok_or(VaultError::MathOverflow)?;
        prices.push((p.market_id, px));
        marks.push(Mark { market_id: p.market_id, venue_market_index: market.venue_market_index, price: px.price });
    }
    let unrealized = adapter_for(pool).read_account_equity(pool, accounts, &marks)?;
    Ok(Marks { prices, unrealized, gross_notional: gross })
}

/// Reconcile the pool's position mirror with the venue before anything is
/// measured (no-op for the mock, whose mirror *is* the book), then account for
/// any realization the venue produced on its own.
///
/// The second half is what closes the gap left by a close the program did not
/// perform. A stop filled by the venue's keepers, a liquidation, an ADL. NAV
/// already tracks those (equity is read from the venue), but the profit split
/// does not, so without this the trader keeps escrow a loss should have clawed
/// back. Returns the amount newly accounted, 0 when there was nothing.
pub fn sync_venue(
    pool: &mut Pool,
    registry: &MarketRegistry,
    config: &PlatformConfig,
    venue: &VenueAccounts,
    now: i64,
) -> Result<i64> {
    let adapter = adapter_for(pool);
    adapter.sync_positions(pool, venue, registry, now)?;
    let Some(observed) = adapter.observed_realized_basis(pool, venue.remaining)? else {
        return Ok(0);
    };
    let delta = observed.saturating_sub(pool.venue_accounted_quote);
    if delta != 0 {
        // Only a live pool splits. After a breach lock `return_unvested` has
        // already taken the trader's escrow, so a late venue realization
        // belongs wholly to investors. Take the baseline, skip the split, and
        // let the value sit in NAV where it is already counted.
        if pool.status == PoolStatus::Live {
            let today = epoch_day(now, config.trial.day_secs);
            // Advances `realized_pnl` itself: the net-new-high rule needs the
            // before and after values to straddle the split, so exactly one of
            // these two branches may touch it.
            apply_profit_split(pool, delta, today, config.effective_vest_days(pool.tier))?;
        } else {
            pool.realized_pnl = pool.realized_pnl.saturating_add(delta);
        }
        pool.venue_accounted_quote = observed;
    }
    Ok(delta)
}

/// Advance the baseline by a realization the program has already split itself,
/// so `sync_venue` does not count it twice. Any difference between the
/// program's arithmetic and the venue's shows up as the next delta.
pub fn account_own_realization(pool: &mut Pool, realized: i64) {
    pool.venue_accounted_quote = pool.venue_accounted_quote.saturating_add(realized);
}

/// Collateral a book of `gross_notional` requires at the platform leverage cap.
pub fn required_collateral(gross_notional: u64, config: &PlatformConfig) -> u64 {
    let required = (gross_notional as u128) * (BPS as u128) / (config.risk.max_leverage_bps.max(1) as u128);
    required.min(u64::MAX as u128) as u64
}

/// Total pool equity: accounted_usdc + venue_equity − trader_escrow
/// − trader_claimable − uncollected platform fee, floored at 0.
///
/// This is the number the *risk* engine works in. Loss limits, the drawdown
/// peak, leverage and the liquidation health factor all measure it, because it
/// includes the trader's first-loss seed and the whole point of the seed is to
/// be spent before investor money is. Anything that prices or pays **investor**
/// shares must use [`investor_nav`] instead.
pub fn compute_nav(pool: &Pool, marks: &Marks) -> u64 {
    let gross = (pool.accounted_usdc as i128) + (marks.unrealized as i128);
    let net = gross
        - (pool.escrow_total as i128)
        - (pool.vested_claimable as i128)
        - (pool.platform_fee_owed as i128);
    if net <= 0 {
        0
    } else {
        net.min(u64::MAX as i128) as u64
    }
}

/// How much of the trader's first-loss seed is still standing, given the pool's
/// total `equity`.
///
/// Derived rather than decremented, deliberately: an unrealized loss must eat
/// the cushion the moment it appears on the screen. Not when it is booked.
/// And must give it back if the position recovers. Storing a "spent" counter
/// would do neither.
pub fn remaining_first_loss(pool: &Pool, equity: u64) -> u64 {
    equity.saturating_sub(pool.investor_principal).min(pool.first_loss_seed)
}

/// Investor-redeemable NAV: equity minus whatever is left of the seed.
///
/// At funding, `equity = allocation + seed` and `investor_principal =
/// allocation`, so this returns exactly the allocation. NAV/share is 1.0 and a
/// trader joining does not print phantom profit for the CommonPool. Trader
/// losses then close the gap before this moves at all; genuine trading profit
/// above the seed accrues to investors as normal. Prices deposits and pays
/// redemptions; never used for a loss limit.
pub fn investor_nav(pool: &Pool, equity: u64) -> u64 {
    equity.saturating_sub(remaining_first_loss(pool, equity))
}

/// Free collateral available for immediate redemption: NAV minus the margin the
/// open book requires at the platform leverage cap. Callers pass the
/// *investor* NAV. The seed backs the book but is not withdrawable, so it must
/// not be counted as free.
pub fn free_collateral(_pool: &Pool, nav: u64, marks: &Marks, config: &PlatformConfig) -> u64 {
    nav.saturating_sub(required_collateral(marks.gross_notional, config))
}

/// Roll the UTC day if it changed. Resets the daily counters and sets
/// day-start NAV. Counts live trading days for tier promotion.
pub fn roll_day(pool: &mut Pool, nav: u64, now: i64, day_secs: u32) {
    let today = epoch_day(now, day_secs);
    if pool.day_epoch != today {
        pool.day_epoch = today;
        pool.day_start_nav = nav;
        pool.trades_today = 0;
    }
    if pool.status == PoolStatus::Live && pool.last_live_day != today {
        if pool.last_live_day != 0 {
            pool.live_days_at_tier = pool.live_days_at_tier.saturating_add(1);
        }
        pool.last_live_day = today;
    }
}

/// Update peak NAV and HWM, and return investor NAV/share. HWM never
/// decreases (section 5.2).
///
/// The two halves run on different numbers on purpose: `peak_nav` feeds the
/// drawdown limit, so it tracks total `equity` and starts the clock while the
/// cushion is still intact; `hwm_nps` and the returned price are investor
/// value, so they track [`investor_nav`].
pub fn mark(pool: &mut Pool, equity: u64, now: i64) -> Result<u128> {
    if equity > pool.peak_nav {
        pool.peak_nav = equity;
    }
    let nps = math::nav_per_share(investor_nav(pool, equity), pool.total_shares)?;
    if nps > pool.hwm_nps {
        pool.hwm_nps = nps;
    }
    pool.last_mark_ts = now;
    pool.last_mark_nav = equity;
    Ok(nps)
}

/// What a liquidator is paid for acting on this pool: a flat `keeper_bounty`,
/// the same for every pool at every tier.
///
/// It used to be bps of NAV so a bigger pool was more profitable to close, and
/// the ordering that produced was genuinely useful. It is flat now because the
/// bounty is charged to the trader's first-loss seed, and whatever survives
/// goes to the investors at reap, so every basis point of bounty is taken
/// from the people putting up the real money. A Tier-3 liquidation cost them
/// $150 under the old formula and costs $10 under this one.
///
/// The trade that buys: nothing makes a $30k pool more attractive to liquidate
/// than a $1k one, so the ordering is gone and the flat figure has to be worth
/// a transaction on its own at any size. Size `keeper_bounty` against what an
/// `unwind_all` actually costs a bot. Up to five closes with oracles and
/// priority fees, in exactly the volatile moment fees spike. Not against the
/// smallest pool.
pub fn liquidation_bounty(_nav: u64, config: &PlatformConfig) -> Result<u64> {
    Ok(config.keeper_bounty)
}

/// Convert `amount` of the trader's earned escrow into the pool's first-loss
/// seed. Takes the vested (withdrawable) balance first. That is the money the
/// trader is actually giving up. Then unvested buckets nearest to unlocking.
///
/// The USDC never moves: escrow already sits inside `accounted_usdc` and is
/// only subtracted when NAV is computed, so un-earmarking it raises NAV and
/// puts that capital in front of investors. Returns what it could move, which
/// is short of `amount` only when the escrow cannot cover it.
pub fn escrow_to_first_loss(pool: &mut Pool, amount: u64) -> u64 {
    let mut need = amount;
    let take = pool.vested_claimable.min(need);
    pool.vested_claimable -= take;
    need -= take;
    while need > 0 {
        let mut best: Option<usize> = None;
        for (i, b) in pool.escrow.iter().enumerate() {
            if b.amount > 0 && best.map_or(true, |j| b.unlock_day < pool.escrow[j].unlock_day) {
                best = Some(i);
            }
        }
        let Some(i) = best else { break };
        let t = pool.escrow[i].amount.min(need);
        pool.escrow[i].amount -= t;
        if pool.escrow[i].amount == 0 {
            pool.escrow[i] = Default::default();
        }
        pool.escrow_total -= t;
        need -= t;
    }
    let moved = amount - need;
    pool.first_loss_seed = pool.first_loss_seed.saturating_add(moved);
    moved
}

/// Returns the lock reason if a loss limit is breached.
pub fn breach(pool: &Pool, nav: u64, config: &PlatformConfig) -> u8 {
    let daily_floor = math::bps_of(pool.day_start_nav, BPS - config.effective_daily_loss_bps(pool.tier) as u64).unwrap_or(0);
    if nav < daily_floor {
        return lock_reason::DAILY_LOSS;
    }
    let dd_floor = math::bps_of(pool.peak_nav, BPS - config.effective_max_drawdown_bps(pool.tier) as u64).unwrap_or(0);
    if nav < dd_floor {
        return lock_reason::DRAWDOWN;
    }
    lock_reason::NONE
}

// ---------------------------------------------------------------------------
// Escrow ring buffer (section 5.2)
// ---------------------------------------------------------------------------

/// Move every bucket whose unlock day has passed into `vested_claimable`.
pub fn vest(pool: &mut Pool, today: u32) -> u64 {
    let mut vested = 0u64;
    for b in pool.escrow.iter_mut() {
        if b.amount > 0 && b.unlock_day <= today {
            vested = vested.saturating_add(b.amount);
            *b = Default::default();
        }
    }
    pool.escrow_total = pool.escrow_total.saturating_sub(vested);
    pool.vested_claimable = pool.vested_claimable.saturating_add(vested);
    vested
}

/// Apply the 80/15/5 split to a realized PnL (Vault Ledger section 6: the platform's
/// 5% is carved out of the pool's former 20%), and advance `realized_pnl`.
///
/// The split is on NET NEW PROFIT, not on each winning trade:
///
/// ```text
///     accruable = max(0, cum_after) - max(0, cum_before)
/// ```
///
/// where `cum` is `pool.realized_pnl`. A trader who makes 1000 and loses 1000
/// has earned nothing and accrues nothing; one who is 5000 down and makes 1000
/// is still 4000 down and accrues nothing. Only the part of a gain that lifts
/// cumulative realized PnL above its previous positive high pays out.
///
/// Splitting per winning trade instead (which is what this did) let profit
/// vest out of reach of the clawback while the pool was still underwater. The
/// clawback only ever drained `escrow_total`, so once a bucket passed its
/// `unlock_day` and moved to `vested_claimable` a later loss could not reach
/// it. `compute_nav` had already carved that money out of investor NAV, and
/// `claim_trader_fees` would not release it below the high-water mark, so it
/// stranded: out of the investors' NAV, out of the trader's hands, and enough
/// to deadlock `reap_pool`, which requires both buckets empty.
///
/// Under net-new-high the clawback exactly reverses the accrual, so there is
/// nothing to strand.
///
/// This function OWNS the `realized_pnl` update. It needs the before and after
/// values and they must straddle the split. Callers that also handle non-Live
/// pools (where no split applies) advance `realized_pnl` themselves in the
/// `else` branch; callers must never do both.
///
/// Positive accruable: 80% into today's trader bucket (current tier's vesting
/// stamped on it) and 5% into the uncollected platform fee; 15% stays
/// compounding investor NAV. Negative: claws back min(escrow_total,
/// |accruable| × 80%) nearest-unlock-first, and the uncollected platform fee
/// absorbs its 5% symmetrically.
pub fn apply_profit_split(pool: &mut Pool, realized: i64, today: u32, vest_days: u16) -> Result<()> {
    vest(pool, today);
    let cum_before = pool.realized_pnl;
    let cum_after = cum_before.saturating_add(realized);
    pool.realized_pnl = cum_after;
    let realized = cum_after.max(0).saturating_sub(cum_before.max(0));
    if realized > 0 {
        let pfee = math::bps_of(realized as u64, PLATFORM_FEE_BPS)?;
        pool.platform_fee_owed = pool.platform_fee_owed.checked_add(pfee).ok_or(VaultError::MathOverflow)?;
        let share = math::bps_of(realized as u64, TRADER_SPLIT_BPS)?;
        let slot = (today as usize) % ESCROW_SLOTS;
        let b = &mut pool.escrow[slot];
        if b.amount > 0 && b.unlock_day > today {
            // bucket already written today. Unlock day fixed on first write
            b.amount = b.amount.checked_add(share).ok_or(VaultError::MathOverflow)?;
        } else {
            b.amount = share;
            b.unlock_day = today + vest_days as u32;
        }
        pool.escrow_total = pool.escrow_total.checked_add(share).ok_or(VaultError::MathOverflow)?;
    } else if realized < 0 {
        // The uncollected platform fee takes its 5% of the loss before investors do.
        let pfee_back = math::bps_of(realized.unsigned_abs(), PLATFORM_FEE_BPS)?;
        pool.platform_fee_owed = pool.platform_fee_owed.saturating_sub(pfee_back);
        let mut to_drain = math::bps_of(realized.unsigned_abs(), TRADER_SPLIT_BPS)?.min(pool.escrow_total);
        while to_drain > 0 {
            // nearest unlock_day first
            let mut best: Option<usize> = None;
            for (i, b) in pool.escrow.iter().enumerate() {
                if b.amount > 0 && best.map_or(true, |j| b.unlock_day < pool.escrow[j].unlock_day) {
                    best = Some(i);
                }
            }
            let Some(i) = best else { break };
            let take = pool.escrow[i].amount.min(to_drain);
            pool.escrow[i].amount -= take;
            if pool.escrow[i].amount == 0 {
                pool.escrow[i] = Default::default();
            }
            pool.escrow_total -= take;
            to_drain -= take;
        }
    }
    Ok(())
}

/// On a breach lock (section 4.8), the trader forfeits their profit share back to the
/// pool: unvested escrow AND any vested-but-unclaimed balance both return. The
/// latter matters because a breach craters NAV/share below the trader's HWM,
/// so `claim_trader_fees` would be blocked forever. Leaving the vested balance
/// stuck and the drained pool permanently un-reapable. Both are excluded from
/// NAV, so zeroing them hands the value to investors. Voluntary closes never
/// call this: there the trader keeps their escrow and can still claim.
pub fn return_unvested(pool: &mut Pool) -> u64 {
    let returned = pool.escrow_total.saturating_add(pool.vested_claimable);
    for b in pool.escrow.iter_mut() {
        *b = Default::default();
    }
    pool.escrow_total = 0;
    pool.vested_claimable = 0;
    returned
}
