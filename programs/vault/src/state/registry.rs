use crate::constants::MAX_MARKETS;
use anchor_lang::prelude::*;

/// Correlated-cluster labels (section 5.3 "hand-labelled clusters").
pub mod cluster {
    pub const MAJORS: u8 = 1;
    pub const L1: u8 = 2;
    pub const MEMES: u8 = 3;
    pub const OTHER: u8 = 0;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace)]
pub struct MarketInfo {
    pub market_id: u16,
    /// ASCII symbol, zero padded (e.g. "SOL-PERP").
    pub symbol: [u8; 8],
    /// Oracle account: either a Pyth `PriceUpdateV2` or this program's `MockOracle`.
    pub oracle: Pubkey,
    /// Pyth feed id the oracle account must carry (ignored for mock oracles).
    pub feed_id: [u8; 32],
    /// Per-market leverage cap, bps.
    pub max_leverage_bps: u32,
    pub cluster: u8,
    pub enabled: bool,
    /// Drift perp market index for the DriftAdapter (unused by MockPerps).
    pub venue_market_index: u16,
}

#[account]
#[derive(InitSpace)]
pub struct MarketRegistry {
    pub markets: [MarketInfo; MAX_MARKETS],
    pub count: u8,
    pub bump: u8,
}

impl MarketRegistry {
    pub fn find(&self, market_id: u16) -> Option<&MarketInfo> {
        self.markets[..self.count as usize]
            .iter()
            .find(|m| m.market_id == market_id)
    }
    pub fn find_mut(&mut self, market_id: u16) -> Option<&mut MarketInfo> {
        let n = self.count as usize;
        self.markets[..n].iter_mut().find(|m| m.market_id == market_id)
    }
}
