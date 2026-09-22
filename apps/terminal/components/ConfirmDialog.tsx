"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Body: consequences, numbers, what cannot be undone. */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" = red confirm button. */
  tone?: "danger" | "primary";
  /** Require the user to type this word before confirming (for irreversible actions). */
  typeToConfirm?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * In-app modal replacing `window.confirm`. Focus is trapped inside the dialog,
 * Escape / overlay click cancel, Enter confirms when allowed, and focus returns
 * to the opener on close.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "primary",
  typeToConfirm,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const confirmRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const ready = !busy && (!typeToConfirm || typed.trim().toUpperCase() === typeToConfirm.toUpperCase());

  // The keydown handler reads these via refs so the effect below can depend on
  // `open` alone. Re-running it on each keystroke would steal focus from any
  // input rendered in `children` (the confirmRef.focus() call).
  const liveRef = useRef({ ready, busy, onConfirm, onCancel });
  liveRef.current = { ready, busy, onConfirm, onCancel };

  useEffect(() => {
    if (!open) {
      setTyped("");
      return;
    }
    openerRef.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      const { ready, busy, onConfirm, onCancel } = liveRef.current;
      if (e.key === "Escape" && !busy) onCancel();
      if (e.key === "Enter" && ready && !(e.target instanceof HTMLTextAreaElement)) onConfirm();
      if (e.key === "Tab" && boxRef.current) {
        const focusables = Array.from(boxRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    if (!typeToConfirm) confirmRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      openerRef.current?.focus?.();
    };
  }, [open, typeToConfirm]);

  if (!open) return null;
  return (
    <div className="modal__overlay" onMouseDown={() => !busy && onCancel()} role="presentation">
      <div
        ref={boxRef}
        className="modal w-[460px]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div id={titleId} className="modal__title">
          {title}
        </div>
        {children && <div className="flex flex-col gap-2 text-h11 leading-double text-fig-text-500/90">{children}</div>}
        {typeToConfirm && (
          <label className="text-h11 text-fig-text-600">
            Type <span className="num text-fg">{typeToConfirm}</span> to confirm
            <input className="input mt-1" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus disabled={busy} placeholder={typeToConfirm} />
          </label>
        )}
        {error && (
          <div className="notice notice-bad" role="alert">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${tone === "danger" ? "btn-down" : "btn-primary"} font-semibold`}
            onClick={onConfirm}
            disabled={!ready}
            title={busy ? "Waiting for the wallet / network…" : typeToConfirm && !ready ? `Type ${typeToConfirm} to enable` : undefined}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
