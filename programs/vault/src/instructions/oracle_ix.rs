//! Mock oracle (devnet / tests). The price gateway pushes Pyth Hermes prices
//! here so the on-chain guard reads exactly what the keeper sees.
use crate::constants::*;
use crate::errors::VaultError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(market_id: u16)]
pub struct InitMockOracle<'info> {
    #[account(mut)]
    pub price_authority: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump, has_one = price_authority @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(
        init, payer = price_authority, space = 8 + MockOracle::INIT_SPACE,
        seeds = [MOCK_ORACLE_SEED, &market_id.to_le_bytes()], bump,
    )]
    pub oracle: Account<'info, MockOracle>,
    pub system_program: Program<'info, System>,
}

pub fn init_mock_oracle(ctx: Context<InitMockOracle>, market_id: u16) -> Result<()> {
    require!(ctx.accounts.config.allow_mock_oracle, VaultError::MockOracleDisabled);
    let o = &mut ctx.accounts.oracle;
    o.market_id = market_id;
    o.expo = -6;
    o.bump = ctx.bumps.oracle;
    Ok(())
}

#[derive(Accounts)]
pub struct SetMockPrice<'info> {
    pub price_authority: Signer<'info>,
    #[account(seeds = [PLATFORM_SEED], bump = config.bump, has_one = price_authority @ VaultError::Unauthorized)]
    pub config: Box<Account<'info, PlatformConfig>>,
    #[account(mut, seeds = [MOCK_ORACLE_SEED, &oracle.market_id.to_le_bytes()], bump = oracle.bump)]
    pub oracle: Account<'info, MockOracle>,
}

pub fn set_mock_price(ctx: Context<SetMockPrice>, price: i64, conf: u64, expo: i32) -> Result<()> {
    require!(ctx.accounts.config.allow_mock_oracle, VaultError::MockOracleDisabled);
    require!(price > 0, VaultError::InvalidArgument);
    let clock = Clock::get()?;
    let o = &mut ctx.accounts.oracle;
    o.price = price;
    o.conf = conf;
    o.expo = expo;
    o.publish_time = clock.unix_timestamp;
    o.slot = clock.slot;
    Ok(())
}
