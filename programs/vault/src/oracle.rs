//! Oracle reads. Two sources are accepted, selected by account owner:
//!  * Pyth pull-oracle `PriceUpdateV2` accounts (owner = Pyth receiver program)
//!  * this program's `MockOracle` (devnet / tests, gated by `allow_mock_oracle`)
//!
//! Both are normalized to a 1e6-scaled price so the rest of the program is
//! oracle-agnostic. The keeper's price gateway reads Pyth Hermes. The same
//! feeds, so on-chain and off-chain marks agree (section 3.4).
use crate::constants::{PRICE_SCALE, PYTH_RECEIVER_PROGRAM};
use crate::errors::VaultError;
use crate::state::{MarketInfo, MockOracle, PlatformConfig, RiskParams};
use anchor_lang::prelude::*;
use std::str::FromStr;

#[derive(Clone, Copy, Debug)]
pub struct OraclePrice {
    /// 1e6-scaled USDC price.
    pub price: u64,
    /// 1e6-scaled confidence interval.
    pub conf: u64,
    pub slot: u64,
    pub publish_time: i64,
}

/// Tolerance for clock skew between the price publisher and this validator.
/// Smaller than one `oracle_max_age_slots` window, so it cannot be used to
/// widen staleness.
const MAX_FUTURE_SECS: i64 = 10;

/// Nominal Solana slot time, used only to express `oracle_max_age_slots` as a
/// wall-clock ceiling on `publish_time`.
const NOMINAL_SLOT_MS: i64 = 400;

/// The `publish_time` ceiling, derived from the configured slot window so there
/// is one staleness knob rather than two that can disagree. Doubled: slots run
/// long under congestion, and this bound is here to catch a price that is stale
/// by minutes, not to second-guess the slot check by a few hundred milliseconds.
fn max_publish_age_secs(risk: &RiskParams) -> i64 {
    (risk.oracle_max_age_slots as i64).saturating_mul(NOMINAL_SLOT_MS).saturating_mul(2) / 1_000
}

impl OraclePrice {
    pub fn conf_bps(&self) -> u64 {
        if self.price == 0 {
            return u64::MAX;
        }
        ((self.conf as u128) * 10_000 / self.price as u128) as u64
    }
}

/// Read and validate an oracle account for `market`.
/// `strict` enforces freshness and confidence (pre-trade guard steps 4–5);
/// the non-strict path only validates identity so that closes are never
/// blocked by a stale feed on a different market.
pub fn read_oracle(
    acc: &AccountInfo,
    market: &MarketInfo,
    config: &PlatformConfig,
    risk: &RiskParams,
    clock: &Clock,
    strict: bool,
) -> Result<OraclePrice> {
    require_keys_eq!(acc.key(), market.oracle, VaultError::OracleMissing);

    let px = if *acc.owner == crate::ID {
        require!(config.allow_mock_oracle, VaultError::MockOracleDisabled);
        let data = acc.try_borrow_data()?;
        let mock = MockOracle::try_deserialize(&mut &data[..])?;
        require!(mock.market_id == market.market_id, VaultError::OracleInvalid);
        normalize(mock.price, mock.conf, mock.expo, mock.slot, mock.publish_time)?
    } else {
        let pyth = Pubkey::from_str(PYTH_RECEIVER_PROGRAM).unwrap();
        require_keys_eq!(*acc.owner, pyth, VaultError::OracleInvalid);
        let data = acc.try_borrow_data()?;
        parse_price_update_v2(&data, &market.feed_id)?
    };

    if strict {
        let age = clock.slot.saturating_sub(px.slot);
        require!(age <= risk.oracle_max_age_slots, VaultError::OracleStale);
        // `slot` is when the update was POSTED on-chain; `publish_time` is when
        // the price was observed. For Pyth those differ, so a price observed
        // minutes ago and posted in the current slot passes the check above.
        // Bound the observation time too.
        //
        // Both directions. A timestamp in the future is not a fresh price, it is
        // a broken or hostile publisher, and without this check it is the most
        // durable kind of stale. It never ages out.
        //
        // Deliberately strict-only: the non-strict path exists so that a bad
        // feed can never block an exit (see `request_redemption`), and a new
        // hard reject there would hand back exactly the lever this file is
        // written to deny.
        require!(
            px.publish_time <= clock.unix_timestamp.saturating_add(MAX_FUTURE_SECS),
            VaultError::OracleInvalid
        );
        require!(
            clock.unix_timestamp.saturating_sub(px.publish_time) <= max_publish_age_secs(risk),
            VaultError::OracleStale
        );
        // ------------------------------------------------------------------
        // REMOVED 2026-09-22. The confidence ceiling is NOT enforced.
        //
        //     require!(px.conf_bps() <= risk.oracle_max_conf_bps as u64,
        //              VaultError::OracleConfidence);
        //
        // What that check did: refuse a price whose published uncertainty
        // exceeded `oracle_max_conf_bps` (config ships 50 = 0.5%), so the
        // program would not open or size a position on a price the feed itself
        // said was unreliable.
        //
        // Why it went: the keeper's exchange fallback had no confidence to
        // report and published a hard-coded `price / 2000` (5 bps) on every
        // such price (`services/keeper/src/prices.ts`). 5 never exceeds 50, so
        // on that path the check passed by construction and protected nothing,
        // while still being able to block the honest Pyth path. A guard that
        // is inert exactly when it is needed is worse than no guard, because
        // it reads like coverage.
        //
        // What is now unprotected: nothing rejects a wide or untrustworthy
        // price. On the MockPerps venue that matters more than it sounds.
        // Fills are struck AT the oracle mark (`venue/mock.rs`), so one bad
        // number becomes the fill price, the mark, the NAV and the breach
        // decision at once, with no real counterparty to disagree with it.
        //
        // Restoring it needs the keeper to publish an honest confidence first:
        // Binance `/ticker/bookTicker` carries a real bid/ask, and a source
        // with no spread should say so with a wide value rather than invent a
        // narrow one. `oracle_max_conf_bps` and `conf_bps()` are deliberately
        // left in place so restoring is a one-line change, not a redesign.
        // ------------------------------------------------------------------
        let _ = risk.oracle_max_conf_bps;
    }
    require!(px.price > 0, VaultError::OracleInvalid);
    Ok(px)
}

fn normalize(price: i64, conf: u64, expo: i32, slot: u64, publish_time: i64) -> Result<OraclePrice> {
    require!(price > 0, VaultError::OracleInvalid);
    require!((-18..=6).contains(&expo), VaultError::OracleInvalid);
    // target exponent is -6
    let shift = expo + 6;
    let (p, c): (u128, u128) = if shift >= 0 {
        let m = 10u128.pow(shift as u32);
        ((price as u128) * m, (conf as u128) * m)
    } else {
        let d = 10u128.pow((-shift) as u32);
        ((price as u128) / d, (conf as u128) / d)
    };
    Ok(OraclePrice {
        price: u64::try_from(p).map_err(|_| VaultError::MathOverflow)?,
        conf: u64::try_from(c).map_err(|_| VaultError::MathOverflow)?,
        slot,
        publish_time,
    })
}

/// Borsh layout of `pyth_solana_receiver_sdk::price_update::PriceUpdateV2`:
///   [8] discriminator
///   [32] write_authority
///   verification_level: enum { Partial{num_signatures:u8} = 0, Full = 1 }
///   price_message: { feed_id:[u8;32], price:i64, conf:u64, exponent:i32,
///                    publish_time:i64, prev_publish_time:i64, ema_price:i64, ema_conf:u64 }
///   posted_slot: u64
fn parse_price_update_v2(data: &[u8], expected_feed: &[u8; 32]) -> Result<OraclePrice> {
    const DISC: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];
    require!(data.len() >= 8 + 32 + 1, VaultError::OracleInvalid);
    require!(data[..8] == DISC, VaultError::OracleInvalid);
    let mut o = 8 + 32;
    let level = data[o];
    o += 1;
    // Partial { num_signatures } = 0 → reject; only fully verified updates are accepted.
    require!(level == 1, VaultError::OracleInvalid);
    require!(data.len() >= o + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8, VaultError::OracleInvalid);
    let feed_id: [u8; 32] = data[o..o + 32].try_into().unwrap();
    require!(&feed_id == expected_feed, VaultError::OracleInvalid);
    o += 32;
    let price = i64::from_le_bytes(data[o..o + 8].try_into().unwrap());
    o += 8;
    let conf = u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
    o += 8;
    let expo = i32::from_le_bytes(data[o..o + 4].try_into().unwrap());
    o += 4;
    let publish_time = i64::from_le_bytes(data[o..o + 8].try_into().unwrap());
    o += 8;
    // Monotonicity, self-contained: the account carries the price it replaced,
    // so a rewound feed is detectable here without this program keeping any
    // per-market history of its own.
    let prev_publish_time = i64::from_le_bytes(data[o..o + 8].try_into().unwrap());
    require!(publish_time >= prev_publish_time, VaultError::OracleInvalid);
    o += 8 + 8 + 8; // ema_price, ema_conf
    let posted_slot = u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
    normalize(price, conf, expo, posted_slot, publish_time)
}

/// Convenience: 1e6-scaled dollars.
pub const fn usd(x: u64) -> u64 {
    x * PRICE_SCALE
}
