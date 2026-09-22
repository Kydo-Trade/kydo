"use client";
import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { WalletError } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import type { Commitment } from "@solana/web3.js";

export interface WalletConnectProviderProps {
  /** RPC endpoint (http://127.0.0.1:8899 for the local stack, devnet otherwise). */
  endpoint: string;
  commitment?: Commitment;
  autoConnect?: boolean;
  children: React.ReactNode;
}

interface WalletErrorState {
  error: string | null;
  clear: () => void;
}
const WalletErrorContext = createContext<WalletErrorState>({ error: null, clear: () => {} });

/** Last error reported by the wallet adapter (connect rejected, extension error, …). */
export const useWalletError = () => useContext(WalletErrorContext);

function describe(e: WalletError): string {
  const name = e.name?.replace(/^Wallet/, "").replace(/Error$/, "");
  const msg = e.message && e.message !== "Unexpected error" ? e.message : "";
  switch (e.name) {
    case "WalletConnectionError":
      return msg || "The wallet refused the connection. Approve the request in the extension popup, or unlock the wallet and try again.";
    case "WalletNotReadyError":
      return "Wallet extension not detected. Install it and reload the page.";
    case "WalletWindowClosedError":
      return "Wallet window was closed before approving.";
    case "WalletNotSelectedError":
      return "No wallet selected.";
    default:
      return [name, msg].filter(Boolean).join(": ") || "Wallet error";
  }
}

/**
 * One wallet setup for every Kydo app: Phantom + Solflare, the modal
 * provider, adapter errors surfaced through `useWalletError`, and a shared
 * theme (import "@kydo/ui/styles.css" once in the layout).
 */
/**
 * Public RPCs (api.devnet.solana.com) rate-limit per IP and per method; a shared dev machine
 * (browser + keeper + indexer) trips 429s in bursts. Retry idempotently with jittered backoff.
 * JSON-RPC reads and preflight retries are safe; sendTransaction retries are safe too (same
 * signed bytes, same signature: replaying is a no-op).
 */
const fetchWith429Retry: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= 3) return res;
    const retryAfter = Number(res.headers.get("retry-after")) * 1000;
    const delay = retryAfter > 0 ? retryAfter : 400 * 2 ** attempt + Math.random() * 300;
    await new Promise((r) => setTimeout(r, Math.min(delay, 5000)));
  }
};

export function WalletConnectProvider({ endpoint, commitment = "confirmed", autoConnect = true, children }: WalletConnectProviderProps) {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  const [error, setError] = useState<string | null>(null);
  const onError = useCallback((e: WalletError) => {
    // Silent auto-reconnect failures on page load are expected (site not yet trusted); ignore them.
    if (e.name === "WalletNotReadyError") return;
    setError(describe(e));
  }, []);
  const ctx = useMemo<WalletErrorState>(() => ({ error, clear: () => setError(null) }), [error]);
  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment, fetch: fetchWith429Retry }}>
      <WalletProvider wallets={wallets} autoConnect={autoConnect} onError={onError}>
        <WalletErrorContext.Provider value={ctx}>
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletErrorContext.Provider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
