//! Shared helpers: PDA-signed token transfers, bounty payment, lock routine.
use crate::constants::{POOL_SEED, TREASURY_SEED};
use crate::errors::VaultError;
use crate::events::{BountyPaid, PoolLocked};
use crate::risk;
use crate::state::{lock_reason, Pool, PoolStatus, TraderProfile, TraderStatus, Treasury};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

/// Transfer USDC out of a pool vault, signed by the pool PDA.
pub fn transfer_from_pool<'info>(
    pool: &Account<'info, Pool>,
    vault: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let index = pool.index.to_le_bytes();
    let seeds: &[&[u8]] = &[POOL_SEED, pool.trader.as_ref(), &index, &[pool.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: vault.to_account_info(),
                to: to.to_account_info(),
                authority: pool.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

/// Transfer USDC out of the treasury vault, signed by the treasury PDA.
pub fn transfer_from_treasury<'info>(
    treasury: &Account<'info, Treasury>,
    treasury_vault: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[TREASURY_SEED, &[treasury.bump]];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: treasury_vault.to_account_info(),
                to: to.to_account_info(),
                authority: treasury.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )
}

/// Pay the keeper bounty from the ring-fenced reserve. Never fails the
/// parent instruction if the reserve is empty. The lock must still happen.
/// Pay a liquidation bounty, charged to the pool's own first-loss seed before
/// the communal reserve touches it.
///
/// This is the economically right source: the trader caused the liquidation,
/// and the cushion exists precisely to absorb its cost. It also makes the
/// bounty self-funding. A bigger pool pays a bigger bounty out of the bigger
/// cushion it was required to post. Instead of draining a shared reserve that
/// a single Tier-3 liquidation could exhaust.
///
/// The treasury is the backstop for a pool whose cushion is already spent
/// (a deep breach), so a bot is never left unpaid for work it did.
/// Returns (paid_from_pool, paid_from_treasury).
#[allow(clippy::too_many_arguments)]
pub fn pay_liquidation_bounty<'info>(
    pool: &mut Account<'info, Pool>,
    vault: &Account<'info, TokenAccount>,
    treasury: &mut Account<'info, Treasury>,
    treasury_vault: &Account<'info, TokenAccount>,
    caller_usdc: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    caller: Pubkey,
    amount: u64,
) -> Result<(u64, u64)> {
    let from_pool = amount
        .min(pool.first_loss_seed)
        .min(pool.accounted_usdc)
        .min(vault.amount);
    let pool_key = pool.key();
    if from_pool > 0 {
        transfer_from_pool(pool, vault, caller_usdc, token_program, from_pool)?;
        pool.accounted_usdc -= from_pool;
        pool.first_loss_seed -= from_pool;
        emit!(BountyPaid { pool: pool_key, caller, amount: from_pool });
    }
    let rest = amount - from_pool;
    let from_treasury = if rest > 0 {
        pay_bounty(treasury, treasury_vault, caller_usdc, token_program, pool_key, caller, rest)?
    } else {
        0
    };
    Ok((from_pool, from_treasury))
}

pub fn pay_bounty<'info>(
    treasury: &mut Account<'info, Treasury>,
    treasury_vault: &Account<'info, TokenAccount>,
    caller_usdc: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    pool: Pubkey,
    caller: Pubkey,
    amount: u64,
) -> Result<u64> {
    let pay = amount.min(treasury.bounty_reserve).min(treasury_vault.amount);
    if pay == 0 {
        return Ok(0);
    }
    transfer_from_treasury(treasury, treasury_vault, caller_usdc, token_program, pay)?;
    treasury.bounty_reserve -= pay;
    treasury.bounties_paid = treasury.bounties_paid.saturating_add(pay);
    emit!(BountyPaid { pool, caller, amount: pay });
    Ok(pay)
}

/// Lock a pool on a risk breach: halt trading, return unvested escrow to the
/// pool, freeze the trader and reset their tier (section 4.8).
pub fn lock_on_breach(
    pool_key: Pubkey,
    pool: &mut Pool,
    profile: &mut TraderProfile,
    reason: u8,
    nav: u64,
    caller: Pubkey,
    now: i64,
    cooldown_secs: u32,
) -> Result<()> {
    require!(pool.status == PoolStatus::Live, VaultError::InvalidPoolStatus);
    require!(reason == lock_reason::DAILY_LOSS || reason == lock_reason::DRAWDOWN, VaultError::NoBreach);
    pool.status = PoolStatus::Locked;
    pool.lock_reason = reason;
    pool.locked_at = now;
    let returned = risk::return_unvested(pool);

    profile.status = TraderStatus::Frozen;
    profile.pools_locked = profile.pools_locked.saturating_add(1);
    // Normally zero. The fee was injected as first-loss seed when the pool was
    // funded. A residue survives only when the treasury could not cover the
    // whole injection; it can never seed anything now, so forfeit it to the
    // CommonPool along with the escrow.
    super::trader::forfeit_held_fee(profile);
    profile.tier = 0;
    profile.live_days_at_tier = 0;
    profile.active_pool = Pubkey::default();
    // Cooldown-after-lock (Vault Ledger section 5 "Risk enforcement"): without this a
    // breach-locked trader could re-apply (including instant funding) with
    // zero wait.
    profile.cooldown_until = now + cooldown_secs as i64;

    emit!(PoolLocked {
        pool: pool_key,
        trader: pool.trader,
        reason,
        nav,
        escrow_returned: returned,
        caller,
        ts: now,
    });
    Ok(())
}
