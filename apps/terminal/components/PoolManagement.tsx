"use client";
/**
 * Pool tab. The pool's lifecycle as a guided flow (section 4.3 / section 6.1):
 *   Create → Funding → Live · Tier 1 → Tier 2 → Tier 3   (a lock ends the run)
 * One stepper says where the pool is, a "Now" card says what to do next with exactly
 * one primary action per stage, progress cards show how far promotion / funding is,
 * escrow + fees get quick actions, and the destructive close sits in a disclosure.
 */
import { useState } from "react";
import BN from "bn.js";
import Link from "next/link";
import type { PublicKey } from "@solana/web3.js";
import { EmptyState, Pill, Spinner, Stepper, useToast, type Step } from "@kydo/ui";
import type { LiveBackend } from "@/lib/backend/live";
import type { BackendState } from "@/lib/backend/types";
import { poolName, type ChainConfig } from "@/lib/chain";
import { poolRecordUrl } from "@/lib/config";
import { countdown, fromPrice, shortAddr, tierLabel, time, usd, usdWhole } from "@/lib/format";
import { useTx } from "@/lib/hooks";
import { ConfirmDialog } from "./ConfirmDialog";
import { Check, Gauge } from "./Gauge";
import { ArrowRight } from "lucide-react";

const LOCK: Record<number, string> = { 0: "none", 1: "daily loss", 2: "drawdown", 3: "voluntary" };
const epochDay = (ts: number) => Math.floor(ts / 86400);

interface Props {
  state: BackendState;
  backend: LiveBackend;
  config: ChainConfig;
  usdcMint: PublicKey | null;
  onChanged: () => void;
  /** Switch the bottom panel to the Escrow tab (bucket-level detail). */
  onOpenEscrow?: () => void;
}

export function PoolManagement({ state, backend, config, usdcMint, onChanged, onOpenEscrow }: Props) {
  const toast = useToast();
  const activate = useTx();
  const promote = useTx();
  const closeP = useTx();
  const vest = useTx();
  const claim = useTx();
  const [confirmClose, setConfirmClose] = useState(false);
  const pool = state.pool;
  if (!pool) {
    return (
      <EmptyState icon="◌" title="Pool not loaded">
        Pool controls appear once the pool account is fetched.
      </EmptyState>
    );
  }

  // ---------------- derived ----------------
  const poolAddr = state.poolAddress ?? "";
  const status = state.poolStatus ?? "funding";
  const floor = fromPrice(config.activationFloor);
  const accounted = fromPrice(pool.accountedUsdc);
  const tierIdx = Math.max(0, Math.min(2, pool.tier - 1));
  const tierCap = fromPrice(config.tierCaps[tierIdx]);
  const days = pool.liveDaysAtTier;
  const needDays = config.risk.promotionDays;
  const npsOk = state.navPerShare !== undefined && state.tierStartNps !== undefined && state.navPerShare > state.tierStartNps;
  const canPromote = status === "live" && pool.tier < 3 && days >= needDays && npsOk;
  const flat = state.positions.length === 0;
  const name = poolName(pool) || `#${pool.index}`;
  const lockLabel = pool.lockReason ? LOCK[pool.lockReason] ?? String(pool.lockReason) : "";
  const ended = status === "locked" || status === "settled";

  // escrow
  const today = epochDay(Date.now() / 1000);
  const buckets = pool.escrow.map((b) => ({ amount: fromPrice(new BN(b.amount)), unlockDay: b.unlockDay })).filter((b) => b.amount > 0);
  const vestable = buckets.filter((b) => b.unlockDay <= today).reduce((a, b) => a + b.amount, 0);
  const nextBucket = buckets.filter((b) => b.unlockDay > today).sort((a, b) => a.unlockDay - b.unlockDay)[0];
  const escrowTotal = fromPrice(pool.escrowTotal);
  const claimable = fromPrice(pool.vestedClaimable);
  const aboveHwm = state.navPerShare !== undefined && state.hwmNps !== undefined && state.navPerShare >= state.hwmNps - 1e-12;

  // ---------------- lifecycle stepper ----------------
  const steps: Step[] = [
    { key: "create", label: "Create", hint: time(Number(pool.createdAt.toString())) },
    { key: "fund", label: "Funding", hint: `${usdWhole(accounted)} / ${usdWhole(floor)}` },
    { key: "t1", label: "Live · Tier 1", hint: pool.tier === 1 ? `${days} / ${needDays} days` : undefined },
    { key: "t2", label: "Tier 2", hint: pool.tier === 2 ? `${days} / ${needDays} days` : `cap ${usdWhole(fromPrice(config.tierCaps[1]))}` },
    { key: "t3", label: "Tier 3", hint: pool.tier === 3 ? "max tier" : `cap ${usdWhole(fromPrice(config.tierCaps[2]))}` },
  ];
  const liveStep = 1 + Math.max(1, Math.min(3, pool.tier)); // 2 / 3 / 4
  const current = status === "funding" ? 1 : liveStep;
  const failedAt = ended ? liveStep : undefined;

  // ---------------- "Now" card ----------------
  const activateTitle = accounted < floor ? `Needs ${usd(floor - accounted)} more to reach the ${usd(floor)} floor` : "Anyone may activate once the floor is reached";
  const promoteTitle = canPromote ? "Every condition holds. Promotion needs your signature" : pool.tier >= 3 ? "Already at the maximum tier" : days < needDays ? `${needDays - days} more live days at this tier` : "NAV/share must exceed the tier-start value";
  const closeTitle = !flat ? `Close your ${state.positions.length} open position${state.positions.length === 1 ? "" : "s"} first` : "Close this pool permanently (type CLOSE to confirm)";

  const copyLink = async () => {
    const url = poolRecordUrl(poolAddr);
    try {
      await navigator.clipboard.writeText(url);
      toast.push({ kind: "success", title: "Pool link copied", detail: url });
    } catch {
      toast.push({ kind: "info", title: "Pool link", detail: url });
    }
  };

  const doActivate = () =>
    activate.run("Activating pool…", () => backend.activate(), (s) => ({ title: "Pool is Live", detail: "You can trade investor capital now.", sig: s })).then(onChanged);
  const doPromote = () =>
    promote.run("Promoting tier…", () => backend.promote(), (s) => ({ title: `Promoted to Tier ${Math.min(3, pool.tier + 1)}`, detail: "The same pool now accepts more capital.", sig: s })).then(onChanged);
  const doVest = () => vest.run("Vesting escrow…", () => backend.vestEscrow(), (s) => ({ title: "Escrow vested", detail: `${usd(vestable)} moved to claimable.`, sig: s })).then(onChanged);
  const doClaim = () => usdcMint && claim.run("Claiming fees…", () => backend.claimFees(usdcMint), (s) => ({ title: "Fees claimed", detail: `${usd(claimable)} sent to your USDC account.`, sig: s })).then(onChanged);

  let now: { title: string; tone?: "up" | "down" | "warn"; body: React.ReactNode; actions: React.ReactNode };
  if (status === "funding") {
    const ready = accounted >= floor;
    now = {
      title: ready ? "Floor reached. Activate the pool" : "Raising the activation floor",
      tone: ready ? "up" : "warn",
      body: ready
        ? "Activation is permissionless: anyone can flip the pool to Live. Trading starts immediately after."
        : `The pool activates once it holds ${usd(floor)}. Seed it with your own USDC to get there. Investors do not fund traders one by one, so nothing arrives on its own.`,
      actions: (
        <>
          <button className={`btn ${ready ? "btn-up" : "btn-primary"} h-8 font-semibold`} disabled={!ready || activate.busy} title={activateTitle} onClick={doActivate} aria-busy={activate.busy}>
            {activate.busy && <Spinner />}
            {activate.busy ? "Activating…" : ready ? "Activate pool" : `Activate at ${usdWhole(floor)}`}
          </button>
          <button className="btn btn-sm" onClick={copyLink} title={poolRecordUrl(poolAddr)}>
            Copy pool link
          </button>
        </>
      ),
    };
  } else if (status === "live") {
    now = canPromote
      ? {
          title: `Promotion window open. Move to Tier ${pool.tier + 1}`,
          tone: "up",
          body: `Every condition holds. Promotion keeps the same pool and raises its cap to ${usd(fromPrice(config.tierCaps[Math.min(2, pool.tier)]))}; vesting becomes ${config.vestDays[Math.min(2, pool.tier)]} days for new escrow.`,
          actions: (
            <>
              <button className="btn btn-up h-8 font-semibold" disabled={promote.busy} title={promoteTitle} onClick={doPromote} aria-busy={promote.busy}>
                {promote.busy && <Spinner />}
                {promote.busy ? "Promoting…" : `Promote to Tier ${pool.tier + 1}`}
              </button>
              <button className="btn btn-sm" onClick={copyLink}>
                Copy pool link
              </button>
            </>
          ),
        }
      : {
          title: pool.tier >= 3 ? "Live at the maximum tier" : `Live · ${tierLabel(pool.tier)}. Trade and keep NAV/share rising`,
          body:
            pool.tier >= 3
              ? "Keep trading within the risk limits; 80% of each winning close escrows and vests to you above the high-water mark."
              : `Trade investor capital in the ticket on the right. After ${needDays} live days at this tier with NAV/share above where the tier started, you can promote in place.`,
          actions: (
            <>
              <button className="btn btn-sm" onClick={copyLink} title="Your public record. Performance, trades and risk, verifiable on-chain">
                Copy pool link
              </button>
              {vestable > 0 && (
                <button className="btn btn-sm btn-outline-up" disabled={vest.busy} onClick={doVest}>
                  Vest {usd(vestable)}
                </button>
              )}
            </>
          ),
        };
  } else {
    now = {
      title: status === "settled" ? "Pool settled" : `Pool locked${lockLabel ? ` · ${lockLabel}` : ""}`,
      tone: "down",
      body:
        pool.lockReason === 3
          ? "You closed this pool. The Common Pool’s stake redeems at final NAV; your escrow keeps vesting and stays claimable above the high-water mark. You keep your tier and may create a new pool from Home."
          : "A risk breach locked this pool: trading halted, the Common Pool’s stake is pulled back at final NAV and unvested escrow returns to investors. Re-apply from Home to start again at Tier 1.",
      actions: (
        <Link href="/" className="btn btn-primary h-8 font-semibold">
          Go to Home
        </Link>
      ),
    };
  }
  const toneCls = now.tone === "up" ? "text-up" : now.tone === "down" ? "text-down" : now.tone === "warn" ? "text-amber" : "";
  const stageCls = now.tone === "up" ? "stage-up" : now.tone === "down" ? "stage-down" : now.tone === "warn" ? "stage-warn" : "stage-accent";

  return (
    <div className="flex flex-col gap-2 p-2 text-xs">
      {/* ---------------- lifecycle ---------------- */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 shrink-0">
          <span className="font-semibold text-sm">{name}</span>
          <Pill tone={status === "live" ? "good" : status === "funding" ? "info" : "bad"}>{status}</Pill>
          <span className="num text-xxs text-muted" title={poolAddr}>
            {shortAddr(poolAddr, 6)}
          </span>
        </div>
        <div className="flex-1 min-w-[420px]">
          <Stepper steps={steps} current={current} failedAt={failedAt} />
        </div>
      </div>

      {/* ---------------- now / progress / escrow ---------------- */}
      <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <section className={`panel p-2 flex flex-col gap-1.5 ${stageCls}`} aria-label="What to do now">
          <div className="label">Now</div>
          <div className={`text-sm font-semibold leading-tight ${toneCls}`}>{now.title}</div>
          <p className="text-muted leading-relaxed">{now.body}</p>
          <div className="flex flex-wrap items-center gap-1.5 mt-auto pt-1">{now.actions}</div>
        </section>

        <section className="panel p-2 flex flex-col gap-1.5" aria-label={status === "funding" ? "Funding progress" : "Promotion progress"}>
          {status === "funding" ? (
            <>
              <div className="label">Funding</div>
              <Gauge label="Raised" value={`${usd(accounted)} / ${usd(floor)}`} ratio={floor ? accounted / floor : 0} kind="goal" hint="Accounted USDC vs the activation floor" />
              <div className="kv">
                <span>Target size</span>
                <span>{usd(fromPrice(pool.targetSize))}</span>
              </div>
              <div className="kv">
                <span>{tierLabel(pool.tier)} cap</span>
                <span>{usd(tierCap)}</span>
              </div>
              <div className="text-xxs text-muted mt-auto">Deposits stay withdrawable until activation.</div>
            </>
          ) : (
            <>
              <div className="label">{pool.tier < 3 ? `Promotion to Tier ${pool.tier + 1}` : "Tier"}</div>
              <Check ok={status === "live"} label="Pool is Live" value={status} />
              <Check ok={pool.tier < 3} label="Below max tier" value={tierLabel(pool.tier)} />
              <Check ok={days >= needDays} label={`${needDays} live days at tier`} value={`${days} / ${needDays}`} ratio={needDays ? days / needDays : 0} />
              <Check ok={npsOk} label="NAV/share above tier start" value={`${state.navPerShare?.toFixed(4) ?? "—"} vs ${state.tierStartNps?.toFixed(4) ?? "—"}`} hint="Measured at the last keeper mark" />
              <div className="text-xxs text-muted mt-auto">
                {pool.tier < 3 ? `Next: cap ${usd(fromPrice(config.tierCaps[Math.min(2, pool.tier)]))} · vesting ${config.vestDays[Math.min(2, pool.tier)]}d` : "Maximum tier reached."}
              </div>
            </>
          )}
        </section>

        <section className="panel p-2 flex flex-col gap-0.5 kv-list" aria-label="Escrow and fees">
          <div className="flex items-baseline justify-between">
            <span className="label">Escrow &amp; fees</span>
            {onOpenEscrow && (
              <button className="inline-flex items-center gap-0.5 text-xxs text-accent hover:underline" onClick={onOpenEscrow}>
                Buckets <ArrowRight size={12} />
              </button>
            )}
          </div>
          <div className="kv">
            <span>Unvested escrow</span>
            <span>{usd(escrowTotal)}</span>
          </div>
          <div className="kv">
            <span>Vestable now</span>
            <span className={vestable > 0 ? "text-up" : ""}>{usd(vestable)}</span>
          </div>
          <div className="kv">
            <span>Claimable</span>
            <span className={claimable > 0 ? "text-up" : ""}>{usd(claimable)}</span>
          </div>
          <div className="kv">
            <span>Next unlock</span>
            <span>{nextBucket ? `${usd(nextBucket.amount)} in ${countdown(nextBucket.unlockDay * 86400)}` : "—"}</span>
          </div>
          <div className={`text-xxs ${aboveHwm ? "text-up" : "text-amber"}`} title={`NAV/share ${state.navPerShare?.toFixed(6) ?? "—"} vs HWM ${state.hwmNps?.toFixed(6) ?? "—"}`}>
            HWM gate {aboveHwm ? "open" : "closed. Claims revert until NAV/share ≥ HWM"}
          </div>
          <div className="grid grid-cols-2 gap-1 mt-auto pt-1">
            <button className="btn btn-sm" disabled={vest.busy || vestable <= 0} title={vestable <= 0 ? "No bucket has reached its unlock day yet" : "Move every unlocked bucket into claimable (anyone may call this)"} onClick={doVest} aria-busy={vest.busy}>
              {vest.busy && <Spinner />}
              {vest.busy ? "Vesting…" : "Vest"}
            </button>
            <button className="btn btn-sm btn-primary" disabled={claim.busy || claimable <= 0 || !aboveHwm || !usdcMint} title={claimable <= 0 ? "Nothing vested to claim" : !aboveHwm ? "Below the high-water mark" : "Transfer vested fees to your USDC account"} onClick={doClaim} aria-busy={claim.busy}>
              {claim.busy && <Spinner />}
              {claim.busy ? "Claiming…" : "Claim fees"}
            </button>
          </div>
        </section>
      </div>

      {/* ---------------- details + close ---------------- */}
      <div className={`grid gap-2 ${ended ? "grid-cols-1" : "grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)]"}`}>
        <section className="panel p-2 flex flex-col gap-1" aria-label="Pool details">
          <div className="label">Pool details</div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-0.5">
            <Row l="Address" v={poolAddr} mono />
            <Row l="Mandate" v={Object.keys(pool.mandate ?? {})[0] ?? "—"} />
            <Row l="Target size" v={usd(fromPrice(pool.targetSize))} />
            <Row l="Investor NAV" v={usd(state.nav)} />
            <Row l="Accounted USDC" v={usd(accounted)} />
            <Row l="Tier / cap" v={`${tierLabel(pool.tier)} · ${usd(tierCap)}`} />
            <Row l="Created" v={time(Number(pool.createdAt.toString()))} />
            <Row l="Activated" v={Number(pool.activatedAt.toString()) > 0 ? time(Number(pool.activatedAt.toString())) : "—"} />
            <Row l="Locked" v={Number(pool.lockedAt.toString()) > 0 ? `${time(Number(pool.lockedAt.toString()))}${lockLabel ? ` (${lockLabel})` : ""}` : "—"} />
            <Row l="Trades total / today" v={`${pool.totalTrades} / ${pool.tradesToday}`} />
            <Row l="Realized PnL" v={usd(fromPrice(pool.realizedPnl))} />
            <Row l="Venue fees paid" v={usd(fromPrice(pool.venueFeesPaid))} />
          </div>
        </section>

        {!ended && (
          <section className="panel p-2 flex flex-col gap-1.5 stage-down" aria-label="Close pool">
            <div className="label text-down">Close pool · voluntary</div>
            <div className="text-muted leading-relaxed">Needs a flat book. The Common Pool’s stake redeems at final NAV, your escrow keeps vesting, you keep {tierLabel(pool.tier)}. Permanent.</div>
            <button className="btn btn-sm btn-outline-down self-start mt-auto" disabled={!flat || closeP.busy} title={closeTitle} onClick={() => setConfirmClose(true)}>
              {closeP.busy ? "Closing…" : flat ? "Close pool…" : `Close pool (${state.positions.length} open)`}
            </button>
          </section>
        )}
      </div>

      <ConfirmDialog
        open={confirmClose}
        title={`Close pool “${name}” permanently?`}
        tone="danger"
        confirmLabel="Close pool"
        typeToConfirm="CLOSE"
        busy={closeP.busy}
        error={closeP.error}
        onCancel={() => setConfirmClose(false)}
        onConfirm={() => {
          void closeP
            .run("Closing pool…", () => backend.closePool(), (s) => ({ title: `Pool “${name}” closed`, detail: "Locked (voluntary). The Common Pool’s stake redeems at final NAV; escrow keeps vesting.", sig: s }))
            .then((r) => {
              if (r) setConfirmClose(false);
              onChanged();
            });
        }}
      >
        <p>
          This cannot be undone. The pool stops trading and moves to <b>Locked (voluntary)</b>.
        </p>
        <ul className="list-disc pl-4 text-muted">
          <li>The Common Pool’s stake redeems at final NAV. Currently {usd(state.nav)} across {state.positions.length === 0 ? "a flat book" : "open positions"}.</li>
          <li>Your escrow keeps vesting and stays claimable; you keep {tierLabel(pool.tier)}.</li>
          <li>You can create a new pool afterwards; this one takes no further funding.</li>
        </ul>
      </ConfirmDialog>
    </div>
  );
}

function Row({ l, v, mono }: { l: string; v: string; mono?: boolean }) {
  return (
    <div className="kv" title={v}>
      <span>{l}</span>
      <span className={mono ? "text-xxs" : ""}>{v}</span>
    </div>
  );
}
