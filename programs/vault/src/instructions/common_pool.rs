//! CommonPool crowdsourced funding (Vault Ledger section 1–section 3, section 5).
//!
//! Investors deposit USDC into one shared pool; eligible traders join a strict
//! FIFO queue; `fund_next_in_queue` creates and funds the trader's pool in one
//! permissionless, bountied instruction. The pool is funded to exactly the tier
//! cap: the trader's entry/instant fee goes in as no-shares first-loss seed
//! capital and the CommonPool allocates the remainder, buying its stake (a
//! normal `InvestorPosition` owned by the CommonPool PDA). NAV/share still
//! starts above 1.0, so losses consume the fee cushion before the CommonPool's
//! stake takes any hit. The fee is now carved out of the cap rather than
//! stacked on top of it, which kept a fresh pool permanently above its own
//! deposit ceiling.
//!
//! Phase B (Vault Ledger section 3) is implemented below: redemption pays from the
//! idle reserve first, and queues when idle can't cover it. Idle refills from
//! new deposits and from pools that LOCK: the pull cascade
//! (`request_common_pull` → the existing `unwind_for_redemption` →
//! `settle_common_pull`) permissionlessly brings a locked pool's stake home in
//! full, then `settle_common_redemption` pays the queued investor. A LIVE pool
//! is never pulled, so a redemption can wait on the queue. `reserve_bps` is
//! the buffer that keeps that wait short. `deposit_enabled` remains an admin
//! gate for cautious rollouts.
use super::common::pay_bounty;
use crate::constants::*;
use crate::errors::VaultError;
use crate::events::*;
use crate::math;
use crate::risk;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

// ---------------------------------------------------------------------------
// init / params (admin)
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CommonPoolParams {
    /// Idle reserve floor, bps of idle balance, never deployed to traders.
    pub reserve_bps: u16,
    /// Testnet gate: no deposits before the redemption cascade ships.
    pub deposit_enabled: bool,
}

#[derive(Accounts)]
pub struct InitCommonPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(init, payer = admin, space = 8 + CommonPool::INIT_SPACE, seeds = [COMMON_POOL_SEED], bump)]
    pub common_pool: Box<Account<'info, CommonPool>>,
    #[account(
        init, payer = admin,
        seeds = [COMMON_VAULT_SEED], bump,
        token::mint = usdc_mint, token::authority = common_pool,
    )]
    pub common_vault: Box<Account<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn init_common_pool(ctx: Context<InitCommonPool>, params: CommonPoolParams) -> Result<()> {
    require!(params.reserve_bps < BPS as u16, VaultError::InvalidArgument);
    let cp = &mut ctx.accounts.common_pool;
    cp.reserve_bps = params.reserve_bps;
    cp.deposit_enabled = params.deposit_enabled;
    cp.bump = ctx.bumps.common_pool;
    cp.vault_bump = ctx.bumps.common_vault;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateCommonPoolParams<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(mut, seeds = [COMMON_POOL_SEED], bump = common_pool.bump)]
    pub common_pool: Box<Account<'info, CommonPool>>,
}

pub fn update_common_pool_params(ctx: Context<UpdateCommonPoolParams>, params: CommonPoolParams) -> Result<()> {
    require!(params.reserve_bps < BPS as u16, VaultError::InvalidArgument);
    let cp = &mut ctx.accounts.common_pool;
    cp.reserve_bps = params.reserve_bps;
    cp.deposit_enabled = params.deposit_enabled;
    Ok(())
}

// ---------------------------------------------------------------------------
// deposit_common (section 3: live today)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct DepositCommon<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,
    #[account(mut, seeds = [COMMON_POOL_SEED], bump = common_pool.bump)]
    pub common_pool: Box<Account<'info, CommonPool>>,
    #[account(mut, seeds = [COMMON_VAULT_SEED], bump = common_pool.vault_bump)]
    pub common_vault: Box<Account<'info, TokenAccount>>,
    #[account(
        init_if_needed, payer = investor, space = 8 + CommonPosition::INIT_SPACE,
        seeds = [COMMON_INVESTOR_SEED, investor.key().as_ref()], bump,
    )]
    pub position: Box<Account<'info, CommonPosition>>,
    #[account(mut, constraint = investor_usdc.owner == investor.key(), constraint = investor_usdc.mint == config.usdc_mint)]
    pub investor_usdc: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Box<Account<'info, MarketRegistry>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: exactly one (pool, InvestorPosition) pair per active
    // stake, pools in strictly ascending key order. No more, no fewer, so NAV
    // can't be understated by omitting a pool (Vault Ledger section 3). Followed by
    // the oracle accounts for every staked pool's open positions.
}

/// CommonPool NAV = accounted idle + Σ the CommonPool's proportional
/// **mark-to-market** value of each staked pool: the pool's live *investor* NAV
/// (`investor_nav` over strict-or-relaxed oracle marks), never its raw book.
/// This closes the Vault Ledger section 6 "book value" HIGH-risk caveat. `strict`
/// marks price deposits (no minting off a stale feed); exits use relaxed marks
/// so a stale oracle can never block a redemption, matching the per-pool path.
fn common_nav<'info>(
    cp: &CommonPool,
    cp_key: &Pubkey,
    registry: &MarketRegistry,
    config: &PlatformConfig,
    clock: &Clock,
    remaining: &'info [AccountInfo<'info>],
    strict: bool,
) -> Result<u64> {
    let n = cp.active_stakes as usize;
    require!(remaining.len() >= n * 2, VaultError::WrongStakeAccounts);
    let (pairs, oracles) = remaining.split_at(n * 2);
    // Duplicate stakes are excluded by the ascending-key requirement below, not
    // by anything about the tail: `oracles` is only ever searched by pubkey, so
    // extra accounts there are inert.
    let mut sum = cp.accounted_idle;
    let mut prev: Option<Pubkey> = None;
    for pair in pairs.chunks(2) {
        let pool_ai = &pair[0];
        let pos_ai = &pair[1];
        // Strictly ascending pool keys → every stake distinct, none repeated.
        if let Some(p) = prev {
            require!(pool_ai.key() > p, VaultError::WrongStakeAccounts);
        }
        prev = Some(pool_ai.key());
        let pool: Account<Pool> = Account::try_from(pool_ai)?;
        let pos: Account<InvestorPosition> = Account::try_from(pos_ai)?;
        require!(pos.pool == pool_ai.key() && pos.investor == *cp_key, VaultError::WrongStakeAccounts);
        let marks = risk::mark_positions(&pool, registry, config, oracles, clock, strict)?;
        // Investor NAV, not equity: the CommonPool's stake is an investor
        // stake, and the trader's intact first-loss seed is not part of it.
        let nav = risk::investor_nav(&pool, risk::compute_nav(&pool, &marks));
        let value = math::value_for_shares(pos.shares, pool.total_shares, nav)?;
        sum = sum.checked_add(value).ok_or(VaultError::MathOverflow)?;
    }
    Ok(sum)
}

pub fn deposit_common<'info>(ctx: Context<'_, '_, 'info, 'info, DepositCommon<'info>>, amount: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, VaultError::Paused);
    let cp_key = ctx.accounts.common_pool.key();
    let cp = &mut ctx.accounts.common_pool;
    require!(cp.deposit_enabled, VaultError::CommonDepositsDisabled);
    require!(amount >= cfg.min_deposit, VaultError::DepositTooSmall);
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Strict marks: new shares are never priced off a stale or wide feed.
    let nav = common_nav(cp, &cp_key, &ctx.accounts.registry, cfg, &clock, ctx.remaining_accounts, true)?;
    let shares = math::shares_for_deposit(amount, cp.total_shares, nav)?;
    require!(shares > 0, VaultError::DepositTooSmall);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.investor_usdc.to_account_info(),
                to: ctx.accounts.common_vault.to_account_info(),
                authority: ctx.accounts.investor.to_account_info(),
            },
        ),
        amount,
    )?;

    cp.accounted_idle = cp.accounted_idle.checked_add(amount).ok_or(VaultError::MathOverflow)?;
    cp.total_shares = cp.total_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;
    cp.deposited_total = cp.deposited_total.saturating_add(amount);

    let pos = &mut ctx.accounts.position;
    if pos.investor == Pubkey::default() {
        pos.investor = ctx.accounts.investor.key();
        pos.bump = ctx.bumps.position;
    }
    pos.shares = pos.shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;
    pos.cost_basis = pos.cost_basis.saturating_add(amount);
    pos.last_deposit_ts = now;

    emit!(CommonDeposited {
        investor: pos.investor,
        amount,
        shares,
        nav_after: nav.saturating_add(amount),
        total_shares_after: cp.total_shares,
        ts: now,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// queue_for_funding (section 2: both tracks converge here)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct QueueForFunding<'info> {
    /// Permissionless: anyone may queue an Eligible trader (and pays the ticket rent).
    #[account(mut)]
    pub caller: Signer<'info>,
    /// CHECK: the trader being queued; profile is looked up by seed.
    pub trader: UncheckedAccount<'info>,
    #[account(seeds = [TRADER_SEED, trader.key().as_ref()], bump = profile.bump)]
    pub profile: Box<Account<'info, TraderProfile>>,
    #[account(mut, seeds = [COMMON_POOL_SEED], bump = common_pool.bump)]
    pub common_pool: Box<Account<'info, CommonPool>>,
    /// PDA per trader: a second queue attempt fails outright on init.
    #[account(init, payer = caller, space = 8 + FundingTicket::INIT_SPACE, seeds = [TICKET_SEED, trader.key().as_ref()], bump)]
    pub ticket: Box<Account<'info, FundingTicket>>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    pub system_program: Program<'info, System>,
}

pub fn queue_for_funding(ctx: Context<QueueForFunding>) -> Result<()> {
    require!(!ctx.accounts.config.paused, VaultError::Paused);
    let p = &ctx.accounts.profile;
    require!(p.status == TraderStatus::Eligible, VaultError::NotEligible);
    require!(p.active_pool == Pubkey::default(), VaultError::PoolAlreadyExists);
    let now = Clock::get()?.unix_timestamp;

    let cp = &mut ctx.accounts.common_pool;
    let t = &mut ctx.accounts.ticket;
    t.trader = ctx.accounts.trader.key();
    t.ticket = cp.next_ticket;
    t.payer = ctx.accounts.caller.key();
    t.created_at = now;
    t.bump = ctx.bumps.ticket;
    cp.next_ticket = cp.next_ticket.checked_add(1).ok_or(VaultError::MathOverflow)?;

    emit!(FundingQueued { trader: t.trader, ticket: t.ticket, ts: now });
    Ok(())
}

// ---------------------------------------------------------------------------
// fund_next_in_queue (section 2: strictly in order, permissionless, bountied)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct FundNextInQueue<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [COMMON_POOL_SEED], bump = common_pool.bump)]
    pub common_pool: Box<Account<'info, CommonPool>>,
    #[account(mut, seeds = [COMMON_VAULT_SEED], bump = common_pool.vault_bump)]
    pub common_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [TICKET_SEED, ticket.trader.as_ref()], bump = ticket.bump, close = rent_to)]
    pub ticket: Box<Account<'info, FundingTicket>>,
    /// CHECK: rent refund target. Whoever paid to create the ticket.
    #[account(mut, address = ticket.payer)]
    pub rent_to: UncheckedAccount<'info>,
    #[account(mut, seeds = [TRADER_SEED, ticket.trader.as_ref()], bump = profile.bump)]
    pub profile: Box<Account<'info, TraderProfile>>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(
        init, payer = caller, space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, ticket.trader.as_ref(), &profile.pools_created.to_le_bytes()], bump,
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init, payer = caller,
        seeds = [POOL_VAULT_SEED, pool.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = pool,
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// CommonPool's stake in the new pool. A normal InvestorPosition owned by the CommonPool PDA.
    #[account(
        init, payer = caller, space = 8 + InvestorPosition::INIT_SPACE,
        seeds = [INVESTOR_SEED, pool.key().as_ref(), common_pool.key().as_ref()], bump,
    )]
    pub stake: Box<Account<'info, InvestorPosition>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, seeds = [TREASURY_VAULT_SEED], bump = treasury.vault_bump)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, constraint = caller_usdc.owner == caller.key(), constraint = caller_usdc.mint == config.usdc_mint)]
    pub caller_usdc: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Creates the trader's pool funded to exactly the tier cap, splitting that
/// total between the held entry/instant fee (injected as no-shares seed
/// capital) and a CommonPool allocation for the remainder, then puts the pool
/// straight into `Live`. The activation floor is satisfied by construction, so
/// the separate `activate_pool` step is collapsed here exactly as the Vault
/// Ledger recommends (section 2, step 3).
pub fn fund_next_in_queue(ctx: Context<FundNextInQueue>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, VaultError::Paused);
    let now = Clock::get()?.unix_timestamp;

    let cp = &mut ctx.accounts.common_pool;
    let ticket = &ctx.accounts.ticket;
    require!(ticket.ticket == cp.next_to_fund, VaultError::TicketOutOfOrder);

    let profile = &mut ctx.accounts.profile;
    require!(profile.status == TraderStatus::Eligible, VaultError::NotEligible);
    require!(profile.active_pool == Pubkey::default(), VaultError::PoolAlreadyExists);

    // The pool is funded to exactly the tier cap (tier 0 = the instant cap the
    // trader bought). The trader's fee is *part* of that total, not added on
    // top: the cap bounds the pool, so the CommonPool supplies the remainder.
    let tier = if profile.tier == 0 { 0 } else { profile.tier.clamp(1, MAX_TIER) };
    let cap = if tier == 0 { profile.instant_cap } else { cfg.tier_cap(tier) };
    require!(cap > 0, VaultError::InvalidArgument);

    // The held entry/instant fee splits three ways. First-loss cushion up to
    // what the invariant demands. `min_first_loss_bps` of the cap, covering
    // the drawdown trigger *and* the liquidation buffer past it, so a blowup
    // costs the trader rather than the investors. Whatever is left over is the
    // platform's: half to the keeper bounty reserve (which pays the liquidators
    // that make the buffer real), half to withdrawable revenue.
    //
    // Capped by what the treasury vault holds beyond its own accounted funds,
    // so pre-upgrade profiles (whose fee was booked as revenue) can't create an
    // accounting deficit, and by the cap, which it can never exceed.
    let t = &ctx.accounts.treasury;
    let unaccounted = ctx.accounts.treasury_vault.amount.saturating_sub(t.revenue.saturating_add(t.bounty_reserve));
    let available = profile.fee_paid.min(unaccounted).min(cap);
    let required_cushion = math::bps_of(cap, cfg.min_first_loss_bps as u64)?;
    // Refuse rather than under-seed. `fee_seed` is a `min`, so a fee that no
    // longer covers the cushion produced a pool that looked funded and was
    // quietly short of the first loss the liquidation model assumes is there.
    // The trigger and the buffer beyond it are both sized on this number. The
    // fee is fixed at application time and the cushion moves with
    // min_first_loss_bps (which moves with leverage and the oracle window), so
    // the two drift apart silently. Failing here surfaces it at the one moment
    // someone can still fix it, instead of at a liquidation.
    require!(available >= required_cushion, VaultError::InsufficientFirstLoss);
    let fee_seed = required_cushion;
    let surplus = available.saturating_sub(fee_seed);

    // What the CommonPool puts in, and the only part that mints shares.
    // Zero would mean a pool with no investor stake (and no shares to value
    // it with), so a fee at or above the cap is rejected rather than funded.
    let allocation = cap.saturating_sub(fee_seed);
    require!(allocation > 0, VaultError::InvalidArgument);

    // Reserve floor: never drain the idle balance below reserve_bps of itself.
    let reserve = math::bps_of(cp.accounted_idle, cp.reserve_bps as u64)?;
    require!(
        cp.accounted_idle.saturating_sub(reserve) >= allocation,
        VaultError::InsufficientIdleReserve
    );

    // ---- create the pool (mirrors create_pool + activate_pool) ----
    let pool = &mut ctx.accounts.pool;
    pool.trader = ticket.trader;
    pool.profile = profile.key();
    pool.index = profile.pools_created;
    pool.mandate = Mandate::Perps;
    pool.status = PoolStatus::Live;
    pool.lock_reason = lock_reason::NONE;
    // Vault Ledger: MockPerps only. The Drift funding path is pending real
    // devnet CPI coverage (section 7 "Drift CPI path has no test coverage").
    pool.venue = Venue::MockPerps;
    pool.vault = ctx.accounts.vault.key();
    pool.venue_account = pool.key();
    pool.name = *b"CommonPool-funded\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0";
    pool.strategy_hash = [0u8; 32];
    // The pool's size is the cap, not just the CommonPool's share of it. The
    // tier-0 deposit cap in `capital.rs` reads this field.
    pool.target_size = cap;
    pool.tier = tier;
    pool.created_at = now;
    pool.activated_at = now;
    pool.ends_at = 0;
    pool.bump = ctx.bumps.pool;
    pool.vault_bump = ctx.bumps.vault;
    pool.first_loss_seed = fee_seed;

    // ---- move the money: fee seed (no shares), then the allocation (shares) ----
    if fee_seed > 0 {
        super::common::transfer_from_treasury(
            &ctx.accounts.treasury,
            &ctx.accounts.treasury_vault,
            &ctx.accounts.vault,
            &ctx.accounts.token_program,
            fee_seed,
        )?;
        profile.fee_paid = profile.fee_paid.saturating_sub(fee_seed);
    }
    // The surplus never leaves the treasury vault. It only stops being held in
    // custody for the trader and starts being the platform's, split the same
    // way the performance fee is.
    if surplus > 0 {
        let to_bounty = math::bps_of(surplus, PLATFORM_FEE_BOUNTY_BPS)?;
        let t = &mut ctx.accounts.treasury;
        t.bounty_reserve = t.bounty_reserve.saturating_add(to_bounty);
        t.revenue = t.revenue.saturating_add(surplus - to_bounty);
        profile.fee_paid = profile.fee_paid.saturating_sub(surplus);
    }
    let cp_seeds: &[&[u8]] = &[COMMON_POOL_SEED, &[cp.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.common_vault.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: cp.to_account_info(),
            },
            &[cp_seeds],
        ),
        allocation,
    )?;
    cp.accounted_idle -= allocation;
    cp.funded_total = cp.funded_total.saturating_add(allocation);

    // First (and only) share mint, at the same share-per-USDC basis a seeded
    // pool uses (DEAD_SHARES per SEED_DEPOSIT). The pool's *equity* is
    // `fee_seed + allocation`, but the shares are priced against `allocation`
    // alone: `investor_principal = allocation` makes the whole fee seed count
    // as intact first loss, so NAV/share starts at exactly 1.0.
    //
    // This is the fix for the phantom profit (Vault Ledger section 2): pricing the
    // mint against equity would have marked the CommonPool up by the trader's
    // own cushion the instant they were funded, letting the earliest investors
    // redeem a gain nobody had earned, and draining, from the pool that had
    // just been funded, the very capital the liquidation buffer is sized on.
    // A loss must still consume the whole cushion before investor value moves;
    // that now happens through `remaining_first_loss`, not through the mint.
    let shares = (allocation as u128)
        .checked_mul(DEAD_SHARES)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(SEED_DEPOSIT as u128)
        .ok_or(VaultError::MathOverflow)?;
    let equity = fee_seed.checked_add(allocation).ok_or(VaultError::MathOverflow)?;
    pool.accounted_usdc = equity;
    pool.total_shares = shares;
    pool.investor_principal = allocation;
    let nps = math::nav_per_share(allocation, shares)?;
    pool.hwm_nps = nps;
    pool.tier_start_nps = nps;
    pool.tier_start_ts = now;
    pool.peak_nav = equity;
    pool.day_start_nav = equity;
    pool.day_epoch = risk::epoch_day(now, cfg.trial.day_secs);
    pool.last_live_day = risk::epoch_day(now, cfg.trial.day_secs);
    pool.last_mark_ts = now;
    pool.last_mark_nav = equity;

    let stake = &mut ctx.accounts.stake;
    stake.pool = pool.key();
    stake.investor = cp.key();
    stake.shares = shares;
    stake.cost_basis = allocation;
    stake.last_deposit_ts = now;
    stake.bump = ctx.bumps.stake;
    cp.active_stakes = cp.active_stakes.checked_add(1).ok_or(VaultError::MathOverflow)?;

    // ---- advance the queue, book-keep the trader ----
    cp.next_to_fund = cp.next_to_fund.checked_add(1).ok_or(VaultError::MathOverflow)?;
    profile.pools_created = profile.pools_created.saturating_add(1);
    profile.active_pool = pool.key();
    profile.tier = tier;
    profile.tier_start_ts = now;
    profile.live_days_at_tier = 0;

    let pool_key = pool.key();
    emit!(PoolCreated {
        pool: pool_key,
        trader: pool.trader,
        index: pool.index,
        mandate: pool.mandate as u8,
        target_size: cap,
        tier,
        ts: now,
    });
    emit!(Deposited {
        pool: pool_key,
        investor: cp.key(),
        amount: allocation,
        shares,
        nav_per_share: nps,
        nav_after: equity,
        ts: now,
    });
    emit!(PoolActivated { pool: pool_key, nav: equity, ts: now });
    emit!(PoolFundedFromQueue {
        pool: pool_key,
        trader: pool.trader,
        ticket: ticket.ticket,
        allocation,
        fee_seed,
        nav: equity,
        ts: now,
    });

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

// ---------------------------------------------------------------------------
// Phase B. Redemption out of the CommonPool (Vault Ledger section 3: "pay from idle
// first; only if that's insufficient, permissionlessly pull capital back from
// trader pools before settling the investor")
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct RedeemCommon<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,
    #[account(mut, seeds = [COMMON_POOL_SEED], bump = common_pool.bump)]
    pub common_pool: Box<Account<'info, CommonPool>>,
    #[account(mut, seeds = [COMMON_VAULT_SEED], bump = common_pool.vault_bump)]
    pub common_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [COMMON_INVESTOR_SEED, investor.key().as_ref()], bump = position.bump, has_one = investor)]
    pub position: Box<Account<'info, CommonPosition>>,
    #[account(mut, constraint = investor_usdc.owner == investor.key(), constraint = investor_usdc.mint == config.usdc_mint)]
    pub investor_usdc: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Box<Account<'info, MarketRegistry>>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: the (pool, position) stake pairs + oracles, as in deposit_common.
}

/// Pays immediately from the idle reserve when it covers the redemption;
/// otherwise queues the shares and lets the pull cascade refill idle.
/// Priced with relaxed marks. A stale oracle never blocks an exit.
pub fn redeem_common<'info>(ctx: Context<'_, '_, 'info, 'info, RedeemCommon<'info>>, shares: u128) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, VaultError::Paused);
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let cp_key = ctx.accounts.common_pool.key();
    let cp = &mut ctx.accounts.common_pool;
    let pos = &mut ctx.accounts.position;
    require!(pos.pending_shares == 0, VaultError::RedemptionPending);
    require!(shares > 0 && shares <= pos.shares, VaultError::InsufficientShares);
    require!(now >= pos.last_deposit_ts + cfg.risk.redemption_lockup_secs as i64, VaultError::LockupActive);

    let nav = common_nav(cp, &cp_key, &ctx.accounts.registry, cfg, &clock, ctx.remaining_accounts, false)?;
    let value = math::value_for_shares(shares, cp.total_shares, nav)?;

    if value <= cp.accounted_idle && value <= ctx.accounts.common_vault.amount {
        let cp_seeds: &[&[u8]] = &[COMMON_POOL_SEED, &[cp.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.common_vault.to_account_info(),
                    to: ctx.accounts.investor_usdc.to_account_info(),
                    authority: cp.to_account_info(),
                },
                &[cp_seeds],
            ),
            value,
        )?;
        cp.accounted_idle -= value;
        cp.total_shares = cp.total_shares.checked_sub(shares).ok_or(VaultError::MathOverflow)?;
        pos.shares -= shares;
        emit!(CommonRedemptionRequested { investor: pos.investor, shares, immediate: true, ts: now });
        emit!(CommonRedemptionSettled {
            investor: pos.investor,
            shares,
            payout: value,
            nav_after: nav.saturating_sub(value),
            total_shares_after: cp.total_shares,
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
    cp.pending_redemption_shares = cp.pending_redemption_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;
    emit!(CommonRedemptionRequested { investor: pos.investor, shares, immediate: false, ts: now });
    Ok(())
}

#[derive(Accounts)]
pub struct SettleCommonRedemption<'info> {
    #[account(mut)]
    pub investor: Signer<'info>,
    #[account(mut, seeds = [COMMON_POOL_SEED], bump = common_pool.bump)]
    pub common_pool: Box<Account<'info, CommonPool>>,
    #[account(mut, seeds = [COMMON_VAULT_SEED], bump = common_pool.vault_bump)]
    pub common_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [COMMON_INVESTOR_SEED, investor.key().as_ref()], bump = position.bump, has_one = investor)]
    pub position: Box<Account<'info, CommonPosition>>,
    #[account(mut, constraint = investor_usdc.owner == investor.key(), constraint = investor_usdc.mint == config.usdc_mint)]
    pub investor_usdc: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Box<Account<'info, MarketRegistry>>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: stake pairs + oracles, as in deposit_common.
}

/// Settles a queued redemption at CURRENT NAV once the idle reserve covers it.
/// Idle refills from new deposits and from locked pools coming home via the
/// pull cascade (request_common_pull / unwind_for_redemption /
/// settle_common_pull). Never from a live pool. Pull costs land in NAV before
/// this prices, so the exiting investor bears their proportional share.
pub fn settle_common_redemption<'info>(ctx: Context<'_, '_, 'info, 'info, SettleCommonRedemption<'info>>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, VaultError::Paused);
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let cp_key = ctx.accounts.common_pool.key();
    let cp = &mut ctx.accounts.common_pool;
    let pos = &mut ctx.accounts.position;
    let shares = pos.pending_shares;
    require!(shares > 0, VaultError::NoRedemptionPending);

    let nav = common_nav(cp, &cp_key, &ctx.accounts.registry, cfg, &clock, ctx.remaining_accounts, false)?;
    let value = math::value_for_shares(shares, cp.total_shares, nav)?;
    require!(value <= cp.accounted_idle && value <= ctx.accounts.common_vault.amount, VaultError::IdleShortfall);

    let cp_seeds: &[&[u8]] = &[COMMON_POOL_SEED, &[cp.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.common_vault.to_account_info(),
                to: ctx.accounts.investor_usdc.to_account_info(),
                authority: cp.to_account_info(),
            },
            &[cp_seeds],
        ),
        value,
    )?;
    cp.accounted_idle -= value;
    cp.total_shares = cp.total_shares.checked_sub(shares).ok_or(VaultError::MathOverflow)?;
    cp.pending_redemption_shares = cp.pending_redemption_shares.saturating_sub(shares);
    pos.shares = pos.shares.checked_sub(shares).ok_or(VaultError::InsufficientShares)?;
    pos.pending_shares = 0;
    emit!(CommonRedemptionSettled {
        investor: pos.investor,
        shares,
        payout: value,
        nav_after: nav.saturating_sub(value),
        total_shares_after: cp.total_shares,
        ts: now,
    });
    if pos.shares == 0 {
        let investor = ctx.accounts.investor.to_account_info();
        ctx.accounts.position.close(investor)?;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct RequestCommonPull<'info> {
    /// Permissionless. Normally the keeper.
    pub caller: Signer<'info>,
    #[account(seeds = [COMMON_POOL_SEED], bump = common_pool.bump)]
    pub common_pool: Box<Account<'info, CommonPool>>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    /// The CommonPool's stake in this pool.
    #[account(mut, seeds = [INVESTOR_SEED, pool.key().as_ref(), common_pool.key().as_ref()], bump = stake.bump)]
    pub stake: Box<Account<'info, InvestorPosition>>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
}

/// Marks the CommonPool's ENTIRE stake in a LOCKED `pool` pending, so the
/// capital comes home. Permissionless and independent of any redemption
/// backlog: a locked pool is dead, so there is nothing to wait for. The
/// existing, audited machinery takes over from here: `unwind_for_redemption`
/// closes any residual positions and `settle_common_pull` moves the money to
/// idle, where a queued redemption can reach it.
pub fn request_common_pull(ctx: Context<RequestCommonPull>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, VaultError::Paused);
    let now = Clock::get()?.unix_timestamp;
    // ONLY a locked pool is pulled, and it is pulled in full.
    //
    // A healthy pool is never redeemed out from under its trader. Pulling from a
    // live pool meant `unwind_for_redemption` force-closing part of a book
    // because somebody unrelated wanted out of the CommonPool. A trader doing
    // nothing wrong had positions closed at market on someone else's schedule.
    //
    // A locked pool is the opposite case: dead, flat, and never trading again,
    // so its capital belongs back in the CommonPool immediately. Locked covers
    // every way a pool ends (a breach, a voluntary close, or expiry) so there
    // is always a path home, just never one that runs through a working trader.
    require!(ctx.accounts.pool.status == PoolStatus::Locked, VaultError::PoolNotLocked);
    let pool = &mut ctx.accounts.pool;
    let stake = &mut ctx.accounts.stake;
    require!(stake.pending_shares == 0, VaultError::RedemptionPending);
    require!(stake.shares > 0, VaultError::InsufficientShares);
    // No redemption lockup here: it exists to stop deposit-then-exit churn on a
    // LIVE pool, and this path now only ever sees locked ones.

    // The whole stake. There is nothing left to trade, so there is nothing to
    // leave behind.
    let shares = stake.shares;

    stake.pending_shares = shares;
    stake.requested_at = now;
    stake.unwound = false;
    stake.unwind_cost = 0;
    pool.pending_redemption_shares = pool.pending_redemption_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;
    emit!(CommonPullRequested { pool: pool.key(), shares, ts: now });
    Ok(())
}

#[derive(Accounts)]
pub struct SettleCommonPull<'info> {
    /// Permissionless. Normally the keeper. Receives the stake account's rent
    /// when the stake is fully exited.
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [COMMON_POOL_SEED], bump = common_pool.bump)]
    pub common_pool: Box<Account<'info, CommonPool>>,
    #[account(mut, seeds = [COMMON_VAULT_SEED], bump = common_pool.vault_bump)]
    pub common_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [INVESTOR_SEED, pool.key().as_ref(), common_pool.key().as_ref()], bump = stake.bump)]
    pub stake: Box<Account<'info, InvestorPosition>>,
    #[account(mut, seeds = [POOL_VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Box<Account<'info, MarketRegistry>>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: oracles for the pool's open positions (+ Drift accounts if ever enabled).
}

/// `settle_redemption`, one layer up: pays the CommonPool's pending slice at
/// post-unwind pool NAV INTO the common vault (idle), charging the slice its
/// own unwind cost exactly as an exiting investor is charged (section 4.7 preserved).
pub fn settle_common_pull<'info>(ctx: Context<'_, '_, 'info, 'info, SettleCommonPull<'info>>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, VaultError::Paused);
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let pool_info = ctx.accounts.pool.to_account_info();
    let venue = crate::venue::VenueAccounts { pool: &pool_info, remaining: ctx.remaining_accounts };
    let pool = &mut ctx.accounts.pool;
    let stake = &mut ctx.accounts.stake;
    let shares = stake.pending_shares;
    require!(shares > 0, VaultError::NoRedemptionPending);

    risk::sync_venue(pool, &ctx.accounts.registry, cfg, &venue, now)?;
    let marks = risk::mark_positions(pool, &ctx.accounts.registry, cfg, ctx.remaining_accounts, &clock, false)?;
    let nav = risk::investor_nav(pool, risk::compute_nav(pool, &marks));
    let total = pool.total_shares;
    let value = math::value_for_shares(shares, total, nav)?;
    if !stake.unwound {
        let free = risk::free_collateral(pool, nav, &marks, cfg);
        require!(value <= free || pool.open_positions == 0, VaultError::UnwindRequired);
    }
    // The pool absorbed the full unwind cost; the exiting slice bears its own.
    let others_share = (stake.unwind_cost as u128)
        .checked_mul(total - shares)
        .and_then(|v| v.checked_div(total))
        .unwrap_or(0) as u64;
    let payout = value.saturating_sub(others_share);

    require!(
        crate::venue::adapter_for(pool).ensure_vault_liquidity(pool, &venue, payout)?,
        VaultError::InsufficientVaultLiquidity
    );
    ctx.accounts.vault.reload()?;
    super::capital::pay_out(pool, &ctx.accounts.vault, &ctx.accounts.common_vault, &ctx.accounts.token_program, shares, payout)?;
    pool.pending_redemption_shares = pool.pending_redemption_shares.saturating_sub(shares);
    stake.shares = stake.shares.checked_sub(shares).ok_or(VaultError::InsufficientShares)?;
    stake.pending_shares = 0;
    stake.unwound = false;
    stake.unwind_cost = 0;

    let cp = &mut ctx.accounts.common_pool;
    cp.accounted_idle = cp.accounted_idle.checked_add(payout).ok_or(VaultError::MathOverflow)?;

    let stake_closed = stake.shares == 0;
    emit!(CommonPullSettled {
        pool: pool.key(),
        shares,
        payout,
        unwind_cost: others_share,
        stake_closed,
        ts: now,
    });
    // Also emit the per-pool settlement so pool NAV/share history stays complete.
    emit!(RedemptionSettled {
        pool: pool.key(),
        investor: cp.key(),
        shares,
        payout,
        unwind_cost: others_share,
        nav_per_share: math::nav_per_share(nav.saturating_sub(payout), pool.total_shares)?,
        ts: now,
    });
    if stake_closed {
        cp.active_stakes = cp.active_stakes.saturating_sub(1);
        let caller = ctx.accounts.caller.to_account_info();
        ctx.accounts.stake.close(caller)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Queue hygiene. Unjam a dead head ticket
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct SkipDeadTicket<'info> {
    /// Permissionless. Normally the keeper.
    pub caller: Signer<'info>,
    #[account(mut, seeds = [COMMON_POOL_SEED], bump = common_pool.bump)]
    pub common_pool: Box<Account<'info, CommonPool>>,
    #[account(mut, seeds = [TICKET_SEED, ticket.trader.as_ref()], bump = ticket.bump, close = rent_to)]
    pub ticket: Box<Account<'info, FundingTicket>>,
    /// CHECK: rent refund target. Whoever paid to create the ticket.
    #[account(mut, address = ticket.payer)]
    pub rent_to: UncheckedAccount<'info>,
    #[account(seeds = [TRADER_SEED, ticket.trader.as_ref()], bump = profile.bump)]
    pub profile: Box<Account<'info, TraderProfile>>,
}

/// The queue is strictly FIFO, so a head ticket whose trader can no longer be
/// funded (they self-created a pool, or fell out of Eligible. A lock, a
/// re-application) would block every trader behind them forever. Anyone may
/// close such a ticket and advance the queue; a still-fundable trader's ticket
/// can never be skipped.
pub fn skip_dead_ticket(ctx: Context<SkipDeadTicket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let cp = &mut ctx.accounts.common_pool;
    let ticket = &ctx.accounts.ticket;
    require!(ticket.ticket == cp.next_to_fund, VaultError::TicketOutOfOrder);
    let p = &ctx.accounts.profile;
    let dead = p.status != TraderStatus::Eligible || p.active_pool != Pubkey::default();
    require!(dead, VaultError::InvalidTraderStatus);
    cp.next_to_fund = cp.next_to_fund.checked_add(1).ok_or(VaultError::MathOverflow)?;
    emit!(QueueTicketSkipped { trader: ticket.trader, ticket: ticket.ticket, ts: now });
    Ok(())
}

// ---------------------------------------------------------------------------
// sweep_forfeited_fee. A dead attempt's fee becomes investor value
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct SweepForfeitedFee<'info> {
    /// Permissionless. Normally the keeper.
    pub caller: Signer<'info>,
    /// CHECK: the trader whose forfeited fee is being swept; the profile is
    /// looked up by seed, so this cannot point at someone else's.
    pub trader: UncheckedAccount<'info>,
    #[account(mut, seeds = [TRADER_SEED, trader.key().as_ref()], bump = profile.bump)]
    pub profile: Box<Account<'info, TraderProfile>>,
    #[account(mut, seeds = [COMMON_POOL_SEED], bump = common_pool.bump)]
    pub common_pool: Box<Account<'info, CommonPool>>,
    #[account(mut, seeds = [COMMON_VAULT_SEED], bump = common_pool.vault_bump)]
    pub common_vault: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, seeds = [TREASURY_VAULT_SEED], bump = treasury.vault_bump)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Hand a forfeited entry/instant fee to the CommonPool. Permissionless.
///
/// The fee sits in treasury-vault custody from `apply_as_trader` onwards,
/// earmarked to become the trader's first-loss seed when they are funded. When
/// the attempt ends without funding. A failed trial (section 5.2) or a breach lock.
/// It is forfeit, and this is where it goes: into `accounted_idle`, with **no
/// shares minted against it**, so CommonPool NAV/share rises and the gain
/// accrues to the investors who were funding traders while that attempt ran.
///
/// That is the same answer `reap_pool` gives for a dead pool's remainder, and
/// for the same reason: the investors carried the risk the fee was charged
/// against, so the fee is theirs rather than the platform's. It is also what
/// makes the custody invariant hold. Treasury vault above
/// `revenue + bounty_reserve` is exactly the sum of held fees, and without a
/// path out, a forfeited one stayed there unowned and unreachable forever,
/// where `activate_pool` and `fund_next_in_queue` would have counted it as
/// spare headroom for some other trader's cushion.
///
/// The exception, exactly as in `reap_pool`: a CommonPool with no shares
/// outstanding has nobody to credit, and value with no shares behind it is a
/// gift to whoever deposits next. That falls back to treasury revenue.
pub fn sweep_forfeited_fee(ctx: Context<SweepForfeitedFee>) -> Result<()> {
    require!(!ctx.accounts.config.paused, VaultError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let p = &mut ctx.accounts.profile;

    // Only a terminal status. `fee_paid` is swept alongside `fee_forfeited`
    // because in both of these states it can never seed a pool, and that is
    // also what reaches a profile whose failure predates `fee_forfeited`.
    require!(
        matches!(p.status, TraderStatus::Failed | TraderStatus::Frozen),
        VaultError::FeeNotForfeited
    );
    require!(p.active_pool == Pubkey::default(), VaultError::PoolAlreadyExists);
    let owed = p.fee_forfeited.saturating_add(p.fee_paid);
    require!(owed > 0, VaultError::FeeNotForfeited);

    // Capped by what the vault holds beyond the treasury's own accounted funds:
    // held fees are exactly that surplus, so this can never reach revenue or
    // the ring-fenced bounty reserve even if a profile's figure is stale.
    let t = &ctx.accounts.treasury;
    let unaccounted = ctx
        .accounts
        .treasury_vault
        .amount
        .saturating_sub(t.revenue.saturating_add(t.bounty_reserve));
    let amount = owed.min(unaccounted);
    require!(amount > 0, VaultError::NothingToClaim);

    let to_common = if ctx.accounts.common_pool.total_shares > 0 { amount } else { 0 };
    let to_treasury = amount - to_common;

    if to_common > 0 {
        super::common::transfer_from_treasury(
            &ctx.accounts.treasury,
            &ctx.accounts.treasury_vault,
            &ctx.accounts.common_vault,
            &ctx.accounts.token_program,
            to_common,
        )?;
        let cp = &mut ctx.accounts.common_pool;
        // Accounted, not donated: `common_nav` reads this figure and never the
        // raw vault balance, so the transfer only becomes value here.
        cp.accounted_idle = cp.accounted_idle.checked_add(to_common).ok_or(VaultError::MathOverflow)?;
    }
    if to_treasury > 0 {
        // Already in the treasury vault. It just stops being held in custody
        // and starts being the platform's. No transfer.
        let t = &mut ctx.accounts.treasury;
        t.revenue = t.revenue.saturating_add(to_treasury);
    }

    // Drain `fee_paid` first, then the forfeited bucket. A short vault leaves
    // the remainder on the profile for a later call rather than losing it.
    let mut rest = amount;
    let from_paid = p.fee_paid.min(rest);
    p.fee_paid -= from_paid;
    rest -= from_paid;
    p.fee_forfeited = p.fee_forfeited.saturating_sub(rest);

    emit!(ForfeitedFeeSwept {
        trader: p.wallet,
        caller: ctx.accounts.caller.key(),
        to_common,
        to_treasury,
        remaining: p.fee_paid.saturating_add(p.fee_forfeited),
        ts: now,
    });
    Ok(())
}
