import { Pool as PgPool } from "pg";
import type { TrialAccount } from "./engine";

export interface TrialStore {
  init(): Promise<void>;
  get(wallet: string): Promise<TrialAccount | null>;
  put(acc: TrialAccount): Promise<void>;
  all(): Promise<TrialAccount[]>;
}

export class MemoryTrialStore implements TrialStore {
  private m = new Map<string, TrialAccount>();
  async init() {}
  async get(w: string) {
    return this.m.get(w) ?? null;
  }
  async put(a: TrialAccount) {
    this.m.set(a.wallet, a);
  }
  async all() {
    return [...this.m.values()];
  }
}

export class PgTrialStore implements TrialStore {
  private pg: PgPool;
  constructor(url: string) {
    this.pg = new PgPool({ connectionString: url });
  }
  async init() {
    await this.pg.query(`CREATE TABLE IF NOT EXISTS trial_accounts (wallet TEXT PRIMARY KEY, data JSONB NOT NULL, updated_at BIGINT NOT NULL)`);
  }
  async get(w: string) {
    const r = await this.pg.query(`SELECT data FROM trial_accounts WHERE wallet=$1`, [w]);
    return r.rows[0]?.data ?? null;
  }
  async put(a: TrialAccount) {
    await this.pg.query(
      `INSERT INTO trial_accounts(wallet,data,updated_at) VALUES($1,$2,$3) ON CONFLICT(wallet) DO UPDATE SET data=$2, updated_at=$3`,
      [a.wallet, JSON.stringify(a), Math.floor(Date.now() / 1000)],
    );
  }
  async all() {
    const r = await this.pg.query(`SELECT data FROM trial_accounts`);
    return r.rows.map((x) => x.data);
  }
}
