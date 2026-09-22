use anchor_lang::prelude::*;

/// Entry-fee revenue, the ring-fenced keeper bounty reserve, and swept dust (section 4.10).
#[account]
#[derive(InitSpace)]
pub struct Treasury {
    /// Withdrawable by admin.
    pub revenue: u64,
    /// Never withdrawable by admin; pays permissionless lock / unwind callers.
    pub bounty_reserve: u64,
    pub dust_swept: u64,
    pub bounties_paid: u64,
    pub bump: u8,
    pub vault_bump: u8,
}
