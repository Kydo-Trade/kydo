/**
 * Keeper service (C4).
 *
 * Every `KEEPER_INTERVAL_MS` (default 3 s, spec ≤ 5 s):
 *   1. push fresh Hermes prices into any mock oracles the registry points at
 *      (localnet / plain devnet). With `PYTH_MODE=pull` a separate loop
 *      (`PythPusher`, every `PRICE_PUSH_MS`) posts real Pyth `PriceUpdateV2`
 *      accounts for the markets whose registry oracle is this keeper's
 *      derived price-update account (see `packages/sdk/src/pyth.ts`).
 *   2. for each Live pool: predict NAV off-chain → breach? `lock_pool` via the
 *      critical path (Jito) : `evaluate_risk` mark
 *   3. for each Locked pool with open positions → `unwind_all`
 *   4. for each investor with a pending, un-unwound redemption → `unwind_for_redemption`
 *   5. once per UTC day per pool with escrow → `vest_escrow`
 *
 * All of these are permissionless and bountied, so any third party can run
 * this same binary (section 3.2).
 */
import { AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import pino from "pino";
import { VaultClient, MarketLike, pythPriceUpdateAddress, DEAD_SHARES } from "@kydo/sdk";
import { env } from "./config";
import { PriceGateway } from "./prices";
import { PythPusher } from "./pyth";
import { breach, computeNav, openPositions, utilisation } from "./risk";
import { sendCritical, sendWithPriority } from "./tx";

const log = pino({ level: env.logLevel, name: "keeper", transport: process.stdout.isTTY ? { target: "pino-pretty" } : undefined });

const feedHex = (feedId: number[]) => Buffer.from(feedId).toString("hex");

/**
 * `PYTH_MODE=pull`: post Pyth price updates for every non-mock market whose registry
 * `oracle` is this keeper's derived price-update account (`bootstrap --pyth` registers
 * exactly those). Other Pyth-owned oracles are somebody else's accounts. Left alone.
 * Returns the (started) pusher, or undefined when nothing is pushable.
 */
async function setupPythPusher(connection: Connection, markets: MarketLike[], mockOracleIds: Set<number>, config: any): Promise<PythPusher | undefined> {
  const feeds: string[] = [];
  for (const m of markets) {
    if (mockOracleIds.has(m.marketId)) continue;
    const hex = feedHex(m.feedId);
    if (/^0+$/.test(hex)) continue;
    const expected = pythPriceUpdateAddress(env.keeper, hex);
    if (m.oracle.equals(expected)) feeds.push(hex);
    else
      log.warn(
        { market: m.symbol, oracle: m.oracle.toBase58(), expected: expected.toBase58() },
        "registry oracle is not this keeper's Pyth price-update account; not pushing it (run `pnpm devnet:bootstrap --pyth` with KEEPER_KEYPAIR = this key)",
      );
  }
  if (!feeds.length) {
    log.warn("PYTH_MODE=pull but no market points at this keeper's Pyth accounts; only mock oracles (if any) will be fed");
    return undefined;
  }
  const pusher = new PythPusher(connection, env.keeper, feeds);
  await pusher.verifyAccounts();
  const maxAgeSlots = Number(config.risk.oracleMaxAgeSlots);
  if (env.pricePushMs > (maxAgeSlots * 400) / 2)
    log.warn({ pricePushMs: env.pricePushMs, oracleMaxAgeSlots: maxAgeSlots }, "PRICE_PUSH_MS exceeds half the oracle staleness window; a slow round (~8 sequential txs) will leave feeds stale");
  if (env.pythDryRun) {
    await pusher.dryRun();
    return pusher;
  }
  await pusher.reclaimOrphanedVaas();
  await pusher.start(env.pricePushMs);
  log.info({ feeds: feeds.length, everyMs: env.pricePushMs }, "Pyth pull pusher started");
  return pusher;
}

async function main() {
  const connection = new Connection(env.rpcUrl, { commitment: "confirmed", wsEndpoint: env.wsUrl });
  const provider = new AnchorProvider(connection, new Wallet(env.keeper), { commitment: "confirmed" });
  const client = new VaultClient(provider, env.programId);
  const keeper = env.keeper.publicKey;
  log.info({ keeper: keeper.toBase58(), program: env.programId.toBase58(), rpc: env.rpcUrl, pythMode: env.pythMode, dryRun: env.pythDryRun }, "starting");
  if (env.pythDryRun && env.pythMode !== "pull") throw new Error("PYTH_DRY_RUN=true only makes sense with PYTH_MODE=pull");

  const config = await client.config();
  const usdcMint: PublicKey = config.usdcMint;

  let { markets } = await client.registry();
  const mockOracleIds = new Set<number>();
  for (const m of markets) {
    const info = await connection.getAccountInfo(m.oracle);
    if (info?.owner.equals(env.programId)) mockOracleIds.add(m.marketId);
  }
  log.info({ markets: markets.map((m) => m.symbol), mockOracles: [...mockOracleIds] }, "registry loaded");

  // Does this keeper actually feed the oracles the registry reads? Getting this
  // wrong is silent at startup and then shows up only as evaluate_risk
  // reverting on OracleStale forever, which reads like an RPC problem.
  //
  // mock: `set_mock_price` is signed by the platform's `price_authority`, and
  //       the account has to be a program-owned MockOracle.
  // pull: the PriceUpdateV2 addresses are derived from THIS key, so a registry
  //       bootstrapped against a different keeper points at accounts this one
  //       will never write.
  {
    const orphaned = markets.filter((m) => m.enabled && !mockOracleIds.has(m.marketId));
    if (env.pythMode === "mock") {
      if (!config.priceAuthority.equals(keeper))
        log.error({ keeper: keeper.toBase58(), priceAuthority: config.priceAuthority.toBase58() }, "PYTH_MODE=mock but this keeper is not the platform's price_authority. Set_mock_price will be rejected and every feed will go stale");
      if (orphaned.length)
        log.error(
          { markets: orphaned.map((m) => m.symbol), oracles: orphaned.map((m) => m.oracle.toBase58()) },
          "PYTH_MODE=mock but these enabled markets do not point at program-owned mock oracles. This keeper cannot feed them and they will sit stale. The registry was bootstrapped for Pyth pull mode: run with PYTH_MODE=pull using the key the registry was bootstrapped against, or re-run `pnpm devnet:bootstrap --mock`",
        );
    }
    const fed = new Set<number>([...mockOracleIds]);
    if (env.pythMode === "pull") for (const m of markets) if (m.oracle.equals(pythPriceUpdateAddress(env.keeper, Buffer.from(m.feedId).toString("hex")))) fed.add(m.marketId);
    const unfed = markets.filter((m) => m.enabled && !fed.has(m.marketId));
    if (unfed.length && env.pythMode === "pull")
      log.error(
        { markets: unfed.map((m) => m.symbol), keeper: keeper.toBase58() },
        "PYTH_MODE=pull but these enabled markets point at PriceUpdateV2 accounts derived from a DIFFERENT key. This keeper will post to addresses nothing reads. Re-bootstrap with KEEPER_KEYPAIR set to this key",
      );
  }

  // (1b) Pyth pull mode. Before anything that sends, so a dry run never spends SOL.
  const pyth = env.pythMode === "pull" ? await setupPythPusher(connection, markets, mockOracleIds, config) : undefined;
  if (env.pythDryRun) {
    log.info("PYTH_DRY_RUN=true: nothing was sent; exiting");
    process.exit(0);
  }

  // Bounties are paid to the keeper's USDC ATA. Make sure it exists.
  const keeperUsdc = getAssociatedTokenAddressSync(usdcMint, keeper);
  try {
    await getAccount(connection, keeperUsdc);
  } catch {
    await sendWithPriority(connection, env.keeper, [
      createAssociatedTokenAccountIdempotentInstruction(keeper, keeperUsdc, keeper, usdcMint),
    ], { label: "create keeper ata" });
  }

  const feeds = markets.map((m) => feedHex(m.feedId)).filter((h) => !/^0+$/.test(h));
  const feedKey = (m: MarketLike) => (feeds.length ? feedHex(m.feedId) : `local-${m.marketId}`);
  const gateway = new PriceGateway(
    markets.map(feedKey),
    Object.fromEntries(markets.map((m) => [feedKey(m), m.symbol])),
  );
  await gateway.start();

  const marksNow = (): Map<number, BN> => {
    const out = new Map<number, BN>();
    for (const m of markets) {
      const key = feeds.length ? feedHex(m.feedId) : `local-${m.marketId}`;
      const q = gateway.latest.get(key);
      if (q) out.set(m.marketId, new BN(q.price.toString()));
    }
    return out;
  };

  const vestedToday = new Map<string, number>();
  const lastVestEscrow = new Map<string, string>();
  // Throttle marking of FLAT live pools (no open positions): their NAV can't move
  // on a mark, so they can't breach. Marking them every tick just burns RPC and
  // helps trip the shared endpoint's rate limit. Pools WITH positions are never
  // throttled (they're the ones that can breach).
  const lastFlatMark = new Map<string, number>();
  /** Pools already warned about the incomplete Drift NAV mirror. Once each, not every tick. */
  const warnedDriftMirror = new Set<string>();
  const FLAT_MARK_MS = 55_000;

  // Run per-pool work with a small concurrency cap instead of all at once.
  // A burst of ~N evaluate_risk txs + reads in one tick is what trips the RPC
  // rate limit (429). Returns allSettled-style results.
  async function runLimited<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<PromiseSettledResult<void>[]> {
    const results = new Array<PromiseSettledResult<void>>(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        try {
          await fn(items[i]);
          results[i] = { status: "fulfilled", value: undefined };
        } catch (e) {
          results[i] = { status: "rejected", reason: e };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
    return results;
  }
  let lastPricePush = 0;
  let busy = false;

  // Fee-balance guard: with an empty keeper key every send fails with an opaque
  // "insufficient funds for rent" simulation error, once per tick, forever. Check the
  // balance (cached 60 s) and skip on-chain work with ONE clear, throttled error instead.
  const MIN_LAMPORTS = 5_000_000; // 0.005 SOL
  let balanceCache = { lamports: Number.MAX_SAFE_INTEGER, at: 0 };
  let lastBrokeLog = 0;
  const keeperFunded = async (): Promise<boolean> => {
    if (Date.now() - balanceCache.at > 60_000) {
      try {
        balanceCache = { lamports: await connection.getBalance(keeper), at: Date.now() };
      } catch {
        return true; // RPC hiccup: try the tick anyway
      }
    }
    if (balanceCache.lamports >= MIN_LAMPORTS) return true;
    if (Date.now() - lastBrokeLog > 300_000) {
      lastBrokeLog = Date.now();
      log.error(
        { keeper: keeper.toBase58(), sol: (balanceCache.lamports / 1e9).toFixed(5) },
        "keeper key is OUT OF SOL. Price pushes, marks and locks are paused. Fund it at https://faucet.solana.com (devnet), then this resumes automatically.",
      );
    }
    return false;
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (!(await keeperFunded())) return;
      // (1) price push for mock oracles
      const marks = marksNow();
      if (mockOracleIds.size && Date.now() - lastPricePush >= env.pricePushMs) {
        const ixs: TransactionInstruction[] = [];
        for (const m of markets) {
          if (!mockOracleIds.has(m.marketId)) continue;
          const key = feeds.length ? feedHex(m.feedId) : `local-${m.marketId}`;
          const q = gateway.latest.get(key);
          if (!q) continue;
          ixs.push(
            await client
              .setMockPrice(keeper, m.marketId, new BN(q.price.toString()), new BN(q.conf.toString()), -6)
              .instruction(),
          );
        }
        if (ixs.length) {
          await sendWithPriority(connection, env.keeper, ixs, { label: "set_mock_price", cuLimit: 200_000 });
          lastPricePush = Date.now();
        }
      }

      // (2)–(5) pools
      const pools = await client.allPools();
      // getProgramAccounts is expensive on public RPCs: only scan investor positions when needed.
      const needsUnwind = pools.some(({ account: p }: any) => p.openPositions > 0 && !new BN(p.pendingRedemptionShares).isZero());
      const investorPositions = needsUnwind ? await (client.program.account as any).investorPosition.all() : [];
      const daySecs = Number(config.trial.daySecs ?? 86_400);
      const today = Math.floor(Date.now() / 1000 / daySecs);

      await runLimited(pools, 3, async ({ publicKey, account: p }: any) => {
          const key = publicKey.toBase58();
          const status = Object.keys(p.status)[0];
          const oracles = () => client.oracleMetas(markets as MarketLike[], p);

          if (status === "live") {
            const { nav, missing } = computeNav(p, marks);
            if (missing.length && mockOracleIds.size) {
              // We feed the mock oracles ourselves: without a local price the on-chain oracle is stale too,
              // so an evaluate_risk would just be rejected (OracleStale). Wait for the next tick.
              log.warn({ pool: key, missing }, "no local mark yet for an open position; skipping this tick");
              return;
            }
            if (missing.length) log.warn({ pool: key, missing }, "no local mark for open position; sending mark anyway");
            // `computeNav` mirrors the program only for MockPerps, whose equity is
            // just the sum of position PnL. For Drift, `read_account_equity` adds
            // the collateral sitting at the venue, which this keeper never reads.
            // So the local NAV understates a Drift pool by its whole margin
            // balance and would read as a permanent breach, spamming lock_pool
            // transactions the chain correctly rejects with NoBreach.
            //
            // Treated exactly like a missing mark: no local prediction, just send
            // `evaluate_risk` and let the program's own arithmetic decide. That is
            // slower (a lock waits for the next tick's on-chain mark) but never
            // wrong. Remove this once the mirror reads Drift collateral.
            const driftPool = Object.keys(p.venue ?? {})[0] === "drift";
            if (driftPool && !warnedDriftMirror.has(key)) {
              warnedDriftMirror.add(key);
              log.warn({ pool: key }, "Drift pool: off-chain NAV mirror is incomplete, deferring every breach decision to the program");
            }
            // Same reasoning, third case: `dayStartNav` is only rewritten when
            // `roll_day` runs inside an instruction, and a flat pool is marked
            // only every FLAT_MARK_MS, so once the day has turned, this pool's
            // `dayStartNav` can still be yesterday's until the next mark lands.
            // And `breach()` measures today's NAV against it.
            //
            // Both directions are wrong and one is dangerous. Against a higher
            // stale day-start an ordinary move reads as a daily-loss breach, we
            // send lock_pool, and the program rolls the day first and rejects it
            // with NoBreach. Noisy and harmless. Against a lower one a REAL
            // breach reads as none, we never send lock_pool, and the pool trades
            // on through its loss limit until something else marks it.
            //
            // The program has the authoritative day: don't predict, just send
            // evaluate_risk (which rolls the day) and let it decide.
            const staleDay = Number(p.dayEpoch ?? today) !== today;
            if (staleDay) log.info({ pool: key, poolDay: Number(p.dayEpoch ?? 0), today }, "day has turned since this pool was marked; deferring the breach decision to the program");
            const trustLocalNav = !missing.length && !driftPool && !staleDay;
            const b = trustLocalNav ? breach(p, nav, config.risk) : "none";
            if (b !== "none") {
              log.warn({ pool: key, breach: b, nav: nav.toString() }, "BREACH → lock_pool");
              const ix = await client.lockPool(keeper, publicKey, p.profile, usdcMint, oracles()).instruction();
              const sig = await sendCritical(connection, env.keeper, [ix], `lock ${key}`);
              log.warn({ pool: key, sig }, "locked");
              return;
            }
            // A flat pool (no open positions) can't breach on a mark; mark it only
            // every FLAT_MARK_MS to keep its NavMarked/day-roll ticking without
            // burning an RPC call every tick. Pools with positions always mark.
            // (Guarded, not early-returned, so the expiry/vest checks below still run.)
            const flat = p.openPositions === 0;
            if (!flat || Date.now() - (lastFlatMark.get(key) ?? 0) >= FLAT_MARK_MS) {
              // Only meaningful when the local NAV is the program's NAV. See above.
              const u = trustLocalNav ? utilisation(p, nav, config.risk) : 0;
              if (u >= 0.75) log.info({ pool: key, utilisation: u.toFixed(2) }, "amber: ≥75% of a limit");
              const ix = await client.evaluateRisk(keeper, publicKey, p.profile, usdcMint, oracles()).instruction();
              await sendWithPriority(connection, env.keeper, [ix], { label: `mark ${key}` });
              if (flat) lastFlatMark.set(key, Date.now());
            }
          }

          // Pool past its end date (ends_at, 0 = open-ended): close it once flat. Close_pool is
          // permissionless after expiry. With positions still open the trader must go flat first
          // (place_trade already refuses new exposure on an expired pool).
          const endsAt = Number(p.endsAt ?? 0);
          if ((status === "live" || status === "funding") && endsAt > 0 && Date.now() / 1000 >= endsAt) {
            if (p.openPositions > 0) {
              log.warn({ pool: key, endsAt }, "pool expired with open positions. Waiting for the trader to go flat");
            } else {
              const ix = await client.closePool(keeper, publicKey, p.trader).instruction();
              const sig = await sendWithPriority(connection, env.keeper, [ix], { label: `close expired ${key}` });
              log.warn({ pool: key, sig }, "expired pool closed");
              return;
            }
          }

          if (status === "locked" && p.openPositions > 0) {
            const ix = await client.unwindAll(keeper, publicKey, p.profile, usdcMint, oracles()).instruction();
            const sig = await sendCritical(connection, env.keeper, [ix], `unwind ${key}`);
            log.warn({ pool: key, sig }, "unwound all positions");
          }

          // (4) pending redemptions needing an unwind
          if (p.openPositions > 0 && !new BN(p.pendingRedemptionShares).isZero()) {
            for (const { account: ip } of investorPositions as any[]) {
              if (!ip.pool.equals(publicKey) || ip.unwound || new BN(ip.pendingShares).isZero()) continue;
              const ix = await client
                .unwindForRedemption(keeper, publicKey, ip.investor, usdcMint, oracles())
                .instruction();
              const sig = await sendWithPriority(connection, env.keeper, [ix], { label: `unwind-redemption ${key}` });
              log.info({ pool: key, investor: ip.investor.toBase58(), sig }, "pro-rata unwind for redemption");
            }
          }

          // (5) daily vest. Skipped while a previous vest left escrow unchanged (nothing matured on-chain;
          // e.g. the deployed program counts days on a different clock than this keeper's config).
          const escrowNow = new BN(p.escrowTotal).toString();
          if (escrowNow !== "0" && vestedToday.get(key) !== today && lastVestEscrow.get(key) !== escrowNow) {
            const due = (p.escrow as any[]).some((b) => Number(b.amount) > 0 && b.unlockDay <= today);
            if (due) {
              const ix = await client.vestEscrow(publicKey).instruction();
              await sendWithPriority(connection, env.keeper, [ix], { label: `vest ${key}` });
              log.info({ pool: key, escrow: escrowNow }, "vest_escrow sent");
              lastVestEscrow.set(key, escrowNow);
            }
            vestedToday.set(key, today);
          }
        }).then((results) => {
        for (const r of results) if (r.status === "rejected") log.error({ err: String(r.reason) }, "pool tick failed");
      });

      // (6) advance the CommonPool funding queue (Vault Ledger section 2). Permissionless
      // and strictly FIFO; a clean InsufficientIdleReserve just means "retry once
      // capital frees up", so it logs at info, not error.
      try {
        const cp = await (client.program.account as any).commonPool.fetchNullable(client.pda.commonPool());
        if (cp && new BN(cp.nextToFund).lt(new BN(cp.nextTicket))) {
          const tickets = await (client.program.account as any).fundingTicket.all();
          const head = (tickets as any[]).find((t) => new BN(t.account.ticket).eq(new BN(cp.nextToFund)));
          if (head) {
            const trader = head.account.trader;
            const prof = await (client.program.account as any).traderProfile.fetch(client.pda.trader(trader));
            const dead = !("eligible" in (prof.status ?? {})) || !new PublicKey(prof.activePool).equals(PublicKey.default);
            if (dead) {
              // The head trader can no longer be funded (self-created pool, lock,
              // re-application). Close the ticket so the queue keeps moving.
              const ix = await client.skipDeadTicket(keeper, trader, head.account.payer).instruction();
              const sig = await sendWithPriority(connection, env.keeper, [ix], { label: `skip dead ticket #${cp.nextToFund}` });
              log.warn({ trader: trader.toBase58(), ticket: Number(cp.nextToFund), sig }, "skipped dead head ticket");
            } else {
              const ix = await client
                .fundNextInQueue(keeper, keeperUsdc, trader, prof.poolsCreated, head.account.payer, usdcMint)
                .instruction();
              const sig = await sendWithPriority(connection, env.keeper, [ix], { label: `fund queue #${cp.nextToFund}` });
              log.warn({ trader: trader.toBase58(), ticket: Number(cp.nextToFund), sig }, "funded next in queue");
            }
          }
        }
      } catch (e) {
        const msg = String(e);
        if (msg.includes("InsufficientIdleReserve")) log.info("funding queue waiting for idle capital");
        else log.warn({ err: msg }, "funding-queue advance failed");
      }

      // (7) Phase B. Bring LOCKED pools' capital home. A locked pool is dead and
      // never trades again, so its stake returns to idle immediately, whether or
      // not anyone is redeeming; that refill is what serves the redemption queue.
      // A live pool is never pulled (the program refuses it) so a redemption
      // backlog no longer authorises touching a working trader's book.
      // Step (4) handles any unwinding in between, since a CP stake is a normal
      // pending InvestorPosition. Also sweeps platform fees ≥ $1.
      try {
        const cpAddr = client.pda.commonPool();
        const cp = await (client.program.account as any).commonPool.fetchNullable(cpAddr);
        if (cp && cp.activeStakes > 0) {
          const stakes = (await (client.program.account as any).investorPosition.all()).filter((s: any) =>
            s.account.investor.equals(cpAddr),
          );
          for (const s of stakes) {
            const poolPk = s.account.pool;
            const poolAcc = (pools as any[]).find((p: any) => p.publicKey.equals(poolPk))?.account;
            if (!poolAcc) continue;
            if (Object.keys(poolAcc.status)[0] !== "locked") continue;
            try {
              if (new BN(s.account.pendingShares).isZero() && !new BN(s.account.shares).isZero()) {
                const ix = await client.requestCommonPull(keeper, poolPk).instruction();
                const sig = await sendWithPriority(connection, env.keeper, [ix], { label: `common-pull request ${poolPk.toBase58()}` });
                log.info({ pool: poolPk.toBase58(), sig }, "requested common pull");
              } else if (!new BN(s.account.pendingShares).isZero()) {
                const oracles = client.oracleMetas(markets as MarketLike[], poolAcc);
                const ix = await client.settleCommonPull(keeper, poolPk, oracles).instruction();
                const sig = await sendWithPriority(connection, env.keeper, [ix], { label: `common-pull settle ${poolPk.toBase58()}` });
                log.info({ pool: poolPk.toBase58(), sig }, "settled common pull into idle");
              }
            } catch (e) {
              const msg = String(e);
              if (msg.includes("UnwindRequired")) log.info({ pool: poolPk.toBase58() }, "common pull waiting for unwind");
              else if (!msg.includes("NoPullNeeded") && !msg.includes("PoolNotLocked")) log.warn({ pool: poolPk.toBase58(), err: msg }, "common pull failed");
            }
          }
        }
        for (const { publicKey, account: p } of pools as any[]) {
          if (new BN(p.platformFeeOwed ?? 0).gte(new BN(1_000_000))) {
            try {
              const ix = await client.collectPlatformFee(keeper, publicKey).instruction();
              const sig = await sendWithPriority(connection, env.keeper, [ix], { label: `collect platform fee ${publicKey.toBase58()}` });
              log.info({ pool: publicKey.toBase58(), sig }, "platform fee collected");
            } catch (e) {
              log.warn({ pool: publicKey.toBase58(), err: String(e) }, "platform fee collection failed");
            }
          }
        }
      } catch (e) {
        log.warn({ err: String(e) }, "common redemption tick failed");
      }

      // (8) reap dead pools. Once (7) has pulled the CommonPool's stake home the
      // pool is Locked, flat, shareless and empty of escrow, but it still holds
      // the unspent part of the trader's first-loss seed, and `reap_pool` is the
      // only instruction that can move it. Nothing called it, so that capital
      // sat stranded indefinitely: it is returned to investors as NAV/share and
      // to the platform as revenue only when someone reaps.
      //
      // Permissionless like every other step here. The gates mirror the
      // program's exactly, so a pool that still owes anyone anything is skipped
      // rather than attempted.
      for (const { publicKey, account: p } of pools as any[]) {
        if (Object.keys(p.status)[0] !== "locked") continue;
        if (p.openPositions > 0) continue;
        if (new BN(p.totalShares).gt(DEAD_SHARES)) continue;
        if (!new BN(p.pendingRedemptionShares).isZero()) continue;
        if (!new BN(p.escrowTotal).isZero() || !new BN(p.vestedClaimable).isZero()) continue;
        try {
          const ix = await client.reapPool(keeper, publicKey).instruction();
          const sig = await sendWithPriority(connection, env.keeper, [ix], { label: `reap ${publicKey.toBase58()}` });
          log.warn({ pool: publicKey.toBase58(), sig }, "reaped dead pool. Remainder split to CommonPool and treasury");
        } catch (e) {
          log.warn({ pool: publicKey.toBase58(), err: String(e) }, "reap failed");
        }
      }
    } catch (e) {
      log.error({ err: String(e) }, "tick failed");
    } finally {
      busy = false;
    }
  };

  // refresh the registry every minute (markets can be added/disabled)
  const warnedNotPushed = new Set<number>();
  setInterval(async () => {
    try {
      markets = (await client.registry()).markets;
      // The Pyth pusher's feed set is fixed at startup; flag markets that appeared since.
      if (pyth) {
        for (const m of markets) {
          if (mockOracleIds.has(m.marketId) || warnedNotPushed.has(m.marketId) || pyth.address(feedHex(m.feedId))?.equals(m.oracle)) continue;
          warnedNotPushed.add(m.marketId);
          log.warn({ market: m.symbol, oracle: m.oracle.toBase58() }, "market not covered by the Pyth pusher; restart the keeper (after `bootstrap --pyth` if needed)");
        }
      }
    } catch (e) {
      log.warn({ err: String(e) }, "registry refresh failed");
    }
  }, 60_000);

  await tick();
  setInterval(tick, env.intervalMs);
}

// A stray rejected promise (RPC 429, dropped websocket) must never take the keeper down:
// a dead keeper means stale oracles and no risk marks for every live pool.
process.on("unhandledRejection", (e) => log.error({ err: String(e) }, "unhandled rejection (keeper keeps running)"));
process.on("uncaughtException", (e) => log.error({ err: String(e), stack: e.stack }, "uncaught exception (keeper keeps running)"));

main().catch((e) => {
  log.fatal({ err: String(e) }, "keeper crashed");
  process.exit(1);
});
