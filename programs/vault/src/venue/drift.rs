//! DriftAdapter. Venue integration against Drift Protocol v2
//! (`dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`, same id on devnet and
//! mainnet).
//!
//! # THIS CODE HAS NEVER EXECUTED
//!
//! Not on devnet, not in a test. `tests/vault.ts` has no Drift coverage, and
//! every pool the terminal can create is `MockPerps` (`PoolForm.tsx`). "Live
//! venue integration" below describes the intent, not a fact: what follows was
//! written against the v2.162.0 layouts and byte-checked, which means the
//! encodings were read carefully, not that they work.
//!
//! Nothing gates it. `adapter_for` returns `DriftAdapter` on
//! `Venue::Drift` unconditionally, and `create_pool` calls `init_sub_account`
//! at creation, so the first CPI fires before anyone places a trade. The
//! failure to fear is not a revert, which is loud and cheap; it is a partial
//! success that leaves `venue_accounted_quote` disagreeing with what Drift
//! actually holds, after which `sync_venue` reads the gap as profit or loss
//! and every NAV in that pool is wrong, quietly.
//!
//! It is also no longer the production target: Phoenix is. This adapter is kept
//! because the work in it is real and reusable. The CPI surface below is a
//! hand-verified map of Drift's protocol-v2 encodings, which is the expensive
//! part of any Drift integration, and because it is the reference against
//! which the `VenueAdapter` interface was designed. Do not fund a pool on it.
//!
//! Before this could be used: one devnet round trip with fills, a partial fill,
//! funding, `settle_pnl` and a withdrawal, and the stub sweep this file has
//! never had.
//!
//! The CPI surface is hand-written: the SBF lockfile pins transitive crates
//! and the `drift` crate would break it. Instruction discriminators, account
//! orders and byte offsets were taken from **protocol-v2 v2.162.0**
//! (`programs/drift/src/state/{user,spot_market,perp_market}.rs`,
//! `instructions/user.rs`, `sdk/src/idl/drift.json`) and cross-checked
//! against Drift's own `SIZE` constants (User 4376, UserStats 240,
//! SpotMarket 776, PerpMarket 1216). Full tables are in the integration notes.
//!
//! Model
//! * The Drift `User` (sub-account 0) is owned by the pool PDA, with no
//!   delegate (section 3.1, section 4.3). Every CPI here is signed by the pool PDA as
//!   `authority`, and the PDA signs only from inside this program, so the
//!   on-chain guard is the only way an order reaches Drift.
//! * Collateral: idle USDC stays in the pool vault. `open_position` deposits
//!   only the shortfall between the venue equity and the collateral the
//!   platform leverage cap requires for the post-trade book, which keeps
//!   redemptions from free collateral immediate (section 4.7). Collateral comes back
//!   lazily through `ensure_vault_liquidity` when a payout needs it
//!   (`reduce_only` withdraw. The pool never borrows on Drift).
//! * Fills are read back from the Drift position delta, never from venue
//!   reporting (section 4.5): quantity from `base_asset_amount`, open notional from
//!   `quote_entry_amount`, taker fee from `UserStats.fees.total_fee_paid`,
//!   funding from `User.cumulative_perp_funding`.
//! * `read_account_equity` = USDC deposit balance + Σ(quote_asset_amount +
//!   base × mark), so NAV = vault USDC + venue equity (section 5.1). Fees, realized
//!   PnL and funding all live inside the Drift account until withdrawn.
//! * Precision: Drift `BASE_PRECISION` 1e9 == `QTY_SCALE`, `PRICE_PRECISION`
//!   and `QUOTE_PRECISION` 1e6 == `PRICE_SCALE` / USDC base units, so no
//!   rescaling is needed anywhere.
//! * Drift's `User` is 4 KiB: it is only ever parsed from the account-data
//!   slice, never copied onto the stack.
use super::{Fill, MarginHint, Mark, VenueAccounts, VenueAdapter};
use crate::constants::{MAX_POSITIONS, POOL_SEED, QTY_SCALE};
use crate::errors::VaultError;
use crate::math;
use crate::oracle::OraclePrice;
use crate::state::{side, MarketInfo, MarketRegistry, Pool, Position};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    pubkey, sysvar,
};

pub struct DriftAdapter;

/// Drift program id (devnet and mainnet).
pub const DRIFT_PROGRAM_ID: Pubkey = pubkey!("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");
/// Drift sub-account used by every pool (authority = pool PDA).
pub const SUB_ACCOUNT_ID: u16 = 0;
/// Off: the pool PDA is the only key that can act on the sub-account, so every
/// order goes through this program's pre-trade guard. A Drift delegate could
/// place orders directly (skipping the leverage/cluster limits) and cancel the
/// pool's resting stop orders, which would leave the guard enforceable only by
/// a live keeper. Flip to `true` only to let a trader drive the sub-account
/// from Drift's own UI.
pub const SET_TRADER_AS_DRIFT_DELEGATE: bool = false;

/// Anchor instruction discriminators: `sha256("global:<name>")[..8]`.
pub mod ix {
    pub const INITIALIZE_USER_STATS: [u8; 8] = [254, 243, 72, 98, 251, 130, 168, 213];
    pub const INITIALIZE_USER: [u8; 8] = [111, 17, 185, 250, 60, 122, 38, 254];
    pub const UPDATE_USER_DELEGATE: [u8; 8] = [139, 205, 141, 141, 113, 36, 94, 187];
    pub const DEPOSIT: [u8; 8] = [242, 35, 198, 137, 82, 225, 242, 182];
    pub const WITHDRAW: [u8; 8] = [183, 18, 70, 156, 148, 109, 161, 34];
    pub const PLACE_AND_TAKE_PERP_ORDER: [u8; 8] = [213, 51, 1, 187, 108, 220, 230, 224];
    /// Rests an order on the book. Used for the reduce-only stop, which must
    /// survive the transaction (unlike the IOC taker order above).
    pub const PLACE_PERP_ORDER: [u8; 8] = [69, 161, 93, 202, 120, 126, 76, 185];
    pub const CANCEL_ORDERS: [u8; 8] = [238, 225, 95, 158, 227, 103, 8, 194];
    /// Not CPI'd by the program (keeper calls it permissionlessly); listed so
    /// the SDK and the program agree on the value.
    pub const SETTLE_PNL: [u8; 8] = [43, 61, 234, 45, 15, 95, 152, 153];
}

/// Anchor account discriminators: `sha256("account:<Name>")[..8]`.
pub mod acct {
    pub const USER: [u8; 8] = [159, 117, 95, 227, 239, 151, 58, 236];
    pub const USER_STATS: [u8; 8] = [176, 223, 136, 27, 122, 79, 32, 227];
    pub const SPOT_MARKET: [u8; 8] = [100, 177, 8, 107, 168, 65, 65, 39];
    pub const PERP_MARKET: [u8; 8] = [10, 223, 12, 44, 107, 245, 55, 247];
}

/// Byte offsets into Drift zero-copy accounts (protocol-v2 v2.162.0, repr(C),
/// no implicit padding). Offsets are from the start of the account data and
/// include the 8-byte discriminator.
pub mod layout {
    // ---- User (4376 bytes) ----
    pub const USER_SIZE: usize = 4376;
    pub const USER_AUTHORITY: usize = 8;
    pub const USER_DELEGATE: usize = 40;
    pub const USER_SPOT_POSITIONS: usize = 104;
    pub const SPOT_POSITIONS_LEN: usize = 8;
    pub const SPOT_POSITION_SIZE: usize = 40;
    pub const USER_PERP_POSITIONS: usize = 424;
    pub const PERP_POSITIONS_LEN: usize = 8;
    pub const PERP_POSITION_SIZE: usize = 96;
    pub const USER_CUMULATIVE_PERP_FUNDING: usize = 4312;
    pub const USER_SUB_ACCOUNT_ID: usize = 4346;
    // ---- PerpPosition (96 bytes, offsets within the struct) ----
    pub const PP_BASE_ASSET_AMOUNT: usize = 8;
    pub const PP_QUOTE_ASSET_AMOUNT: usize = 16;
    pub const PP_QUOTE_BREAK_EVEN_AMOUNT: usize = 24;
    pub const PP_QUOTE_ENTRY_AMOUNT: usize = 32;
    pub const PP_LP_SHARES: usize = 64;
    pub const PP_MARKET_INDEX: usize = 92;
    pub const PP_OPEN_ORDERS: usize = 94;
    // ---- SpotPosition (40 bytes, offsets within the struct) ----
    pub const SP_SCALED_BALANCE: usize = 0;
    pub const SP_MARKET_INDEX: usize = 32;
    pub const SP_BALANCE_TYPE: usize = 34; // 0 = Deposit, 1 = Borrow
    // ---- UserStats (240 bytes) ----
    pub const USER_STATS_SIZE: usize = 240;
    pub const US_AUTHORITY: usize = 8;
    pub const US_TOTAL_FEE_PAID: usize = 72; // fees.total_fee_paid, QUOTE_PRECISION
    // ---- SpotMarket (776 bytes) ----
    pub const SPOT_MARKET_SIZE: usize = 776;
    pub const SM_ORACLE: usize = 40;
    pub const SM_MINT: usize = 72;
    pub const SM_VAULT: usize = 104;
    pub const SM_CUMULATIVE_DEPOSIT_INTEREST: usize = 464; // u128, SPOT_CUMULATIVE_INTEREST_PRECISION
    pub const SM_DECIMALS: usize = 680; // u32
    pub const SM_MARKET_INDEX: usize = 684; // u16
    // ---- PerpMarket (1216 bytes) ----
    pub const PERP_MARKET_SIZE: usize = 1216;
    pub const PM_AMM_ORACLE: usize = 40;
    pub const PM_MARKET_INDEX: usize = 1160; // u16
    // ---- precisions ----
    pub const SPOT_CUMULATIVE_INTEREST_PRECISION_EXP: u32 = 10; // 1e10
    pub const SPOT_BALANCE_PRECISION_EXP: u32 = 9; // 1e9
    pub const QUOTE_SPOT_MARKET_INDEX: u16 = 0;
}
use layout::*;

/// Number of fixed accounts after the Drift program-id marker for trading /
/// capital instructions, and for `create_pool`.
pub const TRADE_BLOCK_LEN: usize = 8;
pub const INIT_BLOCK_LEN: usize = 5;

// ---------------------------------------------------------------------------
// Byte readers (bounds-checked, no copies of the account)
// ---------------------------------------------------------------------------

fn bytes(d: &[u8], o: usize, n: usize) -> Result<&[u8]> {
    d.get(o..o + n).ok_or_else(|| error!(VaultError::VenueLayoutInvalid))
}
fn u8_at(d: &[u8], o: usize) -> Result<u8> {
    Ok(bytes(d, o, 1)?[0])
}
fn u16_at(d: &[u8], o: usize) -> Result<u16> {
    Ok(u16::from_le_bytes(bytes(d, o, 2)?.try_into().unwrap()))
}
fn u32_at(d: &[u8], o: usize) -> Result<u32> {
    Ok(u32::from_le_bytes(bytes(d, o, 4)?.try_into().unwrap()))
}
fn u64_at(d: &[u8], o: usize) -> Result<u64> {
    Ok(u64::from_le_bytes(bytes(d, o, 8)?.try_into().unwrap()))
}
fn i64_at(d: &[u8], o: usize) -> Result<i64> {
    Ok(i64::from_le_bytes(bytes(d, o, 8)?.try_into().unwrap()))
}
fn u128_at(d: &[u8], o: usize) -> Result<u128> {
    Ok(u128::from_le_bytes(bytes(d, o, 16)?.try_into().unwrap()))
}
fn pubkey_at(d: &[u8], o: usize) -> Result<Pubkey> {
    Ok(Pubkey::new_from_array(bytes(d, o, 32)?.try_into().unwrap()))
}

fn has_disc(a: &AccountInfo, disc: &[u8; 8], size: usize) -> bool {
    if *a.owner != DRIFT_PROGRAM_ID {
        return false;
    }
    match a.try_borrow_data() {
        Ok(d) => d.len() >= size && d[..8] == *disc,
        Err(_) => false,
    }
}

fn check_drift_account(a: &AccountInfo, disc: &[u8; 8], size: usize) -> Result<()> {
    require!(has_disc(a, disc, size), VaultError::VenueAccountInvalid);
    Ok(())
}

/// SPL token account balance (`amount` at offset 64).
fn token_amount(a: &AccountInfo) -> Result<u64> {
    let d = a.try_borrow_data()?;
    u64_at(&d, 64)
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

/// Fixed Drift accounts for trading / capital instructions. Layout inside
/// `remaining_accounts`, after the registry oracles:
///
/// | i | account                                   |
/// |---|-------------------------------------------|
/// | 0 | Drift program (marker)                    |
/// | 1 | Drift `State`                             |
/// | 2 | Drift `User` == `pool.venue_account`      |
/// | 3 | Drift `UserStats` (authority = pool PDA)  |
/// | 4 | USDC spot market vault (`spot_market_vault`, index 0) |
/// | 5 | Drift signer PDA                          |
/// | 6 | pool USDC vault == `pool.vault`           |
/// | 7 | SPL token program                         |
/// | 8… | tail, forwarded verbatim to Drift: oracles…, spot markets…, perp markets… |
pub struct DriftAccounts<'a, 'info> {
    pub pool: &'a AccountInfo<'info>,
    pub program: &'a AccountInfo<'info>,
    pub state: &'a AccountInfo<'info>,
    pub user: &'a AccountInfo<'info>,
    pub user_stats: &'a AccountInfo<'info>,
    pub spot_market_vault: &'a AccountInfo<'info>,
    pub drift_signer: &'a AccountInfo<'info>,
    pub vault: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub tail: &'a [AccountInfo<'info>],
}

fn marker_index(remaining: &[AccountInfo]) -> Result<usize> {
    remaining
        .iter()
        .position(|a| a.key() == DRIFT_PROGRAM_ID)
        .ok_or_else(|| error!(VaultError::VenueAccountsMissing))
}

impl<'a, 'info> DriftAccounts<'a, 'info> {
    pub fn parse(pool: &Pool, accs: &VenueAccounts<'a, 'info>) -> Result<Self> {
        let r = accs.remaining;
        let k = marker_index(r)?;
        require!(r.len() >= k + TRADE_BLOCK_LEN, VaultError::VenueAccountsMissing);
        let b = &r[k..];
        require_keys_eq!(b[2].key(), pool.venue_account, VaultError::VenueAccountInvalid);
        require_keys_eq!(b[6].key(), pool.vault, VaultError::VenueAccountInvalid);
        require_keys_eq!(b[7].key(), anchor_spl::token::ID, VaultError::VenueAccountInvalid);
        check_drift_account(&b[2], &acct::USER, USER_SIZE)?;
        check_drift_account(&b[3], &acct::USER_STATS, USER_STATS_SIZE)?;
        Ok(Self {
            pool: accs.pool,
            program: &b[0],
            state: &b[1],
            user: &b[2],
            user_stats: &b[3],
            spot_market_vault: &b[4],
            drift_signer: &b[5],
            vault: &b[6],
            token_program: &b[7],
            tail: &b[TRADE_BLOCK_LEN..],
        })
    }
}

/// The pool's Drift `User` account, wherever it sits in `accounts`.
fn find_user<'a, 'info>(pool: &Pool, accounts: &'a [AccountInfo<'info>]) -> Result<&'a AccountInfo<'info>> {
    let a = accounts
        .iter()
        .find(|a| a.key() == pool.venue_account)
        .ok_or_else(|| error!(VaultError::VenueAccountsMissing))?;
    check_drift_account(a, &acct::USER, USER_SIZE)?;
    Ok(a)
}

/// Drift `SpotMarket` with `market_index == index`, matched by discriminator.
fn find_spot_market<'a, 'info>(accounts: &'a [AccountInfo<'info>], index: u16) -> Result<&'a AccountInfo<'info>> {
    for a in accounts {
        if !has_disc(a, &acct::SPOT_MARKET, SPOT_MARKET_SIZE) {
            continue;
        }
        let d = a.try_borrow_data()?;
        if u16_at(&d, SM_MARKET_INDEX)? == index {
            drop(d);
            return Ok(a);
        }
    }
    err!(VaultError::VenueAccountsMissing)
}

// ---------------------------------------------------------------------------
// Drift state readers
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default)]
struct PerpSnapshot {
    /// BASE_PRECISION (1e9), signed: >0 long, <0 short.
    base: i64,
    /// QUOTE_PRECISION (1e6), includes fees and funding.
    quote_asset: i64,
    /// QUOTE_PRECISION (1e6), cost basis excluding fees/funding.
    quote_entry: i64,
}

#[derive(Clone, Copy, Debug, Default)]
struct UserSnapshot {
    pos: PerpSnapshot,
    /// `User.cumulative_perp_funding`, QUOTE_PRECISION.
    funding: i64,
    /// `UserStats.fees.total_fee_paid`, QUOTE_PRECISION.
    fee_paid: u64,
}

/// A perp slot is free when Drift's `PerpPosition::is_available()` holds.
fn perp_slot_in_use(user: &[u8], o: usize) -> Result<bool> {
    Ok(i64_at(user, o + PP_BASE_ASSET_AMOUNT)? != 0
        || i64_at(user, o + PP_QUOTE_ASSET_AMOUNT)? != 0
        || u64_at(user, o + PP_LP_SHARES)? != 0
        || u8_at(user, o + PP_OPEN_ORDERS)? != 0)
}

fn perp_at(user: &[u8], o: usize) -> Result<PerpSnapshot> {
    Ok(PerpSnapshot {
        base: i64_at(user, o + PP_BASE_ASSET_AMOUNT)?,
        quote_asset: i64_at(user, o + PP_QUOTE_ASSET_AMOUNT)?,
        quote_entry: i64_at(user, o + PP_QUOTE_ENTRY_AMOUNT)?,
    })
}

/// The user's perp position on `market_index`, if the slot is in use.
fn perp_position(user: &[u8], market_index: u16) -> Result<Option<PerpSnapshot>> {
    for i in 0..PERP_POSITIONS_LEN {
        let o = USER_PERP_POSITIONS + i * PERP_POSITION_SIZE;
        if !perp_slot_in_use(user, o)? {
            continue;
        }
        if u16_at(user, o + PP_MARKET_INDEX)? == market_index {
            return Ok(Some(perp_at(user, o)?));
        }
    }
    Ok(None)
}

fn snapshot(a: &DriftAccounts, market_index: u16) -> Result<UserSnapshot> {
    let ud = a.user.try_borrow_data()?;
    let sd = a.user_stats.try_borrow_data()?;
    Ok(UserSnapshot {
        pos: perp_position(&ud, market_index)?.unwrap_or_default(),
        funding: i64_at(&ud, USER_CUMULATIVE_PERP_FUNDING)?,
        fee_paid: u64_at(&sd, US_TOTAL_FEE_PAID)?,
    })
}

/// Net USDC (spot market 0) token amount held at Drift, in USDC base units.
/// Mirrors `drift::math::spot_balance::get_token_amount`:
/// `scaled_balance × cumulative_interest / 10^(19 − decimals)`.
fn usdc_balance(user: &[u8], spot_market: &[u8]) -> Result<i128> {
    let cum = u128_at(spot_market, SM_CUMULATIVE_DEPOSIT_INTEREST)?;
    let decimals = u32_at(spot_market, SM_DECIMALS)?;
    require!(decimals <= 19, VaultError::VenueLayoutInvalid);
    let div = 10u128.pow(SPOT_CUMULATIVE_INTEREST_PRECISION_EXP + SPOT_BALANCE_PRECISION_EXP - decimals);
    let mut total: i128 = 0;
    for i in 0..SPOT_POSITIONS_LEN {
        let o = USER_SPOT_POSITIONS + i * SPOT_POSITION_SIZE;
        let scaled = u64_at(user, o + SP_SCALED_BALANCE)?;
        if scaled == 0 || u16_at(user, o + SP_MARKET_INDEX)? != QUOTE_SPOT_MARKET_INDEX {
            continue;
        }
        let tok = ((scaled as u128).checked_mul(cum).ok_or(VaultError::MathOverflow)? / div) as i128;
        if u8_at(user, o + SP_BALANCE_TYPE)? == 0 {
            total = total.checked_add(tok).ok_or(VaultError::MathOverflow)?;
        } else {
            total = total.checked_sub(tok).ok_or(VaultError::MathOverflow)?;
        }
    }
    Ok(total)
}

/// Average entry (1e6) from Drift's cost basis: |quote_entry| × 1e9 / |base|.
fn entry_price(p: &PerpSnapshot) -> Result<u64> {
    let b = p.base.unsigned_abs() as u128;
    require!(b > 0, VaultError::PositionNotFound);
    let q = p.quote_entry.unsigned_abs() as u128;
    u64::try_from(q * QTY_SCALE as u128 / b).map_err(|_| VaultError::MathOverflow.into())
}

fn price_of(notional: u64, qty: u64) -> Result<u64> {
    require!(qty > 0, VaultError::VenueNoFill);
    u64::try_from((notional as u128) * (QTY_SCALE as u128) / (qty as u128)).map_err(|_| VaultError::MathOverflow.into())
}

// ---------------------------------------------------------------------------
// CPI plumbing
// ---------------------------------------------------------------------------

fn meta(a: &AccountInfo, writable: bool, signer: bool) -> AccountMeta {
    AccountMeta { pubkey: a.key(), is_signer: signer, is_writable: writable }
}

/// Invoke a Drift instruction signed by the pool PDA. `infos` must contain
/// every account in `metas` plus the Drift program account.
fn invoke_drift(pool: &Pool, metas: Vec<AccountMeta>, infos: Vec<AccountInfo>, data: Vec<u8>) -> Result<()> {
    let index = pool.index.to_le_bytes();
    let bump = [pool.bump];
    let seeds: &[&[u8]] = &[POOL_SEED, pool.trader.as_ref(), &index, &bump];
    let ix = Instruction { program_id: DRIFT_PROGRAM_ID, accounts: metas, data };
    invoke_signed(&ix, &infos, &[seeds]).map_err(Into::into)
}

/// Fixed metas + the pass-through tail (writability as supplied by the client).
fn with_tail<'info>(
    mut metas: Vec<AccountMeta>,
    mut infos: Vec<AccountInfo<'info>>,
    a: &DriftAccounts<'_, 'info>,
) -> (Vec<AccountMeta>, Vec<AccountInfo<'info>>) {
    for t in a.tail {
        metas.push(AccountMeta { pubkey: t.key(), is_signer: false, is_writable: t.is_writable });
        infos.push(t.clone());
    }
    infos.push(a.program.clone());
    (metas, infos)
}

/// `deposit(market_index = 0, amount, reduce_only = false)` from the pool vault.
fn cpi_deposit(pool: &Pool, a: &DriftAccounts, amount: u64) -> Result<()> {
    let mut data = Vec::with_capacity(19);
    data.extend_from_slice(&ix::DEPOSIT);
    data.extend_from_slice(&QUOTE_SPOT_MARKET_INDEX.to_le_bytes());
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(0);
    let metas = vec![
        meta(a.state, false, false),
        meta(a.user, true, false),
        meta(a.user_stats, true, false),
        meta(a.pool, false, true),
        meta(a.spot_market_vault, true, false),
        meta(a.vault, true, false),
        meta(a.token_program, false, false),
    ];
    let infos = vec![
        a.state.clone(),
        a.user.clone(),
        a.user_stats.clone(),
        a.pool.clone(),
        a.spot_market_vault.clone(),
        a.vault.clone(),
        a.token_program.clone(),
    ];
    let (metas, infos) = with_tail(metas, infos, a);
    invoke_drift(pool, metas, infos, data)
}

/// `withdraw(market_index = 0, amount, reduce_only = true)` into the pool
/// vault. `reduce_only` makes Drift cap the amount at the existing deposit
/// (and at its own withdraw-margin limit) instead of opening a borrow.
fn cpi_withdraw(pool: &Pool, a: &DriftAccounts, amount: u64) -> Result<()> {
    let mut data = Vec::with_capacity(19);
    data.extend_from_slice(&ix::WITHDRAW);
    data.extend_from_slice(&QUOTE_SPOT_MARKET_INDEX.to_le_bytes());
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(1);
    let metas = vec![
        meta(a.state, false, false),
        meta(a.user, true, false),
        meta(a.user_stats, true, false),
        meta(a.pool, false, true),
        meta(a.spot_market_vault, true, false),
        meta(a.drift_signer, false, false),
        meta(a.vault, true, false),
        meta(a.token_program, false, false),
    ];
    let infos = vec![
        a.state.clone(),
        a.user.clone(),
        a.user_stats.clone(),
        a.pool.clone(),
        a.spot_market_vault.clone(),
        a.drift_signer.clone(),
        a.vault.clone(),
        a.token_program.clone(),
    ];
    let (metas, infos) = with_tail(metas, infos, a);
    invoke_drift(pool, metas, infos, data)
}

struct OrderSpec {
    market_index: u16,
    is_long: bool,
    base_qty: u64,
    /// 0 = market order (Drift derives the auction from its oracle);
    /// otherwise a limit order, filled only if the AMM crosses it.
    limit_px: u64,
    reduce_only: bool,
}

/// Borsh `OrderParams` (protocol-v2 v2.162.0) followed by
/// `success_condition: Option<u32> = None` (Drift reads that as "no success
/// condition, fill at 100% of the auction").
fn encode_place_and_take(s: &OrderSpec) -> Vec<u8> {
    let mut d = Vec::with_capacity(48);
    d.extend_from_slice(&ix::PLACE_AND_TAKE_PERP_ORDER);
    d.push(if s.limit_px > 0 { 1 } else { 0 }); // OrderType: Market = 0, Limit = 1
    d.push(1); // MarketType::Perp
    d.push(if s.is_long { 0 } else { 1 }); // PositionDirection: Long = 0, Short = 1
    d.push(0); // user_order_id
    d.extend_from_slice(&s.base_qty.to_le_bytes()); // base_asset_amount (1e9)
    d.extend_from_slice(&s.limit_px.to_le_bytes()); // price (1e6)
    d.extend_from_slice(&s.market_index.to_le_bytes());
    d.push(s.reduce_only as u8);
    d.push(0); // PostOnlyParam::None (required by place_and_take)
    d.push(1); // bit_flags: ImmediateOrCancel → unfilled remainder is cancelled
    d.push(0); // max_ts: None
    d.push(0); // trigger_price: None
    d.push(0); // OrderTriggerCondition::Above
    d.push(0); // oracle_price_offset: None
    d.push(0); // auction_duration: None  ─┐ Drift derives market-order auctions
    d.push(0); // auction_start_price: None │ from its oracle when all three are None
    d.push(0); // auction_end_price: None  ─┘
    d.push(0); // success_condition: Option<u32> = None
    d
}

/// Borsh `OrderParams` for a resting reduce-only `TriggerMarket` stop. Same
/// struct `encode_place_and_take` writes, with the trigger fields populated and
/// no `success_condition` tail. `place_perp_order` takes `OrderParams` alone.
///
/// `closes_long` picks both halves of the stop: a long is exited by a **short**
/// order triggered **below** the mark, a short by a long triggered above.
fn encode_place_stop(market_index: u16, closes_long: bool, base_qty: u64, trigger_px: u64) -> Vec<u8> {
    let mut d = Vec::with_capacity(56);
    d.extend_from_slice(&ix::PLACE_PERP_ORDER);
    d.push(2); // OrderType::TriggerMarket
    d.push(1); // MarketType::Perp
    d.push(if closes_long { 1 } else { 0 }); // PositionDirection: exit is the opposite side
    d.push(0); // user_order_id
    d.extend_from_slice(&base_qty.to_le_bytes());
    d.extend_from_slice(&0u64.to_le_bytes()); // price: 0. Market once triggered
    d.extend_from_slice(&market_index.to_le_bytes());
    d.push(1); // reduce_only: never opens or flips a position
    d.push(0); // PostOnlyParam::None
    d.push(0); // bit_flags: not IOC. The order has to rest until it triggers
    d.push(0); // max_ts: None
    d.push(1); // trigger_price: Some
    d.extend_from_slice(&trigger_px.to_le_bytes());
    d.push(if closes_long { 1 } else { 0 }); // OrderTriggerCondition: Below (1) / Above (0)
    d.push(0); // oracle_price_offset: None
    d.push(0); // auction_duration: None
    d.push(0); // auction_start_price: None
    d.push(0); // auction_end_price: None
    d
}

/// `cancel_orders(market_type, market_index, direction)`. All three are
/// `Option`s; passing the perp market narrows the cancel to that market's
/// orders, `None` market clears every resting order on the sub-account.
fn encode_cancel_orders(market_index: Option<u16>) -> Vec<u8> {
    let mut d = Vec::with_capacity(16);
    d.extend_from_slice(&ix::CANCEL_ORDERS);
    match market_index {
        Some(i) => {
            d.push(1); // Some(MarketType)
            d.push(1); // MarketType::Perp
            d.push(1); // Some(market_index)
            d.extend_from_slice(&i.to_le_bytes());
        }
        None => {
            d.push(0); // market_type: None
            d.push(0); // market_index: None
        }
    }
    d.push(0); // direction: None. Both sides
    d
}

/// state, user(mut), authority(signer) + tail. Shared by `place_perp_order`
/// and `cancel_orders`, which take the same account list.
fn cpi_order_admin(pool: &Pool, a: &DriftAccounts, data: Vec<u8>) -> Result<()> {
    let metas = vec![meta(a.state, false, false), meta(a.user, true, false), meta(a.pool, false, true)];
    let infos = vec![a.state.clone(), a.user.clone(), a.pool.clone()];
    let (metas, infos) = with_tail(metas, infos, a);
    invoke_drift(pool, metas, infos, data)
}

fn cpi_place_and_take(pool: &Pool, a: &DriftAccounts, spec: &OrderSpec) -> Result<()> {
    let metas = vec![
        meta(a.state, false, false),
        meta(a.user, true, false),
        meta(a.user_stats, true, false),
        meta(a.pool, false, true),
    ];
    let infos = vec![a.state.clone(), a.user.clone(), a.user_stats.clone(), a.pool.clone()];
    let (metas, infos) = with_tail(metas, infos, a);
    invoke_drift(pool, metas, infos, encode_place_and_take(spec))
}

// ---------------------------------------------------------------------------
// Mirror maintenance
// ---------------------------------------------------------------------------

/// Write the Drift position for `market` into `pool.positions`.
fn mirror(pool: &mut Pool, market: &MarketInfo, p: &PerpSnapshot, now: i64) -> Result<()> {
    let existing = pool.find_position(market.market_id);
    if p.base == 0 {
        if let Some(i) = existing {
            pool.positions[i] = Position::default();
        }
        pool.recount_positions();
        return Ok(());
    }
    let side_ = if p.base > 0 { side::LONG } else { side::SHORT };
    let base_qty = p.base.unsigned_abs();
    let entry = entry_price(p)?;
    match existing {
        Some(i) => {
            let pos = &mut pool.positions[i];
            if pos.side != side_ {
                pos.opened_at = now;
            }
            pos.side = side_;
            pos.cluster = market.cluster;
            pos.base_qty = base_qty;
            pos.entry_price = entry;
        }
        None => {
            let i = pool.free_slot().ok_or(VaultError::TooManyPositions)?;
            pool.positions[i] = Position {
                market_id: market.market_id,
                side: side_,
                cluster: market.cluster,
                base_qty,
                entry_price: entry,
                opened_at: now,
            };
        }
    }
    pool.recount_positions();
    Ok(())
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

impl VenueAdapter for DriftAdapter {
    /// `initialize_user_stats` + `initialize_user(0, pool.name)` (and
    /// `update_user_delegate(0, trader)` only when
    /// `SET_TRADER_AS_DRIFT_DELEGATE`), all with `authority = pool PDA`
    /// (signed via seeds. Drift mainnet requires the authority to sign when
    /// the payer differs) and `payer = trader`.
    /// Remaining-accounts block: [Drift program, State, User PDA, UserStats
    /// PDA, Rent sysvar].
    fn init_sub_account<'info>(
        &self,
        pool: &mut Pool,
        accs: &VenueAccounts<'_, 'info>,
        payer: &AccountInfo<'info>,
        system_program: &AccountInfo<'info>,
    ) -> Result<()> {
        let r = accs.remaining;
        let k = marker_index(r)?;
        require!(r.len() >= k + INIT_BLOCK_LEN, VaultError::VenueAccountsMissing);
        let b = &r[k..];
        let (program, state, user, user_stats, rent) = (&b[0], &b[1], &b[2], &b[3], &b[4]);
        require_keys_eq!(rent.key(), sysvar::rent::ID, VaultError::VenueAccountInvalid);
        require_keys_eq!(system_program.key(), anchor_lang::system_program::ID, VaultError::VenueAccountInvalid);
        // The PDA seeds are enforced by Drift's `init` constraints:
        //   user       = ["user", pool, sub_account_id(0) le]
        //   user_stats = ["user_stats", pool]
        // so a successful CPI proves `user` is sub-account 0 of the pool PDA.
        require!(user.data_is_empty(), VaultError::VenueAccountInvalid);

        // 1. initialize_user_stats
        let metas = vec![
            meta(user_stats, true, false),
            meta(state, true, false),
            meta(accs.pool, false, true),
            meta(payer, true, true),
            meta(rent, false, false),
            meta(system_program, false, false),
        ];
        let infos = vec![
            user_stats.clone(),
            state.clone(),
            accs.pool.clone(),
            payer.clone(),
            rent.clone(),
            system_program.clone(),
            program.clone(),
        ];
        invoke_drift(pool, metas, infos, ix::INITIALIZE_USER_STATS.to_vec())?;

        // 2. initialize_user(sub_account_id = 0, name = pool.name)
        let mut data = Vec::with_capacity(8 + 2 + 32);
        data.extend_from_slice(&ix::INITIALIZE_USER);
        data.extend_from_slice(&SUB_ACCOUNT_ID.to_le_bytes());
        data.extend_from_slice(&pool.name);
        let metas = vec![
            meta(user, true, false),
            meta(user_stats, true, false),
            meta(state, true, false),
            meta(accs.pool, false, true),
            meta(payer, true, true),
            meta(rent, false, false),
            meta(system_program, false, false),
        ];
        let infos = vec![
            user.clone(),
            user_stats.clone(),
            state.clone(),
            accs.pool.clone(),
            payer.clone(),
            rent.clone(),
            system_program.clone(),
            program.clone(),
        ];
        invoke_drift(pool, metas, infos, data)?;

        // 3. update_user_delegate(sub_account_id = 0, delegate = trader)
        if SET_TRADER_AS_DRIFT_DELEGATE {
            let mut data = Vec::with_capacity(8 + 2 + 32);
            data.extend_from_slice(&ix::UPDATE_USER_DELEGATE);
            data.extend_from_slice(&SUB_ACCOUNT_ID.to_le_bytes());
            data.extend_from_slice(pool.trader.as_ref());
            let metas = vec![meta(user, true, false), meta(accs.pool, false, true)];
            let infos = vec![user.clone(), accs.pool.clone(), program.clone()];
            invoke_drift(pool, metas, infos, data)?;
        }

        // Sanity: the account Drift just initialised belongs to this pool.
        {
            let d = user.try_borrow_data()?;
            require!(d.len() >= USER_SIZE && d[..8] == acct::USER, VaultError::VenueLayoutInvalid);
            require_keys_eq!(pubkey_at(&d, USER_AUTHORITY)?, accs.pool.key(), VaultError::VenueAccountInvalid);
            require!(u16_at(&d, USER_SUB_ACCOUNT_ID)? == SUB_ACCOUNT_ID, VaultError::VenueAccountInvalid);
            if SET_TRADER_AS_DRIFT_DELEGATE {
                require_keys_eq!(pubkey_at(&d, USER_DELEGATE)?, pool.trader, VaultError::VenueAccountInvalid);
            }
        }
        pool.venue_account = user.key();
        Ok(())
    }

    /// Rebuild `pool.positions` from the Drift `User`: every perp position
    /// with non-zero base becomes a mirror entry (side from the sign, entry
    /// from Drift's cost basis, `opened_at` preserved when the market and
    /// side match). A position on a market the registry does not know fails
    /// loudly: the guard could not value it.
    fn sync_positions(
        &self,
        pool: &mut Pool,
        accs: &VenueAccounts,
        registry: &MarketRegistry,
        now: i64,
    ) -> Result<()> {
        let user = find_user(pool, accs.remaining)?;
        let ud = user.try_borrow_data()?;
        let mut fresh = [Position::default(); MAX_POSITIONS];
        let mut n = 0usize;
        for i in 0..PERP_POSITIONS_LEN {
            let o = USER_PERP_POSITIONS + i * PERP_POSITION_SIZE;
            if !perp_slot_in_use(&ud, o)? {
                continue;
            }
            let p = perp_at(&ud, o)?;
            if p.base == 0 {
                continue; // flat slot holding unsettled PnL only
            }
            let idx = u16_at(&ud, o + PP_MARKET_INDEX)?;
            let market = registry.markets[..registry.count as usize]
                .iter()
                .find(|m| m.venue_market_index == idx)
                .ok_or(VaultError::VenueMarketUnknown)?;
            require!(n < MAX_POSITIONS, VaultError::TooManyPositions);
            let side_ = if p.base > 0 { side::LONG } else { side::SHORT };
            let opened_at = pool
                .find_position(market.market_id)
                .map(|j| pool.positions[j])
                .filter(|q| q.side == side_)
                .map(|q| q.opened_at)
                .unwrap_or(now);
            fresh[n] = Position {
                market_id: market.market_id,
                side: side_,
                cluster: market.cluster,
                base_qty: p.base.unsigned_abs(),
                entry_price: entry_price(&p)?,
                opened_at,
            };
            n += 1;
        }
        pool.positions = fresh;
        pool.recount_positions();
        Ok(())
    }

    /// Deposit the margin shortfall, then `place_and_take_perp_order`
    /// (market or limit, IOC). The fill is the Drift position delta.
    fn open_position(
        &self,
        pool: &mut Pool,
        accs: &VenueAccounts,
        market: &MarketInfo,
        side_: u8,
        base_qty: u64,
        limit_px: u64,
        _mark: &OraclePrice,
        margin: MarginHint,
        now: i64,
    ) -> Result<Fill> {
        require!(base_qty > 0, VaultError::SizeTooSmall);
        let a = DriftAccounts::parse(pool, accs)?;
        let idx = market.venue_market_index;
        let is_long = side_ == side::LONG;

        // 1. Collateral: top the Drift account up to what the post-trade book
        //    needs at the platform leverage cap. The guard already proved
        //    NAV ≥ required, so the shortfall is always covered by vault cash.
        let have = margin.venue_equity.max(0) as u64;
        let deficit = margin.required_collateral.saturating_sub(have);
        if deficit > 0 {
            let available = token_amount(a.vault)?.min(pool.accounted_usdc);
            let dep = deficit.min(available);
            if dep > 0 {
                cpi_deposit(pool, &a, dep)?;
                pool.accounted_usdc -= dep;
                // Capital moving in is not a realization: raise the baseline
                // with it so the next sync does not read it as profit.
                pool.venue_accounted_quote =
                    pool.venue_accounted_quote.checked_add(dep as i64).ok_or(VaultError::MathOverflow)?;
            }
        }

        // 2. Order, bracketed by snapshots of the Drift state.
        let before = snapshot(&a, idx)?;
        if before.pos.base != 0 {
            require!((before.pos.base > 0) == is_long, VaultError::OppositeSide);
        }
        cpi_place_and_take(pool, &a, &OrderSpec { market_index: idx, is_long, base_qty, limit_px, reduce_only: false })?;
        let after = snapshot(&a, idx)?;

        // 3. Fill = position delta. Opens/increases add the fill's quote
        //    amount to quote_entry_amount before fees (Drift `update_position_and_market`).
        let d_base = after.pos.base.checked_sub(before.pos.base).ok_or(VaultError::MathOverflow)?;
        let filled = if is_long { d_base > 0 } else { d_base < 0 };
        if !filled {
            return err!(if limit_px > 0 { VaultError::LimitNotMet } else { VaultError::VenueNoFill });
        }
        let qty = d_base.unsigned_abs();
        let notional = after.pos.quote_entry.checked_sub(before.pos.quote_entry).ok_or(VaultError::MathOverflow)?.unsigned_abs();
        let fee = after.fee_paid.saturating_sub(before.fee_paid);
        let fill_price = price_of(notional, qty)?;
        if limit_px > 0 {
            let ok = if is_long { fill_price <= limit_px } else { fill_price >= limit_px };
            require!(ok, VaultError::LimitNotMet);
        }

        // 4. Mirror and stats. Fees stay inside Drift (they are already in
        //    quote_asset_amount and therefore in venue equity).
        mirror(pool, market, &after.pos, now)?;
        pool.venue_fees_paid = pool.venue_fees_paid.saturating_add(fee);
        Ok(Fill { fill_price, base_qty: qty, notional, fee, realized_pnl: 0 })
    }

    /// Reduce-only `place_and_take_perp_order` on the opposite side. Exit
    /// notional is reconstructed from Δquote_asset_amount net of the fee and
    /// funding settled in the same call; realized PnL uses the mirrored
    /// average entry so the profit split matches the mock's semantics.
    fn close_position(
        &self,
        pool: &mut Pool,
        accs: &VenueAccounts,
        market: &MarketInfo,
        base_qty: u64,
        limit_px: u64,
        _mark: &OraclePrice,
        now: i64,
    ) -> Result<Fill> {
        let a = DriftAccounts::parse(pool, accs)?;
        let idx = market.venue_market_index;
        let before = snapshot(&a, idx)?;
        require!(before.pos.base != 0, VaultError::PositionNotFound);
        let pos_is_long = before.pos.base > 0;
        let held = before.pos.base.unsigned_abs();
        let qty = if base_qty == 0 { held } else { base_qty.min(held) };
        require!(qty > 0, VaultError::SizeTooSmall);
        // Entry for the realized-PnL calc: the mirror if it exists, else Drift's basis.
        let entry = match pool.find_position(market.market_id) {
            Some(i) => pool.positions[i],
            None => Position {
                market_id: market.market_id,
                side: if pos_is_long { side::LONG } else { side::SHORT },
                cluster: market.cluster,
                base_qty: held,
                entry_price: entry_price(&before.pos)?,
                opened_at: now,
            },
        };

        cpi_place_and_take(
            pool,
            &a,
            &OrderSpec { market_index: idx, is_long: !pos_is_long, base_qty: qty, limit_px, reduce_only: true },
        )?;
        let after = snapshot(&a, idx)?;

        // Δbase must shrink the position (reduce_only guarantees no flip).
        let d_base = before.pos.base.checked_sub(after.pos.base).ok_or(VaultError::MathOverflow)?;
        let reduced = if pos_is_long { d_base > 0 && after.pos.base >= 0 } else { d_base < 0 && after.pos.base <= 0 };
        if !reduced {
            return err!(if limit_px > 0 { VaultError::LimitNotMet } else { VaultError::VenueNoFill });
        }
        let qty_filled = d_base.unsigned_abs();
        let fee = after.fee_paid.saturating_sub(before.fee_paid);
        let funding = (after.funding as i128) - (before.funding as i128);
        // Δquote_asset = ±exit_notional − fee + funding
        let d_quote = (after.pos.quote_asset as i128) - (before.pos.quote_asset as i128);
        let exit_quote = d_quote + (fee as i128) - funding;
        let notional = u64::try_from(exit_quote.unsigned_abs()).map_err(|_| VaultError::MathOverflow)?;
        let fill_price = price_of(notional, qty_filled)?;
        if limit_px > 0 {
            // closing a long sells (price ≥ limit); closing a short buys (price ≤ limit)
            let ok = if pos_is_long { fill_price >= limit_px } else { fill_price <= limit_px };
            require!(ok, VaultError::LimitNotMet);
        }
        let realized = math::pnl(&entry, qty_filled, fill_price)?;

        mirror(pool, market, &after.pos, now)?;
        pool.venue_fees_paid = pool.venue_fees_paid.saturating_add(fee);
        Ok(Fill { fill_price, base_qty: qty_filled, notional, fee, realized_pnl: realized })
    }

    /// Cancel this market's resting orders, then rest a fresh reduce-only
    /// `TriggerMarket`. Cancel-then-place rather than `modify_order` so the
    /// pool never holds two stops for one market if the first call half-fails.
    fn set_stop_order(
        &self,
        pool: &Pool,
        accs: &VenueAccounts,
        market: &MarketInfo,
        position_side: u8,
        base_qty: u64,
        stop_px: u64,
    ) -> Result<()> {
        require!(base_qty > 0 && stop_px > 0, VaultError::InvalidArgument);
        let a = DriftAccounts::parse(pool, accs)?;
        let idx = market.venue_market_index;
        cpi_order_admin(pool, &a, encode_cancel_orders(Some(idx)))?;
        cpi_order_admin(pool, &a, encode_place_stop(idx, position_side == side::LONG, base_qty, stop_px))
    }

    fn cancel_stop_orders(&self, pool: &Pool, accs: &VenueAccounts, market_index: Option<u16>) -> Result<()> {
        let a = DriftAccounts::parse(pool, accs)?;
        cpi_order_admin(pool, &a, encode_cancel_orders(market_index))
    }

    fn read_position(&self, pool: &Pool, market_id: u16) -> Option<Position> {
        // Mirror of the Drift perp position kept on the pool for guard maths.
        pool.find_position(market_id).map(|i| pool.positions[i])
    }

    /// `usdc_balance + Σ quote_asset_amount over flat perp slots`. A flat slot's
    /// quote is realized PnL Drift is holding until `settle_pnl`; settling moves
    /// it into the USDC balance, so the sum is unchanged and the baseline does
    /// not care whether the keeper has settled. Open slots are excluded. Their
    /// quote is cost basis, not a realization. No marks needed: flat slots have
    /// no base to value.
    fn observed_realized_basis(&self, pool: &Pool, accounts: &[AccountInfo]) -> Result<Option<i64>> {
        let user = find_user(pool, accounts)?;
        let spot = find_spot_market(accounts, QUOTE_SPOT_MARKET_INDEX)?;
        let ud = user.try_borrow_data()?;
        let sd = spot.try_borrow_data()?;
        let mut total = usdc_balance(&ud, &sd)?;
        for i in 0..PERP_POSITIONS_LEN {
            let o = USER_PERP_POSITIONS + i * PERP_POSITION_SIZE;
            if !perp_slot_in_use(&ud, o)? {
                continue;
            }
            let p = perp_at(&ud, o)?;
            if p.base != 0 {
                continue;
            }
            total = total.checked_add(p.quote_asset as i128).ok_or(VaultError::MathOverflow)?;
        }
        Ok(Some(i64::try_from(total).map_err(|_| VaultError::MathOverflow)?))
    }

    /// USDC held at Drift + Σ over perp positions of
    /// `quote_asset_amount + base × mark / 1e9` (Drift's unrealized PnL,
    /// fees and settled funding included). Needs the pool's `User` and the
    /// USDC `SpotMarket` somewhere in `accounts`; needs a mark for every
    /// non-flat position (a position on an unregistered market fails loudly).
    fn read_account_equity(&self, pool: &Pool, accounts: &[AccountInfo], marks: &[Mark]) -> Result<i64> {
        let user = find_user(pool, accounts)?;
        let spot = find_spot_market(accounts, QUOTE_SPOT_MARKET_INDEX)?;
        let ud = user.try_borrow_data()?;
        let sd = spot.try_borrow_data()?;
        let mut equity: i128 = usdc_balance(&ud, &sd)?;
        for i in 0..PERP_POSITIONS_LEN {
            let o = USER_PERP_POSITIONS + i * PERP_POSITION_SIZE;
            if !perp_slot_in_use(&ud, o)? {
                continue;
            }
            let p = perp_at(&ud, o)?;
            equity = equity.checked_add(p.quote_asset as i128).ok_or(VaultError::MathOverflow)?;
            if p.base != 0 {
                let idx = u16_at(&ud, o + PP_MARKET_INDEX)?;
                let mark = marks
                    .iter()
                    .find(|m| m.venue_market_index == idx)
                    .ok_or(VaultError::VenueMarketUnknown)?;
                let value = (p.base as i128)
                    .checked_mul(mark.price as i128)
                    .ok_or(VaultError::MathOverflow)?
                    / QTY_SCALE as i128;
                equity = equity.checked_add(value).ok_or(VaultError::MathOverflow)?;
            }
        }
        i64::try_from(equity).map_err(|_| VaultError::MathOverflow.into())
    }

    /// Pull `needed − vault balance` back from the Drift USDC deposit
    /// (reduce-only, so never a borrow). Unsettled perp PnL is not
    /// withdrawable until someone calls Drift's permissionless `settle_pnl`;
    /// the keeper does that off-chain and retries.
    fn ensure_vault_liquidity(&self, pool: &mut Pool, accs: &VenueAccounts, needed: u64) -> Result<bool> {
        let a = DriftAccounts::parse(pool, accs)?;
        let have = token_amount(a.vault)?;
        if have >= needed {
            return Ok(true);
        }
        let deficit = needed - have;
        let spot = find_spot_market(a.tail, QUOTE_SPOT_MARKET_INDEX)?;
        let deposit = {
            let ud = a.user.try_borrow_data()?;
            let sd = spot.try_borrow_data()?;
            usdc_balance(&ud, &sd)?.max(0)
        };
        let amount = deficit.min(u64::try_from(deposit).unwrap_or(u64::MAX));
        if amount == 0 {
            return Ok(false);
        }
        cpi_withdraw(pool, &a, amount)?;
        let got = token_amount(a.vault)?.saturating_sub(have);
        pool.accounted_usdc = pool.accounted_usdc.checked_add(got).ok_or(VaultError::MathOverflow)?;
        // Mirror of the deposit case: capital leaving is not a loss.
        pool.venue_accounted_quote =
            pool.venue_accounted_quote.checked_sub(got as i64).ok_or(VaultError::MathOverflow)?;
        Ok(have.saturating_add(got) >= needed)
    }
}
