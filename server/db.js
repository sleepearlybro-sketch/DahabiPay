/* ==========================================================================
   Database layer.

   DATABASE_URL selects PostgreSQL (Railway production). Without it the app
   uses SQLite (local development and tests). Every operation is asynchronous
   so callers behave identically with either engine.
   ========================================================================== */

import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config } from './config.js';

const postgres = Boolean(config.db.url);
const context = new AsyncLocalStorage();
let sqlite = null;
let pool = null;
let sqliteTail = Promise.resolve();

if (postgres) {
  // IDs, counters, flags and basis points use BIGINT in PostgreSQL. This app
  // never approaches JavaScript's safe-integer limit, so keep SQLite's number
  // behaviour instead of exposing string values such as "0" (which is truthy).
  pg.types.setTypeParser(20, (value) => Number(value));
  pool = new pg.Pool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: config.db.ssl ? { rejectUnauthorized: config.db.sslRejectUnauthorized } : false
  });
  pool.on('error', (err) => console.error('idle PostgreSQL client error:', err));
} else {
  fs.mkdirSync(path.dirname(config.db.file), { recursive: true });
  sqlite = new DatabaseSync(config.db.file);
}

export const engine = postgres ? 'postgresql' : 'sqlite';
export const forUpdate = postgres ? ' FOR UPDATE' : '';

function pgSql(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function sqliteQueue(fn) {
  if (context.getStore()?.engine === 'sqlite') return Promise.resolve().then(fn);
  const next = sqliteTail.then(fn, fn);
  sqliteTail = next.catch(() => {});
  return next;
}

function pgRunner() {
  return context.getStore()?.client || pool;
}

export async function exec(sql) {
  if (postgres) {
    await pgRunner().query(sql);
    return;
  }
  await sqliteQueue(() => sqlite.exec(sql));
}

export async function run(sql, ...params) {
  if (postgres) {
    const result = await pgRunner().query(pgSql(sql), params);
    return {
      changes: result.rowCount,
      lastInsertRowid: result.rows[0]?.id ?? null,
      rows: result.rows
    };
  }
  return sqliteQueue(() => sqlite.prepare(sql).run(...params));
}

export async function get(sql, ...params) {
  if (postgres) {
    const result = await pgRunner().query(pgSql(sql), params);
    return result.rows[0];
  }
  return sqliteQueue(() => sqlite.prepare(sql).get(...params));
}

export async function all(sql, ...params) {
  if (postgres) {
    const result = await pgRunner().query(pgSql(sql), params);
    return result.rows;
  }
  return sqliteQueue(() => sqlite.prepare(sql).all(...params));
}

export async function val(sql, ...params) {
  const row = await get(sql, ...params);
  return row ? Object.values(row)[0] : undefined;
}

export async function tx(fn) {
  if (context.getStore()) return fn();

  if (postgres) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await context.run({ engine: 'postgresql', client }, fn);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
      throw err;
    } finally {
      client.release();
    }
  }

  return sqliteQueue(async () => {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const out = await context.run({ engine: 'sqlite' }, fn);
      sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      try { sqlite.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw err;
    }
  });
}

export async function migrate() {
  let sql = fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8');
  if (postgres) {
    sql = sql
      .replace(/^PRAGMA .*;\s*$/gm, '')
      .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, 'BIGSERIAL PRIMARY KEY')
      .replace(/\bINTEGER\b/g, 'BIGINT');
  }
  await exec(sql);
  if (!postgres) await additiveColumns();
}

const LATER_COLUMNS = [
  ['currencies', 'reserved', "TEXT NOT NULL DEFAULT '0'"],
  ['currencies', 'deposit_addr', 'TEXT'],
  ['currencies', 'deposit_memo', 'TEXT'],
  ['orders', 'rate_reaccepted_at', 'TEXT'],
  ['orders', 'access_token', 'TEXT'],
  ['orders', 'reserve_held', 'INTEGER NOT NULL DEFAULT 0']
];

async function additiveColumns() {
  for (const [table, column, decl] of LATER_COLUMNS) {
    const cols = await all(`PRAGMA table_info(${table})`);
    if (!cols.length || cols.some((c) => c.name === column)) continue;
    await exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

export async function close() {
  if (postgres) await pool.end();
  else {
    await sqliteTail;
    try { sqlite.close(); } catch { /* already closed */ }
  }
}

export const now = () => new Date().toISOString();
export const inMinutes = (mins) => new Date(Date.now() + mins * 60_000).toISOString();
export const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

export async function setting(key, fallback = null) {
  const v = await val('SELECT value FROM settings WHERE key = ?', key);
  return v === undefined ? fallback : v;
}

export async function setSetting(key, value) {
  await run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key, String(value)
  );
}
