use crate::constants::{ESCROW_SLOTS, MAX_POSITIONS};
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum PoolStatus {
    Funding,
    Live,
    Locked,
    Settled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Mandate {
    Spot,
    Perps,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Venue {
    MockPerps,
    Drift,
}

pub mod lock_reason {
    pub const NONE: u8 = 0;
    pub const DAILY_LOSS: u8 = 1;
    pub const DRAWDOWN: u8 = 2;
    pub const VOLUNTARY: u8 = 3;
}

pub mod side {
    pub const NONE: u8 = 0;
    pub const LONG: u8 = 1;
    pub const SHORT: u8 = 2;
}

/// One daily escrow bucket (section 5.2): 12 bytes, 30 slots = 360 bytes.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct EscrowBucket {
    pub amount: u64,
    pub unlock_day: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct Position {
    pub market_id: u16,
    pub side: u8,
    pub cluster: u8,
    /// Base quantity, scaled 1e9.
    pub base_qty: u64,
    /// Average entry price, 1e6.
    pub entry_price: u64,
    pub opened_at: i64,
}

impl Position {
    pub fn is_open(&self) -> bool {
        self.side != side::NONE && self.base_qty > 0
    }
}

/// The stop attached to one open position. Keyed by market rather than held in
/// `Position` for two reasons: `sync_positions` rebuilds `positions` in venue
/// order, so a slot-indexed parallel array would mismatch after a reorder; and
/// a field inside `Position` would shift every `Pool` byte after the array,
/// which `migrate_account` (append + zero-fill) cannot do.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct StopOrder {
    pub market_id: u16,
    /// Trigger price, 1e6. 0 = free slot.
    pub price: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub trader: Pubkey,
    pub profile: Pubkey,
    pub index: u16,
    pub mandate: Mandate,
    pub status: PoolStatus,
    pub lock_reason: u8,
    pub venue: Venue,
    /// PDA-owned USDC token account.
    pub vault: Pubkey,
    /// Venue sub-account (Drift user account) owned by the pool PDA. Unused for MockPerps.
    pub venue_account: Pubkey,
    pub name: [u8; 32],
    pub strategy_hash: [u8; 32],
    pub target_size: u64,

    pub tier: u8,
    pub tier_start_ts: i64,
    /// NAV/share at tier start. Promotion requires positive NAV/share vs. this.
    pub tier_start_nps: u128,
    pub live_days_at_tier: u16,
    /// Last UTC day (epoch days) on which the pool was observed Live.
    pub last_live_day: u32,

    /// USDC the program accounts for. Anything above this in the vault is dust (section 5.1).
    pub accounted_usdc: u64,
    pub total_shares: u128,
    /// High-water mark of investor-visible NAV per share, never decreases.
    pub hwm_nps: u128,
    pub peak_nav: u64,
    pub day_start_nav: u64,
    pub day_epoch: u32,
    pub realized_pnl: i64,
    pub venue_fees_paid: u64,

    pub escrow: [EscrowBucket; ESCROW_SLOTS],
    pub escrow_total: u64,
    pub vested_claimable: u64,

    pub positions: [Position; MAX_POSITIONS],
    pub open_positions: u8,
    pub trades_today: u16,
    pub total_trades: u32,

    pub pending_redemption_shares: u128,
    pub created_at: i64,
    pub activated_at: i64,
    pub locked_at: i64,
    pub last_mark_ts: i64,
    pub last_mark_nav: u64,
    pub bump: u8,
    pub vault_bump: u8,
    /// Unix time after which the pool takes no deposits and opens no new trades;
    /// close_pool becomes permissionless. 0 = open-ended (the spec default).
    /// NOTE: appended field. Pools created before this field existed cannot be
    /// deserialized by this program version (devnet: close/reap them pre-upgrade).
    pub ends_at: i64,
    /// Uncollected platform performance fee (5% of realized profit, Vault Ledger
    /// Section 6). Excluded from NAV; swept to the treasury by `collect_platform_fee`.
    /// Appended: migrate_account zero-fills = nothing owed by pre-upgrade pools.
    pub platform_fee_owed: u64,
    /// Optional stop per open position, keyed by market. A trader tool, not a
    /// risk control: the platform sets loss limits and enforces them by
    /// liquidation, it does not dictate how a trader trades. 0 = no stop.
    /// Appended: migrate_account zero-fills, which simply means no stops.
    pub stops: [StopOrder; MAX_POSITIONS],
    /// Baseline for venue-side realizations the program has already accounted
    /// for, so a close *it* did not perform. A stop filled by Drift's keepers,
    /// a liquidation, an ADL. Still runs through the profit split instead of
    /// silently leaving the trader's escrow un-clawed-back.
    ///
    /// Measured against `observed = venue USDC balance + Σ quote_asset over
    /// flat perp slots`, which equals `net deposits + every realization the
    /// venue has produced`. `settle_pnl` only moves value between those two
    /// terms, so the observed total (and therefore this baseline) is
    /// invariant under settlement. `sync_venue` splits `observed − this` and
    /// then stores `observed`; deposits, withdrawals and the program's own
    /// closes move it directly. Any drift between the program's arithmetic and
    /// the venue's is picked up as the next delta, so the mechanism converges
    /// rather than losing value.
    ///
    /// Zero and unused for MockPerps, which has no separate venue account.
    ///
    /// Appended, so `migrate_account` zero-fills it. Correct for any pool that
    /// has never deposited to a venue, which is every pool today (no Drift pool
    /// has ever been funded). **A pre-existing Drift pool holding venue
    /// collateral must not be migrated blind:** a zero baseline against a
    /// non-zero balance reads the whole deposit as profit and hands the trader
    /// 80% of it as escrow. Such a pool has to be seeded with its current
    /// `usdc_balance + Σ quote over flat slots` instead.
    pub venue_accounted_quote: i64,
    /// Trader capital standing in front of investors, in USDC. Holds no shares,
    /// so it is pure first loss: it is spent before investor NAV/share moves.
    ///
    /// The invariant is `first_loss_seed >= min_first_loss_bps x pool cap`,
    /// which covers the drawdown trigger *and* the liquidation buffer beyond
    /// it, so a blowup costs the trader, not the investors. Seeded from the
    /// entry/instant fee at funding and topped up at promotion out of the
    /// trader's own escrow, never from cash.
    ///
    /// Appended: migrate_account zero-fills, which blocks promotion until the
    /// pool's cushion is re-established rather than silently under-funding it.
    pub first_loss_seed: u64,
    /// Investor cash in this pool: the CommonPool's allocation at funding, plus
    /// every deposit, minus every payout. It is the reference the first-loss
    /// seed is measured against, not a share count. Shares float, this does not.
    ///
    /// `remaining_first_loss = clamp(equity - investor_principal, 0, first_loss_seed)`
    /// and `investor_nav = equity - remaining_first_loss`. That is what makes
    /// the seed a *cushion* rather than a windfall: at funding the pool's equity
    /// is `allocation + seed` but investors are priced at `allocation`, so
    /// NAV/share is exactly 1.0 and a trader signing up does not make the
    /// CommonPool look instantly profitable. Trading losses then eat the gap
    /// before investor NAV moves at all, and the money the liquidation buffer
    /// is sized against cannot be withdrawn out from under it.
    ///
    /// Appended: `migrate_account` zero-fills, and `realloc(zero_init)` clears
    /// every byte past the old length, so on a pool predating `e28fa1b`
    /// `first_loss_seed` lands at 0 too. `min(equity - 0, 0) == 0`: investor NAV
    /// reads as the whole equity, the cushion is gone, and exits are OVER-paid.
    /// On a pool created between `e28fa1b` and `5226575` only this field
    /// zero-fills, `remaining_first_loss` becomes a constant reserve, and exits
    /// are UNDER-paid by the seed pro-rata. The first case turns into the second
    /// the moment anyone calls the permissionless `promote_tier`, which raises
    /// `first_loss_seed` without touching this field. No on-chain setter exists:
    /// reap and re-fund such a pool; do not migrate one with shares outstanding.
    pub investor_principal: u64,
}

impl Pool {
    pub fn find_position(&self, market_id: u16) -> Option<usize> {
        self.positions
            .iter()
            .position(|p| p.is_open() && p.market_id == market_id)
    }
    pub fn free_slot(&self) -> Option<usize> {
        self.positions.iter().position(|p| !p.is_open())
    }
    pub fn recount_positions(&mut self) {
        self.open_positions = self.positions.iter().filter(|p| p.is_open()).count() as u8;
    }
    pub fn is_live(&self) -> bool {
        self.status == PoolStatus::Live
    }

    pub fn stop_for(&self, market_id: u16) -> Option<u64> {
        self.stops.iter().find(|s| s.price > 0 && s.market_id == market_id).map(|s| s.price)
    }
    /// Set or replace the stop for `market_id`.
    pub fn set_stop(&mut self, market_id: u16, price: u64) -> Result<()> {
        if let Some(s) = self.stops.iter_mut().find(|s| s.price > 0 && s.market_id == market_id) {
            s.price = price;
            return Ok(());
        }
        let slot = self
            .stops
            .iter_mut()
            .find(|s| s.price == 0)
            .ok_or(crate::errors::VaultError::TooManyPositions)?;
        *slot = StopOrder { market_id, price };
        Ok(())
    }
    /// Drop stops whose market no longer has an open position. Called after
    /// anything that can close one, so a stop never outlives its position and
    /// can never be applied to a later, unrelated position on the same market.
    pub fn prune_stops(&mut self) {
        for i in 0..self.stops.len() {
            let m = self.stops[i].market_id;
            if self.stops[i].price > 0 && self.find_position(m).is_none() {
                self.stops[i] = StopOrder::default();
            }
        }
    }
}
