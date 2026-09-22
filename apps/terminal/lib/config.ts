import { PublicKey } from "@solana/web3.js";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export const TRIAL_URL = process.env.NEXT_PUBLIC_TRIAL_URL ?? "http://localhost:4100";
/**
 * Build-time fallback only. `next build` inlines NEXT_PUBLIC_* into the client
 * bundle, so a keyed endpoint here would have to be committed and could only be
 * changed by a rebuild (see docker-compose.yml on the indexer service). The
 * endpoint actually used is read from `process.env.RPC_URL` at request time in
 * app/layout.tsx and passed down; prefer `useRpcUrl()` from lib/solana over
 * importing this. This is what dev and SSR fall back to.
 */
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
export const PROGRAM_ID = new PublicKey(
  process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID ?? "G4E1BiuovMpeUCgyh2222GqAQt4cW5dXSovZipFd89T1",
);
export const USDC_MINT_ENV = process.env.NEXT_PUBLIC_USDC_MINT || null;

/**
 * The indexer socket. NEXT_PUBLIC_API_URL is either absolute
 * (https://api.example.com) or a same-origin path (/api) when the indexer is
 * proxied under this app's own host; resolve both to an absolute ws(s) URL.
 * A function, not a module const: the relative case reads window.location and
 * this module is also loaded during SSR.
 */
export function wsUrl(): string {
  const base = API_URL.replace(/\/$/, "");
  if (/^https?:\/\//i.test(base)) return base.replace(/^http/, "ws") + "/ws";
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}${base}/ws`;
}

/**
 * Public record pages for a pool / a trader. The standalone investor app is
 * retired. /invest inside this app is the investor surface.
 *
 * These are *record* links, not funding links. Investors cannot deposit into a
 * single trader's pool: capital goes into the Common Pool and the program
 * deploys it in FIFO order (`fund_next_in_queue`). Sharing a pool link shows
 * someone the trader's on-chain record; it does not let them fund that trader.
 * Absolute so they work when pasted anywhere.
 */
const ORIGIN = () => (typeof window !== "undefined" ? window.location.origin : process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");
export const poolRecordUrl = (pool: string) => `${ORIGIN()}/invest/${pool}`;
export const traderRecordUrl = (wallet: string) => `${ORIGIN()}/invest?trader=${wallet}`;

export const NETWORK = process.env.NEXT_PUBLIC_NETWORK ?? "devnet";

/** Solana Explorer link for a tx signature on the configured network. */
export function explorerTxUrl(sig: string): string {
  const q =
    NETWORK === "localnet"
      ? `?cluster=custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`
      : NETWORK === "mainnet" || NETWORK === "mainnet-beta"
        ? ""
        : "?cluster=devnet";
  return `https://explorer.solana.com/tx/${sig}${q}`;
}

/** Poll intervals (ms). Public devnet/mainnet RPCs rate-limit per IP (shared with the keeper + indexer), so chain polls are slower off localnet. */
const PUBLIC_RPC = (process.env.NEXT_PUBLIC_NETWORK ?? "localnet") !== "localnet";
export const PRICE_POLL_MS = 3000;
export const CHAIN_POLL_MS = PUBLIC_RPC ? 12000 : 5000;
export const TRIAL_POLL_MS = 3000;
/* The indexer / trial-engine health pills, and the two admin panels. These hit
   our own /api/health and /trial-api/health, never the chain, so this figure
   has no bearing on RPC rate limits. It is load on our own boxes. Five
   minutes: a service being down is worth surfacing, but not 360 times an hour
   per open tab. Both admin panels ride on this constant too, so the pool list
   and last-mark readout age by up to five minutes as well. */
export const HEALTH_POLL_MS = 300000;
