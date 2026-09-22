/**
 * Price gateway (section 3.4): streams Pyth Hermes. The same feeds the program reads.
 * Emits normalized prices `{ price, conf }` in 1e6 units keyed by feed id.
 *
 * Sources (PRICE_SOURCE):
 *   hermes       Pyth Hermes SSE stream (+ a 10 s poll while the stream is quiet). Needs an
 *                API key. The public endpoint answers 401 to everything else. If Hermes
 *                rejects us the gateway does NOT quietly switch venues: whatever it resolves
 *                is written on-chain and marks every pool, so it degrades to `exchange` only
 *                when PRICE_ALLOW_EXCHANGE_FALLBACK=true, and otherwise stops pushing and
 *                lets trading halt on OracleStale.
 *   exchange     Poll spot prices from Binance (one request for all symbols), Coinbase as a
 *                per-symbol fallback. Needs a feed-id → symbol map (the registry symbols).
 *                `hermes` only degrades to this when PRICE_ALLOW_EXCHANGE_FALLBACK=true.
 *   random-walk  Offline development. Synthetic prices. Refuses to run against
 *                anything but a local validator.
 */
import EventSource from "eventsource";
import pino from "pino";
import { env } from "./config";

const log = pino({ level: env.logLevel, name: "prices" });

/** Every outbound HTTP call gets this deadline; Node's fetch has none. */
const HTTP_TIMEOUT_MS = 8_000;

export interface Quote {
  price: bigint; // 1e6
  conf: bigint; // 1e6
  publishTime: number;
  receivedAt: number;
}

export type Listener = (feedId: string, q: Quote) => void;

function normalize(price: string, conf: string, expo: number): { price: bigint; conf: bigint } {
  const shift = expo + 6;
  const p = BigInt(price);
  const c = BigInt(conf);
  if (shift >= 0) {
    const m = 10n ** BigInt(shift);
    return { price: p * m, conf: c * m };
  }
  const d = 10n ** BigInt(-shift);
  return { price: p / d, conf: c / d };
}

/** Decimal string / number → 1e6 bigint, rounding to the nearest micro-unit. */
function toMicro(v: string | number): bigint {
  return BigInt(Math.round(Number(v) * 1e6));
}

/** Symbols whose exchange ticker differs from the registry symbol. */
const EXCHANGE_ALIAS: Record<string, string> = { WBTC: "BTC", WETH: "ETH" };
const exchangeBase = (symbol: string) => EXCHANGE_ALIAS[symbol.toUpperCase()] ?? symbol.toUpperCase().replace(/-?(PERP|USD[CT]?)$/, "");

export class PriceGateway {
  readonly latest = new Map<string, Quote>();
  /** Active source after start(). `hermes` may have fallen back to `exchange`. */
  source: "hermes" | "exchange" | "random-walk" = env.priceSource;
  private listeners: Listener[] = [];
  private es?: EventSource;
  private timer?: NodeJS.Timeout;
  private streamErrors = 0;

  /**
   * @param feedIds  Pyth feed ids (hex) the program reads. The keys quotes are emitted under.
   * @param symbols  feed id → registry symbol ("SOL", "BTC"…), needed for the exchange source.
   */
  constructor(
    public feedIds: string[],
    private symbols: Record<string, string> = {},
  ) {}

  onQuote(l: Listener) {
    this.listeners.push(l);
  }

  async start() {
    if (env.priceSource === "random-walk") return this.startRandomWalk();
    if (env.priceSource === "exchange") return this.startExchange();
    const rejected = await this.validateFeeds();
    if (rejected) {
      log.error(
        { hermes: env.hermesUrl, keyed: !!env.hermesAuth, fallback: env.allowExchangeFallback },
        "Hermes rejected every feed request. hermes.pyth.network requires a bearer token: set PYTH_API_KEY (or PYTH_HERMES_AUTH)",
      );
      if (this.canUseExchange()) return this.startExchange();
      log.error("no price source. The keeper will not push, marks go stale and trading halts on OracleStale. That is deliberate: pushing another venue's price on-chain would decide liquidations at a price the platform never agreed to use");
      return;
    }
    this.connect();
  }

  /**
   * One unknown id makes Hermes 404 the whole stream. Drop bad ids up front.
   * Only a definitive "not found" drops a feed; auth/rate-limit/network failures keep it
   * (otherwise a 401/429 blip would silently leave every market without a price).
   * Returns true when Hermes rejected every request outright (auth / rate limit).
   */
  /** Auth for a keyed Hermes; empty when no token is configured. */
  private hermesHeaders(): Record<string, string> {
    return env.hermesAuth ? { Authorization: `Bearer ${env.hermesAuth}` } : {};
  }

  private async validateFeeds(): Promise<boolean> {
    const ok: string[] = [];
    let rejected = 0;
    for (const f of this.feedIds) {
      try {
        const res = await fetch(`${env.hermesUrl}/v2/updates/price/latest?ids[]=0x${f.replace(/^0x/, "")}`, {
          headers: this.hermesHeaders(),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (res.ok) ok.push(f);
        else if (res.status === 404 || res.status === 400) log.error({ feedId: f, status: res.status }, "unknown Pyth feed id. Market will have NO price; fix the registry");
        else if (res.status === 403) {
          // A per-feed permission denial, and permanent. The key does not
          // cover this feed. It has to be dropped rather than kept: Hermes
          // refuses a stream request outright if any single id in it is not
          // permitted, so keeping one forbidden feed costs every market its
          // price. A key-wide 401 falls through to the branch below instead,
          // where every feed is "rejected" and the source falls back.
          log.error(
            { feedId: f, symbol: this.symbols[f], status: 403 },
            "Hermes key does not cover this feed. Dropping it so the rest can stream; that market will have NO price",
          );
        } else {
          rejected++;
          log.warn({ feedId: f, status: res.status, hermes: env.hermesUrl }, "Hermes rejected the request (not a bad feed id). Keeping id");
          ok.push(f);
        }
      } catch (e) {
        log.warn({ feedId: f, err: String(e) }, "feed validation failed; keeping id");
        ok.push(f);
      }
    }
    if (!ok.length && this.feedIds.length) log.error("every feed was rejected. Keeping the original list rather than streaming nothing");
    else this.feedIds = ok;
    return this.feedIds.length > 0 && rejected === this.feedIds.length;
  }

  /**
   * Binance/Coinbase spot is a different venue's price than the one the
   * platform marks against, and this gateway's output is written on-chain, so
   * substituting it is opt-in, never automatic. Needs registry symbols too.
   */
  private canUseExchange() {
    return env.allowExchangeFallback && this.feedIds.some((f) => this.symbols[f]);
  }

  stop() {
    this.es?.close();
    if (this.timer) clearInterval(this.timer);
  }

  private emit(feedId: string, q: Quote) {
    this.latest.set(feedId, q);
    for (const l of this.listeners) l(feedId, q);
  }

  // ---------------------------------------------------------------- hermes
  private connect() {
    if (!this.feedIds.length) {
      log.error("no feed ids to stream. Nothing to connect to");
      return;
    }
    const ids = this.feedIds.map((f) => `ids[]=0x${f.replace(/^0x/, "")}`).join("&");
    const url = `${env.hermesUrl}/v2/updates/price/stream?${ids}&parsed=true&allow_unordered=true`;
    log.info({ url }, "connecting to Hermes");
    this.es = new EventSource(url, { headers: this.hermesHeaders() });
    this.es.onopen = () => {
      this.streamErrors = 0;
    };
    this.es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        for (const p of msg.parsed ?? []) {
          const { price, conf } = normalize(p.price.price, p.price.conf, p.price.expo);
          this.emit(p.id, { price, conf, publishTime: p.price.publish_time, receivedAt: Date.now() });
        }
      } catch (e) {
        log.warn({ err: String(e) }, "bad hermes message");
      }
    };
    this.es.onerror = (e: any) => {
      this.streamErrors++;
      this.es?.close();
      const status = Number(e?.status ?? 0);
      // Auth / rate-limit responses never recover by retrying the same URL; switch source.
      if (status === 401 || status === 403 || status === 429 || this.streamErrors >= 5) {
        if (this.canUseExchange()) {
          log.error({ status, errors: this.streamErrors }, "Hermes stream keeps failing. Falling back to exchange spot prices");
          if (this.timer) clearInterval(this.timer);
          this.startExchange();
          return;
        }
        log.error({ status, errors: this.streamErrors }, "Hermes stream keeps failing and the exchange fallback is off. Retrying Pyth rather than marking against another venue");
      }
      const delay = Math.min(30_000, 2000 * 2 ** Math.min(4, this.streamErrors - 1));
      log.warn({ err: JSON.stringify(e), retryMs: delay }, "hermes stream error; reconnecting");
      setTimeout(() => this.connect(), delay);
    };
    // Fallback poll in case the stream is quiet (Hermes drops idle streams).
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.pollLatest().catch(() => undefined), 10_000);
  }

  async pollLatest() {
    const ids = this.feedIds.map((f) => `ids[]=0x${f.replace(/^0x/, "")}`).join("&");
    const res = await fetch(`${env.hermesUrl}/v2/updates/price/latest?${ids}&parsed=true`, {
      headers: this.hermesHeaders(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) return;
    const msg = (await res.json()) as any;
    for (const p of msg.parsed ?? []) {
      const { price, conf } = normalize(p.price.price, p.price.conf, p.price.expo);
      this.emit(p.id, { price, conf, publishTime: p.price.publish_time, receivedAt: Date.now() });
    }
  }

  // -------------------------------------------------------------- exchange
  private startExchange() {
    this.source = "exchange";
    const pairs = this.feedIds.filter((f) => this.symbols[f]).map((f) => ({ feed: f, base: exchangeBase(this.symbols[f]) }));
    const missing = this.feedIds.filter((f) => !this.symbols[f]);
    if (missing.length) log.warn({ missing }, "exchange source: feeds without a registry symbol get no price");
    log.info({ symbols: pairs.map((p) => p.base), everyMs: env.exchangePollMs }, "exchange price source started (Binance, Coinbase fallback)");
    const tick = () => this.pollExchange(pairs).catch((e) => log.warn({ err: String(e) }, "exchange poll failed"));
    void tick();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(tick, env.exchangePollMs);
  }

  private async pollExchange(pairs: { feed: string; base: string }[]) {
    if (!pairs.length) return;
    const now = Date.now();
    const got = new Set<string>();
    // Binance: one request for every symbol.
    try {
      const symbols = encodeURIComponent(JSON.stringify(pairs.map((p) => `${p.base}USDT`)));
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbols=${symbols}`);
      if (res.ok) {
        const rows = (await res.json()) as { symbol: string; price: string }[];
        const bySym = new Map(rows.map((r) => [r.symbol, r.price]));
        for (const p of pairs) {
          const px = bySym.get(`${p.base}USDT`);
          if (!px) continue;
          const price = toMicro(px);
          this.emit(p.feed, { price, conf: price / 2000n, publishTime: Math.floor(now / 1000), receivedAt: now });
          got.add(p.feed);
        }
      } else log.debug({ status: res.status }, "binance ticker rejected");
    } catch (e) {
      log.debug({ err: String(e) }, "binance unreachable");
    }
    // Coinbase per symbol for whatever Binance did not cover.
    await Promise.all(
      pairs
        .filter((p) => !got.has(p.feed))
        .map(async (p) => {
          try {
            const res = await fetch(`https://api.coinbase.com/v2/prices/${p.base}-USD/spot`);
            if (!res.ok) return;
            const j = (await res.json()) as { data?: { amount?: string } };
            if (!j.data?.amount) return;
            const price = toMicro(j.data.amount);
            this.emit(p.feed, { price, conf: price / 2000n, publishTime: Math.floor(now / 1000), receivedAt: now });
            got.add(p.feed);
          } catch {
            /* try again next tick */
          }
        }),
    );
    if (got.size < pairs.length) log.warn({ missing: pairs.filter((p) => !got.has(p.feed)).map((p) => p.base) }, "no exchange price this tick");
  }

  // ----------------------------------------------------------- random walk
  /** Deterministic-ish random walk for offline development. */
  private startRandomWalk() {
    // These prices are invented, and the keeper writes them to the oracle
    // accounts every pool marks against. Never off a local validator.
    if (!/(127\.0\.0\.1|localhost)/.test(env.rpcUrl)) {
      throw new Error(`PRICE_SOURCE=random-walk against ${env.rpcUrl}: synthetic prices are written on-chain and would drive real liquidations. Localhost only`);
    }
    this.source = "random-walk";
    const seeds: Record<string, number> = {};
    const base = [150, 60_000, 3_000, 30, 550, 0.15];
    this.feedIds.forEach((f, i) => (seeds[f] = base[i % base.length]));
    this.timer = setInterval(() => {
      for (const f of this.feedIds) {
        const drift = 1 + (Math.random() - 0.5) * 0.002;
        seeds[f] *= drift;
        const price = BigInt(Math.round(seeds[f] * 1e6));
        this.emit(f, { price, conf: price / 2000n, publishTime: Math.floor(Date.now() / 1000), receivedAt: Date.now() });
      }
    }, 1000);
  }
}
