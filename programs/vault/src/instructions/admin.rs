use crate::constants::*;
use crate::errors::VaultError;
use crate::events::{MarketRemoved, PlatformPaused};
use crate::math;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct InitPlatformArgs {
    pub trial_attestor: Pubkey,
    pub price_authority: Pubkey,
    pub entry_fee: u64,
    pub bounty_per_pool: u64,
    pub keeper_bounty: u64,
    pub activation_floor: u64,
    pub min_deposit: u64,
    pub tier_caps: [u64; 3],
    pub vest_days: [u16; 3],
    pub allow_mock_oracle: bool,
    pub min_first_loss_bps: u16,
    pub risk: Option<RiskParams>,
    pub trial: Option<TrialCriteria>,
}

/// Checked against the resulting config on every write, so an update can never
/// leave the platform in a state `init_platform` would have rejected.
fn check_config_invariants(c: &PlatformConfig) -> Result<()> {
    require!(c.tier_caps[0] <= c.tier_caps[1] && c.tier_caps[1] <= c.tier_caps[2], VaultError::InvalidArgument);
    require!(c.bounty_per_pool <= c.entry_fee, VaultError::InvalidArgument);
    // A larger cap would let the guard admit a trade `Pool::positions` cannot hold.
    require!(c.risk.max_positions as usize <= MAX_POSITIONS, VaultError::InvalidArgument);
    // Section 5.2: entry fee ≥ split × max_drawdown × Tier-1 cap.
    let floor = math::bps_of(math::bps_of(c.tier_caps[0], TRADER_SPLIT_BPS)?, c.risk.max_drawdown_bps as u64)?;
    require!(c.entry_fee >= floor, VaultError::InvalidArgument);
    // A vesting period longer than the escrow ring silently corrupts it: the
    // bucket at `today % ESCROW_SLOTS` is still unvested when the slot comes
    // round, so `apply_profit_split` merges the new accrual into the old bucket
    // and the whole lot vests on the OLD unlock day. `effective_vest_days`
    // reads `vest_days[1]` for tier 0, so all three have to be bounded.
    require!(
        c.vest_days.iter().all(|d| (*d as usize) <= ESCROW_SLOTS),
        VaultError::InvalidArgument
    );
    // The loss limits are used as `BPS - bps`, which panics under
    // `overflow-checks` past 10_000. That would brick `place_trade`, `breach`
    // and therefore every liquidation, on a one-digit config typo. Exactly
    // 10_000 is allowed and means "floor at zero", i.e. limit disabled.
    require!(c.risk.daily_loss_bps as u64 <= BPS, VaultError::InvalidArgument);
    require!(c.risk.max_drawdown_bps as u64 <= BPS, VaultError::InvalidArgument);
    // Above 100% of the tier cap the required cushion exceeds the pool itself,
    // so `fund_next_in_queue` could never leave an allocation to mint against.
    require!(c.min_first_loss_bps as u64 <= BPS, VaultError::InvalidArgument);
    // `required_collateral` divides by this; 0 would make every book look
    // infinitely margined and free every redemption.
    require!(c.risk.max_leverage_bps > 0, VaultError::InvalidArgument);
    Ok(())
}

#[derive(Accounts)]
pub struct InitPlatform<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + PlatformConfig::INIT_SPACE, seeds = [PLATFORM_SEED], bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(init, payer = admin, space = 8 + MarketRegistry::INIT_SPACE, seeds = [REGISTRY_SEED], bump)]
    pub registry: Box<Account<'info, MarketRegistry>>,
    #[account(init, payer = admin, space = 8 + Treasury::INIT_SPACE, seeds = [TREASURY_SEED], bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(
        init, payer = admin,
        seeds = [TREASURY_VAULT_SEED], bump,
        token::mint = usdc_mint, token::authority = treasury,
    )]
    pub treasury_vault: Account<'info, TokenAccount>,
    pub usdc_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn init_platform(ctx: Context<InitPlatform>, args: InitPlatformArgs) -> Result<()> {
    let risk = args.risk.unwrap_or_else(RiskParams::mvp_defaults);
    let trial = args.trial.unwrap_or_else(TrialCriteria::mvp_defaults);

    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.usdc_mint = ctx.accounts.usdc_mint.key();
    c.trial_attestor = args.trial_attestor;
    c.price_authority = args.price_authority;
    c.entry_fee = args.entry_fee;
    c.bounty_per_pool = args.bounty_per_pool;
    c.keeper_bounty = args.keeper_bounty;
    c.activation_floor = args.activation_floor;
    c.min_deposit = args.min_deposit;
    c.tier_caps = args.tier_caps;
    c.vest_days = args.vest_days;
    c.risk = risk;
    c.trial = trial;
    c.paused = false;
    c.allow_mock_oracle = args.allow_mock_oracle;
    c.min_first_loss_bps = args.min_first_loss_bps;
    c.bump = ctx.bumps.config;
    c.treasury_bump = ctx.bumps.treasury;
    c.treasury_vault_bump = ctx.bumps.treasury_vault;
    check_config_invariants(c)?;

    let r = &mut ctx.accounts.registry;
    r.count = 0;
    r.bump = ctx.bumps.registry;

    let t = &mut ctx.accounts.treasury;
    t.bump = ctx.bumps.treasury;
    t.vault_bump = ctx.bumps.treasury_vault;
    Ok(())
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [PLATFORM_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, PlatformConfig>>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct UpdateParamsArgs {
    pub risk: Option<RiskParams>,
    pub trial: Option<TrialCriteria>,
    pub tier_caps: Option<[u64; 3]>,
    pub vest_days: Option<[u16; 3]>,
    pub entry_fee: Option<u64>,
    pub activation_floor: Option<u64>,
    pub min_deposit: Option<u64>,
    pub keeper_bounty: Option<u64>,
    pub bounty_per_pool: Option<u64>,
    pub trial_attestor: Option<Pubkey>,
    pub price_authority: Option<Pubkey>,
    pub min_first_loss_bps: Option<u16>,
}

pub fn update_risk_params(ctx: Context<AdminOnly>, args: UpdateParamsArgs) -> Result<()> {
    let c = &mut ctx.accounts.config;
    if let Some(v) = args.risk { c.risk = v; }
    if let Some(v) = args.trial { c.trial = v; }
    if let Some(v) = args.tier_caps { c.tier_caps = v; }
    if let Some(v) = args.vest_days { c.vest_days = v; }
    if let Some(v) = args.entry_fee { c.entry_fee = v; }
    if let Some(v) = args.activation_floor { c.activation_floor = v; }
    if let Some(v) = args.min_deposit { c.min_deposit = v; }
    if let Some(v) = args.keeper_bounty { c.keeper_bounty = v; }
    if let Some(v) = args.bounty_per_pool { c.bounty_per_pool = v; }
    if let Some(v) = args.trial_attestor { c.trial_attestor = v; }
    if let Some(v) = args.price_authority { c.price_authority = v; }
    if let Some(v) = args.min_first_loss_bps { c.min_first_loss_bps = v; }
    check_config_invariants(c)?;
    Ok(())
}

#[derive(Accounts)]
pub struct AdminRegistry<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Box<Account<'info, MarketRegistry>>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct RegisterMarketArgs {
    pub market_id: u16,
    pub symbol: [u8; 8],
    pub oracle: Pubkey,
    pub feed_id: [u8; 32],
    pub max_leverage_bps: u32,
    pub cluster: u8,
    pub venue_market_index: u16,
}

/// Add or replace a market (section 4.9). Replacing keeps the enabled flag.
pub fn register_market(ctx: Context<AdminRegistry>, args: RegisterMarketArgs) -> Result<()> {
    let r = &mut ctx.accounts.registry;
    require!(args.max_leverage_bps > 0, VaultError::InvalidArgument);
    let info = MarketInfo {
        market_id: args.market_id,
        symbol: args.symbol,
        oracle: args.oracle,
        feed_id: args.feed_id,
        max_leverage_bps: args.max_leverage_bps,
        cluster: args.cluster,
        enabled: true,
        venue_market_index: args.venue_market_index,
    };
    if let Some(m) = r.find_mut(args.market_id) {
        let enabled = m.enabled;
        *m = info;
        m.enabled = enabled;
        return Ok(());
    }
    require!((r.count as usize) < MAX_MARKETS, VaultError::RegistryFull);
    let i = r.count as usize;
    r.markets[i] = info;
    r.count += 1;
    Ok(())
}

/// Disabling blocks new positions but never closing (section 4.9). Closes skip this flag.
/// Admin-only. Drops a market from the registry entirely.
///
/// Needed because nothing else can shrink it: `register_market` replaces by id
/// or appends, and `count` only ever grows. A retired market therefore stayed
/// forever, and a registered market is never inert. It keeps a feed id that
/// goes into the indexer's Hermes batch (where one unpermitted id 403s the
/// whole request), an oracle account nobody feeds that reads as a real price of
/// zero, and a slot in the count the UI reports.
///
/// Order is not load-bearing anywhere: `find` matches on `market_id`, positions
/// store `market_id`, and `venue_market_index` rides on the entry itself, so
/// this swaps the last entry into the hole rather than shifting, and clears the
/// vacated slot so no stale bytes sit past `count`.
///
/// **The market must be disabled first.** Every pool holding a position
/// resolves its market through `registry.find`, and a miss is not a soft
/// failure. `mark_positions` returns MarketNotFound, which makes that pool
/// impossible to mark, trade, unwind OR redeem from until the market is put
/// back. Disabling stops new positions; the caller is responsible for
/// confirming the open ones are closed, which `scripts/remove-market.ts`
/// checks across every pool before it will send this.
pub fn remove_market(ctx: Context<AdminRegistry>, market_id: u16) -> Result<()> {
    let r = &mut ctx.accounts.registry;
    let n = r.count as usize;
    let i = r.markets[..n]
        .iter()
        .position(|m| m.market_id == market_id)
        .ok_or(VaultError::MarketNotFound)?;
    require!(!r.markets[i].enabled, VaultError::MarketStillEnabled);
    let symbol = r.markets[i].symbol;
    r.markets[i] = r.markets[n - 1];
    r.markets[n - 1] = MarketInfo::default();
    r.count -= 1;
    emit!(MarketRemoved { market_id, symbol, remaining: r.count });
    Ok(())
}

pub fn set_market_enabled(ctx: Context<AdminRegistry>, market_id: u16, enabled: bool) -> Result<()> {
    let r = &mut ctx.accounts.registry;
    let m = r.find_mut(market_id).ok_or(VaultError::MarketNotFound)?;
    m.enabled = enabled;
    Ok(())
}

pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    emit!(PlatformPaused { paused, ts: Clock::get()?.unix_timestamp });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, seeds = [TREASURY_VAULT_SEED], bump = treasury.vault_bump)]
    pub treasury_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = destination.mint == config.usdc_mint)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// Withdraw revenue only. The bounty reserve is ring-fenced (section 3.2, section 4.10).
pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
    let t = &mut ctx.accounts.treasury;
    require!(amount <= t.revenue, VaultError::BountyReserveProtected);
    require!(
        ctx.accounts.treasury_vault.amount.saturating_sub(amount) >= t.bounty_reserve,
        VaultError::BountyReserveProtected
    );
    t.revenue -= amount;
    super::common::transfer_from_treasury(
        t,
        &ctx.accounts.treasury_vault,
        &ctx.accounts.destination,
        &ctx.accounts.token_program,
        amount,
    )
}

#[derive(Accounts)]
pub struct SweepDust<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [POOL_VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, seeds = [TREASURY_VAULT_SEED], bump = treasury.vault_bump)]
    pub treasury_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/// NAV reads accounted balance only; anything above it (direct transfers,
/// mock-venue fees) is swept to the treasury (section 5.1, section 4.10).
pub fn sweep_dust(ctx: Context<SweepDust>) -> Result<()> {
    let dust = ctx.accounts.vault.amount.saturating_sub(ctx.accounts.pool.accounted_usdc);
    if dust == 0 {
        return Ok(());
    }
    let index = ctx.accounts.pool.index.to_le_bytes();
    let seeds: &[&[u8]] = &[POOL_SEED, ctx.accounts.pool.trader.as_ref(), &index, &[ctx.accounts.pool.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.treasury_vault.to_account_info(),
                authority: ctx.accounts.pool.to_account_info(),
            },
            &[seeds],
        ),
        dust,
    )?;
    let t = &mut ctx.accounts.treasury;
    t.dust_swept = t.dust_swept.saturating_add(dust);
    t.revenue = t.revenue.saturating_add(dust);
    Ok(())
}

#[derive(Accounts)]
pub struct MigrateAccount<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump, has_one = admin @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, PlatformConfig>>,
    /// CHECK: owner + discriminator verified in the handler; only grown, never shrunk or rewritten.
    #[account(mut)]
    pub target: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// One-time layout migration for accounts created before an upgrade that
/// appended fields (Pool.ends_at, Pool.first_loss_seed, TraderProfile.instant_cap,
/// TraderProfile.fee_forfeited, …). Grows the account to the current size,
/// zero-filling the new tail. Admin-only; a no-op error if the account is
/// already current.
///
/// Zero is NOT the "feature off" value for every appended field. Three of them
/// carry meaning at zero, and two of those break accounting silently:
///
/// * `Pool.investor_principal`, and `Pool.first_loss_seed`, which
///   `realloc(zero_init)` clears alongside it on any pool old enough to predate
///   both. Zeroing them breaks first-loss ordering: with both at 0 investor NAV
///   reads as the whole equity and exits are over-paid; with a seed but no
///   principal the cushion is never spent and exits are under-paid. No
///   instruction repairs either, so a Pool with shares outstanding is REFUSED
///   below rather than warned about.
/// * `Pool.venue_accounted_quote` on a Drift pool that already holds venue
///   collateral. A zero baseline makes the next `sync_venue` read the whole
///   deposit as profit. See the note on that field before migrating one.
pub fn migrate_account(ctx: Context<MigrateAccount>) -> Result<()> {
    let target = &ctx.accounts.target;
    require!(target.owner == ctx.program_id, VaultError::Unauthorized);
    let old_len = target.data_len();
    require!(old_len >= 8, VaultError::InvalidArgument);
    let disc: [u8; 8] = target.try_borrow_data()?[0..8].try_into().unwrap();
    let new_len = if disc == Pool::DISCRIMINATOR {
        8 + Pool::INIT_SPACE
    } else if disc == TraderProfile::DISCRIMINATOR {
        8 + TraderProfile::INIT_SPACE
    } else if disc == PlatformConfig::DISCRIMINATOR {
        8 + PlatformConfig::INIT_SPACE
    } else {
        return err!(VaultError::InvalidArgument);
    };
    require!(old_len < new_len, VaultError::InvalidArgument);
    let need = Rent::get()?.minimum_balance(new_len).saturating_sub(target.lamports());
    if need > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer { from: ctx.accounts.admin.to_account_info(), to: target.to_account_info() },
            ),
            need,
        )?;
    }
    target.to_account_info().realloc(new_len, true)?;

    // Checked AFTER the realloc, which is safe: `total_shares` is a
    // pre-existing field, so the zero-fill does not touch it, and a failing
    // `require!` reverts the whole transaction. Realloc included.
    //
    // A Pool with investors is the case the zero-fill breaks. `first_loss_seed`
    // and `investor_principal` land at 0 together on an old enough pool, which
    // erases the cushion and over-pays every exit; and there is no instruction
    // that writes either back. Same invariant, and the same error, as
    // `reap_pool` (pool.rs). A pool nobody holds shares in has nothing to
    // corrupt.
    if disc == Pool::DISCRIMINATOR {
        let data = target.try_borrow_data()?;
        let pool = Pool::try_deserialize(&mut &data[..])?;
        require!(
            pool.total_shares <= DEAD_SHARES && pool.pending_redemption_shares == 0,
            VaultError::SharesOutstanding
        );
    }
    Ok(())
}
