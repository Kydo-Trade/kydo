//! Trader lifecycle (section 4.1, section 4.2): apply → 30-day simulated trial with daily
//! merkle attestation → finalize against section 5.4 criteria.
use crate::constants::*;
use crate::errors::VaultError;
use crate::events::*;
use crate::math;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct ApplyAsTrader<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(
        init_if_needed, payer = trader, space = 8 + TraderProfile::INIT_SPACE,
        seeds = [TRADER_SEED, trader.key().as_ref()], bump,
    )]
    pub profile: Account<'info, TraderProfile>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(mut, seeds = [TREASURY_SEED], bump = treasury.bump)]
    pub treasury: Account<'info, Treasury>,
    #[account(mut, seeds = [TREASURY_VAULT_SEED], bump = treasury.vault_bump)]
    pub treasury_vault: Account<'info, TokenAccount>,
    #[account(mut, constraint = trader_usdc.owner == trader.key(), constraint = trader_usdc.mint == config.usdc_mint)]
    pub trader_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// `instant_cap`. 0 for the normal trial path; otherwise the funding cap the
/// trader is buying (activation floor ≤ cap ≤ Tier 1 cap),
/// fee = max(1.5 × entry_fee, 20% of cap).
pub fn apply_as_trader(ctx: Context<ApplyAsTrader>, instant_cap: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, VaultError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let p = &mut ctx.accounts.profile;

    if p.wallet == Pubkey::default() {
        p.wallet = ctx.accounts.trader.key();
        p.bump = ctx.bumps.profile;
        p.status = TraderStatus::Applied;
    } else {
        // Re-entry after a failed trial or a lock. Never while a trial or pool is active.
        require!(
            matches!(p.status, TraderStatus::Failed | TraderStatus::Frozen),
            VaultError::InvalidTraderStatus
        );
        require!(p.active_pool == Pubkey::default(), VaultError::PoolAlreadyExists);
        require!(now >= p.cooldown_until, VaultError::InCooldown);
    }

    // Fee → treasury-vault CUSTODY, atomically (Vault Ledger section 2/section 6): it is not
    // revenue and it never refunds. At funding, `fund_next_in_queue` splits it
    // three ways: `min_first_loss_bps` of the pool cap becomes no-shares
    // first-loss seed inside the trader's own pool, and whatever is left over
    // is the platform's. Half to the keeper bounty reserve, half to revenue.
    // Win or lose, the trader never gets any of it back. INSTANT funding skips the
    // trial: the trader chooses the cap and the fee scales with it.
    // Economics replace selection (20% of cap ≥ the section 5.2 floor of
    // split × maxDD = 8%), with a 1.5× floor so speed always costs a premium.
    // Instant funding is one product at the Tier-1 cap, not a cap the trader
    // picks. It read as a choice and was not: the fee is
    // `max(1.5 x entry_fee, 20% of cap)`, and since the cap can never exceed
    // Tier 1, 20% of it never reaches the floor, so every instant trader paid
    // the same 1.5x floor whatever they chose, and a smaller cap bought strictly
    // less capital for the same money. At the activation floor that was 120% of
    // the pool in fees. Pin it, and the price is honest again.
    let instant = instant_cap > 0;
    if instant {
        require!(instant_cap == cfg.tier_cap(1), VaultError::InvalidArgument);
    }
    let fee = if instant {
        (cfg.entry_fee.saturating_mul(INSTANT_FEE_FLOOR_BPS) / 10_000).max(instant_cap.saturating_mul(INSTANT_FEE_BPS) / 10_000)
    } else {
        cfg.entry_fee
    };
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.trader_usdc.to_account_info(),
                to: ctx.accounts.treasury_vault.to_account_info(),
                authority: ctx.accounts.trader.to_account_info(),
            },
        ),
        fee,
    )?;
    // Held in custody (tracked on the profile), not booked as revenue or
    // bounty reserve. The vault balance above (revenue + bounty_reserve) is
    // exactly the sum of `fee_paid + fee_forfeited` over every profile.
    // Overwriting is safe: every path that ends an attempt (`fail_trial`,
    // `finalize_trial`, `lock_on_breach`) moves the old fee to `fee_forfeited`
    // first, so nothing is dropped here.
    p.fee_paid = fee;
    p.attempts = p.attempts.saturating_add(1);
    p.trial_root = [0u8; 32];
    p.trial_days_committed = 0;
    p.tier = 0; // tier 0 + Eligible = instant (finalize_trial always sets tier 1)
    p.live_days_at_tier = 0;
    p.instant_cap = instant_cap;
    if instant {
        p.status = TraderStatus::Eligible;
        p.trial_start_ts = 0;
    } else {
        p.status = TraderStatus::Trial;
        p.trial_start_ts = now;
    }

    emit!(TraderApplied {
        trader: p.wallet,
        attempt: p.attempts,
        fee,
        trial_start_ts: p.trial_start_ts,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CommitTrialRoot<'info> {
    pub trader: Signer<'info>,
    #[account(mut, seeds = [TRADER_SEED, trader.key().as_ref()], bump = profile.bump, constraint = profile.wallet == trader.key())]
    pub profile: Account<'info, TraderProfile>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump)]
    pub config: Box<Account<'info, PlatformConfig>>,
}

fn elapsed_trial_days(cfg: &PlatformConfig, start: i64, now: i64) -> u16 {
    let secs = cfg.trial.day_secs.max(1) as i64;
    ((now - start).max(0) / secs) as u16
}

/// The fee paid for an attempt that is now over. It never refunds (section 5.2), and
/// it is not the platform's either. It moves to `fee_forfeited`, from where
/// `sweep_forfeited_fee` hands it to the CommonPool as investor value, the same
/// way `reap_pool` returns a dead pool's remainder. Pure state: the USDC is
/// already in the treasury vault and does not move until the sweep.
pub(crate) fn forfeit_held_fee(p: &mut TraderProfile) {
    p.fee_forfeited = p.fee_forfeited.saturating_add(p.fee_paid);
    p.fee_paid = 0;
}

fn fail_trial(p: &mut TraderProfile, cfg: &PlatformConfig, now: i64, reason: u8) {
    p.status = TraderStatus::Failed;
    p.trials_failed = p.trials_failed.saturating_add(1);
    p.cooldown_until = now + cfg.risk.cooldown_secs as i64;
    forfeit_held_fee(p);
    emit!(TrialFinalized {
        trader: p.wallet,
        passed: false,
        final_equity: 0,
        max_drawdown_bps: 0,
        trades: 0,
        active_days: 0,
        fail_reason: reason,
    });
}

pub mod fail_reason {
    pub const NONE: u8 = 0;
    pub const MISSED_DAY: u8 = 1;
    pub const PROFIT_TARGET: u8 = 2;
    pub const DRAWDOWN: u8 = 3;
    pub const DAILY_LOSS: u8 = 4;
    pub const ACTIVE_DAYS: u8 = 5;
    pub const MIN_TRADES: u8 = 6;
    pub const CONSISTENCY: u8 = 7;
}

/// Commit the merkle root of trial day `day` (0-based). Days are sequential;
/// a day can be committed once it has ended and must be committed within the
/// grace window, otherwise the trial is invalidated (section 4.2).
pub fn commit_trial_root(ctx: Context<CommitTrialRoot>, day: u16, root: [u8; 32]) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;
    let p = &mut ctx.accounts.profile;
    require!(p.status == TraderStatus::Trial, VaultError::InvalidTraderStatus);
    require!(day == p.trial_days_committed && day < TRIAL_DAYS, VaultError::TrialDayOutOfOrder);

    let elapsed = elapsed_trial_days(cfg, p.trial_start_ts, now);
    require!(elapsed >= day + 1, VaultError::TrialDayNotComplete);
    if elapsed > day + 1 + cfg.trial.commit_grace_days {
        fail_trial(p, cfg, now, fail_reason::MISSED_DAY);
        return Ok(());
    }
    p.trial_root = root;
    p.trial_days_committed = day + 1;
    emit!(TrialRootCommitted { trader: p.wallet, day, root, ts: now });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct TrialMetrics {
    pub final_equity: u64,
    pub max_drawdown_bps: u16,
    pub max_daily_loss_bps: u16,
    pub active_days: u16,
    pub trades: u32,
    /// Largest single day's profit as a share of total profit, bps.
    pub max_day_profit_share_bps: u16,
}

#[derive(Accounts)]
pub struct FinalizeTrial<'info> {
    pub attestor: Signer<'info>,
    /// CHECK: profile is looked up by wallet seed
    pub trader: UncheckedAccount<'info>,
    #[account(mut, seeds = [TRADER_SEED, trader.key().as_ref()], bump = profile.bump)]
    pub profile: Account<'info, TraderProfile>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump, constraint = config.trial_attestor == attestor.key() @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, PlatformConfig>>,
}

/// Evaluate section 5.4 against metrics attested by the trial engine.
pub fn finalize_trial(ctx: Context<FinalizeTrial>, m: TrialMetrics) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let now = Clock::get()?.unix_timestamp;
    let p = &mut ctx.accounts.profile;
    require!(p.status == TraderStatus::Trial, VaultError::InvalidTraderStatus);

    // A missed day invalidates regardless of metrics. A grace window of a year
    // or more (demo deployments set commit_grace_days = 1000; production keeps
    // it at 1) marks a relaxed deployment: the attestor's signed metrics stand
    // in for the day roots, so finalize may run before the 30 days have
    // elapsed. That is what makes the one-button dev bypass work on a
    // real-time clock.
    let relaxed = cfg.trial.commit_grace_days >= RELAXED_GRACE_DAYS;
    let elapsed = elapsed_trial_days(cfg, p.trial_start_ts, now);
    if !relaxed && p.trial_days_committed < TRIAL_DAYS {
        if elapsed > p.trial_days_committed + 1 + cfg.trial.commit_grace_days {
            fail_trial(p, cfg, now, fail_reason::MISSED_DAY);
            return Ok(());
        }
        return err!(VaultError::TrialNotComplete);
    }

    let t = &cfg.trial;
    let target = math::bps_of(t.starting_balance, BPS + t.profit_target_bps as u64)?;
    // profit_target_bps == 0 means "no profit requirement": fees make an exactly-flat
    // finish impossible, so a zero target would otherwise still fail breakeven traders.
    let reason = if t.profit_target_bps > 0 && m.final_equity < target {
        fail_reason::PROFIT_TARGET
    } else if m.max_drawdown_bps > t.max_drawdown_bps {
        fail_reason::DRAWDOWN
    } else if m.max_daily_loss_bps > t.daily_loss_bps {
        fail_reason::DAILY_LOSS
    } else if m.active_days < t.min_active_days {
        fail_reason::ACTIVE_DAYS
    } else if m.trades < t.min_trades {
        fail_reason::MIN_TRADES
    } else if m.max_day_profit_share_bps > t.max_day_profit_share_bps {
        fail_reason::CONSISTENCY
    } else {
        fail_reason::NONE
    };

    if reason == fail_reason::NONE {
        p.status = TraderStatus::Eligible;
        p.tier = 1;
    } else {
        p.status = TraderStatus::Failed;
        p.trials_failed = p.trials_failed.saturating_add(1);
        p.cooldown_until = now + cfg.risk.cooldown_secs as i64;
        forfeit_held_fee(p);
    }
    emit!(TrialFinalized {
        trader: p.wallet,
        passed: reason == fail_reason::NONE,
        final_equity: m.final_equity,
        max_drawdown_bps: m.max_drawdown_bps,
        trades: m.trades,
        active_days: m.active_days,
        fail_reason: reason,
    });
    Ok(())
}
