"use client";
/**
 * The CommonPool investor surface (Vault Ledger section 1, section 3): deposit into one
 * shared pool and hold a proportional claim on every trader it funds. The
 * primary investor entry point. Reads the CommonPool and the investor's own
 * CommonPosition straight from chain, and gathers the stake (pool, position)
 * pairs + their oracles that the on-chain NAV instructions require.
 *
 * Redemption follows section 3's cascade: pays from idle immediately when covered,
 * otherwise queues and the keeper pulls capital back from trader pools before
 * `settle_common_redemption` finishes it.
 */
import BN from "bn.js";
import { AccountMeta, PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Skeleton, Spinner } from "@kydo/ui";
import { CHAIN_POLL_MS } from "@/lib/config";
import { KydoMark } from "./brand/Kydo";
import { fromPrice, fromSharesUsd, pct, toPriceBN, usd } from "@/lib/format";
import { useTx } from "@/lib/hooks";
import { usePlatform } from "@/lib/platform";
import { useVaultClient } from "@/lib/solana";

interface Stake {
  pool: PublicKey;
  shares: BN;
  poolShares: BN;
  poolAccounted: BN;
}

interface CpState {
  idle: number;
  totalShares: BN;
  depositEnabled: boolean;
  reserveBps: number;
  activeStakes: number;
  navEst: number; // idle + Σ book value of stakes (display estimate; on-chain uses live marks)
  stakes: Stake[];
}

export function CommonPoolPanel() {
  const p = usePlatform();
  const { client, readonly } = useVaultClient();
  const depositTx = useTx();
  const redeemTx = useTx();
  const settleTx = useTx();

  const [cp, setCp] = useState<CpState | null | undefined>(undefined);
  const [pos, setPos] = useState<{ shares: BN; costBasis: number; pending: BN; lockupEndsAt: number } | null>(null);
  const [tab, setTab] = useState<"deposit" | "redeem">("deposit");
  const [amountStr, setAmountStr] = useState("");
  const [redeemPct, setRedeemPct] = useState(100);

  const wallet = p.wallet;
  const usdcMint = p.usdcMint;
  const minDeposit = p.config ? fromPrice(p.config.minDeposit) : 50;
  const lockupSecs = p.config ? p.config.risk.redemptionLockupSecs : 0;

  const load = useCallback(async () => {
    if (!readonly) return;
    try {
      const cpKey = readonly.pda.commonPool();
      const acct: any = await (readonly.program.account as any).commonPool.fetchNullable(cpKey);
      if (!acct) {
        setCp(null);
        return;
      }
      // Every pool the CommonPool holds a stake in: InvestorPosition where investor == CommonPool.
      // Layout: [8 disc][32 pool][32 investor] → investor at offset 40.
      const raw = await (readonly.program.account as any).investorPosition.all([{ memcmp: { offset: 8 + 32, bytes: cpKey.toBase58() } }]);
      const stakes: Stake[] = [];
      let bookValue = 0;
      for (const s of raw as any[]) {
        const poolPk = s.account.pool as PublicKey;
        const poolAcct: any = await readonly.pool(poolPk).catch(() => null);
        if (!poolAcct) continue;
        const shares = new BN(s.account.shares);
        const poolShares = new BN(poolAcct.totalShares);
        const poolAccounted = new BN(poolAcct.accountedUsdc);
        stakes.push({ pool: poolPk, shares, poolShares, poolAccounted });
        if (!poolShares.isZero()) bookValue += fromPrice(shares.mul(poolAccounted).div(poolShares));
      }
      const idle = fromPrice(acct.accountedIdle);
      setCp({
        idle,
        totalShares: new BN(acct.totalShares),
        depositEnabled: acct.depositEnabled,
        reserveBps: acct.reserveBps,
        activeStakes: acct.activeStakes,
        navEst: idle + bookValue,
        stakes,
      });

      if (wallet) {
        const cpPos: any = await (readonly.program.account as any).commonPosition.fetchNullable(readonly.pda.commonInvestor(wallet));
        setPos(
          cpPos
            ? { shares: new BN(cpPos.shares), costBasis: fromPrice(cpPos.costBasis), pending: new BN(cpPos.pendingShares), lockupEndsAt: Number(cpPos.lastDepositTs) + lockupSecs }
            : null,
        );
      } else setPos(null);
    } catch {
      setCp((c) => c ?? null);
    }
  }, [readonly, wallet, lockupSecs]);

  useEffect(() => {
    void load();
    const t = setInterval(load, CHAIN_POLL_MS * 2);
    return () => clearInterval(t);
  }, [load]);

  // The staked pools the NAV instructions must be handed (the SDK sorts them
  // and pairs each with its InvestorPosition). Oracles are gathered at call
  // time because they depend on each pool's live open positions.
  const stakePools = useMemo(() => (cp ? cp.stakes.map((s) => s.pool) : []), [cp]);
  const gatherOracles = useCallback(async (): Promise<AccountMeta[]> => {
    if (!client || !p.registry || !cp) return [];
    const seen = new Set<string>();
    const out: AccountMeta[] = [];
    for (const s of cp.stakes) {
      const acct: any = await readonly.pool(s.pool).catch(() => null);
      if (!acct) continue;
      for (const m of client.oracleMetas(p.registry.markets, acct)) {
        const k = m.pubkey.toBase58();
        if (!seen.has(k)) {
          seen.add(k);
          out.push(m);
        }
      }
    }
    return out;
  }, [client, readonly, p.registry, cp]);

  const myShares = pos?.shares ?? new BN(0);
  const myValueEst = cp && !cp.totalShares.isZero() && pos ? (fromPrice(myShares.mul(new BN(Math.round(cp.navEst * 1e6))).div(cp.totalShares)) ) : 0;
  const pnlEst = pos ? myValueEst - pos.costBasis : 0;
  const pending = pos ? !pos.pending.isZero() : false;
  const lockupActive = pos ? pos.lockupEndsAt * 1000 > Date.now() : false;
  const deployed = cp ? Math.max(0, cp.navEst - cp.idle) : 0;
  /* Lifetime return: NAV per share − 1, the definition `PoolSummary.roi` uses.
     The comment here used to say "shares are minted at parity with USDC, so a
     share is worth $1 at inception". True in dollars, false in these units.
     The first deposit mints `amount × SHARE_SCALE` with `amount` already scaled
     by PRICE_SCALE, so `fromShares` came back a million times larger than the
     dollars behind it and `navEst / sharesOut` was 1e-6. The panel reported
     −100.00% on a pool whose only funded trader was flat. */
  const sharesOutUsd = cp ? fromSharesUsd(cp.totalShares) : 0;
  const fundingRoi = cp && sharesOutUsd > 0 ? cp.navEst / sharesOutUsd - 1 : null;

  const doDeposit = () =>
    depositTx.run(
      `Depositing ${usd(Number(amountStr) || 0)}…`,
      async () => {
        if (!client || !wallet || !usdcMint) throw new Error("wallet not ready");
        const amt = Number(amountStr) || 0;
        if (amt < minDeposit) throw new Error(`Minimum deposit is ${usd(minDeposit)}`);
        const oracles = await gatherOracles();
        const sig = await client.depositCommon(wallet, client.usdcAta(wallet, usdcMint), toPriceBN(amt), stakePools, oracles).rpc();
        await load();
        return sig;
      },
      (sig) => ({ title: "Deposited into the Common Pool", detail: `${usd(Number(amountStr) || 0)} at NAV. Your claim now spans every trader the pool funds. Redemption lockup restarts now.`, sig }),
    );

  const doRedeem = () =>
    redeemTx.run(
      "Requesting redemption…",
      async () => {
        if (!client || !wallet || !usdcMint || !pos) throw new Error("no position");
        const shares = myShares.muln(Math.round(redeemPct)).divn(100);
        if (shares.isZero()) throw new Error("nothing to redeem");
        const oracles = await gatherOracles();
        const sig = await client.redeemCommon(wallet, client.usdcAta(wallet, usdcMint), shares, stakePools, oracles).rpc();
        await load();
        return sig;
      },
      (sig) => ({
        title: "Redemption requested",
        detail: cp && deployed > 0 ? "Paid from idle if covered; otherwise the keeper pulls capital back from trader pools, then settle." : "Paid immediately from the idle reserve.",
        sig,
      }),
    );

  const doSettle = () =>
    settleTx.run(
      "Settling redemption…",
      async () => {
        if (!client || !wallet || !usdcMint) throw new Error("wallet not ready");
        const oracles = await gatherOracles();
        const sig = await client.settleCommonRedemption(wallet, client.usdcAta(wallet, usdcMint), stakePools, oracles).rpc();
        await load();
        return sig;
      },
      (sig) => ({ title: "Redemption settled", detail: "USDC paid at current NAV; shares burned.", sig }),
    );

  const busy = depositTx.busy || redeemTx.busy || settleTx.busy;

  return (
    <section className="flex flex-col gap-4" aria-label="Common Pool">
      <PoolHero
        nav={cp ? cp.navEst : null}
        idle={cp ? cp.idle : null}
        reserveBps={cp ? cp.reserveBps : null}
        traders={cp ? cp.activeStakes : null}
        roi={fundingRoi}
        minDeposit={minDeposit}
        onDeposit={() => {
          setTab("deposit");
          document.getElementById("common-pool-form")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }}
      />
      {pos && !myShares.isZero() && <PositionBar deposited={pos.costBasis} pnl={pnlEst} value={myValueEst} />}
      <div id="common-pool-form" className="flex flex-col gap-4 rounded-[24px] bg-gradient-to-t from-fig-bg-pattern-900 to-fig-bg-600 p-5">
        {cp === undefined ? (
          <Skeleton lines={5} />
        ) : cp === null ? (
          <div className="notice notice-bad">Common Pool not found on this deployment.</div>
        ) : (
          <>
            {/* pool stats */}


            {/* your position */}
            {wallet && pos && (
              <div className="rounded border border-line bg-panel2 p-3 flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="label">Your claim</span>
                  <span className="num text-lg font-semibold text-fg">≈ {usd(myValueEst)}</span>
                </div>
                <div className="flex items-baseline justify-between text-xxs">
                  <span className="text-muted">
                    cost basis <span className="num text-fg">{usd(pos.costBasis)}</span>
                  </span>
                  <span className={pnlEst >= 0 ? "text-up" : "text-down"}>
                    {pnlEst >= 0 ? "+" : ""}
                    {usd(pnlEst)} est
                  </span>
                </div>
                {pending && <div className="notice notice-info text-xxs">Redemption pending. The keeper is pulling capital back from trader pools; settle once idle covers your slice.</div>}
              </div>
            )}

            {/* deposit / redeem */}
            {!wallet ? (
              <p className="text-xs text-muted">Connect a wallet to deposit.</p>
            ) : (
              <>
                <div className="seg inline-grid w-auto grid-cols-2 self-start" role="tablist">
                  <button role="tab" aria-selected={tab === "deposit"} className={`seg__btn px-5 ${tab === "deposit" ? "seg__btn--on" : ""}`} onClick={() => setTab("deposit")}>
                    Deposit
                  </button>
                  <button role="tab" aria-selected={tab === "redeem"} className={`seg__btn px-5 ${tab === "redeem" ? "seg__btn--on" : ""}`} onClick={() => setTab("redeem")} disabled={!pos || myShares.isZero()}>
                    Redeem
                  </button>
                </div>

                {tab === "deposit" ? (
                  <div className="flex flex-col gap-2">
                    {!cp.depositEnabled && <div className="notice notice-warn text-xxs">Deposits are paused on this deployment.</div>}
                    <label className="hl-field">
                      <span className="hl-field__label">Amount</span>
                      <input value={amountStr} onChange={(e) => setAmountStr(e.target.value)} inputMode="decimal" placeholder={String(minDeposit)} aria-label="Deposit amount USDC" />
                      <span className="hl-field__unit">USDC</span>
                    </label>
                    <button className="btn btn-primary h-9 font-semibold" disabled={busy || !cp.depositEnabled || !(Number(amountStr) >= minDeposit)} onClick={doDeposit} aria-busy={depositTx.busy}>
                      {depositTx.busy && <Spinner />}
                      {depositTx.busy ? "Working…" : `Deposit ${amountStr ? usd(Number(amountStr) || 0) : ""}`}
                    </button>
                    <p className="text-h11 leading-double text-muted">
                      Priced at NAV against a mark-to-market read of every funded pool. Minimum {usd(minDeposit)}. Investors bear all losses. No backstop fund.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {lockupActive && <div className="notice notice-warn text-xxs">Redemption lockup active. Your last deposit is still within the {lockupSecs >= 86400 ? `${Math.round(lockupSecs / 86400)}-day` : `${Math.round(lockupSecs / 60)}-minute`} window.</div>}
                    <div className="flex items-center gap-2">
                      {[25, 50, 100].map((v) => (
                        <button key={v} className={`h-8 rounded-full px-3 text-h11 font-medium transition-colors ${redeemPct === v ? "bg-fig-bg-500 text-fig-text-950" : "bg-fig-bg-800 text-fig-text-600 hover:text-fg"}`} onClick={() => setRedeemPct(v)}>
                          {v}%
                        </button>
                      ))}
                      <span className="num text-xxs text-muted ml-auto">≈ {usd((myValueEst * redeemPct) / 100)}</span>
                    </div>
                    <button className="btn h-9 font-semibold" disabled={busy || lockupActive || pending || myShares.isZero()} onClick={doRedeem} aria-busy={redeemTx.busy}>
                      {redeemTx.busy && <Spinner />}
                      {redeemTx.busy ? "Working…" : `Redeem ${redeemPct}%`}
                    </button>
                    {pending && (
                      <button className="btn btn-primary h-8" disabled={busy} onClick={doSettle} aria-busy={settleTx.busy}>
                        {settleTx.busy ? "Working…" : "Settle pending redemption"}
                      </button>
                    )}
                    <p className="text-h11 leading-double text-muted">Paid from the idle reserve immediately when it covers your slice; otherwise queued while the keeper pulls capital back, then settle. You bear your own unwind cost.</p>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Hero (Figma "Investor" 40:63817). Headline and featured pool on the left, the
 * pool's numbers on the right. Figures come from the CommonPool account this
 * component already loads.
 */
function PoolHero({
  nav,
  idle,
  reserveBps,
  traders,
  roi,
  minDeposit,
  onDeposit,
}: {
  nav: number | null;
  idle: number | null;
  reserveBps: number | null;
  traders: number | null;
  roi: number | null;
  minDeposit: number;
  onDeposit: () => void;
}) {
  const floorPct = reserveBps === null ? null : reserveBps / 100;
  // Idle against the reserve floor. The design draws this as a segmented bar.
  const floorTarget = nav !== null && floorPct !== null ? (nav * floorPct) / 100 : null;
  const fill = idle !== null && floorTarget && floorTarget > 0 ? Math.max(0, Math.min(1, idle / Math.max(floorTarget, idle))) : 0;

  return (
    <div className="grid gap-4 rounded-[24px] bg-gradient-to-t from-fig-bg-pattern-900 to-fig-bg-600 p-5 lg:grid-cols-2">
      {/* ---- left: the pitch ---- */}
      <div className="flex min-w-0 flex-col gap-5">
        <h1 className="text-h2 font-semibold leading-double text-fg">
          Back a trader,
          <br />
          earn the <span className="text-fig-text-600">profits.</span>
        </h1>

        <div className="flex items-center gap-3">
          <KydoMark size={44} className="rounded-[10px]" />
          <span className="flex min-w-0 flex-col leading-double">
            <span className="text-h7 font-medium text-fg">Common Pool</span>
            <span className="text-h11 text-fig-text-600">one deposit · every funded trader</span>
          </span>
        </div>

        <p className="text-h11 leading-double text-fig-text-550">
          Your deposit is spread across every funded trader, so no single account can take it all.
          {traders !== null && (
            <>
              {" "}
              Currently backing <span className="num font-medium text-fg">{traders}</span> trader{traders === 1 ? "" : "s"}.
            </>
          )}
        </p>

        <p className="text-h11 leading-double text-fig-text-700">
          Investors bear all losses. There is no backstop fund. A trader breaching their loss cap locks that account for good and
          your deposit stops earning from it. You can lose what you deposit.
        </p>

        <div className="mt-auto flex flex-wrap items-center gap-3">
          <button type="button" className="btn-cta w-auto px-6" onClick={onDeposit}>
            Deposit Funds from {usd(minDeposit).replace(".00", "")}
          </button>
          <Link href="/guide" className="btn-pill w-auto px-6">
            Track Record
          </Link>
        </div>
      </div>

      {/* ---- right: the numbers ---- */}
      <div className="flex flex-col gap-4 rounded-[20px] bg-fig-bg-additional p-5">
        <HeroStat label="Pool NAV" value={nav} />
        <div className="border-t border-dashed border-fig-stroke" />
        <div className="flex flex-col gap-3">
          <HeroStat label="Idle reserves" value={idle} aside={floorPct === null ? undefined : `${floorPct.toFixed(0)}% Floor`} />
          {/* segmented fill. The design's striped bar */}
          <div className="h-3 w-full overflow-hidden rounded-sm" aria-hidden>
            <div className="flex h-full w-full">
              <div
                className="h-full bg-[repeating-linear-gradient(90deg,var(--fig-green-600)_0_3px,transparent_3px_5px)]"
                style={{ width: `${Math.round(fill * 100)}%` }}
              />
              <div className="h-full flex-1 bg-[repeating-linear-gradient(90deg,var(--fig-text-800)_0_3px,transparent_3px_5px)]" />
            </div>
          </div>
        </div>
        <div className="border-t border-dashed border-fig-stroke" />
        <div className="flex items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-h11 font-medium text-muted">Funding ROI</span>
            <span
              className={`num text-h4 font-semibold ${roi === null ? "text-fig-text-600" : roi < 0 ? "text-down" : "text-fg"}`}
              title="NAV per share since inception, minus one. The same definition each pool's ROI uses"
            >
              {roi === null ? "—" : pct(roi, 2, true)}
            </span>
          </div>
          {traders !== null && (
            <span className="num text-h11 text-amber">
              {traders} trader{traders === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** A big mono figure with its cents dimmed, as the design sets them. */
function HeroStat({ label, value, aside }: { label: string; value: number | null; aside?: string }) {
  const [whole, cents] = value === null ? ["—", null] : usd(value).split(".");
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-h11 font-medium text-muted">{label}</span>
        <span className="num text-h4 font-semibold text-fg">
          {whole}
          {cents && <span className="text-fig-text-600">.{cents}</span>}
        </span>
      </div>
      {aside && <span className="num shrink-0 text-h11 text-amber">{aside}</span>}
    </div>
  );
}

/** The investor's own position (Figma "Investor" 71:445). */
function PositionBar({ deposited, pnl, value }: { deposited: number; pnl: number; value: number }) {
  const roi = deposited > 0 ? pnl / deposited : 0;
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-[24px] bg-gradient-to-r from-fig-green-950 to-fig-bg-600 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-10 gap-y-3">
        <PositionStat label="Deposited amount" value={usd(deposited)} />
        <PositionStat label="P&L" value={usd(pnl, { sign: true })} cls={pnl < 0 ? "text-down" : pnl > 0 ? "text-up" : undefined} />
        <PositionStat label="ROI" value={pct(roi, 2, true)} cls={roi < 0 ? "text-down" : roi > 0 ? "text-up" : undefined} />
        <PositionStat label="Current value" value={usd(value)} />
      </div>
      <div className="flex items-center gap-3">
        <a href="#common-pool-form" className="btn-cta w-auto px-6">
          Deposit More
        </a>
        <a href="#common-pool-form" className="btn-pill w-auto px-6">
          Withdraw Funds
        </a>
      </div>
    </div>
  );
}

function PositionStat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="text-h11 font-medium uppercase tracking-wider text-fig-text-600">{label}</span>
      <span className={`num text-h8 ${cls ?? "text-fg"}`}>{value}</span>
    </span>
  );
}
