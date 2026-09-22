import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "@kydo/ui/styles.css"; // shared wallet UI + primitives (toasts, stepper, pills). Imported first so globals.css token overrides win
import "./globals.css";
import { Providers } from "./providers";
import { BootSplash } from "@/components/BootSplash";
import { Header } from "@/components/Header";
import { Walkthrough } from "@/components/Walkthrough";

export const metadata: Metadata = {
  title: "Kydo. On-chain funded trading",
  description: "Trade investor capital on Solana. Prove yourself on a trial or fund instantly, keep 80% of the profits, and never touch the principal.",
  icons: {
    // Inline so the mark ships with the app instead of depending on an asset
    // someone has to remember to export. The previous wordmark spent its life
    // showing a text fallback for exactly that reason.
    icon: [
      {
        url:
          "data:image/svg+xml," +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
              '<path d="M0 0 H100 V100 H79 L70 26 L0 13 Z" fill="#527b2f"/>' +
              '<path d="M0 40 L47 38 L0 74 Z" fill="#8da750"/>' +
              '<path d="M26 100 L57 48 L60 100 Z" fill="#8da750"/>' +
              "</svg>",
          ),
        type: "image/svg+xml",
      },
    ],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Read at REQUEST time, not build time. `next start` runs a server, so this is
  // not inlined into the client bundle the way NEXT_PUBLIC_* is: the host can
  // point the browser at a domain-restricted RPC key by setting RPC_URL and
  // restarting. No rebuild, and nothing keyed committed to the repo. Falls back
  // to the build-time public endpoint, which is what the admin panel's
  // "Wallet RPC" row will show if the host never set it.
  const rpcUrl = process.env.RPC_URL || process.env.NEXT_PUBLIC_RPC_URL || "https://api.devnet.solana.com";
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className="h-screen flex flex-col bg-bg text-fg overflow-hidden">
        <Providers rpcUrl={rpcUrl}>
          <BootSplash />
          <Header />
          {/* no padding here. Pages own their gutter via `.page` (or, for the
              terminal, its own wider one), so every screen lines up with the nav. */}
          <main className="flex-1 min-h-0 overflow-auto">{children}</main>
          <Walkthrough />
        </Providers>
      </body>
    </html>
  );
}
