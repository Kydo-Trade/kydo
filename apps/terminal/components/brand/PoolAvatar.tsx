"use client";
/**
 * A pool's identity mark.
 *
 * Every pool used to wear the same `from-accent to-up` gradient circle with its
 * first letter on it, which made a grid of pools look like a grid of one pool
 * and put the *primary action colour* on a decoration, so the brightest thing
 * on the invest page was a badge you cannot click.
 *
 * Instead: the mark's own wedge geometry, rotated by a hash of the pool's
 * address, on a tint stepped along the brand ramp. Two pools are visibly
 * different, the set is visibly one family, and none of it borrows the accent.
 * Deterministic, so a pool keeps its face across sessions and devices.
 */
const TINTS = [
  { bg: "#2f4420", fg: "#8da750" },
  { bg: "#3a4f28", fg: "#a9cd5e" },
  { bg: "#2a3c24", fg: "#c4dd8b" },
  { bg: "#44582c", fg: "#d6e8ac" },
  { bg: "#33482a", fg: "#b6d573" },
];

/** FNV-1a. Any stable hash does; this one needs no dependency. */
function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function PoolAvatar({ seed, size = 28, className = "" }: { seed: string; size?: number; className?: string }) {
  const h = hash(seed || "pool");
  const t = TINTS[h % TINTS.length];
  const rot = (h >> 3) % 4; // four orientations. Enough to tell pools apart, few enough to stay a family
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ${className}`}
      style={{ width: size, height: size, background: t.bg }}
      aria-hidden
    >
      <svg viewBox="0 0 100 100" width={size * 0.62} height={size * 0.62} style={{ transform: `rotate(${rot * 90}deg)` }}>
        <path d="M0 40 L47 38 L0 74 Z" fill={t.fg} />
        <path d="M26 100 L57 48 L60 100 Z" fill={t.fg} />
      </svg>
    </span>
  );
}
