"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { KydoWordmark } from "./brand/Kydo";
import { ConnectButton, WalletBalances } from "@kydo/ui";
import { NETWORK } from "@/lib/config";
import { shortAddr } from "@/lib/format";
import { traderMode } from "@/lib/mode";
import { usePlatform } from "@/lib/platform";
import { useLiveFeed } from "@/lib/ws";

/**
 * Header. "Dev Ready" nav bar (Figma 40:79808 signed out /
 * 40:79809 connected). 1440×104: 56 px bar with 24 px above and below.
 *
 *   left    wordmark + Trade/Invest segmented control
 *   centre  Terminal · Rulebook · Account
 *   right   account pill (lime "Connect Wallet" when signed out)
 *
 * The design draws no mode badge, balances or theme toggle in this row. Two of
 * those were features, not decoration, so they are kept in the shapes the
 * design does have: the balance segment sits inside the account container
 * (every frame after the nav ones shows it), and service health collapses to a
 * single dot beside it. A degraded indexer or a paused platform changes what
 * every number on the page means, so it cannot live only in a sub-page.
 *
 * Both are *exception-only*: the dot renders nothing while every service is
 * healthy, and SOL appears only once it is running out. At rest the row is the
 * design as drawn; it grows a warning exactly when there is something to warn
 * about. Trial export and Admin live in the account menu.
 */

/** Persona switch. Both chips are a fixed 118 px in the design. */
const personas = [
  { href: "/terminal", label: "Trade", match: (p: string) => p.startsWith("/terminal") || p.startsWith("/trial") },
  { href: "/invest", label: "Invest", match: (p: string) => p.startsWith("/invest") },
];

const links = [
  { href: "/terminal", label: "Terminal" },
  { href: "/guide", label: "Rulebook" },
  { href: "/", label: "Account" },
];

export function Header() {
  const path = usePathname();
  const { status, profile, wallet, config } = usePlatform();
  const mode = traderMode(status, profile);
  const tier = profile && profile.tier > 0 ? profile.tier : 0;
  const isAdmin = !!wallet && !!config?.admin && wallet.equals(config.admin);
  // Instant-funded traders have no trial log. Hide the export link from their menu.
  const instant = !!profile && Number((profile.instantCap ?? 0).toString()) > 0;

  return (
    <header className="shrink-0 bg-bg">
      {/* 104 px is the design's bar. Below lg the row sheds furniture rather than
          overflowing: the persona chips lose their fixed 118 px, the centre nav
          moves under the bar as a strip, and the balance segment drops. It is a
          convenience, and the Account page carries it. */}
      <div className="mx-auto flex h-[72px] max-w-[1312px] items-center justify-between gap-3 px-4 md:gap-6 md:px-6 lg:h-[104px]">
        {/* ---- left: wordmark + persona switch ---- */}
        <div className="flex shrink-0 items-center gap-2">
          <Link href="/" aria-label="Kydo home" className="rounded-sm">
            <Wordmark />
          </Link>

          <div
            role="tablist"
            aria-label="Persona"
            className="relative flex items-center gap-1 overflow-clip rounded-full border border-fig-stroke bg-fig-bg-additional p-1 shadow-[inset_0_6px_16px_0_rgba(0,0,0,0.16)]"
          >
            {personas.map((p) => {
              const active = p.match(path);
              return (
                <Link
                  key={p.href}
                  href={p.href}
                  role="tab"
                  aria-selected={active}
                  className={`flex h-8 items-center justify-center rounded-full border px-4 py-1 text-h11 font-medium transition-colors lg:w-[118px] lg:px-2 ${
                    active
                      ? "border-fg bg-fig-bg-500 text-fig-text-950"
                      : "border-transparent bg-fig-bg-800 text-fig-text-600 hover:text-fg"
                  }`}
                >
                  {p.label}
                </Link>
              );
            })}
          </div>
        </div>

        {/* ---- centre: primary nav ---- */}
        <nav className="hidden items-center gap-8 lg:flex" aria-label="Primary">
          {links.map((l) => {
            const active = path === l.href;
            return (
              <Link
                key={l.label}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap text-h9 font-medium transition-colors ${
                  active ? "text-fg" : "text-fg/70 hover:text-fg"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        {/* ---- right: service dot + account cluster ----
            The wrapper is the design's "Header" frame: 4 px of padding around
            the pill, gradient only once there is an account to show. The newer
            frames (terminal 121:143625, Investor 40:63788, onboarding
            97:62037) put a balance segment beside the account pill.
            "Live $2,000.00". Inside the same container. */}
        <div className="flex shrink-0 items-center gap-2">
          <StatusPopover />
          <div
            className={`flex shrink-0 items-center gap-1 rounded-[52px] p-1 ${
              wallet ? "bg-gradient-to-t from-fig-bg-pattern-900 to-fig-bg-600" : ""
            }`}
            data-tour="connect"
          >
            {wallet && (
              <>
                <span className="hidden items-center gap-2 pl-4 pr-3 md:flex">
                  {mode !== "none" && (
                    <span
                      className={`text-h11 font-medium ${mode === "live" ? "text-up" : "text-amber"}`}
                      title={
                        mode === "live"
                          ? `Trading investor capital on-chain${tier ? ` · Tier ${tier}` : ""}`
                          : "30-day simulated trial under live risk limits"
                      }
                    >
                      {mode === "live" ? (tier ? `Live · T${tier}` : "Live") : "Trial"}
                    </span>
                  )}
                  <WalletBalances usdcMint={process.env.NEXT_PUBLIC_USDC_MINT} only="usdc" warnLowSolBelow={0.01} size="sm" />
                </span>
                <span className="hidden h-6 w-px shrink-0 bg-fig-stroke md:block" aria-hidden />
              </>
            )}
            <ConnectButton
              size="lg"
              label="Connect Wallet"
              menuExtras={
                <>
                  {!instant && (
                    <Link href="/trial/export" role="menuitem">
                      Trial export
                    </Link>
                  )}
                  {isAdmin && (
                    <Link href="/admin" role="menuitem">
                      Admin
                    </Link>
                  )}
                </>
              }
            />
          </div>
        </div>
      </div>

      {/* The nav the bar drops below lg. A strip rather than a menu: three
          destinations do not need a disclosure, and one tap beats two. */}
      <nav className="flex items-center gap-1 overflow-x-auto px-4 pb-2 lg:hidden" aria-label="Primary">
        {links.map((l) => {
          const active = path === l.href;
          return (
            <Link
              key={l.label}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={`shrink-0 rounded-full px-4 py-2 text-h11 font-medium transition-colors ${active ? "bg-fig-bg-500 text-fig-text-950" : "bg-fig-bg-800 text-fig-text-600"}`}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

/**
 * One dot summarising chain / indexer / trial engine / platform; details on
 * hover, focus or click. Styled as the design's 32 px inset circle so it reads
 * as part of the nav bar rather than as a leftover control.
 *
 * Renders nothing while everything is online. The design's row has no such
 * control, and a permanently green dot is noise. The trade-off is that a
 * healthy platform and a broken health check look the same; the Account page
 * is where to go for an explicit all-clear.
 */
function StatusPopover() {
  const { indexerOnline, trialOnline, chainError, status, profile, wallet, config } = usePlatform();
  const { status: ws } = useLiveFeed();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const level: "ok" | "warn" | "bad" = chainError || !indexerOnline ? "bad" : !trialOnline || ws !== "open" ? "warn" : "ok";
  const dot = level === "warn" ? "bg-amber" : "bg-down";
  const summary = level === "ok" ? "All services online" : level === "warn" ? "Degraded. Some services offline" : chainError ? "Chain unreachable" : "Indexer offline";
  const rows: { label: string; value: string; tone: "up" | "down" | "amber" | "muted" }[] = [
    { label: "Chain", value: chainError ? "platform not initialised" : `${NETWORK} · program ok`, tone: chainError ? "down" : "up" },
    { label: "Indexer", value: indexerOnline ? (ws === "open" ? "online · websocket live" : "online · polling") : "offline. Using chain fallbacks", tone: indexerOnline ? (ws === "open" ? "up" : "amber") : "down" },
    { label: "Trial engine", value: trialOnline ? "online" : "offline", tone: trialOnline ? "up" : status === "trial" ? "down" : "muted" },
    { label: "Platform", value: config ? (config.paused ? "PAUSED by admin" : "active") : "loading…", tone: config?.paused ? "down" : config ? "up" : "muted" },
  ];
  if (wallet) rows.push({ label: "Trader", value: `${status}${profile && profile.tier > 0 ? ` · Tier ${profile.tier}` : ""} · ${shortAddr(wallet.toBase58())}`, tone: "muted" });
  if (level === "ok") return null;
  return (
    <div className="relative" ref={ref} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="flex size-8 items-center justify-center rounded-full border border-fig-stroke bg-fig-bg-additional shadow-[inset_0_6px_16px_0_rgba(0,0,0,0.16)] transition-colors hover:border-fg/40"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Service status: ${summary}`}
        title={summary}
        onClick={() => setOpen((o) => !o)}
        onFocus={() => setOpen(true)}
      >
        <span className={`dot ${dot}`} aria-hidden />
      </button>
      {open && (
        <div className="popover right-0 z-50" role="dialog" aria-label="Service status">
          <div className="label mb-1.5">{summary}</div>
          <div className="flex flex-col gap-1">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center gap-2">
                <span className={`dot ${r.tone === "up" ? "bg-up" : r.tone === "down" ? "bg-down" : r.tone === "amber" ? "bg-amber" : "bg-muted"}`} aria-hidden />
                <span className="w-20 shrink-0 text-h11 text-fig-text-600">{r.label}</span>
                <span className={`num truncate text-h11 ${r.tone === "down" ? "text-down" : r.tone === "amber" ? "text-amber" : "text-fg"}`} title={r.value}>
                  {r.value}
                </span>
              </div>
            ))}
          </div>
          {chainError && <div className="mt-2 text-h11 text-down break-words">{chainError}</div>}
        </div>
      )}
    </div>
  );
}

/**
 * The wordmark. Drawn rather than loaded: an `<img>` that 404s until someone
 * remembers to export an asset is how the old one spent its life showing a
 * text fallback. The mark is vector geometry in `components/brand/Kydo`, so
 * there is nothing to forget to ship.
 */
function Wordmark() {
  return <KydoWordmark size={30} />;
}
