"use client";
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { FUNDED_EVENT } from "./WalletBalances";

export interface FaucetButtonProps {
  /** Indexer base URL (NEXT_PUBLIC_API_URL). */
  apiUrl: string;
  size?: "sm" | "md";
  className?: string;
  usd?: number;
  sol?: number;
  /** Called after a successful drip so the app can refresh balances. */
  onFunded?: () => void;
}

interface Health {
  ok: boolean;
  cluster?: string;
  faucet?: boolean;
}

/**
 * "Get test USDC". Visible only when the indexer reports a faucet (localnet /
 * devnet). Drips test USDC + SOL to the connected wallet and broadcasts
 * `kydo:funded` so balances refresh.
 */
export function FaucetButton({ apiUrl, size = "md", className = "", usd = 5_000, sol = 2, onFunded }: FaucetButtonProps) {
  const { publicKey } = useWallet();
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; err: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${apiUrl}/health`)
        .then((r) => r.json())
        .then((h: Health) => alive && setHealth(h))
        .catch(() => alive && setHealth(null));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [apiUrl]);

  if (!health?.faucet || !publicKey) return null;

  const drip = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${apiUrl}/faucet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: publicKey.toBase58(), usd, sol }),
      });
      // A proxy / CDN error page is HTML, not the faucet's JSON. Say so instead of "Unexpected token '<'".
      const isJson = /json/i.test(res.headers.get("content-type") ?? "");
      const body = isJson ? await res.json() : null;
      if (!body) throw new Error(`the faucet did not answer (HTTP ${res.status} from the server or proxy). Wait a moment and try again`);
      if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const solText = Number(body.sol) > 0 ? `, +${body.sol} SOL` : "";
      setMsg({
        text: `Funded on ${body.cluster}: +${Number(body.usd).toLocaleString()} test USDC${solText}. Your wallet extension only shows this when it is on the same network (${body.cluster}).${body.note ? ` ${body.note}` : ""}`,
        err: false,
      });
      window.dispatchEvent(new CustomEvent(FUNDED_EVENT));
      onFunded?.();
    } catch (e) {
      setMsg({ text: `Faucet failed: ${e instanceof Error ? e.message : String(e)}`, err: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className={`kydo-faucet ${className}`}>
      <button type="button" className={`kydo-wallet-btn kydo-wallet-btn--${size}`} onClick={drip} disabled={busy} title={`Mint test USDC on ${health.cluster}`}>
        {busy ? "Funding…" : "Get test USDC"}
        <span className="kydo-faucet__net">{health.cluster}</span>
      </button>
      {msg && (
        <span className={`kydo-faucet__msg ${msg.err ? "kydo-faucet__msg--err" : ""}`} role="status">
          {msg.text}
          <button type="button" className="kydo-faucet__close" onClick={() => setMsg(null)} aria-label="dismiss">
            ×
          </button>
        </span>
      )}
    </span>
  );
}
