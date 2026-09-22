/**
 * Trial engine service (C3). HTTP API per the interface contract.
 */
import { AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import cors from "@fastify/cors";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import Fastify from "fastify";
import pino from "pino";
import nacl from "tweetnacl";
import { VaultClient } from "@kydo/sdk";
import { env } from "./config";
import * as E from "./engine";
import { Prices } from "./prices";
import { MemoryTrialStore, PgTrialStore, TrialStore } from "./store";

const log = pino({ level: env.logLevel, name: "trial" });

async function main() {
  const store: TrialStore = env.store === "pg" ? new PgTrialStore(env.databaseUrl!) : new MemoryTrialStore();
  await store.init();

  const connection = new Connection(env.rpcUrl, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(env.attestor), { commitment: "confirmed" });
  const client = new VaultClient(provider, env.programId);

  // Public RPCs rate-limit (429). Retry the startup reads instead of crashing.
  const withRetry = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const wait = Math.min(15_000, 1_000 * 2 ** attempt);
        log.warn({ label, attempt, wait, err: String(e).slice(0, 120) }, "startup read failed; retrying");
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };
  let cfg = await withRetry("config", () => client.config());
  let markets = await withRetry("registry", async () => (await client.registry()).markets);
  const feedIdByMarket = new Map(markets.map((m) => [m.marketId, Buffer.from(m.feedId).toString("hex")]));
  const prices = new Prices(feedIdByMarket);
  prices.start();

  // Sandbox "keeper": mark every trial account against the live risk limits on every
  // price tick (not only when the terminal polls), so a daily-cap / drawdown breach
  // locks and unwinds the account even with no browser open. Exactly like a funded pool.
  setInterval(async () => {
    if (!Object.keys(prices.latest).length) return;
    try {
      for (const acc of await store.all()) {
        if (acc.locked) continue;
        const reason = E.mark(acc, prices.latest, now(), risk(), criteria());
        await store.put(acc);
        if (reason) log.warn({ wallet: acc.wallet, reason, equity: E.equity(acc, acc.lastPrices) }, "TRIAL LOCKED by sandbox keeper");
      }
    } catch (e) {
      log.warn({ err: String(e) }, "sandbox mark tick failed");
    }
  }, env.pricePollMs);
  setInterval(async () => {
    try {
      cfg = await client.config();
      markets = (await client.registry()).markets;
    } catch (e) {
      log.warn({ err: String(e) }, "config refresh failed");
    }
  }, 60_000);

  const risk = (): E.Risk => ({
    maxLeverageBps: cfg.risk.maxLeverageBps,
    maxPositions: cfg.risk.maxPositions,
    maxSingleBps: cfg.risk.maxSingleBps,
    maxClusterBps: cfg.risk.maxClusterBps,
    dailyLossBps: cfg.risk.dailyLossBps,
    maxDrawdownBps: cfg.risk.maxDrawdownBps,
    minHoldSecs: cfg.risk.minHoldSecs,
    maxTradesPerDay: cfg.risk.maxTradesPerDay,
    limitBandBps: cfg.risk.limitBandBps,
  });
  const criteria = (): E.Criteria => ({
    startingBalance: Number(cfg.trial.startingBalance) / 1e6,
    profitTargetBps: cfg.trial.profitTargetBps,
    maxDrawdownBps: cfg.trial.maxDrawdownBps,
    dailyLossBps: cfg.trial.dailyLossBps,
    minActiveDays: cfg.trial.minActiveDays,
    minTrades: cfg.trial.minTrades,
    maxDayProfitShareBps: cfg.trial.maxDayProfitShareBps,
    daySecs: cfg.trial.daySecs,
  });
  const marketOf = (id: number): E.Market | null => {
    const m = markets.find((x) => x.marketId === id);
    if (!m) return null;
    return { marketId: m.marketId, symbol: m.symbol, cluster: m.cluster, enabled: m.enabled, maxLeverageBps: m.maxLeverageBps, depthUsd: m.cluster === 1 ? env.depthMajors : env.depthOther };
  };
  const now = () => Math.floor(Date.now() / 1000);

  /** Load (or lazily create) the account, gated on the on-chain profile. */
  async function load(wallet: string): Promise<{ acc: E.TrialAccount | null; profile: any | null }> {
    const pk = new PublicKey(wallet);
    const profile = await client.trader(pk);
    let acc = await store.get(wallet);
    const status = profile ? Object.keys(profile.status)[0] : "none";
    const startTs = profile ? Number(profile.trialStartTs) : 0;
    // A new attempt (re-apply) starts a fresh account.
    if (profile && status === "trial" && (!acc || acc.startTs !== startTs)) {
      acc = E.newAccount(wallet, startTs, criteria());
      await store.put(acc);
    }
    return { acc, profile };
  }

  function stateOf(acc: E.TrialAccount | null, profile: any | null, wallet: string) {
    const c = criteria();
    const status = profile ? Object.keys(profile.status)[0] : "none";
    if (!acc) {
      return { wallet, exists: false, onChainStatus: status, startTs: 0, daySecs: c.daySecs, day: 0, daysCommitted: profile?.trialDaysCommitted ?? 0, balance: 0, equity: 0, dayStartEquity: 0, peakEquity: 0, positions: [], metrics: null, riskUtil: null, dayRoots: [], tradesToday: 0, locked: false, lockReason: null };
    }
    E.mark(acc, prices.latest, now(), risk(), c);
    const eq = E.equity(acc, acc.lastPrices);
    const day = E.dayOf(acc, now(), c);
    const ds = acc.days[day];
    const gross = E.grossNotional(acc, acc.lastPrices);
    const r = risk();
    const daily = ds && ds.startEquity > 0 ? Math.max(0, (ds.startEquity - eq) / ds.startEquity) / (r.dailyLossBps / 1e4) : 0;
    const dd = acc.peakEquity > 0 ? Math.max(0, (acc.peakEquity - eq) / acc.peakEquity) / (r.maxDrawdownBps / 1e4) : 0;
    const lev = eq > 0 ? gross / eq / (r.maxLeverageBps / 1e4) : 0;
    const committed = profile?.trialDaysCommitted ?? 0;
    const dayRoots = [];
    for (let d = 0; d < Math.min(day, 30); d++) dayRoots.push({ day: d, root: E.dayRoot(acc, d).toString("hex"), entries: E.dayEntries(acc, d).length, committed: d < committed });
    return {
      wallet,
      exists: true,
      onChainStatus: status,
      startTs: acc.startTs,
      daySecs: c.daySecs,
      day,
      daysCommitted: committed,
      balance: acc.balance,
      equity: eq,
      dayStartEquity: ds?.startEquity ?? eq,
      peakEquity: acc.peakEquity,
      positions: acc.positions.map((p) => {
        const mark = acc.lastPrices[p.marketId] ?? p.entryPrice;
        return { marketId: p.marketId, symbol: marketOf(p.marketId)?.symbol ?? `#${p.marketId}`, side: p.side, cluster: p.cluster, baseQty: p.baseQty, entryPrice: p.entryPrice, markPrice: mark, notional: p.baseQty * mark, unrealizedPnl: (mark - p.entryPrice) * p.baseQty * (p.side === "short" ? -1 : 1), openedAt: p.openedAt };
      }),
      metrics: E.metrics(acc, acc.lastPrices, c),
      riskUtil: { daily, drawdown: dd, leverage: lev, warn: Math.max(daily, dd, lev) >= 0.75 },
      dayRoots,
      tradesToday: ds?.trades ?? 0,
      locked: acc.locked,
      lockReason: acc.lockReason,
    };
  }

  const app = Fastify({ logger: { level: env.logLevel } });
  app.register(cors, { origin: true });
  // keep the raw body for signature verification
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  function verify(req: any, wallet: string): string | null {
    const w = req.headers["x-wallet"];
    const sig = req.headers["x-signature"];
    if (w !== wallet) return "x-wallet does not match path";
    if (!sig) return "missing x-signature";
    const body: string = req.rawBody ?? "";
    const ts = Number(req.body?.ts);
    if (!ts || Math.abs(Date.now() - ts) > 60_000) return "ts missing or outside ±60s";
    try {
      const ok = nacl.sign.detached.verify(Buffer.from(body, "utf8"), bs58.decode(String(sig)), new PublicKey(wallet).toBytes());
      return ok ? null : "bad signature";
    } catch (e) {
      return `signature error: ${String(e)}`;
    }
  }

  app.get("/health", async () => ({ ok: true, prices: Object.keys(prices.latest).length, devForcePass: env.devForcePass }));

  /** Market metadata incl. Section 4.2 venue depth, so clients can clamp order size before submitting. */
  app.get("/markets", async () => ({
    markets: markets
      .map((m) => marketOf(m.marketId))
      .filter((m): m is E.Market => !!m)
      .map((m) => ({ marketId: m.marketId, symbol: m.symbol, cluster: m.cluster, enabled: m.enabled, depthUsd: m.depthUsd, maxOrderUsd: m.depthUsd * E.MAX_DEPTH_SHARE })),
  }));

  app.get<{ Params: { wallet: string } }>("/trial/:wallet", async (req) => {
    const { acc, profile } = await load(req.params.wallet);
    if (acc) await store.put(acc);
    return stateOf(acc, profile, req.params.wallet);
  });

  app.get<{ Params: { wallet: string } }>("/trial/:wallet/metrics", async (req, reply) => {
    const { acc } = await load(req.params.wallet);
    if (!acc) return reply.code(404).send({ error: "no trial account" });
    return E.metrics(acc, prices.latest, criteria());
  });

  app.get<{ Params: { wallet: string }; Querystring: { day?: string } }>("/trial/:wallet/orders", async (req, reply) => {
    const { acc } = await load(req.params.wallet);
    if (!acc) return reply.code(404).send({ error: "no trial account" });
    const entries = req.query.day !== undefined ? E.dayEntries(acc, Number(req.query.day)) : acc.entries;
    return { entries };
  });

  app.get<{ Params: { wallet: string; day: string } }>("/trial/:wallet/roots/:day", async (req, reply) => {
    const { acc } = await load(req.params.wallet);
    if (!acc) return reply.code(404).send({ error: "no trial account" });
    const day = Number(req.params.day);
    const cur = E.dayOf(acc, now(), criteria());
    if (day >= cur) return reply.code(400).send({ error: `day ${day} has not ended yet (current day ${cur})` });
    return { day, root: E.dayRoot(acc, day).toString("hex"), entries: E.dayEntries(acc, day).length };
  });

  app.get<{ Params: { wallet: string } }>("/trial/:wallet/export", async (req, reply) => {
    const { acc } = await load(req.params.wallet);
    if (!acc) return reply.code(404).send({ error: "no trial account" });
    const days = [...new Set(acc.entries.map((e) => e.day))].sort((a, b) => a - b);
    return { wallet: acc.wallet, startTs: acc.startTs, entries: acc.entries, dayRoots: days.map((d) => ({ day: d, root: E.dayRoot(acc, d).toString("hex") })), proofs: E.proofs(acc) };
  });

  app.post<{ Params: { wallet: string }; Body: any }>("/trial/:wallet/orders", async (req, reply) => {
    const wallet = req.params.wallet;
    const authErr = verify(req, wallet);
    if (authErr) return reply.code(401).send({ ok: false, error: authErr });
    const { acc, profile } = await load(wallet);
    if (!acc || !profile || Object.keys(profile.status)[0] !== "trial") return reply.code(400).send({ ok: false, error: "wallet is not in an active trial" });
    const b: any = req.body ?? {};
    const market = marketOf(Number(b.marketId));
    if (!market) return reply.code(400).send({ ok: false, error: "MarketNotFound" });
    const order: E.OrderRequest = { marketId: market.marketId, side: b.side, action: b.action, notional: b.notional ? Number(b.notional) : undefined, baseQty: b.baseQty ? Number(b.baseQty) : undefined, limitPx: b.limitPx ? Number(b.limitPx) : undefined, stopPx: b.stopPx ? Number(b.stopPx) : undefined };
    if (!["long", "short"].includes(order.side) || !["open", "close"].includes(order.action)) return reply.code(400).send({ ok: false, error: "InvalidArgument" });
    try {
      const { fill, entry } = E.execute(acc, order, market, prices.latest, now(), risk(), criteria(), env.attestor.secretKey);
      await store.put(acc);
      return { ok: true, fill, entry, state: stateOf(acc, profile, wallet) };
    } catch (e: any) {
      await store.put(acc);
      const code = e instanceof E.TrialError ? e.code : "InternalError";
      return reply.code(400).send({ ok: false, error: code, message: e.message });
    }
  });

  app.post<{ Params: { wallet: string }; Body: any }>("/trial/:wallet/finalize", async (req, reply) => {
    const wallet = req.params.wallet;
    const authErr = verify(req, wallet);
    if (authErr) return reply.code(401).send({ ok: false, error: authErr });
    const { acc, profile } = await load(wallet);
    if (!acc || !profile) return reply.code(400).send({ ok: false, error: "no trial account" });
    let m = E.metrics(acc, prices.latest, criteria());
    const force = env.devForcePass && (req.body as any)?.force === true;
    if (force) {
      // Even the dev shortcut requires the trial to contain actual trading. An empty
      // trial must not continue to Eligible (metrics are forced, existence is not).
      if (m.trades === 0) return reply.code(400).send({ ok: false, error: "no trades in this trial. Place at least one order in the terminal before finalizing" });
      // DEV ONLY: attest a passing result so testers can reach pool creation without grinding +8%.
      const c = criteria();
      m = { ...m, finalEquity: c.startingBalance * 1.1, maxDrawdownBps: 0, maxDailyLossBps: 0, activeDays: 30, trades: 40, maxDayProfitShareBps: 1000 };
      log.warn({ wallet }, "FORCE-PASS finalize (TRIAL_DEV_FORCE_PASS). Never enable this on a real deployment");
    }
    try {
      const sig = await client
        .finalizeTrial(env.attestor.publicKey, new PublicKey(wallet), {
          finalEquity: new BN(Math.round(m.finalEquity * 1e6)),
          maxDrawdownBps: m.maxDrawdownBps,
          maxDailyLossBps: m.maxDailyLossBps,
          activeDays: m.activeDays,
          trades: m.trades,
          maxDayProfitShareBps: m.maxDayProfitShareBps,
        })
        .rpc();
      const after = await client.trader(new PublicKey(wallet));
      const passed = after ? Object.keys(after.status)[0] === "eligible" : false;
      // Name the failed criterion in the program's own section 5.4 evaluation order; if every
      // metric passes yet the profile says Failed, the on-chain reason was a missed day root.
      const failReason = (): string => {
        const c = criteria();
        if (m.finalEquity < c.startingBalance * (1 + c.profitTargetBps / 10_000)) return `profit target not reached (needs +${c.profitTargetBps / 100}%, finished ${(((m.finalEquity - c.startingBalance) / c.startingBalance) * 100).toFixed(2)}%)`;
        if (m.maxDrawdownBps > c.maxDrawdownBps) return `max drawdown ${(m.maxDrawdownBps / 100).toFixed(2)}% exceeded the ${c.maxDrawdownBps / 100}% limit`;
        if (m.maxDailyLossBps > c.dailyLossBps) return `worst day lost ${(m.maxDailyLossBps / 100).toFixed(2)}%. Over the ${c.dailyLossBps / 100}% daily cap`;
        if (m.activeDays < c.minActiveDays) return `only ${m.activeDays} active days (minimum ${c.minActiveDays})`;
        if (m.trades < c.minTrades) return `only ${m.trades} trades (minimum ${c.minTrades})`;
        if (m.maxDayProfitShareBps > c.maxDayProfitShareBps) return `best day made ${(m.maxDayProfitShareBps / 100).toFixed(0)}% of total profit (max ${c.maxDayProfitShareBps / 100}%)`;
        return "a day's merkle root was not committed in time";
      };
      log.info({ wallet, sig, passed, metrics: m }, "finalized trial");
      return { ok: true, sig, passed, forced: force, metrics: m, failReason: passed ? undefined : failReason() };
    } catch (e: any) {
      const code = e?.error?.errorCode?.code ?? String(e);
      return reply.code(400).send({ ok: false, error: code });
    }
  });

  await app.listen({ port: env.port, host: "0.0.0.0" });
  log.info({ port: env.port, attestor: env.attestor.publicKey.toBase58(), priceSource: env.priceSource }, "trial engine up");
}

main().catch((e) => {
  log.fatal({ err: String(e) }, "trial engine crashed");
  process.exit(1);
});
