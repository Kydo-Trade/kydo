/** Environment wiring. The landing is wallet-free and talks only to the indexer's public REST API. */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export const TERMINAL_URL = process.env.NEXT_PUBLIC_TERMINAL_URL ?? "http://localhost:3000";
export const NETWORK = process.env.NEXT_PUBLIC_NETWORK ?? "devnet";
export const PROGRAM_ID = process.env.NEXT_PUBLIC_VAULT_PROGRAM_ID ?? "G4E1BiuovMpeUCgyh2222GqAQt4cW5dXSovZipFd89T1";

/** Solana Explorer link for an address on the configured network. */
export const explorerAddrUrl = (addr: string) => {
  const q =
    NETWORK === "localnet"
      ? `?cluster=custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`
      : NETWORK === "mainnet" || NETWORK === "mainnet-beta"
        ? ""
        : "?cluster=devnet";
  return `https://explorer.solana.com/address/${addr}${q}`;
};

export const usd = (v: number) =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const usdWhole = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

/** oracle price with sensible precision. Sub-$1 assets keep 4 decimals (DOGE ≠ $0.09). */
export const price = (v: number) => usd0(v, v >= 1 ? 2 : 4);
const usd0 = (v: number, dp: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: dp, maximumFractionDigits: dp });

/** basis points → human percentage ("800" → "8%"). */
export const pct = (bps: number) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

/** seconds → human duration, coarse on purpose ("86400" → "24 h", "604800" → "7 days"). */
export const dur = (secs: number) => {
  if (secs < 120) return `${secs} s`;
  if (secs < 7200) return `${Math.round(secs / 60)} min`;
  if (secs < 172800) return `${Math.round(secs / 3600)} h`;
  return `${Math.round(secs / 86400)} days`;
};
