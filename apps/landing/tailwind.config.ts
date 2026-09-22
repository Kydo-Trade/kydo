import type { Config } from "tailwindcss";

/**
 * Landing tokens. The terminal's 2026-09-03 build-spec set (section 5.1 of
 * the landing design spec), dark-only like the product.
 * Static hexes on purpose: this app has no theme toggle and no @kydo/ui dependency.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      /* Palette mirrors the Figma variables.
         Static hexes on purpose: this app has no theme toggle and no @kydo/ui
         dependency, so it can't read the terminal's --t-* custom properties. */
      colors: {
        bg: "#0e0e0e", // BG/950
        panel: "#161616", // BG/900
        panel2: "#202020", // BG/700
        panel3: "#232323", // BG/750
        line: "#2c2c2c", // Text/900
        line2: "#404040", // Text/800
        muted: "#8d8d8d", // Text/550
        fg: "#f8f8f8", // Text/500
        up: "#00d05b", // Green/600
        down: "#ff5f2e", // Red/400
        amber: "#ffdd00", // Yellow/Main Color
        "amber-hi": "#ffdd00",
        accent: "#b7ff00", // Main Color/500. "Main Button"
        "accent-hi": "#c4ff2e", // Main Color/400, hover
        ink: "#0e0e0e", // Text/950. Text on lime/green fills
        "fig-main": {
          200: "#deff8a",
          300: "#d1ff5c",
          400: "#c4ff2e",
          500: "#b7ff00",
          600: "#9ad600",
          700: "#7cad00",
        },
      },
      fontFamily: {
        /* Geist per the Figma type styles; the existing next/font vars stay as
           fallbacks until `geist` is installed and wired into app/layout.tsx. */
        sans: ["Geist", "var(--font-geist-sans)", "var(--font-inter)", "system-ui", "sans-serif"],
        mono: [
          "Geist Mono",
          "var(--font-geist-mono)",
          "var(--font-jetbrains)",
          "ui-monospace",
          "monospace",
        ],
      },
      fontSize: {
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

        /* Figma H-steps. Same set as the terminal. */
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
        double: "1.2",
      },
      borderRadius: {
        sm: "4px",
        DEFAULT: "6px",
        md: "8px",
        lg: "12px",
      },
    },
  },
  plugins: [],
};

export default config;
