/** Live backend: on-chain `place_trade` / `close_trade` via the SDK client + wallet-adapter provider. */
import BN from "bn.js";
import { ComputeBudgetProgram, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { PRICE_SCALE, QTY_SCALE, VaultClient, type MarketLike } from "@kydo/sdk";
import { indexer } from "../api";
import { CHAIN_POLL_MS } from "../config";
import {
  chainPositionsToView,
  computeLiveMarks,
  liveNps,
  poolName,
  poolStatus,
  stopFor,
  toPositionLike,
  type ChainConfig,
  type ChainPool,
} from "../chain";
import { fromPrice, npsToFloat, usdWhole } from "../format";
import { priceStore } from "../prices";
import { sessionKeypair } from "../session";
import { liveFeed } from "../ws";
import type { BackendState, CloseOrderArgs, HistoryRow, OrderResult, PlaceOrderArgs, TradingBackend } from "./types";

export interface LiveDeps {
  client: VaultClient;
  trader: PublicKey;
  pool: PublicKey;
  markets: MarketLike[];
  config: ChainConfig;
  symbols: Record<number, string>;
}

export class LiveBackend implements TradingBackend {
  readonly mode = "live" as const;
  private pool: ChainPool | null = null;
  private view: BackendState | null = null;
  private listeners = new Set<(s: BackendState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubs: (() => void)[] = [];
  private lastError: string | undefined;
  private inflight: Promise<void> | null = null;

  constructor(private readonly d: LiveDeps) {}

  get poolAddress() {
    return this.d.pool;
  }

  getState() {
    return this.view;
  }

  subscribe(cb: (s: BackendState) => void) {
    this.listeners.add(cb);
    if (this.listeners.size === 1) {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), CHAIN_POLL_MS);
      this.unsubs.push(priceStore.subscribe(() => this.emit()));
      const addr = this.d.pool.toBase58();
      this.unsubs.push(
        liveFeed.on("trade", (m) => {
          if (m.trade.pool === addr) void this.refresh();
        }),
        liveFeed.on("lock", (m) => {
          if (m.pool === addr) void this.refresh();
        }),
        liveFeed.on("event", (m) => {
          if (m.pool === addr) void this.refresh();
        }),
      );
    }
    if (this.view) cb(this.view);
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  dispose() {
    this.stop();
    this.listeners.clear();
  }

  async refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        this.pool = (await this.d.client.pool(this.d.pool)) as ChainPool;
        this.lastError = undefined;
      } catch (e) {
        this.lastError = (e as Error).message;
      } finally {
        this.inflight = null;
      }
      this.emit();
    })();
    return this.inflight;
  }

  private emit() {
    this.view = this.build();
    for (const l of this.listeners) l(this.view);
  }

  private build(): BackendState {
    const pool = this.pool;
    const prices = priceStore.getSnapshot().prices;
    if (!pool) {
      return {
        mode: "live",
        label: "LIVE",
        nav: 0,
        dayStartNav: 0,
        peakNav: 0,
        grossNotional: 0,
        unrealizedPnl: 0,
        positions: [],
        tradesToday: 0,
        totalTrades: 0,
        poolAddress: this.d.pool.toBase58(),
        raw: { nav: new BN(0), dayStartNav: new BN(0), peakNav: new BN(0), positions: [], marks: {} },
        ready: false,
        tradable: false,
        tradableReason: this.lastError ? `pool fetch failed: ${this.lastError}` : "loading pool…",
        updatedAt: Date.now(),
        error: this.lastError,
      };
    }
    const m = computeLiveMarks(pool, prices);
    const status = poolStatus(pool);
    const cap = this.d.config.tierCaps[Math.max(0, Math.min(2, pool.tier - 1))];
    const label = `LIVE · ${poolName(pool) || "pool #" + pool.index} · Tier ${pool.tier} · ${usdWhole(fromPrice(m.nav))} investor capital · cap ${usdWhole(fromPrice(cap))}`;
    const positions = chainPositionsToView(pool, prices, this.d.symbols);
    const tradable = status === "live" && !this.d.config.paused;
    return {
      mode: "live",
      label,
      nav: fromPrice(m.nav),
      dayStartNav: fromPrice(pool.dayStartNav),
      peakNav: Math.max(fromPrice(pool.peakNav), fromPrice(m.nav)),
      grossNotional: fromPrice(m.grossNotional),
      unrealizedPnl: fromPrice(m.unrealized),
      positions,
      tradesToday: pool.tradesToday,
      totalTrades: pool.totalTrades,
      navPerShare: liveNps(pool, m.nav),
      hwmNps: npsToFloat(pool.hwmNps),
      tierStartNps: npsToFloat(pool.tierStartNps),
      pool,
      poolAddress: this.d.pool.toBase58(),
      poolStatus: status,
      raw: {
        nav: m.nav,
        dayStartNav: new BN(pool.dayStartNav),
        peakNav: BN.max(new BN(pool.peakNav), m.nav),
        positions: pool.positions
          .filter((p) => p.side !== 0 && !new BN(p.baseQty).isZero())
          .map((p) => toPositionLike(p, stopFor(pool, p.marketId))),
        marks: m.marks,
      },
      ready: true,
      tradable,
      tradableReason: tradable
        ? undefined
        : this.d.config.paused
          ? "platform paused"
          : status === "funding"
            ? "pool is Funding. Activates at the $1,000 floor"
            : `pool is ${status}`,
      updatedAt: Date.now(),
      error: this.lastError,
    };
  }

  private oracles(extraMarketId?: number) {
    if (!this.pool) throw new Error("pool not loaded");
    return this.d.client.oracleMetas(this.d.markets, this.pool, extraMarketId);
  }

  /**
   * Send a trade instruction. With an active session key (lib/session.ts) the
   * transaction is signed locally by that key. No wallet popup; otherwise the
   * wallet signs. Trades get a compute budget large enough for Drift CPIs.
   */
  /** True once we detect that the deployed program predates session keys (old account layout). */
  private legacyProgram = false;

  private cu() {
    return ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
  }

  /**
   * Simulate a transaction *before* asking the wallet to sign, so the user never
   * sees a wallet-side "simulation failed" and program errors surface as text.
   * Returns the Anchor error code (or a generic message) when it fails.
   */
  private async simulate(tx: Transaction, feePayer: PublicKey): Promise<{ ok: true } | { ok: false; code: string; logs: string[] }> {
    const connection = this.d.client.provider.connection;
    tx.feePayer = feePayer;
    tx.recentBlockhash = (await connection.getLatestBlockhash("finalized")).blockhash;
    // replaceRecentBlockhash: the simulating node substitutes its own latest blockhash, so a load-balanced
    // public RPC can never answer "Blockhash not found" for a simulation.
    const sim = await connection
      .simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true })
      .catch((e) => ({ value: { err: String(e), logs: [] as string[] } }));
    const v: any = sim.value;
    if (!v.err) return { ok: true };
    const logs: string[] = v.logs ?? [];
    const m = logs.map((l) => /Error Code: ([A-Za-z]+)/.exec(l)?.[1]).find(Boolean);
    const acct = logs.map((l) => /caused by account: ([a-z_]+)/.exec(l)?.[1]).find(Boolean);
    return { ok: false, code: m ? `${m}${acct ? `@${acct}` : ""}` : JSON.stringify(v.err), logs };
  }

  private async sendLegacy(ix: any): Promise<string> {
    const tx = new Transaction().add(this.cu(), ix);
    const sim = await this.simulate(tx, this.d.trader);
    if (!sim.ok) throw Object.assign(new Error(`Error Code: ${sim.code.split("@")[0]}`), { logs: sim.logs, code: sim.code.split("@")[0] });
    return this.d.client.provider.sendAndConfirm!(tx);
  }

  private async sendTrade(build: (sessionSigner?: PublicKey) => any, legacy: () => any): Promise<string> {
    if (this.legacyProgram) return this.sendLegacy(legacy());
    const session = sessionKeypair(this.d.trader.toBase58());
    const signer = session?.publicKey;
    const tx: Transaction = await build(signer).preInstructions([this.cu()]).transaction();
    const sim = await this.simulate(tx, signer ?? this.d.trader);
    if (!sim.ok) {
      // Old program: our 2nd account (trader) lands where it expects `pool` → discriminator / owner mismatch on `pool`.
      const outdated = /^(AccountDiscriminatorMismatch|AccountNotInitialized|AccountOwnedByWrongProgram)@pool$/.test(sim.code);
      if (outdated) {
        console.warn("[live] deployed program predates session keys. Using legacy trade layout");
        this.legacyProgram = true;
        return this.sendLegacy(legacy());
      }
      throw Object.assign(new Error(`Error Code: ${sim.code.split("@")[0]}`), { logs: sim.logs, code: sim.code.split("@")[0] });
    }
    if (!session) return this.d.client.provider.sendAndConfirm!(tx);
    const connection = this.d.client.provider.connection;
    tx.sign(session);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  async placeOrder(args: PlaceOrderArgs): Promise<OrderResult> {
    if (!this.pool) await this.refresh();
    const tradeArgs = {
      marketId: args.marketId,
      side: args.side === "short" ? 2 : 1,
      notional: args.notionalRaw ?? new BN(Math.round(args.notionalUsd * PRICE_SCALE)),
      limitPx: new BN(Math.round((args.limitPx ?? 0) * PRICE_SCALE)),
      stopPx: new BN(Math.round((args.stopPx ?? 0) * PRICE_SCALE)),
    };
    const sig = await this.sendTrade(
      (s) => this.d.client.placeTrade(this.d.trader, this.d.pool, tradeArgs, this.oracles(args.marketId), s),
      () => this.d.client.placeTradeLegacyIx(this.d.trader, this.d.pool, tradeArgs, this.oracles(args.marketId)),
    );
    await this.refresh();
    return { sig };
  }

  async closeOrder(args: CloseOrderArgs): Promise<OrderResult> {
    if (!this.pool) await this.refresh();
    const closeArgs = {
      marketId: args.marketId,
      baseQty: new BN(Math.round((args.baseQty ?? 0) * QTY_SCALE)),
      limitPx: new BN(Math.round((args.limitPx ?? 0) * PRICE_SCALE)),
    };
    const sig = await this.sendTrade(
      (s) => this.d.client.closeTrade(this.d.trader, this.d.pool, closeArgs, this.oracles(args.marketId), s),
      () => this.d.client.closeTradeLegacyIx(this.d.trader, this.d.pool, closeArgs, this.oracles(args.marketId)),
    );
    await this.refresh();
    return { sig };
  }

  // ---------- pool management / escrow (live only) ----------
  async vestEscrow(): Promise<string> {
    const sig = await this.d.client.vestEscrow(this.d.pool).rpc();
    await this.refresh();
    return sig;
  }
  async claimFees(usdcMint: PublicKey): Promise<string> {
    if (!this.pool) await this.refresh();
    const sig = await this.d.client.claimTraderFees(this.d.trader, this.d.pool, usdcMint, this.oracles()).rpc();
    await this.refresh();
    return sig;
  }
  async activate(): Promise<string> {
    const sig = await this.d.client.activatePool(this.d.pool, this.d.client.pda.trader(this.d.trader)).rpc();
    await this.refresh();
    return sig;
  }
  async promote(): Promise<string> {
    if (!this.pool) await this.refresh();
    const sig = await this.d.client.promoteTier(this.d.trader, this.d.pool, this.d.client.pda.trader(this.d.trader), this.oracles()).rpc();
    await this.refresh();
    return sig;
  }
  async closePool(): Promise<string> {
    const sig = await this.d.client.closePool(this.d.trader, this.d.pool).rpc();
    await this.refresh();
    return sig;
  }

  async history(): Promise<HistoryRow[]> {
    const { trades } = await indexer.poolTrades(this.d.pool.toBase58(), { limit: 100 });
    return trades.map((t) => ({
      id: t.sig,
      ts: t.ts,
      marketId: t.marketId,
      symbol: t.symbol || this.d.symbols[t.marketId] || `#${t.marketId}`,
      side: t.side,
      action: t.isClose ? "close" : "open",
      baseQty: t.baseQty,
      fillPrice: t.fillPrice,
      oraclePrice: t.oraclePrice,
      fee: t.fee,
      realizedPnl: t.realizedPnl,
      navAfter: t.navAfter,
    }));
  }
}
