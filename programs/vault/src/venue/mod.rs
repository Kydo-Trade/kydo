//! Venue abstraction (section 3.3). One trait, two implementations in the MVP:
//!  * `MockPerps`. In-program, oracle-priced engine. Deterministic; used for
//!    weeks 1–4 and for every risk test.
//!  * `DriftAdapter`. The live venue: hand-written CPIs into Drift v2, with
//!    the Drift user account owned by the pool PDA and no delegate, so the
//!    pre-trade guard is the only path to an order.
//!
//! Instruction handlers hand the adapter a `VenueAccounts` view (pool PDA +
//! the instruction's remaining accounts). The mock ignores it; Drift finds its
//! accounts in the remaining-accounts block (see `drift::DriftAccounts`).
//!
//! Phoenix Perps is deferred to phase 2 and intentionally absent.
pub mod drift;
pub mod mock;

use crate::oracle::OraclePrice;
use crate::state::{MarketInfo, MarketRegistry, Pool, Position, Venue};
use anchor_lang::prelude::*;

#[derive(Clone, Copy, Debug, Default)]
pub struct Fill {
    pub fill_price: u64,
    pub base_qty: u64,
    /// Notional at fill price.
    pub notional: u64,
    pub fee: u64,
    /// Realized PnL for closes (0 for opens), excluding fee.
    pub realized_pnl: i64,
}

/// Oracle mark for one market. Carries the venue's own market index so an
/// adapter can match venue-side positions without the registry.
#[derive(Clone, Copy, Debug)]
pub struct Mark {
    pub market_id: u16,
    pub venue_market_index: u16,
    /// 1e6-scaled USDC price.
    pub price: u64,
}

/// Accounts a venue may need beyond the `Pool` account itself.
///
/// * `pool`. The pool PDA's `AccountInfo`: the CPI authority / signer.
/// * `remaining`. The instruction's remaining accounts: registry oracles
///   first, then the venue block (Drift: program id marker + fixed accounts +
///   pass-through tail; see `drift::DriftAccounts`).
pub struct VenueAccounts<'a, 'info> {
    pub pool: &'a AccountInfo<'info>,
    pub remaining: &'a [AccountInfo<'info>],
}

/// Collateral hint handed to `open_position` by the guard.
#[derive(Clone, Copy, Debug, Default)]
pub struct MarginHint {
    /// Collateral the venue account must hold after the trade for the
    /// post-trade book at the platform leverage cap (gross / max_leverage).
    pub required_collateral: u64,
    /// Venue equity the guard just read (what `read_account_equity` returned).
    pub venue_equity: i64,
}

pub trait VenueAdapter {
    /// Create the venue sub-account for a freshly created pool (section 4.3).
    /// No-op for the mock. Must set `pool.venue_account`.
    fn init_sub_account<'info>(
        &self,
        pool: &mut Pool,
        accs: &VenueAccounts<'_, 'info>,
        payer: &AccountInfo<'info>,
        system_program: &AccountInfo<'info>,
    ) -> Result<()>;

    /// Reconcile `pool.positions` with the venue's own view so the guard,
    /// cluster maths and keeper NAV never work from a stale mirror. No-op for
    /// the mock (its positions *are* the book).
    fn sync_positions(
        &self,
        pool: &mut Pool,
        accs: &VenueAccounts,
        registry: &MarketRegistry,
        now: i64,
    ) -> Result<()>;

    fn open_position(
        &self,
        pool: &mut Pool,
        accs: &VenueAccounts,
        market: &MarketInfo,
        side: u8,
        base_qty: u64,
        limit_px: u64,
        mark: &OraclePrice,
        margin: MarginHint,
        now: i64,
    ) -> Result<Fill>;

    /// `base_qty == 0` closes the whole position.
    fn close_position(
        &self,
        pool: &mut Pool,
        accs: &VenueAccounts,
        market: &MarketInfo,
        base_qty: u64,
        limit_px: u64,
        mark: &OraclePrice,
        now: i64,
    ) -> Result<Fill>;

    /// Rest a reduce-only stop for `market` at `stop_px`, replacing any the
    /// venue already holds. `position_side` is the side being protected, so the
    /// order is placed on the opposite one. Errors propagate: a trade whose
    /// stop cannot be placed must not exist, which is what makes an unprotected
    /// position structurally impossible on a venue that supports triggers.
    fn set_stop_order(
        &self,
        pool: &Pool,
        accs: &VenueAccounts,
        market: &MarketInfo,
        position_side: u8,
        base_qty: u64,
        stop_px: u64,
    ) -> Result<()>;

    /// Cancel resting stops. One market, or every one when `market_index` is
    /// `None`. Called wherever a position can go away, so a stop never outlives
    /// the position it protects.
    fn cancel_stop_orders(&self, pool: &Pool, accs: &VenueAccounts, market_index: Option<u16>) -> Result<()>;

    fn read_position(&self, pool: &Pool, market_id: u16) -> Option<Position>;

    /// The venue quantity `Pool::venue_accounted_quote` is a baseline against:
    /// net deposits plus every realization the venue has produced, whether or
    /// not it has been settled. `sync_venue` splits the difference between this
    /// and the stored baseline, which is how a close the program did not
    /// perform (a stop filled by the venue, a liquidation, an ADL) still
    /// reaches the trader's escrow.
    ///
    /// `None` for a venue with no separate account. The mock realizes straight
    /// into `accounted_usdc` through `close_position`, which already splits.
    fn observed_realized_basis(&self, pool: &Pool, accounts: &[AccountInfo]) -> Result<Option<i64>>;

    /// Venue equity contribution to NAV (section 5.1). Mock: Σ unrealized PnL over
    /// `marks`. Drift: USDC collateral held at the venue + Σ unrealized PnL
    /// (fees and funding included), read from the venue account in `accounts`.
    fn read_account_equity(&self, pool: &Pool, accounts: &[AccountInfo], marks: &[Mark]) -> Result<i64>;

    /// Make sure at least `needed` USDC sits in the pool vault, pulling
    /// collateral back from the venue if necessary. Returns whether the vault
    /// now covers `needed`. The mock keeps every dollar in the vault and
    /// always returns `true`.
    fn ensure_vault_liquidity(&self, pool: &mut Pool, accs: &VenueAccounts, needed: u64) -> Result<bool>;

    fn mark_price(&self, oracle: &OraclePrice) -> u64 {
        oracle.price
    }
}

pub fn adapter_for(pool: &Pool) -> Box<dyn VenueAdapter> {
    match pool.venue {
        Venue::MockPerps => Box::new(mock::MockPerps),
        Venue::Drift => Box::new(drift::DriftAdapter),
    }
}
