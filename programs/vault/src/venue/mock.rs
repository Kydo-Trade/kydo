//! MockPerps: oracle-priced matching engine that lives entirely on the `Pool`
//! account. Fills cross a fixed half-spread and pay a taker fee; both are
//! realistic enough to make the risk maths exercise the same paths as Drift.
use super::{Fill, MarginHint, Mark, VenueAccounts, VenueAdapter};
use crate::constants::{BPS, MOCK_FEE_BPS, MOCK_SPREAD_BPS};
use crate::errors::VaultError;
use crate::math;
use crate::oracle::OraclePrice;
use crate::state::{side, MarketInfo, MarketRegistry, Pool, Position};
use anchor_lang::prelude::*;

pub struct MockPerps;

impl MockPerps {
    fn fill_price(&self, mark: u64, is_buy: bool) -> u64 {
        let spread = mark * MOCK_SPREAD_BPS / BPS;
        if is_buy {
            mark + spread
        } else {
            mark - spread
        }
    }
}

impl VenueAdapter for MockPerps {
    fn init_sub_account<'info>(
        &self,
        _pool: &mut Pool,
        _accs: &VenueAccounts<'_, 'info>,
        _payer: &AccountInfo<'info>,
        _system_program: &AccountInfo<'info>,
    ) -> Result<()> {
        // The pool account itself is the venue sub-account (set by create_pool).
        Ok(())
    }

    fn sync_positions(
        &self,
        _pool: &mut Pool,
        _accs: &VenueAccounts,
        _registry: &MarketRegistry,
        _now: i64,
    ) -> Result<()> {
        Ok(())
    }

    fn open_position(
        &self,
        pool: &mut Pool,
        _accs: &VenueAccounts,
        market: &MarketInfo,
        side_: u8,
        base_qty: u64,
        limit_px: u64,
        mark: &OraclePrice,
        _margin: MarginHint,
        now: i64,
    ) -> Result<Fill> {
        require!(base_qty > 0, VaultError::SizeTooSmall);
        let is_buy = side_ == side::LONG;
        let px = self.fill_price(mark.price, is_buy);
        if limit_px > 0 {
            // A limit order fills only if the crossing price respects the limit.
            let ok = if is_buy { px <= limit_px } else { px >= limit_px };
            require!(ok, VaultError::LimitNotMet);
        }
        let notional = math::notional(base_qty, px)?;
        let fee = notional * MOCK_FEE_BPS / BPS;

        match pool.find_position(market.market_id) {
            Some(i) => {
                let p = &mut pool.positions[i];
                require!(p.side == side_, VaultError::OppositeSide);
                p.entry_price = math::avg_entry(p.base_qty, p.entry_price, base_qty, px)?;
                p.base_qty = p.base_qty.checked_add(base_qty).ok_or(VaultError::MathOverflow)?;
                // opened_at stays at the original open; min-hold applies from the first fill
            }
            None => {
                let i = pool.free_slot().ok_or(VaultError::TooManyPositions)?;
                pool.positions[i] = Position {
                    market_id: market.market_id,
                    side: side_,
                    cluster: market.cluster,
                    base_qty,
                    entry_price: px,
                    opened_at: now,
                };
            }
        }
        pool.accounted_usdc = pool.accounted_usdc.checked_sub(fee).ok_or(VaultError::MathOverflow)?;
        pool.venue_fees_paid = pool.venue_fees_paid.saturating_add(fee);
        pool.recount_positions();
        Ok(Fill { fill_price: px, base_qty, notional, fee, realized_pnl: 0 })
    }

    fn close_position(
        &self,
        pool: &mut Pool,
        _accs: &VenueAccounts,
        market: &MarketInfo,
        base_qty: u64,
        limit_px: u64,
        mark: &OraclePrice,
        _now: i64,
    ) -> Result<Fill> {
        let i = pool.find_position(market.market_id).ok_or(VaultError::PositionNotFound)?;
        let pos = pool.positions[i];
        let qty = if base_qty == 0 { pos.base_qty } else { base_qty.min(pos.base_qty) };
        require!(qty > 0, VaultError::SizeTooSmall);
        // Closing a long sells; closing a short buys.
        let is_buy = pos.side == side::SHORT;
        let px = self.fill_price(mark.price, is_buy);
        if limit_px > 0 {
            let ok = if is_buy { px <= limit_px } else { px >= limit_px };
            require!(ok, VaultError::LimitNotMet);
        }
        let notional = math::notional(qty, px)?;
        let fee = notional * MOCK_FEE_BPS / BPS;
        let realized = math::pnl(&pos, qty, px)?;

        let p = &mut pool.positions[i];
        p.base_qty -= qty;
        if p.base_qty == 0 {
            *p = Position::default();
        }
        pool.accounted_usdc = math::add_i64(pool.accounted_usdc, realized).saturating_sub(fee);
        pool.venue_fees_paid = pool.venue_fees_paid.saturating_add(fee);
        pool.recount_positions();
        Ok(Fill { fill_price: px, base_qty: qty, notional, fee, realized_pnl: realized })
    }

    /// The mock has no resting-order book, so a stop cannot be parked at the
    /// venue. It is recorded on the pool and enforced only by the entry-time
    /// solvency check, which is the part that needs nothing to be running.
    /// Nothing closes a MockPerps position automatically.
    fn set_stop_order(
        &self,
        _pool: &Pool,
        _accs: &VenueAccounts,
        _market: &MarketInfo,
        _position_side: u8,
        _base_qty: u64,
        _stop_px: u64,
    ) -> Result<()> {
        Ok(())
    }

    fn cancel_stop_orders(&self, _pool: &Pool, _accs: &VenueAccounts, _market_index: Option<u16>) -> Result<()> {
        Ok(())
    }

    fn read_position(&self, pool: &Pool, market_id: u16) -> Option<Position> {
        pool.find_position(market_id).map(|i| pool.positions[i])
    }

    fn observed_realized_basis(&self, _pool: &Pool, _accounts: &[AccountInfo]) -> Result<Option<i64>> {
        Ok(None)
    }

    fn read_account_equity(&self, pool: &Pool, _accounts: &[AccountInfo], marks: &[Mark]) -> Result<i64> {
        let mut total: i64 = 0;
        for p in pool.positions.iter().filter(|p| p.is_open()) {
            let mark = marks
                .iter()
                .find(|m| m.market_id == p.market_id)
                .ok_or(VaultError::OracleMissing)?;
            total = total
                .checked_add(math::pnl(p, p.base_qty, mark.price)?)
                .ok_or(VaultError::MathOverflow)?;
        }
        Ok(total)
    }

    fn ensure_vault_liquidity(&self, _pool: &mut Pool, _accs: &VenueAccounts, _needed: u64) -> Result<bool> {
        // Every accounted dollar already sits in the vault.
        Ok(true)
    }
}
