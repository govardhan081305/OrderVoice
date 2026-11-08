// Database layer with one async interface for two engines:
//   - SQLite (default, zero setup) via Node's built-in node:sqlite
//   - PostgreSQL (set DATABASE_URL) via pg
// All queries in the app are written with `?` placeholders and portable SQL,
// so switching engine only touches this file.
const fs = require('fs');
const path = require('path');
const config = require('./config');

// Timestamps are stored as epoch milliseconds (BIGINT) in both engines.
const SCHEMA = (pg) => {
  const id = pg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  return `
CREATE TABLE IF NOT EXISTS users (
  id ${id},
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('customer','agent','admin')),
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS restaurants (
  id ${id},
  name TEXT NOT NULL,
  cuisine TEXT NOT NULL,
  rating REAL NOT NULL DEFAULT 4.0,
  eta_mins INTEGER NOT NULL DEFAULT 30,
  emoji TEXT NOT NULL DEFAULT '🍽️',
  address TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS menu_items (
  id ${id},
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL,
  veg INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  agent_id INTEGER REFERENCES users(id),
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  status TEXT NOT NULL CHECK (status IN ('placed','accepted','picked_up','out_for_delivery','delivered','cancelled')),
  total INTEGER NOT NULL,
  address TEXT NOT NULL,
  delivery_lat REAL,
  delivery_lng REAL,
  created_at BIGINT NOT NULL,
  accepted_at BIGINT,
  delivered_at BIGINT,
  cancelled_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_agent ON orders(agent_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE TABLE IF NOT EXISTS order_items (
  id ${id},
  order_id TEXT NOT NULL REFERENCES orders(id),
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS call_logs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  caller_id INTEGER NOT NULL REFERENCES users(id),
  callee_id INTEGER NOT NULL REFERENCES users(id),
  caller_role TEXT NOT NULL,
  status TEXT NOT NULL,
  end_reason TEXT,
  created_at BIGINT NOT NULL,
  answered_at BIGINT,
  connected_at BIGINT,
  ended_at BIGINT,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  connection_type TEXT,
  avg_rtt_ms REAL,
  jitter_ms REAL,
  packet_loss_pct REAL,
  bitrate_kbps REAL
);
CREATE INDEX IF NOT EXISTS idx_calls_order ON call_logs(order_id);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id ${id},
  user_id INTEGER NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
`;
};

// Columns added after the first release. Added on startup if missing, so
// existing databases keep working without being deleted.
const ADDED_COLUMNS = [
  // 'internet' = WebRTC call · 'masked' = user chose the normal (masked) call option because internet was off
  ['call_logs', 'channel', "TEXT NOT NULL DEFAULT 'internet'"],
];

// Hide Node's one-line "SQLite is an experimental feature" notice; keep all other warnings.
function silenceSqliteWarning() {
  const orig = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...rest) {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    if (msg && msg.includes('SQLite is an experimental feature')) return;
    return orig.call(process, warning, ...rest);
  };
}

// Uses Node's BUILT-IN SQLite (node:sqlite, Node 22.13+), so there is nothing
// to compile: no Visual Studio / Python / node-gyp needed on Windows.
function sqliteAdapter(file) {
  silenceSqliteWarning();
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch {
    throw new Error(`OrderVoice needs Node.js 22.13 or newer (built-in SQLite). You have ${process.version}.`);
  }
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const plain = (row) => (row ? { ...row } : row); // rows come back with a null prototype
  const clean = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
  return {
    engine: 'sqlite',
    async migrate() {
      db.exec(SCHEMA(false));
      for (const [table, col, def] of ADDED_COLUMNS) {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      }
    },
    async all(sql, params = []) { return db.prepare(sql).all(...clean(params)).map(plain); },
    async get(sql, params = []) { return plain(db.prepare(sql).get(...clean(params))); },
    async run(sql, params = []) {
      const r = db.prepare(sql).run(...clean(params));
      return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
    },
    async transaction(fn) {
      db.exec('BEGIN');
      try { const out = await fn(this); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    async close() { db.close(); },
  };
}

function pgAdapter(url) {
  const { Pool, types } = require('pg'); // npm i pg (only needed for PostgreSQL)
  types.setTypeParser(20, (v) => Number(v)); // BIGINT -> number
  const pool = new Pool({ connectionString: url });
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const make = (q) => ({
    engine: 'pg',
    async all(sql, params = []) { return (await q.query(toPg(sql), params)).rows; },
    async get(sql, params = []) { return (await q.query(toPg(sql), params)).rows[0]; },
    async run(sql, params = []) {
      let s = toPg(sql);
      const isInsert = /^\s*insert/i.test(s) && !/returning/i.test(s);
      if (isInsert) s += ' RETURNING *';
      const r = await q.query(s, params);
      return { changes: r.rowCount, lastId: isInsert && r.rows[0] ? r.rows[0].id : undefined };
    },
  });
  const api = make(pool);
  api.migrate = async () => {
    await pool.query(SCHEMA(true));
    for (const [table, col, def] of ADDED_COLUMNS) await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def}`);
  };
  api.transaction = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(make(client));
      await client.query('COMMIT');
      return out;
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  };
  api.close = () => pool.end();
  return api;
}

function createDb(opts = {}) {
  const url = opts.databaseUrl ?? config.databaseUrl;
  if (url) return pgAdapter(url);
  return sqliteAdapter(opts.sqlitePath ?? config.sqlitePath);
}

module.exports = { createDb };