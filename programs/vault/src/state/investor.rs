use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct InvestorPosition {
    pub pool: Pubkey,
    pub investor: Pubkey,
    pub shares: u128,
    /// Sum of deposits, USDC base units.
    pub cost_basis: u64,
    pub last_deposit_ts: i64,
    /// Shares queued for redemption (burned at settlement, section 4.7).
    pub pending_shares: u128,
    pub requested_at: i64,
    /// Pro-rata unwind already executed for the pending redemption.
    pub unwound: bool,
    /// Slippage + fees of the investor's own unwind; borne by the exiting investor.
    pub unwind_cost: u64,
    pub bump: u8,
}
