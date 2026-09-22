"use client";
/**
 * Instant-funding onboarding. "Size your account Instantly".
 *
 * Figma: "Dev Ready" / features and states, row y=3657
 * (97:62013 deposit · 97:17184 queue · 97:87605 tier assignment ·
 * 97:113220 done). Spec: docs/design/onboarding-flow-spec.md.
 *
 * Purely presentational. StatusCard owns the journey state and the paying
 * transaction and passes both in, so there is one implementation of each and
 * this file holds no chain logic. Figures arrive already derived from on-chain
 * config. Nothing here is hardcoded from the mock (the design's own numbers
 * were wrong; see spec section 7).
 *
 * Step 2 reads the funding-capacity signal (CommonPool idle less its reserve
 * floor, against what `fund_next_in_queue` would actually deploy). It is
 * always a *pending* state, never a failure one: a paid seat that has not yet
 * become a pool is waiting, and telling someone their payment failed when the
 * queue is simply ahead of them would be both wrong and alarming. Real
 * failures surface as toasts on the transaction that caused them.
 */
import Link from "next/link";
import { ConnectButton, Skeleton, Spinner } from "@kydo/ui";
import { usd, usdWhole } from "@/lib/format";

/** The four steps, in the design's order. */
export type OnboardingStep = 0 | 1 | 2 | 3;

/** One waiting trader, as the design's queue table lists them. */
export interface OnboardingQueueRow {
  /** FIFO ticket number. */
  ticket: number;
  /** base58 wallet, already shortened. */
  wallet: string;
  /** This row is the connected trader. */
  you: boolean;
}

/** Where the trader stands in the CommonPool funding queue (step 2). */
export interface OnboardingQueue {
  /** 0 = next to be funded; null while unknown or not queued. */
  position: number | null;
  /** How many are ahead. */
  ahead: number | null;
  /** Total tickets waiting. */
  depth: number | null;
  /** Deployable idle in the CommonPool (idle less the reserve floor). */
  availableUsd: number | null;
  /** What this trader's pool needs from it. */
  needsUsd: number | null;
  /** availableUsd >= needsUsd; null while unknown. */
  hasCapacity: boolean | null;
  /** The queue itself, head first. Empty while loading or when nobody waits. */
  rows?: OnboardingQueueRow[];
}

export interface InstantOnboardingProps {
  /** First step not yet done. 0 deposit · 1 queue · 2 tier · 3 trading. */
  current: OnboardingStep;
  /** A chain read for the current step is outstanding. Render the skeleton. */
  settling?: boolean;
  /** Seat price: max(1.5 × entry fee, 20% of the Tier 1 cap). */
  seatPrice: number | null;
  /** What the trader is funded to, once paid; the Tier 1 cap before that. */
  fundedCap: number | null;
  /** Tier caps in USD, index 0 = Tier 1. */
  tierCaps: (number | null)[];
  /** Vesting days for the assigned tier. */
  vestDays: number;
  /** A wallet is connected and the client is ready. Step 1's CTA is the
      deposit itself when true, and the wallet connector when false. */
  connected?: boolean;
  /** Funding-queue state for step 2. */
  queue?: OnboardingQueue;
  /** Step 1's action. Paying for the seat. Omitted when it isn't available. */
  onDeposit?: () => void;
  depositBusy?: boolean;
  /** Set when the deposit can't proceed yet; shown instead of enabling the CTA. */
  depositBlockedReason?: string;
}

export function InstantOnboarding({
  current,
  settling = false,
  seatPrice,
  fundedCap,
  tierCaps,
  vestDays,
  connected = false,
  queue,
  onDeposit,
  depositBusy = false,
  depositBlockedReason,
}: InstantOnboardingProps) {
  const ladder = tierCaps.slice(0, 3).map((cap, i) => ({ tier: i + 1, cap }));
  const ladderCopy = ladder.every((l) => l.cap !== null)
    ? `${ladder.map((l) => `Tier ${l.tier} → ${usdWhole(l.cap as number)}`).join(" | ")}. You can upgrade tiers from your profits.`
    : "You can upgrade tiers from your profits.";

  return (
    <section className="flex flex-col gap-6" aria-label="Get funded">
      {/* ---- heading (Figma 97:62066) ---- */}
      <div className="flex max-w-[540px] flex-col gap-4">
        <h1 className="text-h1 font-semibold leading-double text-fg">
          Size your account
          <br />
          Instantly
        </h1>
        <p className="max-w-[476px] text-h10 leading-double text-fig-text-600">
          Choose how much you want to trade with. Your deposit is 20% of the account size, with the rest coming from the pool.
        </p>
      </div>

      {/* ---- the two cards (Figma: 823 + 406, 16 px gutter. Separate
           surfaces, not one card split down the middle) ---- */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
        {/* left card: how it works */}
        <div className="flex min-w-0 flex-1 flex-col rounded-[24px] bg-gradient-to-t from-fig-bg-pattern-900 to-fig-bg-600 px-8 py-7 lg:px-10">
          <ol className="flex flex-col divide-y divide-dashed divide-fig-stroke">
            <WizardStep
              n={1}
              current={current}
              settling={settling}
              title={seatPrice === null ? "Deposit to get funded" : `Deposit ${usdWhole(seatPrice)} USDC to get funded`}
              body="One payment joining amount. Gives you access to a funded account for live markets, every order committed on-chain daily."
            />
            <WizardStep
              n={2}
              current={current}
              settling={settling}
              title="Queue for Instant funding pool"
              body="You get your own personal funding pool, funded from the global funding pool."
            />
            <WizardStep
              n={3}
              current={current}
              settling={settling}
              title={tierCaps[0] == null ? "Get your funding tier" : `Get Funding Tier 1: ${usdWhole(tierCaps[0] as number)}`}
              body={ladderCopy}
            />
            <WizardStep
              n={4}
              current={current}
              settling={settling}
              title="Trade, win and keep 80% profit"
              body={`80% of every winning close escrows to you, vests over ${vestDays} days with clawback, and pays out above the high-water mark.`}
            />
          </ol>
        </div>

        {/* right card (Figma 406×434). Changes per state */}
        <div className="flex w-full shrink-0 flex-col rounded-[24px] border border-fig-stroke bg-fig-bg-additional p-5 lg:w-[406px]">
          {settling ? (
            <SigningSkeleton />
          ) : current === 0 ? (
            <DepositPanel
              seatPrice={seatPrice}
              fundedCap={fundedCap}
              connected={connected}
              onDeposit={onDeposit}
              busy={depositBusy}
              blockedReason={depositBlockedReason}
            />
          ) : current === 1 ? (
            <QueuePanel queue={queue} />
          ) : current === 2 ? (
            <TierPanel ladder={ladder} />
          ) : (
            <FundedPanel cap={fundedCap} />
          )}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- steps --- */

function WizardStep({ n, current, settling, title, body }: { n: number; current: OnboardingStep; settling: boolean; title: string; body: string }) {
  const idx = n - 1;
  const done = idx < current;
  const active = idx === current;
  return (
    <li className="flex items-start gap-4 py-5 first:pt-0 last:pb-0">
      <StepBadge n={n} done={done} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={`text-h9 font-medium leading-double ${done || active ? "text-fg" : "text-fig-text-550"}`}>{title}</span>
        <span className="text-h11 leading-double text-fig-text-600">{body}</span>
      </span>
      {/* The design writes the status as plain lime text, right-aligned. No
          pill, no border (Figma 97:62013 and siblings). */}
      <span className="hidden w-[110px] shrink-0 text-right text-h10 font-medium text-accent sm:inline-flex sm:justify-end">
        {done ? "Complete" : active && settling ? "Signing..." : "Waiting..."}
      </span>
    </li>
  );
}

/** Dashed circle while pending, solid green tick once done (Figma 97:55603). */
function StepBadge({ n, done }: { n: number; done: boolean }) {
  if (done) {
    return (
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-up text-ink" aria-hidden>
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8.4l3 3 6-6.6" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-dashed border-fig-text-700 text-h11 font-medium text-fig-text-600"
      aria-hidden
    >
      {n}
    </span>
  );
}

/* --------------------------------------------------------- right panels --- */

function PanelLabel({ children }: { children: React.ReactNode }) {
  return <span className="px-1 pb-3 text-h11 font-medium uppercase tracking-wider text-fig-text-600">{children}</span>;
}

/** A figure on its own inset surface, as the design sets the deposit amounts. */
function FigureBox({ value }: { value: string }) {
  return (
    <div className="rounded-[16px] bg-fig-bg-700 px-4 py-4 shadow-[inset_0_6px_16px_0_rgba(0,0,0,0.16)]">
      <span className="num text-h7 font-semibold text-fg">{value}</span>
    </div>
  );
}

function DepositPanel({
  seatPrice,
  fundedCap,
  connected,
  onDeposit,
  busy,
  blockedReason,
}: {
  seatPrice: number | null;
  fundedCap: number | null;
  connected: boolean;
  onDeposit?: () => void;
  busy: boolean;
  blockedReason?: string;
}) {
  return (
    <>
      <PanelLabel>How it works</PanelLabel>
      <div className="flex flex-1 flex-col gap-4">
        <div className="flex flex-col gap-3">
          <span className="text-h9 font-medium text-fg">You Deposit</span>
          <FigureBox value={seatPrice === null ? "—" : usd(seatPrice)} />
        </div>

        <div className="border-t border-dashed border-fig-stroke" />

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-h9 font-medium text-fg">Your Funding Amount</span>
            {fundedCap !== null && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-up px-2 py-1 text-h11 text-up">
                <CheckDot />
                <span className="num">{usdWhole(fundedCap)}</span>
              </span>
            )}
          </div>
          <FigureBox value={fundedCap === null ? "—" : usd(fundedCap)} />
        </div>

        {/* The Figma frame for this step is the *signed-out* state, which is
            why it reads "Connect Wallet". That label was ported as though it
            were constant, so a connected trader was told to connect a wallet by
            a button that actually opened the deposit dialog. Signed out, this
            is the real connector; signed in, it is the deposit. */}
        <div className="mt-auto flex flex-col gap-2 pt-2">
          {!connected ? (
            <ConnectButton size="lg" className="w-full" label="Connect Wallet" />
          ) : (
            onDeposit && (
              <button type="button" className="btn-lime" onClick={onDeposit} disabled={busy || !!blockedReason} aria-busy={busy} title={blockedReason}>
                {busy && <Spinner />}
                <WalletGlyph />
                {busy ? "Working…" : seatPrice === null ? "Deposit & get funded" : `Deposit ${usdWhole(seatPrice)} & get funded`}
              </button>
            )
          )}
          {blockedReason && <p className="text-h11 leading-double text-amber">{blockedReason}</p>}
        </div>
      </div>
    </>
  );
}

/**
 * Step 2 (Figma 97:17184, "YOUR POSITION"). Between paying and having a pool.
 *
 * Always pending, never failed. The funding queue is strictly FIFO and
 * permissionless, so "not funded yet" means either capacity is filling or
 * someone is ahead. Both are waiting, and there is nothing the trader can do
 * about either. A "payment failed" panel here would be wrong far more often
 * than it was right.
 *
 * The design's table is kept; two of its columns are not. "1 pool slot opens
 * every ~8 hrs" and a "~4 days" wait were mock values. Nothing schedules
 * funding, it runs the moment idle covers the head of the queue. The third
 * column says what is actually true of each row instead.
 */
function QueuePanel({ queue }: { queue?: OnboardingQueue }) {
  const pos = queue?.position ?? null;
  const capacity = queue?.hasCapacity ?? null;
  const next = pos === 0;
  const rows = queue?.rows ?? [];
  const headline = capacity === null ? "Queue" : next && capacity ? "Funding now" : "Queue";
  const sub =
    capacity === null
      ? "Reading the funding pool…"
      : queue?.availableUsd != null && queue?.needsUsd != null
        ? `${usdWhole(queue.availableUsd)} available · your account needs ${usdWhole(queue.needsUsd)}`
        : "Funded automatically, strictly in order.";
  return (
    <>
      <PanelLabel>Your position</PanelLabel>
      <div className="flex flex-1 flex-col gap-4 rounded-[20px] bg-fig-bg-700 p-4">
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-2 text-h9 font-medium text-fg">
            {headline}
            {capacity !== null && !(next && capacity) && <Spinner />}
          </span>
          <span className={`text-h11 leading-double ${capacity === false ? "text-amber" : "text-fig-text-600"}`}>{sub}</span>
        </div>

        {rows.length === 0 ? (
          <Skeleton lines={4} />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[64px_1fr_auto] gap-2 px-3 text-h11 text-fig-text-600">
              <span>Position</span>
              <span>Wallet address</span>
              <span className="text-right">Status</span>
            </div>
            {rows.map((r, i) => (
              <div
                key={r.ticket}
                className={`grid grid-cols-[64px_1fr_auto] items-center gap-2 rounded-full bg-fig-bg-additional px-3 py-2 text-h11 shadow-[inset_0_6px_16px_0_rgba(0,0,0,0.16)] ${
                  r.you ? "text-accent" : "text-fig-text-600"
                }`}
                aria-current={r.you ? "step" : undefined}
              >
                <span className="num">#{r.ticket}</span>
                <span className="num truncate">{r.wallet}</span>
                <span className="num text-right">{i === 0 ? (capacity ? "Funding" : "Next") : r.you ? "You" : "Waiting"}</span>
              </div>
            ))}
          </div>
        )}

        <p className="mt-auto pt-2 text-h11 leading-double text-fig-text-600">
          Your seat is paid. Funding runs on its own the moment the pool covers the head of the queue. There is nothing more to sign.
        </p>
      </div>
    </>
  );
}

/**
 * Tier ladder (Figma 97:87605). A vertical timeline, not a plain list: a dot
 * per tier joined by a connector, lime down to the tier you hold and grey
 * beyond it.
 */
function TierPanel({ ladder }: { ladder: { tier: number; cap: number | null }[] }) {
  return (
    <>
      <PanelLabel>Assigning tier</PanelLabel>
      <div className="flex flex-1 flex-col gap-4 rounded-[20px] bg-fig-bg-700 p-4">
        <span className="text-h9 font-medium text-fg">Tier Ladder</span>
        <ol className="flex flex-col rounded-[16px] bg-fig-bg-additional p-4">
          {ladder.map((l, i) => {
            const current = i === 0;
            const last = i === ladder.length - 1;
            return (
              <li key={l.tier} className="flex gap-3">
                {/* dot + connector */}
                <span className="flex shrink-0 flex-col items-center" aria-hidden>
                  <span className={`mt-1.5 size-2.5 rounded-full ${current ? "bg-accent" : "bg-fig-text-700"}`} />
                  {!last && <span className={`w-px flex-1 ${current ? "bg-accent" : "bg-fig-text-800"}`} />}
                </span>
                <span className={`flex min-w-0 flex-col gap-0.5 ${last ? "" : "pb-5"}`}>
                  <span className={`text-h8 font-semibold ${current ? "text-accent" : "text-fg"}`}>
                    Tier {l.tier} · <span className="num">{l.cap === null ? "—" : usd(l.cap)}</span>
                  </span>
                  <span className="text-h11 text-fig-text-600">{current ? "Current · unlocked" : "Upgrade from profits"}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}

function FundedPanel({ cap }: { cap: number | null }) {
  return (
    <>
      {/* The design still reads "ASSIGNING TIER" here, carried over from the
          previous state. The tier is assigned by this point. */}
      <PanelLabel>Your account</PanelLabel>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[20px] bg-fig-bg-700 p-6 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-accent text-ink" aria-hidden>
          <svg viewBox="0 0 16 16" className="size-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.5 8.4l3 3 6-6.6" />
          </svg>
        </span>
        <span className="text-h9 font-semibold text-fg">You&rsquo;re funded and ready to trade</span>
        <span className="text-h11 text-fig-text-600">
          {cap === null ? "Tier active." : `${usdWhole(cap)} tier active.`} Keep 80% of every win.
        </span>
      </div>
      <div className="pt-4">
        <Link href="/terminal" className="btn-lime">
          Open Terminal
        </Link>
      </div>
    </>
  );
}

function SigningSkeleton() {
  return (
    <>
      <PanelLabel>Working</PanelLabel>
      <div className="flex-1 rounded-[20px] bg-fig-bg-700 p-4">
        <Skeleton lines={5} />
      </div>
    </>
  );
}

/** The cap chip's check, and the wallet glyph on the connect CTA. */
function CheckDot() {
  return (
    <svg viewBox="0 0 12 12" className="size-3 shrink-0" aria-hidden>
      <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M3.6 6.2l1.7 1.7 3.1-3.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WalletGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <rect x="2.5" y="4.5" width="15" height="11" rx="2.5" />
      <path d="M2.5 8.5h15" />
      <circle cx="14" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
