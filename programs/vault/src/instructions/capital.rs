//! Capital (section 4.4, section 4.7): deposit, request_redemption, unwind_for_redemption,
//! settle_redemption. No path other than the global pause blocks a redemption.
//!
//! **`deposit` is not an investor path.** Investors fund the CommonPool, which
//! deploys capital to traders in strict FIFO order (`fund_next_in_queue`); they
//! never choose a trader, and a trader can never raise capital from them
//! directly. What is left of `deposit` is the trader seeding their *own* pool
//! to the activation floor on the trial path. A self-funding step, gated to
//! `pool.trader` below.
//!
//! The CommonPool does not use this instruction either: `fund_next_in_queue`
//! creates its `InvestorPosition` itself, in the same transaction that creates
//! the pool. Redemption is deliberately left open to any position holder so
//! that a stake minted by either path always has a way out.
use super::common::{pay_bounty, transfer_from_pool};
use crate::constants::*;
use crate::errors::VaultError;
use crate::events::*;
use crate::math;
use crate::risk;
use crate::state::*;
use crate::venue::{adapter_for, VenueAccounts};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct Deposit<'info> {
    /// The depositor. Must be the pool's own trader. See the module docs.
    /// Kept named `investor` because the position it mints is an ordinary
    /// `InvestorPosition`: a self-seeding trader holds investor shares in their
    /// own pool and redeems them like anyone else.
    #[account(mut)]
    pub investor: Signer<'info>,
    /// Constraint lives here rather than on `investor` so it can see both
    /// accounts (Anchor resolves in declaration order).
    #[account(mut, constraint = pool.trader == investor.key() @ VaultError::DirectDepositDisabled)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init_if_needed, payer = investor, space = 8 + InvestorPosition::INIT_SPACE,
        seeds = [INVESTOR_SEED, pool.key().as_ref(), investor.key().as_ref()], bump,
    )]
    pub position: Account<'info, InvestorPosition>,
    #[account(mut, seeds = [POOL_VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = investor_usdc.owner == investor.key(), constraint = investor_usdc.mint == config.usdc_mint)]
    pub investor_usdc: Account<'info, TokenAccount>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Box<Account<'info, MarketRegistry>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: oracles for every open position
}

/// Seed a trader's own pool. See the module docs: this is not how investors
/// reach a trader, and the account constraint above enforces that.
pub fn deposit<'info>(ctx: Context<'_, '_, 'info, 'info, Deposit<'info>>, amount: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, VaultError::Paused);
    // Belt and braces: the same rule the account constraint carries, stated
    // where someone reading the handler will see it.
    require!(
        ctx.accounts.pool.trader == ctx.accounts.investor.key(),
        VaultError::DirectDepositDisabled
    );
    require!(amount >= cfg.min_deposit, VaultError::DepositTooSmall);
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let pool_info = ctx.accounts.pool.to_account_info();
    let venue = VenueAccounts { pool: &pool_info, remaining: ctx.remaining_accounts };
    let pool = &mut ctx.accounts.pool;
    require!(
        matches!(pool.status, PoolStatus::Funding | PoolStatus::Live),
        VaultError::InvalidPoolStatus
    );
    require!(pool.ends_at == 0 || now < pool.ends_at, VaultError::PoolExpired);

    risk::sync_venue(pool, &ctx.accounts.registry, cfg, &venue, now)?;
    let marks = risk::mark_positions(pool, &ctx.accounts.registry, cfg, ctx.remaining_accounts, &clock, true)?;
    // The tier cap sizes *deployed capital*, so it is measured on equity. The
    // trader's first-loss seed occupies part of the cap rather than sitting on
    // top of it. Shares, though, are priced on investor NAV, which excludes the
    // intact seed: a depositor must not buy a claim on the trader's cushion.
    let equity = risk::compute_nav(pool, &marks);
    require!(equity.checked_add(amount).ok_or(VaultError::MathOverflow)? <= if pool.tier == 0 { pool.target_size } else { cfg.tier_cap(pool.tier) }, VaultError::ExceedsTierCap);
    let nav = risk::investor_nav(pool, equity);
    let shares = math::shares_for_deposit(amount, pool.total_shares, nav)?;
    require!(shares > 0, VaultError::DepositTooSmall);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.investor_usdc.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.investor.to_account_info(),
            },
        ),
        amount,
    )?;

    pool.accounted_usdc = pool.accounted_usdc.checked_add(amount).ok_or(VaultError::MathOverflow)?;
    pool.total_shares = pool.total_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;
    // Investor cash in, so the seed's reference moves with it and the deposit
    // does not read as the cushion having been consumed.
    pool.investor_principal = pool.investor_principal.checked_add(amount).ok_or(VaultError::MathOverflow)?;
    // Deposits must not mask losses: shift the reference NAVs by the inflow.
    if pool.status == PoolStatus::Live {
        risk::roll_day(pool, equity, now, cfg.trial.day_secs);
        pool.peak_nav = pool.peak_nav.saturating_add(amount);
        pool.day_start_nav = pool.day_start_nav.saturating_add(amount);
    } else {
        pool.peak_nav = pool.accounted_usdc;
        pool.day_start_nav = pool.accounted_usdc;
    }
    let nav_after = equity + amount;
    let nps = risk::mark(pool, nav_after, now)?;

    let pos = &mut ctx.accounts.position;
    if pos.investor == Pubkey::default() {
        pos.pool = pool.key();
        pos.investor = ctx.accounts.investor.key();
        pos.bump = ctx.bumps.position;
    }
    pos.shares = pos.shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;
    pos.cost_basis = pos.cost_basis.saturating_add(amount);
    pos.last_deposit_ts = now;

    emit!(Deposited {
        pool: pool.key(),
        investor: pos.investor,
        amount,
        shares,
        nav_per_share: nps,
        nav_after,
        ts: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RequestRedemption<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [INVESTOR_SEED, pool.key().as_ref(), investor.key().as_ref()], bump = position.bump, has_one = investor)]
    pub position: Account<'info, InvestorPosition>,
    #[account(mut, seeds = [POOL_VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = investor_usdc.owner == investor.key(), constraint = investor_usdc.mint == config.usdc_mint)]
    pub investor_usdc: Account<'info, TokenAccount>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Box<Account<'info, MarketRegistry>>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: oracles for every open position
}

/// Payout helper shared by the immediate path, `settle_redemption` and the
/// CommonPool's `settle_common_pull`. Adjusts the reference NAVs so an outflow
/// never reads as a loss.
pub(crate) fn pay_out<'info>(
    pool: &mut Account<'info, Pool>,
    vault: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    shares: u128,
    payout: u64,
) -> Result<()> {
    // Pay in full or not at all.
    //
    // This used to cap the transfer at `min(accounted_usdc, vault.amount)` and
    // then burn the FULL share count regardless, so a short-paid investor
    // surrendered every share and the difference became value for whoever
    // stayed. With no event recording that requested != paid.
    //
    // Reverting rather than burning proportionally, deliberately. Both settle
    // paths already `require!(ensure_vault_liquidity(..))` immediately above
    // their call here and fail with this same error rather than under-pay, and
    // `request_redemption` checks free collateral before taking the immediate
    // branch. A shortfall at this point is therefore not a liquidity condition
    // the design rides out; it is `accounted_usdc` disagreeing with the vault.
    // Half-settling a redemption on top of that would require partial-settlement
    // semantics for `pending_shares`, `unwound` and `unwind_cost` that nothing
    // else in the program defines. More new states than the bug removes.
    require!(
        payout <= pool.accounted_usdc && payout <= vault.amount,
        VaultError::InsufficientVaultLiquidity
    );
    transfer_from_pool(pool, vault, to, token_program, payout)?;
    pool.accounted_usdc -= payout;
    pool.total_shares = pool.total_shares.checked_sub(shares).ok_or(VaultError::MathOverflow)?;
    // Investor cash out. Equity and principal fall together, so an exit leaves
    // `remaining_first_loss` exactly where it was. A redemption can never
    // withdraw the cushion, and never reads as the cushion being spent.
    pool.investor_principal = pool.investor_principal.saturating_sub(payout);
    pool.peak_nav = pool.peak_nav.saturating_sub(payout);
    pool.day_start_nav = pool.day_start_nav.saturating_sub(payout);
    pool.last_mark_nav = pool.last_mark_nav.saturating_sub(payout);
    Ok(())
}

pub fn request_redemption<'info>(ctx: Context<'_, '_, 'info, 'info, RequestRedemption<'info>>, shares: u128) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, VaultError::Paused);
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let pool_info = ctx.accounts.pool.to_account_info();
    let venue = VenueAccounts { pool: &pool_info, remaining: ctx.remaining_accounts };
    let pool = &mut ctx.accounts.pool;
    require!(pool.status != PoolStatus::Settled, VaultError::InvalidPoolStatus);
    let pos = &mut ctx.accounts.position;
    require!(pos.pending_shares == 0, VaultError::RedemptionPending);
    require!(shares > 0 && shares <= pos.shares, VaultError::InsufficientShares);
    // 24h post-deposit lockup applies only to live pools (section 4.7); free withdrawal while Funding (section 5.5).
    if pool.status == PoolStatus::Live {
        require!(now >= pos.last_deposit_ts + cfg.risk.redemption_lockup_secs as i64, VaultError::LockupActive);
    }

    risk::sync_venue(pool, &ctx.accounts.registry, cfg, &venue, now)?;
    // Non-strict oracle read: a stale feed must never block an exit.
    let marks = risk::mark_positions(pool, &ctx.accounts.registry, cfg, ctx.remaining_accounts, &clock, false)?;
    // Investor NAV, not equity: an exit is paid out of investor value only.
    let nav = risk::investor_nav(pool, risk::compute_nav(pool, &marks));
    let value = math::value_for_shares(shares, pool.total_shares, nav)?;
    let free = risk::free_collateral(pool, nav, &marks, cfg);

    // Immediate only if free collateral covers the slice *and* the vault can
    // pay it now. Drift pulls settled collateral back into the vault here;
    // if PnL is still unsettled at the venue the request falls through to
    // the unwind path instead of under-paying.
    let immediate = value <= free && adapter_for(pool).ensure_vault_liquidity(pool, &venue, value)?;
    if immediate {
        ctx.accounts.vault.reload()?;
        pay_out(pool, &ctx.accounts.vault, &ctx.accounts.investor_usdc, &ctx.accounts.token_program, shares, value)?;
        pos.shares -= shares;
        let nps = math::nav_per_share(nav.saturating_sub(value), pool.total_shares)?;
        emit!(RedemptionRequested { pool: pool.key(), investor: pos.investor, shares, immediate: true, ts: now });
        emit!(RedemptionSettled {
            pool: pool.key(),
            investor: pos.investor,
            shares,
            payout: value,
            unwind_cost: 0,
            nav_per_share: nps,
            ts: now,
        });
        if pos.shares == 0 {
            let investor = ctx.accounts.investor.to_account_info();
            ctx.accounts.position.close(investor)?;
        }
        return Ok(());
    }

    pos.pending_shares = shares;
    pos.requested_at = now;
    pos.unwound = false;
    pos.unwind_cost = 0;
    pool.pending_redemption_shares = pool.pending_redemption_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;
    emit!(RedemptionRequested { pool: pool.key(), investor: pos.investor, shares, immediate: false, ts: now });
    Ok(())
}

#[derive(Accounts)]
pub struct UnwindForRedemption<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [INVESTOR_SEED, pool.key().as_ref(), position.investor.as_ref()], bump = position.bump)]
    pub position: Account<'info, InvestorPosition>,
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

/// Permissionless, bountied. Closes the exiting investor's pro-rata slice of
/// every open position at market (section 4.7).
pub fn unwind_for_redemption<'info>(ctx: Context<'_, '_, 'info, 'info, UnwindForRedemption<'info>>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, VaultError::Paused);
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let pool_info = ctx.accounts.pool.to_account_info();
    let venue = VenueAccounts { pool: &pool_info, remaining: ctx.remaining_accounts };
    let pool = &mut ctx.accounts.pool;
    let pos = &mut ctx.accounts.position;
    require!(pos.pending_shares > 0, VaultError::NoRedemptionPending);
    require!(!pos.unwound, VaultError::InvalidArgument);
    risk::sync_venue(pool, &ctx.accounts.registry, cfg, &venue, now)?;
    require!(pool.open_positions > 0, VaultError::NothingToUnwind);

    let marks = risk::mark_positions(pool, &ctx.accounts.registry, cfg, ctx.remaining_accounts, &clock, false)?;
    let total_shares = pool.total_shares;
    let adapter = adapter_for(pool);
    let today = risk::epoch_day(now, cfg.trial.day_secs);
    let vest_days = cfg.effective_vest_days(pool.tier);
    let mut cost: u64 = 0;

    let open: Vec<Position> = pool.positions.iter().filter(|p| p.is_open()).copied().collect();
    for p in open {
        let qty = ((p.base_qty as u128) * pos.pending_shares / total_shares) as u64;
        if qty == 0 {
            continue;
        }
        let mark = *marks.price_of(p.market_id).ok_or(VaultError::OracleMissing)?;
        let market = ctx.accounts.registry.find(p.market_id).ok_or(VaultError::MarketNotFound)?;
        let fill = adapter.close_position(pool, &venue, market, qty, 0, &mark, now)?;
        // Slippage on what actually filled (an IOC order at the venue may fill partially).
        let slip = math::notional(fill.base_qty, mark.price.abs_diff(fill.fill_price))?;
        cost = cost.saturating_add(fill.fee).saturating_add(slip);
        let net = fill.realized_pnl.saturating_sub(fill.fee as i64);
        if pool.status == PoolStatus::Live {
            // Advances `realized_pnl` itself. See `apply_profit_split`.
            risk::apply_profit_split(pool, net, today, vest_days)?;
        } else {
            pool.realized_pnl = pool.realized_pnl.saturating_add(net);
        }
        // Accounted here, so `sync_venue` does not read this same realization
        // as a fresh venue-side delta and split it a second time. Advances
        // whatever the status, exactly as `sync_venue` moves the baseline even
        // when it skips the split.
        risk::account_own_realization(pool, net);
        let after = adapter.read_position(pool, p.market_id).unwrap_or_default();
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
            position_qty_after: after.base_qty,
            position_entry_after: after.entry_price,
            nav_after: 0,
            escrow_total_after: pool.escrow_total,
            open_positions: pool.open_positions,
            ts: now,
        });
    }
    pos.unwound = true;
    pos.unwind_cost = cost;

    let pool_key = pool.key();
    pay_bounty(
        &mut ctx.accounts.treasury,
        &ctx.accounts.treasury_vault,
        &ctx.accounts.caller_usdc,
        &ctx.accounts.token_program,
        pool_key,
        ctx.accounts.caller.key(),
        cfg.keeper_bounty,
    )?;
    Ok(())
}

#[derive(Accounts)]
pub struct SettleRedemption<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [INVESTOR_SEED, pool.key().as_ref(), investor.key().as_ref()], bump = position.bump, has_one = investor)]
    pub position: Account<'info, InvestorPosition>,
    #[account(mut, seeds = [POOL_VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = investor_usdc.owner == investor.key(), constraint = investor_usdc.mint == config.usdc_mint)]
    pub investor_usdc: Account<'info, TokenAccount>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Box<Account<'info, MarketRegistry>>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: oracles for every open position
}

/// Pays at post-unwind NAV; the exiting investor bears their own unwind cost.
/// Shares burn here, not at request (section 4.7).
pub fn settle_redemption<'info>(ctx: Context<'_, '_, 'info, 'info, SettleRedemption<'info>>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, VaultError::Paused);
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let pool_info = ctx.accounts.pool.to_account_info();
    let venue = VenueAccounts { pool: &pool_info, remaining: ctx.remaining_accounts };
    let pool = &mut ctx.accounts.pool;
    let pos = &mut ctx.accounts.position;
    let shares = pos.pending_shares;
    require!(shares > 0, VaultError::NoRedemptionPending);

    risk::sync_venue(pool, &ctx.accounts.registry, cfg, &venue, now)?;
    let marks = risk::mark_positions(pool, &ctx.accounts.registry, cfg, ctx.remaining_accounts, &clock, false)?;
    let nav = risk::investor_nav(pool, risk::compute_nav(pool, &marks));
    let total = pool.total_shares;
    let value = math::value_for_shares(shares, total, nav)?;
    if !pos.unwound {
        let free = risk::free_collateral(pool, nav, &marks, cfg);
        require!(value <= free || pool.open_positions == 0, VaultError::UnwindRequired);
    }
    // The pool already absorbed the full unwind cost; the exiting investor's
    // slice absorbed cost × fraction. Charge them the remainder.
    //
    // Checked, like the same arithmetic in `settle_common_pull`: `unwind_cost ×
    // total_shares` is a u64 against a u128 share count, and the product leaves
    // u128 at a large enough pool. Under `overflow-checks` that aborts the
    // transaction rather than corrupting a payout, but an exit that panics is
    // an exit the investor cannot make, so it degrades to "charge them
    // nothing" instead, which errs toward the person leaving.
    let others_share = (pos.unwind_cost as u128)
        .checked_mul(total.saturating_sub(shares))
        .and_then(|v| v.checked_div(total))
        .and_then(|v| u64::try_from(v).ok())
        .unwrap_or(0);
    let payout = value.saturating_sub(others_share);

    // Drift: pull settled collateral back into the vault. Fail loudly rather
    // than under-pay while PnL is still unsettled at the venue (the keeper
    // settles it and the investor retries).
    require!(
        adapter_for(pool).ensure_vault_liquidity(pool, &venue, payout)?,
        VaultError::InsufficientVaultLiquidity
    );
    ctx.accounts.vault.reload()?;
    pay_out(pool, &ctx.accounts.vault, &ctx.accounts.investor_usdc, &ctx.accounts.token_program, shares, payout)?;
    pool.pending_redemption_shares = pool.pending_redemption_shares.saturating_sub(shares);
    pos.shares = pos.shares.checked_sub(shares).ok_or(VaultError::InsufficientShares)?;
    pos.pending_shares = 0;
    pos.unwound = false;
    pos.unwind_cost = 0;
    let nps = math::nav_per_share(nav.saturating_sub(payout), pool.total_shares)?;
    emit!(RedemptionSettled {
        pool: pool.key(),
        investor: pos.investor,
        shares,
        payout,
        unwind_cost: others_share,
        nav_per_share: nps,
        ts: now,
    });
    if pos.shares == 0 {
        let investor = ctx.accounts.investor.to_account_info();
        ctx.accounts.position.close(investor)?;
    }
    Ok(())
}
