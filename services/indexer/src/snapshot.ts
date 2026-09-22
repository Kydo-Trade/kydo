/**
 * Account snapshotter: every `SNAPSHOT_INTERVAL_MS` (2 s, spec ≤ 2 s lag)
 * re-reads pools, trader profiles, investor positions and oracle prices so
 * the API always serves current on-chain state even between events.
 */
import { Connection } from "@solana/web3.js";
import pino from "pino";
import { MarketLike, VaultClient } from "@kydo/sdk";
import { Price, readOraclePrices } from "./chain";
import { env } from "./config";
import type { Store } from "./store";
import { plain, statusOf, symbolOf } from "./views";
import type { Hub } from "./ws";

const log = pino({ level: env.logLevel, name: "snapshot" });

/** Deadline for every outbound HTTP call; Node's fetch has none, and a socket
 *  whose network vanishes hangs rather than errors. */
const HTTP_TIMEOUT_MS = 8_000;

export class Snapshotter {
  markets: MarketLike[] = [];
  config: any = null;
  /**
   * The CommonPool account, re-read every cycle. One `getAccountInfo`, and it
   * is what `/common-pool` answers "can the next trader be funded right now?"
   * from. The onboarding flow needs that before it can tell someone whether
   * they are funded instantly or waiting in the queue.
   */
  commonPool: any = null;
  prices = new Map<number, Price>();
  /** Where the served prices came from this cycle: on-chain oracles, Hermes (stale-oracle fallback) or both. */
  priceSource: "chain" | "hermes" | "exchange" | "mixed" | "none" = "none";
  /** Recent price ticks per market (ring buffer) for chart backfill: GET /prices/history. */
  history = new Map<number, { ts: number; price: number }[]>();
  static readonly HISTORY_MAX = 3_000;
  lastSlot = 0;
  lastRunMs = 0;
  private cycle = 0;
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private connection: Connection, private client: VaultClient, private store: Store, private hub: Hub) {}

  /**
   * Fetch ONE pool account straight from the chain and upsert it. For reads that race the
   * snapshot cycle (e.g. posting a strategy right after create_pool confirms, while the next
   * snapshot is up to SNAPSHOT_INTERVAL_MS away). Returns false when the account doesn't exist.
   */
  async refreshPool(address: string): Promise<boolean> {
    try {
      const { PublicKey } = await import("@solana/web3.js");
      const account = await (this.client.program.account as any).pool.fetch(new PublicKey(address));
      await this.store.upsertPool(address, account.trader.toBase58(), statusOf(account.status), plain(account));
      return true;
    } catch {
      return false;
    }
  }

  async refreshStatic() {
    this.config = await this.client.config();
    this.markets = (await this.client.registry()).markets;
  }

  async run() {
    if (this.busy) return;
    this.busy = true;
    const t0 = Date.now();
    try {
      // Sequential, not Promise.all: public RPCs rate-limit bursts. Pools + prices every cycle;
      // trader profiles and investor positions (extra getProgramAccounts) only every SLOW_EVERY cycles.
      const SLOW_EVERY = Math.max(1, Math.round(60_000 / env.snapshotMs));
      const slowCycle = this.cycle++ % SLOW_EVERY === 0;
      const prices = await readOraclePrices(this.connection, this.client, this.markets);
      await this.fillStalePricesFromHermes(prices);
      const pools = await this.client.allPools();
      try {
        this.commonPool = await (this.client.program.account as any).commonPool.fetchNullable(this.client.pda.commonPool());
      } catch {
        // leave the last good read in place. A missed cycle must not read as "no capacity"
      }
      const profiles = slowCycle ? await (this.client.program.account as any).traderProfile.all() : null;
      const positions = slowCycle ? await (this.client.program.account as any).investorPosition.all() : null;
      this.lastSlot = prices.size ? this.lastSlot + 1 : this.lastSlot; // avoid a getSlot round-trip per cycle

      for (const [id, p] of prices) {
        const prev = this.prices.get(id);
        if (!prev || prev.price !== p.price || prev.ts !== p.ts) {
          this.hub.broadcast({ type: "price", marketId: id, symbol: symbolOf(this.markets, id), price: p.price, conf: p.conf, ts: p.ts });
          const h = this.history.get(id) ?? [];
          if (!h.length || h[h.length - 1].ts < p.ts) {
            h.push({ ts: p.ts, price: p.price });
            if (h.length > Snapshotter.HISTORY_MAX) h.splice(0, h.length - Snapshotter.HISTORY_MAX);
            this.history.set(id, h);
          }
        }
      }
      this.prices = prices;

      const poolAddrs: string[] = [];
      for (const { publicKey, account } of pools as any[]) {
        const addr = publicKey.toBase58();
        poolAddrs.push(addr);
        await this.store.upsertPool(addr, account.trader.toBase58(), statusOf(account.status), plain(account));
      }
      await this.store.deletePoolsNotIn(poolAddrs);

      if (profiles) {
        for (const { publicKey, account } of profiles as any[]) {
          await this.store.upsertTrader(account.wallet.toBase58(), { ...plain(account), address: publicKey.toBase58() });
        }
      }
      if (positions) {
        const ipAddrs: string[] = [];
        for (const { publicKey, account } of positions as any[]) {
          const addr = publicKey.toBase58();
          ipAddrs.push(addr);
          await this.store.upsertInvestorPosition(addr, account.pool.toBase58(), account.investor.toBase58(), plain(account));
        }
        await this.store.deleteInvestorPositionsNotIn(ipAddrs);
      }
    } catch (e) {
      log.warn({ err: String(e) }, "snapshot failed");
    } finally {
      this.lastRunMs = Date.now() - t0;
      this.busy = false;
    }
  }

  /**
   * Stale-oracle fallback: when the keeper cannot push (out of SOL, RPC down) the on-chain mock
   * oracles freeze, but the platform's price *feed* (charts, marks shown in the UI, the trial
   * engine's indexer source) shouldn't. Any market whose on-chain price is missing or older than
   * PRICE_STALE_SECS is served the live Hermes price for its registry feed id instead.
   * On-chain actions still read the on-chain oracle, so this changes what users SEE, not risk math.
   */
  private async fillStalePricesFromHermes(prices: Map<number, Price>): Promise<void> {
    const staleAfter = env.priceStaleSecs;
    const now = Math.floor(Date.now() / 1000);
    const wanted = new Map<string, number[]>(); // feedId hex -> marketIds
    if (staleAfter > 0) {
      for (const m of this.markets) {
        // Enabled markets only. A retired market keeps a valid feed id and a
        // mock oracle nobody feeds, so it reads as permanently stale and would
        // sit in this batch forever, and Hermes 403s the WHOLE request if any
        // single id is outside the plan, which sent every price to the exchange
        // fallback.
        if (m.enabled === false) continue;
        const hex = Buffer.from(m.feedId ?? []).toString("hex");
        if (!/^[0-9a-f]{64}$/.test(hex) || /^0+$/.test(hex)) continue;
        if (this.forbiddenFeeds.has(hex)) continue;
        const p = prices.get(m.marketId);
        if (!p || now - p.ts > staleAfter) wanted.set(hex, [...(wanted.get(hex) ?? []), m.marketId]);
      }
    }
    const chainFresh = prices.size - [...wanted.values()].reduce((n, ids) => n + ids.filter((id) => prices.has(id)).length, 0);
    if (!wanted.size) {
      this.priceSource = prices.size ? "chain" : "none";
      return;
    }
    let filled = 0;
    let tier: "hermes" | "exchange" = "hermes";
    try {
      filled = await this.fetchHermes(wanted, prices);
    } catch (e) {
      // Auth errors won't heal by retrying, so stop asking for a while.
      // 401 = bad/missing key, nothing heals it soon. 403 = a feed outside the
      // plan, already dropped above. Retry immediately with the rest.
      const auth = /401/.test(String(e));
      if (auth) this.hermesDeadUntil = Date.now() + 10 * 60_000;
      if (auth && this.lastLoggedSource !== "hermes-auth") {
        log.error({ keyed: !!env.hermesAuth }, "Hermes rejected the request. Set PYTH_API_KEY (sent as `Authorization: Bearer …`). Until then the stale-price fallback cannot reach Pyth");
        this.lastLoggedSource = "hermes-auth";
      }
      // Binance spot is a different venue's price, not the one the program
      // marks against, so it is opt-in: a chart that silently disagrees with
      // the liquidation engine is worse than a chart that stops moving.
      if (!env.allowExchangeFallback) {
        this.priceSource = prices.size ? "chain" : "none";
        log.warn({ hermes: String(e) }, "Pyth unreachable. Serving the on-chain oracle prices as-is (set PRICE_ALLOW_EXCHANGE_FALLBACK=true to substitute Binance spot)");
        return;
      }
      try {
        filled = await this.fetchExchange(wanted, prices);
        tier = "exchange";
      } catch (e2) {
        this.priceSource = prices.size ? "chain" : "none";
        log.warn({ hermes: String(e), exchange: String(e2) }, "stale-price fallback failed (Hermes and exchange); serving on-chain prices as-is");
        return;
      }
    }
    this.priceSource = filled ? (chainFresh > 0 ? "mixed" : tier) : prices.size ? "chain" : "none";
    if (filled && this.priceSource !== this.lastLoggedSource) {
      log.warn({ filled, staleAfter }, "on-chain oracles are stale (keeper not pushing?). Serving live external prices for the stale markets");
      this.lastLoggedSource = this.priceSource;
    }
  }
  private lastLoggedSource: string | null = null;
  private hermesDeadUntil = 0;
  /** Feed ids Hermes refuses (403, outside the plan). One of them poisons the
   *  whole batch, so they are learned once and skipped thereafter. */
  private forbiddenFeeds = new Set<string>();

  private async fetchHermes(wanted: Map<string, number[]>, prices: Map<number, Price>): Promise<number> {
    if (Date.now() < this.hermesDeadUntil) throw new Error("hermes 401 (cached)");
    const qs = [...wanted.keys()].map((h) => `ids[]=0x${h}`).join("&");
    // Bearer token or 401. The public endpoint has not been open for a while.
    const res = await fetch(`${env.hermesUrl}/v2/updates/price/latest?${qs}&parsed=true`, {
      headers: env.hermesAuth ? { Authorization: `Bearer ${env.hermesAuth}` } : {},
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.status === 403) {
      // One id outside the plan 403s the entire batch. Learn it and drop it
      // rather than losing every price to the fallback on every cycle.
      const body = await res.text().catch(() => "");
      for (const hex of wanted.keys()) if (body.includes(hex)) this.forbiddenFeeds.add(hex);
      if (!this.forbiddenFeeds.size) for (const hex of wanted.keys()) this.forbiddenFeeds.add(hex);
      log.error({ feeds: [...this.forbiddenFeeds] }, "Hermes refuses these feed ids (outside the plan). Dropping them from the price batch; those markets get no Pyth price");
      throw new Error("hermes 403");
    }
    if (!res.ok) throw new Error(`hermes ${res.status}`);
    const body = (await res.json()) as { parsed?: { id: string; price: { price: string; conf: string; expo: number; publish_time: number } }[] };
    let filled = 0;
    for (const u of body.parsed ?? []) {
      const ids = wanted.get(u.id.replace(/^0x/, "").toLowerCase());
      if (!ids) continue;
      const scale = Math.pow(10, u.price.expo);
      for (const id of ids) {
        prices.set(id, { price: Number(u.price.price) * scale, conf: Number(u.price.conf) * scale, ts: Number(u.price.publish_time) });
        filled++;
      }
    }
    return filled;
  }

  /** Binance spot, only when `PRICE_ALLOW_EXCHANGE_FALLBACK=true` (same aliasing as the keeper's exchange source). */
  private async fetchExchange(wanted: Map<string, number[]>, prices: Map<number, Price>): Promise<number> {
    const base = (sym: string) => sym.toUpperCase().replace(/-?(PERP|USD[CT]?)$/, "");
    const bySymbol = new Map<string, number[]>();
    for (const ids of wanted.values())
      for (const id of ids) {
        const m = this.markets.find((x) => x.marketId === id);
        if (!m) continue;
        const b = base(m.symbol);
        bySymbol.set(b, [...(bySymbol.get(b) ?? []), id]);
      }
    if (!bySymbol.size) return 0;
    const symbols = encodeURIComponent(JSON.stringify([...bySymbol.keys()].map((b) => `${b}USDT`)));
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${symbols}`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`binance ${res.status}`);
    const body = (await res.json()) as { symbol: string; price: string }[];
    const now = Math.floor(Date.now() / 1000);
    let filled = 0;
    for (const row of body) {
      const ids = bySymbol.get(row.symbol.replace(/USDT$/, ""));
      const px = Number(row.price);
      if (!ids || !Number.isFinite(px) || px <= 0) continue;
      for (const id of ids) {
        prices.set(id, { price: px, conf: px * 0.0005, ts: now });
        filled++;
      }
    }
    return filled;
  }

  start() {
    this.timer = setInterval(() => this.run(), env.snapshotMs);
    setInterval(() => this.refreshStatic().catch((e) => log.warn({ err: String(e) }, "static refresh failed")), 60_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
