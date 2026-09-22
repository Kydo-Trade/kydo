"use client";
/**
 * The landing page.
 * visual direction 1a of the canvas in apps/design/UI mockups for form design.
 * Copy states what the program enforces: platform parameters render live from
 * the indexer's /config (falling back to the spec values in config/platform.jsonc),
 * stats degrade to "—" without layout shift, and nothing is fabricated (section 8).
 * CTAs route into the terminal app (section 7).
 */
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { type ConfigJson, indexer, SPEC_CONFIG } from "@/lib/api";
import { dur, explorerAddrUrl, NETWORK, pct, price, PROGRAM_ID, TERMINAL_URL, usd, usdWhole } from "@/lib/config";

/* ---------------- reveal-on-scroll (no-op under prefers-reduced-motion) ---------------- */

function Reveal({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          el.classList.add("in");
          io.disconnect();
        }),
      { rootMargin: "0px 0px -10% 0px", threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`landing-rev ${className}`} style={{ "--d": `${delay}ms` } as CSSProperties}>
      {children}
    </div>
  );
}

/* ---------------- live data (section 4.2: real numbers or "—", never fabricated) ---------------- */

function useLandingStats() {
  const [pools, setPools] = useState<{ live: number; tvl: number } | null>(null);
  const [markets, setMarkets] = useState<number | null>(null);
  const [markTs, setMarkTs] = useState<number | null>(null); // unix ms of the freshest oracle price
  const [now, setNow] = useState(0);

  useEffect(() => {
    let alive = true;
    const loadSlow = () => {
      indexer
        .pools()
        .then((r) => alive && setPools({ live: r.pools.filter((p) => p.status === "live" || p.status === "funding").length, tvl: r.pools.reduce((a, p) => a + p.tvl, 0) }))
        .catch(() => alive && setPools(null));
      indexer
        .markets()
        .then((r) => alive && setMarkets(r.markets.filter((m) => m.enabled).length))
        .catch(() => alive && setMarkets(null));
    };
    const loadMark = () => {
      indexer
        .prices()
        .then((r) => {
          if (!alive) return;
          const ts = Math.max(0, ...Object.values(r).map((p) => p.ts));
          setMarkTs(ts > 0 ? (ts > 1e12 ? ts : ts * 1000) : null);
        })
        .catch(() => alive && setMarkTs(null));
    };
    loadSlow();
    loadMark();
    const slow = setInterval(loadSlow, 30_000);
    const fast = setInterval(loadMark, 10_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      alive = false;
      clearInterval(slow);
      clearInterval(fast);
      clearInterval(tick);
    };
  }, []);

  const markAge = markTs === null ? null : Math.max(0, Math.round(((now || Date.now()) - markTs) / 1000));
  return { live: pools?.live ?? null, tvl: pools?.tvl ?? null, markets, markAge };
}

/** The parameters the program enforces: live /config when reachable, spec values otherwise. */
function usePlatformConfig() {
  const [cfg, setCfg] = useState<ConfigJson>(SPEC_CONFIG);
  const [liveCfg, setLiveCfg] = useState(false);
  useEffect(() => {
    let alive = true;
    indexer
      .config()
      .then((c) => {
        if (!alive) return;
        setCfg(c);
        setLiveCfg(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return { cfg, liveCfg };
}

function useMarketPrices() {
  const [rows, setRows] = useState<{ symbol: string; price: number | null; lev: string }[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      indexer
        .markets()
        .then((r) => alive && setRows(r.markets.filter((m) => m.enabled).map((m) => ({ symbol: m.symbol, price: m.price?.price ?? null, lev: `${Math.round(m.maxLeverageBps / 10000)}×` }))))
        .catch(() => alive && setRows(null));
    load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return rows;
}

/* ---------------- hero visual: real capture if present, else a live chart ---------------- */

function HeroCapture() {
  // Probe for the capture off-DOM: an SSR'd <img> that 404s before hydration never
  // fires React's onError, so the broken-image glyph would stick.
  const [mode, setMode] = useState<"probe" | "img" | "chart">("probe");
  useEffect(() => {
    const probe = new Image();
    probe.onload = () => setMode("img");
    probe.onerror = () => setMode("chart");
    probe.src = "/terminal.png";
  }, []);
  return (
    <div className="relative h-60 md:h-72 lg:h-[340px] rounded border border-line bg-panel2 overflow-hidden" aria-label="Terminal preview">
      {mode === "img" && (
        // eslint-disable-next-line @next/next/no-img-element -- static capture with live-chart fallback
        <img src="/terminal.png" alt="The Kydo trader terminal" className="w-full h-full object-cover object-left-top" />
      )}
      {mode === "chart" && <LiveMiniChart />}
    </div>
  );
}

/** Real candles from the indexer drawn as a single line. Live data, never a fake UI (section 4.1). */
function LiveMiniChart() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [meta, setMeta] = useState<{ symbol: string; last: number; up: boolean } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { markets } = await indexer.markets();
        const market = markets[0];
        if (!market) throw new Error("no markets");
        const { candles } = await indexer.candles(market.marketId, "15m", 192);
        if (!alive || candles.length < 2) throw new Error("no candles");
        const closes = candles.map((c) => c.close);
        const last = closes[closes.length - 1];
        const rising = last >= closes[0];
        setMeta({ symbol: market.symbol, last, up: rising });

        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.scale(dpr, dpr);

        const tone = rising ? "44 185 131" : "228 102 108"; // --up / --down
        const min = Math.min(...closes);
        const max = Math.max(...closes);
        const pad = 18;
        const x = (i: number) => (i / (closes.length - 1)) * w;
        const y = (v: number) => (max === min ? h / 2 : pad + (1 - (v - min) / (max - min)) * (h - pad * 2));

        ctx.strokeStyle = "rgb(40 49 60 / 0.5)"; // --line
        ctx.lineWidth = 1;
        for (let g = 1; g < 4; g++) {
          ctx.beginPath();
          ctx.moveTo(0, (h / 4) * g);
          ctx.lineTo(w, (h / 4) * g);
          ctx.stroke();
        }
        const area = ctx.createLinearGradient(0, 0, 0, h);
        area.addColorStop(0, `rgb(${tone} / 0.18)`);
        area.addColorStop(1, `rgb(${tone} / 0)`);
        ctx.beginPath();
        closes.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
        ctx.strokeStyle = `rgb(${tone})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.fillStyle = area;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x(closes.length - 1), y(last), 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgb(${tone})`;
        ctx.fill();
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (failed)
    return (
      <div className="w-full h-full flex items-center justify-center">
        <span className="eyebrow">Live preview unavailable</span>
      </div>
    );
  return (
    <>
      <canvas ref={canvasRef} className="w-full h-full" aria-hidden />
      {meta && (
        <div className="absolute top-3 left-3 flex items-baseline gap-2">
          <span className="font-mono text-xs font-medium text-fg">{meta.symbol}</span>
          <span className={`num text-xs ${meta.up ? "text-up" : "text-down"}`}>{usd(meta.last)}</span>
          <span className="eyebrow">15m · live oracle</span>
        </div>
      )}
    </>
  );
}

/* ---------------- small pieces ---------------- */

function NetworkPill() {
  return <span className="font-mono text-[10px] font-medium tracking-wider uppercase text-amber border border-line2 rounded-sm px-1.5 py-0.5">{NETWORK}</span>;
}

function Brand() {
  return (
    <span className="font-sans text-sm font-semibold text-fg">
      Kydo
    </span>
  );
}

function Stat({ label, value, suffix }: { label: string; value: string | null; suffix?: string }) {
  return (
    <div className="md:border-l md:border-line md:pl-4 md:first:border-l-0 md:first:pl-0">
      <div className="eyebrow">{label}</div>
      <div className="num text-xl md:text-[26px] md:leading-8 font-semibold text-fg mt-1">
        {value ?? "—"}
        {suffix && <span className="text-sm text-muted font-normal"> {suffix}</span>}
      </div>
    </div>
  );
}

function StageCard({ n, tag, figure, body }: { n: string; tag: string; figure: string; body: React.ReactNode }) {
  return (
    <div className="border border-line rounded bg-panel p-4 transition-colors hover:border-line2 hover:bg-panel2">
      <div className="font-mono text-xxs font-medium tracking-wider text-amber">
        {n} · {tag}
      </div>
      <div className="num text-xl font-semibold text-fg mt-3">{figure}</div>
      <p className="text-xs text-muted leading-relaxed mt-1.5">{body}</p>
    </div>
  );
}

function Feature({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="border border-line rounded bg-panel p-5 transition-colors hover:border-line2 hover:bg-panel2">
      <h3 className="font-sans text-sm font-semibold text-fg">{title}</h3>
      <p className="mt-2 text-xs text-muted leading-relaxed">{body}</p>
    </div>
  );
}

function Rule({ label, value, tone }: { label: string; value: string; tone?: "down" }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-2.5 border-b border-line/60 last:border-b-0">
      <span className="text-sm text-muted">{label}</span>
      <span className={`num text-sm ${tone === "down" ? "text-down" : "text-fg"}`}>{value}</span>
    </div>
  );
}

function Receipt({ label, value, href, link, mono }: { label: string; value: string; href: string; link: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr_auto] gap-x-6 gap-y-1 items-baseline py-4 border-b border-line transition-colors hover:bg-panel/60">
      <div className="text-sm text-muted">{label}</div>
      <div className={`${mono ? "num break-all" : ""} text-sm text-fg`}>{value}</div>
      <a href={href} target="_blank" rel="noreferrer" className="font-mono text-xxs font-medium tracking-wider text-amber hover:text-fg transition-colors">
        {link} ↗
      </a>
    </div>
  );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group border-b border-line open:bg-panel/60 transition-colors">
      <summary className="flex items-baseline justify-between gap-6 py-4 cursor-pointer list-none select-none text-base text-fg [&::-webkit-details-marker]:hidden hover:text-amber transition-colors">
        <span>{q}</span>
        <span className="num text-muted group-open:hidden" aria-hidden>
          +
        </span>
        <span className="num text-amber hidden group-open:inline" aria-hidden>
          −
        </span>
      </summary>
      <p className="pb-4 text-sm text-muted leading-relaxed max-w-[68ch]">{children}</p>
    </details>
  );
}

const Num = ({ children }: { children: React.ReactNode }) => <span className="num text-fg">{children}</span>;

/* ---------------- the page ---------------- */

const SECTION = "w-full max-w-[1120px] mx-auto px-5 md:px-10 lg:px-16";

export function Landing() {
  const { live, tvl, markets, markAge } = useLandingStats();
  const { cfg, liveCfg } = usePlatformConfig();
  const tickers = useMarketPrices();
  const [copied, setCopied] = useState(false);
  const copyProgram = () => {
    navigator.clipboard?.writeText(PROGRAM_ID).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => {},
    );
  };

  const fee = usdWhole(cfg.entryFee);
  const simBalance = usdWhole(cfg.trial.startingBalance);
  const caps = cfg.tierCaps.map(usdWhole);
  const vest = cfg.vestDays.join("/");

  return (
    <div className="flex flex-col min-h-screen bg-bg">
      {/* mockup 1a nav: links stay inline on every width (no hamburger), wrapping to a second row on phones */}
      <nav className="border-b border-line" aria-label="Primary">
        <div className={`${SECTION} min-h-[52px] md:h-[60px] py-2 md:py-0 flex flex-wrap items-center gap-x-3 gap-y-2`}>
          <Brand />
          <NetworkPill />
          <span className="flex-1" />
          <div className="flex items-center gap-4 md:gap-5 text-xs order-last w-full justify-end md:order-none md:w-auto">
            <a href="#traders" className="text-muted hover:text-fg transition-colors">
              Traders
            </a>
            <a href="#investors" className="text-muted hover:text-fg transition-colors">
              Investors
            </a>
            <a href={`${TERMINAL_URL}/guide`} className="text-muted hover:text-fg transition-colors">
              Rulebook
            </a>
          </div>
          <a href={TERMINAL_URL} className="btn h-8 px-3.5 text-xs font-semibold border-line bg-panel2 hover:bg-panel3 hover:border-line2 hover:text-fg">
            Launch terminal
          </a>
        </div>
      </nav>

      {/* ================= section 4.1 hero ================= */}
      <section className="relative landing-grid border-b border-line overflow-hidden" aria-label="Introduction">
        <div className={`${SECTION} py-16 lg:py-24 grid lg:grid-cols-2 gap-10 lg:gap-14 items-center`}>
          <Reveal>
            <div className="eyebrow mb-5">On-chain funded trading</div>
            <h1 className="font-sans text-h6 leading-[34px] md:text-4xl lg:text-h2 lg:leading-[52px] font-bold tracking-tight text-fg [text-wrap:balance]">
              Prove yourself in 30 days. Get funded on-chain.
            </h1>
            <p className="mt-5 text-base text-muted leading-relaxed max-w-[60ch]">
              A prop-trading platform on Solana. Traders pass a fully logged simulated trial, investors fund them through a program-owned vault, and an on-chain risk
              guard locks the pool when a loss limit is breached.
            </p>
            <div className="flex flex-wrap items-center gap-3 mt-8">
              <a href={TERMINAL_URL} className="btn btn-primary">
                Start the trial
              </a>
              <a href={`${TERMINAL_URL}/invest`} className="btn">
                Explore pools
              </a>
            </div>
          </Reveal>
          <Reveal delay={120}>
            <HeroCapture />
          </Reveal>
        </div>
      </section>

      {/* ================= section 4.2 proof strip ================= */}
      <section className="border-b border-line bg-panel" aria-label="Live platform numbers">
        <Reveal>
          <div className={`${SECTION} py-5 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-4`}>
            <Stat label="Pools live" value={live === null ? null : String(live)} />
            <Stat label="Capital in vaults" value={tvl === null ? null : usd(tvl)} />
            <Stat label="Markets" value={markets === null ? null : String(markets)} />
            <Stat label="Last mark" value={markAge === null ? null : String(markAge)} suffix="s ago" />
          </div>
        </Reveal>
      </section>

      {/* ================= markets ticker: the product's TickerStrip, with live oracle prices ================= */}
      <section className="border-b border-line" aria-label="Markets">
        <div className={`${SECTION} h-11 flex items-center gap-x-6 gap-y-1 overflow-x-auto whitespace-nowrap`}>
          {(tickers ?? []).map((t) => (
            <span key={t.symbol} className="flex items-baseline gap-1.5 shrink-0">
              <span className="font-mono text-xs font-medium text-fg">{t.symbol}-PERP</span>
              <span className="num text-xs text-muted">{t.price === null ? "—" : price(t.price)}</span>
              <span className="font-mono text-[10px] text-muted/70">{t.lev}</span>
            </span>
          ))}
          {tickers === null && <span className="eyebrow">Perp markets · live oracle prices</span>}
        </div>
      </section>

      {/* ================= section 4.3 trader lifecycle ================= */}
      <section id="traders" className={`${SECTION} py-16 lg:py-24 scroll-mt-14`} aria-label="For traders">
        <Reveal>
          <div className="eyebrow">For traders</div>
          <h2 className="mt-3 font-sans text-xl md:text-h6 md:leading-9 font-semibold tracking-tight text-fg">Trial to funded, in five steps</h2>
        </Reveal>
        <Reveal delay={120}>
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 mt-9">
            <StageCard n="01" tag="Trial" figure={simBalance} body={<>Pay the {fee} entry fee, trade a simulated account for 30 days against live Pyth prices, with every order in a signed hash-chained log.</>} />
            <StageCard n="02" tag="Pass" figure={`+${pct(cfg.trial.profitTargetBps)}`} body={<>Hit the profit target inside the loss limits, with ≥ {cfg.trial.minActiveDays} active days and ≥ {cfg.trial.minTrades} trades. Finalized on-chain.</>} />
            <StageCard n="03" tag="Go live" figure={caps[0]} body={<>Open your pool at the Tier 1 cap. The Common Pool funds it in turn (investors back the pool, not individual traders) and you are live once NAV ≥ {usdWhole(cfg.activationFloor)}.</>} />
            <StageCard n="04" tag="Promote" figure={caps[2]} body={<>{cfg.risk.promotionDays} positive live days raise your cap per tier: {caps[0]} → {caps[1]} → {caps[2]}.</>} />
            <StageCard n="05" tag="Earn" figure="80%" body={<>80% of net new realized profit, net of the closing fee (15% compounds to investors, 5% to the platform). It vests over {vest} days per tier, pays above the high-water mark, claws back on breach.</>} />
          </div>
          <div className="landing-rule mt-4 h-0.5 bg-down" aria-hidden />
          <div className="font-mono text-xxs font-medium uppercase tracking-wider text-down mt-2.5">Loss-limit guard · every step, every pool</div>
          <div className="mt-9">
            <a href={TERMINAL_URL} className="btn btn-primary">
              Start the trial
            </a>
          </div>
        </Reveal>
      </section>

      {/* ================= the terminal: what you actually trade in ================= */}
      <section className="border-t border-line" aria-label="The terminal">
        <div className={`${SECTION} py-16 lg:py-24`}>
          <Reveal>
            <div className="eyebrow">The terminal</div>
            <h2 className="mt-3 font-sans text-xl md:text-h6 md:leading-9 font-semibold tracking-tight text-fg">A real trading terminal, not a form</h2>
            <p className="mt-4 text-sm text-muted leading-relaxed max-w-[68ch]">One interface for the trial and for live capital. The simulated account runs under the same limits, the same prices and the same terminal you trade funded.</p>
          </Reveal>
          <Reveal delay={120}>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-9">
              <Feature title="Charting" body={<>Candles from <Num>1m</Num> to <Num>1D</Num> with your entry line, live PnL tag and execution marks on the chart. TradingView Advanced Charts supported.</>} />
              <Feature title="Order book" body={<>Live depth with <Num>5–50 bps</Num> grouping, USD or base units, and a trades tape beside it.</>} />
              <Feature title="Order types" body={<>Market and limit (within ±{pct(cfg.risk.limitBandBps)} of oracle), a TWAP runner, take-profit / stop-loss triggers, reduce-only closes.</>} />
              <Feature title="One-click trading" body={<>A revocable session key signs orders for you, so there is no wallet popup on every trade.</>} />
              <Feature title="Risk HUD" body={<>Leverage, exposure and distance-to-lock, computed live against the same limits the program enforces.</>} />
              <Feature title="Test USDC faucet" body={<>A claim button in the terminal funds your {NETWORK} wallet for the entry fee and pool seeding. Nothing real is at stake.</>} />
            </div>
            <div className="mt-8">
              <a href={TERMINAL_URL} className="btn">
                Launch terminal
              </a>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ================= the rules: section 5.3 / section 5.4, rendered from platform parameters ================= */}
      <section className="border-t border-line bg-panel" aria-label="The rules">
        <div className={`${SECTION} py-16 lg:py-24`}>
          <Reveal>
            <div className="eyebrow">The rules are the product</div>
            <h2 className="mt-3 font-sans text-xl md:text-h6 md:leading-9 font-semibold tracking-tight text-fg">Every limit below is enforced by the program, not a policy page</h2>
          </Reveal>
          <Reveal delay={120}>
            <div className="grid md:grid-cols-2 gap-4 mt-9">
              <div className="border border-line rounded bg-bg p-5">
                <div className="eyebrow pb-2 border-b border-line">Trial pass criteria</div>
                <div className="mt-1">
                  <Rule label="Starting balance" value={`${simBalance} simulated`} />
                  <Rule label="Profit target" value={`≥ +${pct(cfg.trial.profitTargetBps)}`} />
                  <Rule label="Max drawdown" value={`≤ ${pct(cfg.trial.maxDrawdownBps)}`} tone="down" />
                  <Rule label="Daily loss" value={`≤ ${pct(cfg.trial.dailyLossBps)}`} tone="down" />
                  <Rule label="Active days" value={`≥ ${cfg.trial.minActiveDays} of 30`} />
                  <Rule label="Trades" value={`≥ ${cfg.trial.minTrades}`} />
                  <Rule label="Best-day share" value={`≤ ${pct(cfg.trial.maxDayProfitShareBps)} of profit`} />
                </div>
              </div>
              <div className="border border-line rounded bg-bg p-5">
                <div className="eyebrow pb-2 border-b border-line">Live risk limits</div>
                <div className="mt-1">
                  <Rule label="Gross leverage" value={`≤ ${Math.round(cfg.risk.maxLeverageBps / 10000)}×`} />
                  <Rule label="Open positions" value={`≤ ${cfg.risk.maxPositions}`} />
                  <Rule label="Daily loss" value={`${pct(cfg.risk.dailyLossBps)} → lock`} tone="down" />
                  <Rule label="Max drawdown" value={`${pct(cfg.risk.maxDrawdownBps)} → lock`} tone="down" />
                  <Rule label="Trades per day" value={`≤ ${cfg.risk.maxTradesPerDay}`} />
                  <Rule label="Limit orders" value={`±${pct(cfg.risk.limitBandBps)} of oracle`} />
                  <Rule label="Redemption lockup" value={dur(cfg.risk.redemptionLockupSecs)} />
                  <Rule label="Failed-trial cooldown" value={dur(cfg.risk.cooldownSecs)} />
                </div>
              </div>
            </div>
            <p className="mt-4 font-mono text-xxs text-muted/80">
              {liveCfg ? "Values read live from the platform's on-chain parameters via the indexer." : "Spec values (sections 5.3 and 5.4). The running platform's parameters load here when the API is reachable."}
            </p>
          </Reveal>
        </div>
      </section>

      {/* ================= section 4.4 investors ================= */}
      <section id="investors" className="border-t border-line scroll-mt-14" aria-label="For investors">
        <div className={`${SECTION} py-16 lg:py-24`}>
          <Reveal>
            <div className="eyebrow">For investors</div>
            <h2 className="mt-3 font-sans text-xl md:text-h6 md:leading-9 font-semibold tracking-tight text-fg">Where your money sits, and who can touch it</h2>
          </Reveal>
          <Reveal delay={120}>
            <div className="grid md:grid-cols-3 gap-4 mt-9">
              <div className="border border-line rounded bg-panel p-6 transition-colors hover:border-line2 hover:bg-panel2">
                <h3 className="font-sans text-lg font-semibold text-fg">Deposit into a vault</h3>
                <p className="mt-2.5 text-sm text-muted leading-relaxed">
                  From <Num>{usdWhole(cfg.minDeposit)}</Num> into any pool, at NAV. Funds go to a program-owned vault the trader can trade but never withdraw. Redeem after a {dur(cfg.risk.redemptionLockupSecs)} lockup;
                  an open book does not trap you, because the keeper unwinds positions to free the collateral.
                </p>
              </div>
              <div className="border border-line rounded bg-panel p-6 transition-colors hover:border-line2 hover:bg-panel2">
                <h3 className="font-sans text-lg font-semibold text-fg">The guard, not the trader, holds the floor</h3>
                <p className="mt-2.5 text-sm text-muted leading-relaxed">
                  The keeper marks every live pool every <Num>3 s</Num>. When equity crosses the lock floor the program <span className="text-down">locks the pool</span>, and anyone can trigger
                  that lock for a bounty if the keeper does not.
                </p>
              </div>
              <div className="border border-line rounded bg-panel p-6 transition-colors hover:border-line2 hover:bg-panel2">
                <h3 className="font-sans text-lg font-semibold text-fg">A record that can't be rewritten</h3>
                <p className="mt-2.5 text-sm text-muted leading-relaxed">
                  Every pool card shows drawdown beside return, from indexed on-chain events. The split is <Num>80/15/5</Num> between trader, investors and platform. The trader's share vests over {vest} days with clawback, so losses hit them before they're
                  paid.
                </p>
              </div>
            </div>
            <p className="mt-5 text-xs text-muted/90 max-w-[68ch]">One deposit into the Common Pool is spread across every funded trader. You do not pick one, and no trader can raise capital from you directly. Investors bear all losses; there is no backstop fund.</p>
            <div className="mt-6">
              <a href={`${TERMINAL_URL}/invest`} className="btn">
                Explore pools
              </a>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ================= section 4.5 receipts ================= */}
      <section className="border-t border-line" aria-label="On-chain receipts">
        <div className={`${SECTION} py-16 lg:py-24`}>
          <Reveal>
            <div className="eyebrow">On-chain receipts</div>
            <div className="mt-7 border-t border-line">
              <Receipt label="Program" value={PROGRAM_ID} href={explorerAddrUrl(PROGRAM_ID)} link="Explorer" mono />
              <Receipt label="Trial log" value="Signed, hash-chained, daily merkle roots, exportable from the terminal" href={`${TERMINAL_URL}/trial/export`} link="Export" />
              <Receipt label="Prices" value="Pyth, via Hermes stream or on-chain receiver" href={`${TERMINAL_URL}/guide`} link="Rulebook" />
              <Receipt label="Venue" value={`Drift (${NETWORK})`} href={`${TERMINAL_URL}/guide`} link="Rulebook" />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ================= section 4.6 disclosures ================= */}
      <section className="border-t border-line" aria-label="Disclosures">
        <div className={`${SECTION} py-16 lg:py-24`}>
          <Reveal>
            <h2 className="font-sans text-xl md:text-h6 md:leading-9 font-semibold tracking-tight text-fg">Disclosures</h2>
            <div className="mt-7 max-w-[68ch]">
              <Faq q="What does it cost to try?">
                {fee} per trial attempt, paid to the platform treasury, where it backs the risk your funded pool will take. A failed trial has a {dur(cfg.risk.cooldownSecs)} cooldown before you can pay for
                another. On {NETWORK} the terminal's faucet gives you the test USDC.
              </Faq>
              <Faq q="What happens if I breach the loss limit?">
                Live, the program locks the pool once the keeper's mark crosses the floor: open positions are unwound, investors can redeem at NAV, and unvested profit is clawed back. Marking runs on
                a {"3 s"} cadence and the lock is a transaction, so it lands shortly after the breach rather than instantly. In the trial, a breach fails the attempt and the {dur(cfg.risk.cooldownSecs)} cooldown applies.
              </Faq>
              <Faq q="Who holds investor funds?">
                A program-owned vault on Solana, not the trader and not the platform. The program lets the trader trade the vault but never withdraw from it, and nobody takes custody of your keys. One
                caveat worth knowing: the admin key can pause the platform, and while a pause is set it blocks withdrawals as well as trading.
              </Faq>
              <Faq q="What can I trade?">
                {markets ?? 5} perp markets (SOL, BTC, ETH and other majors) at up to {Math.round(cfg.risk.maxLeverageBps / 10000)}× gross leverage, priced by Pyth oracles. The exact list with live
                prices is in the strip above.
              </Faq>
              <Faq q="What's simulated vs real?">
                The 30-day trial runs on a simulated {simBalance} account against live Pyth prices, with every order committed to a signed hash-chained log. Funded pools trade real investor USDC
                through the venue adapter.
              </Faq>
              <Faq q="How do redemptions work while positions are open?">
                A redemption request is honored at NAV. If the pool lacks free collateral, the keeper unwinds positions to free it, so an open book does not trap you. Two things can hold a request up: a
                global pause set by the admin key blocks every exit path while it is on, and on a live pool there is a {dur(cfg.risk.redemptionLockupSecs)} lockup after each deposit. Investors bear
                losses, and there is no backstop fund.
              </Faq>
              <Faq q="What does the 80/15/5 split net out of?">Net of the closing fee: the split applies to realized profit after the venue's closing costs are deducted. 80% goes to the trader and vests, 15% compounds investor NAV, and 5% funds the platform and its keeper bounties.</Faq>
              <Faq q="Is this mainnet?">
                Not yet. The whole platform runs on Solana {NETWORK} with test USDC, and the {NETWORK.toUpperCase()} badge stays until that changes.
              </Faq>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ================= section 4.7 footer ================= */}
      <footer className="border-t border-line bg-panel mt-auto">
        <div className={`${SECTION} py-8 flex flex-wrap items-center gap-x-6 gap-y-3`}>
          <Brand />
          <NetworkPill />
          <button type="button" onClick={copyProgram} title="Copy program id" className="num text-xs text-muted hover:text-fg transition-colors break-all text-left rounded">
            {PROGRAM_ID} ⧉
          </button>
          <span className="flex-1" />
          <nav className="flex flex-wrap gap-4 text-xs" aria-label="Footer">
            <a href={`${TERMINAL_URL}/guide`} className="text-muted hover:text-fg transition-colors">
              Rulebook
            </a>
            <a href={TERMINAL_URL} className="text-muted hover:text-fg transition-colors">
              Terminal
            </a>
            <a href={`${TERMINAL_URL}/invest`} className="text-muted hover:text-fg transition-colors">
              Invest
            </a>
          </nav>
        </div>
        {/* toast for the program-id copy (section 4.7: toast, not inline text) */}
        <div
          role="status"
          className={`fixed left-1/2 bottom-6 -translate-x-1/2 bg-panel2 border border-line2 rounded-md px-4 py-2.5 text-sm font-medium text-fg shadow-[0_12px_32px_rgba(0,0,0,0.45)] transition-all duration-200 ${
            copied ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3 pointer-events-none"
          }`}
        >
          Program id copied
        </div>
      </footer>
    </div>
  );
}
