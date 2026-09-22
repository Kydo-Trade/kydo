"use client";
import React, { createContext, useContext, useMemo } from "react";
import { AnchorProvider } from "@coral-xyz/anchor";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Connection, Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import { VaultClient } from "@kydo/sdk";
import { WalletConnectProvider } from "@kydo/ui";
import { PROGRAM_ID, RPC_URL } from "./config";

/**
 * The wallet RPC endpoint actually in use. Supplied by the server layout at
 * request time (app/layout.tsx) so the host can point the browser at a
 * domain-restricted key without a rebuild; falls back to the build-time
 * NEXT_PUBLIC_RPC_URL for `next dev` and SSR.
 */
const RpcUrlContext = createContext<string>(RPC_URL);
export const useRpcUrl = () => useContext(RpcUrlContext);

/** Shared wallet setup (Phantom + Solflare + themed modal) from @kydo/ui. */
export function SolanaProviders({ children, rpcUrl }: { children: React.ReactNode; rpcUrl?: string }) {
  const endpoint = rpcUrl || RPC_URL;
  return (
    <RpcUrlContext.Provider value={endpoint}>
      <WalletConnectProvider endpoint={endpoint}>{children}</WalletConnectProvider>
    </RpcUrlContext.Provider>
  );
}

export interface VaultClients {
  /** Signing client (undefined until a wallet is connected). */
  client: VaultClient | null;
  /** Read-only client backed by a throwaway keypair. Always available. */
  readonly: VaultClient;
  provider: AnchorProvider | null;
}

/**
 * Read-only wallet for account fetches. (Avoids `VaultClient.readonly`, whose
 * Anchor `Wallet`/NodeWallet is not exported in browser/SSR bundles.)
 */
const READONLY_WALLET = {
  publicKey: Keypair.generate().publicKey,
  signTransaction: async <T extends Transaction | VersionedTransaction>(_tx: T): Promise<T> => {
    throw new Error("read-only wallet cannot sign");
  },
  signAllTransactions: async <T extends Transaction | VersionedTransaction>(_txs: T[]): Promise<T[]> => {
    throw new Error("read-only wallet cannot sign");
  },
};

export function readonlyClient(connection: Connection): VaultClient {
  return new VaultClient(new AnchorProvider(connection, READONLY_WALLET, { commitment: "confirmed" }), PROGRAM_ID);
}

/** Builds an AnchorProvider from the wallet-adapter wallet and wraps it in the SDK client. */
export function useVaultClient(): VaultClients {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  return useMemo(() => {
    const readonly = readonlyClient(connection);
    if (!wallet) return { client: null, readonly, provider: null };
    // preflightCommitment "finalized": wallet-signed transactions carry a blockhash every RPC node already knows,
    // so wallets never mistake a fresh devnet blockhash for another cluster ("this transaction is for mainnet").
    const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed", preflightCommitment: "finalized", skipPreflight: true });
    return { client: new VaultClient(provider, PROGRAM_ID), readonly, provider };
  }, [connection, wallet]);
}

/** Message signer for the trial engine's signed requests. */
export function useSigner() {
  const { publicKey, signMessage } = useWallet();
  return useMemo(() => {
    if (!publicKey || !signMessage) return null;
    return { publicKey, signMessage };
  }, [publicKey, signMessage]);
}
