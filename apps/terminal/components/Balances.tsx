"use client";
/** Balances tab: what the connected wallet holds and what the trading account is worth. */
import { useEffect, useState } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { EmptyState, Skeleton } from "@kydo/ui";
import type { BackendState } from "@/lib/backend/types";
import { fromPrice, usd } from "@/lib/format";
import { usePlatform } from "@/lib/platform";
import { ClaimUsdc } from "./ClaimUsdc";
import { SessionKeyButton } from "./SessionKeyButton";
import { Gauge } from "./Gauge";
import { useVaultClient } from "@/lib/solana";

export function Balances({ state }: { state: BackendState | null }) {
  const p = usePlatform();
  const { client } = useVaultClient();
  const { connection } = useConnection();
  const [sol, setSol] = useState<number | null>(null);
  const [usdc, setUsdc] = useState<number | null | "none">(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!p.wallet) return;
    let alive = true;
    const wallet = p.wallet;
    connection
      .getBalance(wallet)
      .then((l) => alive && setSol(l / LAMPORTS_PER_SOL))
      .catch(() => alive && setSol(null));
    if (client && p.usdcMint) {
      connection
        .getTokenAccountBalance(client.usdcAta(wallet, p.usdcMint))
        .then((b) => alive && setUsdc(b.value.uiAmount ?? 0))
        .catch(() => alive && setUsdc("none"));
    }
    const t = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.wallet?.toBase58(), client, p.usdcMint?.toBase58(), connection, tick]);

  if (!p.wallet)
    return (
      <EmptyState icon="◎" title="Connect a wallet">
        Wallet balances and the trading account&apos;s equity appear here.
      </EmptyState>
    );

  const pool = state?.pool ?? null;
  const live = state?.mode === "live";
  // Margin block (build-spec account panel): equity · free collateral · margin-ratio meter
  const baseRisk = p.config?.risk ?? null;
  // Tier-0 (instant funding) pools lock at tighter floors until first promotion. Mirror the program's effective limits.
  const tier0 = p.traderDetail?.profile?.tier === 0;
  const risk = baseRisk ? { ...baseRisk, dailyLossBps: tier0 ? Math.min(baseRisk.dailyLossBps, 300) : baseRisk.dailyLossBps, maxDrawdownBps: tier0 ? Math.min(baseRisk.maxDrawdownBps, 800) : baseRisk.maxDrawdownBps } : null;
  const maxLev = risk ? risk.maxLeverageBps / 10_000 : 5; // program default, see RiskParams::mvp_defaults()
  const nav = state?.nav ?? 0;
  const gross = state?.grossNotional ?? 0;
  const marginCap = nav * maxLev;
  const freeCollateral = Math.max(0, marginCap - gross);
  const marginRatio = marginCap > 0 ? gross / marginCap : 0;
  const dayStart = state?.dayStartNav ?? 0;
  const peak = state?.peakNav ?? 0;
  const dailyRatio = risk && dayStart > 0 ? Math.max(0, 1 - nav / dayStart) / (risk.dailyLossBps / 10_000) : 0;
  const ddRatio = risk && peak > 0 ? Math.max(0, 1 - nav / peak) / (risk.maxDrawdownBps / 10_000) : 0;
  const rows: { label: string; value: React.ReactNode; hint?: string }[] = [
    { label: "SOL · wallet", value: sol === null ? <Skeleton className="w-16 h-3" /> : sol.toFixed(4), hint: "Pays transaction fees" },
    { label: "USDC · wallet", value: usdc === null ? <Skeleton className="w-16 h-3" /> : usdc === "none" ? <span className="text-muted">no token account yet</span> : usd(usdc), hint: "Platform test-USDC mint; the entry fee and any self-stake come from here" },
  ];
  if (state) {
    rows.push({ label: live ? "Investor capital (NAV)" : "Simulated balance", value: usd(state.nav), hint: live ? "Pool NAV. You trade it, you cannot withdraw it" : "Virtual balance of the 30-day trial" });
    if (live && pool) {
      rows.push({ label: "Escrow · unvested", value: usd(fromPrice(pool.escrowTotal)), hint: "80% of net new profit, vesting in daily buckets" });
      rows.push({ label: "Escrow · claimable", value: <span className="text-up">{usd(fromPrice(pool.vestedClaimable))}</span>, hint: "Vested fees you can claim above the high-water mark (Escrow tab)" });
    }
  }

  return (
    <div className="flex flex-col">
    {/* `tbl-fit` because this panel is 272 px wide in the terminal's right
        column and a table cannot widen to fit "Investor capital (NAV)". It
        would paint over the panel edge instead. 58/42 keeps the balance column
        wide enough for "$24,857.61" without cents wrapping. */}
    <table className="tbl tbl-fit w-full">
      <thead>
        <tr>
          <th className="w-[58%]">Asset</th>
          <th className="text-right">Balance</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} title={r.hint}>
            <td className={`font-medium ${r.hint ? "underline decoration-dotted decoration-muted/50 underline-offset-2" : ""}`}>{r.label}</td>
            <td className="num text-right">{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
    {state?.ready && (
      <div className="border-t border-line p-3 flex flex-col gap-2" aria-label="Margin">
        <div className="flex items-baseline justify-between text-xxs">
          <span className="text-muted underline decoration-dotted decoration-muted/50 underline-offset-2" title={`Room before the ${maxLev.toFixed(0)}× gross-leverage cap: ${maxLev.toFixed(0)}× equity − open notional`}>
            Free collateral
          </span>
          <span className="num text-fg">{usd(freeCollateral)}</span>
        </div>
        <Gauge label="Margin ratio" value={`${(marginRatio * 100).toFixed(1)}%`} ratio={marginRatio} hint={`Open notional ${usd(gross)} of the ${maxLev.toFixed(0)}× cap ${usd(marginCap)}. Amber from 75%`} />
        <div className="grid grid-cols-2 gap-2">
          <Gauge label="Daily loss" value={`${(Math.max(0, 1 - (dayStart ? nav / dayStart : 1)) * 100).toFixed(2)}%`} ratio={dailyRatio} hint={`Locks at −${(risk?.dailyLossBps ?? 400) / 100}% of day-start NAV`} />
          <Gauge label="Drawdown" value={`${(Math.max(0, 1 - (peak ? nav / peak : 1)) * 100).toFixed(2)}%`} ratio={ddRatio} hint={`Locks at −${(risk?.maxDrawdownBps ?? 1000) / 100}% from peak NAV`} />
        </div>
      </div>
    )}
    {/* design reference: Claim USDC with its Completed / Failed claim history */}
    <div className="border-t border-line p-3 max-w-md flex flex-col gap-1.5">
      {/* Stacked, not two-up. Both labels carry a live countdown ("Claim USDC ·
          2d 19h 14m", "1-click on · 00:20:47"), so neither has a stable width,
          and 246 px split in two gives each 121 px. Measured at 130 and 126.
          They overflowed their cells and, being centred, were clipped at both
          ends. Full width fits both with room for the countdown to grow. */}
      <div className="flex flex-col gap-1.5">
        <ClaimUsdc className="[&>button]:w-full" />
        <SessionKeyButton size="md" className="[&>button]:w-full" />
      </div>
      <ClaimUsdc history className="[&>button]:hidden" />
    </div>
    </div>
  );
}
