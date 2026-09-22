"use client";
import { useState } from "react";
import BN from "bn.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { useToast } from "@kydo/ui";
import { PRICE_SCALE, encodeName } from "@kydo/sdk";
import { indexer } from "@/lib/api";
import { fromPrice, hexToBytes, usd } from "@/lib/format";
import { sha256Hex, useTx } from "@/lib/hooks";
import { usePlatform } from "@/lib/platform";
import { useVaultClient } from "@/lib/solana";

export function PoolForm({ onCreated }: { onCreated: (poolAddress: string) => void }) {
  const { config, usdcMint, profile, wallet, indexerOnline } = usePlatform();
  const { client } = useVaultClient();
  const { connection } = useConnection();
  const toast = useToast();
  const action = useTx();
  const [name, setName] = useState("");
  const [mandate, setMandate] = useState<"perps" | "spot">("perps");
  const [target, setTarget] = useState("5000");
  const [days, setDays] = useState(""); // blank = 30-day pool (product default); explicit 0 = open-ended
  const [strategy, setStrategy] = useState("");
  const [hash, setHash] = useState<string>("");

  const rawTier = profile?.tier ?? 1;
  const instant = rawTier === 0; // Eligible without a trial = Instant Funding (Tier 0)
  const tier = instant ? 0 : Math.max(1, Math.min(3, rawTier));
  const cap = config ? (instant ? fromPrice(profile?.instantCap ?? config.tierCaps[0]) : fromPrice(config.tierCaps[tier - 1])) : 5000;
  const targetNum = Number(target) || 0;
  const nameBytes = new TextEncoder().encode(name).length;

  const problems: string[] = [];
  if (!name.trim()) problems.push("name required");
  if (nameBytes > 32) problems.push("name > 32 bytes");
  if (!(targetNum > 0)) problems.push("target size required");
  if (targetNum > cap) problems.push(`target size exceeds the ${instant ? "Instant" : `Tier ${tier}`} cap ${usd(cap)}`);
  // On a compressed demo clock a "30-day" pool would expire in seconds and the
  // keeper would close it mid-session. Blank means open-ended there instead.
  const daySecs = config?.trial.daySecs ?? 86_400;
  const compressed = daySecs < 86_400;
  const daysNum = days.trim() === "" ? (compressed ? 0 : 30) : Number(days);
  if (!Number.isInteger(daysNum) || daysNum < 0 || daysNum > 3650) problems.push("duration must be a whole number of days (0–3650)");
  if (!client || !wallet) problems.push("connect wallet");
  if (!usdcMint) problems.push("USDC mint unknown (platform not initialised?)");

  const onStrategy = async (v: string) => {
    setStrategy(v);
    setHash(v ? await sha256Hex(v) : "");
  };

  const submit = async () => {
    if (!client || !wallet || !usdcMint || !profile || !config) return;
    const poolIndex = profile.poolsCreated;
    const poolAddr = client.pda.pool(wallet, poolIndex);
    const r = await action.run(
      "Creating pool…",
      async () => {
        const ata = client.usdcAta(wallet, usdcMint);
        const info = await connection.getAccountInfo(ata);
        if (!info) throw new Error("Your USDC associated token account does not exist. Click “Get test USDC” in the header first (1 USDC seed is required)");
        const h = await sha256Hex(strategy);
        const sig = await client
          .createPool(wallet, usdcMint, poolIndex, {
            name: encodeName(name.trim()),
            mandate: mandate === "perps" ? { perps: {} } : { spot: {} },
            targetSize: new BN(Math.round(targetNum * PRICE_SCALE)),
            strategyHash: hexToBytes(h),
            venue: { mockPerps: {} },
            durationDays: daysNum,
          })
          .rpc();
        try {
          if (strategy.trim()) await indexer.postStrategy(poolAddr.toBase58(), strategy);
        } catch (e) {
          toast.push({
            kind: "error",
            title: "Strategy text not stored",
            detail: `Pool created on-chain, but the indexer rejected the description (${(e as Error).message}). Re-post later: POST /pools/${poolAddr.toBase58()}/strategy`,
            ttl: 15_000,
          });
        }
        return sig;
      },
      (sig) => ({ title: `Pool created (${instant ? "Instant" : `Tier ${tier}`})`, detail: `${name.trim()} · target ${usd(targetNum)}${daysNum > 0 ? ` · runs ${daysNum} platform day${daysNum === 1 ? "" : "s"}` : " · open-ended"}. It activates once NAV reaches the floor.`, sig }),
    );
    if (r) onCreated(poolAddr.toBase58());
  };

  return (
    <div className="flex flex-col gap-2 w-full" data-tour="pool-form">
      <div className="grid grid-cols-2 gap-2">
        <label className="label flex flex-col gap-1">
          <span>
            Pool name <span className={`num normal-case tracking-normal ${nameBytes > 32 ? "text-down" : ""}`}>({nameBytes}/32 bytes)</span>
          </span>
          <input className="input font-sans" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Momentum Majors" maxLength={64} />
        </label>
        <label className="label flex flex-col gap-1">
          <span>Mandate</span>
          <select className="input font-sans" value={mandate} onChange={(e) => setMandate(e.target.value as "perps" | "spot")}>
            <option value="perps">Perps (MockPerps venue)</option>
            <option value="spot">Spot</option>
          </select>
        </label>
        <label className="label flex flex-col gap-1">
          <span>
            Target size (USD) <span className="num normal-case tracking-normal">· {instant ? "Instant" : `Tier ${tier}`} cap {usd(cap)}</span>
          </span>
          <input className={`input ${targetNum > cap ? "border-down" : ""}`} value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" />
        </label>
        <div className="label flex flex-col gap-1">
          <span>Venue</span>
          <div className="input font-sans flex items-center text-fg normal-case tracking-normal">MockPerps (devnet)</div>
        </div>
        <label className="label flex flex-col gap-1">
          <span>
            Duration (days){" "}
            <span className="normal-case tracking-normal">{compressed ? `· default open-ended · 1 day = ${daySecs}s on this demo, so 30 "days" ≈ ${Math.round((30 * daySecs) / 60) || "<1"} min` : "· default 30 · type 0 for open-ended"}</span>
          </span>
          <input className={`input ${problems.some((x) => x.startsWith("duration")) ? "border-down" : ""}`} value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" placeholder={compressed ? "0 (open-ended)" : "30"} title="After this many platform days the pool stops taking deposits and new trades, and is closed once flat (investors redeem at NAV, escrow keeps vesting). Days follow the platform day clock. Shortened on demo deployments." />
        </label>
      </div>
      <label className="label flex flex-col gap-1">
        <span>
          Strategy description <span className="normal-case tracking-normal">(optional, but it is the pitch investors read; sha256 goes on-chain so it can never be edited later)</span>
        </span>
        <textarea className="input font-sans h-24" value={strategy} onChange={(e) => void onStrategy(e.target.value)} placeholder="What you trade, how you size, when you stop." />
      </label>
      {hash && (
        <div className="text-xxs text-muted num break-all">
          sha256: {hash}
        </div>
      )}
      {config && daysNum > 0 && daysNum < config.risk.promotionDays && (
        <div className="notice notice-info">
          A {daysNum}-day pool ends before the {config.risk.promotionDays} continuous live days a Tier promotion requires. It will run its course at Tier {tier} and close. Use {config.risk.promotionDays}+ days (or 0 = open-ended) if you want this pool to climb the tier ladder.
        </div>
      )}
      {!indexerOnline && <div className="notice notice-warn">Indexer offline. The pool will be created on-chain but the description cannot be stored right now.</div>}
      <div className="text-xxs text-muted">
        {config ? (
          <>
            Risk limits are platform-wide ({config.risk.maxLeverageBps / 10000}× gross, {config.risk.maxPositions} positions,{" "}
            {config.risk.dailyLossBps / 100}% daily, {config.risk.maxDrawdownBps / 100}% drawdown
            {instant ? ". Tighter 3% / 8% while instant-funded, until your first promotion" : ""}). Creation transfers a 1 USDC seed to the pool vault against dead shares.
          </>
        ) : (
          <>Risk limits are platform-wide. Creation transfers a 1 USDC seed to the pool vault against dead shares.</>
        )}
      </div>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary h-8 font-semibold" disabled={problems.length > 0 || action.busy} onClick={submit} title={problems.length ? problems.join(" · ") : undefined}>
          {action.busy ? "Creating…" : `Create pool (${instant ? "Instant" : `Tier ${tier}`})`}
        </button>
        {problems.length > 0 && <span className="text-xxs text-amber">{problems.join(" · ")}</span>}
      </div>
    </div>
  );
}
