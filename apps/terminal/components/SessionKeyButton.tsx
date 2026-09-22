"use client";
import { useEffect, useState } from "react";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { useVaultClient } from "@/lib/solana";
import { usePlatform } from "@/lib/platform";
import { clearSession, newSession, useSession } from "@/lib/session";
import { useTx } from "@/lib/hooks";
import { countdown } from "@/lib/format";
import { ConfirmDialog } from "./ConfirmDialog";

const TTL_OPTIONS = [
  { label: "1 h", secs: 3_600 },
  { label: "4 h", secs: 4 * 3_600 },
  { label: "24 h", secs: 24 * 3_600 },
];

/**
 * "1-click trading" control: authorises a browser keypair as a trade-only
 * session key (one wallet signature), shows the remaining time, revokes.
 */
export function SessionKeyButton({ size = "sm", className = "" }: { size?: "sm" | "md"; className?: string }) {
  const { client } = useVaultClient();
  const { wallet, profile } = usePlatform();
  const session = useSession(wallet);
  const [onChain, setOnChain] = useState<{ key: string; expiresAt: number } | null>(null);
  /** null = unknown, false = deployed program predates session keys (upgrade pending). */
  const [supported, setSupported] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [ttl, setTtl] = useState(TTL_OPTIONS[1].secs);
  const act = useTx();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Mirror the on-chain session so a stale localStorage entry never looks "active".
  useEffect(() => {
    if (!client || !wallet) return;
    let alive = true;
    const load = () =>
      client
        .sessionKey(wallet)
        .then((s: any) => alive && setOnChain(s ? { key: new PublicKey(s.key).toBase58(), expiresAt: Number(s.expiresAt) } : null))
        .catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [client, wallet, session?.pubkey]);

  // Probe once whether the deployed program knows `set_session_key` (simulate, no signature, fresh blockhash).
  useEffect(() => {
    if (!client || !wallet) return;
    let alive = true;
    (async () => {
      try {
        const conn = client.provider.connection;
        const tx = await client.setSessionKey(wallet, PublicKey.unique(), 60).transaction();
        tx.feePayer = wallet;
        tx.recentBlockhash = (await conn.getLatestBlockhash("finalized")).blockhash;
        const sim = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true });
        const logs = (sim.value.logs ?? []).join("\n");
        const missing = /InstructionFallbackNotFound|Fallback functions are not supported|InstructionDidNotDeserialize/.test(logs);
        if (alive) setSupported(!missing);
      } catch {
        if (alive) setSupported(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, wallet]);

  if (!wallet || !client || !profile) return null;
  const hasPool = profile.activePool && profile.activePool.toBase58() !== PublicKey.default.toBase58();
  if (!hasPool) return null;

  const active = !!session && !!onChain && onChain.key === session.pubkey && onChain.expiresAt > now;

  const enable = () =>
    act.run(
      "Authorising session key…",
      async () => {
        const { keypair, expiresAt } = newSession(wallet.toBase58(), ttl);
        try {
          // The session key pays its own transaction fees: top it up with 0.02 SOL (~4,000 trades).
          const sig = await client
            .setSessionKey(wallet, keypair.publicKey, ttl)
            .preInstructions([SystemProgram.transfer({ fromPubkey: wallet, toPubkey: keypair.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL })])
            .rpc();
          setOnChain({ key: keypair.publicKey.toBase58(), expiresAt });
          setOpen(false);
          return sig;
        } catch (e) {
          clearSession(wallet.toBase58());
          throw e;
        }
      },
      (sig) => ({ title: "1-click trading enabled", detail: `Trades are signed locally for the next ${countdown(Math.floor(Date.now() / 1000) + ttl)}.`, sig }),
    );

  const revoke = () =>
    act.run(
      "Revoking session key…",
      async () => {
        const sig = onChain ? await client.revokeSessionKey(wallet).rpc() : "";
        clearSession(wallet.toBase58());
        setOnChain(null);
        return sig;
      },
      (sig) => ({ title: "Session key revoked", detail: "Trades need a wallet signature again.", sig: sig || null }),
    );

  // `btn-ell` so the countdown inside the label can ellipsise instead of
  // pushing the button wider than whatever column it lands in.
  const cls = `btn btn-ell ${size === "sm" ? "btn-sm" : ""} ${className}`;
  return (
    <>
      {active ? (
        <button className={`${cls} btn-outline-up`} onClick={revoke} disabled={act.busy} title={`Session key ${onChain!.key.slice(0, 6)}… signs trades locally. Click to revoke.`}>
          <span className="shrink-0" aria-hidden>
            ⚡
          </span>
          {/* One element, not a bare text node: `text-overflow` cannot reach an
              anonymous flex item, so an unwrapped label clips mid-glyph. */}
          <span className="num">1-click on · {countdown(onChain!.expiresAt)}</span>
        </button>
      ) : (
        <button
          className={`${cls} ${supported === false ? "opacity-60" : ""}`}
          onClick={() => setOpen(true)}
          disabled={act.busy || supported === false}
          title={
            supported === false
              ? "Not available yet: the program deployed on this network predates session keys. Run the program upgrade (NETWORK=devnet scripts/dev-stack.sh upgrade)."
              : "Authorise a browser session key so trades don't need a wallet popup"
          }
        >
          <span className="shrink-0" aria-hidden>
            ⚡
          </span>
          <span>{act.busy ? "Authorising…" : supported === false ? "1-click · upgrade pending" : "1-click trading"}</span>
        </button>
      )}
      <ConfirmDialog
        open={open}
        title="Enable 1-click trading?"
        confirmLabel="Authorise session key"
        busy={act.busy}
        error={act.error}
        onCancel={() => setOpen(false)}
        onConfirm={() => void enable()}
      >
        <p>
          Your wallet signs <b>once</b> to authorise a keypair generated in this browser. Until it expires, <b>place / close trade</b> instructions are signed locally. No popups.
        </p>
        <ul className="list-disc pl-4 text-muted">
          <li>The session key can <b>only</b> trade your pool under the same risk guard. It cannot deposit, redeem, claim fees, close the pool or move funds.</li>
          <li>It lives in this browser&apos;s storage. Anyone with access to this browser could trade your pool until it expires or you revoke it.</li>
          <li>Revoke any time with one click (or it expires automatically).</li>
        </ul>
        <div className="flex items-center gap-2 pt-1" role="radiogroup" aria-label="Session validity">
          <span className="label">Valid for</span>
          {TTL_OPTIONS.map((o) => (
            <button key={o.secs} type="button" role="radio" aria-checked={ttl === o.secs} className={`btn btn-sm ${ttl === o.secs ? "btn-primary" : ""}`} onClick={() => setTtl(o.secs)}>
              {o.label}
            </button>
          ))}
        </div>
      </ConfirmDialog>
    </>
  );
}
