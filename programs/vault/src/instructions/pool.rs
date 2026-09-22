//! Pool lifecycle (section 4.3, section 5.5): create → activate → (promote)* → close/lock → reap.
use crate::constants::*;
use crate::errors::VaultError;
use crate::events::*;
use crate::math;
use crate::risk;
use crate::state::*;
use crate::venue::{adapter_for, VenueAccounts};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreatePoolArgs {
    pub name: [u8; 32],
    pub mandate: Mandate,
    pub target_size: u64,
    /// sha256 of the strategy description stored off-chain by the indexer.
    pub strategy_hash: [u8; 32],
    pub venue: Venue,
    /// Pool lifetime in platform days (cfg.trial.day_secs each); 0 = open-ended.
    /// Appended last: the pre-duration program deserializes its prefix and ignores it.
    pub duration_days: u16,
}

#[derive(Accounts)]
pub struct CreatePool<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(mut, seeds = [TRADER_SEED, trader.key().as_ref()], bump = profile.bump, constraint = profile.wallet == trader.key())]
    pub profile: Account<'info, TraderProfile>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(
        init, payer = trader, space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, trader.key().as_ref(), &profile.pools_created.to_le_bytes()], bump,
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init, payer = trader,
        seeds = [POOL_VAULT_SEED, pool.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = pool,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut, constraint = trader_usdc.owner == trader.key(), constraint = trader_usdc.mint == config.usdc_mint)]
    pub trader_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    // remaining_accounts (Venue::Drift only): [Drift program, State, User PDA,
    // UserStats PDA, Rent sysvar]. See venue::drift::DriftAdapter::init_sub_account.
}

pub fn create_pool<'info>(ctx: Context<'_, '_, 'info, 'info, CreatePool<'info>>, args: CreatePoolArgs) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, VaultError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let profile = &mut ctx.accounts.profile;
    require!(profile.status == TraderStatus::Eligible, VaultError::NotEligible);
    require!(profile.active_pool == Pubkey::default(), VaultError::PoolAlreadyExists);
    // A passing trial funds Tier 1 only; a voluntary close keeps the earned tier.
    // Tier 0 = INSTANT: the cap is whatever the trader paid for at apply time,
    // carried by the pool's own target_size until first promotion.
    let tier = if profile.tier == 0 { 0 } else { profile.tier.clamp(1, MAX_TIER) };
    let cap = if tier == 0 { profile.instant_cap } else { cfg.tier_cap(tier) };
    require!(args.target_size <= cap, VaultError::ExceedsTierCap);

    // 1 USDC seed against 1e9 dead shares (section 5.1, first-depositor inflation guard).
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.trader_usdc.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            },
        ),
        SEED_DEPOSIT,
    )?;

    let pool = &mut ctx.accounts.pool;
    pool.trader = ctx.accounts.trader.key();
    pool.profile = profile.key();
    pool.index = profile.pools_created;
    pool.mandate = args.mandate;
    pool.status = PoolStatus::Funding;
    pool.lock_reason = lock_reason::NONE;
    pool.venue = args.venue;
    pool.vault = ctx.accounts.vault.key();
    // For the mock the venue sub-account is the pool itself; Drift overwrites
    // this below once its User account exists.
    pool.venue_account = pool.key();
    pool.name = args.name;
    pool.strategy_hash = args.strategy_hash;
    pool.target_size = args.target_size;
    pool.tier = tier;
    pool.tier_start_ts = now;
    pool.accounted_usdc = SEED_DEPOSIT;
    pool.total_shares = DEAD_SHARES;
    // DEAD_SHARES are minted against the seed deposit, so it is principal, not
    // first loss. The cushion arrives separately at activation.
    pool.investor_principal = SEED_DEPOSIT;
    pool.hwm_nps = math::nav_per_share(SEED_DEPOSIT, DEAD_SHARES)?;
    pool.tier_start_nps = pool.hwm_nps;
    pool.peak_nav = SEED_DEPOSIT;
    pool.day_start_nav = SEED_DEPOSIT;
    pool.day_epoch = risk::epoch_day(now, cfg.trial.day_secs);
    pool.created_at = now;
    // One day here is cfg.trial.day_secs. The single platform day clock (demo configs shorten it).
    pool.ends_at = if args.duration_days > 0 { now + (args.duration_days as i64) * (cfg.trial.day_secs as i64) } else { 0 };
    pool.bump = ctx.bumps.pool;
    pool.vault_bump = ctx.bumps.vault;

    // Section 4.3: open the venue sub-account owned by the pool PDA (Drift:
    // initialize_user_stats + initialize_user, signed by the pool PDA, rent
    // paid by the trader). No delegate. See `SET_TRADER_AS_DRIFT_DELEGATE`.
    if args.venue == Venue::Drift {
        let pool_info = pool.to_account_info();
        let venue = VenueAccounts { pool: &pool_info, remaining: ctx.remaining_accounts };
        adapter_for(pool).init_sub_account(
            pool,
            &venue,
            &ctx.accounts.trader.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
        )?;
    }

    profile.pools_created = profile.pools_created.saturating_add(1);
    profile.active_pool = pool.key();
    profile.tier = tier;
    profile.tier_start_ts = now;
    profile.live_days_at_tier = 0;

    emit!(PoolCreated {
        pool: pool.key(),
        trader: pool.trader,
        index: pool.index,
        mandate: args.mandate as u8,
        target_size: args.target_size,
        tier,
        ts: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ActivatePool<'info> {
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    /// The pool's trader profile. Carries the held entry/instant fee.
    #[account(mut, address = pool.profile)]
    pub profile: Box<Account<'info, TraderProfile>>,
    #[account(mut, seeds = [POOL_VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, seeds = [TREASURY_VAULT_SEED], bump = treasury.vault_bump)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Permissionless. Pool goes Live once NAV ≥ activation floor (section 4.4). On the
/// way Live, the trader's held entry/instant fee is injected as no-shares
/// first-loss seed capital. The same treatment `fund_next_in_queue` gives a
/// queue-funded pool (Vault Ledger section 2/section 6), so both paths carry the cushion.
/// The floor is checked BEFORE the injection: investor capital alone must
/// reach it. The trader's own fee cannot buy activation.
pub fn activate_pool(ctx: Context<ActivatePool>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, VaultError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    require!(pool.status == PoolStatus::Funding, VaultError::InvalidPoolStatus);
    require!(pool.ends_at == 0 || now < pool.ends_at, VaultError::PoolExpired);
    let nav = pool.accounted_usdc; // no positions while Funding
    require!(nav >= cfg.activation_floor, VaultError::BelowActivationFloor);

    // Inject the held fee as first-loss seed (no shares minted against it).
    // Capped by treasury funds beyond its own accounted revenue + bounty
    // reserve, so pre-upgrade profiles can't create an accounting deficit.
    let profile = &mut ctx.accounts.profile;
    let t = &ctx.accounts.treasury;
    let unaccounted = ctx.accounts.treasury_vault.amount.saturating_sub(t.revenue.saturating_add(t.bounty_reserve));
    let fee_seed = profile.fee_paid.min(unaccounted);
    if fee_seed > 0 {
        super::common::transfer_from_treasury(
            &ctx.accounts.treasury,
            &ctx.accounts.treasury_vault,
            &ctx.accounts.vault,
            &ctx.accounts.token_program,
            fee_seed,
        )?;
        profile.fee_paid -= fee_seed;
        pool.accounted_usdc = pool.accounted_usdc.checked_add(fee_seed).ok_or(VaultError::MathOverflow)?;
        // "No shares minted against it" is only half the job: the fee has to be
        // recorded as first loss too, or it lands in equity as unattributed
        // value and marks every existing share up by the trader's own cushion.
        pool.first_loss_seed = pool.first_loss_seed.saturating_add(fee_seed);
    }
    // Equity carries the cushion; the share price does not.
    let nav = pool.accounted_usdc;
    let inv_nav = risk::investor_nav(pool, nav);

    pool.status = PoolStatus::Live;
    pool.activated_at = now;
    pool.peak_nav = nav;
    pool.day_start_nav = nav;
    pool.day_epoch = risk::epoch_day(now, cfg.trial.day_secs);
    pool.last_live_day = risk::epoch_day(now, cfg.trial.day_secs);
    pool.tier_start_ts = now;
    pool.tier_start_nps = math::nav_per_share(inv_nav, pool.total_shares)?;
    pool.hwm_nps = pool.hwm_nps.max(pool.tier_start_nps);
    pool.last_mark_ts = now;
    pool.last_mark_nav = nav;
    emit!(PoolActivated { pool: pool.key(), nav, ts: now });
    Ok(())
}

#[derive(Accounts)]
pub struct PromoteTier<'info> {
    /// The pool's trader. Promotion is NOT permissionless: it spends the
    /// trader's own vested escrow, and `escrow_to_first_loss` moves it into
    /// `first_loss_seed`, which no instruction pays back out. Without this
    /// signer anyone could front-run `claim_trader_fees` and convert a
    /// trader's whole claimable balance into cushion they can never withdraw.
    pub trader: Signer<'info>,
    #[account(mut, has_one = profile, has_one = trader)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut)]
    pub profile: Account<'info, TraderProfile>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Box<Account<'info, MarketRegistry>>,
    // remaining_accounts: oracles for every open position
}

/// Trader-signed. Raises the cap on the existing pool in place.
///
/// Section 4.3 describes this as permissionless. It cannot be: the promotion tops the
/// cushion up out of `escrow_to_first_loss`, so a caller who is not the trader
/// is spending the trader's money on a size increase they did not ask for.
pub fn promote_tier<'info>(ctx: Context<'_, '_, 'info, 'info, PromoteTier<'info>>) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, VaultError::Paused);
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    require!(pool.status == PoolStatus::Live, VaultError::InvalidPoolStatus);
    require!(pool.tier < MAX_TIER, VaultError::MaxTier);

    let marks = risk::mark_positions(pool, &ctx.accounts.registry, cfg, ctx.remaining_accounts, &clock, true)?;
    let nav = risk::compute_nav(pool, &marks);
    risk::roll_day(pool, nav, now, cfg.trial.day_secs);
    let nps = risk::mark(pool, nav, now)?;

    require!(pool.live_days_at_tier >= cfg.risk.promotion_days, VaultError::PromotionConditionsNotMet);
    require!(nps > pool.tier_start_nps, VaultError::PromotionConditionsNotMet);

    // A bigger cap needs a bigger cushion in front of it, and the trader funds
    // that out of their own earnings. Never a cash call. This is the fork:
    // claim the profit and stay at this cap, or leave it in and take the size.
    // Escrow moved here stops being withdrawable and starts absorbing losses
    // before investors do.
    let new_cap = cfg.tier_cap(pool.tier + 1);
    let required = math::bps_of(new_cap, cfg.min_first_loss_bps as u64)?;
    // What is *left* of the cushion, not what was posted: a trader who has
    // already spent part of it on losses has to rebuild it before taking size.
    let remaining = risk::remaining_first_loss(pool, nav);
    if remaining < required {
        let short = required - remaining;
        let moved = risk::escrow_to_first_loss(pool, short);
        // Partial mutation is fine: the whole instruction reverts on error.
        require!(moved == short, VaultError::InsufficientFirstLoss);
    }

    let from = pool.tier;
    pool.tier += 1;
    pool.tier_start_ts = now;
    pool.tier_start_nps = nps;
    pool.live_days_at_tier = 0;

    let profile = &mut ctx.accounts.profile;
    profile.tier = pool.tier;
    profile.tier_start_ts = now;
    profile.live_days_at_tier = 0;

    emit!(TierPromoted {
        pool: pool.key(),
        trader: pool.trader,
        from_tier: from,
        to_tier: pool.tier,
        cap: if pool.tier == 0 { pool.target_size } else { cfg.tier_cap(pool.tier) },
        ts: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClosePool<'info> {
    /// The pool's trader, or, once the pool's end date has passed, anyone (keeper included).
    pub trader: Signer<'info>,
    #[account(mut, has_one = profile)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut)]
    pub profile: Account<'info, TraderProfile>,
}

/// Voluntary close. Positions must already be flat. Escrow keeps vesting;
/// investors redeem at NAV. The trader keeps their tier.
pub fn close_pool(ctx: Context<ClosePool>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    let expired = pool.ends_at != 0 && now >= pool.ends_at;
    require!(ctx.accounts.trader.key() == pool.trader || expired, VaultError::NotPoolTrader);
    require!(
        matches!(pool.status, PoolStatus::Funding | PoolStatus::Live),
        VaultError::InvalidPoolStatus
    );
    require!(pool.open_positions == 0, VaultError::PositionsOpen);
    pool.status = PoolStatus::Locked;
    pool.lock_reason = lock_reason::VOLUNTARY;
    pool.locked_at = now;
    let profile = &mut ctx.accounts.profile;
    profile.active_pool = Pubkey::default();
    profile.live_days_at_tier = 0;
    emit!(PoolClosed { pool: pool.key(), trader: pool.trader, ts: now });
    Ok(())
}

#[derive(Accounts)]
pub struct ReapPool<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(mut, close = treasury)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [POOL_VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, seeds = [TREASURY_VAULT_SEED], bump = treasury.vault_bump)]
    pub treasury_vault: Account<'info, TokenAccount>,
    /// Where the remainder goes: back to the investors who funded the pool.
    #[account(mut, seeds = [COMMON_POOL_SEED], bump = common_pool.bump)]
    pub common_pool: Box<Account<'info, CommonPool>>,
    #[account(mut, seeds = [COMMON_VAULT_SEED], bump = common_pool.vault_bump)]
    pub common_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts (Drift pools, optional): the Drift trade block, so the
    // collateral still parked at the venue is swept into the vault first.
}

/// After the last investor exits: return whatever is left in the vault to the
/// CommonPool and reclaim rent (section 4.10, section 6.3).
///
/// What is left is the unspent part of the trader's first-loss seed, plus dust.
/// It is split `REAP_PLATFORM_BPS` to the platform and the rest to the
/// investors: they carried the pool for its whole life and the seed existed to
/// protect them, so most of the part the trader never lost is theirs, and it
/// lands back in the idle balance, lifting NAV/share and funding the next
/// trader in the queue. The platform's half is its cut for carrying the
/// liquidation; its cut of the entry fee was already taken as `surplus` at
/// funding time, and the performance fee comes out separately above.
///
/// Nothing here is taken from money the investors were owed. `settle_common_pull`
/// has already paid the CommonPool its full `investor_nav` and burned its
/// shares, so by the time this runs the residue has no shares against it.
///
/// The exception is a CommonPool with no shares outstanding: there is nobody
/// to return it to, and idle value with no shares behind it is a gift to the
/// next depositor. That case falls back to the treasury in full.
pub fn reap_pool<'info>(ctx: Context<'_, '_, 'info, 'info, ReapPool<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool_info = ctx.accounts.pool.to_account_info();
    let venue = VenueAccounts { pool: &pool_info, remaining: ctx.remaining_accounts };
    {
        let pool = &mut ctx.accounts.pool;
        require!(pool.status == PoolStatus::Locked, VaultError::InvalidPoolStatus);
        require!(pool.open_positions == 0, VaultError::PositionsOpen);
        require!(pool.total_shares <= DEAD_SHARES && pool.pending_redemption_shares == 0, VaultError::SharesOutstanding);

        // A breach lock reaches this point with both escrow balances already
        // zeroed. `return_unvested` takes the vested half too, precisely so a
        // trader below their HWM cannot hold a drained pool open forever.
        //
        // A voluntary close does not call it: there the trader keeps their
        // escrow and can still claim. That is the path that deadlocks. A trader
        // who closes below their high-water mark can never satisfy
        // `claim_trader_fees`' `nps >= hwm_nps`, so neither balance ever reaches
        // zero and the pool can never be reaped, closed, or its rent and residue
        // recovered. By anyone, ever.
        //
        // So fold it, but not on sight. `reap_pool` is permissionless, and
        // folding the moment a pool closes would let any caller sweep escrow the
        // trader is entitled to and about to claim, including buckets that had
        // not yet vested. The window is twice the pool tier's vesting period
        // measured from `locked_at`: one period for every outstanding bucket to
        // mature, and a second, equally long, to call `claim_trader_fees`.
        // Nothing is taken that could not have been collected first. Past that,
        // unclaimed value returns to the investors whose capital carried the
        // pool rather than holding it open indefinitely.
        if pool.escrow_total > 0 || pool.vested_claimable > 0 {
            require!(pool.lock_reason == lock_reason::VOLUNTARY, VaultError::NothingToClaim);
            let cfg = &ctx.accounts.config;
            let vest_secs = (cfg.effective_vest_days(pool.tier) as i64)
                .saturating_mul(cfg.trial.day_secs as i64)
                .saturating_mul(2);
            require!(now >= pool.locked_at.saturating_add(vest_secs), VaultError::ClaimGraceActive);
            risk::return_unvested(pool);
        }
        // Drift: pull whatever settled USDC is left at the venue into the vault
        // (the Drift User itself keeps its rent; it stays owned by the PDA).
        if pool.venue == Venue::Drift && !ctx.remaining_accounts.is_empty() {
            adapter_for(pool).ensure_vault_liquidity(pool, &venue, u64::MAX)?;
            ctx.accounts.vault.reload()?;
        }
    }
    let pool = &ctx.accounts.pool;

    let index = pool.index.to_le_bytes();
    let seeds: &[&[u8]] = &[POOL_SEED, pool.trader.as_ref(), &index, &[pool.bump]];

    // The platform's uncollected performance fee comes out first. It was
    // always excluded from NAV, so it is not investor money and must not be
    // swept into the CommonPool by a reap that happened to run before
    // `collect_platform_fee` did.
    let fee = pool.platform_fee_owed.min(ctx.accounts.vault.amount);
    if fee > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[seeds],
            ),
            fee,
        )?;
        let to_bounty = math::bps_of(fee, PLATFORM_FEE_BOUNTY_BPS)?;
        let t = &mut ctx.accounts.treasury;
        t.bounty_reserve = t.bounty_reserve.saturating_add(to_bounty);
        t.revenue = t.revenue.saturating_add(fee - to_bounty);
    }
    ctx.accounts.vault.reload()?;
    let pool = &ctx.accounts.pool;

    // The remainder. The part of the trader's first-loss seed they never lost,
    // plus dust. Is split `REAP_PLATFORM_BPS` to the platform and the rest to
    // the investors, who carried the pool for its whole life and on whose
    // behalf the seed was posted. The investor half lands in `accounted_idle`
    // against unchanged shares, so it lifts NAV/share for every holder rather
    // than being paid to anyone in particular.
    //
    // Rounding goes to the investors: the platform's cut is rounded down and
    // the remainder is whatever is left, so the two halves always sum to
    // `amount` exactly and no lamport is stranded in a closing vault.
    //
    // The exception is an empty CommonPool. It has no shares to price an inflow
    // against, so value parked in `accounted_idle` would sit unowned until the
    // next deposit and then be handed to whoever happened to be first. There is
    // nobody to return it to, so the whole remainder falls back to the treasury.
    let amount = ctx.accounts.vault.amount;
    let has_investors = ctx.accounts.common_pool.total_shares > 0;
    let to_common = if has_investors {
        amount - math::bps_of(amount, REAP_PLATFORM_BPS)?
    } else {
        0
    };
    let to_treasury = amount - to_common;
    if to_common > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.common_vault.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[seeds],
            ),
            to_common,
        )?;
    }
    if to_treasury > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[seeds],
            ),
            to_treasury,
        )?;
    }
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.treasury.to_account_info(),
            authority: pool.to_account_info(),
        },
        &[seeds],
    ))?;
    // Accounted, not donated: both NAVs read their accounted figure, never the
    // raw vault balance, so a transfer only becomes value here.
    if to_common > 0 {
        let cp = &mut ctx.accounts.common_pool;
        cp.accounted_idle = cp.accounted_idle.checked_add(to_common).ok_or(VaultError::MathOverflow)?;
    }
    if to_treasury > 0 {
        let t = &mut ctx.accounts.treasury;
        // `dust_swept` is the stat for value that fell to the treasury for want
        // of an owner, so only the no-investor fallback counts there. The
        // deliberate platform cut is ordinary revenue and nothing else.
        if !has_investors {
            t.dust_swept = t.dust_swept.saturating_add(to_treasury);
        }
        t.revenue = t.revenue.saturating_add(to_treasury);
    }
    emit!(PoolReaped { pool: pool.key(), platform_fee: fee, to_common, to_treasury, ts: now });
    Ok(())
}

#[derive(Accounts)]
pub struct CollectPlatformFee<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [POOL_VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,
    #[account(mut, seeds = [TREASURY_VAULT_SEED], bump = treasury.vault_bump)]
    pub treasury_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

/// Permissionless sweep of the pool's uncollected 5% platform performance fee
/// (Vault Ledger section 6). NAV is unchanged. The fee was already excluded from it.
/// So no reference-NAV shift. Half of what's collected replenishes the keeper
/// bounty reserve; the rest is withdrawable revenue.
pub fn collect_platform_fee(ctx: Context<CollectPlatformFee>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    let pay = pool.platform_fee_owed.min(pool.accounted_usdc).min(ctx.accounts.vault.amount);
    require!(pay > 0, VaultError::NothingToClaim);

    super::common::transfer_from_pool(pool, &ctx.accounts.vault, &ctx.accounts.treasury_vault, &ctx.accounts.token_program, pay)?;
    pool.accounted_usdc -= pay;
    pool.platform_fee_owed -= pay;

    let to_bounty = math::bps_of(pay, crate::constants::PLATFORM_FEE_BOUNTY_BPS)?;
    let t = &mut ctx.accounts.treasury;
    t.bounty_reserve = t.bounty_reserve.saturating_add(to_bounty);
    t.revenue = t.revenue.saturating_add(pay - to_bounty);
    emit!(PlatformFeeCollected { pool: pool.key(), amount: pay, to_bounty_reserve: to_bounty, ts: now });
    Ok(())
}
