use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum TraderStatus {
    Applied,
    Trial,
    Failed,
    Eligible,
    Frozen,
}

#[account]
#[derive(InitSpace)]
pub struct TraderProfile {
    pub wallet: Pubkey,
    pub status: TraderStatus,
    pub attempts: u16,
    /// Merkle root of the latest committed trial day.
    pub trial_root: [u8; 32],
    pub trial_start_ts: i64,
    /// Number of days committed so far (0..=30).
    pub trial_days_committed: u16,
    /// Track record: pools created / locked, live days.
    pub tier: u8,
    pub tier_start_ts: i64,
    pub live_days_at_tier: u16,
    pub pools_created: u16,
    pub pools_locked: u16,
    pub trials_failed: u16,
    pub cooldown_until: i64,
    /// Currently live pool, or `Pubkey::default()`.
    pub active_pool: Pubkey,
    pub bump: u8,
    /// INSTANT funding (tier 0): the cap the trader paid for. 0 for trial-path traders.
    /// NOTE: appended field. Pre-upgrade profiles need re-creation (devnet: re-apply).
    pub instant_cap: u64,
    /// Entry/instant fee held in treasury-vault custody, waiting to be injected
    /// into the trader's pool as no-shares first-loss seed capital by
    /// `fund_next_in_queue` (Vault Ledger section 2/section 6). Never refunded. Zeroed when
    /// consumed. Appended: migrate_account zero-fills = no seed for
    /// pre-upgrade profiles.
    pub fee_paid: u64,
    /// Fee from an attempt that ended without funding. A failed trial or a
    /// breach lock. Still sitting in treasury-vault custody, but no longer
    /// earmarked to seed anything, so `sweep_forfeited_fee` hands it to the
    /// CommonPool where it becomes investor value.
    ///
    /// Separate from `fee_paid` because a trader may re-apply before anyone
    /// sweeps: `apply_as_trader` overwrites `fee_paid` with the new attempt's
    /// fee, and without this bucket the old one would be silently dropped from
    /// the only record of it and stranded in the vault forever.
    ///
    /// Appended: migrate_account zero-fills. A profile that failed before this
    /// existed still has its fee in `fee_paid`, which the sweep also drains
    /// once the status is terminal.
    pub fee_forfeited: u64,
}
