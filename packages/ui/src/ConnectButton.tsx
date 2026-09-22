"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useWallet, type Wallet } from "@solana/wallet-adapter-react";
import { shortAddress } from "./format";
import { useWalletError } from "./WalletConnectProvider";

export interface ConnectButtonProps {
  /** "md" for the investor app, "sm" for dense rows, "lg" for the nav-bar pill. */
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Label while disconnected. */
  label?: string;
  /** Anchor the dropdown to the left or right edge of the button. */
  align?: "left" | "right";
  /**
   * App-specific entries for the account menu, rendered above Disconnect.
   * Keeps route-aware links (e.g. Admin) in the app rather than in this
   * shared component. Pass elements with role="menuitem".
   */
  menuExtras?: ReactNode;
}

type Panel = "closed" | "wallets" | "account";

/**
 * Only a browser extension counts as "detected". `Loadable` is the adapter's
 * web-wallet fallback (e.g. solflare.com/provider in a new tab on mainnet):
 * it cannot reach a local/devnet RPC and cannot auto-reconnect, so we never
 * offer it. We ask for the extension instead.
 */
const detected = (w: Wallet) => w.readyState === WalletReadyState.Installed;

/**
 * Wallet connect control shared by every Kydo app. No modal: a dropdown
 * anchored to the button lists the wallets (detected ones first); once
 * connected it shows the address with copy / change wallet / disconnect.
 */
export function ConnectButton({ size = "md", className = "", label = "Connect wallet", align = "right", menuExtras }: ConnectButtonProps) {
  const { wallets, wallet, publicKey, connecting, select, connect, disconnect } = useWallet();
  const adapterError = useWalletError();
  const [panel, setPanel] = useState<Panel>("closed");
  const [pending, setPending] = useState<string | null>(null);
  const [localError, setError] = useState<string | null>(null);
  const error = localError ?? adapterError.error;
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // close on outside click / escape
  useEffect(() => {
    if (panel === "closed") return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPanel("closed");
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPanel("closed");
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [panel]);

  // `select()` is async in the adapter context. Once the chosen adapter is active the
  // WalletProvider's autoConnect issues the single connect() request. We must NOT call
  // connect() here too, or the wallet sees a duplicate request and rejects it
  // (Phantom: "Unexpected error", Solflare: "Connection rejected").
  useEffect(() => {
    if (!pending || wallet?.adapter.name !== pending) return;
    setPending(null);
  }, [pending, wallet]);

  // Clear a stale pending marker if the adapter never became active.
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(null), 4_000);
    return () => clearTimeout(t);
  }, [pending]);

  useEffect(() => {
    if (publicKey) {
      setPanel("closed");
      setError(null);
    }
  }, [publicKey]);

  const choose = useCallback(
    (w: Wallet) => {
      setError(null);
      adapterError.clear();
      if (!detected(w)) {
        setError(`${w.adapter.name} browser extension not detected. Install it, then reload this page.`);
        return;
      }
      if (wallet?.adapter.name === w.adapter.name && !publicKey) {
        // Same adapter re-chosen after a disconnect/rejection: autoConnect won't re-fire, so connect explicitly.
        if (!connecting) connect().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
        return;
      }
      setPending(w.adapter.name);
      select(w.adapter.name);
    },
    [wallet, publicKey, connecting, select, connect, adapterError],
  );

  const copy = useCallback(async () => {
    if (!publicKey) return;
    await navigator.clipboard.writeText(publicKey.toBase58());
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [publicKey]);

  const base = `kydo-wallet-btn kydo-wallet-btn--${size} ${className}`;
  const sorted = [...wallets].sort((a, b) => Number(detected(b)) - Number(detected(a)));

  return (
    <div className={`kydo-wallet-menu ${className.includes("w-full") ? "kydo-wallet-menu--block" : ""}`} ref={ref}>
      {publicKey ? (
        <button type="button" className={base} onClick={() => setPanel((p) => (p === "closed" ? "account" : "closed"))} aria-haspopup="menu" aria-expanded={panel !== "closed"}>
          {wallet?.adapter.icon ? <img className="kydo-wallet-btn__icon" src={wallet.adapter.icon} alt="" /> : null}
          <span className="kydo-wallet-btn__addr">{shortAddress(publicKey.toBase58())}</span>
          <Chevron />
        </button>
      ) : (
        <button
          type="button"
          className={`${base} kydo-wallet-btn--primary`}
          onClick={() => setPanel((p) => (p === "closed" ? "wallets" : "closed"))}
          disabled={connecting || pending !== null}
          aria-haspopup="menu"
          aria-expanded={panel !== "closed"}
        >
          {connecting || pending ? "Connecting…" : label}
          <Chevron />
        </button>
      )}

      {panel === "account" && (
        <div className={`kydo-wallet-menu__list kydo-wallet-menu__list--${align}`} role="menu">
          <div className="kydo-wallet-menu__head">
            {wallet?.adapter.icon ? <img className="kydo-wallet-btn__icon" src={wallet.adapter.icon} alt="" /> : null}
            <span>{wallet?.adapter.name}</span>
            <span className="kydo-wallet-btn__addr">{shortAddress(publicKey!.toBase58(), 6)}</span>
          </div>
          <button type="button" role="menuitem" onClick={copy}>
            {copied ? "Copied" : "Copy address"}
          </button>
          <button type="button" role="menuitem" onClick={() => setPanel("wallets")}>
            Change wallet
          </button>
          {menuExtras}
          <button
            type="button"
            role="menuitem"
            className="kydo-wallet-menu__danger"
            onClick={() => {
              setPanel("closed");
              void disconnect();
            }}
          >
            Disconnect
          </button>
        </div>
      )}

      {panel === "wallets" && (
        <div className={`kydo-wallet-menu__list kydo-wallet-menu__list--${align}`} role="menu">
          <div className="kydo-wallet-menu__title">Connect a wallet on Solana</div>
          {sorted.map((w) => {
            const ok = detected(w);
            const active = publicKey && wallet?.adapter.name === w.adapter.name;
            return (
              <button key={w.adapter.name} type="button" role="menuitem" className="kydo-wallet-item" onClick={() => choose(w)} disabled={!!active}>
                <img className="kydo-wallet-item__icon" src={w.adapter.icon} alt="" />
                <span className="kydo-wallet-item__name">{w.adapter.name}</span>
                {ok || active ? (
                  <span className="kydo-wallet-item__tag kydo-wallet-item__tag--ok">{active ? "Connected" : "Detected"}</span>
                ) : (
                  <a
                    className="kydo-wallet-item__tag kydo-wallet-item__install"
                    href={w.adapter.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Install extension ↗
                  </a>
                )}
              </button>
            );
          })}
          {sorted.length === 0 && <div className="kydo-wallet-menu__empty">No Solana wallets found. Install Phantom or Solflare.</div>}
          {error && <div className="kydo-wallet-menu__error">{error}</div>}
        </div>
      )}
    </div>
  );
}

function Chevron() {
  return (
    <svg className="kydo-wallet-btn__chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
