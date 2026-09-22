"use client";
import { useCallback, useEffect, useState } from "react";
import { useToast } from "@kydo/ui";
import { explorerTxUrl } from "./config";
import { explainError } from "./errors";

export interface ActionState {
  busy: boolean;
  error: string | null;
  errorCode: string | null;
  result: string | null;
}

/** Run an async action (usually a tx) with busy/error/result bookkeeping. No toasts. */
export function useAction() {
  const [state, setState] = useState<ActionState>({ busy: false, error: null, errorCode: null, result: null });
  const run = useCallback(async <T,>(fn: () => Promise<T>, okMessage?: (r: T) => string): Promise<T | undefined> => {
    setState({ busy: true, error: null, errorCode: null, result: null });
    try {
      const r = await fn();
      setState({ busy: false, error: null, errorCode: null, result: okMessage ? okMessage(r) : "done" });
      return r;
    } catch (e) {
      const ex = explainError(e);
      setState({ busy: false, error: ex.message, errorCode: ex.code, result: null });
      return undefined;
    }
  }, []);
  const reset = useCallback(() => setState({ busy: false, error: null, errorCode: null, result: null }), []);
  return { ...state, run, reset };
}

/** What a successful action should say. `sig` (an on-chain signature) adds an explorer link. */
export interface TxOutcome {
  title: string;
  detail?: string;
  sig?: string | null;
}

/**
 * Transaction runner with toast feedback: pending → confirmed (explorer link)
 * or a human error from lib/errors.ts. Also exposes `busy` / `error` so a
 * button can disable itself and a ConfirmDialog can echo the failure inline.
 */
export function useTx() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const run = useCallback(
    async <T,>(pending: string, fn: () => Promise<T>, ok: string | ((r: T) => TxOutcome | string)): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      setErrorCode(null);
      const id = toast.push({ kind: "pending", title: pending });
      try {
        const r = await fn();
        const o = typeof ok === "function" ? ok(r) : ok;
        const out: TxOutcome = typeof o === "string" ? { title: o } : o;
        toast.update(id, {
          kind: "success",
          title: out.title,
          detail: out.detail,
          link: out.sig ? { label: `View ${out.sig.slice(0, 8)}… on Explorer`, href: explorerTxUrl(out.sig) } : undefined,
        });
        return r;
      } catch (e) {
        const ex = explainError(e);
        setError(ex.message);
        setErrorCode(ex.code);
        toast.update(id, { kind: "error", title: ex.code ? `Failed · ${ex.code}` : "Failed", detail: ex.message });
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  const reset = useCallback(() => {
    setError(null);
    setErrorCode(null);
  }, []);

  return { busy, error, errorCode, run, reset };
}

/** Re-renders every `ms` (for countdowns). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** localStorage-backed state (SSR-safe, falls back to the default when storage is unavailable). */
export function useStoredState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      /* ignore */
    }
  }, [key]);
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [key],
  );
  return [value, set];
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
