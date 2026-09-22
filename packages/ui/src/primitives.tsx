"use client";
import type { ReactNode } from "react";

/** Grey placeholder block for loading states. Pass width/height via className or style. */
export function Skeleton({ className = "", lines = 1 }: { className?: string; lines?: number }) {
  if (lines <= 1) return <span className={`kydo-skeleton ${className}`} aria-hidden />;
  return (
    <span className={`kydo-skeleton-stack ${className}`} aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <span key={i} className="kydo-skeleton" style={{ width: `${100 - (i % 3) * 12}%` }} />
      ))}
    </span>
  );
}

/** Consistent empty state: icon, headline, one-line explanation, optional action. */
export function EmptyState({ icon = "◌", title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="kydo-empty" role="status">
      <div className="kydo-empty__icon" aria-hidden>
        {icon}
      </div>
      <div className="kydo-empty__title">{title}</div>
      {children && <div className="kydo-empty__text">{children}</div>}
      {action && <div className="kydo-empty__action">{action}</div>}
    </div>
  );
}

export interface Step {
  key: string;
  label: string;
  /** Short helper shown under the active step. */
  hint?: string;
}

/**
 * Horizontal progress stepper for the trader funnel (section 6.1) / investor flow (section 6.2).
 * `current` = index of the active step; steps before it are done.
 */
export function Stepper({ steps, current, failedAt }: { steps: Step[]; current: number; failedAt?: number }) {
  return (
    <ol className="kydo-stepper" aria-label="Progress">
      {steps.map((s, i) => {
        const state = failedAt === i ? "failed" : i < current ? "done" : i === current ? "active" : "todo";
        return (
          <li key={s.key} className={`kydo-step kydo-step--${state}`} aria-current={state === "active" ? "step" : undefined}>
            <span className="kydo-step__dot" aria-hidden>
              {state === "done" ? "✓" : state === "failed" ? "✕" : i + 1}
            </span>
            <span className="kydo-step__label">{s.label}</span>
            {state === "active" && s.hint && <span className="kydo-step__hint">{s.hint}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** Inline busy indicator for buttons; inherits the button's text colour. */
export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`kydo-spinner ${className}`} role="status" aria-label="Working" />;
}

/** Small status pill. */
export function Pill({ tone = "neutral", children, title, dot = false }: { tone?: "neutral" | "good" | "warn" | "bad" | "info"; children: ReactNode; title?: string; dot?: boolean }) {
  return (
    <span className={`kydo-pill kydo-pill--${tone}${dot ? " kydo-pill--dot" : ""}`} title={title}>
      {children}
    </span>
  );
}
