//! Session keys: one wallet signature authorises a browser keypair to sign
//! trade instructions for up to `MAX_SESSION_SECS`; revocable any time.
use crate::constants::*;
use crate::errors::VaultError;
use crate::events::SessionKeySet;
use crate::state::*;
use anchor_lang::prelude::*;

/// Hard cap on a session's lifetime (24 h).
pub const MAX_SESSION_SECS: i64 = 24 * 60 * 60;

#[derive(Accounts)]
pub struct SetSessionKey<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(seeds = [TRADER_SEED, trader.key().as_ref()], bump = profile.bump, constraint = profile.wallet == trader.key())]
    pub profile: Account<'info, TraderProfile>,
    #[account(
        init_if_needed, payer = trader, space = 8 + SessionKey::INIT_SPACE,
        seeds = [SESSION_SEED, trader.key().as_ref()], bump,
    )]
    pub session: Account<'info, SessionKey>,
    pub system_program: Program<'info, System>,
}

/// Authorise `key` until `now + ttl_secs` (≤ 24 h). Replaces any existing session.
pub fn set_session_key(ctx: Context<SetSessionKey>, key: Pubkey, ttl_secs: i64) -> Result<()> {
    require!(ttl_secs > 0 && ttl_secs <= MAX_SESSION_SECS, VaultError::InvalidArgument);
    require!(key != Pubkey::default() && key != ctx.accounts.trader.key(), VaultError::InvalidArgument);
    let now = Clock::get()?.unix_timestamp;
    let s = &mut ctx.accounts.session;
    s.trader = ctx.accounts.trader.key();
    s.key = key;
    s.expires_at = now + ttl_secs;
    s.created_at = now;
    s.bump = ctx.bumps.session;
    emit!(SessionKeySet { trader: s.trader, key, expires_at: s.expires_at, ts: now });
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeSessionKey<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(mut, seeds = [SESSION_SEED, trader.key().as_ref()], bump = session.bump, has_one = trader, close = trader)]
    pub session: Account<'info, SessionKey>,
}

/// Revoke immediately (closes the account, rent back to the trader).
pub fn revoke_session_key(ctx: Context<RevokeSessionKey>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    emit!(SessionKeySet { trader: ctx.accounts.trader.key(), key: Pubkey::default(), expires_at: 0, ts: now });
    Ok(())
}

/// Shared check for trade instructions: the signer is the trader wallet, or a
/// valid, unexpired session key for that trader.
pub fn check_trade_signer(signer: &Pubkey, trader: &Pubkey, session: Option<&Account<SessionKey>>, now: i64) -> Result<()> {
    if signer == trader {
        return Ok(());
    }
    match session {
        Some(s) if s.is_valid_for(signer, trader, now) => Ok(()),
        _ => err!(VaultError::NotTraderDelegate),
    }
}
