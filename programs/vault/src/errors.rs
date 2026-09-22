use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("Platform is paused")]
    Paused,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid argument")]
    InvalidArgument,

    // --- trader lifecycle ---
    #[msg("Trader already has an active profile state that forbids this action")]
    InvalidTraderStatus,
    #[msg("Trader is in post-failure cooldown")]
    InCooldown,
    #[msg("Trial day must be committed sequentially and on time")]
    TrialDayOutOfOrder,
    #[msg("Trial day is not yet complete")]
    TrialDayNotComplete,
    #[msg("Trial has not reached its full duration")]
    TrialNotComplete,
    #[msg("Trader is not eligible")]
    NotEligible,
    #[msg("Trader already has a live pool")]
    PoolAlreadyExists,

    // --- pool lifecycle ---
    #[msg("Pool is not in the required status")]
    InvalidPoolStatus,
    #[msg("Pool NAV is below the activation floor")]
    BelowActivationFloor,
    #[msg("Promotion conditions not met")]
    PromotionConditionsNotMet,
    #[msg("Pool has open positions")]
    PositionsOpen,
    #[msg("Pool still has investor shares outstanding")]
    SharesOutstanding,
    #[msg("Already at maximum tier")]
    MaxTier,
    #[msg("Not enough earned profit to fund the first-loss cushion for the next tier: keep trading, or claim the profit and stay at this cap")]
    InsufficientFirstLoss,
    #[msg("Market must be disabled before it can be removed")]
    MarketStillEnabled,

    // --- capital ---
    #[msg("Deposit below minimum")]
    DepositTooSmall,
    #[msg("Deposit would exceed the tier cap")]
    ExceedsTierCap,
    #[msg("Redemption lockup has not elapsed")]
    LockupActive,
    #[msg("Insufficient shares")]
    InsufficientShares,
    #[msg("A redemption is already pending")]
    RedemptionPending,
    #[msg("No redemption pending")]
    NoRedemptionPending,
    #[msg("Redemption requires an unwind before settlement")]
    UnwindRequired,

    // --- trading / guard ---
    #[msg("Signer is not the registered trader delegate")]
    NotTraderDelegate,
    #[msg("Market not found in registry")]
    MarketNotFound,
    #[msg("Market is disabled")]
    MarketDisabled,
    #[msg("Oracle account missing for a market")]
    OracleMissing,
    #[msg("Oracle is stale")]
    OracleStale,
    #[msg("Oracle confidence too wide")]
    OracleConfidence,
    #[msg("Oracle account invalid")]
    OracleInvalid,
    #[msg("Daily loss cap breached")]
    DailyLossBreach,
    #[msg("Max drawdown breached")]
    DrawdownBreach,
    #[msg("Too many open positions")]
    TooManyPositions,
    #[msg("Gross leverage limit exceeded")]
    LeverageExceeded,
    #[msg("Single position limit exceeded")]
    SinglePositionExceeded,
    #[msg("Cluster exposure limit exceeded")]
    ClusterExceeded,
    #[msg("Limit price outside the oracle band")]
    LimitOutOfBand,
    #[msg("Position not found")]
    PositionNotFound,
    #[msg("Opposite-side order on an open position: use close_trade")]
    OppositeSide,
    #[msg("Minimum holding time not elapsed")]
    MinHoldTime,
    #[msg("Max trades per day reached")]
    TooManyTrades,
    #[msg("Trade size too small")]
    SizeTooSmall,
    #[msg("Fill would exceed limit price")]
    LimitNotMet,
    #[msg("Stop must sit below the mark on a long and above it on a short")]
    StopWrongSide,

    // --- risk ---
    #[msg("No risk breach detected")]
    NoBreach,
    #[msg("Nothing to unwind")]
    NothingToUnwind,

    // --- venue ---
    #[msg("Venue adapter not available in this build")]
    VenueUnavailable,

    // --- treasury ---
    #[msg("Withdrawal would dip into the ring-fenced bounty reserve")]
    BountyReserveProtected,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("NAV per share is below the high-water mark")]
    BelowHighWaterMark,
    #[msg("Mock oracle is disabled on this deployment")]
    MockOracleDisabled,
    #[msg("Registry is full")]
    RegistryFull,

    // --- venue (Drift) ---
    #[msg("Venue accounts missing from remaining accounts")]
    VenueAccountsMissing,
    #[msg("Venue account does not match the pool's venue sub-account or vault")]
    VenueAccountInvalid,
    #[msg("Venue account data has an unexpected layout")]
    VenueLayoutInvalid,
    #[msg("Venue returned no fill")]
    VenueNoFill,
    #[msg("Venue holds a position on a market that is not in the registry")]
    VenueMarketUnknown,
    #[msg("Pool vault lacks USDC for this payout: settle venue PnL and retry")]
    InsufficientVaultLiquidity,

    // --- pool duration ---
    #[msg("Pool has reached its end date: no new deposits or trades")]
    PoolExpired,
    #[msg("Only the pool's trader may do this (or anyone, once the pool has expired)")]
    NotPoolTrader,

    // --- CommonPool / funding queue ---
    #[msg("CommonPool deposits are disabled on this deployment")]
    CommonDepositsDisabled,
    #[msg("deposit_common needs exactly one (pool, position) pair per active stake, in ascending pool order")]
    WrongStakeAccounts,
    #[msg("Only the ticket at the head of the funding queue can be processed")]
    TicketOutOfOrder,
    #[msg("CommonPool idle reserve cannot cover this allocation")]
    InsufficientIdleReserve,
    #[msg("The funding queue only funds MockPerps pools until the Drift path is verified")]
    QueueVenueUnsupported,
    #[msg("The CommonPool has no redemption backlog to pull for")]
    NoPullNeeded,
    #[msg("The CommonPool's idle reserve does not yet cover this settlement. It refills when a pool locks")]
    IdleShortfall,
    #[msg("Only a locked pool's capital is pulled back. A healthy pool is never redeemed out from under its trader")]
    PoolNotLocked,
    #[msg("This trader's fee is not forfeit: their attempt is still live, or there is nothing held")]
    FeeNotForfeited,
    #[msg("Investors cannot fund a trader directly. Deposit into the CommonPool, which funds traders in queue order. `deposit` seeds a trader's own pool to the activation floor and is theirs alone")]
    DirectDepositDisabled,
    #[msg("The trader's claim window on a voluntarily closed pool has not expired. Their escrow cannot be folded into the reap yet")]
    ClaimGraceActive,
}
