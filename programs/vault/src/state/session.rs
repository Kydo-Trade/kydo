use anchor_lang::prelude::*;

/// Optional browser-held "session key" authorised by the trader wallet for a
/// bounded time. It may sign **trade instructions only** (`place_trade`,
/// `close_trade` and `set_stop`. Everything on the `Trade` context) on the
/// trader's live pool. Never deposits, redemptions,
/// pool closing, claims or anything that moves funds, so a leaked session key
/// can at most trade within the same risk guard the trader is bound by.
/// Seeds: ["session", trader wallet]. Separate PDA so `TraderProfile`'s layout
/// is unchanged (in-place upgrade friendly).
#[account]
#[derive(InitSpace)]
pub struct SessionKey {
    pub trader: Pubkey,
    pub key: Pubkey,
    pub expires_at: i64,
    pub created_at: i64,
    pub bump: u8,
}

impl SessionKey {
    pub fn is_valid_for(&self, signer: &Pubkey, trader: &Pubkey, now: i64) -> bool {
        &self.trader == trader && &self.key == signer && self.expires_at > now
    }
}
