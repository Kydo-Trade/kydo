//! Program-wide constants. All USDC amounts are base units (6 dp).

pub const PLATFORM_SEED: &[u8] = b"platform";
pub const REGISTRY_SEED: &[u8] = b"registry";
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const TREASURY_VAULT_SEED: &[u8] = b"treasury_vault";
pub const TRADER_SEED: &[u8] = b"trader";
pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const INVESTOR_SEED: &[u8] = b"investor";
pub const MOCK_ORACLE_SEED: &[u8] = b"mock_oracle";
pub const SESSION_SEED: &[u8] = b"session";
pub const COMMON_POOL_SEED: &[u8] = b"common_pool";
pub const COMMON_VAULT_SEED: &[u8] = b"common_vault";
pub const COMMON_INVESTOR_SEED: &[u8] = b"common_investor";
pub const TICKET_SEED: &[u8] = b"ticket";

/// Shares are scaled 1e12 (section 3.1). This is the basis for a mint into a pool that
/// has no shares yet. `math::shares_for_deposit` with `total_shares == 0`,
/// which in practice means the CommonPool's first depositor.
///
/// NOTE: it is NOT the only share basis in this program. A trader pool mints at
/// `DEAD_SHARES / SEED_DEPOSIT` (1e3 shares per USDC base unit) in both
/// `create_pool` and `fund_next_in_queue`, while this is 1e12 per base unit.
/// The two ledgers are separate and never compared, so the 1e9 difference is
/// harmless today, but `nav_per_share` returns numbers nine orders of magnitude
/// apart depending on which kind of account you hand it. Do not assume one
/// basis when reading or displaying them.
///
/// SHARE_SCALE is also load-bearing for dilution safety. The CommonPool has no
/// dead shares (`init_common_pool` leaves `total_shares` at 0) so what stops
/// the classic first-depositor inflation attack is this constant being large
/// enough that a later depositor can never be rounded down to zero shares, even
/// with NAV inflated to `u64::MAX`. That margin depends on SHARE_SCALE and
/// `min_deposit` together; it is pinned by
/// `tests::a_later_depositor_can_never_be_rounded_to_zero_shares`.
pub const SHARE_SCALE: u128 = 1_000_000_000_000;
/// Prices are USDC base units per one whole unit of the base asset (1e6 = $1).
pub const PRICE_SCALE: u64 = 1_000_000;
/// Base-asset quantities are scaled 1e9.
pub const QTY_SCALE: u64 = 1_000_000_000;
/// Dead shares minted against the 1 USDC seed at pool creation (section 5.1).
/// `DEAD_SHARES / SEED_DEPOSIT` = 1e3 shares per USDC base unit is the TRADER
/// POOL share basis. See the note on [`SHARE_SCALE`], which is a different one.
pub const DEAD_SHARES: u128 = 1_000_000_000;
pub const SEED_DEPOSIT: u64 = 1_000_000;

/// Registry capacity. Section 4.9 launches with 5–8 markets; kept small so the
/// registry deserializes within the 4 KiB SBF stack frame.
pub const MAX_MARKETS: usize = 8;
pub const MAX_POSITIONS: usize = 5;
pub const ESCROW_SLOTS: usize = 30;
pub const BPS: u64 = 10_000;
pub const SECONDS_PER_DAY: i64 = 86_400;
pub const TRIAL_DAYS: u16 = 30;
/// commit_grace_days at or above this marks a relaxed (demo) deployment where
/// finalize_trial accepts attested metrics without the 30 day roots.
pub const RELAXED_GRACE_DAYS: u16 = 365;
pub const MAX_TIER: u8 = 3;

/// Trader share of realized profit (section 5.2).
pub const TRADER_SPLIT_BPS: u64 = 8_000;
/// Platform performance fee, bps of realized profit. Carved out of the pool's
/// 20% share (trader 80 / investors 15 / platform 5), the Vault Ledger section 6 fix
/// for the "no revenue engine, no bounty funding" gap. Compiled, like the split.
pub const PLATFORM_FEE_BPS: u64 = 500;
/// Share of each collected platform fee that replenishes the keeper bounty
/// reserve (the rest is withdrawable revenue).
pub const PLATFORM_FEE_BOUNTY_BPS: u64 = 5_000;

/// Platform's share of what a reaped pool leaves behind. The part of the
/// trader's first-loss seed they never lost, once every investor has exited at
/// full value. The rest goes to the CommonPool, where it lifts NAV/share.
///
/// Unlike the entry fee's `surplus` and the performance fee, this is not carved
/// out of anything the investors were promised: by the time `reap_pool` runs,
/// the CommonPool has already been paid `investor_nav` in full and holds no
/// shares against the residue. It is the platform's cut for carrying the
/// liquidation, and it lands in withdrawable `revenue` rather than the bounty
/// reserve, so it can be paid out to a platform wallet via `withdraw_treasury`.
pub const REAP_PLATFORM_BPS: u64 = 5_000;

/// MockPerps execution model: half-spread and taker fee, both in bps of notional.
pub const MOCK_SPREAD_BPS: u64 = 5;
pub const MOCK_FEE_BPS: u64 = 5;


/// Pyth pull-oracle receiver program (same id on devnet and mainnet).
pub const PYTH_RECEIVER_PROGRAM: &str = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

/// Instant funding: fee = max(entry_fee, cap × this / 10_000). 12% > the section 5.2
/// invariant floor (split × maxDD = 8%), so buying instant seats stays negative-EV.
pub const INSTANT_FEE_BPS: u64 = 2_000;
/// Instant fee floor, bps of the entry fee (15_000 = 1.5×). Instant always
/// costs a real premium over the trial, even at the minimum cap.
pub const INSTANT_FEE_FLOOR_BPS: u64 = 15_000;
/// Tier-0 (instant funding) trades under tighter loss limits until the first
/// promotion. The industry-standard price of skipping the evaluation.
pub const INSTANT_DAILY_LOSS_BPS: u16 = 300;
pub const INSTANT_MAX_DRAWDOWN_BPS: u16 = 800;
