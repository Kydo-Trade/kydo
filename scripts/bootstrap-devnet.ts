/**
 * One-shot devnet bootstrap:
 *   1. create a test USDC mint (6 dp). Devnet has no canonical USDC faucet
 *   2. init_platform with the MVP parameters (section 4, section 5)
 *   3. register the launch markets (section 4.9) against either
 *        - program-owned mock oracles (default; the keeper feeds them from Hermes), or
 *        - the keeper's stable Pyth `PriceUpdateV2` accounts (`--pyth` / PYTH_MODE=pull;
 *          the keeper posts them with the Pyth receiver. See packages/sdk/src/pyth.ts)
 *      A market that already exists but points at a different oracle is re-registered
 *      (register_market replaces by market_id and keeps `enabled`), so switching between
 *      the two modes is just re-running this script.
 *   4. print the env values every service needs
 *
 * Usage:  SOLANA_RPC_URL=<keyed devnet rpc> pnpm devnet:bootstrap   (set it in .env)
 *         PLATFORM_CONFIG=config/platform.demo.jsonc pnpm devnet:bootstrap    (init from a config file)
 *         pnpm devnet:bootstrap --pyth                                         (markets → Pyth accounts of KEEPER_KEYPAIR, default = admin key)
 *         pnpm devnet:bootstrap --mock                                         (markets → mock oracles again)
 * Params: pnpm devnet:bootstrap apply-params config/platform.demo.jsonc       (update a live platform)
 * Faucet: pnpm devnet:bootstrap faucet <wallet> <amountUsd>
 *
 * The admin is the local keypair (~/.config/solana/id.json); on a real deployment
 * `init_platform.admin` must be the Squads multisig (section 3.1).
 */
import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { createAssociatedTokenAccountIdempotent, createMint, mintTo } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { DEFAULT_MARKETS, VaultClient, VAULT_PROGRAM_ID, pythPriceUpdateAddress } from "../packages/sdk/src";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const ARGS = process.argv.slice(2);
const FLAGS = new Set(ARGS.filter((a) => a.startsWith("--")));
/** mock (default) | pull. `--pyth` / `--mock` override PYTH_MODE. */
const PYTH_MODE: "mock" | "pull" = FLAGS.has("--pyth") ? "pull" : FLAGS.has("--mock") ? "mock" : process.env.PYTH_MODE === "pull" ? "pull" : "mock";
/** Platform parameters come from a JSON file (config/platform.json = spec, config/platform.demo.json = accelerated). */
const CONFIG_FILE = process.env.PLATFORM_CONFIG ?? resolve(__dirname, "..", "config", "platform.jsonc");
const STATE_FILE = process.env.STATE_FILE ?? resolve(__dirname, "..", ".devnet.json");
const USD = 1_000_000;
const usd = (x: number) => new BN(Math.round(x * USD));

interface PlatformFile {
  entryFeeUsd: number;
  /** Trader first-loss required to fund a pool, bps of the tier cap. */
  allowMockOracle: boolean;
  minFirstLossBps: number;
  bountyPerPoolUsd: number;
  keeperBountyUsd: number;
  activationFloorUsd: number;
  minDepositUsd: number;
  tiers: { capsUsd: [number, number, number]; vestDays: [number, number, number]; promotionDays: number };
  daySecs: number;
  risk: Record<string, number>;
  trial: Record<string, number>;
  /** CommonPool crowdsourced funding layer (Vault Ledger section 1); optional, defaults below. */
  commonPool?: { reserveBps: number; depositEnabled: boolean };
}

/** JSONC → JSON: strip line comments and block comments (outside strings), then trailing commas. */
function stripJsonc(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") { out += n; i++; } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function loadPlatformFile(path: string): PlatformFile {
  const cfg = JSON.parse(stripJsonc(readFileSync(path, "utf8"))) as PlatformFile;
  const fee = cfg.entryFeeUsd;
  const floor = cfg.tiers.capsUsd[0] * 0.8 * (cfg.risk.maxDrawdownBps / 10_000);
  if (fee < floor) throw new Error(`entryFeeUsd ${fee} < 80% × maxDrawdown × Tier-1 cap = ${floor} (section 5.2 invariant)`);
  // The cushion invariant: the trader's fee must cover the drawdown trigger AND
  // the liquidation buffer on the Tier-1 cap, or investors are exposed by the gap.
  const cushion = (cfg.tiers.capsUsd[0] * cfg.minFirstLossBps) / 10_000;
  // A mock oracle on a real deployment hands the price authority the power to
  // mint NAV or force liquidations. It is init-time and permanent, so refuse
  // rather than rely on whoever runs this having read the config.
  if (cfg.allowMockOracle && /mainnet/i.test(RPC))
    throw new Error("allowMockOracle=true against a mainnet RPC. Refusing: the price authority could write any price, and the flag cannot be turned off after init_platform");
  if (fee < cushion)
    throw new Error(
      `entryFeeUsd ${fee} < minFirstLossBps ${cfg.minFirstLossBps} × Tier-1 cap = ${cushion}: ` +
        `the fee cannot fund the first-loss cushion, so investors would absorb the difference`,
    );
  // The escrow is a 30-slot ring indexed by `day % 30`. A longer vesting period
  // means the slot is still unvested when it comes round, and the new accrual is
  // merged into the old bucket and vests on the OLD day. The program rejects
  // this too. Fail here, where the file that caused it is in front of you.
  const ESCROW_SLOTS = 30;
  const badVest = cfg.tiers.vestDays.findIndex((d) => d > ESCROW_SLOTS);
  if (badVest >= 0)
    throw new Error(
      `tiers.vestDays[${badVest}] = ${cfg.tiers.vestDays[badVest]} > ${ESCROW_SLOTS}: ` +
        `the escrow ring has only ${ESCROW_SLOTS} daily slots, so a longer period vests early`,
    );
  if (cfg.risk.dailyLossBps > 10_000 || cfg.risk.maxDrawdownBps > 10_000)
    throw new Error("risk.dailyLossBps / risk.maxDrawdownBps must be ≤ 10000 bps (the program computes 10000 − bps)");
  return cfg;
}

/** JSON file → on-chain argument shapes (BN for u64, numbers otherwise). */
function toChainParams(c: PlatformFile) {
  const risk = {
    maxLeverageBps: c.risk.maxLeverageBps,
    maxPositions: c.risk.maxPositions,
    maxSingleBps: c.risk.maxSingleBps,
    maxClusterBps: c.risk.maxClusterBps,
    dailyLossBps: c.risk.dailyLossBps,
    maxDrawdownBps: c.risk.maxDrawdownBps,
    minHoldSecs: c.risk.minHoldSecs,
    maxTradesPerDay: c.risk.maxTradesPerDay,
    oracleMaxAgeSlots: new BN(c.risk.oracleMaxAgeSlots),
    oracleMaxConfBps: c.risk.oracleMaxConfBps,
    limitBandBps: c.risk.limitBandBps,
    redemptionLockupSecs: c.risk.redemptionLockupSecs,
    cooldownSecs: c.risk.cooldownSecs,
    promotionDays: c.tiers.promotionDays,
  };
  const trial = {
    startingBalance: usd(c.trial.startingBalanceUsd),
    profitTargetBps: c.trial.profitTargetBps,
    maxDrawdownBps: c.trial.maxDrawdownBps,
    dailyLossBps: c.trial.dailyLossBps,
    minActiveDays: c.trial.minActiveDays,
    minTrades: c.trial.minTrades,
    maxDayProfitShareBps: c.trial.maxDayProfitShareBps,
    daySecs: c.daySecs,
    commitGraceDays: c.trial.commitGraceDays,
  };
  return {
    risk,
    trial,
    entryFee: usd(c.entryFeeUsd),
    bountyPerPool: usd(c.bountyPerPoolUsd),
    keeperBounty: usd(c.keeperBountyUsd),
    activationFloor: usd(c.activationFloorUsd),
    minDeposit: usd(c.minDepositUsd),
    tierCaps: c.tiers.capsUsd.map(usd) as [BN, BN, BN],
    vestDays: c.tiers.vestDays,
    minFirstLossBps: c.minFirstLossBps,
    allowMockOracle: c.allowMockOracle,
  };
}

function loadKeypair(p = process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json") {
  const path = p.startsWith("~") ? resolve(homedir(), p.slice(2)) : p;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

async function main() {
  const admin = loadKeypair();
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
  const programId = new PublicKey(process.env.VAULT_PROGRAM_ID ?? VAULT_PROGRAM_ID);
  const client = new VaultClient(provider, programId);
  const state: Record<string, string> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};

  const [cmd, ...rest] = ARGS.filter((a) => !a.startsWith("--"));
  if (cmd === "apply-params") {
    // Push every tunable from a config file to the live platform (admin only). Idempotent.
    const file = rest[0] ? resolve(process.cwd(), rest[0]) : CONFIG_FILE;
    const c = toChainParams(loadPlatformFile(file));
    await client
      .updateRiskParams(admin.publicKey, {
        risk: c.risk,
        trial: c.trial,
        tierCaps: c.tierCaps,
        vestDays: c.vestDays,
        entryFee: c.entryFee,
        activationFloor: c.activationFloor,
        minDeposit: c.minDeposit,
        keeperBounty: c.keeperBounty,
        bountyPerPool: c.bountyPerPool,
        trialAttestor: null,
        priceAuthority: null,
        minFirstLossBps: c.minFirstLossBps,
      })
      .rpc();
    const d = c.trial.daySecs;
    const fmt = (days: number) => (days * d >= 3600 ? `${((days * d) / 3600).toFixed(1)} h` : `${((days * d) / 60).toFixed(1)} min`);
    console.log(`applied ${file}`);
    console.log(`  day = ${d}s · trial 30 days = ${fmt(30)} · promotion ${c.risk.promotionDays} days = ${fmt(c.risk.promotionDays)} · vesting ${c.vestDays.map(fmt).join(" / ")}`);
    return;
  }
  if (cmd === "faucet") {
    const [wallet, amount] = rest;
    const mint = new PublicKey(state.usdcMint ?? process.env.USDC_MINT!);
    const ata = await createAssociatedTokenAccountIdempotent(connection, admin, mint, new PublicKey(wallet));
    await mintTo(connection, admin, mint, ata, admin, BigInt(Math.round(Number(amount) * USD)));
    console.log(`minted ${amount} test-USDC to ${wallet} (${ata.toBase58()})`);
    return;
  }

  console.log("admin:", admin.publicKey.toBase58(), "program:", programId.toBase58(), "rpc:", RPC);
  const bal = await connection.getBalance(admin.publicKey);
  if (bal < 1e9) console.warn(`admin has ${bal / 1e9} SOL. Run: solana airdrop 2`);

  // 1. USDC mint
  let usdcMint: PublicKey;
  if (state.usdcMint) {
    usdcMint = new PublicKey(state.usdcMint);
    console.log("reusing USDC mint", usdcMint.toBase58());
  } else {
    usdcMint = await createMint(connection, admin, admin.publicKey, null, 6);
    state.usdcMint = usdcMint.toBase58();
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log("created test USDC mint", usdcMint.toBase58());
  }
  const adminAta = await createAssociatedTokenAccountIdempotent(connection, admin, usdcMint, admin.publicKey);
  await mintTo(connection, admin, usdcMint, adminAta, admin, BigInt(100_000 * USD));

  // 2. platform
  const existing = await connection.getAccountInfo(client.pda.platform());
  if (existing) {
    console.log("platform already initialized");
  } else {
    const c = toChainParams(loadPlatformFile(CONFIG_FILE));
    const sig = await client
      .initPlatform(admin.publicKey, usdcMint, {
        trialAttestor: admin.publicKey,
        priceAuthority: admin.publicKey,
        entryFee: c.entryFee,
        bountyPerPool: c.bountyPerPool,
        keeperBounty: c.keeperBounty,
        activationFloor: c.activationFloor,
        minDeposit: c.minDeposit,
        tierCaps: c.tierCaps,
        vestDays: c.vestDays,
        allowMockOracle: c.allowMockOracle,
        minFirstLossBps: c.minFirstLossBps,
        risk: c.risk,
        trial: c.trial,
      })
      .rpc();
    console.log("init_platform", sig, "from", CONFIG_FILE);
  }

  // 2b. CommonPool. The crowdsourced funding layer (Vault Ledger section 1).
  if (await connection.getAccountInfo(client.pda.commonPool())) {
    console.log("common pool already initialized");
  } else {
    const cpc = loadPlatformFile(CONFIG_FILE).commonPool ?? { reserveBps: 1000, depositEnabled: true };
    const sig = await client.initCommonPool(admin.publicKey, usdcMint, cpc).rpc();
    console.log("init_common_pool", sig, `reserve ${cpc.reserveBps} bps, deposits ${cpc.depositEnabled ? "enabled" : "disabled"}`);
  }

  // 3. markets. Same Pyth feed ids either way; the oracle account depends on PYTH_MODE:
  //    mock: program-owned MockOracle PDA fed by the keeper's Hermes gateway
  //    pull: the keeper's stable Pyth PriceUpdateV2 account (derived from the keeper key + feed id)
  const keeperKp = PYTH_MODE === "pull" ? (process.env.KEEPER_KEYPAIR ? loadKeypair(process.env.KEEPER_KEYPAIR) : admin) : null;
  if (keeperKp) {
    console.log(`PYTH_MODE=pull: registering markets against the Pyth price-update accounts of keeper ${keeperKp.publicKey.toBase58()}`);
    console.log("  (the accounts are created by the keeper's first push. Start it with PYTH_MODE=pull and the same KEEPER_KEYPAIR)");
  }
  const reg = await client.registry();
  for (const m of DEFAULT_MARKETS) {
    let oracle: PublicKey;
    if (keeperKp) {
      oracle = pythPriceUpdateAddress(keeperKp, m.feedId);
    } else {
      oracle = client.pda.mockOracle(m.marketId);
      if (!(await connection.getAccountInfo(oracle))) {
        await client.initMockOracle(admin.publicKey, m.marketId).rpc();
      }
    }
    const existing = reg.markets.find((x) => x.marketId === m.marketId);
    if (existing?.oracle.equals(oracle) && existing.maxLeverageBps === m.maxLeverageBps) {
      console.log("market exists", m.symbol, "oracle", oracle.toBase58());
      continue;
    }
    const symbol = Buffer.alloc(8);
    symbol.write(m.symbol);
    await client
      .registerMarket(admin.publicKey, {
        marketId: m.marketId,
        symbol: [...symbol],
        oracle,
        feedId: [...Buffer.from(m.feedId, "hex")],
        maxLeverageBps: m.maxLeverageBps,
        cluster: m.cluster,
        venueMarketIndex: m.driftIndex,
      })
      .rpc();
    console.log(
      existing ? `re-registered ${m.symbol} (oracle ${existing.oracle.toBase58()} →)` : `registered ${m.symbol}`,
      "oracle",
      oracle.toBase58(),
      keeperKp ? "(Pyth PriceUpdateV2)" : "(mock)",
    );
  }

  console.log("\n# ---- paste into .env ----");
  console.log(`SOLANA_RPC_URL=${RPC}`);
  console.log(`VAULT_PROGRAM_ID=${programId.toBase58()}`);
  console.log(`USDC_MINT=${usdcMint.toBase58()}`);
  console.log(`NEXT_PUBLIC_VAULT_PROGRAM_ID=${programId.toBase58()}`);
  console.log(`NEXT_PUBLIC_USDC_MINT=${usdcMint.toBase58()}`);
  console.log(`PYTH_MODE=${PYTH_MODE}`);
  if (keeperKp && process.env.KEEPER_KEYPAIR) console.log(`KEEPER_KEYPAIR=${process.env.KEEPER_KEYPAIR}`);
  console.log(
    keeperKp
      ? "\nNext: start the keeper with PYTH_MODE=pull (posts Pyth PriceUpdateV2 accounts every PRICE_PUSH_MS; try PYTH_DRY_RUN=true first), the indexer, the trial engine, then the apps."
      : "\nNext: start the keeper (pushes live Pyth prices into the mock oracles), the indexer, the trial engine, then the apps.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
