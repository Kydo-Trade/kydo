/**
 * Chart colours.
 *
 * The charting libraries (lightweight-charts, TradingView) take colours as
 * plain strings, so they can't read the `--t-*` / `--fig-*` custom properties
 * the rest of the UI styles from. These constants are the bridge: the same
 * Figma palette, written out as hex.
 *
 * Keep in step with the design token reference: if a token changes there, change
 * it here too, or the charts drift back out of the design.
 */

/** Dark theme. The Figma palette (docs/design/figma-tokens.json). */
export const CHART_DARK = {
  bg: "#161616", // BG/900. The panel the chart sits in
  text: "#8d8d8d", // Text/550. Axis labels
  grid: "#2c2c2c", // Text/900
  border: "#2c2c2c", // Text/900
  labelBg: "#404040", // Text/800
  labelText: "#0e0e0e", // Text/950. On a bright label
  cross: "#6e6e6e", // Text/700
} as const;

/** Series colours. Identical in both themes, as in the design. */
export const CHART_UP = "#00d05b"; // Green/600
export const CHART_DOWN = "#ff5f2e"; // Red/400
export const CHART_CLOSE = "#ffdd00"; // Yellow/Main Color. Position-close markers
export const CHART_MARK = "#8d8d8d"; // Text/550. Oracle mark line
export const CHART_ACCENT = "#b7ff00"; // Main Color/500. Indicators, equity curve

/** Geist Mono per the design's "Numb" text styles. */
export const CHART_FONT = "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace";
/** The design sets table and axis numerals at 10 px. */
export const CHART_FONT_SIZE = 10;
