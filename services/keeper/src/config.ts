import "dotenv/config";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { VAULT_PROGRAM_ID } from "@kydo/sdk";

/**
 * Load a keypair from either a file path (`~` expands to $HOME) or the JSON secret-key array
 * itself (`KEEPER_KEYPAIR='[12,34,…]'`. Handy in containers where mounting a file is awkward).
 * Errors name the path so a bad bind mount (Docker turning a missing file into a directory) is obvious.
 */
export function loadKeypair(pathOrJson: string, label = "keypair"): Keypair {
  const v = pathOrJson.trim();
  if (v.startsWith("[")) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(v)));
    } catch (e) {
      throw new Error(`${label}: inline JSON secret key is invalid (${(e as Error).message})`);
    }
  }
  const p = v.startsWith("~") ? resolve(homedir(), v.slice(2)) : resolve(v);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(p);
  } catch {
    throw new Error(`${label}: no file at ${p}. Set the env var to a keypair file (solana-keygen new -o <file>) or to the JSON secret-key array`);
  }
  if (st.isDirectory()) throw new Error(`${label}: ${p} is a directory, not a keypair file (a Docker bind mount of a missing file creates an empty directory. Check the host path)`);
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
  } catch (e) {
    throw new Error(`${label}: ${p} is not a valid Solana keypair JSON file (${(e as Error).message})`);
  }
}

export const env = {
  rpcUrl: process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899",
  wsUrl: process.env.SOLANA_WS_URL,
  programId: new PublicKey(process.env.VAULT_PROGRAM_ID ?? VAULT_PROGRAM_ID),
  keeper: loadKeypair(process.env.KEEPER_KEYPAIR ?? "~/.config/solana/id.json", "KEEPER_KEYPAIR"),
  intervalMs: Number(process.env.KEEPER_INTERVAL_MS ?? 3000),
  priorityFee: Number(process.env.PRIORITY_FEE_MICROLAMPORTS ?? 50_000),
  jitoUrl: process.env.JITO_BLOCK_ENGINE_URL || undefined,
  jitoTipLamports: Number(process.env.JITO_TIP_LAMPORTS ?? 10_000),
  hermesUrl: process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network",
  /**
   * Bearer token for Hermes. The public endpoint now answers 401 to every
   * request without one, so this is required for `PRICE_SOURCE=hermes`.
   * It is sent as `Authorization: Bearer …`, which is the only auth form
   * hermes.pyth.network accepts (query params and X-API-Key are rejected).
   */
  hermesAuth: process.env.PYTH_API_KEY ?? process.env.PYTH_HERMES_AUTH ?? "",
  /**
   * hermes (default) | exchange (Binance/Coinbase spot) | random-walk (offline dev).
   * `hermes` degrades to `exchange` only when `allowExchangeFallback` is set.
   */
  priceSource: parsePriceSource(process.env.PRICE_SOURCE),
  /**
   * Let `PRICE_SOURCE=hermes` silently degrade to Binance/Coinbase spot when
   * Hermes rejects us. Off by default, and the default matters: whatever this
   * gateway resolves is *written on-chain* and becomes the price the pool marks
   * against, so a fallback does not just change a chart. It decides who gets
   * liquidated, at a price from a venue the platform never agreed to use.
   * Failing loudly stops the keeper pushing, marks go stale, and trading halts
   * on OracleStale, which is the correct outcome for a missing oracle.
   */
  allowExchangeFallback: /^(1|true|yes)$/i.test(process.env.PRICE_ALLOW_EXCHANGE_FALLBACK ?? ""),
  /** exchange source: poll interval. Binance allows ~1200 req/min; 2 s is far below that. */
  exchangePollMs: Number(process.env.EXCHANGE_POLL_MS ?? 2000),
  /** Push prices on-chain at least this often (mock: set_mock_price; pull: Pyth post_update). Must be < oracle_max_age_slots × 0.4s. */
  pricePushMs: Number(process.env.PRICE_PUSH_MS ?? 3000),
  /**
   * mock (default) = feed program-owned mock oracles from Hermes (localnet / tests / plain devnet);
   * pull = post real Pyth `PriceUpdateV2` accounts through the Pyth receiver (devnet with `bootstrap --pyth`).
   * Mock-oracle markets keep being fed in either mode; `pull` only adds the Pyth pusher.
   */
  pythMode: parsePythMode(process.env.PYTH_MODE),
  /** pull mode only: build one round of Pyth post transactions, log their sizes, and exit without sending. */
  pythDryRun: /^(1|true|yes)$/i.test(process.env.PYTH_DRY_RUN ?? ""),
  logLevel: process.env.LOG_LEVEL ?? "info",
};

function parsePriceSource(v: string | undefined): "hermes" | "exchange" | "random-walk" {
  const s = (v ?? "hermes").toLowerCase();
  if (s !== "hermes" && s !== "exchange" && s !== "random-walk") throw new Error(`PRICE_SOURCE must be "hermes", "exchange" or "random-walk", got "${v}"`);
  return s;
}

function parsePythMode(v: string | undefined): "mock" | "pull" {
  const mode = (v ?? "mock").toLowerCase();
  if (mode !== "mock" && mode !== "pull") throw new Error(`PYTH_MODE must be "mock" or "pull", got "${v}"`);
  return mode;
}
