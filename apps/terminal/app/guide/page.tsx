"use client";
/**
 * Rulebook. What the platform does with your money, and what ends an account.
 *
 * Rewritten from a wall of prose (eight numbered paragraphs, a six-row
 * comparison table, three essay cards) into diagrams. The rule applied
 * throughout: if a thing is a flow, a proportion, an order or a ladder, draw
 * it; keep prose for the one line that says what it means, and put the rest
 * behind a "Detail" expander so the page can be scanned in twenty seconds.
 *
 * Section markers (section 6.1, section 4.9…) came out of the headings. They are references
 * into the requirements doc, not something a trader reading this needs.
 *
 * Every figure comes from on-chain config, so a demo deployment describes its
 * own compressed timings truthfully.
 */
import { useState } from "react";
import Link from "next/link";
import { Skeleton } from "@kydo/ui";
import { riskLike } from "@/lib/chain";
import { fromPrice, usd, usdWhole } from "@/lib/format";
import { usePlatform } from "@/lib/platform";
import { Card, Figure, LimitBars, LossWaterfall, MoneyFlow, ProfitSplit, Step, TierLadder } from "@/components/rulebook/Visuals";

export default function GuidePage() {
  const { config: c } = usePlatform();
  const [who, setWho] = useState<"trader" | "investor">("trader");

  const fee = c ? usd(fromPrice(c.entryFee)) : "—";
  const floor = c ? usdWhole(fromPrice(c.activationFloor)) : "—";
  const minDep = c ? usdWhole(fromPrice(c.minDeposit)) : "—";
  const caps = c ? c.tierCaps.slice(0, 3).map((x) => usdWhole(fromPrice(x))) : ["—", "—", "—"];
  const vestDays = c ? c.vestDays : [14, 30, 30];
  const daySecs = c ? c.trial.daySecs : 86_400;
  const compressed = daySecs < 86_400;
  const trialWall = compressed ? `${Math.round((30 * daySecs) / 60) || "<1"} min` : "30 days";
  const start = c ? usdWhole(fromPrice(c.trial.startingBalance)) : "—";
  const cushionPct = c?.minFirstLossBps ? `${(c.minFirstLossBps / 100).toFixed(0)}%` : "20%";
  const dailyPct = c ? c.risk.dailyLossBps / 100 : 4;
  const ddPct = c ? c.risk.maxDrawdownBps / 100 : 10;
  // Tier 0 is instant funding, and the SDK is what narrows the limits for it.
  // Read them from there rather than restating 3 / 8 here, or this page drifts
  // the moment the tightening changes.
  const instantRisk = c ? riskLike(c.risk, 0) : null;
  const instantDailyPct = instantRisk ? instantRisk.dailyLossBps / 100 : 3;
  const instantDdPct = instantRisk ? instantRisk.maxDrawdownBps / 100 : 8;
  const lev = c ? c.risk.maxLeverageBps / 10_000 : 5; // program default; the old 10 was double the real cap
  const instantFee = c ? usdWhole(Math.max(fromPrice(c.entryFee) * 1.5, fromPrice(c.tierCaps[0]) * 0.2)) : "—";
  const lockupHrs = c ? Math.round(c.risk.redemptionLockupSecs / 3600) : 24;

  if (!c) {
    return (
      <div className="page gap-8">
        <h1 className="text-h1 font-semibold leading-double text-fg">Rulebook</h1>
        <Skeleton lines={10} />
      </div>
    );
  }

  return (
    <div className="page gap-8">
      {/* ---------------------------------------------------------- header */}
      <header className="flex max-w-[680px] flex-col gap-4">
        <h1 className="text-h1 font-semibold leading-double text-fg">Rulebook</h1>
        <p className="text-h10 leading-double text-fig-text-600">
          Traders trade capital they can never withdraw. Investors back all of them at once. Every limit here is enforced by the program, not by a
          policy. A breaching order simply fails.
        </p>
        {compressed && (
          <p className="notice notice-warn">
            Demo deployment: one platform day is {daySecs}s, so a 30-day trial takes about {trialWall} and vesting runs just as fast. Production uses real
            days.
          </p>
        )}
      </header>

      {/* ------------------------------------------------- the four numbers */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <Figure value="80%" label="of winning closes to the trader" tone="accent" />
        </Card>
        <Card>
          <Figure value={cushionPct} label="of the account is the trader's own money" tone="amber" sub="spent before yours" />
        </Card>
        <Card>
          <Figure value={`${ddPct}%`} label="drawdown ends the account" tone="down" sub="permanently" />
        </Card>
        <Card>
          <Figure value={caps[2]} label="largest account a trader can reach" sub={`from ${caps[0]}`} />
        </Card>
      </div>

      {/* ------------------------------------------------------- money flow */}
      <Card title="Where your deposit goes" aside="Investor side">
        <MoneyFlow minDeposit={minDep} />
      </Card>

      {/* --------------------------------------- split + loss order, paired */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="How profit is split">
          <ProfitSplit />
        </Card>
        <Card title="Who absorbs a loss, and in what order">
          <LossWaterfall cushionPct={cushionPct} />
        </Card>
      </div>

      {/* ----------------------------------------------- what ends the account */}
      <Card title="What ends an account" aside="Measured against the account's own peak and its day-start value">
        <LimitBars
          rows={[
            { label: "Loss in a single day", standard: dailyPct, instant: instantDailyPct },
            { label: "Drawdown from peak", standard: ddPct, instant: instantDdPct },
          ]}
        />
        <div className="grid gap-3 border-t border-dashed border-fig-stroke pt-4 sm:grid-cols-3">
          <Figure value={`${lev}×`} label="Maximum gross leverage" />
          <Figure value={String(c.risk.maxPositions)} label="Open positions at once" />
          <Figure value={String(c.risk.maxTradesPerDay)} label="Trades per day" />
        </div>
      </Card>

      {/* ------------------------------------------------------ tier ladder */}
      <Card title="How an account grows" aside={`${c.risk.promotionDays} positive days per step`}>
        <TierLadder caps={caps} vestDays={vestDays} promotionDays={c.risk.promotionDays} />
      </Card>

      {/* ------------------------------------------------- two ways to start */}
      <section className="flex flex-col gap-3" aria-label="Two ways to get funded">
        <h2 className="text-h7 font-semibold text-fg">Two ways to get funded</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          <Card title="Prove it first" aside={`${trialWall} trial`}>
            <div className="flex flex-wrap gap-6">
              <Figure value={fee} label="Entry fee" />
              <Figure value={start} label="Simulated balance" />
              <Figure value={`${vestDays[0]}d`} label="Vesting" tone="up" />
            </div>
            <ul className="flex flex-col gap-2 border-t border-dashed border-fig-stroke pt-4 text-h11 leading-double text-fig-text-600">
              <li>
                Pass by finishing <span className="text-fg">+{c.trial.profitTargetBps / 100}%</span> inside the live limits, over{" "}
                <span className="text-fg">{c.trial.minActiveDays}</span> active days and <span className="text-fg">{c.trial.minTrades}</span> trades.
              </li>
              <li>The fee is never refunded. It becomes your account&rsquo;s cushion when you are funded.</li>
              <li className="text-up">Wider loss limits, faster vesting, and a verifiable record at the end.</li>
            </ul>
          </Card>
          <Card title="Pay to skip it" aside="Funded today">
            <div className="flex flex-wrap gap-6">
              <Figure value={instantFee} label="Up front" tone="amber" />
              <Figure value={caps[0]} label="Account size" />
              <Figure value={`${vestDays[1] ?? 30}d`} label="Vesting" tone="amber" />
            </div>
            <ul className="flex flex-col gap-2 border-t border-dashed border-fig-stroke pt-4 text-h11 leading-double text-fig-text-600">
              <li>
                The larger of <span className="text-fg">1.5× the entry fee</span> or <span className="text-fg">{cushionPct} of the account</span>, whichever
                is bigger.
              </li>
              <li>No trial, no queue for the trial. You are trading the same day.</li>
              <li className="text-amber">
                Tighter limits ({instantDailyPct}% / {instantDdPct}%), slower vesting, and a public &ldquo;no trial record&rdquo; badge until your
                first promotion.
              </li>
            </ul>
          </Card>
        </div>
        <p className="text-h11 leading-double text-fig-text-600">
          A proven trader buys speed. A trader still finding consistency takes the trial. The limits are wider and passing it mints a record. Both end
          the same way if a floor breaks.
        </p>
      </section>

      {/* ------------------------------------------------------- the journey */}
      <section className="flex flex-col gap-4" aria-label="Your path">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-h7 font-semibold text-fg">Your path</h2>
          <div className="seg w-[280px]" role="radiogroup" aria-label="Which path">
            {(["trader", "investor"] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={who === k} className={`seg__btn ${who === k ? "seg__btn--on" : ""}`} onClick={() => setWho(k)}>
                {k === "trader" ? "I want to trade" : "I want to invest"}
              </button>
            ))}
          </div>
        </div>

        <Card>
          {who === "trader" ? (
            <ol className="flex flex-col">
              <Step n={1} title="Connect a wallet" where="header" href="/" line="Phantom or Solflare. No KYC, no application. Any wallet may start." />
              <Step n={2} title="Get test USDC" where="Account panel" href="/terminal" line="The Claim USDC button drips test funds, rate-limited per wallet.">
                You need it for the entry fee and, later, to seed your own account to the {floor} activation floor.
              </Step>
              <Step n={3} title={`Pay ${fee} and start the trial`} where="Home" href="/" line={`A ${start} simulated account against live prices, for ${trialWall}.`}>
                The fee is never refunded, win or lose. When you are funded it goes into your account as the cushion that absorbs losses ahead of investor
                money; a failed attempt keeps it, which is what makes buying attempts as a lottery unprofitable.
              </Step>
              <Step n={4} title="Commit your days, then finalize" where="Home" href="/" line="Each day's orders are hash-chained and its root goes on-chain, so the record cannot be rewritten.">
                Use <b className="text-fg">Commit all</b> to sweep pending days in one approval, then <b className="text-fg">Finalize trial</b>. A miss
                invalidates the trial; a fail means a cooldown and a fresh fee.
              </Step>
              <Step n={5} title={`Open your account and seed it to ${floor}`} where="Home" href="/" line="Name, mandate and size. The risk limits are platform-wide and not yours to set.">
                <b className="text-fg">Seed &amp; activate</b> deposits your own USDC to the floor in one click. Investor capital arrives through the Common
                Pool when your turn comes; nobody can fund you directly, so there is no link to share that raises money.
              </Step>
              <Step n={6} title="Trade capital you cannot withdraw" where="Terminal" href="/terminal" line="Every order passes the on-chain guard before it reaches the venue. A breaching order fails outright.">
                Turn on <b className="text-fg">1-Click Trading</b> in the Account panel to stop signing each order. A breach the keeper catches between
                trades locks the account permanently.
              </Step>
              <Step n={7} title="Earn, vest, claim. Then promote" where="Escrow tab" href="/terminal" line={`80% of net new profit escrows to you and vests over ${vestDays[0]} days, above the high-water mark.`}>
                Escrow stays clawback-eligible against later losses, so a run of wins followed by a big loss pays nothing. Your first claim also refunds the
                trial entry fee. {c.risk.promotionDays} positive days at a tier promote you in place.
              </Step>
            </ol>
          ) : (
            <ol className="flex flex-col">
              <Step n={1} title="Deposit into the Common Pool" where="Invest" href="/invest" line={`From ${minDep}. One deposit, spread across every funded trader.`}>
                Shares mint at the current NAV per share, so a late deposit buys none of the earlier gains. You cannot deposit into one trader, and no
                trader can raise capital from you.
              </Step>
              <Step n={2} title="Read the records" where="Invest" href="/invest" line="Every trader the pool backs is listed with max drawdown beside the return.">
                Tier and days-at-tier say how long they have held that record; the cushion figure is how much of their own money is spent before yours is
                touched. You are not choosing between them. You are seeing what your deposit is backing.
              </Step>
              <Step n={3} title="Watch it work" where="Invest" href="/invest" line="Your value and PnL sit on the Common Pool card; each trader's full history stays public." />
              <Step n={4} title="Redeem whenever" where="Invest" href="/invest" line={`After a ${lockupHrs}-hour lockup, request any amount. Nothing but a global pause can block it.`}>
                If the idle reserve covers it you are paid immediately; otherwise the keeper pulls capital back from trader accounts first and you settle
                once it does.
              </Step>
              <Step n={5} title="Know what you are carrying" where="every pool page" href="/invest" line="You bear 100% of losses and receive 15% of gains. There is no backstop fund.">
                A breach locks that account and unwinds it at market; the trader&rsquo;s unvested escrow comes back to investors. Your protection is the
                cushion and the escrow above you. Not a guarantee.
              </Step>
            </ol>
          )}
        </Card>
      </section>

      {/* ------------------------------------------------------ three truths */}
      <div className="grid gap-3 md:grid-cols-3">
        <Card title="No liquidation. Locks">
          <p className="text-h11 leading-double text-fig-text-600">
            Single positions are never liquidated. When a floor breaks the whole account locks: trading halts, positions unwind, investors redeem at final
            NAV, and the lock is public on the trader&rsquo;s record.
          </p>
        </Card>
        <Card title="The platform takes no cut of profit">
          <p className="text-h11 leading-double text-fig-text-600">
            5% of a winning close covers running the thing; entry fees are the revenue. Nobody here earns more when a trader takes more risk.
          </p>
        </Card>
        <Card title="Nothing depends on us being online">
          <p className="text-h11 leading-double text-fig-text-600">
            Risk marks, locks, unwinds and redemption settlement are callable by anyone and paid from a ring-fenced bounty reserve. An exit never waits on
            the platform.
          </p>
        </Card>
      </div>

      {/* --------------------------------------------------------- markets */}
      <Card title="Which markets are listed" aside="Admin-curated, 5–8 at launch">
        <div className="grid gap-4 sm:grid-cols-4">
          <Figure value="$100k" label="Minimum top-of-book depth" />
          <Figure value="$1B" label="Minimum market cap" />
          <Figure value="90d" label="Minimum listing history" />
          <Figure value="Pyth" label="Oracle matching the venue mark" />
        </div>
        <p className="border-t border-dashed border-fig-stroke pt-4 text-h11 leading-double text-fig-text-600">
          Disabling a market blocks new positions but never blocks closing an open one.
        </p>
      </Card>

      {/* ------------------------------------------------------------- CTAs */}
      <div className="flex flex-wrap gap-3 pb-8">
        <button
          className="btn-lime w-auto px-6"
          onClick={() => {
            try {
              localStorage.setItem("kydo.walkthrough", "active:0");
            } catch {
              /* private mode */
            }
            window.dispatchEvent(new Event("kydo:walkthrough"));
          }}
        >
          Start the interactive walkthrough
        </button>
        <Link href="/" className="btn-pill w-auto px-6">
          Start as a trader
        </Link>
        <Link href="/invest" className="btn-pill w-auto px-6">
          Browse pools instead
        </Link>
      </div>
    </div>
  );
}
