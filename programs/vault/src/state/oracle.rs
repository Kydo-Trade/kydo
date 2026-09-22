use anchor_lang::prelude::*;

/// Program-owned oracle for devnet / tests. The keeper's price gateway pushes
/// Pyth Hermes prices here when a Pyth `PriceUpdateV2` account is not available.
/// Gated by `PlatformConfig.allow_mock_oracle`.
#[account]
#[derive(InitSpace)]
pub struct MockOracle {
    pub market_id: u16,
    pub price: i64,
    pub conf: u64,
    pub expo: i32,
    pub publish_time: i64,
    pub slot: u64,
    pub bump: u8,
}
