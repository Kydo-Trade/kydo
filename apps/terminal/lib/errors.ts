/** Map program error codes (Anchor `err.error.errorCode.code`, or trial-engine error names) to human text.
 *
 * These strings deliberately name no limit VALUES. `explainError` is called from
 * a dozen components that have no platform config in scope, so any figure baked
 * in here drifts the moment a risk parameter moves, which is how this file came
 * to tell traders "> 25 slots" long after the oracle window became 150, and
 * "3× NAV" after the leverage cap became 5×. Where the caller does have the
 * config (the order ticket, via the SDK's `preTradeCheck`), the message is
 * interpolated from it and states the real number. */
export const ERROR_MESSAGES: Record<string, string> = {
  Paused: "Platform is paused by the admin. No trading or lifecycle actions until unpaused",
  Unauthorized: "Unauthorized signer",
  MathOverflow: "Math overflow in the program",
  InvalidArgument: "Invalid argument",
  InvalidTraderStatus: "Your trader profile is not in the required status for this action",
  InCooldown: "You are in the post-failure cooldown. Re-apply once it expires",
  TrialDayOutOfOrder: "Trial days must be committed sequentially and on time",
  TrialDayNotComplete: "This trial day has not ended yet. Commit it after 00:00 UTC of the next day",
  TrialNotComplete: "The trial has not reached 30 committed days yet",
  NotEligible: "Only Eligible traders (passed trial) can create a pool",
  PoolAlreadyExists: "You already have a live pool. One active pool per trader",
  InvalidPoolStatus: "Pool is not in the required status (must be Live to trade, Funding to activate)",
  BelowActivationFloor: "Pool NAV is below the activation floor",
  PromotionConditionsNotMet: "Promotion conditions not met: 30 live days at tier and NAV/share above tier start",
  PositionsOpen: "Pool still has open positions. Close them first",
  SharesOutstanding: "Investor shares are still outstanding",
  MaxTier: "Already at the maximum tier (3)",
  DepositTooSmall: "Deposit is below the platform minimum",
  ExceedsTierCap: "Amount exceeds the tier cap",
  LockupActive: "The post-deposit redemption lockup has not elapsed",
  InsufficientShares: "Insufficient shares",
  RedemptionPending: "A redemption is already pending",
  NoRedemptionPending: "No redemption pending",
  UnwindRequired: "Redemption requires an unwind before settlement",
  NotTraderDelegate: "Signer is not the registered trader delegate of this pool",
  MarketNotFound: "Market not found in the registry",
  MarketDisabled: "Market is disabled by the admin. Closing is still allowed",
  OracleMissing: "Oracle account missing. Include oracles for the traded market and every open position",
  OracleStale: "Oracle price is older than the platform's staleness window. Wait for the keeper's next price push",
  // Retained for completeness: the on-chain confidence ceiling is not enforced
  // at present, so the program does not currently return this.
  OracleConfidence: "Oracle confidence interval is wider than the platform allows. Try again shortly.",
  OracleInvalid: "Oracle account invalid",
  DailyLossBreach: "Daily loss cap breached. Pool will be locked by the keeper",
  DrawdownBreach: "Max drawdown from peak breached. Pool will be locked by the keeper",
  TooManyPositions: "Too many concurrent positions. Close one first",
  LeverageExceeded: "Gross leverage would exceed the platform cap (or this market's own cap)",
  SinglePositionExceeded: "Single position would exceed the per-market cap",
  ClusterExceeded: "Correlated cluster exposure would exceed the cluster cap",
  LimitOutOfBand: "Limit price is outside the allowed band around the oracle price",
  PositionNotFound: "No open position in this market",
  OppositeSide: "Opposite-side order on an open position. Close the position instead",
  MinHoldTime: "Minimum holding time (60s) has not elapsed",
  TooManyTrades: "Max 100 trades per UTC day reached",
  SizeTooSmall: "Trade size too small",
  LimitNotMet: "Fill price would cross your limit. Order not filled",
  NoBreach: "No risk breach detected",
  NothingToUnwind: "Nothing to unwind",
  VenueUnavailable: "Venue adapter not available in this build",
  BountyReserveProtected: "Withdrawal would dip into the bounty reserve",
  NothingToClaim: "Nothing to claim. No vested escrow",
  BelowHighWaterMark: "NAV per share is below the high-water mark. Fees are gated until it recovers",
  MockOracleDisabled: "Mock oracle disabled on this deployment",
  RegistryFull: "Market registry is full",
};

const KNOWN = Object.keys(ERROR_MESSAGES);

export interface ExplainedError {
  code: string | null;
  message: string;
  raw: string;
}

/** Best-effort extraction of an Anchor error code from any thrown value. */
export function explainError(err: unknown): ExplainedError {
  const e = err as any;
  const raw: string = typeof err === "string" ? err : e?.message ?? String(err);
  let code: string | null = e?.error?.errorCode?.code ?? e?.errorCode?.code ?? null;
  if (!code && typeof e?.code === "string" && KNOWN.includes(e.code)) code = e.code;
  if (!code) {
    // trial-engine error names, or "Error Code: X" inside logs/messages
    const m = /Error Code:\s*([A-Za-z]+)/.exec(raw) ?? /AnchorError[^:]*:\s*([A-Za-z]+)/.exec(raw);
    if (m && KNOWN.includes(m[1])) code = m[1];
    else if (KNOWN.includes(raw.trim())) code = raw.trim();
    else {
      const logs: string[] | undefined = e?.logs ?? e?.transactionLogs;
      if (Array.isArray(logs)) {
        for (const l of logs) {
          const mm = /Error Code:\s*([A-Za-z]+)/.exec(l);
          if (mm && KNOWN.includes(mm[1])) {
            code = mm[1];
            break;
          }
        }
      }
    }
  }
  if (!code) {
    for (const k of KNOWN) if (raw.includes(k)) { code = k; break; }
  }
  let message = code ? ERROR_MESSAGES[code] : raw;
  if (!code) {
    if (/InstructionFallbackNotFound|Fallback functions are not supported|InstructionDidNotDeserialize|101\b/.test(raw))
      message =
        "The program deployed on this network does not have this instruction yet. The on-chain program is older than the app. Upgrade the program (anchor upgrade) and retry.";
    else if (/Unknown action/i.test(raw))
      message =
        "The wallet could not simulate this transaction. Most common cause: the wallet is on the wrong network. This app runs on devnet, so in Phantom enable Settings → Developer settings → Testnet mode and pick Solana Devnet, then retry. If the network is right, the wallet needs a little devnet SOL for fees, or the pool/oracle state moved. Retry with a slightly smaller size.";
    else if (/User rejected|rejected the request/i.test(raw)) message = "Transaction rejected in wallet";
    else if (/insufficient funds|0x1\b/.test(raw)) message = "Insufficient funds (SOL for rent/fees or USDC balance)";
    else if (/AccountNotInitialized|could not find account|Account does not exist/i.test(raw))
      message = "A required account does not exist (is your USDC associated token account created?)";
    else if (/429|Too many requests|rate limit/i.test(raw))
      message =
        "The public devnet RPC is rate-limiting this network's IP. Wait a few seconds and retry. Permanent fix: a dedicated RPC key (e.g. Helius) in RPC_URL on the host for the browser, and a separate one in SOLANA_RPC_URL for the services.";
    else if (/Failed to fetch|NetworkError|ECONNREFUSED/i.test(raw)) message = "Service unreachable";
  }
  return { code, message, raw };
}
