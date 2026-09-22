/** REST + WS API. */
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { createHash } from "crypto";
import Fastify from "fastify";
import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import { env } from "./config";
import { clusterName, Faucet } from "./faucet";
import type { Snapshotter } from "./snapshot";
import type { Store } from "./store";
import type { Ingestor } from "./ingest";
import { equityView, f, maxDrawdownOf, plain, poolSummary, positionsView, navOf, npsOf, statusOf, tradeView, traderSummary, usd, USD } from "./views";
import type { Hub } from "./ws";

export function buildApi(store: Store, snap: Snapshotter, hub: Hub, ingest: Ingestor, faucet: Faucet | null) {
  // `trustProxy` so `req.ip` is the real client: the API runs behind a TLS proxy,
  // and without this every request reports the proxy's address, which turns any
  // per-IP limit into a global one that locks out all users at once.
  const app = Fastify({ logger: { level: env.logLevel }, trustProxy: env.trustProxyHops });
  app.register(cors, { origin: true });
  app.register(websocket);

  const now = () => Math.floor(Date.now() / 1000);
  const cluster = clusterName(env.rpcUrl);
  const tierCaps = () => (snap.config?.tierCaps ?? []).map((x: any) => f(x));

  async function summaryFor(row: { address: string; data: any }, counts: Map<string, number>) {
    const profile = (await store.trader(row.data.trader))?.data ?? null;
    const strategy = await store.strategy(row.address);
    const marks = await store.navMarks(row.address, undefined, undefined, 5000);
    return poolSummary({
      address: row.address,
      pool: row.data,
      markets: snap.markets,
      prices: snap.prices,
      profile,
      strategy,
      tierCaps: tierCaps(),
      investorCount: counts.get(row.address) ?? 0,
      maxDrawdown: maxDrawdownOf(marks),
      now: now(),
      risk: snap.config?.risk ?? null,
    });
  }

  app.get("/health", async () => ({
    ok: true,
    slot: snap.lastSlot,
    lagMs: snap.lastRunMs,
    lastEventTs: ingest.lastEventTs,
    wsClients: hub.size,
    cluster,
    rpcUrl: env.rpcUrl,
    faucet: !!faucet,
    /** How old the freshest served price is and where prices come from ("hermes"/"mixed" = on-chain oracles stale, live fallback active). */
    priceAgeSecs: snap.prices.size ? Math.max(0, Math.floor(Date.now() / 1000) - Math.max(...[...snap.prices.values()].map((p) => p.ts))) : null,
    priceSource: snap.priceSource,
    usdcMint: snap.config?.usdcMint?.toBase58?.() ?? null,
    alerts: ingest.alertSinks,
  }));

  /** Dev-only: test USDC + SOL for a wallet. Disabled unless FAUCET_ENABLED=true.
   *  Cooldown per wallet with a claim history the UI lists. */
  interface DripRow {
    ts: number;
    usd: number;
    sol: number;
    ok: boolean;
    error?: string;
    sig?: string;
  }
  // The cooldown timestamp is deliberately NOT derived from `drips`.
  //
  // It used to be: `lastOk` scanned the history, and the history was trimmed to
  // the last 20 rows from the FRONT. While every rejected attempt, including
  // the cooldown's own 429, appended a row, so ~21 requests pushed the
  // successful drip out of the window, `lastOk` came back undefined and the
  // cooldown lifted. The limiter defeated itself under exactly the load it
  // existed to stop. `drips` is now display-only; the gate reads `lastOkAt`,
  // which nothing trims.
  const drips = new Map<string, DripRow[]>();
  const lastOkAt = new Map<string, number>();
  const cooldownMs = () => env.faucetCooldownHours * 3600_000;
  // …and it is persisted, because the map is per-process and a deploy restarts
  // the indexer. Every push to main used to reset every cooldown. Falls back to
  // the in-memory store when DATABASE_URL is unset, which is the best available.
  const ckey = (w: string) => `faucet:lastok:${w}`;
  const lastOk = async (w: string): Promise<number> => {
    const cached = lastOkAt.get(w);
    if (cached !== undefined) return cached;
    const v = Number((await store.getCursor(ckey(w))) ?? 0);
    lastOkAt.set(w, v);
    return v;
  };
  const setLastOk = async (w: string, ts: number) => {
    lastOkAt.set(w, ts);
    await store.setCursor(ckey(w), String(ts));
  };
  const record = (w: string, row: DripRow) => {
    const list = drips.get(w) ?? [];
    list.push(row);
    if (list.length > 20) list.splice(0, list.length - 20);
    drips.set(w, list);
    // Bound the map itself: `wallet` is caller-supplied and pubkeys are free, so
    // an unbounded map is a memory-exhaustion vector on a public endpoint.
    if (drips.size > 5_000) for (const k of [...drips.keys()].slice(0, drips.size - 5_000)) drips.delete(k);
  };

  // Per-IP token bucket over the whole faucet route. The per-wallet cooldown
  // cannot stand on its own: wallets are free to generate, so without this a
  // script mints from an endless supply of fresh ones, and each fresh wallet
  // costs the faucet key up to 0.5 SOL once the devnet airdrop starts throttling
  // (faucet.ts falls back to a direct transfer), which empties it for real users.
  const FAUCET_IP_MAX = 5;
  const WINDOW_MS = 3600_000;
  const ipHits = new Map<string, number[]>();
  const ipAllowed = (ip: string): boolean => {
    const cutoff = Date.now() - WINDOW_MS;
    const hits = (ipHits.get(ip) ?? []).filter((t) => t > cutoff);
    if (ipHits.size > 10_000) ipHits.clear(); // coarse, but never unbounded
    if (hits.length >= FAUCET_IP_MAX) {
      ipHits.set(ip, hits);
      return false;
    }
    hits.push(Date.now());
    ipHits.set(ip, hits);
    return true;
  };

  // The backstop. Per-wallet and per-IP limits are both evadable. Wallets are
  // free, IPs are rentable, so neither actually bounds the damage. This does:
  // whatever else happens, the faucet key cannot be drained faster than this.
  let globalHits: number[] = [];
  const globalAllowed = (): boolean => {
    const cutoff = Date.now() - WINDOW_MS;
    globalHits = globalHits.filter((t) => t > cutoff);
    if (globalHits.length >= env.faucetGlobalPerHour) return false;
    globalHits.push(Date.now());
    return true;
  };

  /** What a single claim is worth. `/faucet` clamps to this, not to
   *  FAUCET_MAX_USD: status advertised 1,000 while `drip` clamped to the
   *  10,000 default, so a direct POST of {"usd": 10000} got 10x what the UI
   *  offers. FAUCET_MAX_USD stays the hard ceiling above this.
   *
   *  1,200 is the instant-funding seat price. `max(entryFee × 1.5, 20% of the
   *  instant cap)`, which is `max(1200, 1000)` at the shipped $800 entry fee
   *  and $5,000 Tier-1 cap. One claim therefore covers one instant funding, so
   *  a new wallet is not sent back to the faucet mid-onboarding. It is NOT
   *  derived from on-chain config: this route answers before a caller has a
   *  wallet, let alone a pool, and a faucet that changed its payout whenever
   *  params moved would make the cooldown unpredictable. If `entryFeeUsd` or
   *  the Tier-1 cap changes, re-derive this by hand. The instant-funding path
   *  in StatusCard.tsx owns the real formula. */
  const claimUsd = () => Math.min(1_200, env.faucetMaxUsd);

  app.get<{ Querystring: { wallet?: string } }>("/faucet/status", async (req, reply) => {
    if (!faucet) return reply.code(404).send({ ok: false, error: "faucet disabled on this deployment" });
    const w = String(req.query.wallet ?? "");
    const last = w ? await lastOk(w) : 0;
    const nextAt = last ? Math.floor((last + cooldownMs()) / 1000) : 0;
    return {
      ok: true,
      cooldownHours: env.faucetCooldownHours,
      claimUsd: claimUsd(),
      canClaim: !last || Date.now() >= last + cooldownMs(),
      nextAt,
      history: (drips.get(w) ?? []).slice(-8).reverse().map((d) => ({ ts: Math.floor(d.ts / 1000), usd: d.usd, sol: d.sol, ok: d.ok, error: d.error })),
    };
  });

  app.post<{ Body: { wallet: string; usd?: number; sol?: number } }>("/faucet", async (req, reply) => {
    if (!faucet) return reply.code(404).send({ ok: false, error: "faucet disabled on this deployment" });
    let wallet: PublicKey;
    try {
      wallet = new PublicKey(String(req.body?.wallet ?? ""));
    } catch {
      return reply.code(400).send({ ok: false, error: "invalid wallet address" });
    }
    const w = wallet.toBase58();
    const last = await lastOk(w);
    if (last && Date.now() < last + cooldownMs()) {
      // Not recorded: a rejected attempt is not a claim, and appending one here
      // is what used to evict the success row and unlock the cooldown.
      const error = `faucet can only be used once per ${env.faucetCooldownHours} hours`;
      return reply.code(429).send({ ok: false, error, nextAt: Math.floor((last + cooldownMs()) / 1000) });
    }
    if (!ipAllowed(req.ip)) {
      return reply
        .code(429)
        .send({ ok: false, error: `too many faucet requests from this address. At most ${FAUCET_IP_MAX} per hour` });
    }
    if (!globalAllowed()) {
      req.log.warn({ wallet: w, ip: req.ip }, "faucet global hourly cap reached");
      return reply.code(429).send({ ok: false, error: "the faucet is busy right now. Please try again later" });
    }
    // Clamp to one advertised claim. The caller no longer picks the size.
    // `finite` matters: {"usd":"abc"} yields NaN, which survives min/max and
    // reaches `BigInt(Math.round(NaN))` in mintTo as a thrown RangeError.
    const finite = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
    const usd = Math.min(Math.max(0, finite(req.body?.usd, claimUsd())), claimUsd());
    const sol = Math.min(Math.max(0, finite(req.body?.sol, 2)), 2);
    try {
      // Stamp the cooldown BEFORE the drip: `drip` is several seconds of RPC,
      // and concurrent requests for the same wallet would otherwise all pass the
      // gate and mint. Rolled back below if the drip fails, so a genuine error
      // does not cost the user their turn.
      await setLastOk(w, Date.now());
      const r = await faucet.drip(wallet, usd, sol);
      record(w, { ts: Date.now(), usd: r.usd, sol: r.sol, ok: true, sig: r.sigs[0] });
      req.log.info({ wallet: w, usd: r.usd, sol: r.sol, ata: r.ata }, "faucet drip");
      return { ok: true, cluster, mint: faucet.mint.toBase58(), ...r };
    } catch (e) {
      await setLastOk(w, last);
      const error = String((e as Error).message ?? e);
      record(w, { ts: Date.now(), usd, sol: 0, ok: false, error });
      return reply.code(500).send({ ok: false, error });
    }
  });

  app.get("/config", async () => {
    const c = snap.config;
    if (!c) return { error: "not ready" };
    return {
      programId: env.programId.toBase58(),
      usdcMint: c.usdcMint.toBase58(),
      entryFee: usd(c.entryFee),
      tierCaps: c.tierCaps.map(usd),
      vestDays: c.vestDays,
      activationFloor: usd(c.activationFloor),
      minDeposit: usd(c.minDeposit),
      keeperBounty: usd(c.keeperBounty),
      paused: c.paused,
      risk: plain(c.risk),
      trial: { ...plain(c.trial), startingBalance: usd(c.trial.startingBalance) },
    };
  });

  /**
   * Funding capacity. "is there money to fund the next trader right now?".
   *
   * `fund_next_in_queue` puts in `cap − first-loss cushion` and refuses to take
   * idle below the reserve floor, so this mirrors that arithmetic exactly
   * rather than guessing: anything else and onboarding would promise instant
   * funding the chain then rejects with InsufficientIdleReserve.
   *
   *   deployable = accounted_idle − reserve_bps × accounted_idle
   *   allocation(cap) = cap − min_first_loss_bps × cap
   *   fundable(cap) ⇔ deployable ≥ allocation(cap)
   *
   * `maxFundableCapUsd` inverts that: the largest tier cap the queue head could
   * be funded to on this idle balance. Zero queue depth and a fundable cap mean
   * a trader joining now is funded on the spot.
   */
  app.get("/common-pool", async () => {
    const cp = snap.commonPool;
    const cfg = snap.config;
    if (!cp || !cfg) return { ready: false };
    const idle = usd(cp.accountedIdle);
    const reserveBps = Number(cp.reserveBps ?? 0);
    const minFirstLossBps = Number(cfg.minFirstLossBps ?? 0);
    const deployable = Math.max(0, idle - (idle * reserveBps) / 10_000);
    const allocationOf = (cap: number) => cap - (cap * minFirstLossBps) / 10_000;
    const caps: number[] = tierCaps();
    const queueDepth = Math.max(0, f(cp.nextTicket) - f(cp.nextToFund));
    return {
      ready: true,
      idleUsd: idle,
      deployableUsd: deployable,
      reserveBps,
      minFirstLossBps,
      depositEnabled: !!cp.depositEnabled,
      activeStakes: Number(cp.activeStakes ?? 0),
      depositedTotalUsd: usd(cp.depositedTotal),
      fundedTotalUsd: usd(cp.fundedTotal),
      queueDepth,
      nextTicket: f(cp.nextTicket),
      nextToFund: f(cp.nextToFund),
      /** Largest cap fundable from idle right now (0 when nothing is). */
      maxFundableCapUsd: minFirstLossBps >= 10_000 ? 0 : deployable / (1 - minFirstLossBps / 10_000),
      /** Per configured tier: could a trader at this cap be funded from idle now? */
      fundableByTier: caps.map((cap, i) => ({ tier: i + 1, capUsd: cap, fundable: deployable >= allocationOf(cap) })),
    };
  });

  app.get("/markets", async () => {
    // Real open interest: sum of open position notional across every pool, per market.
    const oi = new Map<number, number>();
    for (const row of await store.pools()) {
      for (const pos of (row.data.positions ?? []) as { marketId: number; side: number; baseQty: string }[]) {
        if (!pos || pos.side === 0) continue;
        const px = snap.prices.get(pos.marketId)?.price ?? 0;
        oi.set(pos.marketId, (oi.get(pos.marketId) ?? 0) + (Number(pos.baseQty) / 1e9) * px);
      }
    }
    return {
    markets: snap.markets.map((m) => ({
      marketId: m.marketId,
      symbol: m.symbol,
      oracle: m.oracle.toBase58(),
      cluster: m.cluster,
      maxLeverageBps: m.maxLeverageBps,
      enabled: m.enabled,
      venueMarketIndex: m.venueMarketIndex,
      price: snap.prices.get(m.marketId) ?? null,
      oiUsd: oi.get(m.marketId) ?? 0,
    })),
    };
  });

  app.get("/prices", async () => Object.fromEntries([...snap.prices.entries()].map(([k, v]) => [String(k), v])));

  /**
   * Chart history: OHLC bars from Binance spot klines (the same exchange as the stale-price
   * fallback. Display-only, the risk math never reads it).
   *   tf     1m | 5m | 15m | 1h | 4h | 1d   (default 1m)
   *   from/to  unix seconds. The range TradingView's getBars asks for (optional)
   *   limit    max bars (default 4320 for the legacy recent-history call, cap 4320)
   * Recent no-range 1m requests are cached 60 s per market; ranged requests go straight through.
   */
  const TFS: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
  // `limit` is part of the entry, not the key: a 24-bar request and a 4320-bar
  // request share a market+tf, and serving the short array to the long request
  // silently truncated the deep chart history for a minute. Keyed by market+tf
  // so the cache stays small; a hit only counts when it holds at least as many
  // bars as the caller asked for.
  const klineCache = new Map<string, { at: number; limit: number; candles: { time: number; open: number; high: number; low: number; close: number; v?: number }[] }>();
  app.get<{ Querystring: Record<string, string> }>("/candles", async (req, reply) => {
    const marketId = Number(req.query.marketId);
    const tf = TFS[req.query.tf ?? "1m"] ? (req.query.tf ?? "1m") : null;
    const limit = Math.min(4320, Math.max(10, Number(req.query.limit ?? 4320)));
    const from = Number(req.query.from) || undefined; // unix secs
    const to = Number(req.query.to) || undefined;
    const m = snap.markets.find((x) => x.marketId === marketId);
    if (!m) return reply.code(404).send({ ok: false, error: "unknown marketId" });
    if (!tf) return reply.code(400).send({ ok: false, error: `tf must be one of ${Object.keys(TFS).join(", ")}` });
    const cacheKey = `${marketId}:${tf}`;
    const cacheable = !from && !to;
    const hit = cacheable ? klineCache.get(cacheKey) : undefined;
    if (hit && Date.now() - hit.at < 60_000 && hit.limit >= limit) return { marketId, tf, candles: hit.candles.slice(-limit) };
    const base = m.symbol.toUpperCase().replace(/-?(PERP|USD[CT]?)$/, "");
    const out: { time: number; open: number; high: number; low: number; close: number; v?: number }[] = [];
    try {
      let endTime = to ? to * 1000 : Date.now();
      const startTime = from ? from * 1000 : undefined;
      for (let got = 0; got < limit; ) {
        const batch = Math.min(1000, limit - got);
        const range = startTime ? `&startTime=${startTime}` : "";
        const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${base}USDT&interval=${tf}&limit=${batch}&endTime=${endTime}${range}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`binance ${res.status}`);
        const rows = (await res.json()) as [number, string, string, string, string, string][];
        if (!rows.length) break;
        out.unshift(...rows.map((r) => ({ time: Math.floor(r[0] / 1000), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), v: Number(r[5]) || 0 })));
        got += rows.length;
        endTime = rows[0][0] - 1;
        if (rows.length < batch || (startTime && rows[0][0] <= startTime)) break;
      }
    } catch (e) {
      req.log.warn({ err: String(e), market: m.symbol }, "kline history failed");
      if (hit) return { marketId, tf, candles: hit.candles.slice(-limit) }; // stale cache beats nothing
      return reply.code(502).send({ ok: false, error: `history unavailable (${String((e as Error).message ?? e)})` });
    }
    const candles = from ? out.filter((c) => c.time >= from && (!to || c.time <= to)) : out;
    if (cacheable) klineCache.set(cacheKey, { at: Date.now(), limit, candles: out });
    return { marketId, tf, candles: candles.slice(-limit) };
  });

  app.get<{ Querystring: Record<string, string> }>("/prices/history", async (req) => {
    const from = req.query.from ? Number(req.query.from) : 0;
    const to = req.query.to ? Number(req.query.to) : Number.MAX_SAFE_INTEGER;
    const ids = req.query.marketId ? [Number(req.query.marketId)] : [...snap.history.keys()];
    const out: Record<string, { ts: number; price: number }[]> = {};
    for (const id of ids) out[String(id)] = (snap.history.get(id) ?? []).filter((t) => t.ts >= from && t.ts <= to);
    return { history: out };
  });

  app.get<{ Querystring: Record<string, string> }>("/pools", async (req) => {
    const q = req.query;
    const counts = await store.investorCounts();
    let rows = await store.pools();
    if (q.status) rows = rows.filter((r) => statusOf(r.data.status) === q.status);
    if (q.mandate) rows = rows.filter((r) => statusOf(r.data.mandate) === q.mandate);
    let pools = await Promise.all(rows.map((r) => summaryFor(r, counts).then((x) => x.summary)));
    if (q.minAgeDays) pools = pools.filter((p) => p.ageDays >= Number(q.minAgeDays));
    if (q.maxDrawdown) pools = pools.filter((p) => p.maxDrawdown <= Number(q.maxDrawdown));
    const sortKey =
      ({ roi: "roi", perf: "perf", drawdown: "maxDrawdown", age: "ageDays", tvl: "tvl", health: "healthFactor" } as Record<string, string>)[q.sort ?? "tvl"] ??
      "tvl";
    // Descending is right for return and size. Most first. For health it is
    // backwards: a health sort is a risk sort, and the pool a caller needs to
    // see is the one closest to its floor, not the safest one.
    const dir = q.order ? (q.order === "asc" ? 1 : -1) : sortKey === "healthFactor" ? 1 : -1;
    pools.sort((a: any, b: any) => (a[sortKey] - b[sortKey]) * dir);
    const total = pools.length;
    const offset = Number(q.offset ?? 0);
    const limit = Number(q.limit ?? 50);
    return { pools: pools.slice(offset, offset + limit), total };
  });

  /**
   * Liquidation queue for bots: every live pool ranked by how close it is to
   * its trigger, closest first. `healthFactor <= 1` is liquidatable now.
   * `?max=1.05` returns only pools within 5% of the trigger, so a bot can poll
   * this one endpoint instead of simulating NAV for every pool on chain.
   */
  app.get<{ Querystring: Record<string, string> }>("/pools/at-risk", async (req) => {
    const counts = await store.investorCounts();
    const rows = (await store.pools()).filter((r) => statusOf(r.data.status) === "live");
    const pools = (await Promise.all(rows.map((r) => summaryFor(r, counts).then((x) => x.summary))))
      .filter((p: any) => p.healthFactor !== null)
      .sort((a: any, b: any) => a.healthFactor - b.healthFactor);
    const max = req.query.max ? Number(req.query.max) : Infinity;
    const within = pools.filter((p: any) => p.healthFactor <= max);
    return {
      pools: within.slice(0, Number(req.query.limit ?? 100)).map((p: any) => ({
        address: p.address,
        trader: p.trader,
        nav: p.nav,
        healthFactor: p.healthFactor,
        distanceToLiquidation: p.distanceToLiquidation,
        liquidationFloors: p.liquidationFloors,
        firstLossSeed: p.firstLossSeed,
        openPositions: p.openPositions,
        lastMarkTs: p.lastMarkTs,
      })),
      total: within.length,
      liquidatable: pools.filter((p: any) => p.healthFactor <= 1).length,
    };
  });

  app.get<{ Params: { address: string } }>("/pools/:address", async (req, reply) => {
    const row = await store.pool(req.params.address);
    if (!row) return reply.code(404).send({ error: "pool not found" });
    const counts = await store.investorCounts();
    const { summary, positions, extra } = await summaryFor(row, counts);
    const marks = await store.navMarks(row.address, undefined, undefined, 2000);
    const trades = await store.trades(row.address, 100);
    return { ...summary, ...extra, positions, equity: marks.map(equityView), trades: trades.map((t) => tradeView(t, snap.markets)) };
  });

  app.get<{ Params: { address: string }; Querystring: Record<string, string> }>("/pools/:address/trades", async (req) => {
    const trades = await store.trades(req.params.address, Number(req.query.limit ?? 100), req.query.before ? Number(req.query.before) : undefined);
    return { trades: trades.map((t) => tradeView(t, snap.markets)) };
  });

  app.get<{ Params: { address: string }; Querystring: Record<string, string> }>("/pools/:address/equity", async (req) => {
    const marks = await store.navMarks(req.params.address, req.query.from ? Number(req.query.from) : undefined, req.query.to ? Number(req.query.to) : undefined, 5000);
    return { points: marks.map(equityView) };
  });

  app.post<{ Params: { address: string }; Body: { text: string } }>("/pools/:address/strategy", async (req, reply) => {
    let row = await store.pool(req.params.address);
    if (!row) {
      // A fresh create_pool races the snapshot cycle. Check the chain before saying no.
      if (await snap.refreshPool(req.params.address)) row = await store.pool(req.params.address);
      if (!row) return reply.code(404).send({ error: "pool not found (not in the index and not on-chain)" });
    }
    const text = String(req.body?.text ?? "");
    const hash = createHash("sha256").update(text).digest("hex");
    const onChain = Buffer.from(row.data.strategyHash).toString("hex");
    if (hash !== onChain) return reply.code(400).send({ error: "sha256(text) does not match on-chain strategyHash", expected: onChain, got: hash });
    await store.setStrategy(row.address, text);
    return { ok: true };
  });

  app.get<{ Params: { wallet: string } }>("/traders/:wallet", async (req, reply) => {
    const t = await store.trader(req.params.wallet);
    if (!t) return reply.code(404).send({ error: "trader not found" });
    const prof = t.data;
    const counts = await store.investorCounts();
    const rows = (await store.pools()).filter((r) => r.data.trader === req.params.wallet);
    const pools = await Promise.all(rows.map((r) => summaryFor(r, counts).then((x) => x.summary)));
    const events = await store.events({ trader: req.params.wallet, limit: 200 });
    const roots = await store.trialRoots(req.params.wallet);
    return {
      profile: {
        ...traderSummary(req.params.wallet, prof),
        trialStartTs: f(prof.trialStartTs),
        trialDaysCommitted: prof.trialDaysCommitted,
        trialRoot: Buffer.from(prof.trialRoot).toString("hex"),
        cooldownUntil: f(prof.cooldownUntil),
        activePool: prof.activePool && prof.activePool !== "11111111111111111111111111111111" ? prof.activePool : null,
        trialRoots: roots,
      },
      pools,
      events: events.map((e) => ({ type: e.name, ts: e.ts, sig: e.sig, data: e.data })),
    };
  });

  app.get<{ Params: { wallet: string } }>("/investors/:wallet", async (req) => {
    const rows = await store.investorPositions({ investor: req.params.wallet });
    const counts = await store.investorCounts();
    const lockup = Number(snap.config?.risk?.redemptionLockupSecs ?? 86_400);
    const positions = [];
    for (const r of rows) {
      const poolRow = await store.pool(r.data.pool);
      if (!poolRow) continue;
      const { summary } = await summaryFor(poolRow, counts);
      const pos = positionsView(poolRow.data, snap.markets, snap.prices);
      const { nav } = navOf(poolRow.data, pos);
      const shares = new BN(r.data.shares);
      const total = new BN(poolRow.data.totalShares);
      const value = total.isZero() ? 0 : (nav * Number(shares.mul(new BN(1_000_000)).div(total))) / 1_000_000;
      const costBasis = usd(r.data.costBasis);
      positions.push({
        pool: summary,
        shares: shares.toString(),
        value,
        costBasis,
        pnl: value - costBasis,
        lastDepositTs: f(r.data.lastDepositTs),
        lockupEndsAt: f(r.data.lastDepositTs) + lockup,
        pendingShares: new BN(r.data.pendingShares).toString(),
        unwound: r.data.unwound,
        unwindCost: usd(r.data.unwindCost),
      });
    }
    return { positions };
  });

  const alertView = (a: { id: number; type: string; ts: number; acked: boolean; data: any }) => ({ id: a.id, type: a.type, ts: a.ts, acked: a.acked, ...a.data });

  /** Newest first. `?since=<unix ts>` returns only alerts after that time; `?acked=false` hides acknowledged ones. */
  app.get<{ Querystring: Record<string, string> }>("/alerts", async (req) => {
    const since = req.query.since ? Number(req.query.since) : undefined;
    let rows = await store.alerts(Math.min(1000, Number(req.query.limit ?? 200)), Number.isFinite(since) ? since : undefined);
    if (req.query.acked === "false") rows = rows.filter((a) => !a.acked);
    if (req.query.type) rows = rows.filter((a) => a.type === req.query.type);
    return { alerts: rows.map(alertView) };
  });

  app.post<{ Params: { id: string } }>("/alerts/:id/ack", async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: "invalid alert id" });
    const row = await store.ackAlert(id);
    if (!row) return reply.code(404).send({ ok: false, error: "alert not found" });
    req.log.info({ id }, "alert acknowledged");
    hub.broadcast({ type: "alert_ack", id, ts: now() });
    return { ok: true, alert: alertView(row) };
  });

  app.get<{ Querystring: Record<string, string> }>("/events", async (req) => {
    const events = await store.events({ pool: req.query.pool, name: req.query.type, limit: Number(req.query.limit ?? 100) });
    return { events: events.map((e) => ({ name: e.name, ts: e.ts, sig: e.sig, slot: e.slot, data: e.data })) };
  });

  app.register(async (inst) => {
    inst.get("/ws", { websocket: true }, (socket) => {
      hub.add(socket as any);
      (socket as any).send(JSON.stringify({ type: "hello", markets: snap.markets.map((m) => m.symbol), ts: now() }));
    });
  });

  return app;
}

export { USD, npsOf };
