/**
 * Event ingestion: backfill on start, then live `onLogs` subscription.
 * Every event is stored raw; `TradeFilled` and `NavMarked` also feed the
 * trades / equity-curve tables; `TrialRootCommitted` feeds trial_roots;
 * `TradeFilled` opens run through the cross-pool hedge detector.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import pino from "pino";
import { MarketLike } from "@kydo/sdk";
import { checkForHedges } from "./alerts";
import { backfill, DecodedEvent, decodeLogs, eventParser } from "./chain";
import { env } from "./config";
import { hedgeNotification, lockNotification, Notifier, pauseNotification, type Notification } from "./notify";
import type { Store, TradeRow } from "./store";
import { f, lockReasonOf, plain, tradeView, symbolOf, usd } from "./views";
import type { Hub } from "./ws";

const log = pino({ level: env.logLevel, name: "ingest" });
const CURSOR = "last_sig";

const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
/** Shallow snake_case → camelCase on an event payload (values untouched: BN, PublicKey, arrays…). */
function camelKeys<T extends Record<string, any>>(o: T): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(o)) out[camel(k)] = v;
  return out;
}

const POOL_EVENTS = new Set([
  "PoolCreated", "PoolActivated", "TierPromoted", "Deposited", "RedemptionRequested", "RedemptionSettled",
  "TradeFilled", "NavMarked", "PoolLocked", "PoolUnwound", "EscrowVested", "FeesClaimed", "PoolClosed", "PoolReaped", "BountyPaid",
  "PoolFundedFromQueue", "CommonPullRequested", "CommonPullSettled", "PlatformFeeCollected", "StopSet",
]);
const TRADER_EVENTS = new Set(["TraderApplied", "TrialRootCommitted", "TrialFinalized", "PoolCreated", "TierPromoted", "PoolLocked", "PoolClosed", "TradeFilled", "FundingQueued", "PoolFundedFromQueue", "QueueTicketSkipped", "ForfeitedFeeSwept"]);

export class Ingestor {
  lastEventTs = 0;
  constructor(
    private connection: Connection,
    private store: Store,
    private hub: Hub,
    private markets: () => MarketLike[],
    private notifier: Notifier = new Notifier(),
    /** Known trader wallets (from the on-chain profiles) for the cold-start replay. */
    private traderWallets?: () => Promise<PublicKey[]>,
  ) {}

  get alertSinks() {
    return this.notifier.enabled;
  }

  /** Ops alerts from outside the event stream (e.g. the keeper-balance watcher). */
  async raiseOpsAlert(type: string, data: Record<string, unknown>, notify: (id: number) => Notification) {
    return this.raiseAlert(type, Math.floor(Date.now() / 1000), data, notify);
  }

  /** Persist an alert row, broadcast it on the WS feed and hand it to the notifier (non-blocking). */
  private async raiseAlert(type: string, ts: number, data: Record<string, unknown>, notify: (id: number) => Notification) {
    const row = await this.store.insertAlert(type, ts, data);
    this.hub.broadcast({ type: "alert", alert: { id: row.id, type: row.type, ts: row.ts, acked: row.acked, ...row.data } });
    this.notifier.send(notify(row.id));
    return row;
  }

  private pk(x: any): string | null {
    if (!x) return null;
    return x instanceof PublicKey ? x.toBase58() : new PublicKey(x).toBase58();
  }

  async handle(ev: DecodedEvent, blockTime: number | null) {
    // Anchor's event parser keeps the IDL's snake_case field names; everything below (and the
    // stored JSON) uses camelCase.
    const d = camelKeys(ev.data);
    const ts = Number(d.ts ?? blockTime ?? Math.floor(Date.now() / 1000));
    const pool = POOL_EVENTS.has(ev.name) ? this.pk(d.pool) : null;
    const trader = TRADER_EVENTS.has(ev.name) ? this.pk(d.trader) : null;
    const fresh = await this.store.insertEvent({ sig: ev.sig, idx: ev.idx, slot: ev.slot, ts, name: ev.name, pool, trader, data: plain(d) });
    if (!fresh) return;
    this.lastEventTs = Math.max(this.lastEventTs, ts);

    switch (ev.name) {
      case "TradeFilled": {
        const t: TradeRow = {
          sig: ev.sig, idx: ev.idx, ts, pool: pool!, marketId: d.marketId, side: d.side, isClose: d.isClose,
          baseQty: d.baseQty.toString(), fillPrice: d.fillPrice.toString(), oraclePrice: d.oraclePrice.toString(),
          oracleSlot: f(d.oracleSlot), fee: d.fee.toString(), realizedPnl: d.realizedPnl.toString(),
          navAfter: d.navAfter.toString(), positionQtyAfter: d.positionQtyAfter.toString(),
        };
        await this.store.insertTrade(t);
        this.hub.broadcast({ type: "trade", trade: tradeView(t, this.markets()) });
        if (!t.isClose) {
          for (const a of await checkForHedges(this.store, t, this.markets())) {
            const data = { ...a, symbol: symbolOf(this.markets(), a.marketId), symbolA: symbolOf(this.markets(), a.marketIdA) };
            log.warn({ alert: data }, "CROSS-POOL HEDGE detected");
            await this.raiseAlert(a.type, a.ts, data, (id) => hedgeNotification({ id, ...data }));
          }
        }
        break;
      }
      case "NavMarked": {
        await this.store.insertNavMark({
          pool: pool!, ts, nav: d.nav.toString(), nps: d.navPerShare.toString(), peakNav: d.peakNav.toString(),
          dayStartNav: d.dayStartNav.toString(), grossNotional: d.grossNotional.toString(),
        });
        this.hub.broadcast({
          // `nav` is total equity (what the loss limits measure); `investorNav`
          // is what the shares are worth, i.e. equity minus the unspent part of
          // the trader's first-loss seed. `navPerShare` is priced off the latter.
          type: "nav", pool, nav: f(d.nav) / 1e6, investorNav: f(d.investorNav) / 1e6,
          navPerShare: f(d.navPerShare) / 1e9, peakNav: f(d.peakNav) / 1e6,
          dayStartNav: f(d.dayStartNav) / 1e6, grossNotional: f(d.grossNotional) / 1e6, ts,
        });
        break;
      }
      case "Deposited":
      case "RedemptionSettled": {
        // Deposits/redemptions move NAV without a keeper mark; record a point so the curve stays continuous.
        const nav = ev.name === "Deposited" ? d.navAfter.toString() : "0";
        if (ev.name === "Deposited") {
          await this.store.insertNavMark({ pool: pool!, ts, nav, nps: d.navPerShare.toString(), peakNav: "0", dayStartNav: "0", grossNotional: "0" });
        }
        break;
      }
      case "StopSet": {
        // `worstCase` is the pool's loss if every position exited at its stop
        // at once. The headroom the pre-trade guard holds above the floors,
        // and the number that stays true with no keeper running.
        this.hub.broadcast({
          type: "stop",
          pool,
          marketId: d.marketId,
          stopPx: f(d.stopPx) / 1e6,
          worstCase: usd(d.worstCase),
          nav: usd(d.nav),
          ts,
        });
        break;
      }
      case "TrialRootCommitted": {
        await this.store.upsertTrialRoot({ trader: trader!, day: d.day, root: Buffer.from(d.root).toString("hex"), ts, sig: ev.sig });
        break;
      }
      case "PoolLocked": {
        const reason = lockReasonOf(d.reason);
        this.hub.broadcast({ type: "lock", pool, reason, nav: usd(d.nav), ts });
        const data = { pool: pool!, trader: trader ?? (await this.store.pool(pool!))?.data?.trader ?? null, reason, nav: usd(d.nav), escrowReturned: usd(d.escrowReturned), caller: this.pk(d.caller), sig: ev.sig, ts };
        log.warn(data, "POOL LOCKED");
        await this.raiseAlert("pool_locked", ts, data, () => lockNotification(data));
        break;
      }
      case "PlatformPaused": {
        const data = { paused: !!d.paused, sig: ev.sig, ts };
        log.warn(data, d.paused ? "PLATFORM PAUSED" : "platform unpaused");
        await this.raiseAlert("platform_paused", ts, data, () => pauseNotification(data));
        break;
      }
      default:
        break;
    }
    this.hub.broadcast({ type: "event", name: ev.name, pool: pool ?? undefined, ts, data: plain(d) });
  }

  async start() {
    const parser = eventParser();
    const since = await this.store.getCursor(CURSOR);

    // Live first: new marks / fills flow immediately even while a (rate-limited) backfill runs.
    // insertEvent de-duplicates by (sig, idx), so an event seen live and again during backfill is stored once.
    let liveCursor: string | null = null;
    this.connection.onLogs(
      env.programId,
      async (logs, ctx) => {
        if (logs.err) return;
        try {
          const events = decodeLogs(parser, logs.logs, logs.signature, ctx.slot);
          for (const e of events) await this.handle(e, null);
          if (events.length) {
            liveCursor = logs.signature;
            await this.store.setCursor(CURSOR, logs.signature);
          }
        } catch (e) {
          log.error({ err: String(e), sig: logs.signature }, "event handling failed");
        }
      },
      "confirmed",
    );
    log.info("subscribed to program logs");

    if (since) {
      // Warm start: replay everything the program emitted since the cursor.
      log.info({ since }, "backfilling since cursor");
      const newest = await backfill(
        this.connection,
        parser,
        since,
        async (events, bt) => {
          for (const e of events) await this.handle(e, bt);
        },
        { onProgress: (done, total) => log.info({ done, total }, "backfill progress") },
      );
      // Never move the cursor backwards past something the live subscription already recorded.
      if (newest && !liveCursor) await this.store.setCursor(CURSOR, newest);
      log.info({ newest, liveCursor }, "backfill complete");
    } else {
      // Cold start: the program's history is dominated by keeper price pushes / marks (a full walk
      // takes hours on a rate-limited public RPC and only yields NAV marks the live subscription
      // already delivers). Trades, deposits and pool lifecycle transactions are signed by
      // traders/investors, so replaying each known trader wallet's short signature list recovers
      // them cheaply. Events already stored are skipped by insertEvent's (sig, idx) key.
      log.info({ maxSigsPerTrader: env.backfillMaxSigs }, "cold start: skipping the program-wide walk, replaying trader wallets");
    }

    if (!since && this.traderWallets) {
      try {
        const wallets = await this.traderWallets();
        log.info({ traders: wallets.length, maxSigsEach: env.backfillMaxSigs }, "replaying trader wallets");
        // Two passes: anything skipped by a throttled / failed batch in pass 1 is retried in pass 2
        // (already-stored events are de-duplicated, so the second pass is cheap).
        for (let pass = 1; pass <= 2; pass++) {
          let skipped = 0;
          for (const w of wallets) {
            await backfill(
              this.connection,
              parser,
              null,
              async (events, bt) => {
                for (const e of events) await this.handle(e, bt);
              },
              {
                maxSigs: env.backfillMaxSigs,
                address: w,
                onProgress: (done, total) => done % 25 === 0 && log.info({ wallet: w.toBase58(), done, total, pass }, "trader replay progress"),
                onSkip: (sigs, err) => {
                  skipped += sigs.length;
                  log.warn({ wallet: w.toBase58(), sigs: sigs.length, err, pass }, "batch skipped after retries");
                },
              },
            );
            log.info({ wallet: w.toBase58(), pass }, "trader wallet replayed");
          }
          if (!skipped) break;
          log.warn({ skipped, pass }, "some batches were skipped. Running another pass in 30 s");
          await new Promise((r) => setTimeout(r, 30_000));
        }
        log.info("trader wallet replay complete");
      } catch (e) {
        log.warn({ err: String(e) }, "trader wallet replay failed (live ingestion unaffected)");
      }
    }
  }
}
