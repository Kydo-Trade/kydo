/**
 * Stand up a LIVE demo pool with script-owned keypairs so the investor app,
 * keeper and pool pages have something real to show. On localnet or devnet.
 *
 *   pnpm demo:pool                # trader applies → 30 roots → finalize → pool → trader seeds $1,500 → activate
 *   pnpm demo:pool --bot          # …and then keep trading it (random small trades) until Ctrl-C
 *   pnpm demo:pool --bot-only     # only run the bot against the pool from a previous run
 *
 * Admin-only shortcut inside: the on-chain trial needs 30 elapsed "days", so the script
 * temporarily sets daySecs=1, waits 31 s, commits the roots, and restores the config file
 * given by PLATFORM_CONFIG (default config/platform.demo.jsonc).
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { createAssociatedTokenAccountIdempotent, mintTo } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { VaultClient, VAULT_PROGRAM_ID, encodeName } from "../packages/sdk/src";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const ROOT = resolve(__dirname, "..");
const KEYS_FILE = resolve(ROOT, ".devstack", "demo-keys.json");
const CONFIG = process.env.PLATFORM_CONFIG ?? "config/platform.demo.jsonc";
const USD = 1_000_000;
const usd = (x: number) => new BN(Math.round(x * USD));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

function loadKeypair(p = process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json") {
  const path = p.startsWith("~") ? resolve(homedir(), p.slice(2)) : p;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

function loadOrCreateKeys(): { trader: Keypair; investor: Keypair } {
  if (existsSync(KEYS_FILE)) {
    const j = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
    return { trader: Keypair.fromSecretKey(Uint8Array.from(j.trader)), investor: Keypair.fromSecretKey(Uint8Array.from(j.investor)) };
  }
  const k = { trader: Keypair.generate(), investor: Keypair.generate() };
  writeFileSync(KEYS_FILE, JSON.stringify({ trader: [...k.trader.secretKey], investor: [...k.investor.secretKey] }));
  return k;
}

async function main() {
  const args = process.argv.slice(2);
  const bot = args.includes("--bot") || args.includes("--bot-only");
  const setupNeeded = !args.includes("--bot-only");

  const admin = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const programId = new PublicKey(process.env.VAULT_PROGRAM_ID ?? VAULT_PROGRAM_ID);
  const adminClient = new VaultClient(new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" }), programId);
  const cfg = await adminClient.config();
  const usdcMint: PublicKey = cfg.usdcMint;
  const { markets } = await adminClient.registry();
  const { trader, investor } = loadOrCreateKeys();
  const traderClient = new VaultClient(new anchor.AnchorProvider(connection, new anchor.Wallet(trader), { commitment: "confirmed" }), programId);
  const investorClient = new VaultClient(new anchor.AnchorProvider(connection, new anchor.Wallet(investor), { commitment: "confirmed" }), programId);
  log("rpc", RPC, "program", programId.toBase58());
  log("demo trader", trader.publicKey.toBase58(), "· demo investor", investor.publicKey.toBase58());

  const fund = async (who: Keypair, sol: number, usdAmt: number) => {
    const bal = await connection.getBalance(who.publicKey);
    if (bal < sol * LAMPORTS_PER_SOL) {
      await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: who.publicKey, lamports: sol * LAMPORTS_PER_SOL - bal })), [admin]);
    }
    const ata = await createAssociatedTokenAccountIdempotent(connection, admin, usdcMint, who.publicKey);
    if (usdAmt > 0) await mintTo(connection, admin, usdcMint, ata, admin, BigInt(usdAmt * USD));
  };

  let pool: PublicKey;
  if (setupNeeded) {
    // The trader carries the seed capital now: `deposit` is gated to the pool's
    // own trader, so the demo investor cannot put the pool over its activation
    // floor. They keep a balance for the CommonPool instead.
    await fund(trader, 0.3, 4_000);
    await fund(investor, 0.15, 5_000);
    log("funded demo wallets (0.3 / 0.15 SOL, 4,000 / 5,000 test USDC)");

    let prof = await traderClient.trader(trader.publicKey);
    const status = prof ? Object.keys(prof.status)[0] : "none";
    if (prof && prof.activePool && !prof.activePool.equals(PublicKey.default)) {
      pool = prof.activePool;
      log("trader already has a pool:", pool.toBase58());
    } else {
      if (status === "none" || status === "failed" || status === "frozen") {
        await traderClient.applyAsTrader(trader.publicKey, usdcMint).rpc();
        log("applied ($500 fee)");
        prof = await traderClient.trader(trader.publicKey);
      }
      if (Object.keys(prof.status)[0] === "trial") {
        // Fast-forward the on-chain trial clock: daySecs=1 → 30 days in 31 s.
        const cfgNow = await adminClient.config();
        await adminClient
          .updateRiskParams(admin.publicKey, {
            risk: null, trial: { ...cfgNow.trial, daySecs: 1, commitGraceDays: 100_000 }, tierCaps: null, vestDays: null,
            entryFee: null, activationFloor: null, minDeposit: null, keeperBounty: null, bountyPerPool: null, trialAttestor: null, priceAuthority: null,
          })
          .rpc();
        const elapsed = Math.floor(Date.now() / 1000) - Number(prof.trialStartTs);
        if (elapsed < 31) {
          log(`daySecs=1: waiting ${31 - elapsed}s for 30 trial days to elapse…`);
          await sleep((31 - elapsed) * 1000);
        }
        for (let day = prof.trialDaysCommitted; day < 30; day += 8) {
          const tx = new Transaction();
          for (let d = day; d < Math.min(30, day + 8); d++) {
            const root = createHash("sha256").update(`demo-day-${d}`).digest();
            tx.add(await traderClient.commitTrialRoot(trader.publicKey, d, root).instruction());
          }
          await traderClient.provider.sendAndConfirm(tx);
        }
        log("30 daily roots committed");
        await adminClient
          .finalizeTrial(admin.publicKey, trader.publicKey, { finalEquity: usd(55_000), maxDrawdownBps: 300, maxDailyLossBps: 150, activeDays: 20, trades: 40, maxDayProfitShareBps: 2_000 })
          .rpc();
        execSync(`pnpm exec ts-node --transpile-only scripts/bootstrap-devnet.ts apply-params ${CONFIG}`, { cwd: ROOT, stdio: "inherit", env: { ...process.env, SOLANA_RPC_URL: RPC } });
        prof = await traderClient.trader(trader.publicKey);
        log("finalized → status", Object.keys(prof.status)[0]);
      }
      const idx = prof.poolsCreated;
      await traderClient
        .createPool(trader.publicKey, usdcMint, idx, {
          name: encodeName("Demo Momentum"),
          mandate: { perps: {} },
          targetSize: usd(5_000),
          strategyHash: [...createHash("sha256").update("Demo pool: scripted momentum bot on SOL/BTC/ETH, small size, for testing the platform.").digest()],
          venue: { mockPerps: {} },
        })
        .rpc();
      pool = traderClient.pda.pool(trader.publicKey, idx);
      log("pool created:", pool.toBase58());
      try {
        await fetch("http://127.0.0.1:4000/pools/" + pool.toBase58() + "/strategy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Demo pool: scripted momentum bot on SOL/BTC/ETH, small size, for testing the platform." }) });
      } catch {}
    }

    const p = await adminClient.pool(pool);
    if (Object.keys(p.status)[0] === "funding") {
      const nav = Number(p.accountedUsdc) / USD;
      if (nav < 1_000) {
        // Seeded by the trader, not the investor: investors fund the CommonPool,
        // which funds traders in queue order, and nobody can deposit into one
        // trader's pool (`DirectDepositDisabled`).
        await traderClient.deposit(trader.publicKey, pool, usdcMint, usd(1_500), []).rpc();
        log("demo trader seeded $1,500 to the activation floor");
      }
      await adminClient.activatePool(pool, adminClient.pda.trader(trader.publicKey)).rpc();
      log("pool ACTIVATED → Live");
    } else {
      log("pool status:", Object.keys(p.status)[0]);
    }
    log("\n  investor app → http://localhost:3001/pool/" + pool.toBase58());
  } else {
    const prof = await traderClient.trader(trader.publicKey);
    pool = prof.activePool;
  }

  if (!bot) return;
  log("bot: trading", pool.toBase58(), "every ~30 s (Ctrl-C to stop)");
  const tradable = markets.filter((m) => m.enabled).slice(0, 3);
  for (;;) {
    try {
      const p = await traderClient.pool(pool);
      if (Object.keys(p.status)[0] !== "live") {
        log("pool is", Object.keys(p.status)[0], "- bot stopping");
        return;
      }
      const open = (p.positions as any[]).filter((x) => x.side !== 0 && Number(x.baseQty) > 0);
      const nav = Number(p.lastMarkNav || p.accountedUsdc) / USD;
      const oldest = open.find((x) => Date.now() / 1000 - Number(x.openedAt) > Number(cfg.risk.minHoldSecs) + 5);
      if (open.length >= 2 && oldest) {
        await traderClient.closeTrade(trader.publicKey, pool, { marketId: oldest.marketId, baseQty: new BN(0), limitPx: new BN(0) }, traderClient.oracleMetas(markets, p, oldest.marketId)).rpc();
        log("closed", markets.find((m) => m.marketId === oldest.marketId)?.symbol);
      } else {
        const m = tradable[Math.floor(Math.random() * tradable.length)];
        const existing = open.find((x) => x.marketId === m.marketId);
        const side = existing ? existing.side : Math.random() < 0.6 ? 1 : 2;
        const notional = Math.max(50, Math.floor(nav * 0.08));
        await traderClient.placeTrade(trader.publicKey, pool, { marketId: m.marketId, side, notional: usd(notional), limitPx: new BN(0), stopPx: new BN(0) }, traderClient.oracleMetas(markets, p, m.marketId)).rpc();
        log(side === 1 ? "long" : "short", m.symbol, `$${notional}`);
      }
    } catch (e: any) {
      log("bot:", e?.error?.errorCode?.code ?? String(e).slice(0, 120));
    }
    await sleep(30_000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
