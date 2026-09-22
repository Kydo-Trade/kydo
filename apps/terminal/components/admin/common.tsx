"use client";
import type { ReactNode } from "react";
import { poolRecordUrl, traderRecordUrl } from "@/lib/config";
import { shortAddr } from "@/lib/format";

/** Card section: panel title (uppercase label) with an optional right-hand slot, padded body. */
export function Section({ title, right, children, className = "", bodyClassName = "" }: { title: string; right?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={`panel flex flex-col min-w-0 ${className}`} aria-label={title}>
      <div className="panel-title">
        <span>{title}</span>
        {right && <span className="meta flex items-center gap-2 overflow-visible">{right}</span>}
      </div>
      <div className={`panel-body text-xs flex flex-col gap-1 min-w-0 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function Row({ l, v, cls = "", title }: { l: string; v: ReactNode; cls?: string; title?: string }) {
  return (
    <div className="kv" title={title}>
      <span>{l}</span>
      <span className={cls}>{v}</span>
    </div>
  );
}

/** Short address; full address on hover; optional external link. */
export function Addr({ a, n = 4, href, cls = "" }: { a: string | null | undefined; n?: number; href?: string; cls?: string }) {
  if (!a) return <span className="text-muted">—</span>;
  const s = <span className={`num ${cls}`}>{shortAddr(a, n)}</span>;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" title={a} className="hover:text-accent underline decoration-line underline-offset-2 rounded">
      {s}
    </a>
  ) : (
    <span title={a}>{s}</span>
  );
}

export const PoolLink = ({ pool, n = 4, label }: { pool: string; n?: number; label?: string }) =>
  label ? (
    <a href={`/invest/${pool}`} title={pool} className="hover:text-accent underline decoration-line underline-offset-2 rounded">
      {label}
    </a>
  ) : (
    <Addr a={pool} n={n} href={`/invest/${pool}`} />
  );

export const TraderLink = ({ wallet, n = 4 }: { wallet: string | null; n?: number }) => (wallet ? <Addr a={wallet} n={n} href={traderRecordUrl(wallet)} /> : <span className="text-muted">—</span>);

export const sigShort = (sig: string) => `${sig.slice(0, 8)}…`;
