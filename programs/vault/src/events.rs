//! Every state transition emits an event. The indexer (C5) builds the equity
//! curve from `TradeFilled` and `NavMarked`, never from venue reporting (section 4.5).
use anchor_lang::prelude::*;

#[event]
pub struct TraderApplied {
    pub trader: Pubkey,
    pub attempt: u16,
    pub fee: u64,
    pub trial_start_ts: i64,
}

#[event]
pub struct TrialRootCommitted {
    pub trader: Pubkey,
    pub day: u16,
    pub root: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct TrialFinalized {
    pub trader: Pubkey,
    pub passed: bool,
    pub final_equity: u64,
    pub max_drawdown_bps: u16,
    pub trades: u32,
    pub active_days: u16,
    pub fail_reason: u8,
}

#[event]
pub struct PoolCreated {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub index: u16,
    pub mandate: u8,
    pub target_size: u64,
    pub tier: u8,
    pub ts: i64,
}

#[event]
pub struct PoolActivated {
    pub pool: Pubkey,
    pub nav: u64,
    pub ts: i64,
}

#[event]
pub struct TierPromoted {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub from_tier: u8,
    pub to_tier: u8,
    pub cap: u64,
    pub ts: i64,
}

#[event]
pub struct Deposited {
    pub pool: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
    pub shares: u128,
    pub nav_per_share: u128,
    pub nav_after: u64,
    pub ts: i64,
}

#[event]
pub struct RedemptionRequested {
    pub pool: Pubkey,
    pub investor: Pubkey,
    pub shares: u128,
    pub immediate: bool,
    pub ts: i64,
}

#[event]
pub struct RedemptionSettled {
    pub pool: Pubkey,
    pub investor: Pubkey,
    pub shares: u128,
    pub payout: u64,
    pub unwind_cost: u64,
    pub nav_per_share: u128,
    pub ts: i64,
}

#[event]
pub struct TradeFilled {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub market_id: u16,
    pub side: u8,
    pub is_close: bool,
    pub base_qty: u64,
    pub fill_price: u64,
    pub oracle_price: u64,
    pub oracle_slot: u64,
    pub fee: u64,
    pub realized_pnl: i64,
    pub position_qty_after: u64,
    pub position_entry_after: u64,
    pub nav_after: u64,
    pub escrow_total_after: u64,
    pub open_positions: u8,
    pub ts: i64,
}

#[event]
pub struct NavMarked {
    pub pool: Pubkey,
    /// Total pool equity. What the loss limits and the health factor measure.
    pub nav: u64,
    /// Investor-redeemable NAV: `nav` minus whatever is left of the trader's
    /// first-loss seed. `nav_per_share` is priced off this, not off `nav`.
    pub investor_nav: u64,
    pub nav_per_share: u128,
    pub peak_nav: u64,
    pub day_start_nav: u64,
    pub hwm_nps: u128,
    pub gross_notional: u64,
    pub ts: i64,
}

#[event]
pub struct PoolLocked {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub reason: u8,
    pub nav: u64,
    pub escrow_returned: u64,
    pub caller: Pubkey,
    pub ts: i64,
}

#[event]
pub struct PoolUnwound {
    pub pool: Pubkey,
    pub positions_closed: u8,
    pub realized_pnl: i64,
    pub nav_after: u64,
    pub caller: Pubkey,
    pub ts: i64,
}

#[event]
pub struct EscrowVested {
    pub pool: Pubkey,
    pub amount: u64,
    pub vested_claimable: u64,
    pub ts: i64,
}

#[event]
pub struct FeesClaimed {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub amount: u64,
    pub ts: i64,
}

#[event]
pub struct PoolClosed {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub ts: i64,
}

#[event]
pub struct PoolReaped {
    pub pool: Pubkey,
    /// Uncollected 5% platform performance fee, swept to the treasury.
    pub platform_fee: u64,
    /// The investors' share of the unspent first-loss seed + dust, added to the
    /// CommonPool's idle balance against unchanged shares, so it raises
    /// NAV/share for every holder.
    pub to_common: u64,
    /// The platform's `REAP_PLATFORM_BPS` share of the same remainder, booked as
    /// withdrawable treasury revenue, or the whole remainder when the
    /// CommonPool has no shares outstanding and the value would be unowned.
    pub to_treasury: u64,
    pub ts: i64,
}

#[event]
pub struct MarketRemoved {
    pub market_id: u16,
    pub symbol: [u8; 8],
    /// Markets left in the registry after the removal.
    pub remaining: u8,
}

#[event]
pub struct BountyPaid {
    pub pool: Pubkey,
    pub caller: Pubkey,
    pub amount: u64,
}

#[event]
pub struct SessionKeySet {
    pub trader: Pubkey,
    /// `Pubkey::default()` on revoke.
    pub key: Pubkey,
    pub expires_at: i64,
    pub ts: i64,
}

#[event]
pub struct PlatformPaused {
    pub paused: bool,
    pub ts: i64,
}

/// Retired by the Vault Ledger fee model (the fee is first-loss seed capital
/// now, never refunded). Kept so old indexed events still decode.
#[event]
pub struct EntryFeeRefunded {
    pub trader: Pubkey,
    pub amount: u64,
    pub ts: i64,
}

#[event]
pub struct CommonDeposited {
    pub investor: Pubkey,
    pub amount: u64,
    pub shares: u128,
    /// idle + Σ book value of stakes, after this deposit.
    pub nav_after: u64,
    pub total_shares_after: u128,
    pub ts: i64,
}

#[event]
pub struct FundingQueued {
    pub trader: Pubkey,
    pub ticket: u64,
    pub ts: i64,
}

#[event]
pub struct CommonRedemptionRequested {
    pub investor: Pubkey,
    pub shares: u128,
    pub immediate: bool,
    pub ts: i64,
}

#[event]
pub struct CommonRedemptionSettled {
    pub investor: Pubkey,
    pub shares: u128,
    pub payout: u64,
    pub nav_after: u64,
    pub total_shares_after: u128,
    pub ts: i64,
}

/// The CommonPool pulling capital back from a trader pool to serve redemptions.
#[event]
pub struct CommonPullRequested {
    pub pool: Pubkey,
    pub shares: u128,
    pub ts: i64,
}

#[event]
pub struct CommonPullSettled {
    pub pool: Pubkey,
    pub shares: u128,
    pub payout: u64,
    pub unwind_cost: u64,
    /// True when the CommonPool's stake in this pool is fully exited (position closed).
    pub stake_closed: bool,
    pub ts: i64,
}

/// The 5% platform performance fee swept from a pool to the treasury
/// (half replenishes the keeper bounty reserve, half is revenue).
/// A held entry/instant fee whose attempt ended without funding (failed trial
/// or breach lock) was handed to the CommonPool, where it raises NAV/share with
/// no new shares behind it, so it accrues to the investors who were carrying
/// the platform while the attempt ran.
#[event]
pub struct ForfeitedFeeSwept {
    pub trader: Pubkey,
    pub caller: Pubkey,
    /// Into the CommonPool's idle balance, as investor value.
    pub to_common: u64,
    /// To treasury revenue instead, when the CommonPool has no shares to price
    /// the value against (same fallback as `reap_pool`).
    pub to_treasury: u64,
    /// Still held on the profile because the treasury vault could not cover it.
    pub remaining: u64,
    pub ts: i64,
}

#[event]
pub struct PlatformFeeCollected {
    pub pool: Pubkey,
    pub amount: u64,
    pub to_bounty_reserve: u64,
    pub ts: i64,
}

/// A head-of-queue ticket whose trader could no longer be funded was closed
/// and the queue advanced (permissionless unjam).
#[event]
pub struct QueueTicketSkipped {
    pub trader: Pubkey,
    pub ticket: u64,
    pub ts: i64,
}

#[event]
pub struct PoolFundedFromQueue {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub ticket: u64,
    /// CommonPool's tier-cap allocation (mints the CommonPool's stake).
    pub allocation: u64,
    /// The trader's entry/instant fee injected as no-shares first-loss seed.
    pub fee_seed: u64,
    pub nav: u64,
    pub ts: i64,
}

/// A stop was attached to or moved on an open position. By `place_trade` at
/// entry or by `set_stop` afterwards. Informational: stops are a trader tool,
/// not a risk control, so nothing in the guard depends on this.
#[event]
pub struct StopSet {
    pub pool: Pubkey,
    pub market_id: u16,
    pub stop_px: u64,
    pub nav: u64,
    pub ts: i64,
}
