/**
 * Browser-held session keypair for one-click live trading.
 *
 * The trader authorises it on-chain once (`set_session_key`, ≤ 24 h); after that
 * `place_trade` / `close_trade` are signed locally by this keypair and sent
 * directly. No wallet popup. The key can only sign trade instructions (the
 * program rejects it for anything that moves funds), and the trader can revoke
 * it at any time. Stored in localStorage per wallet + program.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { useSyncExternalStore } from "react";
import { PROGRAM_ID } from "./config";

const KEY = (wallet: string) => `kydo.session.${PROGRAM_ID.toBase58()}.${wallet}`;

export interface StoredSession {
  secret: number[];
  pubkey: string;
  /** unix seconds; mirrors the on-chain `expires_at` */
  expiresAt: number;
}

let listeners: (() => void)[] = [];
const notify = () => listeners.forEach((l) => l());

// useSyncExternalStore needs a referentially stable snapshot: cache the parsed value per raw string.
const cache = new Map<string, { raw: string; value: StoredSession | null }>();

export function loadSession(wallet: string): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY(wallet)) ?? "";
    const hit = cache.get(wallet);
    if (hit && hit.raw === raw) return hit.value;
    const value = raw ? (JSON.parse(raw) as StoredSession) : null;
    cache.set(wallet, { raw, value });
    return value;
  } catch {
    return null;
  }
}

export function sessionKeypair(wallet: string): Keypair | null {
  const s = loadSession(wallet);
  if (!s) return null;
  if (s.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(s.secret));
  } catch {
    return null;
  }
}

/** Create a fresh keypair for `wallet` (not yet authorised on-chain). */
export function newSession(wallet: string, ttlSecs: number): { keypair: Keypair; expiresAt: number } {
  const keypair = Keypair.generate();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSecs;
  const s: StoredSession = { secret: [...keypair.secretKey], pubkey: keypair.publicKey.toBase58(), expiresAt };
  try {
    localStorage.setItem(KEY(wallet), JSON.stringify(s));
  } catch {}
  notify();
  return { keypair, expiresAt };
}

export function clearSession(wallet: string) {
  try {
    localStorage.removeItem(KEY(wallet));
  } catch {}
  notify();
}

/** Reactive view of the stored session for a wallet. */
export function useSession(wallet: PublicKey | null): StoredSession | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.push(cb);
      const onStorage = () => cb();
      window.addEventListener("storage", onStorage);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
        window.removeEventListener("storage", onStorage);
      };
    },
    () => (wallet ? loadSession(wallet.toBase58()) : null),
    () => null,
  );
}
