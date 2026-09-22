"use client";
/**
 * The Kydo mark and wordmark.
 *
 * Rebuilt as vector geometry from the supplied raster. The .svg did not reach
 * this session, so if you have the original, drop it in and replace `KydoMark`
 * with it; the colours and the sizing contract here are what the app depends on.
 *
 * The mark is a perspective form: a solid green upright, and two lighter wedges
 * converging on the same vanishing point. A road narrowing toward a horizon,
 * which is the right idea for a product about a track record you build over
 * time. It is drawn on a 100×100 grid so it scales cleanly to a 16 px favicon
 * and a 96 px hero alike.
 *
 * `--kydo-deep` and `--kydo-sage` are the mark's own colours and are NOT the UI
 * accent: the deep green carries 3.89:1 against the ink glyph, under what a
 * button label needs. See the note in globals.css.
 */
export function KydoMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={`shrink-0 ${className}`} role="img" aria-label="Kydo">
      {/* the solid upright, tapering to the vanishing point */}
      <path d="M0 0 H100 V100 H79 L70 26 L0 13 Z" fill="var(--kydo-deep, #527b2f)" />
      {/* upper wedge */}
      <path d="M0 40 L47 38 L0 74 Z" fill="var(--kydo-sage, #8da750)" />
      {/* lower wedge */}
      <path d="M26 100 L57 48 L60 100 Z" fill="var(--kydo-sage, #8da750)" />
    </svg>
  );
}

/** Mark plus name, for the nav bar and anywhere the product signs itself. */
export function KydoWordmark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <KydoMark size={size} />
      <span className="font-sans font-semibold tracking-tight text-fg" style={{ fontSize: size * 0.82, lineHeight: 1 }}>
        Kydo
      </span>
    </span>
  );
}
