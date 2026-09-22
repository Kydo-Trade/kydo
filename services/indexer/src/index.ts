/**
 * Indexer + API (C5): program events → store → REST/WS. Reads only; never a
 * source of truth (section 3.4).
 */
import { PublicKey } from "@solana/web3.js";
import pino from "pino";
import { buildApi } from "./api";
import { keeperLowSolNotification } from "./notify";
import { Keypair } from "@solana/web3.js";
import { readFileSync } from "fs";
import { homedir } from "os";
import { makeClient } from "./chain";
import { env } from "./config";
import { clusterName, Faucet } from "./faucet";
import { Ingestor } from "./ingest";
import { Snapshotter } from "./snapshot";
import { createStore } from "./store";
import { Hub } from "./ws";

const log = pino({ level: env.logLevel, name: "indexer" });

async function main() {
  const store = createStore(env.store, env.databaseUrl);
  await store.init();
  const { connection, client } = makeClient();
  const hub = new Hub();
  const snap = new Snapshotter(connection, client, store, hub);
  await snap.refreshStatic();
  await snap.run();
  snap.start();
  const traderWallets = async () => {
    const rows = (await (client.program.account as any).traderProfile.all()) as { account: { wallet: PublicKey } }[];
    return rows.map((r) => r.account.wallet);
  };
  const ingest = new Ingestor(connection, store, hub, () => snap.markets, undefined, traderWallets);
  ingest.start().catch((e) => log.error({ err: String(e) }, "ingest failed"));

  let faucet: Faucet | null = null;
  if (env.faucetEnabled) {
    const cluster = clusterName(env.rpcUrl);
    if (cluster === "mainnet") {
      log.error("FAUCET_ENABLED ignored: refusing to run a faucet against mainnet");
    } else {
      const mint = env.usdcMint ? new PublicKey(env.usdcMint) : (snap.config.usdcMint as PublicKey);
      faucet = new Faucet(connection, mint);
      log.warn({ cluster, mint: mint.toBase58(), authority: faucet.authority.publicKey.toBase58() }, "test-USDC faucet ENABLED");
    }
  }

  // ---- keeper-balance watchdog: the key that pays for everything must never run dry silently ----
  {
    const thresholdSol = Number(process.env.KEEPER_LOW_SOL_ALERT ?? 1);
    let keeperPk: PublicKey | null = null;
    try {
      const path = (env.faucetKeypair ?? "~/.config/solana/id.json").replace(/^~\//, homedir() + "/");
      keeperPk = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")))).publicKey;
    } catch {
      log.warn("keeper watchdog disabled: cannot read FAUCET_KEYPAIR for the keeper pubkey");
    }
    if (keeperPk && thresholdSol > 0) {
      const pk = keeperPk;
      let low = false; // alert on the healthy->low crossing, re-arm on recovery
      const check = async () => {
        try {
          const sol = (await connection.getBalance(pk)) / 1e9;
          if (sol < thresholdSol && !low) {
            low = true;
            await ingest.raiseOpsAlert("keeper_low_sol", { keeper: pk.toBase58(), sol, thresholdSol }, (id) =>
              keeperLowSolNotification({ keeper: pk.toBase58(), sol, thresholdSol, ts: Math.floor(Date.now() / 1000) }),
            );
            log.warn({ sol, thresholdSol }, "keeper key LOW on SOL. Alert raised");
          } else if (sol >= thresholdSol * 1.2 && low) {
            low = false;
            log.info({ sol }, "keeper key balance recovered");
          }
        } catch {
          /* transient RPC failure. Next tick */
        }
      };
      void check();
      setInterval(check, 120_000);
      log.info({ keeper: pk.toBase58(), thresholdSol }, "keeper-balance watchdog on (KEEPER_LOW_SOL_ALERT to tune)");
    }
  }

  const app = buildApi(store, snap, hub, ingest, faucet);
  await app.listen({ port: env.port, host: "0.0.0.0" });
  log.info({ port: env.port, store: env.store, program: env.programId.toBase58(), markets: snap.markets.map((m) => m.symbol), faucet: !!faucet }, "indexer up");
}

main().catch((e) => {
  log.fatal({ err: String(e) }, "indexer crashed");
  process.exit(1);
});
