"use client";
/**
 * App-wide context: on-chain PlatformConfig + MarketRegistry (chain is the
 * source of truth; the indexer `/config` is optional), the connected trader's
 * profile (chain + indexer), indexer health, and the price feed fallbacks.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import { PYTH_RECEIVER_PROGRAM_ID, parsePriceUpdateV2, type MarketLike } from "@kydo/sdk";
import { indexer, trial, type ConfigJson, type TraderDetail } from "./api";
import { CHAIN_POLL_MS, HEALTH_POLL_MS, PRICE_POLL_MS, USDC_MINT_ENV } from "./config";
import { type ChainConfig, type ChainMockOracle, type ChainProfile, type TraderStatus, profileStatus, isDefaultKey } from "./chain";
import { priceStore, type Tick } from "./prices";
import { useVaultClient } from "./solana";
import { liveFeed, useLiveFeed } from "./ws";

export interface Registry {
  markets: MarketLike[];
  count: number;
}

export interface PlatformCtx {
  config: ChainConfig | null;
  registry: Registry | null;
  apiConfig: ConfigJson | null;
  usdcMint: PublicKey | null;
  symbols: Record<number, string>;
  marketById: (id: number) => MarketLike | undefined;
  chainError: string | null;
  indexerOnline: boolean;
  trialOnline: boolean;
  /** trial engine allows the dev-only force-pass finalize */
  trialDevForcePass: boolean;
  refreshPlatform: () => Promise<void>;
  // trader
  wallet: PublicKey | null;
  profile: ChainProfile | null;
  profileLoaded: boolean;
  status: TraderStatus;
  traderDetail: TraderDetail | null;
  refreshProfile: () => Promise<void>;
}

const Ctx = createContext<PlatformCtx | null>(null);

export function PlatformProvider({ children }: { children: React.ReactNode }) {
  const { readonly } = useVaultClient();
  const { publicKey } = useWallet();
  const { status: feedStatus } = useLiveFeed();

  const [config, setConfig] = useState<ChainConfig | null>(null);
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [apiConfig, setApiConfig] = useState<ConfigJson | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [indexerOnline, setIndexerOnline] = useState(false);
  const [trialOnline, setTrialOnline] = useState(false);
  const [trialDevForcePass, setTrialDevForcePass] = useState(false);
  const [profile, setProfile] = useState<ChainProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [traderDetail, setTraderDetail] = useState<TraderDetail | null>(null);

  const refreshPlatform = useCallback(async () => {
    try {
      const [cfg, reg] = await Promise.all([readonly.config(), readonly.registry()]);
      setConfig(cfg as ChainConfig);
      setRegistry(reg);
      setChainError(null);
    } catch (e) {
      setChainError((e as Error).message ?? String(e));
    }
    try {
      setApiConfig(await indexer.config());
    } catch {
      /* indexer optional */
    }
  }, [readonly]);

  useEffect(() => {
    void refreshPlatform();
  }, [refreshPlatform]);

  // indexer + trial engine health pills
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      const [a, b] = await Promise.allSettled([indexer.health(), trial.health()]);
      if (!alive) return;
      setIndexerOnline(a.status === "fulfilled" && !!a.value?.ok);
      setTrialOnline(b.status === "fulfilled" && !!b.value?.ok);
      setTrialDevForcePass(b.status === "fulfilled" && !!b.value?.devForcePass);
    };
    void ping();
    const t = setInterval(ping, HEALTH_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // trader profile (chain) + detail (indexer)
  const refreshProfile = useCallback(async () => {
    if (!publicKey) {
      setProfile(null);
      setTraderDetail(null);
      setProfileLoaded(true);
      return;
    }
    try {
      const p = (await readonly.trader(publicKey)) as ChainProfile | null;
      setProfile(p);
      setProfileLoaded(true);
    } catch {
      setProfileLoaded(true);
    }
    try {
      setTraderDetail(await indexer.trader(publicKey.toBase58()));
    } catch {
      setTraderDetail(null);
    }
  }, [publicKey, readonly]);

  useEffect(() => {
    setProfileLoaded(false);
    void refreshProfile();
    const t = setInterval(refreshProfile, CHAIN_POLL_MS * 2);
    return () => clearInterval(t);
  }, [refreshProfile]);

  // ---- deep chart history: multi-day 1m OHLC (Binance klines via the indexer), once per market ----
  //
  // Deliberately NOT cancelled on cleanup. `registry` is a fresh object on every
  // refreshPlatform(), and autoConnect flips the wallet from undefined to
  // connected a beat after load, which rebuilds `readonly`, hence
  // refreshPlatform, hence registry. An `alive` flag that discarded a completed
  // fetch therefore threw away whichever market was in flight at that moment,
  // while `deepHist` had already marked it done, so it never retried and that
  // market simply had no history for the rest of the session.
  //
  // Nothing here touches component state. `priceStore` is a module singleton
  // that outlives the effect and the route, so a backfill landing late is
  // always worth applying, never a leak.
  const deepHist = useRef(new Set<number>());
  useEffect(() => {
    const ids = (registry?.markets ?? []).map((m) => m.marketId).filter((id) => !deepHist.current.has(id));
    if (!ids.length) return;
    // Parallel, not sequential: five markets at ~3.5 s each made the last one
    // wait ~17 s for its history. The indexer caches per market, so this is one
    // upstream fetch either way.
    void Promise.all(
      ids.map(async (id) => {
        deepHist.current.add(id);
        try {
          const r = await indexer.candles(id);
          priceStore.backfillCandles(id, r.candles.map((c) => ({ ...c, volume: c.v })));
        } catch {
          deepHist.current.delete(id); // retry on the next registry refresh
        }
      }),
    );
  }, [registry]);

  // ---- price feed fallbacks: /prices poll when WS is not delivering, chain mock oracles when the indexer is down ----
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const feedRef = useRef(feedStatus);
  feedRef.current = feedStatus;
  useEffect(() => {
    let alive = true;
    // One-time chart backfill from the indexer's recent tick history (candles otherwise start empty).
    indexer
      .priceHistory(undefined, Math.floor(Date.now() / 1000) - 12 * 3600)
      .then((r) => {
        if (!alive) return;
        for (const [id, ticks] of Object.entries(r.history)) priceStore.backfill(Number(id), ticks);
      })
      .catch(() => {});
    const tick = async () => {
      const fresh = feedRef.current === "open" && Date.now() - liveFeed.lastMessageAt < PRICE_POLL_MS * 2;
      if (fresh) return;
      try {
        const map = await indexer.prices();
        if (!alive) return;
        priceStore.bulk(map as Record<string, Tick>, "poll");
        return;
      } catch {
        /* fall through to chain */
      }
      const reg = registryRef.current;
      if (!reg) return;
      try {
        const out: Record<string, Tick> = {};
        // Oracle accounts are either program-owned MockOracles or Pyth PriceUpdateV2 (PYTH_MODE=pull). Decode by owner.
        const infos = await readonly.provider.connection.getMultipleAccountsInfo(reg.markets.map((m) => m.oracle));
        infos.forEach((info, i) => {
          if (!info) return;
          const id = String(reg.markets[i].marketId);
          if (info.owner.equals(readonly.programId)) {
            const o = (readonly.program.coder.accounts as any).decode("mockOracle", info.data) as ChainMockOracle;
            const price = Number(new BN(o.price).toString()) * 10 ** o.expo;
            const conf = Number(new BN(o.conf).toString()) * 10 ** o.expo;
            out[id] = { price, conf, ts: Number(o.publishTime.toString()) };
          } else if (info.owner.equals(PYTH_RECEIVER_PROGRAM_ID)) {
            const p = parsePriceUpdateV2(info.data);
            if (p) out[id] = { price: Number(p.price) * 10 ** p.expo, conf: Number(p.conf) * 10 ** p.expo, ts: p.publishTime };
          }
        });
        if (alive) priceStore.bulk(out, "chain");
      } catch {
        /* no prices available */
      }
    };
    void tick();
    const t = setInterval(tick, PRICE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [readonly]);

  const symbols = useMemo(() => {
    const s: Record<number, string> = {};
    for (const m of registry?.markets ?? []) s[m.marketId] = m.symbol;
    return s;
  }, [registry]);

  const usdcMint = useMemo(() => {
    if (config?.usdcMint && !isDefaultKey(config.usdcMint)) return config.usdcMint;
    if (apiConfig?.usdcMint) return new PublicKey(apiConfig.usdcMint);
    if (USDC_MINT_ENV) return new PublicKey(USDC_MINT_ENV);
    return null;
  }, [config, apiConfig]);

  const value: PlatformCtx = useMemo(
    () => ({
      config,
      registry,
      apiConfig,
      usdcMint,
      symbols,
      marketById: (id: number) => registry?.markets.find((m) => m.marketId === id),
      chainError,
      indexerOnline,
      trialOnline,
      trialDevForcePass,
      refreshPlatform,
      wallet: publicKey ?? null,
      profile,
      profileLoaded,
      status: profileStatus(profile),
      traderDetail,
      refreshProfile,
    }),
    [config, registry, apiConfig, usdcMint, symbols, chainError, indexerOnline, trialOnline, trialDevForcePass, refreshPlatform, publicKey, profile, profileLoaded, traderDetail, refreshProfile],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlatform(): PlatformCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePlatform outside PlatformProvider");
  return v;
}
