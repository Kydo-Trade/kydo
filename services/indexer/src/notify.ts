/**
 * Alert delivery (section 4.6 "alerting on this is a launch requirement", section 3.2 safety).
 *
 * Two optional sinks, both fire-and-forget (never block ingestion), each
 * retried once and logged:
 *   - ALERT_WEBHOOK_URL        generic JSON POST `{ kind, ts, title, text, data, links }`
 *   - ALERT_SLACK_WEBHOOK_URL  Slack incoming-webhook payload with a readable summary
 *
 * Alerts older than ALERT_MAX_AGE_SECS (a cold backfill replaying history) are
 * stored by the caller but not delivered.
 */
import pino from "pino";
import { env } from "./config";

const log = pino({ level: env.logLevel, name: "notify" });

export type NotifyKind = "cross_pool_hedge" | "pool_locked" | "platform_paused" | "keeper_low_sol";

export interface Notification {
  kind: NotifyKind;
  ts: number;
  /** One-line headline. */
  title: string;
  /** Multi-line plain-text summary (Slack mrkdwn-safe). */
  text: string;
  /** Structured payload (the stored alert row / event data). */
  data: Record<string, unknown>;
  links?: { label: string; url: string }[];
}

const EMOJI: Record<NotifyKind, string> = { cross_pool_hedge: ":rotating_light:", pool_locked: ":lock:", platform_paused: ":octagonal_sign:", keeper_low_sol: ":low_battery:" };

export const poolUrl = (pool: string) => `${env.publicInvestorUrl}/invest/${pool}`;
export const traderUrl = (wallet: string) => `${env.publicInvestorUrl}/invest?trader=${wallet}`;
export const short = (a: string | null | undefined, n = 4) => (a ? `${a.slice(0, n)}…${a.slice(-n)}` : "—");
const usd = (x: number) => `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export class Notifier {
  constructor(
    private webhookUrl = env.alertWebhookUrl,
    private slackUrl = env.alertSlackWebhookUrl,
    private maxAgeSecs = env.alertMaxAgeSecs,
  ) {}

  get enabled() {
    return { webhook: !!this.webhookUrl, slack: !!this.slackUrl };
  }

  /** Non-blocking: schedules delivery and returns immediately. */
  send(n: Notification) {
    const age = Math.floor(Date.now() / 1000) - n.ts;
    if (age > this.maxAgeSecs) {
      log.info({ kind: n.kind, ageSecs: age }, "alert older than ALERT_MAX_AGE_SECS. Stored, not delivered");
      return;
    }
    if (!this.webhookUrl && !this.slackUrl) {
      log.warn({ kind: n.kind, title: n.title }, "ALERT (no webhook configured. Set ALERT_WEBHOOK_URL / ALERT_SLACK_WEBHOOK_URL)");
      return;
    }
    if (this.webhookUrl) void this.post("webhook", this.webhookUrl, { kind: n.kind, ts: n.ts, title: n.title, text: n.text, data: n.data, links: n.links ?? [] });
    if (this.slackUrl) void this.post("slack", this.slackUrl, slackPayload(n));
  }

  private async post(sink: string, url: string, body: unknown) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 8_000);
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        log.info({ sink, attempt }, "alert delivered");
        return;
      } catch (e) {
        log[attempt === 2 ? "error" : "warn"]({ sink, attempt, err: String((e as Error).message ?? e) }, attempt === 2 ? "alert delivery FAILED" : "alert delivery failed, retrying");
        if (attempt === 1) await new Promise((r) => setTimeout(r, 1_500));
      }
    }
  }
}

function slackPayload(n: Notification) {
  const links = (n.links ?? []).map((l) => `<${l.url}|${l.label}>`).join(" · ");
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `${n.title}`.slice(0, 150), emoji: false } },
    { type: "section", text: { type: "mrkdwn", text: n.text.slice(0, 2_900) } },
  ];
  if (links) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: links }] });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `${n.kind} · ${new Date(n.ts * 1000).toISOString()}` }] });
  return { text: `${EMOJI[n.kind]} ${n.title}\n${n.text}${links ? `\n${links}` : ""}`, blocks };
}

// ---------- message builders ----------

export function hedgeNotification(a: {
  id: number;
  scope?: "market" | "cluster";
  poolA: string;
  poolB: string;
  traderA: string | null;
  traderB: string | null;
  marketId: number;
  marketIdA?: number;
  symbol: string;
  symbolA?: string;
  openedWithinSecs: number;
  notionalA: number;
  notionalB: number;
  sharedDepositors?: string[];
  ts: number;
}): Notification {
  const cluster = a.scope === "cluster";
  const pair = cluster && a.symbolA ? `${a.symbolA} vs ${a.symbol} (correlated cluster)` : a.symbol;
  return {
    kind: "cross_pool_hedge",
    ts: a.ts,
    title: `Cross-pool hedge suspected: ${pair} · ${usd(a.notionalA)} vs ${usd(a.notionalB)} · ${a.openedWithinSecs}s apart`,
    text: [
      cluster
        ? `*Cluster hedge*. Opposing positions in correlated markets ${a.symbolA ?? `#${a.marketIdA}`} / ${a.symbol}, similar size, opened ${a.openedWithinSecs}s apart (section 4.6, Vault Ledger section 7).`
        : `*Market* ${a.symbol} (#${a.marketId}). Opposing positions of similar size opened ${a.openedWithinSecs}s apart (section 4.6).`,
      `*Pool A* \`${a.poolA}\` · trader \`${a.traderA ?? "?"}\` · notional ${usd(a.notionalA)}`,
      `*Pool B* \`${a.poolB}\` · trader \`${a.traderB ?? "?"}\` · notional ${usd(a.notionalB)}`,
      ...(a.sharedDepositors?.length
        ? [`*Sybil linkage*. ${a.sharedDepositors.length} investor(s) hold positions in BOTH pools: ${a.sharedDepositors.map((w) => `\`${short(w)}\``).join(", ")}`]
        : []),
      `Review both pools; the admin pause is the MVP defence. Alert id ${a.id}.`,
    ].join("\n"),
    data: { ...a },
    links: [
      { label: `pool A ${short(a.poolA)}`, url: poolUrl(a.poolA) },
      { label: `pool B ${short(a.poolB)}`, url: poolUrl(a.poolB) },
      ...(a.traderA ? [{ label: `trader A ${short(a.traderA)}`, url: traderUrl(a.traderA) }] : []),
      ...(a.traderB ? [{ label: `trader B ${short(a.traderB)}`, url: traderUrl(a.traderB) }] : []),
    ],
  };
}

export function lockNotification(a: { pool: string; trader: string | null; reason: string; nav: number; escrowReturned: number; caller: string | null; ts: number; sig: string }): Notification {
  return {
    kind: "pool_locked",
    ts: a.ts,
    title: `Pool locked (${a.reason.replace("_", " ")}) · NAV ${usd(a.nav)} · ${short(a.pool, 6)}`,
    text: [
      `*Pool* \`${a.pool}\` · trader \`${a.trader ?? "?"}\``,
      `*Reason* ${a.reason} · *NAV at lock* ${usd(a.nav)} · unvested escrow returned ${usd(a.escrowReturned)}`,
      `Locked by \`${a.caller ?? "?"}\` · tx \`${a.sig}\``,
    ].join("\n"),
    data: { ...a },
    links: [{ label: `pool ${short(a.pool)}`, url: poolUrl(a.pool) }, ...(a.trader ? [{ label: `trader ${short(a.trader)}`, url: traderUrl(a.trader) }] : [])],
  };
}

export function pauseNotification(a: { paused: boolean; ts: number; sig: string }): Notification {
  return {
    kind: "platform_paused",
    ts: a.ts,
    title: a.paused ? "PLATFORM PAUSED by admin. Trading and lifecycle actions halted" : "Platform unpaused by admin",
    text: `*paused* = ${a.paused} · tx \`${a.sig}\`${a.paused ? "\nRedemptions stay open; place/close trades, deposits, activation and promotion are blocked until unpause." : ""}`,
    data: { ...a },
  };
}

export function keeperLowSolNotification(a: { keeper: string; sol: number; thresholdSol: number; ts: number }): Notification {
  return {
    kind: "keeper_low_sol",
    ts: a.ts,
    title: `Keeper key low on SOL: ${a.sol.toFixed(4)} SOL (alert threshold ${a.thresholdSol} SOL)`,
    text: `\`${a.keeper}\` pays oracle pushes, marks, locks and faucet claims. Below ~0.005 SOL it all pauses.\nTop up: https://faucet.solana.com (devnet) or transfer SOL to the address above.`,
    data: { ...a },
  };
}
