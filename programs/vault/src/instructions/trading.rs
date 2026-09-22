//! Trading (section 4.5, section 5.3): the pre-trade guard runs atomically before the venue
//! call; a breaching order fails the transaction, plus escrow vesting and
//! trader fee claims (section 5.2).
use super::common::transfer_from_pool;
use crate::constants::*;
use crate::errors::VaultError;
use crate::events::*;
use crate::math;
use crate::oracle::read_oracle;
use crate::risk;
use crate::state::*;
use crate::venue::{adapter_for, MarginHint, VenueAccounts};
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

#[derive(Accounts)]
pub struct Trade<'info> {
    /// The trader wallet, or a session key authorised by it (see `session`).
    pub signer: Signer<'info>,
    /// CHECK: must equal `pool.trader`; validated by the `has_one` below. Not a signer when a session key signs.
    pub trader: UncheckedAccount<'info>,
    /// Optional trade-only session key for `trader` (`set_session_key`). Pass `None` when the wallet signs.
    #[account(seeds = [SESSION_SEED, trader.key().as_ref()], bump = session.bump)]
    pub session: Option<Account<'info, SessionKey>>,
    #[account(mut, has_one = trader @ VaultError::NotTraderDelegate)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Box<Account<'info, MarketRegistry>>,
    // remaining_accounts: oracle of the traded market + oracles of every open position,
    // then (Drift pools) the Drift block. See venue::drift::DriftAccounts.
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PlaceTradeArgs {
    pub market_id: u16,
    /// 1 = long, 2 = short
    pub side: u8,
    /// Order size as USDC notional (base units).
    pub notional: u64,
    /// 0 = market order; otherwise a limit within `limit_band_bps` of oracle.
    pub limit_px: u64,
    /// Optional stop trigger, 1e6. 0 = none. When set it must sit below the mark
    /// on a long / above it on a short, replaces any existing stop on this
    /// market, and covers the whole resulting position. Not just the quantity
    /// added here.
    pub stop_px: u64,
}

fn find_oracle<'a, 'info>(accs: &'a [AccountInfo<'info>], key: Pubkey) -> Result<&'a AccountInfo<'info>> {
    accs.iter().find(|a| a.key() == key).ok_or_else(|| VaultError::OracleMissing.into())
}

pub fn place_trade<'info>(ctx: Context<'_, '_, 'info, 'info, Trade<'info>>, args: PlaceTradeArgs) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let registry = &ctx.accounts.registry;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let pool_info = ctx.accounts.pool.to_account_info();
    let venue = VenueAccounts { pool: &pool_info, remaining: ctx.remaining_accounts };
    let pool = &mut ctx.accounts.pool;

    // 1. pool live and platform not paused
    require!(!cfg.paused, VaultError::Paused);
    require!(pool.status == PoolStatus::Live, VaultError::InvalidPoolStatus);
    // A pool past its end date is close-only (close_trade has no such check).
    require!(pool.ends_at == 0 || now < pool.ends_at, VaultError::PoolExpired);
    // 2. signer is the registered trader delegate (wallet) or an unexpired session key it authorised
    super::session::check_trade_signer(&ctx.accounts.signer.key(), &pool.trader, ctx.accounts.session.as_ref(), now)?;
    require!(args.side == side::LONG || args.side == side::SHORT, VaultError::InvalidArgument);
    require!(args.notional > 0, VaultError::SizeTooSmall);
    // 3. market present and enabled
    let market = registry.find(args.market_id).ok_or(VaultError::MarketNotFound)?;
    require!(market.enabled, VaultError::MarketDisabled);
    // The venue's book is authoritative: refresh the mirror before measuring anything.
    risk::sync_venue(pool, registry, cfg, &venue, now)?;
    // 4–5. oracle fresh and sane
    let oracle_acc = find_oracle(ctx.remaining_accounts, market.oracle)?;
    let px = read_oracle(oracle_acc, market, cfg, &cfg.risk, &clock, true)?;
    // 6. nav
    let marks = risk::mark_positions(pool, registry, cfg, ctx.remaining_accounts, &clock, true)?;
    let nav = risk::compute_nav(pool, &marks);
    require!(nav > 0, VaultError::DrawdownBreach);
    // 7. roll day epoch
    risk::roll_day(pool, nav, now, cfg.trial.day_secs);
    require!(pool.trades_today < cfg.risk.max_trades_per_day, VaultError::TooManyTrades);
    // 8–9. loss limits
    let daily_floor = math::bps_of(pool.day_start_nav, BPS - cfg.effective_daily_loss_bps(pool.tier) as u64)?;
    let dd_floor = math::bps_of(pool.peak_nav, BPS - cfg.effective_max_drawdown_bps(pool.tier) as u64)?;
    require!(nav >= daily_floor, VaultError::DailyLossBreach);
    require!(nav >= dd_floor, VaultError::DrawdownBreach);
    // 10. position count (adding to an existing position does not open a new one)
    let existing = pool.find_position(args.market_id).map(|i| pool.positions[i]);
    if let Some(e) = existing {
        require!(e.side == args.side, VaultError::OppositeSide);
    } else {
        require!(pool.open_positions < cfg.risk.max_positions, VaultError::TooManyPositions);
    }
    // 11–13. post-trade exposure
    let base_qty = math::qty_for_notional(args.notional, px.price)?;
    require!(base_qty > 0, VaultError::SizeTooSmall);
    let add_notional = math::notional(base_qty, px.price)?;
    let gross_after = marks.gross_notional.checked_add(add_notional).ok_or(VaultError::MathOverflow)?;
    require!(gross_after <= math::bps_of(nav, cfg.risk.max_leverage_bps as u64)?, VaultError::LeverageExceeded);
    let existing_notional = existing.map(|e| math::notional(e.base_qty, px.price)).transpose()?.unwrap_or(0);
    let single_after = existing_notional + add_notional;
    require!(single_after <= math::bps_of(nav, cfg.risk.max_single_bps as u64)?, VaultError::SinglePositionExceeded);
    require!(single_after <= math::bps_of(nav, market.max_leverage_bps as u64)?, VaultError::LeverageExceeded);
    let mut cluster_notional: u64 = add_notional;
    for p in pool.positions.iter().filter(|p| p.is_open() && p.cluster == market.cluster) {
        let m = marks.price_of(p.market_id).ok_or(VaultError::OracleMissing)?;
        cluster_notional = cluster_notional.saturating_add(math::notional(p.base_qty, m.price)?);
    }
    require!(cluster_notional <= math::bps_of(nav, cfg.risk.max_cluster_bps as u64)?, VaultError::ClusterExceeded);
    // 14. limit within band
    if args.limit_px > 0 {
        let band = math::bps_of(px.price, cfg.risk.limit_band_bps as u64)?;
        require!(args.limit_px.abs_diff(px.price) <= band, VaultError::LimitOutOfBand);
    }
    // 15. optional stop. A prop platform sets loss *limits*, it does not dictate
    //     how a trader reaches them, so a stop is a tool the trader may use and
    //     not a condition of trading. Risk is bounded by the liquidation model
    //     instead: the trader's first-loss seed absorbs the overshoot between
    //     the liquidation trigger and the investor floor. `stop_px == 0` means
    //     no stop; a stop that is set must still be on the correct side.
    if args.stop_px > 0 {
        let stop_ok = if args.side == side::LONG { args.stop_px < px.price } else { args.stop_px > px.price };
        require!(stop_ok, VaultError::StopWrongSide);
    }

    // → venue. Drift tops its collateral up to what the post-trade book needs
    //   at the platform cap (the guard just proved NAV covers it).
    let adapter = adapter_for(pool);
    let margin = MarginHint { required_collateral: risk::required_collateral(gross_after, cfg), venue_equity: marks.unrealized };
    let fill = adapter.open_position(pool, &venue, market, args.side, base_qty, args.limit_px, &px, margin, now)?;
    pool.trades_today += 1;
    pool.total_trades = pool.total_trades.saturating_add(1);
    if args.stop_px > 0 {
        pool.set_stop(args.market_id, args.stop_px)?;
        // Park it at the venue over the whole post-fill position. On Drift a
        // reduce-only trigger order worked by Drift's own keepers. Still fatal
        // if it cannot be placed: a stop the trader asked for and did not get
        // is worse than none at all.
        let held = adapter.read_position(pool, args.market_id).map(|p| p.base_qty).unwrap_or(0);
        adapter.set_stop_order(pool, &venue, market, args.side, held, args.stop_px)?;
    }

    // → update state: re-mark with the new position included (spread cost shows up as unrealized)
    let marks_after = risk::mark_positions(pool, registry, cfg, ctx.remaining_accounts, &clock, false)?;
    let nav_after = risk::compute_nav(pool, &marks_after);
    risk::mark(pool, nav_after, now)?;
    let after = adapter.read_position(pool, args.market_id).unwrap_or_default();

    emit!(TradeFilled {
        pool: pool.key(),
        trader: pool.trader,
        market_id: args.market_id,
        side: args.side,
        is_close: false,
        base_qty: fill.base_qty,
        fill_price: fill.fill_price,
        oracle_price: px.price,
        oracle_slot: px.slot,
        fee: fill.fee,
        realized_pnl: 0,
        position_qty_after: after.base_qty,
        position_entry_after: after.entry_price,
        nav_after,
        escrow_total_after: pool.escrow_total,
        open_positions: pool.open_positions,
        ts: now,
    });
    if args.stop_px > 0 {
        emit!(StopSet { pool: pool.key(), market_id: args.market_id, stop_px: args.stop_px, nav: nav_after, ts: now });
    }
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct CloseTradeArgs {
    pub market_id: u16,
    /// Base quantity to close (1e9 scale); 0 = entire position.
    pub base_qty: u64,
    pub limit_px: u64,
}

/// Closing is never blocked by a disabled market (section 4.9), but it IS subject to
/// `max_trades_per_day`, so a trader at the daily cap must wait for the day
/// roll or be unwound by a keeper. Realized PnL goes through the 80/15/5 split
/// with clawback (section 5.2).
pub fn close_trade<'info>(ctx: Context<'_, '_, 'info, 'info, Trade<'info>>, args: CloseTradeArgs) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let registry = &ctx.accounts.registry;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let pool_info = ctx.accounts.pool.to_account_info();
    let venue = VenueAccounts { pool: &pool_info, remaining: ctx.remaining_accounts };
    let pool = &mut ctx.accounts.pool;

    require!(!cfg.paused, VaultError::Paused);
    require!(pool.status == PoolStatus::Live, VaultError::InvalidPoolStatus);
    super::session::check_trade_signer(&ctx.accounts.signer.key(), &pool.trader, ctx.accounts.session.as_ref(), now)?;
    let market = registry.find(args.market_id).ok_or(VaultError::MarketNotFound)?;
    risk::sync_venue(pool, registry, cfg, &venue, now)?;
    let idx = pool.find_position(args.market_id).ok_or(VaultError::PositionNotFound)?;
    let before = pool.positions[idx];
    require!(now - before.opened_at >= cfg.risk.min_hold_secs as i64, VaultError::MinHoldTime);

    let oracle_acc = find_oracle(ctx.remaining_accounts, market.oracle)?;
    let px = read_oracle(oracle_acc, market, cfg, &cfg.risk, &clock, true)?;
    let marks = risk::mark_positions(pool, registry, cfg, ctx.remaining_accounts, &clock, false)?;
    let nav = risk::compute_nav(pool, &marks);
    risk::roll_day(pool, nav, now, cfg.trial.day_secs);
    require!(pool.trades_today < cfg.risk.max_trades_per_day, VaultError::TooManyTrades);
    if args.limit_px > 0 {
        let band = math::bps_of(px.price, cfg.risk.limit_band_bps as u64)?;
        require!(args.limit_px.abs_diff(px.price) <= band, VaultError::LimitOutOfBand);
    }

    let adapter = adapter_for(pool);
    let fill = adapter.close_position(pool, &venue, market, args.base_qty, args.limit_px, &px, now)?;
    pool.trades_today += 1;
    pool.total_trades = pool.total_trades.saturating_add(1);
    // Realized PnL is net of the closing fee: the trader's 80% is of what the pool actually keeps.
    let net = fill.realized_pnl.saturating_sub(fill.fee as i64);

    // 80/15/5 split on realized PnL; vesting stamped with the *current* tier's period.
    // This advances `pool.realized_pnl`. The pool is Live by the guard above, so
    // the split always runs and must be the only writer.
    let today = risk::epoch_day(now, cfg.trial.day_secs);
    let vest_days = cfg.effective_vest_days(pool.tier);
    risk::apply_profit_split(pool, net, today, vest_days)?;
    // Already split here. Advance the baseline so `sync_venue` does not count
    // this same realization again on the next instruction.
    risk::account_own_realization(pool, net);
    pool.prune_stops();
    // A venue stop must not outlive its position, and a partial close leaves a
    // stale size resting: cancel either way, then re-place over what remains.
    adapter.cancel_stop_orders(pool, &venue, Some(market.venue_market_index))?;
    if let Some(p) = adapter.read_position(pool, args.market_id).filter(|p| p.is_open()) {
        if let Some(stop) = pool.stop_for(args.market_id) {
            adapter.set_stop_order(pool, &venue, market, p.side, p.base_qty, stop)?;
        }
    }

    let marks_after = risk::mark_positions(pool, registry, cfg, ctx.remaining_accounts, &clock, false)?;
    let nav_after = risk::compute_nav(pool, &marks_after);
    risk::mark(pool, nav_after, now)?;
    let after = adapter.read_position(pool, args.market_id).unwrap_or_default();

    emit!(TradeFilled {
        pool: pool.key(),
        trader: pool.trader,
        market_id: args.market_id,
        side: before.side,
        is_close: true,
        base_qty: fill.base_qty,
        fill_price: fill.fill_price,
        oracle_price: px.price,
        oracle_slot: px.slot,
        fee: fill.fee,
        realized_pnl: net,
        position_qty_after: after.base_qty,
        position_entry_after: after.entry_price,
        nav_after,
        escrow_total_after: pool.escrow_total,
        open_positions: pool.open_positions,
        ts: now,
    });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct SetStopArgs {
    pub market_id: u16,
    pub stop_px: u64,
}

/// Move the stop on an open position without trading. Stops are the trader's
/// own tool, not a risk control, so this only checks the stop is on the correct
/// side of the mark. Losses are bounded by the liquidation model instead.
pub fn set_stop<'info>(ctx: Context<'_, '_, 'info, 'info, Trade<'info>>, args: SetStopArgs) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let registry = &ctx.accounts.registry;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let pool_info = ctx.accounts.pool.to_account_info();
    let venue = VenueAccounts { pool: &pool_info, remaining: ctx.remaining_accounts };
    let pool = &mut ctx.accounts.pool;

    require!(!cfg.paused, VaultError::Paused);
    require!(pool.status == PoolStatus::Live, VaultError::InvalidPoolStatus);
    super::session::check_trade_signer(&ctx.accounts.signer.key(), &pool.trader, ctx.accounts.session.as_ref(), now)?;
    let market = registry.find(args.market_id).ok_or(VaultError::MarketNotFound)?;
    risk::sync_venue(pool, registry, cfg, &venue, now)?;
    let pos = pool
        .find_position(args.market_id)
        .map(|i| pool.positions[i])
        .ok_or(VaultError::PositionNotFound)?;

    let oracle_acc = find_oracle(ctx.remaining_accounts, market.oracle)?;
    let px = read_oracle(oracle_acc, market, cfg, &cfg.risk, &clock, true)?;
    require!(args.stop_px > 0, VaultError::InvalidArgument);
    let stop_ok = if pos.side == side::LONG { args.stop_px < px.price } else { args.stop_px > px.price };
    require!(stop_ok, VaultError::StopWrongSide);

    let marks = risk::mark_positions(pool, registry, cfg, ctx.remaining_accounts, &clock, true)?;
    let nav = risk::compute_nav(pool, &marks);
    risk::roll_day(pool, nav, now, cfg.trial.day_secs);

    pool.set_stop(args.market_id, args.stop_px)?;
    adapter_for(pool).set_stop_order(pool, &venue, market, pos.side, pos.base_qty, args.stop_px)?;
    emit!(StopSet { pool: pool.key(), market_id: args.market_id, stop_px: args.stop_px, nav, ts: now });
    Ok(())
}

#[derive(Accounts)]
pub struct VestEscrow<'info> {
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
}

/// Permissionless and idempotent (section 5.2).
pub fn vest_escrow(ctx: Context<VestEscrow>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    let amount = risk::vest(pool, risk::epoch_day(now, ctx.accounts.config.trial.day_secs));
    emit!(EscrowVested { pool: pool.key(), amount, vested_claimable: pool.vested_claimable, ts: now });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimTraderFees<'info> {
    pub trader: Signer<'info>,
    #[account(mut, has_one = trader @ VaultError::NotTraderDelegate)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [POOL_VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = trader_usdc.owner == trader.key(), constraint = trader_usdc.mint == config.usdc_mint)]
    pub trader_usdc: Account<'info, TokenAccount>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Box<Account<'info, MarketRegistry>>,
    #[account(mut, seeds = [TRADER_SEED, trader.key().as_ref()], bump = profile.bump)]
    pub profile: Box<Account<'info, TraderProfile>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, seeds = [TREASURY_VAULT_SEED], bump = treasury.vault_bump)]
    pub treasury_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: oracles for every open position
}

/// Pays vested, clawback-cleared escrow, and only while investor NAV/share
/// sits at its high-water mark (section 5.2).
pub fn claim_trader_fees<'info>(ctx: Context<'_, '_, 'info, 'info, ClaimTraderFees<'info>>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, VaultError::Paused);
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    risk::vest(pool, risk::epoch_day(now, cfg.trial.day_secs));
    let amount = pool.vested_claimable;
    require!(amount > 0, VaultError::NothingToClaim);

    let marks = risk::mark_positions(pool, &ctx.accounts.registry, cfg, ctx.remaining_accounts, &clock, false)?;
    // Investor NAV, not equity. `hwm_nps` is a high-water mark of *investor*
    // value per share (`risk::mark`), so pricing the gate on equity compared
    // two different numbers and left it loose by the whole remaining first-loss
    // seed. The trader could claim while investor NAV/share sat below its HWM,
    // which is the one thing this check exists to prevent.
    let equity = risk::compute_nav(pool, &marks);
    let nps = math::nav_per_share(risk::investor_nav(pool, equity), pool.total_shares)?;
    require!(nps >= pool.hwm_nps, VaultError::BelowHighWaterMark);

    let pay = amount.min(pool.accounted_usdc).min(ctx.accounts.vault.amount);
    transfer_from_pool(pool, &ctx.accounts.vault, &ctx.accounts.trader_usdc, &ctx.accounts.token_program, pay)?;
    pool.accounted_usdc -= pay;
    pool.vested_claimable -= pay; // NAV already excluded this amount: no reference-NAV shift
    emit!(FeesClaimed { pool: pool.key(), trader: pool.trader, amount: pay, ts: now });
    // No entry-fee refund: under the Vault Ledger fee model the fee became the
    // pool's first-loss seed capital at funding time and is never returned.
    Ok(())
}
