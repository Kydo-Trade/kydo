import type { Config } from "tailwindcss";

/**
 * Terminal design tokens. Colours mirror the `--kydo-*` variables in
 * app/globals.css so Tailwind utilities and the shared @kydo/ui primitives
 * render from one palette.
 *
 *   surfaces   bg → panel → panel2 → panel3 (each one step lighter)
 *   line       single border colour everywhere
 *   text       fg (values) · muted (labels)
 *   semantic   up / down / amber / accent
 *   radius     sm 4 · DEFAULT 6 · md 8 · lg 12
 *   type       xxs 10 · xs 12 · sm 13 · base 14 · lg 16 · xl 20
 *   spacing    Tailwind 4 px scale (1 = 4, 2 = 8, 3 = 12, 4 = 16)
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        /* Theme-driven (bulk-style light/dark): RGB triplets live in globals.css
           (:root, dark-only. The design has no light theme) so Tailwind opacity modifiers keep working. */
        bg: "rgb(var(--t-bg) / <alpha-value>)",
        panel: "rgb(var(--t-panel) / <alpha-value>)",
        panel2: "rgb(var(--t-panel2) / <alpha-value>)",
        panel3: "rgb(var(--t-panel3) / <alpha-value>)",
        line: "rgb(var(--t-line) / <alpha-value>)",
        line2: "rgb(var(--t-line2) / <alpha-value>)",
        muted: "rgb(var(--t-muted) / <alpha-value>)",
        fg: "rgb(var(--t-fg) / <alpha-value>)",
        up: "rgb(var(--t-up) / <alpha-value>)",
        down: "rgb(var(--t-down) / <alpha-value>)",
        amber: "rgb(var(--t-amber) / <alpha-value>)",
        /* accent is now the Figma lime (Main Color/500), no longer an alias of amber */
        accent: "rgb(var(--t-accent) / <alpha-value>)",
        ink: "rgb(var(--t-ink) / <alpha-value>)" /* text on lime/green fills */,

        /* Figma ramps, for the cases the semantic slots above don't cover
           (hover/pressed steps, tinted backgrounds). Prefer the semantic
           names; reach for these only when a design calls for a specific step. */
        "fig-main": {
          200: "var(--fig-main-200)",
          300: "var(--fig-main-300)",
          400: "var(--fig-main-400)",
          500: "var(--fig-main-500)",
          600: "var(--fig-main-600)",
          700: "var(--fig-main-700)",
        },
        "fig-green": {
          100: "var(--fig-green-100)",
          200: "var(--fig-green-200)",
          300: "var(--fig-green-300)",
          500: "var(--fig-green-500)",
          600: "var(--fig-green-600)",
          700: "var(--fig-green-700)",
          950: "var(--fig-green-950)",
        },
        "fig-red": {
          200: "var(--fig-red-200)",
          300: "var(--fig-red-300)",
          400: "var(--fig-red-400)",
        },
        "fig-bg": {
          500: "var(--fig-bg-500)",
          600: "var(--fig-bg-600)",
          700: "var(--fig-bg-700)",
          750: "var(--fig-bg-750)",
          800: "var(--fig-bg-800)",
          900: "var(--fig-bg-900)",
          950: "var(--fig-bg-950)",
          additional: "var(--fig-bg-additional)",
          "pattern-900": "var(--fig-bg-pattern-900)",
        },
        "fig-text": {
          500: "var(--fig-text-500)",
          550: "var(--fig-text-550)",
          600: "var(--fig-text-600)",
          700: "var(--fig-text-700)",
          800: "var(--fig-text-800)",
          900: "var(--fig-text-900)",
          950: "var(--fig-text-950)",
        },
        /* Unbound stroke colour used on the nav bar's pills. Not a Figma
           variable. A raw hex in the design, sitting between Text/900 and
           Text/800. Kept as its own token so it is findable if it ever gets
           promoted to a real variable. */
        "fig-stroke": "var(--fig-stroke)",
      },
      fontFamily: {
        sans: ["var(--kydo-font)"],
        mono: ["var(--kydo-mono)"],
      },
      /* The design has one radius language: 24 px cards, 20 px panels, 16 px
         inset boxes, 12 px chips, and pills for anything interactive. Tailwind's
         defaults (2/4/6/8/12/16) are all a step or two too tight, so the aliases
         are remapped rather than chased through ~100 call sites. A legacy
         `rounded-md` box now reads as part of the same system. */
      borderRadius: {
        sm: "6px",
        DEFAULT: "8px",
        md: "12px",
        lg: "16px",
        xl: "20px",
        "2xl": "24px",
        "3xl": "32px",
      },
      fontSize: {
        /* Hyperliquid-sized: 13 px body, 11 px labels. One step up from the old MT5 density */
        /* Remapped onto the Figma scale: the design
           uses 10 / 12 / 14 / 16 / 20 / 24 and nothing in between, so the
           existing aliases now resolve to those steps instead of the old
           11 / 13 / 15 / 18 / 22. Line-heights stay proportional. The design's
           lineHeight 1 is for single-line labels, available as `leading-none`. */
        xxs: ["10px", "14px"],
        xs: ["12px", "16px"],
        sm: ["14px", "20px"],
        base: ["16px", "24px"],
        lg: ["20px", "28px"],
        xl: ["24px", "32px"],

        /* Figma type scale (H-steps). Added alongside the existing xs/sm/base
           rather than replacing them. The terminal's dense tables are built on
           13px `xs` and swapping that globally would reflow every panel.
           Adopt these per screen as you port. Line-height 1 matches the Figma
           single-line styles; pair with `leading-double` for the 1.2 variants. */
        h11: ["12px", "1"],
        h10: ["14px", "1"],
        h9: ["16px", "1"],
        h8: ["20px", "1"],
        h7: ["24px", "1"],
        h6: ["28px", "1"],
        h5: ["32px", "1"],
        h4: ["36px", "1"],
        h2: ["44px", "1"],
        h1: ["48px", "1"],
      },
      lineHeight: {
        /* Figma "Double Line" text styles */
        double: "1.2",
      },
      boxShadow: {
        pop: "0 12px 32px rgba(0, 0, 0, 0.45)",
      },
    },
  },
  plugins: [],
};

export default config;
