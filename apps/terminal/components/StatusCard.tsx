"use client";
/**
 * Trader funnel (section 6.1) as a guided flow: one stepper driven by the on-chain
 * profile status + the active pool's state, exactly one primary call-to-action
 * per stage, section 5.4 criteria as a checklist, and every clock as a countdown.
 */
import BN from "bn.js";
import { effectiveVestDays } from "@kydo/sdk";
import { PublicKey, Transaction } from "@solana/web3.js";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { EmptyState, Pill, Skeleton, Spinner, Stepper, useToast, type Step } from "@kydo/ui";
import { trial as trialApi, indexer, type TrialState } from "@/lib/api";
import { isDefaultKey, isDefaultPoolName, liveNps, poolName, poolStatus, riskLike, type ChainPool } from "@/lib/chain";
import { CHAIN_POLL_MS, poolRecordUrl } from "@/lib/config";
import { ago, bytesToHex, countdown, fromPrice, hexToBytes, npsToFloat, pct, shortAddr, tierLabel, time, toPriceBN, usd, usdWhole } from "@/lib/format";
import { useNow, useTx } from "@/lib/hooks";
import { usePlatform } from "@/lib/platform";
import { useSigner, useVaultClient } from "@/lib/solana";
import { ClaimUsdc } from "./ClaimUsdc";
import { InstantOnboarding, type OnboardingStep } from "./InstantOnboarding";
import { ConfirmDialog } from "./ConfirmDialog";
import { Check, Gauge } from "./Gauge";
import { PoolForm } from "./PoolForm";
import { PromotionProgress } from "./PromotionProgress";
import { AccountSummary } from "./AccountSummary";
import { Card } from "./Surface";

const TRIAL_DAYS = 30;

const STEPS: Step[] = [
  { key: "apply", label: "Apply" },
  { key: "trial", label: "Trial" },
  { key: "commit", label: "Commit roots" },
  { key: "finalize", label: "Finalize" },
  { key: "pool", label: "Get funded" },
  { key: "fund", label: "Fund" },
  { key: "live", label: "Live" },
  { key: "promote", label: "Promote" },
];

export function StatusCard({ rail }: { rail?: ReactNode } = {}) {
  const p = usePlatform();
  const { client, readonly } = useVaultClient();
  const signer = useSigner();
  const { connection } = useConnection();
  const toast = useToast();
  const now = useNow(1000);
  const apply = useTx();
  const commit = useTx();
  const finalize = useTx();
  const activate = useTx();
  const seed = useTx();
  const closeTx = useTx();
  const promote = useTx();
  const queueTx = useTx();
  const [trialState, setTrialState] = useState<TrialState | null | undefined>(undefined);
  const [createdPool, setCreatedPool] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  // Instant-funding dialog state. Must live with the top hooks (early returns below)
  const [instantOpen, setInstantOpen] = useState(false);
  const [pool, setPool] = useState<ChainPool | null | undefined>(undefined);
  // Wallet USDC balance. Decides whether "Claim USDC" leads the apply stage
  const [usdcBal, setUsdcBal] = useState<number | null | "none">(null);
  useEffect(() => {
    const mint = p.usdcMint;
    const w = p.wallet;
    if (!w || !client || !mint) return;
    let alive = true;
    const refetch = () =>
      connection
        .getTokenAccountBalance(client.usdcAta(w, mint))
        .then((b) => alive && setUsdcBal(b.value.uiAmount ?? 0))
        .catch(() => alive && setUsdcBal("none"));
    void refetch();
    window.addEventListener("kydo:funded", refetch);
    return () => {
      alive = false;
      window.removeEventListener("kydo:funded", refetch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.wallet?.toBase58(), client, p.usdcMint?.toBase58(), connection]);
  const [investors, setInvestors] = useState<number | null>(null);

  const wallet = p.wallet;
  const profile = p.profile;
  const status = p.status;
  const cfg = p.config;

  // trial engine state (metrics preview / day roots)
  useEffect(() => {
    if (!wallet || status !== "trial") {
      setTrialState(undefined);
      return;
    }
    let alive = true;
    const load = () =>
      trialApi
        .state(wallet.toBase58())
        .then((s) => alive && setTrialState(s))
        .catch(() => alive && setTrialState(null));
    load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [wallet, status, profile?.trialDaysCommitted]);

  // active pool (chain) + investor count (indexer, optional)
  const poolAddr = createdPool ?? (profile && !isDefaultKey(profile.activePool) ? profile.activePool.toBase58() : null);
  useEffect(() => {
    if (!poolAddr) {
      setPool(undefined);
      setInvestors(null);
      return;
    }
    let alive = true;
    const load = () => {
      readonly
        .pool(new PublicKey(poolAddr))
        .then((x: ChainPool) => alive && setPool(x))
        .catch(() => alive && setPool(null));
      indexer
        .pool(poolAddr)
        .then((d) => alive && setInvestors(typeof d.investorCount === "number" ? d.investorCount : null))
        .catch(() => alive && setInvestors(null));
    };
    load();
    const t = setInterval(load, CHAIN_POLL_MS * 2);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [poolAddr, readonly]);

  // CommonPool funding queue (Vault Ledger section 2: both tracks converge here).
  // Polled only while Eligible without a pool. The stage the queue serves.
  const [ticket, setTicket] = useState<any | null | undefined>(undefined);
  const [commonPool, setCommonPool] = useState<any | null>(null);
  /** Everyone waiting, head first. The design's queue table lists them. */
  const [queueRows, setQueueRows] = useState<{ ticket: number; trader: string }[] | null>(null);
  // Also polled on the instant path before the pool exists: that is exactly
  // the window the onboarding wizard's step 2 describes, and it needs the same
  // answer. Funded now, or waiting behind someone.
  const eligibleNoPool = (status === "eligible" || (!!profile && fromPrice(profile.instantCap ?? 0) > 0)) && !poolAddr;
  useEffect(() => {
    if (!client || !wallet || !eligibleNoPool) {
      setTicket(undefined);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const [t, cp, all] = await Promise.all([
          (client.program.account as any).fundingTicket.fetchNullable(client.pda.ticket(wallet)),
          (client.program.account as any).commonPool.fetchNullable(client.pda.commonPool()),
          // Tickets are one small account each and only exist while waiting, so
          // listing them is cheap and gives the queue table real rows instead
          // of the design's mocked wallets.
          (client.program.account as any).fundingTicket.all().catch(() => []),
        ]);
        if (!alive) return;
        setTicket(t);
        setCommonPool(cp);
        setQueueRows(
          (all as any[])
            .map((x) => ({ ticket: Number(x.account.ticket), trader: x.account.trader.toBase58() }))
            .sort((a, b) => a.ticket - b.ticket),
        );
      } catch {
        if (alive) setTicket(null);
      }
    };
    void load();
    const t = setInterval(load, CHAIN_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, wallet?.toBase58(), eligibleNoPool]);
  const queuePos = ticket && commonPool ? Number(ticket.ticket) - Number(commonPool.nextToFund) : null;
  const queueDepth = commonPool ? Math.max(0, Number(commonPool.nextTicket) - Number(commonPool.nextToFund)) : null;
  const capUsdForQueue = profile ? (profile.tier === 0 ? fromPrice(profile.instantCap ?? 0) : fromPrice((p.config?.tierCaps ?? [])[Math.min(2, Math.max(0, (profile.tier || 1) - 1))] ?? 0)) : 0;
  const cpIdleUsd = commonPool ? fromPrice(commonPool.accountedIdle) : null;
  const cpAvailUsd = commonPool && cpIdleUsd !== null ? cpIdleUsd * (1 - (commonPool.reserveBps ?? 0) / 10_000) : null;
  // What the CommonPool actually puts in: the cap less the first-loss cushion
  // the trader's own fee seeds (`fund_next_in_queue`). Comparing against the
  // full cap under-reports capacity and would queue traders the chain would
  // have funded on the spot.
  const minFirstLossBps = p.config?.minFirstLossBps ?? 0;
  const allocationForQueue = capUsdForQueue * (1 - minFirstLossBps / 10_000);
  const hasCapacity = cpAvailUsd !== null && capUsdForQueue > 0 ? cpAvailUsd >= allocationForQueue : null;
  const canFundNow = queuePos === 0 && !!hasCapacity;

  // ---------- derived trial clocks ----------
  const daySecs = cfg?.trial.daySecs || 86400;
  const trialStart = profile ? Number(profile.trialStartTs.toString()) : 0;
  const elapsedDays = profile ? Math.max(0, Math.floor((now / 1000 - trialStart) / daySecs)) : 0;
  const committed = profile?.trialDaysCommitted ?? 0;
  const nextDay = committed;
  const nextDayEnds = trialStart + (nextDay + 1) * daySecs;
  const canCommit = committed < TRIAL_DAYS && elapsedDays >= nextDay + 1;
  const deadlineDay = nextDay + 1 + (cfg?.trial.commitGraceDays ?? 1);
  const deadlineTs = trialStart + (deadlineDay + 1) * daySecs;
  const missed = committed < TRIAL_DAYS && elapsedDays > deadlineDay;
  const trialEnds = trialStart + TRIAL_DAYS * daySecs;
  const pendingCommits = Math.max(0, Math.min(TRIAL_DAYS, elapsedDays) - nextDay);
  const allCommitted = committed >= TRIAL_DAYS;

  const cooldownUntil = profile ? Number(profile.cooldownUntil.toString()) : 0;
  const inCooldown = cooldownUntil * 1000 > now;

  const pStatus = pool ? poolStatus(pool) : null;
  const floor = cfg ? fromPrice(cfg.activationFloor) : 1000;
  const accounted = pool ? fromPrice(pool.accountedUsdc) : 0;
  const needDays = cfg?.risk.promotionDays ?? 30;
  const liveDays = pool?.liveDaysAtTier ?? profile?.liveDaysAtTier ?? 0;
  // NAV/share at the last keeper mark vs NAV/share when the tier began (the terminal's Pool tab uses live marks).
  const npsNow = pool ? liveNps(pool, new BN(pool.lastMarkNav)) : 0;
  const npsStart = pool ? npsToFloat(pool.tierStartNps) : 0;
  const npsOk = !!pool && npsNow > npsStart;
  const canPromote = !!pool && pStatus === "live" && pool.tier < 3 && liveDays >= needDays && npsOk;
  // The counter keeps accruing past the requirement (and legacy pools banked
  // compressed-clock days). Display clamps at the target once it is met.
  const liveDaysShown = Math.min(liveDays, needDays);

  // ---------- stage ----------
  const stage = useMemo((): { current: number; failedAt?: number } => {
    switch (status) {
      case "none":
        return { current: 0 };
      case "applied":
        return { current: 1 };
      case "trial":
        if (allCommitted) return { current: 3 };
        if (elapsedDays >= TRIAL_DAYS || missed) return { current: 2 };
        return { current: 1 };
      case "failed":
        return { current: 0, failedAt: 1 };
      case "frozen":
        return { current: 0, failedAt: 6 };
      case "eligible":
        if (!poolAddr) return { current: 4 };
        if (pStatus === "funding") return { current: 5 };
        if (pStatus === "live") return { current: canPromote ? 7 : 6 };
        if (pStatus === "locked" || pStatus === "settled") return { current: 6 };
        return { current: 5 };
      default:
        return { current: 0 };
    }
  }, [status, allCommitted, elapsedDays, missed, poolAddr, pStatus, canPromote]);

  const steps = useMemo<Step[]>(() => {
    const hint: Record<string, string | undefined> = {
      apply: cfg ? `${usd(fromPrice(cfg.entryFee))} entry fee` : undefined,
      trial: profile ? `day ${Math.min(elapsedDays, TRIAL_DAYS)} / ${TRIAL_DAYS}` : "30 days simulated",
      commit: `${committed} / ${TRIAL_DAYS} committed`,
      finalize: "evaluates the pass criteria",
      pool: cfg ? `queue · cap ${usdWhole(fromPrice(cfg.tierCaps[0]))}` : undefined,
      fund: `activates at ${usdWhole(floor)}`,
      live: pool ? `${Math.min(liveDays, needDays)} / ${needDays} days at ${tierLabel(pool.tier).toLowerCase()}` : undefined,
      promote: "cap ↑ in place",
    };
    return STEPS.map((s) => ({ ...s, hint: hint[s.key] }));
  }, [cfg, profile, elapsedDays, committed, floor, pool, liveDays, needDays]);

  // Instant-funded traders never had a trial. Their journey starts at "Get funded".
  // (also computed inline above, before the queue effect that needs it)
  const instantJourney = !!profile && fromPrice(profile.instantCap ?? 0) > 0;
  const journeySteps = instantJourney
    ? steps.slice(4).map((s, i) => (i === 0 && profile ? { ...s, hint: `Instant · cap ${usdWhole(fromPrice(profile.instantCap ?? 0))}` } : s))
    : steps;
  const journeyCurrent = instantJourney ? Math.max(0, stage.current - 4) : stage.current;
  const journeyFailedAt = stage.failedAt === undefined ? undefined : instantJourney ? Math.max(0, stage.failedAt - 4) : stage.failedAt;

  // ---------- early returns ----------
  if (!wallet) {
    return (
      <section className="panel">
        <div className="panel-body p-3 flex flex-col gap-3">
          <div className="label">Trader journey</div>
          <Stepper steps={STEPS} current={-1} />
          <EmptyState icon="◎" title="Connect a wallet to see your trader status">
            Phantom or Solflare on {process.env.NEXT_PUBLIC_NETWORK ?? "devnet"}. Applying pays the entry fee and starts a 30-day simulated trial.
          </EmptyState>
        </div>
      </section>
    );
  }
  if (!p.profileLoaded || !cfg) {
    return (
      <section className="panel">
        <div className="panel-body p-3 flex flex-col gap-3">
          <div className="label flex items-center gap-2">
            Trader journey
            <span className="num normal-case tracking-normal font-normal">{shortAddr(wallet.toBase58(), 6)}</span>
          </div>
          {p.chainError ? (
            <EmptyState icon="⚠" title="Chain unreachable">
              {p.chainError}
            </EmptyState>
          ) : (
            <>
              <Skeleton className="h-8 w-2/3" />
              <Skeleton className="h-10" />
              <div className="grid grid-cols-12 gap-3">
                <Skeleton className="col-span-8 h-40" />
                <Skeleton className="col-span-4 h-40" />
              </div>
            </>
          )}
        </div>
      </section>
    );
  }

  const entryFee = fromPrice(cfg.entryFee);

  // ---------- actions ----------
  /** Instant funding is one product at the Tier-1 cap. The program now requires
   *  `instant_cap == tierCaps[0]`. The old chooser could not change the price:
   *  the fee is `max(1.5 x entry_fee, 20% of cap)` and 20% of a cap that can
   *  never exceed Tier 1 never reaches the floor, so a smaller cap bought less
   *  capital for exactly the same money. */
  const instantCapUsd = fromPrice(cfg.tierCaps[0]);
  const instantFee = Math.max(entryFee * 1.5, (instantCapUsd * 2000) / 10_000);
  const doApply = (capUsd = 0) =>
    apply.run(
      capUsd > 0 ? "Applying. Instant funding…" : "Applying as trader…",
      async () => {
        if (!client || !p.usdcMint) throw new Error("wallet / USDC mint not ready");
        const ata = client.usdcAta(wallet, p.usdcMint);
        const info = await connection.getAccountInfo(ata);
        if (!info) {
          let faucet = false;
          try {
            faucet = !!(await indexer.health()).faucet;
          } catch {
            /* indexer offline. Assume no faucet */
          }
          throw new Error(
            faucet
              ? `Your wallet has no USDC yet. Press “Claim USDC” right below the Apply button (it creates your token account and mints test funds), then apply again`
              : `Your wallet has no USDC token account yet (${shortAddr(ata.toBase58())}) and this deployment has no faucet. Ask the platform admin to send you test USDC (pnpm devnet:bootstrap faucet ${shortAddr(wallet.toBase58())} 5000), then apply again`,
          );
        }
        const sig = await client.applyAsTrader(wallet, p.usdcMint, toPriceBN(capUsd)).rpc();
        await p.refreshProfile();
        return sig;
      },
      (sig) => ({
        title: capUsd > 0 ? "Instant funding active" : "Trial started",
        detail: capUsd > 0 ? `${usd(instantFee)} fee paid for a ${usd(capUsd)} cap. You are Eligible (Instant). Join the funding queue below.` : `${usd(entryFee)} entry fee paid to the treasury. 30 simulated days begin now.`,
        sig,
      }),
    );

  const doCommit = () =>
    commit.run(
      `Committing day ${nextDay} root…`,
      async () => {
        if (!client) throw new Error("wallet not ready");
        const r = await trialApi.root(wallet.toBase58(), nextDay);
        const sig = await client.commitTrialRoot(wallet, r.day, hexToBytes(r.root)).rpc();
        await p.refreshProfile();
        return { sig, r };
      },
      ({ sig, r }) => ({ title: `Day ${r.day} root committed`, detail: `${r.entries} entries attested on-chain.`, sig }),
    );

  /** Dev shortcut: commit every pending day root, up to 8 commit instructions per transaction. */
  const doCommitAll = () =>
    commit.run(
      `Committing ${pendingCommits} day roots…`,
      async () => {
        if (!client) throw new Error("wallet not ready");
        let done = 0;
        let day = nextDay;
        const last = Math.min(TRIAL_DAYS, elapsedDays);
        const txs: Transaction[] = [];
        while (day < last) {
          const batch: number[] = [];
          while (day < last && batch.length < 8) batch.push(day++);
          const tx = new Transaction();
          for (const d of batch) {
            const r = await trialApi.root(wallet.toBase58(), d);
            tx.add(await client.commitTrialRoot(wallet, r.day, hexToBytes(r.root)).instruction());
          }
          txs.push(tx);
          done += batch.length;
        }
        // One wallet approval signs every batch (signAllTransactions under the hood).
        const sigs = txs.length ? await client.provider.sendAll!(txs.map((tx) => ({ tx }))) : [];
        await p.refreshProfile();
        return { done, sigs };
      },
      ({ done, sigs }) => ({ title: `${done} day roots committed`, detail: `${sigs.length} transaction${sigs.length === 1 ? "" : "s"}.`, sig: sigs[sigs.length - 1] }),
    );

  /** DEV ONLY: sweep every elapsed day root, then force-finalize. One button from Trial to Eligible. */
  const relaxedGrace = (cfg?.trial.commitGraceDays ?? 1) >= 365; // mirrors the program: grace >= 365 waives day roots at finalize
  const doPassTrial = () =>
    finalize.run(
      relaxedGrace ? "Passing trial (dev): finalizing with attested metrics…" : `Passing trial (dev): committing roots as days end (~${Math.max(0, (TRIAL_DAYS - Math.min(TRIAL_DAYS, elapsedDays)) * daySecs)}s), then finalizing…`,
      async () => {
        if (!client || !signer) throw new Error("wallet not ready");
        // An empty trial cannot continue. Check before spending signatures on root commits.
        const mNow = await trialApi.metrics(wallet.toBase58()).catch(() => null);
        if (mNow && (mNow.trades ?? 0) === 0) throw new Error("no trades in this trial yet. Open the terminal and place at least one order first");
        // Relaxed grace (demo): the program accepts finalize without day roots,
        // so skip the day-by-day commit loop entirely.
        // Strict grace: the program only accepts a root once its day has ended,
        // so this runs until day 30: commit whatever has elapsed (8 per tx),
        // sleep out the rest, sweep again.
        let day = relaxedGrace ? TRIAL_DAYS : nextDay;
        while (day < TRIAL_DAYS) {
          const target = Math.min(TRIAL_DAYS, Math.floor((Date.now() / 1000 - trialStart) / daySecs));
          // Build every committable batch, then sign them ALL in one wallet approval.
          const txs: Transaction[] = [];
          while (day < target) {
            const batch: number[] = [];
            while (day < target && batch.length < 8) batch.push(day++);
            const tx = new Transaction();
            for (const d of batch) {
              const r = await trialApi.root(wallet.toBase58(), d);
              tx.add(await client.commitTrialRoot(wallet, r.day, hexToBytes(r.root)).instruction());
            }
            txs.push(tx);
          }
          if (txs.length) await client.provider.sendAll!(txs.map((tx) => ({ tx })));
          if (day >= TRIAL_DAYS) break;
          await new Promise((res) => setTimeout(res, Math.max(1500, daySecs * 1000)));
        }
        const r = await trialApi.finalize(signer, true);
        if (!r.ok) throw new Error(r.error ?? "finalize failed");
        await p.refreshProfile();
        return r;
      },
      (r) => (r.passed ? { title: "Trial passed (forced · dev)", detail: "All roots committed and metrics attested. You are Eligible. Join the funding queue below.", sig: r.sig } : { title: "Trial failed", detail: `Reason: ${r.failReason ?? "?"}.`, sig: r.sig }),
    );

  const doFinalize = (force = false) =>
    finalize.run(
      force ? "Finalizing (forced pass)…" : "Finalizing trial…",
      async () => {
        if (!signer) throw new Error("wallet cannot sign messages");
        const r = await trialApi.finalize(signer, force);
        if (!r.ok) throw new Error(r.error ?? "finalize failed");
        await p.refreshProfile();
        return r;
      },
      (r) =>
        r.passed
          ? { title: `Trial passed${r.forced ? " (forced · dev)" : ""}`, detail: "You are Eligible. Join the funding queue for your Tier 1 allocation.", sig: r.sig }
          : { title: "Trial failed", detail: `Reason: ${r.failReason ?? "?"}. A ${cooldownText} cooldown applies before re-applying.`, sig: r.sig },
    );

  const doActivate = () =>
    activate.run(
      "Activating pool…",
      async () => {
        if (!client || !poolAddr) throw new Error("wallet not ready");
        const sig = await client.activatePool(new PublicKey(poolAddr), client.pda.trader(wallet!)).rpc();
        await p.refreshProfile();
        return sig;
      },
      (sig) => ({ title: "Pool is Live", detail: "You can now trade investor capital in the terminal.", sig }),
    );

  /**
   * Section 4.4 lets ANY wallet deposit (min $50), the trader's included, so the funding stage
   * doesn't have to wait for outside investors: one signature deposits the trader's own
   * USDC up to the activation floor and activates, both instructions in one transaction.
   */
  const doSeedFund = () =>
    seed.run(
      "Seeding pool & activating…",
      async () => {
        if (!client || !wallet || !poolAddr || !pool || !p.usdcMint || !p.registry) throw new Error("wallet or chain state not ready");
        const poolPk = new PublicKey(poolAddr);
        const amount = Math.max(floor - accounted, fromPrice(cfg.minDeposit));
        const tx = new Transaction();
        tx.add(await client.deposit(wallet, poolPk, p.usdcMint, toPriceBN(amount), client.oracleMetas(p.registry.markets, pool)).instruction());
        tx.add(await client.activatePool(poolPk, client.pda.trader(wallet)).instruction());
        const sig = await client.provider.sendAndConfirm!(tx);
        await p.refreshProfile();
        return { sig, amount };
      },
      (r) => ({ title: "Pool is Live", detail: `Seeded ${usd(r.amount)} of your own USDC and activated. You now also hold investor shares in your pool. Trading is open.`, sig: r.sig }),
    );

  /** Voluntary close from Home. One click when flat; positions must be closed in the terminal first. */
  const doClosePool = () =>
    closeTx.run(
      "Closing pool…",
      async () => {
        if (!client || !wallet || !poolAddr) throw new Error("wallet not ready");
        const sig = await client.closePool(wallet, new PublicKey(poolAddr)).rpc();
        await p.refreshProfile();
        return sig;
      },
      (sig) => ({ title: "Pool closed (voluntary)", detail: "The Common Pool’s stake redeems at final NAV, escrow keeps vesting, your tier is kept. Create a new pool below whenever you like.", sig }),
    );

  const doPromote = () =>
    promote.run(
      "Promoting tier…",
      async () => {
        if (!client || !poolAddr || !pool || !p.registry) throw new Error("wallet not ready");
        const sig = await client.promoteTier(wallet, new PublicKey(poolAddr), client.pda.trader(wallet), client.oracleMetas(p.registry.markets, pool)).rpc();
        await p.refreshProfile();
        return sig;
      },
      (sig) => ({ title: `Promoted to Tier ${Math.min(3, (pool?.tier ?? 1) + 1)}`, detail: "The same pool now accepts more capital.", sig }),
    );

  const copyPoolLink = async () => {
    if (!poolAddr) return;
    try {
      await navigator.clipboard.writeText(poolRecordUrl(poolAddr));
      toast.push({ kind: "success", title: "Pool link copied", detail: poolRecordUrl(poolAddr) });
    } catch {
      toast.push({ kind: "info", title: "Pool link", detail: poolRecordUrl(poolAddr) });
    }
  };

  const doJoinQueue = () =>
    queueTx.run(
      "Joining the funding queue…",
      async () => {
        if (!client || !wallet) throw new Error("wallet not ready");
        const sig = await client.queueForFunding(wallet, wallet).rpc();
        await p.refreshProfile();
        return sig;
      },
      (sig) => ({
        title: "In the funding queue",
        detail: "Strictly first in, first funded: your pool is created and funded automatically from the CommonPool the moment capital is free. Your fee goes in as first-loss seed.",
        sig,
      }),
    );

  const doFundNow = () =>
    queueTx.run(
      "Funding from the CommonPool…",
      async () => {
        if (!client || !wallet || !profile || !p.usdcMint || !ticket) throw new Error("wallet or queue state not ready");
        const sig = await client
          .fundNextInQueue(wallet, client.usdcAta(wallet, p.usdcMint), wallet, profile.poolsCreated, new PublicKey(ticket.payer), p.usdcMint)
          .rpc();
        await p.refreshProfile();
        return sig;
      },
      (sig) => ({ title: "Pool funded from the CommonPool", detail: "Your pool is Live. The allocation plus your fee-seed arrived in one instruction.", sig }),
    );

  // ---------- primary CTA ----------
  const anyBusy = apply.busy || commit.busy || finalize.busy || activate.busy || seed.busy || closeTx.busy || promote.busy || queueTx.busy;
  let primary: { label: string; onClick?: () => void; href?: string; disabled?: boolean; title?: string; tone?: "primary" | "up" } | null = null;
  const openTerminal = (label: string) => ({ label, href: "/terminal" });
  switch (status) {
    case "none":
      primary = { label: `Apply · ${usdWhole(entryFee)}`, onClick: () => doApply(0), disabled: apply.busy || !client, title: !client ? "Connect a wallet first" : undefined };
      break;
    case "applied":
      primary = { label: "Refresh profile", onClick: () => void p.refreshProfile() };
      break;
    case "trial":
      {
        // With a grace window covering the whole trial (demo configs), the mid-run commit
        // nag is noise: trade first, sweep every root once all days have elapsed.
        const relaxed = (cfg?.trial.commitGraceDays ?? 1) >= TRIAL_DAYS;
        if (missed) primary = { label: "Finalize (record missed day)", onClick: () => doFinalize(false), disabled: anyBusy || !signer, title: !signer ? "Wallet cannot sign messages" : undefined };
        else if (allCommitted)
          primary = { label: "Finalize trial", onClick: () => doFinalize(false), disabled: anyBusy || !signer, title: !signer ? "Wallet cannot sign messages" : "Evaluates the real pass criteria. Use Pass trial (dev) to bypass them" };
        else if (canCommit && pendingCommits >= 2 && (!relaxed || elapsedDays >= TRIAL_DAYS)) primary = { label: `Commit all ${pendingCommits} pending days`, onClick: doCommitAll, disabled: anyBusy || !client, title: "One signature per 8 days. Each root still binds its own day's log" };
        else if (canCommit && !relaxed) primary = { label: `Commit day ${nextDay} root`, onClick: doCommit, disabled: anyBusy || !client };
        else primary = openTerminal("Open terminal");
      }
      break;
    case "failed":
    case "frozen":
      primary = { label: `Re-apply · ${usdWhole(entryFee)}`, onClick: () => doApply(0), disabled: apply.busy || !client || inCooldown, title: inCooldown ? `Cooldown ends in ${countdown(cooldownUntil)}` : undefined };
      break;
    case "eligible":
      if (!poolAddr)
        primary =
          ticket === undefined
            ? null // still loading queue state
            : ticket === null
              ? { label: "Join the funding queue", onClick: doJoinQueue, disabled: anyBusy || !client, tone: "up", title: "Both tracks converge here. The Common Pool creates and funds your pool automatically, strictly in order, with your fee injected as first-loss seed capital." }
              : canFundNow
                ? { label: "Fund my pool now", onClick: doFundNow, disabled: anyBusy || !client, tone: "up", title: "Permissionless. The keeper does this automatically too; pressing it just skips the wait." }
                : null; // queued: the status tiles below explain the wait
      else if (pStatus === "funding")
        primary =
          accounted >= floor
            ? { label: "Activate pool", onClick: doActivate, disabled: anyBusy || !client, tone: "up" }
            : {
                label: `Seed ${usd(Math.max(floor - accounted, fromPrice(cfg.minDeposit)))} & activate`,
                onClick: doSeedFund,
                disabled: anyBusy || !client || !pool,
                tone: "up",
                title: "Deposit your own USDC up to the activation floor and go Live. One signature. Investors do not fund traders one by one, so nothing arrives on its own: seed it, or wait for the Common Pool to reach you.",
              };
      else if (pStatus === "live") primary = canPromote ? { label: `Promote to Tier ${Math.min(3, (pool?.tier ?? 1) + 1)}`, onClick: doPromote, disabled: anyBusy || !client, tone: "up" } : openTerminal("Open terminal");
      else primary = openTerminal("Open terminal");
      break;
  }

  const statusTone = status === "trial" ? "warn" : status === "eligible" ? "good" : status === "failed" || status === "frozen" ? "bad" : "neutral";
  const poolTone = pStatus === "live" ? "good" : pStatus === "funding" ? "info" : "bad";
  const curTier = pool?.tier ?? profile?.tier ?? 1;
  const isInstant = curTier === 0;
  const tierIdx = Math.min(2, Math.max(0, curTier - 1));
  const tierCapStr = isInstant ? usd(fromPrice(profile?.instantCap ?? cfg.tierCaps[0])) : usd(fromPrice(cfg.tierCaps[tierIdx]));
  /* What a tier is, in the three numbers promotion can move. Vesting goes
     through `effectiveVestDays` because instant funding vests on the Tier 2
     schedule, not `vestDays[0]`. Reading the array by `tier - 1` clamps to 0
     and reports the faster schedule, which is how the promotion card came to
     claim "14 days → 14 days". Loss limits go through `riskLike`, which is
     where the instant tier's tighter 3% / 8% live. */
  /* Distance to whichever lock floor binds, from the pool account itself.
     `dayStartNav` and `peakNav` are on chain, so the account page can say this
     without the terminal's backend state. `riskLike` because the instant tier
     trades under tighter floors than the platform's. */
  const lockRoom = (() => {
    if (!pool || pStatus !== "live") return null;
    const r = riskLike(cfg.risk, pool.tier);
    const nav = fromPrice(pool.lastMarkNav);
    const dayFloor = fromPrice(pool.dayStartNav) * (1 - r.dailyLossBps / 10_000);
    const ddFloor = fromPrice(pool.peakNav) * (1 - r.maxDrawdownBps / 10_000);
    const daily = dayFloor >= ddFloor;
    const floor = Math.max(dayFloor, ddFloor);
    const budget = daily ? fromPrice(pool.dayStartNav) * (r.dailyLossBps / 10_000) : fromPrice(pool.peakNav) * (r.maxDrawdownBps / 10_000);
    const room = Math.max(0, nav - floor);
    return { usd: room, which: daily ? "Today's loss limit" : "The drawdown floor", ofBudget: budget > 0 ? Math.min(1, room / budget) : 1 };
  })();

  const tierFacts = (tier: number) => {
    const r = riskLike(cfg.risk, tier);
    return [
      { label: "Vesting", value: `${effectiveVestDays(cfg.vestDays ?? [], tier)} days` },
      { label: "Daily loss", value: `${(r.dailyLossBps / 100).toFixed(r.dailyLossBps % 100 ? 1 : 0)}%` },
      { label: "Drawdown", value: `${(r.maxDrawdownBps / 100).toFixed(r.maxDrawdownBps % 100 ? 1 : 0)}%` },
    ];
  };
  const cooldownSecsCfg = cfg?.risk.cooldownSecs ?? 604_800;
  const cooldownText = cooldownSecsCfg >= 86_400 ? `${Math.round(cooldownSecsCfg / 86_400)}-day` : cooldownSecsCfg >= 60 ? `${Math.round(cooldownSecsCfg / 60)}-minute` : `${cooldownSecsCfg}-second`;
  const noPoolYet = status === "eligible" && !poolAddr;
  const lockLabel = pool?.lockReason ? ["none", "daily loss", "drawdown", "voluntary"][pool.lockReason] ?? String(pool.lockReason) : "";

  // ---------- hero copy (one headline per stage) ----------
  let heroTitle: React.ReactNode = "Trader journey";
  // One sentence. Anything a trader does not need in order to decide what to do
  // next goes in `heroMore`, behind a disclosure. This card used to open with
  // a paragraph in every state.
  let heroSub = "";
  let heroMore = "";
  let heroCls = "";
  let nowTitle = "Now";
  switch (status) {
    case "none":
      heroTitle = "Apply to start the 30-day trial";
      heroSub = `Trade a ${usd(fromPrice(cfg.trial.startingBalance))} simulated account for 30 days, or pay to skip it.`;
      heroMore = `Any wallet may apply. No KYC. The ${usd(entryFee)} USDC entry fee transfers atomically to the treasury and is non-refundable per attempt. The trial runs on live prices under the same risk limits a funded account trades under.`;
      nowTitle = "Before you apply";
      break;
    case "applied":
      heroTitle = "Profile created, trial not started";
      heroSub = "This state should not persist. Refresh, or re-apply if it does.";
      nowTitle = "Profile";
      break;
    case "trial":
      heroTitle = (
        <>
          Simulated trial · day <span className="num">{Math.min(elapsedDays, TRIAL_DAYS)}</span> of {TRIAL_DAYS}
        </>
      );
      heroSub =
        (cfg?.trial.commitGraceDays ?? 1) >= TRIAL_DAYS
          ? "Trade freely. Press “Commit all” once at the end."
          : "Trade in the terminal and commit each day's root as it closes.";
      heroMore = `Started ${time(trialStart)} · day length ${daySecs}s · ${committed} / ${TRIAL_DAYS} day roots on-chain. Every order is hash-chained and its daily merkle root goes on-chain, so the record cannot be rewritten afterwards.`;
      nowTitle = "Pass criteria";
      break;
    case "failed":
      heroTitle = "Trial failed";
      heroCls = "text-down";
      heroSub = `Re-apply after a ${cooldownText} cooldown. The ${usd(entryFee)} fee is charged again.`;
      heroMore = "Your trade log stays exportable and verifiable, so the attempt is still a record you can show.";
      nowTitle = "What happens next";
      break;
    case "frozen":
      heroTitle = "Pool locked by a risk breach";
      heroCls = "text-down";
      heroSub = `Re-applying restarts from the trial at Tier 1${inCooldown ? " after the cooldown" : ""}.`;
      heroMore = "The lock is shown publicly on your record, your tier is reset, and unvested escrow was returned to investors.";
      nowTitle = "What happens next";
      break;
    case "eligible":
      if (!poolAddr) {
        if (ticket) {
          heroTitle = (
            <>
              In the funding queue · ticket <span className="num">#{Number(ticket.ticket)}</span>
            </>
          );
          heroCls = "text-up";
          heroSub =
            queuePos === 0
              ? `You're next. Funding runs the moment the pool covers your ${tierCapStr} cap.`
              : `${queuePos} trader${queuePos === 1 ? "" : "s"} ahead of you.`;
          heroMore =
            "Strictly first in, first funded. Your pool is created and funded automatically when your turn comes. The keeper calls it, and anyone may trigger it. Your fee goes in as the first-loss cushion.";
          nowTitle = "Funding queue";
        } else {
          heroTitle = isInstant ? "You're funded (join the funding queue" : "You passed) join the funding queue";
          heroCls = "text-up";
          heroSub = `${isInstant ? "Instant funding" : `Tier ${Math.max(1, profile?.tier ?? 1)}`} · cap ${tierCapStr}. Join the queue and funding is automatic.`;
          heroMore = "Both tracks converge here. The Common Pool creates and funds your pool up to your cap, strictly in order. No investors to court and no manual setup.";
          nowTitle = "Get funded";
        }
      } else {
        /* The tier rides in the pill group beside the title now. A name and
           a tier are two kinds of fact, and joining them with a middot inside
           one h1 was half of why the header read as a run-on. (Tier 0 is the
           instant-funding marker internally; `tierLabel` says what it is.) */
        heroTitle = pool ? (isDefaultPoolName(poolName(pool)) ? "Your pool" : poolName(pool) || `Pool #${pool.index}`) : "Active pool";
        heroSub =
          pStatus === "funding"
            ? "Seed it to the activation floor with your own USDC to go Live."
            : pStatus === "live"
              ? "Live. You are trading investor capital under the platform risk limits."
              : pStatus
                ? `Pool is ${pStatus}${lockLabel ? ` (${lockLabel})` : ""}.`
                : "";
        heroMore =
          pStatus === "funding"
            ? "Investor capital arrives through the Common Pool when your turn comes. Nobody can deposit into your pool directly."
            : pStatus === "live"
              ? "80% of each winning close escrows to you and vests; it pays out above the pool's high-water mark and later losses drain it first."
              : pStatus
                ? "The Common Pool's stake redeems at final NAV; your escrow keeps vesting."
                : "";
        nowTitle = pStatus === "funding" ? "Funding" : pStatus === "live" ? (pool && pool.tier < 3 ? `Promotion to Tier ${pool.tier + 1}` : "Pool") : "Pool";
      }
      break;
  }

  const secondary: { label: string; href?: string; onClick?: () => void; title?: string }[] = [];
  const showInstant = (status === "none" || status === "failed" || status === "frozen") && !inCooldown;
  /** Funded and trading: the onboarding wizard has finished its job. */
  const journeyDone = instantJourney && !!poolAddr && pStatus === "live";
  /** One source of truth. The stepper below stands down exactly when this is up. */
  const wizardVisible = (showInstant || instantJourney) && !journeyDone;
  // Can't pay the entry fee → claiming test USDC is the real first step
  const needsUsdc = showInstant && usdcBal !== null && (usdcBal === "none" || usdcBal < entryFee);
  const openInstant = () => setInstantOpen(true);
  if (status === "trial" && p.trialDevForcePass && !allCommitted)
    secondary.push({
      label: "Pass trial (dev)",
      onClick: () => void doPassTrial(),
      title: relaxedGrace ? "Finalizes immediately with attested passing metrics. No day roots needed on this deployment; dev only" : `Commits every day root as its day ends (ONE wallet approval per sweep), waits out the remaining ${Math.max(0, TRIAL_DAYS - Math.min(TRIAL_DAYS, elapsedDays))} day(s) automatically, then finalizes with forced metrics. Keep the tab open; dev deployments only`,
    });
  if (primary?.href !== "/terminal" && (status === "trial" || (status === "eligible" && poolAddr))) secondary.push({ label: "Open terminal", href: "/terminal" });
  if (status === "eligible" && poolAddr) secondary.push({ label: "View pool page", href: `/invest/${poolAddr}`, title: "Your pool's public detail page. Stats, equity curve, trades, deposits" });
  if (status === "eligible" && poolAddr) secondary.push({ label: "Copy link", onClick: copyPoolLink, title: poolRecordUrl(poolAddr) });
  if (status === "eligible" && poolAddr && (pStatus === "funding" || pStatus === "live"))
    secondary.push(
      pool && pool.openPositions > 0
        ? { label: "Close pool", href: "/terminal", title: "Go flat in the terminal first. A pool can only close with no open positions" }
        : { label: "Close pool…", onClick: () => setConfirmClose(true), title: "Voluntary close: the Common Pool’s stake redeems at final NAV, escrow keeps vesting, you keep your tier. Frees you to create a new pool." },
    );
  if (!instantJourney && (status === "trial" || status === "failed" || status === "frozen" || status === "eligible")) secondary.push({ label: "Export & verify log", href: "/trial/export" });

  return (
    // 32 px between bands, as the Rulebook sets them. This page had 12, which
    // is most of why one reads as designed and the other as packed.
    <div className="flex flex-col gap-6" aria-labelledby="journey-title">
      <ConfirmDialog
        open={instantOpen}
        title="Instant Funding"
        confirmLabel={`Pay ${usd(instantFee)} & get funded`}
        tone="primary"
        busy={apply.busy}
        error={apply.error}
        onCancel={() => setInstantOpen(false)}
        onConfirm={() => {
          void doApply(instantCapUsd).then((r) => {
            if (r) setInstantOpen(false);
          });
        }}
      >
        <div className="flex flex-col gap-2">
          <p>Skip the 30-day trial entirely. No evaluation. The fee and disclosure replace it.</p>
          <div className="kv-list flex flex-col text-xxs">
            <div className="kv">
              <span>Funding cap</span>
              <span className="num text-fg">{usd(instantCapUsd)}</span>
            </div>
            <div className="kv">
              <span>Fee</span>
              <span className="num text-amber">{usd(instantFee)}</span>
            </div>
            <div className="kv">
              <span>Loss limits</span>
              <span>Tighter until first promotion: 3% daily / 8% drawdown (vs {(cfg.risk.dailyLossBps / 100).toFixed(0)}% / {(cfg.risk.maxDrawdownBps / 100).toFixed(0)}%)</span>
            </div>
            <div className="kv">
              <span>Vesting</span>
              <span>Tier 2 schedule (slower) until first promotion</span>
            </div>
            <div className="kv">
              <span>Disclosure</span>
              <span>&ldquo;Instant · no trial record&rdquo; badge on your pool</span>
            </div>
          </div>
        </div>
      </ConfirmDialog>

      {/* Onboarding wizard (docs/design/onboarding-flow-spec.md). Presentational.
          It reads the journey this component already derives, and step 1's CTA is
          the same openInstant/doApply path as the Instant Funding button below,
          so there is exactly one paying implementation. */}
      {/* The wizard's job is getting funded. Once the pool is live it has
          nothing left to say, and its "Open Terminal" CTA sat directly above
          this card's identical primary. Two lime buttons, same action, on
          every visit. It stands down at that point and the card below is the
          single surface. */}
      {wizardVisible && (
        <InstantOnboarding
          current={(!instantJourney ? 0 : !poolAddr ? 1 : pStatus !== "live" ? 2 : 3) as OnboardingStep}
          settling={!!poolAddr && pool === undefined}
          seatPrice={instantFee}
          fundedCap={instantJourney && profile ? fromPrice(profile.instantCap ?? 0) : instantCapUsd}
          tierCaps={(cfg.tierCaps ?? []).slice(0, 3).map((c) => fromPrice(c))}
          vestDays={cfg.vestDays?.[0] ?? 14}
          connected={!!wallet && !!client}
          queue={{
            position: queuePos,
            ahead: queuePos === null ? null : Math.max(0, queuePos),
            depth: queueDepth,
            availableUsd: cpAvailUsd,
            needsUsd: capUsdForQueue > 0 ? allocationForQueue : null,
            hasCapacity,
            // A window of the queue: the head, then the trader and their
            // neighbours. The whole queue could be long and only the nearby
            // rows tell them anything.
            rows: (queueRows ?? []).slice(0, Math.max(4, (queuePos ?? 0) + 2)).map((r) => ({
              ticket: r.ticket,
              wallet: shortAddr(r.trader),
              you: !!wallet && r.trader === wallet.toBase58(),
            })),
          }}
          onDeposit={showInstant ? openInstant : undefined}
          depositBusy={apply.busy}
          depositBlockedReason={
            // No "connect a wallet" case: with no wallet the panel renders the
            // connector itself, so a blocked-reason saying the same thing would
            // sit under a button that already says it.
            needsUsdc ? `The ${usd(instantFee)} deposit needs USDC. Claim test USDC below first.` : undefined
          }
        />
      )}
      <ConfirmDialog
        open={confirmClose}
        title={`Close pool ${pool ? `\u201c${poolName(pool) || `#${pool.index}`}\u201d ` : ""}permanently?`}
        tone="danger"
        confirmLabel="Close pool"
        typeToConfirm="CLOSE"
        busy={closeTx.busy}
        error={closeTx.error}
        onCancel={() => setConfirmClose(false)}
        onConfirm={() => {
          void doClosePool().then((r) => {
            if (r) setConfirmClose(false);
          });
        }}
      >
        <p>
          This cannot be undone. The pool stops trading and moves to <b>Locked (voluntary)</b>. The Common Pool’s stake redeems at final NAV, your escrow keeps vesting, and you keep Tier {pool?.tier ?? 1}. The create-pool form reappears here afterwards.
        </p>
        <p className="mt-2">
          <b className="text-fg">Claim your escrow once it vests.</b> On a voluntarily closed pool, escrow left unclaimed after twice the vesting period returns to the Common Pool when the pool is wound up.
        </p>
      </ConfirmDialog>
      {/* ================= hero ================= */}
      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-4">
            {/* Five things of four different kinds used to sit on one line at
                one gap: a section label, two status pills, and two bare
                monospace addresses. The first of which had no label at all, so
                nothing said it was the wallet. Grouped by kind instead, with
                the vertical rhythm opened from 6 px to 12 px so the blocks read
                as blocks:

                  identity + state   what this is and how it is doing
                  one sentence       what that means
                  addresses          reference, quieter, and labelled
                  disclosure         the long version, on its own

                The "Account" label went with it: the pills say the state, and
                the page is the account page. */}
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h1 id="journey-title" className={`text-xl font-semibold leading-none tracking-tight ${heroCls}`}>
                  {heroTitle}
                </h1>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Pill tone={statusTone} dot>
                    {status}
                  </Pill>
                  {pStatus && (
                    <Pill tone={poolTone} dot>
                      pool {pStatus}
                    </Pill>
                  )}
                  {pool && <Pill tone={isInstant ? "warn" : "neutral"}>{tierLabel(pool.tier)}</Pill>}
                </span>
              </div>

              {heroSub && <p className="max-w-3xl text-xs leading-relaxed text-muted">{heroSub}</p>}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-h11 text-fig-text-600">
                <span>
                  wallet{" "}
                  <span className="num text-muted" title={wallet.toBase58()}>
                    {shortAddr(wallet.toBase58(), 6)}
                  </span>
                </span>
                {poolAddr && (
                  <span>
                    pool{" "}
                    <span className="num text-muted" title={poolAddr}>
                      {shortAddr(poolAddr, 6)}
                    </span>
                  </span>
                )}
                {pool && isDefaultPoolName(poolName(pool)) && (
                  <span title="The on-chain name the Common Pool writes when it funds a pool">
                    on-chain name <span className="num text-muted">{poolName(pool)}</span>
                  </span>
                )}
                {p.traderDetail && p.traderDetail.profile.status !== status && (
                  <span className="text-amber" title="The indexer has not caught up with the chain yet">
                    indexer says {p.traderDetail.profile.status}
                  </span>
                )}
              </div>

              {heroMore && (
                <details className="disclosure max-w-3xl">
                  <summary>How this works</summary>
                  <p className="pt-1 text-xs leading-relaxed text-muted">{heroMore}</p>
                </details>
              )}
            </div>

            <div className="flex flex-col gap-1.5 w-full sm:w-[21rem] shrink-0" data-tour="primary-cta">
              {needsUsdc && (
                <>
                  <ClaimUsdc />
                  <div className="text-xxs text-muted text-center">
                    {usdcBal === "none" ? "This wallet holds no test USDC yet" : `Wallet holds ${usd(usdcBal as number)}. The fee is ${usd(entryFee)}`}
                  </div>
                </>
              )}
              <div className={`grid gap-1.5 ${showInstant && primary ? "grid-cols-2" : "grid-cols-1"}`}>
                {primary &&
                  (primary.href ? (
                    <Link href={primary.href} className="btn-lime h-10 min-w-0 px-4" title={primary.title}>
                      {primary.label}
                    </Link>
                  ) : (
                    <button
                      className="btn-lime h-10 min-w-0 px-4"
                      disabled={primary.disabled || needsUsdc}
                      onClick={primary.onClick}
                      title={needsUsdc ? `The ${usd(entryFee)} fee needs USDC. Claim test USDC above first` : primary.title}
                      aria-busy={anyBusy}
                    >
                      {anyBusy && <Spinner />}
                      {anyBusy ? "Working…" : primary.label}
                    </button>
                  ))}
                {showInstant && (
                  <button
                    className="btn-pill h-10 min-w-0 px-4"
                    disabled={apply.busy || !client || needsUsdc}
                    onClick={openInstant}
                    title={`Skip the trial at the Tier 1 cap (${usdWhole(fromPrice(cfg.tierCaps[0]))}) for max(${usd(entryFee * 1.5)}, 20% of it). Non-refundable. Tighter loss limits, slower vesting and a public "no trial record" badge until your first promotion.`}
                  >
                    Instant Funding
                  </button>
                )}
              </div>
              {showInstant && !needsUsdc && <ClaimUsdc variant="ghost" />}
              {noPoolYet && !ticket && <div className="text-xxs text-muted text-center">Join the queue, or create a self-funded pool from the disclosure below</div>}
              {noPoolYet && ticket && queuePos !== 0 && <div className="text-xxs text-muted text-center">Funding arrives automatically when your turn comes</div>}
              {noPoolYet && ticket && queuePos === 0 && !canFundNow && <div className="text-xxs text-muted text-center">You're next. Waiting for CommonPool idle capital to cover your cap</div>}
              {secondary.length > 0 && (
                <div className="flex flex-wrap gap-1.5 justify-end">
                  {secondary.map((s) =>
                    s.href ? (
                      <Link key={s.label} href={s.href} className="btn btn-sm">
                        {s.label}
                      </Link>
                    ) : (
                      <button key={s.label} className="btn btn-sm" onClick={s.onClick} title={s.title}>
                        {s.label}
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          </div>
          {/* The onboarding wizard renders the same four steps with more detail
              and a panel per state. Two step indicators for one journey is one
              too many, so the stepper stands down while it is up, and comes
              back once it retires, which is when this card takes over. */}
          {!wizardVisible && pStatus !== "live" && <Stepper steps={journeySteps} current={journeyCurrent} failedAt={journeyFailedAt} />}
        </div>
      </Card>

      {/* The account's actual state, in its own band. Live pools only: before
          funding there is no capital, no tier clock and no lock floor to near. */}
      {pStatus === "live" && pool && (
        <AccountSummary
          capital={fromPrice(pool.lastMarkNav)}
          cap={isInstant ? fromPrice(profile?.instantCap ?? cfg.tierCaps[0]) : fromPrice(cfg.tierCaps[tierIdx])}
          nps={npsNow}
          npsStart={npsStart}
          room={lockRoom}
          escrowTotal={fromPrice(pool.escrowTotal)}
          escrowClaimable={fromPrice(pool.vestedClaimable)}
        />
      )}

      {/* ================= now + rail ================= */}
      <div className="grid grid-cols-12 gap-4 items-stretch">
        <Card
          className={`col-span-12 min-w-0 lg:col-span-8 ${heroCls === "text-up" ? "stage-up" : heroCls === "text-down" ? "stage-down" : status === "trial" ? "stage-warn" : ""}`}
          title={nowTitle}
          aside={
            status === "trial" ? (
              <span className="num">
                {Math.min(elapsedDays, TRIAL_DAYS)} / {TRIAL_DAYS} days · {committed} roots
              </span>
            ) : pool && pStatus === "live" ? (
              <span className="num" title={time(Number(pool.lastMarkTs.toString()))}>
                marked {ago(Number(pool.lastMarkTs.toString()))}
              </span>
            ) : undefined
          }
        >
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {status === "none" && (
              <>
                <div className="grid grid-cols-2 gap-1.5">
                  <Check ok label="Wallet connected" value={shortAddr(wallet.toBase58())} />
                  <Check ok={!!p.usdcMint} label="USDC mint known" value={p.usdcMint ? shortAddr(p.usdcMint.toBase58()) : "—"} hint="Claim USDC below creates your token account and mints test funds" />
                  <Check ok={!cfg.paused} label="Platform active" value={cfg.paused ? "paused" : "yes"} />
                  <Check ok label="Entry fee" value={usd(entryFee)} />
                </div>
                {/* no USDC needed to claim. The faucet creates the token account and mints in one go */}
                <div className="max-w-xs">
                  <ClaimUsdc variant="ghost" />
                </div>
              </>
            )}

            {status === "applied" && <div className="notice notice-info">Profile exists but the trial has not started. Refresh the profile, or re-apply if it persists.</div>}

            {status === "trial" && profile && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <Gauge label="Trial progress" value={`${Math.min(elapsedDays, TRIAL_DAYS)} / ${TRIAL_DAYS} days`} ratio={Math.min(elapsedDays, TRIAL_DAYS) / TRIAL_DAYS} kind="goal" hint="Calendar days elapsed since the trial started" />
                  <Gauge label="Roots committed" value={`${committed} / ${TRIAL_DAYS}`} ratio={committed / TRIAL_DAYS} kind="goal" hint="Each simulated day's merkle root must be committed on-chain; a missed day invalidates the trial" />
                </div>
                {trialState === undefined ? (
                  <Skeleton lines={6} />
                ) : trialState === null ? (
                  <div className="notice notice-warn">Trial engine offline. Metrics unavailable. Your orders are still recorded once it returns.</div>
                ) : (
                  <TrialCriteria state={trialState} />
                )}
              </>
            )}

            {status === "failed" && (
              <div className="grid grid-cols-2 gap-1.5">
                <Check ok={!inCooldown} label="Cooldown" value={inCooldown ? countdown(cooldownUntil) : "over"} hint={`${cooldownText} after the failed finalize`} />
                <Check ok={!!p.usdcMint} label="USDC for the entry fee" value={usd(entryFee)} hint="Charged again on re-apply" />
                <div className="col-span-2 notice notice-info">Your simulated trade log is still exportable and verifiable against the on-chain day roots.</div>
              </div>
            )}

            {status === "frozen" && (
              <div className="grid grid-cols-2 gap-1.5">
                <Check ok={!inCooldown} label="Cooldown" value={inCooldown ? countdown(cooldownUntil) : "over"} />
                <Check ok={false} label="Tier" value="reset to 1 on re-apply" />
                <div className="col-span-2 notice notice-bad">Unvested escrow was returned to investors; the lock is recorded on your public profile.</div>
              </div>
            )}

            {noPoolYet && ticket && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Tile l="Your ticket" v={`#${Number(ticket.ticket)}`} big />
                <Tile l="Position in line" v={queuePos === 0 ? "next" : `${queuePos} ahead`} sub={commonPool ? `head of queue: #${Number(commonPool.nextToFund)}` : undefined} />
                <Tile l="Your allocation" v={usd(capUsdForQueue)} sub="funded in one instruction, plus your fee as seed" />
                <Tile l="CommonPool idle" v={cpIdleUsd === null ? "—" : usd(cpIdleUsd)} sub={cpAvailUsd !== null ? `${usd(Math.max(0, cpAvailUsd))} deployable after reserve` : undefined} />
              </div>
            )}
            {noPoolYet && ticket && (
              <div className="notice notice-info">
                Strictly first in, first funded: nobody jumps the line, even if the pool could cover a smaller request behind you. The keeper funds tickets automatically as capital frees up; anyone may also trigger it.
              </div>
            )}
            {noPoolYet && !ticket && (
              <details className="disclosure panel px-3 py-2">
                <summary>Prefer a self-funded pool? Create one manually instead</summary>
                <div className="pt-2 flex flex-col gap-2">
                  <p className="text-h11 leading-double text-muted">
                    The manual path: you create the pool yourself, court investors (or seed it with your own USDC) to the {usd(floor)} activation floor, and skip the queue entirely. Your held fee is still injected as first-loss seed when the pool activates. Note: creating a pool removes you from queue eligibility.
                  </p>
                  <PoolForm
                    onCreated={(addr) => {
                      setCreatedPool(addr);
                      void p.refreshProfile();
                    }}
                  />
                </div>
              </details>
            )}
            {status === "eligible" && poolAddr && (pStatus === "live" || pStatus === "funding") && (
              /* Reference, not status: true at all times and needed once. */
              <details className="disclosure">
                <summary>Starting a second pool</summary>
                <p className="pt-1 text-h11 leading-double text-muted">
                  One pool per trader. The program blocks <span className="num">create_pool</span> while this one is active. To start another: go flat, then{" "}
                  <span className="text-fg">Pool tab → Close pool</span>. The create form reappears here afterwards and you keep your tier.
                </p>
              </details>
            )}

            {status === "eligible" && poolAddr && (
              <>
                {pool === undefined ? (
                  <Skeleton lines={4} />
                ) : pool === null ? (
                  <div className="notice notice-bad">Pool account could not be loaded from the chain.</div>
                ) : pStatus === "funding" ? (
                  <>
                    <Gauge label="Funding" value={`${usd(accounted)} / ${usd(floor)}`} ratio={floor ? accounted / floor : 0} kind="goal" hint="Accounted USDC vs the activation floor" />
                    <div className="grid grid-cols-3 gap-2">
                      <Tile l="Raised" v={usd(accounted)} big />
                      <Tile l="Target size" v={usd(fromPrice(pool.targetSize))} sub={`tier cap ${tierCapStr}`} />
                      <Tile l="Investors" v={investors === null ? "—" : String(investors)} sub="via the Common Pool" />
                    </div>
                  </>
                ) : pStatus === "live" ? (
                  <>
                    {pool.tier < 3 ? (
                      <>
                        <PromotionProgress
                          current={{ name: tierLabel(pool.tier), cap: tierCapStr, facts: tierFacts(pool.tier) }}
                          next={{ name: `Tier ${pool.tier + 1}`, cap: usd(fromPrice(cfg.tierCaps[Math.min(2, pool.tier)])), facts: tierFacts(pool.tier + 1) }}
                          conditions={[
                            {
                              met: liveDays >= needDays,
                              label: `${needDays} live days at ${tierLabel(pool.tier).toLowerCase()}`,
                              value: `${Math.min(liveDays, needDays)} / ${needDays}`,
                              ratio: needDays ? liveDays / needDays : 0,
                            },
                            // No value: the headline above already states the
                            // performance this tests. A checklist row restating
                            // its own input is how "1.0000 vs 1.0000" ended up
                            // on screen twice.
                            { met: npsOk, label: "NAV/share above where the tier started" },
                          ]}
                        />
                        <p className="text-h11 leading-double text-muted">
                          Promotion needs your signature. It spends your vested escrow as first-loss seed, which is not withdrawable, so nobody can raise your cap for you.
                        </p>
                      </>
                    ) : (
                      <div className="notice notice-ok">Tier 3 is the maximum cap. Nothing further to unlock. Escrow keeps vesting on the {cfg.vestDays?.[2] ?? 14}-day schedule.</div>
                    )}
                    {/* Open positions and recent fills used to sit here as two
                        more tables. The terminal shows both, live and fuller.
                        This is a status panel, not a second terminal. */}
                    <Link href="/terminal" className="text-h11 text-accent hover:underline">
                      {pool.openPositions > 0 ? `${pool.openPositions} open position${pool.openPositions === 1 ? "" : "s"} · open the terminal →` : "Open the terminal →"}
                    </Link>
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      <Tile l="Final NAV" v={usd(fromPrice(pool.lastMarkNav))} big />
                      <Tile l="Escrow unvested" v={usd(fromPrice(pool.escrowTotal))} sub={`${usd(fromPrice(pool.vestedClaimable))} claimable`} />
                      <Tile l="Trades" v={String(pool.totalTrades)} sub="lifetime" />
                    </div>
                    <div className="notice notice-info">
                      Pool is {pStatus}
                      {lockLabel ? ` (${lockLabel})` : ""}. The Common Pool’s stake redeems at final NAV; your escrow keeps vesting. Vest and claim in the terminal&apos;s Escrow tab.
                    </div>
                    <Link href={`/invest/${poolAddr}`} className="text-h11 text-accent hover:underline">
                      Final positions and the full trade history stay on the pool&rsquo;s record →
                    </Link>
                  </>
                )}
              </>
            )}
          </div>
        </Card>

        {/* ---------------- right rail ---------------- */}
        <div className="col-span-12 lg:col-span-4 flex min-w-0 flex-col gap-4">
          {/* Clock and Your record were two panels asking the same question.
              "what is true about me right now", and once the rows duplicated
              elsewhere were removed, Clock was a single line floating above a
              column of empty space. One panel, the clocks above the standing
              facts, separated by a rule rather than by a second chrome. */}
          <Card title="Your record" aside="public on-chain profile">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
              {status === "trial" && (
                <>
                  <Clock l="Trial ends" v={countdown(trialEnds)} sub={time(trialEnds)} />
                  {missed ? (
                    <Clock l={`Day ${nextDay} commit`} v="missed" tone="bad" sub="grace window passed. Finalize will record MissedDay" />
                  ) : allCommitted ? (
                    <Clock l="Attestation" v="complete" tone="good" sub="all 30 day roots on-chain" />
                  ) : canCommit ? (
                    <Clock l={`Commit day ${nextDay} before`} v={countdown(deadlineTs)} tone={deadlineTs - now / 1000 < daySecs * 0.25 ? "warn" : undefined} sub={time(deadlineTs)} />
                  ) : (
                    <Clock l={`Day ${nextDay} ends in`} v={countdown(nextDayEnds)} sub="commit its root after that" />
                  )}
                </>
              )}
              {(status === "failed" || status === "frozen") &&
                (inCooldown ? <Clock l="Cooldown ends" v={countdown(cooldownUntil)} tone="warn" sub={time(cooldownUntil)} /> : <Clock l="Cooldown" v="over" tone="good" sub="you may re-apply" />)}
              {status === "eligible" && pool && pStatus === "live" && (
                <>
                  {/* "Live days at tier" lived here and as condition one in
                      the promotion checklist. The checklist is where it means
                      something, so this panel keeps only the clocks that are
                      nowhere else. */}
                  <VestClock pool={pool} />
                </>
              )}
              {status === "eligible" && pool && (pStatus === "locked" || pStatus === "settled") && <VestClock pool={pool} />}
              {status === "eligible" && pool && pStatus === "funding" && <Clock l="Funding" v="open-ended" sub="no window. Activates when the floor is reached" />}
              {noPoolYet && <Clock l="Activation floor" v={usd(floor)} sub="investor NAV that takes the pool Live" />}
              {pool && Number(pool.endsAt ?? 0) > 0 && (
                <Clock
                  l="Pool ends"
                  v={Number(pool.endsAt) > now / 1000 ? countdown(Number(pool.endsAt)) : "expired"}
                  sub={Number(pool.endsAt) > now / 1000 ? "then: no deposits / new trades; closed once flat" : "no deposits or new trades. Go flat; the keeper closes it"}
                />
              )}
              {status === "none" && <Clock l="Trial length" v={`${TRIAL_DAYS} days`} sub={`day length ${daySecs}s on this network`} />}
              {status === "applied" && <Clock l="Trial" v="not started" tone="warn" />}
              </div>
              {profile && (
                <>
                  <div className="border-t border-dashed border-fig-stroke" />
                  <div className="kv-list flex flex-col">
                {instantJourney ? (
                  <div className="kv">
                    <span>Funding</span>
                    <span className="font-sans text-amber">Instant · cap <span className="num">{usd(fromPrice(profile.instantCap ?? 0))}</span></span>
                  </div>
                ) : (
                  <>
                    <div className="kv">
                      <span>Attempts</span>
                      <span>{profile.attempts}</span>
                    </div>
                    <div className="kv">
                      <span>Trials failed</span>
                      <span className={profile.trialsFailed > 0 ? "text-amber" : ""}>{profile.trialsFailed}</span>
                    </div>
                  </>
                )}
                <div className="kv">
                  <span>Pools created</span>
                  <span>{profile.poolsCreated}</span>
                </div>
                <div className="kv">
                  <span>Pools locked</span>
                  <span className={profile.poolsLocked > 0 ? "text-down" : ""}>{profile.poolsLocked}</span>
                </div>
                <div className="kv">
                  <span>Tier</span>
                  <span className="font-sans">{profile.tier > 0 ? <>Tier {profile.tier} · cap <span className="num">{usd(fromPrice(cfg.tierCaps[Math.min(2, Math.max(0, profile.tier - 1))]))}</span></> : "—"}</span>
                </div>
                  </div>
                </>
              )}
              <span className="text-xxs text-muted">{daySecs === 86400 ? "1 day = 24 h on this network" : `1 day = ${daySecs}s on this network`}</span>
            </div>
          </Card>

          {status === "trial" && (
            <Card title="Trial tools">
              <div className="flex flex-col gap-1">
                <details className="disclosure">
                  <summary>Dev shortcuts</summary>
                  <div className="flex flex-col gap-1.5 pt-1">
                    <div className="text-xxs text-muted">Not part of the production flow. Only useful on localnet / devnet with a short day length.</div>
                    <div className="flex flex-wrap gap-1.5">
                      <button className="btn btn-sm btn-outline-amber" disabled={!canCommit || anyBusy || !client || pendingCommits < 2} onClick={doCommitAll} title="Commit every day that has already ended, 8 per transaction">
                        Commit all ({pendingCommits} pending)
                      </button>
                    </div>
                  </div>
                </details>
                {trialState?.dayRoots?.length ? (
                  <details className="disclosure">
                    <summary>Day roots ({trialState.dayRoots.length})</summary>
                    <div className="text-xxs text-muted num max-h-28 overflow-auto flex flex-col gap-0.5 pt-1">
                      {trialState.dayRoots.map((d) => (
                        <div key={d.day} className="flex gap-2 items-center">
                          <span className="w-10 shrink-0">day {d.day}</span>
                          <span className="flex-1 truncate" title={d.root}>
                            {d.root}
                          </span>
                          <span className="shrink-0">{d.entries} entries</span>
                          <span className={`shrink-0 ${d.committed ? "text-up" : "text-amber"}`}>{d.committed ? "committed" : "pending"}</span>
                        </div>
                      ))}
                      {profile && <div className="text-muted pt-1">latest on-chain root: {bytesToHex(profile.trialRoot).replace(/^0+$/, "—")}</div>}
                    </div>
                  </details>
                ) : null}
              </div>
            </Card>
          )}
          {rail}
        </div>
      </div>
    </div>
  );
}

/** KPI tile for the Now panel. */
function Tile({ l, v, sub, tone, big }: { l: string; v: string; sub?: string; tone?: "up" | "down" | "warn"; big?: boolean }) {
  const cls = tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-amber" : "";
  return (
    <div className="min-w-0 rounded-[16px] border border-fig-stroke bg-fig-bg-additional px-4 py-3 shadow-[inset_0_6px_16px_0_rgba(0,0,0,0.16)]">
      <div className="label truncate">{l}</div>
      <div className={`${big ? "value-lg" : "value text-sm"} truncate ${cls}`} title={v}>
        {v}
      </div>
      {sub && <div className="num truncate text-h11 text-muted">{sub}</div>}
    </div>
  );
}

/** section 5.4 criteria as ✓/✗ rows with progress bars. */
function TrialCriteria({ state }: { state: TrialState }) {
  const { config } = usePlatform();
  const m = state.metrics;
  const c = config?.trial;
  if (!m || !c) return <Skeleton lines={6} />;
  const target = c.profitTargetBps / 10000;
  const profit = m.profitPct ?? 0;
  const ddLimit = c.maxDrawdownBps;
  const dlLimit = c.dailyLossBps;
  const consLimit = c.maxDayProfitShareBps;
  const pass = m.passing ?? { profitTarget: false, drawdown: false, dailyLoss: false, activeDays: false, trades: false, consistency: false, all: false };
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
      <Check ok={pass.profitTarget} label={`Profit ≥ +${c.profitTargetBps / 100}%`} value={`${pct(profit, 2, true)} · ${usd(state.equity)}`} ratio={target ? profit / target : 0} hint="Reachable in a month at moderate leverage, not by accident" />
      <Check ok={pass.drawdown} label={`Max drawdown ≤ ${ddLimit / 100}%`} value={`${(m.maxDrawdownBps / 100).toFixed(2)}%`} ratio={ddLimit ? m.maxDrawdownBps / ddLimit : 0} kind="limit" hint="Same rule you will trade under live" />
      <Check ok={pass.dailyLoss} label={`Daily loss ≤ ${dlLimit / 100}%`} value={`${(m.maxDailyLossBps / 100).toFixed(2)}%`} ratio={dlLimit ? m.maxDailyLossBps / dlLimit : 0} kind="limit" hint="Worst single UTC day" />
      <Check ok={pass.activeDays} label={`Active days ≥ ${c.minActiveDays}`} value={`${m.activeDays}`} ratio={c.minActiveDays ? m.activeDays / c.minActiveDays : 0} hint="Blocks “one trade on day 3, wait 27 days”" />
      <Check ok={pass.trades} label={`Trades ≥ ${c.minTrades}`} value={`${m.trades}`} ratio={c.minTrades ? m.trades / c.minTrades : 0} hint="Sample-size floor" />
      <Check ok={pass.consistency} label={`Best day ≤ ${consLimit / 100}% of profit`} value={`${(m.maxDayProfitShareBps / 100).toFixed(1)}%`} ratio={consLimit ? m.maxDayProfitShareBps / consLimit : 0} kind="limit" hint="No single day may carry most of the profit" />
      <div className={`col-span-2 notice ${pass.all ? "notice-ok" : "notice-info"}`}>{pass.all ? "All criteria passing (finalize once every day root is committed." : "Not passing yet) criteria are evaluated at finalize."}</div>
    </div>
  );
}

/** Nearest escrow bucket to vest, as a countdown. */
function VestClock({ pool }: { pool: ChainPool }) {
  const today = Math.floor(Date.now() / 1000 / 86400);
  const next = pool.escrow
    .map((b) => ({ amount: fromPrice(b.amount), unlockDay: b.unlockDay }))
    .filter((b) => b.amount > 0)
    .sort((a, b) => a.unlockDay - b.unlockDay)[0];
  if (!next) return <Clock l="Escrow vesting" v="none yet" sub="accrues from winning closes" />;
  if (next.unlockDay <= today) return <Clock l="Escrow vestable" v={usd(next.amount)} tone="good" sub="vest + claim in the terminal's Escrow tab" />;
  return <Clock l="Next vest" v={countdown(next.unlockDay * 86400)} sub={`${usd(next.amount)} · ${usd(fromPrice(pool.escrowTotal))} total unvested`} />;
}

function Clock({ l, v, sub, tone }: { l: string; v: string; sub?: string; tone?: "good" | "warn" | "bad" }) {
  const cls = tone === "good" ? "text-up" : tone === "warn" ? "text-amber" : tone === "bad" ? "text-down" : "text-fg";
  // Mono is for figures you compare down a column. A value with no digit in it
  // ("none yet") is a sentence, and the caption under it always is.
  const figure = /\d/.test(v);
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted text-xs whitespace-nowrap">{l}</span>
      <span className="min-w-0 text-right">
        <span className={`text-sm font-medium ${figure ? "num" : ""} ${cls}`}>{v}</span>
        {sub && <span className="block truncate text-xxs text-muted">{sub}</span>}
      </span>
    </div>
  );
}

