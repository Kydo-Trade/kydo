/**
 * Storage abstraction with two implementations:
 *  - `PgStore`     . Postgres (production / docker compose)
 *  - `MemoryStore` . In-process, for local development and tests
 *
 * Both hold the same read model: raw events, trades, NAV marks, account
 * snapshots, strategy texts, trial roots and alerts.
 */
import { Pool as PgPool } from "pg";
import { readFileSync } from "fs";
import { join } from "path";

export interface EventRow {
  sig: string;
  idx: number;
  slot: number;
  ts: number;
  name: string;
  pool: string | null;
  trader: string | null;
  data: any;
}
export interface TradeRow {
  sig: string;
  idx: number;
  ts: number;
  pool: string;
  marketId: number;
  side: number;
  isClose: boolean;
  baseQty: string;
  fillPrice: string;
  oraclePrice: string;
  oracleSlot: number;
  fee: string;
  realizedPnl: string;
  navAfter: string;
  positionQtyAfter: string;
}
export interface NavMarkRow {
  pool: string;
  ts: number;
  nav: string;
  nps: string;
  peakNav: string;
  dayStartNav: string;
  grossNotional: string;
}
export interface SnapshotRow {
  address: string;
  data: any;
  updatedAt: number;
}
export interface TrialRootRow {
  trader: string;
  day: number;
  root: string;
  ts: number;
  sig: string;
}
export interface AlertRow {
  id: number;
  type: string;
  ts: number;
  data: any;
  acked: boolean;
}

export interface Store {
  init(): Promise<void>;
  getCursor(key: string): Promise<string | null>;
  setCursor(key: string, value: string): Promise<void>;

  insertEvent(e: EventRow): Promise<boolean>;
  events(filter: { pool?: string; trader?: string; name?: string; limit?: number }): Promise<EventRow[]>;

  insertTrade(t: TradeRow): Promise<void>;
  trades(pool: string, limit: number, before?: number): Promise<TradeRow[]>;
  recentOpens(marketId: number, sinceTs: number): Promise<TradeRow[]>;

  insertNavMark(m: NavMarkRow): Promise<void>;
  navMarks(pool: string, from?: number, to?: number, limit?: number): Promise<NavMarkRow[]>;

  upsertPool(address: string, trader: string, status: string, data: any): Promise<void>;
  pools(): Promise<SnapshotRow[]>;
  pool(address: string): Promise<SnapshotRow | null>;
  deletePoolsNotIn(addresses: string[]): Promise<void>;

  upsertTrader(wallet: string, data: any): Promise<void>;
  trader(wallet: string): Promise<SnapshotRow | null>;

  upsertInvestorPosition(address: string, pool: string, investor: string, data: any): Promise<void>;
  investorPositions(filter: { investor?: string; pool?: string }): Promise<SnapshotRow[]>;
  deleteInvestorPositionsNotIn(addresses: string[]): Promise<void>;
  investorCounts(): Promise<Map<string, number>>;

  setStrategy(pool: string, text: string): Promise<void>;
  strategy(pool: string): Promise<string | null>;

  upsertTrialRoot(r: TrialRootRow): Promise<void>;
  trialRoots(trader: string): Promise<TrialRootRow[]>;

  insertAlert(type: string, ts: number, data: any): Promise<AlertRow>;
  /** Newest first; `since` = only alerts with ts > since. */
  alerts(limit: number, since?: number): Promise<AlertRow[]>;
  ackAlert(id: number): Promise<AlertRow | null>;
}

const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
export class MemoryStore implements Store {
  private cursors = new Map<string, string>();
  private evs: EventRow[] = [];
  private evKeys = new Set<string>();
  private trs: TradeRow[] = [];
  private marks: NavMarkRow[] = [];
  private poolRows = new Map<string, SnapshotRow & { trader: string; status: string }>();
  private traderRows = new Map<string, SnapshotRow>();
  private ipRows = new Map<string, SnapshotRow & { pool: string; investor: string }>();
  private strategies = new Map<string, string>();
  private roots = new Map<string, TrialRootRow>();
  private alertRows: AlertRow[] = [];

  async init() {}
  async getCursor(k: string) {
    return this.cursors.get(k) ?? null;
  }
  async setCursor(k: string, v: string) {
    this.cursors.set(k, v);
  }
  async insertEvent(e: EventRow) {
    const k = `${e.sig}:${e.idx}`;
    if (this.evKeys.has(k)) return false;
    this.evKeys.add(k);
    this.evs.push(e);
    return true;
  }
  async events(f: { pool?: string; trader?: string; name?: string; limit?: number }) {
    return this.evs
      .filter((e) => (!f.pool || e.pool === f.pool) && (!f.trader || e.trader === f.trader) && (!f.name || e.name === f.name))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, f.limit ?? 100);
  }
  async insertTrade(t: TradeRow) {
    if (!this.trs.some((x) => x.sig === t.sig && x.idx === t.idx)) this.trs.push(t);
  }
  async trades(pool: string, limit: number, before?: number) {
    return this.trs
      .filter((t) => t.pool === pool && (!before || t.ts < before))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }
  async recentOpens(marketId: number, sinceTs: number) {
    return this.trs.filter((t) => t.marketId === marketId && !t.isClose && t.ts >= sinceTs);
  }
  async insertNavMark(m: NavMarkRow) {
    this.marks.push(m);
  }
  async navMarks(pool: string, from?: number, to?: number, limit = 2000) {
    const rows = this.marks.filter((m) => m.pool === pool && (!from || m.ts >= from) && (!to || m.ts <= to));
    return rows.slice(-limit);
  }
  async upsertPool(address: string, trader: string, status: string, data: any) {
    this.poolRows.set(address, { address, trader, status, data, updatedAt: now() });
  }
  async pools() {
    return [...this.poolRows.values()];
  }
  async pool(address: string) {
    return this.poolRows.get(address) ?? null;
  }
  async deletePoolsNotIn(addresses: string[]) {
    const keep = new Set(addresses);
    for (const k of [...this.poolRows.keys()]) if (!keep.has(k)) this.poolRows.delete(k);
  }
  async upsertTrader(wallet: string, data: any) {
    this.traderRows.set(wallet, { address: wallet, data, updatedAt: now() });
  }
  async trader(wallet: string) {
    return this.traderRows.get(wallet) ?? null;
  }
  async upsertInvestorPosition(address: string, pool: string, investor: string, data: any) {
    this.ipRows.set(address, { address, pool, investor, data, updatedAt: now() });
  }
  async investorPositions(f: { investor?: string; pool?: string }) {
    return [...this.ipRows.values()].filter((r) => (!f.investor || r.investor === f.investor) && (!f.pool || r.pool === f.pool));
  }
  async deleteInvestorPositionsNotIn(addresses: string[]) {
    const keep = new Set(addresses);
    for (const k of [...this.ipRows.keys()]) if (!keep.has(k)) this.ipRows.delete(k);
  }
  async investorCounts() {
    const m = new Map<string, number>();
    for (const r of this.ipRows.values()) m.set(r.pool, (m.get(r.pool) ?? 0) + 1);
    return m;
  }
  async setStrategy(pool: string, text: string) {
    this.strategies.set(pool, text);
  }
  async strategy(pool: string) {
    return this.strategies.get(pool) ?? null;
  }
  async upsertTrialRoot(r: TrialRootRow) {
    this.roots.set(`${r.trader}:${r.day}`, r);
  }
  async trialRoots(trader: string) {
    return [...this.roots.values()].filter((r) => r.trader === trader).sort((a, b) => a.day - b.day);
  }
  async insertAlert(type: string, ts: number, data: any) {
    const row: AlertRow = { id: this.alertRows.length + 1, type, ts, data, acked: false };
    this.alertRows.push(row);
    return row;
  }
  async alerts(limit: number, since?: number) {
    const rows = since ? this.alertRows.filter((a) => a.ts > since) : this.alertRows;
    return rows.slice(-limit).reverse();
  }
  async ackAlert(id: number) {
    const row = this.alertRows.find((a) => a.id === id);
    if (!row) return null;
    row.acked = true;
    return row;
  }
}

// ---------------------------------------------------------------------------
export class PgStore implements Store {
  private pg: PgPool;
  constructor(url: string) {
    this.pg = new PgPool({ connectionString: url });
  }
  async init() {
    const sql = readFileSync(join(__dirname, "..", "sql", "001_init.sql"), "utf8");
    await this.pg.query(sql);
  }
  async getCursor(k: string) {
    const r = await this.pg.query("SELECT value FROM cursor WHERE key=$1", [k]);
    return r.rows[0]?.value ?? null;
  }
  async setCursor(k: string, v: string) {
    await this.pg.query("INSERT INTO cursor(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2", [k, v]);
  }
  async insertEvent(e: EventRow) {
    const r = await this.pg.query(
      `INSERT INTO events(sig,idx,slot,ts,name,pool,trader,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (sig,idx) DO NOTHING RETURNING id`,
      [e.sig, e.idx, e.slot, e.ts, e.name, e.pool, e.trader, JSON.stringify(e.data)],
    );
    return r.rowCount === 1;
  }
  async events(f: { pool?: string; trader?: string; name?: string; limit?: number }) {
    const r = await this.pg.query(
      `SELECT sig,idx,slot,ts,name,pool,trader,data FROM events
       WHERE ($1::text IS NULL OR pool=$1) AND ($2::text IS NULL OR trader=$2) AND ($3::text IS NULL OR name=$3)
       ORDER BY ts DESC LIMIT $4`,
      [f.pool ?? null, f.trader ?? null, f.name ?? null, f.limit ?? 100],
    );
    return r.rows.map((x) => ({ ...x, slot: Number(x.slot), ts: Number(x.ts) }));
  }
  async insertTrade(t: TradeRow) {
    await this.pg.query(
      `INSERT INTO trades(sig,idx,ts,pool,market_id,side,is_close,base_qty,fill_price,oracle_price,oracle_slot,fee,realized_pnl,nav_after,position_qty_after)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (sig,idx) DO NOTHING`,
      [t.sig, t.idx, t.ts, t.pool, t.marketId, t.side, t.isClose, t.baseQty, t.fillPrice, t.oraclePrice, t.oracleSlot, t.fee, t.realizedPnl, t.navAfter, t.positionQtyAfter],
    );
  }
  private mapTrade = (x: any): TradeRow => ({
    sig: x.sig, idx: x.idx, ts: Number(x.ts), pool: x.pool, marketId: x.market_id, side: x.side, isClose: x.is_close,
    baseQty: x.base_qty, fillPrice: x.fill_price, oraclePrice: x.oracle_price, oracleSlot: Number(x.oracle_slot),
    fee: x.fee, realizedPnl: x.realized_pnl, navAfter: x.nav_after, positionQtyAfter: x.position_qty_after,
  });
  async trades(pool: string, limit: number, before?: number) {
    const r = await this.pg.query(
      `SELECT * FROM trades WHERE pool=$1 AND ($2::bigint IS NULL OR ts<$2) ORDER BY ts DESC LIMIT $3`,
      [pool, before ?? null, limit],
    );
    return r.rows.map(this.mapTrade);
  }
  async recentOpens(marketId: number, sinceTs: number) {
    const r = await this.pg.query(`SELECT * FROM trades WHERE market_id=$1 AND is_close=false AND ts>=$2`, [marketId, sinceTs]);
    return r.rows.map(this.mapTrade);
  }
  async insertNavMark(m: NavMarkRow) {
    await this.pg.query(
      `INSERT INTO nav_marks(pool,ts,nav,nps,peak_nav,day_start_nav,gross_notional) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [m.pool, m.ts, m.nav, m.nps, m.peakNav, m.dayStartNav, m.grossNotional],
    );
  }
  async navMarks(pool: string, from?: number, to?: number, limit = 2000) {
    const r = await this.pg.query(
      `SELECT * FROM (SELECT pool,ts,nav,nps,peak_nav,day_start_nav,gross_notional FROM nav_marks
        WHERE pool=$1 AND ($2::bigint IS NULL OR ts>=$2) AND ($3::bigint IS NULL OR ts<=$3) ORDER BY ts DESC LIMIT $4) q ORDER BY ts ASC`,
      [pool, from ?? null, to ?? null, limit],
    );
    return r.rows.map((x) => ({ pool: x.pool, ts: Number(x.ts), nav: x.nav, nps: x.nps, peakNav: x.peak_nav, dayStartNav: x.day_start_nav, grossNotional: x.gross_notional }));
  }
  async upsertPool(address: string, trader: string, status: string, data: any) {
    await this.pg.query(
      `INSERT INTO pools(address,trader,status,data,updated_at) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(address) DO UPDATE SET trader=$2,status=$3,data=$4,updated_at=$5`,
      [address, trader, status, JSON.stringify(data), now()],
    );
  }
  async pools() {
    const r = await this.pg.query(`SELECT address,data,updated_at FROM pools`);
    return r.rows.map((x) => ({ address: x.address, data: x.data, updatedAt: Number(x.updated_at) }));
  }
  async pool(address: string) {
    const r = await this.pg.query(`SELECT address,data,updated_at FROM pools WHERE address=$1`, [address]);
    return r.rows[0] ? { address, data: r.rows[0].data, updatedAt: Number(r.rows[0].updated_at) } : null;
  }
  async deletePoolsNotIn(addresses: string[]) {
    await this.pg.query(`DELETE FROM pools WHERE NOT (address = ANY($1::text[]))`, [addresses]);
  }
  async upsertTrader(wallet: string, data: any) {
    await this.pg.query(
      `INSERT INTO traders(wallet,data,updated_at) VALUES($1,$2,$3) ON CONFLICT(wallet) DO UPDATE SET data=$2,updated_at=$3`,
      [wallet, JSON.stringify(data), now()],
    );
  }
  async trader(wallet: string) {
    const r = await this.pg.query(`SELECT data,updated_at FROM traders WHERE wallet=$1`, [wallet]);
    return r.rows[0] ? { address: wallet, data: r.rows[0].data, updatedAt: Number(r.rows[0].updated_at) } : null;
  }
  async upsertInvestorPosition(address: string, pool: string, investor: string, data: any) {
    await this.pg.query(
      `INSERT INTO investor_positions(address,pool,investor,data,updated_at) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(address) DO UPDATE SET pool=$2,investor=$3,data=$4,updated_at=$5`,
      [address, pool, investor, JSON.stringify(data), now()],
    );
  }
  async investorPositions(f: { investor?: string; pool?: string }) {
    const r = await this.pg.query(
      `SELECT address,data,updated_at FROM investor_positions WHERE ($1::text IS NULL OR investor=$1) AND ($2::text IS NULL OR pool=$2)`,
      [f.investor ?? null, f.pool ?? null],
    );
    return r.rows.map((x) => ({ address: x.address, data: x.data, updatedAt: Number(x.updated_at) }));
  }
  async deleteInvestorPositionsNotIn(addresses: string[]) {
    await this.pg.query(`DELETE FROM investor_positions WHERE NOT (address = ANY($1::text[]))`, [addresses]);
  }
  async investorCounts() {
    const r = await this.pg.query(`SELECT pool, COUNT(*)::int AS n FROM investor_positions GROUP BY pool`);
    return new Map(r.rows.map((x) => [x.pool, x.n]));
  }
  async setStrategy(pool: string, text: string) {
    await this.pg.query(`INSERT INTO strategies(pool,text) VALUES($1,$2) ON CONFLICT(pool) DO UPDATE SET text=$2`, [pool, text]);
  }
  async strategy(pool: string) {
    const r = await this.pg.query(`SELECT text FROM strategies WHERE pool=$1`, [pool]);
    return r.rows[0]?.text ?? null;
  }
  async upsertTrialRoot(t: TrialRootRow) {
    await this.pg.query(
      `INSERT INTO trial_roots(trader,day,root,ts,sig) VALUES($1,$2,$3,$4,$5) ON CONFLICT(trader,day) DO UPDATE SET root=$3,ts=$4,sig=$5`,
      [t.trader, t.day, t.root, t.ts, t.sig],
    );
  }
  async trialRoots(trader: string) {
    const r = await this.pg.query(`SELECT * FROM trial_roots WHERE trader=$1 ORDER BY day`, [trader]);
    return r.rows.map((x) => ({ ...x, ts: Number(x.ts) }));
  }
  private mapAlert = (x: any): AlertRow => ({ id: Number(x.id), type: x.type, ts: Number(x.ts), data: x.data, acked: !!x.acked });
  async insertAlert(type: string, ts: number, data: any) {
    const r = await this.pg.query(`INSERT INTO alerts(type,ts,data) VALUES($1,$2,$3) RETURNING id`, [type, ts, JSON.stringify(data)]);
    return { id: Number(r.rows[0].id), type, ts, data, acked: false };
  }
  async alerts(limit: number, since?: number) {
    const r = await this.pg.query(`SELECT * FROM alerts WHERE ($2::bigint IS NULL OR ts>$2) ORDER BY ts DESC, id DESC LIMIT $1`, [limit, since ?? null]);
    return r.rows.map(this.mapAlert);
  }
  async ackAlert(id: number) {
    const r = await this.pg.query(`UPDATE alerts SET acked=true WHERE id=$1 RETURNING *`, [id]);
    return r.rows[0] ? this.mapAlert(r.rows[0]) : null;
  }
}

export function createStore(kind: "pg" | "memory", url?: string): Store {
  if (kind === "pg") {
    if (!url) throw new Error("DATABASE_URL required for pg store");
    return new PgStore(url);
  }
  return new MemoryStore();
}
