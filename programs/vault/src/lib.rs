//! Kydo vault program (C1). Pools, investor shares, NAV, pre-trade
//! risk guard, profit split with vesting + clawback, and pool lifecycle.
//! Venue access goes through the `VenueAdapter` trait (C2): MockPerps for
//! development and tests, Drift for live trading.
#![allow(clippy::too_many_arguments)]
#![allow(unexpected_cfgs)]
// `#[program]` expands to a call to the now-deprecated `AccountInfo::realloc`.
// Anchor's macro, not ours. It goes away with an Anchor upgrade, not an edit here.
#![allow(deprecated)]
// `>= 8 + 32 + 1` and `>= day + 1` state a byte layout and a day boundary.
// Clippy's `> 8 + 32` / `> day` are equivalent but hide what the number means.
#![allow(clippy::int_plus_one)]
// `is_none_or` needs rustc 1.82; the SBF build compiles with whatever rustc
// platform-tools ships, which is older than the host toolchain.
#![allow(clippy::unnecessary_map_or)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod oracle;
pub mod risk;
pub mod state;
mod tests;
pub mod venue;

use instructions::*;

declare_id!("G4E1BiuovMpeUCgyh2222GqAQt4cW5dXSovZipFd89T1");

#[program]
pub mod vault {
    use super::*;

    // ---- Setup ----
    pub fn init_platform(ctx: Context<InitPlatform>, args: InitPlatformArgs) -> Result<()> {
        instructions::admin::init_platform(ctx, args)
    }
    pub fn update_risk_params(ctx: Context<AdminOnly>, args: UpdateParamsArgs) -> Result<()> {
        instructions::admin::update_risk_params(ctx, args)
    }
    pub fn register_market(ctx: Context<AdminRegistry>, args: RegisterMarketArgs) -> Result<()> {
        instructions::admin::register_market(ctx, args)
    }
    pub fn remove_market(ctx: Context<AdminRegistry>, market_id: u16) -> Result<()> {
        instructions::admin::remove_market(ctx, market_id)
    }

    pub fn set_market_enabled(ctx: Context<AdminRegistry>, market_id: u16, enabled: bool) -> Result<()> {
        instructions::admin::set_market_enabled(ctx, market_id, enabled)
    }

    // ---- Mock oracle (devnet / tests) ----
    pub fn init_mock_oracle(ctx: Context<InitMockOracle>, market_id: u16) -> Result<()> {
        instructions::oracle_ix::init_mock_oracle(ctx, market_id)
    }
    pub fn set_mock_price(ctx: Context<SetMockPrice>, price: i64, conf: u64, expo: i32) -> Result<()> {
        instructions::oracle_ix::set_mock_price(ctx, price, conf, expo)
    }

    // ---- Trader lifecycle ----
    pub fn apply_as_trader(ctx: Context<ApplyAsTrader>, instant_cap: u64) -> Result<()> {
        instructions::trader::apply_as_trader(ctx, instant_cap)
    }
    pub fn commit_trial_root(ctx: Context<CommitTrialRoot>, day: u16, root: [u8; 32]) -> Result<()> {
        instructions::trader::commit_trial_root(ctx, day, root)
    }
    pub fn finalize_trial(ctx: Context<FinalizeTrial>, metrics: TrialMetrics) -> Result<()> {
        instructions::trader::finalize_trial(ctx, metrics)
    }

    // ---- Pool lifecycle ----
    pub fn create_pool<'info>(ctx: Context<'_, '_, 'info, 'info, CreatePool<'info>>, args: CreatePoolArgs) -> Result<()> {
        instructions::pool::create_pool(ctx, args)
    }
    pub fn activate_pool(ctx: Context<ActivatePool>) -> Result<()> {
        instructions::pool::activate_pool(ctx)
    }
    pub fn promote_tier<'info>(ctx: Context<'_, '_, 'info, 'info, PromoteTier<'info>>) -> Result<()> {
        instructions::pool::promote_tier(ctx)
    }
    pub fn close_pool(ctx: Context<ClosePool>) -> Result<()> {
        instructions::pool::close_pool(ctx)
    }
    pub fn reap_pool<'info>(ctx: Context<'_, '_, 'info, 'info, ReapPool<'info>>) -> Result<()> {
        instructions::pool::reap_pool(ctx)
    }

    // ---- Capital ----
    // ---- CommonPool crowdsourced funding (Vault Ledger section 1–section 3) ----
    pub fn init_common_pool(ctx: Context<InitCommonPool>, params: CommonPoolParams) -> Result<()> {
        instructions::common_pool::init_common_pool(ctx, params)
    }
    pub fn update_common_pool_params(ctx: Context<UpdateCommonPoolParams>, params: CommonPoolParams) -> Result<()> {
        instructions::common_pool::update_common_pool_params(ctx, params)
    }
    pub fn deposit_common<'info>(ctx: Context<'_, '_, 'info, 'info, DepositCommon<'info>>, amount: u64) -> Result<()> {
        instructions::common_pool::deposit_common(ctx, amount)
    }
    pub fn queue_for_funding(ctx: Context<QueueForFunding>) -> Result<()> {
        instructions::common_pool::queue_for_funding(ctx)
    }
    pub fn fund_next_in_queue(ctx: Context<FundNextInQueue>) -> Result<()> {
        instructions::common_pool::fund_next_in_queue(ctx)
    }
    pub fn skip_dead_ticket(ctx: Context<SkipDeadTicket>) -> Result<()> {
        instructions::common_pool::skip_dead_ticket(ctx)
    }
    /// Permissionless: hand a failed/locked trader's forfeited entry fee to the
    /// CommonPool, where it raises NAV/share for the investors.
    pub fn sweep_forfeited_fee(ctx: Context<SweepForfeitedFee>) -> Result<()> {
        instructions::common_pool::sweep_forfeited_fee(ctx)
    }
    // Phase B. Redemption out of the CommonPool + the platform fee sweep.
    pub fn redeem_common<'info>(ctx: Context<'_, '_, 'info, 'info, RedeemCommon<'info>>, shares: u128) -> Result<()> {
        instructions::common_pool::redeem_common(ctx, shares)
    }
    pub fn settle_common_redemption<'info>(ctx: Context<'_, '_, 'info, 'info, SettleCommonRedemption<'info>>) -> Result<()> {
        instructions::common_pool::settle_common_redemption(ctx)
    }
    pub fn request_common_pull(ctx: Context<RequestCommonPull>) -> Result<()> {
        instructions::common_pool::request_common_pull(ctx)
    }
    pub fn settle_common_pull<'info>(ctx: Context<'_, '_, 'info, 'info, SettleCommonPull<'info>>) -> Result<()> {
        instructions::common_pool::settle_common_pull(ctx)
    }
    pub fn collect_platform_fee(ctx: Context<CollectPlatformFee>) -> Result<()> {
        instructions::pool::collect_platform_fee(ctx)
    }

    pub fn deposit<'info>(ctx: Context<'_, '_, 'info, 'info, Deposit<'info>>, amount: u64) -> Result<()> {
        instructions::capital::deposit(ctx, amount)
    }
    pub fn request_redemption<'info>(ctx: Context<'_, '_, 'info, 'info, RequestRedemption<'info>>, shares: u128) -> Result<()> {
        instructions::capital::request_redemption(ctx, shares)
    }
    pub fn unwind_for_redemption<'info>(ctx: Context<'_, '_, 'info, 'info, UnwindForRedemption<'info>>) -> Result<()> {
        instructions::capital::unwind_for_redemption(ctx)
    }
    pub fn settle_redemption<'info>(ctx: Context<'_, '_, 'info, 'info, SettleRedemption<'info>>) -> Result<()> {
        instructions::capital::settle_redemption(ctx)
    }

    // ---- Trading ----
    pub fn place_trade<'info>(ctx: Context<'_, '_, 'info, 'info, Trade<'info>>, args: PlaceTradeArgs) -> Result<()> {
        instructions::trading::place_trade(ctx, args)
    }
    pub fn close_trade<'info>(ctx: Context<'_, '_, 'info, 'info, Trade<'info>>, args: CloseTradeArgs) -> Result<()> {
        instructions::trading::close_trade(ctx, args)
    }
    pub fn set_stop<'info>(ctx: Context<'_, '_, 'info, 'info, Trade<'info>>, args: SetStopArgs) -> Result<()> {
        instructions::trading::set_stop(ctx, args)
    }
    pub fn vest_escrow(ctx: Context<VestEscrow>) -> Result<()> {
        instructions::trading::vest_escrow(ctx)
    }
    pub fn claim_trader_fees<'info>(ctx: Context<'_, '_, 'info, 'info, ClaimTraderFees<'info>>) -> Result<()> {
        instructions::trading::claim_trader_fees(ctx)
    }

    // ---- Risk (permissionless, bountied) ----
    pub fn evaluate_risk<'info>(ctx: Context<'_, '_, 'info, 'info, RiskAction<'info>>) -> Result<()> {
        instructions::risk_ix::evaluate_risk(ctx)
    }
    pub fn lock_pool<'info>(ctx: Context<'_, '_, 'info, 'info, RiskAction<'info>>) -> Result<()> {
        instructions::risk_ix::lock_pool(ctx)
    }
    pub fn unwind_all<'info>(ctx: Context<'_, '_, 'info, 'info, RiskAction<'info>>) -> Result<()> {
        instructions::risk_ix::unwind_all(ctx)
    }

    // ---- Session keys (trade-only delegate, ≤ 24 h) ----
    pub fn set_session_key(ctx: Context<SetSessionKey>, key: Pubkey, ttl_secs: i64) -> Result<()> {
        instructions::session::set_session_key(ctx, key, ttl_secs)
    }
    pub fn revoke_session_key(ctx: Context<RevokeSessionKey>) -> Result<()> {
        instructions::session::revoke_session_key(ctx)
    }

    // ---- Safety ----
    pub fn pause(ctx: Context<AdminOnly>) -> Result<()> {
        instructions::admin::set_paused(ctx, true)
    }
    pub fn unpause(ctx: Context<AdminOnly>) -> Result<()> {
        instructions::admin::set_paused(ctx, false)
    }
    pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
        instructions::admin::withdraw_treasury(ctx, amount)
    }
    pub fn sweep_dust(ctx: Context<SweepDust>) -> Result<()> {
        instructions::admin::sweep_dust(ctx)
    }
    pub fn migrate_account(ctx: Context<MigrateAccount>) -> Result<()> {
        instructions::admin::migrate_account(ctx)
    }
}
