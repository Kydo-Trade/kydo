//! CommonPool. The crowdsourced funding layer (Vault Ledger section 1–section 3).
//! Investors deposit into one shared pool; eligible traders join a strict FIFO
//! queue and are funded automatically, up to their tier cap. The CommonPool
//! holds its claim on each funded trader pool as a normal `InvestorPosition`
//! owned by the CommonPool PDA.
use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct CommonPool {
    /// Investor shares outstanding (scaled 1e12, like pool shares).
    pub total_shares: u128,
    /// USDC the program accounts for in the common vault. Anything above this
    /// in the vault is dust. NAV never reads the raw balance, so donations
    /// can't move the share price (section 5.1 discipline, one layer up).
    pub accounted_idle: u64,
    /// Trader pools the CommonPool currently holds a stake in. `deposit_common`
    /// requires exactly this many (pool, position) pairs so NAV can't be
    /// understated by omitting a pool.
    pub active_stakes: u16,
    /// Next FIFO ticket number to hand out.
    pub next_ticket: u64,
    /// Head of the queue. `fund_next_in_queue` only ever processes this ticket.
    pub next_to_fund: u64,
    /// Idle reserve floor, bps of idle balance, never deployed to traders.
    pub reserve_bps: u16,
    /// Testnet gate (Vault Ledger section 7): no real deposits before redemption ships.
    pub deposit_enabled: bool,
    pub deposited_total: u64,
    pub funded_total: u64,
    /// Investor shares queued for redemption (Phase B). Burned at settlement.
    pub pending_redemption_shares: u128,
    pub bump: u8,
    pub vault_bump: u8,
}

/// An investor's stake in the CommonPool (not in any single trader).
#[account]
#[derive(InitSpace)]
pub struct CommonPosition {
    pub investor: Pubkey,
    pub shares: u128,
    /// Sum of deposits, USDC base units.
    pub cost_basis: u64,
    pub last_deposit_ts: i64,
    /// Shares queued for redemption (Phase B); burned at settlement.
    pub pending_shares: u128,
    pub requested_at: i64,
    pub bump: u8,
}

/// One place in the funding queue. PDA per trader, so double-queuing is
/// structurally impossible; closed (rent back to `payer`) when funded.
#[account]
#[derive(InitSpace)]
pub struct FundingTicket {
    pub trader: Pubkey,
    pub ticket: u64,
    /// Who paid the ticket rent (queue_for_funding is permissionless).
    pub payer: Pubkey,
    pub created_at: i64,
    pub bump: u8,
}
