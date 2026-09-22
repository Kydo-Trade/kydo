"use client";
/**
 * Interactive walkthrough (section 6.1) with anchored spotlighting: each step attaches
 * to the real UI element (amber glow + scroll-into-view) and the card docks
 * beside it. On the wrong page the card offers "Go to <page>" and re-anchors
 * after navigation. Auto-offered once to new visitors; resumable; dismissable;
 * restartable from /guide. Progress auto-checks from on-chain state.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isDefaultKey } from "@/lib/chain";
import { fromPrice, usd } from "@/lib/format";
import { usePlatform } from "@/lib/platform";

const KEY = "kydo.walkthrough"; // "offer" | "active:<n>" | "min:<n>" | "done" | "dismissed"

interface Ctx {
  wallet: boolean;
  status: string;
  hasPool: boolean;
  fee: string;
  floor: string;
}

const STEPS: { title: string; where: string; href: string; target: string; body: (c: Ctx) => string; done?: (c: Ctx) => boolean }[] = [
  { title: "Connect your wallet", where: "here", href: "/", target: "connect", body: () => "This is the Connect wallet button. Phantom or Solflare on devnet. No sign-up, no KYC.", done: (c) => c.wallet },
  { title: "Claim test USDC", where: "the Terminal", href: "/terminal", target: "account", body: (c) => `This Account panel holds your balances and the Claim USDC button. It drips test funds for the ${c.fee} entry fee and for seeding your pool later.` },
  { title: "Apply for the trial", where: "Home", href: "/", target: "primary-cta", body: (c) => `This is your journey's action button. It always shows your next move. Press Apply: the ${c.fee} fee goes to the treasury and your simulated trial starts immediately.`, done: (c) => c.status !== "none" && c.status !== "" },
  { title: "Trade the 30-day trial", where: "the Terminal", href: "/terminal", target: "ticket", body: () => "This is the order ticket. Pick a size and hit Buy / Long or Sell / Short. One click places the order. The pass criteria live on the Home status card as a checklist." },
  { title: "Commit roots & finalize", where: "Home", href: "/", target: "primary-cta", body: () => "Back on the action button: each trial day's merkle root goes on-chain so your record can't be rewritten. “Commit all” sweeps pending days in one approval, then Finalize trial.", done: (c) => c.status === "eligible" },
  { title: "Create & fund your pool", where: "Home", href: "/", target: "pool-form", body: (c) => `This form creates your pool. Name, mandate, target size. Afterwards “Seed ${c.floor} & activate” funds it with your own USDC in one click. Investor capital reaches you through the Common Pool, not by investors picking you.`, done: (c) => c.hasPool },
  { title: "Trade investor capital", where: "the Terminal", href: "/terminal", target: "ticket", body: () => "Same ticket, real stakes: you trade the pool's vault and can never withdraw it. Every order passes the on-chain guard. Tip: enable 1-Click Trading in the Account panel below." },
  { title: "Earn, vest, promote", where: "the Terminal", href: "/terminal", target: "account", body: () => "Your escrow shows here: 80% of each winning close vests over days, clawback-eligible until it does, claimable above the high-water mark. 30 positive live days promote your cap. Good luck!" },
];

export function Walkthrough() {
  const p = usePlatform();
  const path = usePathname();
  const [state, setState] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    try {
      setState(localStorage.getItem(KEY) ?? "offer");
    } catch {
      setState("dismissed");
    }
    const sync = () => {
      try {
        const v = localStorage.getItem(KEY);
        if (v) setState(v);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("kydo:walkthrough", sync);
    return () => window.removeEventListener("kydo:walkthrough", sync);
  }, []);
  const set = (v: string) => {
    setState(v);
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* private mode */
    }
  };

  const active = !!state && state.startsWith("active:");
  const idx = useMemo(() => Math.min(STEPS.length - 1, Math.max(0, Number((state ?? "").split(":")[1] ?? 0) || 0)), [state]);
  const step = STEPS[idx];

  // anchor to the target element: glow, scroll into view, dock the card beside it
  useEffect(() => {
    if (!active) return;
    let el: Element | null = null;
    const place = () => {
      el?.classList.remove("tour-target");
      el = document.querySelector(`[data-tour="${step.target}"]`);
      if (!el) {
        setAnchor(null);
        return;
      }
      el.classList.add("tour-target");
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) el.scrollIntoView({ block: "center", behavior: "smooth" });
      const CARD_W = 320;
      const CARD_H = 230;
      const rr = el.getBoundingClientRect();
      // prefer left of the target, else below, clamped to the viewport
      let x = rr.left - CARD_W - 16;
      let y = rr.top;
      if (x < 8) {
        x = Math.min(Math.max(8, rr.left), innerWidth - CARD_W - 8);
        y = rr.bottom + 12;
      }
      y = Math.min(Math.max(8, y), innerHeight - CARD_H - 8);
      setAnchor({ x, y });
    };
    place();
    const t = setInterval(place, 600);
    return () => {
      clearInterval(t);
      el?.classList.remove("tour-target");
      setAnchor(null);
    };
  }, [active, idx, step.target, path]);

  if (!state || state === "dismissed" || state === "done") return null;

  const ctx: Ctx = {
    wallet: !!p.wallet,
    status: p.status ?? "",
    hasPool: !!p.profile && !isDefaultKey(p.profile.activePool),
    fee: p.config ? usd(fromPrice(p.config.entryFee)) : "$800",
    floor: p.config ? usd(fromPrice(p.config.activationFloor)) : "$1,000",
  };

  if (state === "offer")
    return (
      <div className="fixed bottom-3 right-3 z-50 panel shadow-pop p-3 w-72 flex flex-col gap-2" role="dialog" aria-label="Walkthrough offer">
        <div className="font-sans text-sm font-semibold text-fg">New here? 👋</div>
        <p className="font-sans text-xs text-muted leading-relaxed">Take the 8-step walkthrough. It points at each control, from connecting a wallet to trading investor capital.</p>
        <div className="flex gap-1.5">
          <button className="btn btn-primary h-8 flex-1 font-semibold" onClick={() => set("active:0")}>
            Start walkthrough
          </button>
          <button className="btn h-8" onClick={() => set("dismissed")} aria-label="No thanks">
            ✕
          </button>
        </div>
      </div>
    );

  if (state.startsWith("min:"))
    return (
      <button className="fixed bottom-3 right-3 z-50 btn btn-primary h-8 shadow-pop font-semibold" onClick={() => set(`active:${idx}`)} aria-label="Resume walkthrough">
        Walkthrough · {idx + 1}/{STEPS.length}
      </button>
    );

  const onTargetPage = anchor !== null;
  const style = onTargetPage ? { left: anchor.x, top: anchor.y } : undefined;

  return (
    <div className={`fixed z-50 panel shadow-pop p-3.5 w-80 flex flex-col gap-2.5 border-amber/50 ${onTargetPage ? "" : "bottom-3 right-3"}`} style={style} role="dialog" aria-label={`Walkthrough step ${idx + 1}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-sans text-xxs uppercase tracking-wider text-muted">
          Walkthrough · {idx + 1} / {STEPS.length}
        </span>
        <span className="flex items-center gap-1">
          <button className="btn btn-ghost h-6 w-6 px-0 justify-center text-muted" onClick={() => set(`min:${idx}`)} title="Minimise" aria-label="Minimise">
            —
          </button>
          <button className="btn btn-ghost h-6 w-6 px-0 justify-center text-muted" onClick={() => set("dismissed")} title="Dismiss forever" aria-label="Dismiss">
            ✕
          </button>
        </span>
      </div>
      <div className="flex items-center gap-1" aria-hidden>
        {STEPS.map((st, i) => {
          const complete = st.done?.(ctx) ?? false;
          return <span key={i} className={`h-1 flex-1 rounded-full ${complete ? "bg-up" : i === idx ? "bg-amber" : i < idx ? "bg-line2" : "bg-panel3"}`} />;
        })}
      </div>
      <div className="flex items-baseline gap-2">
        <h3 className="font-sans text-sm font-semibold text-fg">{step.title}</h3>
        {step.done?.(ctx) && <span className="font-sans text-xxs text-up">done ✓</span>}
      </div>
      <p className="font-sans text-xs text-muted leading-relaxed">{step.body(ctx)}</p>
      <div className="flex items-center gap-1.5">
        {!onTargetPage && (
          <Link href={step.href} className="btn btn-primary h-8 px-3 font-semibold">
            Go to {step.where} →
          </Link>
        )}
        <span className="flex-1" />
        <button className="btn h-8 px-2.5" disabled={idx === 0} onClick={() => set(`active:${idx - 1}`)}>
          Back
        </button>
        <button className="btn h-8 px-2.5" onClick={() => (idx + 1 < STEPS.length ? set(`active:${idx + 1}`) : set("done"))}>
          {idx + 1 < STEPS.length ? "Next" : "Finish"}
        </button>
      </div>
    </div>
  );
}
