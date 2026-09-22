import "dotenv/config";
import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { VAULT_PROGRAM_ID } from "@kydo/sdk";

/** File path (`~` = $HOME) or the inline JSON secret-key array; errors name the path (see keeper/config.ts). */
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
  programId: new PublicKey(process.env.VAULT_PROGRAM_ID ?? VAULT_PROGRAM_ID),
  attestor: loadKeypair(process.env.TRIAL_ATTESTOR_KEYPAIR ?? "~/.config/solana/id.json", "TRIAL_ATTESTOR_KEYPAIR"),
  port: Number(process.env.TRIAL_PORT ?? 4100),
  databaseUrl: process.env.DATABASE_URL,
  store: (process.env.STORE ?? (process.env.DATABASE_URL ? "pg" : "memory")) as "pg" | "memory",
  /** Where prices come from: the indexer (same feed the keeper pushes on-chain) or Hermes directly. */
  // 127.0.0.1, not localhost: Node 18's fetch resolves localhost to ::1 while the indexer binds IPv4.
  indexerUrl: process.env.INDEXER_URL ?? "http://127.0.0.1:4000",
  hermesUrl: process.env.PYTH_HERMES_URL ?? "https://hermes.pyth.network",
  priceSource: (process.env.TRIAL_PRICE_SOURCE ?? "indexer") as "indexer" | "hermes" | "random-walk",
  pricePollMs: Number(process.env.TRIAL_PRICE_POLL_MS ?? 1000),
  /** Synthetic top-of-book depth per side, USD (section 4.2: no order > 10% of visible depth). */
  depthMajors: Number(process.env.TRIAL_DEPTH_MAJORS ?? 250_000),
  depthOther: Number(process.env.TRIAL_DEPTH_OTHER ?? 100_000),
  /** DEV ONLY: allow `POST /trial/:wallet/finalize {force:true}` to attest passing metrics regardless of the sandbox result. */
  devForcePass: process.env.TRIAL_DEV_FORCE_PASS === "true",
  logLevel: process.env.LOG_LEVEL ?? "info",
};
