"use client";
/**
 * "How far am I from the next tier". The one question the Home status panel's
 * promotion section exists to answer.
 *
 * It used to be a two-column grid of ✓/✗ rows wedged under six stat tiles, with
 * the progress bar and the values clipping each other. Three changes:
 *
 *  - **A flow, not a list.** Where you are and what you are heading for, side by
 *    side, with the connector between them carrying the progress. The cap and
 *    the vesting period are the two things that actually change on promotion, so
 *    they are what the cards show.
 *  - **Pending is a dashed circle, not a red cross.** Day zero of thirty is not a
 *    failure, and marking it in red says the account is in trouble when nothing
 *    is wrong. This is the same badge language the onboarding wizard uses, which
 *    also ties the two surfaces together.
 *  - **Room to breathe.** Groups are separated by 20 px and labelled, rather than
 *    stacked at gap-1.5 in one undifferentiated block.
 */
import type { ReactNode } from "react";

function SectionLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 pb-3">
      <span className="font-sans text-h10 font-medium text-muted">{children}</span>
      {aside && <span className="num text-h11 text-muted">{aside}</span>}
    </div>
  );
}

function TierCard({ name, cap, facts, now = false, changed, showCap }: { name: string; cap: string; facts: Fact[]; now?: boolean; changed: Set<string>; showCap: boolean }) {
  /* A card leads with what promotion moves. When the cap changes it is the
     biggest lever and it is the headline; when it does not. Instant funding
     *buys* the Tier 1 cap, so tier 0 → 1 leaves it alone. Putting it at 20 px
     on both cards made two identical $5,000.00 figures the loudest thing in a
     diagram whose whole job is showing a difference. It reads as a bug even
     after the sentence underneath explains it, so on that path the cap moves
     out to a shared line above and the card leads with the first thing that
     actually changes. */
  // `changed` can be empty at the top tier or if two tiers are configured
  // identically; fall back to the cap so a card is never headless.
  const lead = showCap ? null : facts.find((f) => changed.has(f.label));
  const headless = !showCap && !lead;
  const rest = lead ? facts.filter((f) => f.label !== lead.label) : facts;
  return (
    <div className={`flex min-w-0 flex-1 flex-col gap-2 rounded-xl border p-4 ${now ? "border-accent bg-accent/[0.07]" : "border-fig-stroke bg-fig-bg-additional"}`}>
      <span className="flex items-center gap-2 text-h11 text-muted">
        {name}
        {now && <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink">now</span>}
      </span>
      {showCap || headless ? (
        <span className={`num text-h8 font-semibold leading-none ${now ? "text-accent" : "text-fg"}`}>{cap}</span>
      ) : lead ? (
        <span className="flex items-baseline gap-2">
          <span className={`num text-h8 font-semibold leading-none ${now ? "text-accent" : "text-fg"}`}>{lead.value}</span>
          <span className="truncate text-h11 text-muted">{lead.label.toLowerCase()}</span>
        </span>
      ) : null}
      <span className="flex flex-col gap-1 pt-1">
        {rest.map((f) => (
          <span key={f.label} className="flex items-baseline justify-between gap-3 text-h11">
            {/* A fact that does not change between the two tiers is context,
                not news. It stays legible but stops competing with the two or
                three that are the actual reason to promote. */}
            <span className={changed.has(f.label) ? "text-muted" : "text-fig-text-600"}>{f.label}</span>
            <span className={`num ${changed.has(f.label) ? (now ? "text-fg" : "text-accent") : "text-fig-text-600"}`}>{f.value}</span>
          </span>
        ))}
      </span>
    </div>
  );
}

/** The gap between the two tiers, carrying how much of it is closed. */
function Connector({ met, total }: { met: number; total: number }) {
  const pct = total > 0 ? Math.round((met / total) * 100) : 0;
  return (
    <div className="flex shrink-0 flex-col items-center justify-center gap-1.5 py-3 md:w-32 md:px-4 md:py-0" aria-hidden>
      <span className="num text-h11 text-muted">
        {met} of {total}
      </span>
      {/* The cards stack below md and sit side by side from md, so the bar that
          joins them has to change axis with them. Two elements rather than one
          transformed element: a Tailwind breakpoint cannot flip an inline
          style, and faking it in JS reads the wrong viewport on first paint. */}
      <div className="h-6 w-1 overflow-hidden rounded-full bg-fig-bg-750 md:hidden">
        <div className="w-full rounded-full bg-accent transition-all" style={{ height: `${pct}%` }} />
      </div>
      <div className="hidden h-1 w-full overflow-hidden rounded-full bg-fig-bg-750 md:block">
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Condition({ met, label, value, ratio }: { met: boolean; label: string; value?: string; ratio?: number }) {
  return (
    <li className="flex flex-col gap-1.5 border-b border-dashed border-fig-stroke py-3 first:pt-0 last:border-0 last:pb-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2.5">
          {met ? (
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-up text-ink" aria-hidden>
              <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3.5 8.4l3 3 6-6.6" />
              </svg>
            </span>
          ) : (
            <span className="size-5 shrink-0 rounded-full border border-dashed border-fig-text-700" aria-hidden />
          )}
          <span className="sr-only">{met ? "met" : "not yet"}</span>
          <span className={`truncate text-h10 ${met ? "text-fg" : "text-muted"}`}>{label}</span>
        </span>
        {value && <span className={`num shrink-0 text-h11 ${met ? "text-up" : "text-muted"}`}>{value}</span>}
      </div>
      {ratio !== undefined && (
        <div className="ml-[30px] h-1 overflow-hidden rounded-full bg-fig-bg-750">
          <div className={`h-full rounded-full ${met ? "bg-up" : "bg-accent"}`} style={{ width: `${Math.min(100, Math.max(0, ratio) * 100)}%` }} />
        </div>
      )}
    </li>
  );
}

export interface Fact {
  label: string;
  value: string;
}

export interface TierFacts {
  name: string;
  /** The headline: the capital ceiling at this tier. */
  cap: string;
  /** Everything else worth comparing. Vesting, loss limits. */
  facts: Fact[];
}

export interface PromotionProgressProps {
  current: TierFacts;
  /** Absent at the top tier. */
  next?: TierFacts;
  conditions: { met: boolean; label: string; value?: string; ratio?: number }[];
}

export function PromotionProgress({ current, next, conditions }: PromotionProgressProps) {
  const met = conditions.filter((c) => c.met).length;
  /* Which facts actually differ. Instant funding is the case that made this
     necessary: it buys the Tier 1 *cap*, so a card comparing caps and vesting
     showed "$5,000 / 14 days" against "$5,000 / 14 days" and made promotion
     look pointless. What tier 0 -> 1 really buys is faster vesting and the
     normal loss limits back. Rather than hard-code which fields matter per
     tier, diff them and let the card say so. */
  const changed = new Set<string>();
  if (next) {
    for (const f of current.facts) {
      const other = next.facts.find((x) => x.label === f.label);
      if (other && other.value !== f.value) changed.add(f.label);
    }
    if (next.cap !== current.cap) changed.add("__cap");
  }
  const deltas = [...changed].filter((k) => k !== "__cap");
  const capChanges = changed.has("__cap");

  return (
    <div className="flex flex-col gap-5">
      {next && (
        <div>
          <SectionLabel aside={changed.size === 0 ? "nothing changes" : undefined}>Where you are</SectionLabel>
          {!capChanges && (
            /* Said once, above both cards, because it is true of both. */
            <div className="mb-3 flex items-baseline justify-between gap-3 rounded-xl border border-dashed border-fig-stroke px-4 py-2.5">
              <span className="text-h11 text-muted">Capital ceiling</span>
              <span className="text-h11 text-fig-text-600">
                <span className="num text-fg">{current.cap}</span> at both tiers. Instant funding already buys the {next.name} cap
              </span>
            </div>
          )}
          <div className="flex flex-col items-stretch md:flex-row md:items-stretch">
            <TierCard {...current} now changed={changed} showCap={capChanges} />
            <Connector met={met} total={conditions.length} />
            <TierCard {...next} changed={changed} showCap={capChanges} />
          </div>
          {deltas.length > 0 && (
            <p className="pt-2 text-h11 leading-double text-muted">
              Promotion changes {deltas.length === 1 ? "one thing" : `${deltas.length} things`}:{" "}
              <span className="text-fg">
                {deltas
                  .map((k) => `${k.toLowerCase()} ${current.facts.find((f) => f.label === k)?.value} → ${next.facts.find((f) => f.label === k)?.value}`)
                  .join(", ")}
              </span>
              .
            </p>
          )}
        </div>
      )}

      <div>
        <SectionLabel aside={`${met} of ${conditions.length} met`}>{next ? "What promotion needs" : "Status"}</SectionLabel>
        <ul className="flex flex-col rounded-xl border border-fig-stroke bg-fig-bg-additional px-4 py-3">
          {conditions.map((c) => (
            <Condition key={c.label} {...c} />
          ))}
        </ul>
      </div>
    </div>
  );
}
