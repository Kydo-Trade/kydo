-- Kydo indexer schema. The indexer is a read model only (section 3.4):
-- chain state is the source of truth; everything here can be rebuilt.

CREATE TABLE IF NOT EXISTS cursor (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id      BIGSERIAL PRIMARY KEY,
  sig     TEXT NOT NULL,
  idx     INT  NOT NULL,
  slot    BIGINT NOT NULL,
  ts      BIGINT NOT NULL,
  name    TEXT NOT NULL,
  pool    TEXT,
  trader  TEXT,
  data    JSONB NOT NULL,
  UNIQUE (sig, idx)
);
CREATE INDEX IF NOT EXISTS events_pool_ts ON events (pool, ts DESC);
CREATE INDEX IF NOT EXISTS events_trader_ts ON events (trader, ts DESC);
CREATE INDEX IF NOT EXISTS events_name_ts ON events (name, ts DESC);

CREATE TABLE IF NOT EXISTS trades (
  id                 BIGSERIAL PRIMARY KEY,
  sig                TEXT NOT NULL,
  idx                INT  NOT NULL,
  ts                 BIGINT NOT NULL,
  pool               TEXT NOT NULL,
  market_id          INT  NOT NULL,
  side               SMALLINT NOT NULL,
  is_close           BOOLEAN NOT NULL,
  base_qty           NUMERIC NOT NULL,
  fill_price         NUMERIC NOT NULL,
  oracle_price       NUMERIC NOT NULL,
  oracle_slot        BIGINT NOT NULL,
  fee                NUMERIC NOT NULL,
  realized_pnl       NUMERIC NOT NULL,
  nav_after          NUMERIC NOT NULL,
  position_qty_after NUMERIC NOT NULL,
  UNIQUE (sig, idx)
);
CREATE INDEX IF NOT EXISTS trades_pool_ts ON trades (pool, ts DESC);
CREATE INDEX IF NOT EXISTS trades_market_ts ON trades (market_id, ts DESC);

CREATE TABLE IF NOT EXISTS nav_marks (
  id             BIGSERIAL PRIMARY KEY,
  pool           TEXT NOT NULL,
  ts             BIGINT NOT NULL,
  nav            NUMERIC NOT NULL,
  nps            NUMERIC NOT NULL,
  peak_nav       NUMERIC NOT NULL,
  day_start_nav  NUMERIC NOT NULL,
  gross_notional NUMERIC NOT NULL
);
CREATE INDEX IF NOT EXISTS nav_marks_pool_ts ON nav_marks (pool, ts);

-- Latest decoded account snapshots (jsonb of the Anchor-decoded account).
CREATE TABLE IF NOT EXISTS pools (
  address    TEXT PRIMARY KEY,
  trader     TEXT NOT NULL,
  status     TEXT NOT NULL,
  data       JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS traders (
  wallet     TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS investor_positions (
  address    TEXT PRIMARY KEY,
  pool       TEXT NOT NULL,
  investor   TEXT NOT NULL,
  data       JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS investor_positions_investor ON investor_positions (investor);
CREATE INDEX IF NOT EXISTS investor_positions_pool ON investor_positions (pool);

CREATE TABLE IF NOT EXISTS strategies (
  pool TEXT PRIMARY KEY,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trial_roots (
  trader TEXT NOT NULL,
  day    INT  NOT NULL,
  root   TEXT NOT NULL,
  ts     BIGINT NOT NULL,
  sig    TEXT NOT NULL,
  PRIMARY KEY (trader, day)
);

CREATE TABLE IF NOT EXISTS alerts (
  id     BIGSERIAL PRIMARY KEY,
  type   TEXT NOT NULL,
  ts     BIGINT NOT NULL,
  data   JSONB NOT NULL
);
-- migration-safe: admin acknowledgement flag (POST /alerts/:id/ack)
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acked BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS alerts_ts ON alerts (ts DESC);
