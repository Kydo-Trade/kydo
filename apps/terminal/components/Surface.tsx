"use client";
/**
 * The Rulebook's card and figure, lifted out of `rulebook/Visuals` so other
 * pages can be built on the same material.
 *
 * The Rulebook reads better than the rest of the app and it is worth naming
 * why, because none of it is decoration:
 *
 *  - **A gradient surface instead of a bordered box.** `.panel` is a flat fill
 *    with a hairline stroke; four of them nested read as a wireframe. A card
 *    lit from below separates itself from the page without drawing a line, so
 *    nesting stays legible.
 *  - **24 px of padding, 24 px of radius.** `.panel-body` is 12 px, which is
 *    right for a 272 px terminal column and cramped everywhere else.
 *  - **Titles are 16 px sentence case, not 12 px uppercase grey.** The uppercase
 *    micro-label is a terminal convention; on a page you read, it flattens every
 *    heading to one level.
 *  - **A figure is a number with its label underneath**, 28 px over 12 px. Label
 *    first is a form field; value first is a fact.
 */
import type { ReactNode } from "react";

export function Card({ title, aside, children, className = "" }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex flex-col gap-4 rounded-[24px] bg-gradient-to-t from-fig-bg-pattern-900 to-fig-bg-600 p-6 ${className}`}>
      {(title || aside) && (
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          {title && <h3 className="text-h9 font-medium text-fg">{title}</h3>}
          {aside && <span className="text-h11 text-fig-text-600">{aside}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A figure with its label under it. The unit of "one number". */
export function Figure({ value, label, tone = "fg", sub, children }: { value: ReactNode; label: string; tone?: "fg" | "accent" | "up" | "down" | "amber"; sub?: ReactNode; children?: ReactNode }) {
  const cls = { fg: "text-fg", accent: "text-accent", up: "text-up", down: "text-down", amber: "text-amber" }[tone];
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className={`num truncate text-h6 font-semibold leading-none ${cls}`}>{value}</span>
      <span className="truncate text-h11 text-fig-text-600">{label}</span>
      {sub && <span className="truncate text-h11 text-fig-text-700">{sub}</span>}
      {children}
    </div>
  );
}
