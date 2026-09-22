"use client";
/**
 * The asset mark for a market, with the lettered circle as a fallback.
 *
 * Icons are looked up by base symbol at `/brand/tokens/<symbol>.svg`
 * (lower-case, e.g. `sol.svg`). None are committed. They are third-party brand
 * marks, so the set is a licensing choice; `public/brand/tokens/README.md` has
 * the one-liner. Until a file exists, or if one fails to load, this renders the
 * gradient initial it replaced, so a market without an icon is never a broken
 * image and a new listing never needs an icon to ship.
 *
 * Local files rather than a CDN on purpose: a logo that 404s or gets rate
 * limited is a broken row in a trading screen, and the terminal should not need
 * a third-party host to render its own market list.
 */
import { useEffect, useState } from "react";

export function TokenIcon({ symbol, size = 20, className = "" }: { symbol: string | undefined; size?: number; className?: string }) {
  const sym = (symbol ?? "").trim();
  const [failed, setFailed] = useState(false);

  // A new market must get its own chance to load. Otherwise the first missing
  // icon would poison every symbol rendered by the same element afterwards.
  useEffect(() => setFailed(false), [sym]);

  const box = { width: size, height: size };
  if (!sym || failed) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent to-up font-bold text-ink ${className}`}
        style={{ ...box, fontSize: Math.max(8, Math.round(size * 0.45)) }}
        aria-hidden
      >
        {sym.slice(0, 1).toUpperCase() || "·"}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/brand/tokens/${sym.toLowerCase()}.svg`}
      alt=""
      width={size}
      height={size}
      style={box}
      className={`shrink-0 rounded-full ${className}`}
      onError={() => setFailed(true)}
      aria-hidden
    />
  );
}
