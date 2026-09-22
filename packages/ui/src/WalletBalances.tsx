"use client";
import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

export const FUNDED_EVENT = "kydo:funded";

export interface WalletBalancesProps {
  /** Test/real USDC mint (NEXT_PUBLIC_USDC_MINT). */
  usdcMint?: string | null;
  size?: "sm" | "md";
  className?: string;
  pollMs?: number;
  /** Render a single figure instead of both. The header shows USDC alone. */
  only?: "sol" | "usdc";
  /**
   * SOL below this many SOL is surfaced as a warning even when it is not
   * otherwise rendered. The header shows USDC alone per the design, but a
   * wallet out of SOL cannot sign anything, so the shortfall has to be visible
   * where the trader already is. 0 disables it.
   */
  warnLowSolBelow?: number;
}

/** SPL associated token address without pulling @solana/spl-token into the UI package. */
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
function ata(mint: PublicKey, owner: PublicKey) {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

/**
 * Shows the connected wallet's SOL and USDC balances as seen by the app's RPC
 * (the network the app is on. Not whatever network the wallet UI displays).
 * Refreshes on a poll and immediately after the faucet funds the wallet.
 */
export function WalletBalances({ usdcMint, size = "md", className = "", pollMs = 15_000, only, warnLowSolBelow = 0 }: WalletBalancesProps) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [sol, setSol] = useState<number | null>(null);
  const [usdc, setUsdc] = useState<number | null>(null);
  const [hasAta, setHasAta] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    if (!publicKey) return;
    try {
      const lamports = await connection.getBalance(publicKey, "confirmed");
      setSol(lamports / LAMPORTS_PER_SOL);
    } catch {
      setSol(null);
    }
    if (!usdcMint) return;
    try {
      const acc = await connection.getTokenAccountBalance(ata(new PublicKey(usdcMint), publicKey), "confirmed");
      setUsdc(Number(acc.value.uiAmount ?? 0));
      setHasAta(true);
    } catch {
      setUsdc(0);
      setHasAta(false);
    }
  }, [connection, publicKey, usdcMint]);

  useEffect(() => {
    if (!publicKey) {
      setSol(null);
      setUsdc(null);
      setHasAta(null);
      return;
    }
    refresh();
    const t = setInterval(refresh, pollMs);
    const onFunded = () => refresh();
    window.addEventListener(FUNDED_EVENT, onFunded);
    return () => {
      clearInterval(t);
      window.removeEventListener(FUNDED_EVENT, onFunded);
    };
  }, [publicKey, refresh, pollMs]);

  if (!publicKey) return null;
  const fmt = (n: number, dp: number) => n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
  // Only when SOL is not already on screen. Otherwise the figure is its own warning.
  const lowSol = warnLowSolBelow > 0 && only === "usdc" && sol !== null && sol < warnLowSolBelow;
  return (
    <span className={`kydo-balances kydo-balances--${size} ${className}`} title="Balances on the app's network (from its RPC)">
      {only !== "usdc" && (
        <span className="kydo-balances__item">
          <span className="kydo-balances__sym">SOL</span>
          <span className="kydo-balances__val">{sol === null ? "…" : fmt(sol, 2)}</span>
        </span>
      )}
      {lowSol && (
        <span className="kydo-balances__item kydo-balances__item--warn" title={`Only ${fmt(sol ?? 0, 4)} SOL left. SOL pays every transaction fee, so signing will start to fail. Top up from the Balances panel.`}>
          <span className="kydo-balances__sym">SOL</span>
          <span className="kydo-balances__val">{fmt(sol ?? 0, 3)}</span>
        </span>
      )}
      {usdcMint && only !== "sol" && (
        <span className={`kydo-balances__item ${hasAta === false ? "kydo-balances__item--empty" : ""}`}>
          <span className="kydo-balances__sym">USDC</span>
          <span className="kydo-balances__val">{usdc === null ? "…" : hasAta === false ? "no account" : fmt(usdc, 2)}</span>
        </span>
      )}
    </span>
  );
}
