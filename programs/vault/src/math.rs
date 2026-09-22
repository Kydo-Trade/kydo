//! NAV / share arithmetic (section 5.1). Rounding always favours the pool.
use crate::constants::{BPS, QTY_SCALE, SHARE_SCALE};
use crate::errors::VaultError;
use crate::state::{side, Position};
use anchor_lang::prelude::*;

pub fn nav_per_share(nav: u64, total_shares: u128) -> Result<u128> {
    if total_shares == 0 {
        return Ok(0);
    }
    (nav as u128)
        .checked_mul(SHARE_SCALE)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(total_shares)
        .ok_or_else(|| VaultError::MathOverflow.into())
}

/// shares_minted = deposit × total_shares / nav  (first deposit: deposit × 1e12)
pub fn shares_for_deposit(amount: u64, total_shares: u128, nav: u64) -> Result<u128> {
    if total_shares == 0 || nav == 0 {
        return (amount as u128)
            .checked_mul(SHARE_SCALE)
            .ok_or_else(|| VaultError::MathOverflow.into());
    }
    (amount as u128)
        .checked_mul(total_shares)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(nav as u128)
        .ok_or_else(|| VaultError::MathOverflow.into())
}

/// redeem_value = shares × nav / total_shares  (rounded down)
pub fn value_for_shares(shares: u128, total_shares: u128, nav: u64) -> Result<u64> {
    if total_shares == 0 {
        return Ok(0);
    }
    let v = shares
        .checked_mul(nav as u128)
        .ok_or(VaultError::MathOverflow)?
        .checked_div(total_shares)
        .ok_or(VaultError::MathOverflow)?;
    u64::try_from(v).map_err(|_| VaultError::MathOverflow.into())
}

/// Notional value of `base_qty` at `price`, in USDC base units.
pub fn notional(base_qty: u64, price: u64) -> Result<u64> {
    let n = (base_qty as u128)
        .checked_mul(price as u128)
        .ok_or(VaultError::MathOverflow)?
        / QTY_SCALE as u128;
    u64::try_from(n).map_err(|_| VaultError::MathOverflow.into())
}

/// Base quantity that `notional_usd` buys at `price`. Rounded down.
pub fn qty_for_notional(notional_usd: u64, price: u64) -> Result<u64> {
    require!(price > 0, VaultError::OracleInvalid);
    let q = (notional_usd as u128)
        .checked_mul(QTY_SCALE as u128)
        .ok_or(VaultError::MathOverflow)?
        / price as u128;
    u64::try_from(q).map_err(|_| VaultError::MathOverflow.into())
}

/// Signed PnL of a position (or a slice of it) marked at `mark`.
pub fn pnl(pos: &Position, qty: u64, mark: u64) -> Result<i64> {
    let diff = (mark as i128) - (pos.entry_price as i128);
    let raw = diff
        .checked_mul(qty as i128)
        .ok_or(VaultError::MathOverflow)?
        / QTY_SCALE as i128;
    let signed = if pos.side == side::SHORT { -raw } else { raw };
    i64::try_from(signed).map_err(|_| VaultError::MathOverflow.into())
}

pub fn bps_of(amount: u64, bps: u64) -> Result<u64> {
    let v = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(VaultError::MathOverflow)?
        / BPS as u128;
    u64::try_from(v).map_err(|_| VaultError::MathOverflow.into())
}

pub fn add_i64(a: u64, b: i64) -> u64 {
    if b >= 0 {
        a.saturating_add(b as u64)
    } else {
        a.saturating_sub(b.unsigned_abs())
    }
}

/// Volume-weighted average entry for a position increase.
pub fn avg_entry(old_qty: u64, old_px: u64, add_qty: u64, add_px: u64) -> Result<u64> {
    let num = (old_qty as u128)
        .checked_mul(old_px as u128)
        .ok_or(VaultError::MathOverflow)?
        .checked_add((add_qty as u128).checked_mul(add_px as u128).ok_or(VaultError::MathOverflow)?)
        .ok_or(VaultError::MathOverflow)?;
    let den = (old_qty as u128) + (add_qty as u128);
    require!(den > 0, VaultError::InvalidArgument);
    u64::try_from(num / den).map_err(|_| VaultError::MathOverflow.into())
}
