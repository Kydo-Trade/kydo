use anchor_lang::prelude::*;

/// Platform-wide live risk limits (section 5.3). Fixed by the admin; traders cannot change them.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct RiskParams {
    /// Max gross leverage, bps of NAV (50_000 = 5×).
    pub max_leverage_bps: u32,
    /// Max concurrent positions (5).
    pub max_positions: u8,
    /// Max single position, bps of equity (4_000 = 40%).
    pub max_single_bps: u16,
    /// Max correlated cluster, bps of equity (6_000 = 60%).
    pub max_cluster_bps: u16,
    /// Daily loss cap, bps of day-start NAV (400 = 4%).
    pub daily_loss_bps: u16,
    /// Max total drawdown from peak NAV, bps (1_000 = 10%).
    pub max_drawdown_bps: u16,
    /// Minimum holding time per position, seconds (60).
    pub min_hold_secs: u32,
    /// Max trades per UTC day (100).
    pub max_trades_per_day: u16,
    /// Oracle max age in slots (150 ≈ 60s).
    pub oracle_max_age_slots: u64,
    /// Oracle max confidence / price, bps (50).
    pub oracle_max_conf_bps: u16,
    /// Limit price must be within this many bps of oracle (200).
    pub limit_band_bps: u16,
    /// Post-deposit redemption lockup, seconds (86_400).
    pub redemption_lockup_secs: u32,
    /// Cooldown after a failed trial, seconds (7 days).
    pub cooldown_secs: u32,
    /// Live trading days at a tier required for promotion (30).
    pub promotion_days: u16,
}

impl RiskParams {
    /// The fallback `init_platform` uses when no `risk` is supplied. It must
    /// stay in step with `config/platform.jsonc`, because `min_first_loss_bps`
    /// is derived from `max_leverage_bps` and `oracle_max_age_slots`: the
    /// cushion the shipped configs post (1_571 bps) is sized for 5x over a 60 s
    /// mark window. These defaults used to say 10x / 25 slots, which would have
    /// silently deployed twice the leverage behind a cushion sized for half of
    /// it. See the note on `PlatformConfig::min_first_loss_bps`.
    pub fn mvp_defaults() -> Self {
        Self {
            max_leverage_bps: 50_000,
            max_positions: 5,
            max_single_bps: 12_500,
            max_cluster_bps: 25_000,
            daily_loss_bps: 400,
            max_drawdown_bps: 1_000,
            min_hold_secs: 60,
            max_trades_per_day: 100,
            oracle_max_age_slots: 150,
            oracle_max_conf_bps: 50,
            limit_band_bps: 200,
            redemption_lockup_secs: 86_400,
            cooldown_secs: 7 * 86_400,
            promotion_days: 30,
        }
    }
}

/// Trial pass criteria (section 5.4). Evaluated on-chain in `finalize_trial` against
/// metrics attested by the trial engine's attestor key.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct TrialCriteria {
    /// Virtual starting balance, USDC base units ($50,000).
    pub starting_balance: u64,
    /// Profit target, bps (800 = +8%).
    pub profit_target_bps: u16,
    /// Max drawdown, bps (1_000).
    pub max_drawdown_bps: u16,
    /// Daily loss cap, bps (400).
    pub daily_loss_bps: u16,
    /// Minimum active days (15).
    pub min_active_days: u16,
    /// Minimum trades (20).
    pub min_trades: u32,
    /// No single day may exceed this share of total profit, bps (4_000 = 40%).
    pub max_day_profit_share_bps: u16,
    /// Length of one platform "day" in seconds. Trial days, live-trading days (tier
    /// promotion) and escrow vesting all use it. 86_400 in production; demos shorten it.
    pub day_secs: u32,
    /// Extra days allowed to commit a day's root before the trial is invalidated (1 on devnet).
    pub commit_grace_days: u16,
}

impl TrialCriteria {
    pub fn mvp_defaults() -> Self {
        Self {
            starting_balance: 50_000_000_000,
            profit_target_bps: 800,
            max_drawdown_bps: 1_000,
            daily_loss_bps: 400,
            min_active_days: 15,
            min_trades: 20,
            max_day_profit_share_bps: 4_000,
            day_secs: 86_400,
            commit_grace_days: 1,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct PlatformConfig {
    /// The only key that can change params, pause, or withdraw revenue.
    ///
    /// A single `Pubkey`, not a multisig. An earlier version of this comment
    /// said "(multisig)" and nothing in the program has ever enforced that.
    /// It is also write-once: `init_platform` sets it and no instruction
    /// changes it, so rotating the admin needs a program upgrade.
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    /// Trial engine key that attests trial metrics to `finalize_trial`.
    pub trial_attestor: Pubkey,
    /// Key allowed to push mock-oracle prices (devnet only).
    pub price_authority: Pubkey,
    /// Entry fee, USDC base units. `config/platform.jsonc` ships 800, not the
    /// $500 this comment claimed; treat the config file as the source of truth
    /// and this field as whatever `init_platform` was given.
    pub entry_fee: u64,
    /// **Vestigial. Read by nothing.** Under the Vault Ledger fee model the
    /// entry fee is held in treasury-vault custody and split at funding time by
    /// `fund_next_in_queue`: `min_first_loss_bps` of the cap becomes the pool's
    /// first-loss seed and the surplus is divided by `PLATFORM_FEE_BOUNTY_BPS`.
    /// Nothing reads this field. It is kept (and still bounded by `entry_fee`)
    /// only so the account layout and the IDL are unchanged; set it to 0.
    pub bounty_per_pool: u64,
    /// Bounty paid per permissionless lock / unwind call.
    pub keeper_bounty: u64,
    /// Pool activates at ≥ this NAV ($1,000).
    pub activation_floor: u64,
    /// Minimum investor deposit ($50).
    pub min_deposit: u64,
    /// Per-tier pool caps ($5k / $15k / $30k).
    pub tier_caps: [u64; 3],
    /// Per-tier vesting periods in days (14 / 30 / 30).
    pub vest_days: [u16; 3],
    pub risk: RiskParams,
    pub trial: TrialCriteria,
    pub paused: bool,
    pub allow_mock_oracle: bool,
    pub bump: u8,
    pub treasury_bump: u8,
    pub treasury_vault_bump: u8,
    /// Trader first-loss required to fund a pool, in bps of the pool's tier cap.
    /// Must cover the drawdown trigger plus the liquidation buffer at the
    /// platform leverage cap: at 5x over a 60s mark window (the 150-slot
    /// staleness bound the shipped configs use) that is 10% + 5.71% = 1_571
    /// bps. Raising `risk.max_leverage_bps` or `risk.oracle_max_age_slots`
    /// widens the buffer and so must raise this too. `RiskParams::mvp_defaults`
    /// and `config/platform.jsonc` are both sized against this figure.
    ///
    /// Appended: migrate_account zero-fills. Zero disables the cushion gate,
    /// which is the pre-upgrade behaviour.
    pub min_first_loss_bps: u16,
}

impl PlatformConfig {
    pub fn tier_cap(&self, tier: u8) -> u64 {
        self.tier_caps[(tier.clamp(1, 3) - 1) as usize]
    }
    pub fn vest_days(&self, tier: u8) -> u16 {
        self.vest_days[(tier.clamp(1, 3) - 1) as usize]
    }
    /// Instant traders vest on the slower Tier 2 schedule. No trial record
    /// means a longer clawback window prices the missing evidence.
    pub fn effective_vest_days(&self, tier: u8) -> u16 {
        if tier == 0 { self.vest_days[1] } else { self.vest_days(tier) }
    }

    /// Tier 0 runs tighter loss limits than the platform-wide ones (never
    /// looser): no trial record means less loss budget until first promotion.
    pub fn effective_daily_loss_bps(&self, tier: u8) -> u16 {
        if tier == 0 { self.risk.daily_loss_bps.min(crate::constants::INSTANT_DAILY_LOSS_BPS) } else { self.risk.daily_loss_bps }
    }
    pub fn effective_max_drawdown_bps(&self, tier: u8) -> u16 {
        if tier == 0 { self.risk.max_drawdown_bps.min(crate::constants::INSTANT_MAX_DRAWDOWN_BPS) } else { self.risk.max_drawdown_bps }
    }
}
