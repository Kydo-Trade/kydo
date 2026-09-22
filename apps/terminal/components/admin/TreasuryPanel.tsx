"use client";
/** Treasury PDA: revenue (withdrawable), bounty reserve (ring-fenced, never withdrawable), dust, vault balance. */
import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import BN from "bn.js";
import { Skeleton } from "@kydo/ui";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { ChainTreasury } from "@/lib/chain";
import { CHAIN_POLL_MS } from "@/lib/config";
import { explainError } from "@/lib/errors";
import { fromPrice, shortAddr, toPriceBN, usd } from "@/lib/format";
import { useTx } from "@/lib/hooks";
import { usePlatform } from "@/lib/platform";
import { useVaultClient } from "@/lib/solana";
import { Addr, Row, Section } from "./common";

export function TreasuryPanel() {
  const { wallet, usdcMint } = usePlatform();
  const { client, readonly } = useVaultClient();
  const { connection } = useConnection();
  const [t, setT] = useState<ChainTreasury | null>(null);
  const [vaultBal, setVaultBal] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [confirm, setConfirm] = useState(false);
  const withdraw = useTx();

  const load = useCallback(async () => {
    try {
      const [tr, bal] = await Promise.all([
        readonly.treasury() as Promise<ChainTreasury>,
        connection.getTokenAccountBalance(readonly.pda.treasuryVault()).then((b) => Number(b.value.amount) / 1e6).catch(() => null),
      ]);
      setT(tr);
      setVaultBal(bal);
      setErr(null);
    } catch (e) {
      setErr(explainError(e).message);
    }
  }, [readonly, connection]);

  useEffect(() => {
    void load();
    const i = setInterval(load, CHAIN_POLL_MS * 2);
    return () => clearInterval(i);
  }, [load]);

  const revenue = t ? fromPrice(t.revenue) : 0;
  const reserve = t ? fromPrice(t.bountyReserve) : 0;
  // program: amount ≤ revenue AND vault − amount ≥ bounty_reserve
  const maxOut = Math.max(0, Math.min(revenue, vaultBal === null ? revenue : vaultBal - reserve));
  const amt = Number(amount);
  const amtOk = Number.isFinite(amt) && amt > 0 && amt <= maxOut + 1e-9;
  const dest = wallet && usdcMint ? client?.usdcAta(wallet, usdcMint) ?? null : null;

  const doWithdraw = () =>
    withdraw
      .run(
        `Withdrawing ${usd(amt)}…`,
        async () => {
          if (!client || !wallet || !usdcMint || !dest) throw new Error("wallet / USDC mint not ready");
          const info = await connection.getAccountInfo(dest);
          if (!info) throw new Error(`Your USDC associated token account (${shortAddr(dest.toBase58())}) does not exist. Click “Get test USDC” in the header first`);
          const lamports: BN = toPriceBN(amt);
          const sig = await client.withdrawTreasury(wallet, dest, lamports).rpc();
          await load();
          setAmount("");
          return sig;
        },
        (sig) => ({ title: `Withdrew ${usd(amt)}`, detail: `Sent to ${shortAddr(dest?.toBase58(), 6)}. Bounty reserve untouched.`, sig }),
      )
      .then((r) => r && setConfirm(false));

  const withdrawTitle = !client ? "Connect the admin wallet" : !amtOk ? (amt > maxOut ? `Max withdrawable is ${usd(maxOut)}` : "Enter an amount") : "Withdraw revenue (type WITHDRAW to confirm)";

  return (
    <Section
      title="Treasury"
      right={
        <button className="btn btn-sm btn-ghost" onClick={load} title="Reload treasury account">
          refresh
        </button>
      }
    >
      {err && <div className="notice notice-bad">{err}</div>}
      {!t && !err ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton lines={5} />
        </div>
      ) : (
        <>
          <Row l="Revenue (withdrawable)" v={usd(revenue)} cls="text-up" />
          <Row l="Bounty reserve (ring-fenced)" v={usd(reserve)} cls="text-amber" title="Pays permissionless lock / unwind callers. The program rejects any withdrawal that would dip into it (BountyReserveProtected)." />
          <Row l="Bounties paid" v={usd(t ? fromPrice(t.bountiesPaid) : 0)} />
          <Row l="Dust swept" v={usd(t ? fromPrice(t.dustSwept) : 0)} />
          <Row l="Vault balance" v={vaultBal === null ? "—" : usd(vaultBal)} title={readonly.pda.treasuryVault().toBase58()} />
        </>
      )}
      <div className="border-t border-line mt-1 pt-2 flex flex-col gap-2">
        <div className="label">Withdraw revenue</div>
        <div className="text-muted leading-relaxed">
          To the admin&apos;s USDC ATA <Addr a={dest?.toBase58()} n={6} />. The bounty reserve is <b className="text-fg">not</b> withdrawable by anyone. Max <span className="num text-fg">{usd(maxOut)}</span>.
        </div>
        <div className="flex gap-2 items-center">
          <input className="input w-32" placeholder="USDC" aria-label="Amount in USDC" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          <button className="btn btn-sm" onClick={() => setAmount(maxOut.toFixed(2))} disabled={maxOut <= 0} title="Fill in the maximum withdrawable amount">
            max
          </button>
          <button className="btn btn-primary" disabled={!amtOk || !client || withdraw.busy} onClick={() => setConfirm(true)} title={withdrawTitle}>
            {withdraw.busy ? "Withdrawing…" : "Withdraw"}
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        title={`Withdraw ${usd(amt)} from the treasury?`}
        confirmLabel="Withdraw"
        typeToConfirm="WITHDRAW"
        busy={withdraw.busy}
        error={withdraw.error}
        onCancel={() => setConfirm(false)}
        onConfirm={doWithdraw}
      >
        <p>
          Sends <span className="num">{usd(amt)}</span> USDC to <span className="num break-all">{dest?.toBase58()}</span>. Revenue after: <span className="num">{usd(revenue - amt)}</span>; bounty reserve <span className="num">{usd(reserve)}</span> stays untouched.
        </p>
      </ConfirmDialog>
    </Section>
  );
}
