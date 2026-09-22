//! Risk (section 4.6, section 4.8): keeper marks, permissionless lock and unwind, all bountied.
use super::common::{lock_on_breach, pay_liquidation_bounty};
use crate::constants::*;
use crate::errors::VaultError;
use crate::events::*;
use crate::risk;
use crate::state::*;
use crate::venue::{adapter_for, VenueAccounts};
use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

#[derive(Accounts)]
pub struct RiskAction<'info> {
    pub caller: Signer<'info>,
    #[account(mut, has_one = profile)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut)]
    pub profile: Account<'info, TraderProfile>,
    /// The pool's USDC vault. The bounty is charged here first, against the
    /// trader's first-loss seed, before the communal reserve is touched.
    #[account(mut, seeds = [POOL_VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Box<Account<'info, MarketRegistry>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, seeds = [TREASURY_VAULT_SEED], bump = treasury.vault_bump)]
    pub treasury_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = caller_usdc.owner == caller.key(), constraint = caller_usdc.mint == config.usdc_mint)]
    pub caller_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: oracles for every open position
}

fn evaluate<'info>(ctx: Context<'_, '_, 'info, 'info, RiskAction<'info>>, require_breach: bool) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let pool_info = ctx.accounts.pool.to_account_info();
    let venue = VenueAccounts { pool: &pool_info, remaining: ctx.remaining_accounts };
    let pool = &mut ctx.accounts.pool;
    require!(pool.status == PoolStatus::Live, VaultError::InvalidPoolStatus);

    risk::sync_venue(pool, &ctx.accounts.registry, cfg, &venue, now)?;
    let marks = risk::mark_positions(pool, &ctx.accounts.registry, cfg, ctx.remaining_accounts, &clock, true)?;
    let nav = risk::compute_nav(pool, &marks);
    risk::roll_day(pool, nav, now, cfg.trial.day_secs);
    let reason = risk::breach(pool, nav, cfg);
    let nps = risk::mark(pool, nav, now)?;

    emit!(NavMarked {
        pool: pool.key(),
        nav,
        investor_nav: risk::investor_nav(pool, nav),
        nav_per_share: nps,
        peak_nav: pool.peak_nav,
        day_start_nav: pool.day_start_nav,
        hwm_nps: pool.hwm_nps,
        gross_notional: marks.gross_notional,
        ts: now,
    });

    if reason == lock_reason::NONE {
        require!(!require_breach, VaultError::NoBreach);
        return Ok(());
    }

    let caller = ctx.accounts.caller.key();
    let pool_key = pool.key();
    lock_on_breach(pool_key, pool, &mut ctx.accounts.profile, reason, nav, caller, now, cfg.risk.cooldown_secs)?;
    let bounty = risk::liquidation_bounty(nav, cfg)?;
    let (from_pool, _) = pay_liquidation_bounty(
        pool,
        &ctx.accounts.vault,
        &mut ctx.accounts.treasury,
        &ctx.accounts.treasury_vault,
        &ctx.accounts.caller_usdc,
        &ctx.accounts.token_program,
        caller,
        bounty,
    )?;
    // The mark above predates the payment; keep last_mark_nav honest rather
    // than waiting for the next mark to correct it.
    pool.last_mark_nav = pool.last_mark_nav.saturating_sub(from_pool);
    Ok(())
}

/// Keeper entry point (≤5s per live pool). Marks NAV; locks on breach.
pub fn evaluate_risk<'info>(ctx: Context<'_, '_, 'info, 'info, RiskAction<'info>>) -> Result<()> {
    evaluate(ctx, false)
}

/// Explicit permissionless lock. Errors if no breach.
pub fn lock_pool<'info>(ctx: Context<'_, '_, 'info, 'info, RiskAction<'info>>) -> Result<()> {
    evaluate(ctx, true)
}

/// Close every position at market on a locked pool. No profit split: the
/// unvested escrow was already returned to the pool on lock (section 4.8).
pub fn unwind_all<'info>(ctx: Context<'_, '_, 'info, 'info, RiskAction<'info>>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let pool_info = ctx.accounts.pool.to_account_info();
    let venue = VenueAccounts { pool: &pool_info, remaining: ctx.remaining_accounts };
    let pool = &mut ctx.accounts.pool;
    require!(pool.status == PoolStatus::Locked, VaultError::InvalidPoolStatus);
    risk::sync_venue(pool, &ctx.accounts.registry, cfg, &venue, now)?;
    require!(pool.open_positions > 0, VaultError::NothingToUnwind);

    // Never blocked by a stale feed: non-strict read.
    let marks = risk::mark_positions(pool, &ctx.accounts.registry, cfg, ctx.remaining_accounts, &clock, false)?;
    let adapter = adapter_for(pool);
    let mut closed = 0u8;
    let mut realized: i64 = 0;
    let open: Vec<Position> = pool.positions.iter().filter(|p| p.is_open()).copied().collect();
    for p in open {
        let mark = *marks.price_of(p.market_id).ok_or(VaultError::OracleMissing)?;
        let market = ctx.accounts.registry.find(p.market_id).ok_or(VaultError::MarketNotFound)?;
        let fill = adapter.close_position(pool, &venue, market, 0, 0, &mark, now)?;
        realized = realized.saturating_add(fill.realized_pnl.saturating_sub(fill.fee as i64));
        closed += 1;
        emit!(TradeFilled {
            pool: pool.key(),
            trader: pool.trader,
            market_id: p.market_id,
            side: p.side,
            is_close: true,
            base_qty: fill.base_qty,
            fill_price: fill.fill_price,
            oracle_price: mark.price,
            oracle_slot: mark.slot,
            fee: fill.fee,
            realized_pnl: fill.realized_pnl,
            position_qty_after: 0,
            position_entry_after: 0,
            nav_after: 0,
            escrow_total_after: pool.escrow_total,
            open_positions: pool.open_positions,
            ts: now,
        });
    }
    pool.realized_pnl = pool.realized_pnl.saturating_add(realized);
    // No split on an unwind (section 4.8), but the baseline must still move or the
    // next sync would re-account the same realization.
    risk::account_own_realization(pool, realized);
    pool.prune_stops();
    // Every position is being closed: no stop should be left resting behind.
    adapter.cancel_stop_orders(pool, &venue, None)?;
    // Re-mark: the venue may keep collateral and settled PnL (Drift), and an
    // IOC close can fill partially. A residual position keeps the pool
    // unwindable by a follow-up call rather than mis-stating NAV.
    let marks_after = risk::mark_positions(pool, &ctx.accounts.registry, cfg, ctx.remaining_accounts, &clock, false)?;
    let nav_after = risk::compute_nav(pool, &marks_after);
    pool.last_mark_nav = nav_after;
    pool.last_mark_ts = now;

    let caller = ctx.accounts.caller.key();
    emit!(PoolUnwound { pool: pool.key(), positions_closed: closed, realized_pnl: realized, nav_after, caller, ts: now });
    // Basis is the NAV the unwind protects, same as the lock. The two halves
    // of one liquidation pay symmetrically.
    let bounty = risk::liquidation_bounty(nav_after, cfg)?;
    let (from_pool, _) = pay_liquidation_bounty(
        pool,
        &ctx.accounts.vault,
        &mut ctx.accounts.treasury,
        &ctx.accounts.treasury_vault,
        &ctx.accounts.caller_usdc,
        &ctx.accounts.token_program,
        caller,
        bounty,
    )?;
    pool.last_mark_nav = pool.last_mark_nav.saturating_sub(from_pool);
    Ok(())
}
