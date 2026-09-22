"use client";
/**
 * Escrow: the trader's 80% of net new profit, vesting in daily buckets.
 *
 * The bucket table led with `Slot`. The ring-buffer index, a program internal
 * nobody claims escrow by, and printed the unlock as `20352 (2025-09-19)`, the
 * on-chain day number *and* the date it means. `Unlocks in` and `State` then
 * said the same thing twice: a countdown, and a pill that reads "vesting"
 * exactly when that countdown is non-zero. Four of five columns were either a
 * representation detail or a restatement, and none of them showed which bucket
 * is the big one.
 *
 * The side panel had the same flatness: eight identical `.kv` rows, with the
 * two figures you came for (vestable now, claimable now) at positions two and
 * three, and their buttons detached at the bottom. A number and the button that
 * acts on it belong together.
 */
import BN from "bn.js";
import type { PublicKey } from "@solana/web3.js";
import { EmptyState } from "@kydo/ui";
import type { LiveBackend } from "@/lib/backend/live";
import type { BackendState } from "@/lib/backend/types";
import { useTx } from "@/lib/hooks";
import { countdown, fromPrice, usd } from "@/lib/format";

const epochDay = (ts: number) => Math.floor(ts / 86400);

export function EscrowPanel({ state, backend, usdcMint }: { state: BackendState; backend: LiveBackend; usdcMint: PublicKey | null }) {
  const vest = useTx();
  const claim = useTx();
  const pool = state.pool;
  if (!pool) {
    return (
      <EmptyState icon="◌" title="Pool not loaded">
        Escrow buckets appear once the pool account is fetched.
      </EmptyState>
    );
  }
  const today = epochDay(Date.now() / 1000);
  const buckets = pool.escrow
    .map((b, i) => ({ slot: i, amount: fromPrice(new BN(b.amount)), unlockDay: b.unlockDay }))
    .filter((b) => b.amount > 0)
    .sort((a, b) => a.unlockDay - b.unlockDay);
  const vestable = buckets.filter((b) => b.unlockDay <= today).reduce((a, b) => a + b.amount, 0);
  const escrowTotal = fromPrice(pool.escrowTotal);
  const claimable = fromPrice(pool.vestedClaimable);
  const aboveHwm = state.navPerShare !== undefined && state.hwmNps !== undefined && state.navPerShare >= state.hwmNps - 1e-12;

  const vestTitle = vest.busy ? "Vesting…" : vestable <= 0 ? "No bucket has reached its unlock day yet" : "Move every unlocked bucket into vested claimable (anyone may call this)";
  const claimTitle = claim.busy ? "Claiming…" : claimable <= 0 ? "Nothing vested to claim" : !aboveHwm ? "NAV/share is below the high-water mark. Claims revert with BelowHighWaterMark" : !usdcMint ? "USDC mint unknown" : "Transfer vested fees to your USDC account";

  const biggest = Math.max(1, ...buckets.map((b) => b.amount));
  const dateOf = (day: number) => new Date(day * 86400 * 1000).toISOString().slice(0, 10);

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_320px] gap-2 p-2">
      <div className="flex min-w-0 flex-col">
        <div className="label mb-1">Escrow buckets · nearest unlock first</div>
        {buckets.length === 0 ? (
          <EmptyState icon="◌" title="No escrow yet">
            80% of net new profit accrues into today&apos;s bucket, measured on cumulative realised PnL, so a win that only recovers an earlier loss earns nothing. Losses drain the nearest-to-vesting buckets first.
          </EmptyState>
        ) : (
          <div className="flex min-w-0 flex-col">
            {buckets.map((b) => {
              const ready = b.unlockDay <= today;
              return (
                <div key={b.slot} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 border-b border-fig-text-900 py-2.5 last:border-0">
                  <span className="flex min-w-0 max-w-[260px] flex-col gap-1.5">
                    <span className={`num truncate text-h10 ${ready ? "text-up" : "text-fg"}`}>{usd(b.amount)}</span>
                    {/* Scaled to the largest bucket, so "where is most of my
                        escrow" is a glance and not a column of sums. */}
                    <span className="block h-1 overflow-hidden rounded-full bg-fig-bg-750">
                      <span className={`block h-full rounded-full ${ready ? "bg-up" : "bg-fig-text-700"}`} style={{ width: `${Math.max(4, (b.amount / biggest) * 100)}%` }} />
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-col items-end gap-1">
                    {/* One statement, not a countdown next to a pill that
                        restates the countdown. */}
                    <span className={`truncate text-h10 ${ready ? "text-up" : "text-fg"}`}>{ready ? "Vestable now" : `Unlocks in ${countdown(b.unlockDay * 86400)}`}</span>
                    <span className="num truncate text-h11 text-muted" title={ready ? "Already past its unlock day" : "Clawback still applies until this unlocks"}>
                      {dateOf(b.unlockDay)}
                      {!ready && " · clawback live"}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel flex flex-col gap-2 p-2">
        {/* The figure and the button that acts on it, together. */}
        <Act
          label="Vestable now"
          value={usd(vestable)}
          tone={vestable > 0 ? "text-up" : undefined}
          button={
            <button
              className="btn w-full"
              disabled={vest.busy || vestable <= 0}
              title={vestTitle}
              onClick={() => vest.run("Vesting escrow…", () => backend.vestEscrow(), (sig) => ({ title: "Escrow vested", detail: `${usd(vestable)} moved to claimable.`, sig }))}
            >
              {vest.busy ? "Vesting…" : "Vest"}
            </button>
          }
        />
        <Act
          label="Vested claimable"
          value={usd(claimable)}
          tone={claimable > 0 ? "text-up" : undefined}
          button={
            <button
              className="btn btn-primary w-full"
              disabled={claim.busy || claimable <= 0 || !aboveHwm || !usdcMint}
              title={claimTitle}
              onClick={() => usdcMint && claim.run("Claiming fees…", () => backend.claimFees(usdcMint), (sig) => ({ title: "Fees claimed", detail: `${usd(claimable)} sent to your USDC account.`, sig }))}
            >
              {claim.busy ? "Claiming…" : "Claim fees"}
            </button>
          }
        />

        {/* A blocker, next to the action it blocks. Not eight rows below it. */}
        {!aboveHwm && <div className="notice notice-warn">NAV/share is below the high-water mark, so a claim would revert. It opens again once the pool trades back above it.</div>}

        <div className="kv-list flex flex-col pt-1">
          <div className="kv">
            <span>Escrow total (unvested)</span>
            <span>{usd(escrowTotal)}</span>
          </div>
          <div className="kv">
            <span>NAV/share vs HWM</span>
            <span className={aboveHwm ? "text-up" : "text-amber"}>
              {state.navPerShare?.toFixed(6) ?? "—"} vs {state.hwmNps?.toFixed(6) ?? "—"}
            </span>
          </div>
          <div className="kv">
            <span>Realized PnL (lifetime)</span>
            <span>{usd(fromPrice(pool.realizedPnl))}</span>
          </div>
          <div className="kv">
            <span>Venue fees paid</span>
            <span>{usd(fromPrice(pool.venueFeesPaid))}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A figure and the button that acts on it, on one inset surface. */
function Act({ label, value, tone, button }: { label: string; value: string; tone?: string; button: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-fig-stroke bg-fig-bg-additional p-3">
      <span className="text-h11 font-medium uppercase tracking-wider text-fig-text-600">{label}</span>
      <span className={`num text-h7 font-semibold leading-none ${tone ?? "text-fg"}`}>{value}</span>
      {button}
    </div>
  );
}
