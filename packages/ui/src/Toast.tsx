"use client";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastKind = "success" | "error" | "info" | "pending";

export interface ToastInput {
  kind: ToastKind;
  title: string;
  /** Secondary line. Error detail, amounts, etc. */
  detail?: string;
  /** Optional link, e.g. an explorer URL for a transaction. */
  link?: { label: string; href: string };
  /** ms; default 6 s. Pending and errors are sticky until dismissed. Pass an
   *  explicit ttl to override. */
  ttl?: number;
}

export interface Toast extends ToastInput {
  id: number;
}

interface ToastApi {
  push: (t: ToastInput) => number;
  /** Replace a pending toast (e.g. "sending…" → "confirmed"). */
  update: (id: number, t: Partial<ToastInput>) => void;
  dismiss: (id: number) => void;
  toasts: Toast[];
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children, max = 4 }: { children: ReactNode; max?: number }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
    const tm = timers.current.get(id);
    if (tm) clearTimeout(tm);
    timers.current.delete(id);
  }, []);

  const arm = useCallback(
    (id: number, t: ToastInput) => {
      const tm = timers.current.get(id);
      if (tm) clearTimeout(tm);
      // Pending stays until it resolves. Errors stay until dismissed: a failed
      // transaction's toast is the only explanation of why the money did not
      // move, and ten seconds is exactly long enough to miss it while looking
      // at the wallet. An explicit `ttl` still wins for callers that want one.
      if (t.kind === "pending") return;
      if (t.kind === "error" && t.ttl === undefined) return;
      const ttl = t.ttl ?? 6_000;
      timers.current.set(id, setTimeout(() => dismiss(id), ttl));
    },
    [dismiss],
  );

  const push = useCallback(
    (t: ToastInput) => {
      const id = seq.current++;
      setToasts((ts) => [...ts.slice(-(max - 1)), { ...t, id }]);
      arm(id, t);
      return id;
    },
    [arm, max],
  );

  const update = useCallback(
    (id: number, patch: Partial<ToastInput>) => {
      setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      setToasts((ts) => {
        const t = ts.find((x) => x.id === id);
        if (t) arm(id, t);
        return ts;
      });
    },
    [arm],
  );

  const api = useMemo<ToastApi>(() => ({ push, update, dismiss, toasts }), [push, update, dismiss, toasts]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} dismiss={dismiss} />
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(Ctx);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}

/**
 * Run an async action with pending → success/error toasts.
 * `describe` turns the result into the success title/detail.
 */
export async function withToast<T>(
  toast: ToastApi,
  pending: string,
  fn: () => Promise<T>,
  describe: (r: T) => Omit<ToastInput, "kind">,
  describeError: (e: unknown) => Omit<ToastInput, "kind"> = (e) => ({ title: "Failed", detail: e instanceof Error ? e.message : String(e) }),
): Promise<T | undefined> {
  const id = toast.push({ kind: "pending", title: pending });
  try {
    const r = await fn();
    toast.update(id, { kind: "success", ...describe(r) });
    return r;
  } catch (e) {
    toast.update(id, { kind: "error", ...describeError(e) });
    return undefined;
  }
}

const ICON: Record<ToastKind, string> = { success: "✓", error: "✕", info: "i", pending: "…" };

function ToastViewport({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="kydo-toasts" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`kydo-toast kydo-toast--${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <span className="kydo-toast__icon" aria-hidden>
            {ICON[t.kind]}
          </span>
          <div className="kydo-toast__body">
            <div className="kydo-toast__title">{t.title}</div>
            {t.detail && <div className="kydo-toast__detail">{t.detail}</div>}
            {t.link && (
              <a className="kydo-toast__link" href={t.link.href} target="_blank" rel="noopener noreferrer">
                {t.link.label} ↗
              </a>
            )}
          </div>
          <button type="button" className="kydo-toast__close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
