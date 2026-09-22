import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { VAULT_PROGRAM_ID } from "@kydo/sdk";

export const env = {
  rpcUrl: process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899",
  wsUrl: process.env.SOLANA_WS_URL,
  programId: new PublicKey(process.env.VAULT_PROGRAM_ID ?? VAULT_PROGRAM_ID),
  databaseUrl: process.env.DATABASE_URL,
  /** pg (default when DATABASE_URL set) | memory */
  store: (process.env.STORE ?? (process.env.DATABASE_URL ? "pg" : "memory")) as "pg" | "memory",
  port: Number(process.env.API_PORT ?? 4000),
  snapshotMs: Number(process.env.SNAPSHOT_INTERVAL_MS ?? 2000),
  /**
   * Cold start (no cursor yet): only replay the newest N program signatures instead of the whole
   * history. On public devnet every signature costs one rate-limited getTransaction, so a full
   * replay of an active program takes hours during which nothing is ingested. Warm starts
   * (cursor present) always replay everything since the cursor.
   */
  backfillMaxSigs: Number(process.env.BACKFILL_MAX_SIGS ?? 400),
  hermesUrl: process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network",
  /**
   * Bearer token for Hermes. The same one the keeper uses. hermes.pyth.network
   * answers 401 to every request without it, so without this the stale-price
   * fallback below could never actually reach Pyth: it 401'd on the first try,
   * cached "hermes dead" for ten minutes, and served Binance spot instead. The
   * charts were then showing exchange prices while claiming to be a Pyth feed.
   */
  hermesAuth: process.env.PYTH_API_KEY ?? process.env.PYTH_HERMES_AUTH ?? "",
  /**
   * Serve Binance spot when Pyth is unreachable and the on-chain oracles are
   * stale. Off by default: a price that is not the one the program marks
   * against is worse than no price. It makes a chart disagree with the
   * liquidation engine, silently. Turn it on only for a demo that must keep
   * drawing through a Pyth outage.
   */
  allowExchangeFallback: /^(1|true|yes)$/i.test(process.env.PRICE_ALLOW_EXCHANGE_FALLBACK ?? ""),
  /** On-chain oracle prices older than this are replaced by live Hermes prices in /prices, the WS feed and charts (0 = never). */
  priceStaleSecs: Number(process.env.PRICE_STALE_SECS ?? 90),
  /** Dev-only test-USDC faucet (never enable against mainnet). Needs the mint-authority keypair. */
  faucetEnabled: process.env.FAUCET_ENABLED === "true",
  faucetKeypair: process.env.FAUCET_KEYPAIR ?? "~/.config/solana/id.json",
  usdcMint: process.env.USDC_MINT,
  faucetMaxUsd: Number(process.env.FAUCET_MAX_USD ?? 10_000),
  /** Claim cooldown per wallet (design: once per 72 hours). */
  faucetCooldownHours: Number(process.env.FAUCET_COOLDOWN_HOURS ?? 72),
  /** Reverse-proxy hops in front of the API, for `req.ip`. The service is published
   *  behind a TLS proxy (see docker-compose header), so without this every request
   *  carries the PROXY's address and any per-IP limit throttles all users at once.
   *  A hop count (not `true`) is what makes X-Forwarded-For unspoofable: Fastify
   *  counts back from the right, so a client-supplied entry on the left is ignored.
   *  Set 0 when the API is exposed directly. */
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 1),
  /** Ceiling on faucet drips per hour across the whole service. The per-wallet
   *  cooldown and the per-IP limit can both be worked around (wallets are free,
   *  IPs are rentable); this one cannot, and it is what actually bounds how fast
   *  the faucet key's SOL can be drained. */
  faucetGlobalPerHour: Number(process.env.FAUCET_GLOBAL_PER_HOUR ?? 60),
  hedgeWindowSecs: Number(process.env.HEDGE_WINDOW_SECS ?? 300),
  hedgeNotionalTolerance: Number(process.env.HEDGE_NOTIONAL_TOLERANCE ?? 0.25),
  /** Alert delivery (section 4.6): generic JSON webhook and/or a Slack incoming webhook. Empty = log only. */
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || undefined,
  alertSlackWebhookUrl: process.env.ALERT_SLACK_WEBHOOK_URL || undefined,
  /** Alerts older than this (e.g. replayed during a cold backfill) are stored but not delivered. */
  alertMaxAgeSecs: Number(process.env.ALERT_MAX_AGE_SECS ?? 600),
  /** Public investor-app base URL used for links inside alert messages. */
  publicInvestorUrl: (process.env.PUBLIC_INVESTOR_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  logLevel: process.env.LOG_LEVEL ?? "info",
};
