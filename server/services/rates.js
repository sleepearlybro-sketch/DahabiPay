/* ==========================================================================
   Live pivot feed.

   Every currency carries a USD pivot. Crypto pivots come from CoinGecko,
   fiat from open.er-api.com - both keyless, so live rates work before any
   credential exists. Values land in rate_cache with a fetched_at, and
   lib/orders.js refuses to quote a direction whose pivot has gone stale.

   A failed fetch never zeroes a pivot: the last good value stays and the
   dashboard raises a stale-feed alert instead.
   ========================================================================== */

import * as db from '../db.js';
import * as M from '../lib/money.js';
import { config } from '../config.js';
import { auditSystem } from '../lib/http.js';

const TIMEOUT_MS = 12_000;

let lastRun = null;
let lastError = null;

async function fetchJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json', 'user-agent': 'DahabiPay/1.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function writePivot(symbol, usd, source) {
  // guard against a provider returning 0, null or nonsense - a zero pivot
  // would divide by zero in the cross rate
  let v;
  try { v = M.dec(usd); } catch { return false; }
  if (!M.isPos(v)) return false;

  await db.run(
    `INSERT INTO rate_cache (symbol, usd, source, fetched_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET usd = excluded.usd,
                                       source = excluded.source,
                                       fetched_at = excluded.fetched_at`,
    symbol, M.str(v), source, db.now()
  );
  return true;
}

/** Push cached pivots onto the currencies that follow the feed. */
async function applyToCurrencies() {
  const rows = await db.all(
    `SELECT id, feed_symbol FROM currencies
      WHERE pivot_source = 'feed' AND feed_symbol IS NOT NULL`
  );
  let n = 0;
  for (const c of rows) {
    const cached = await db.get('SELECT usd FROM rate_cache WHERE symbol = ?', c.feed_symbol);
    if (!cached) continue;
    await db.run('UPDATE currencies SET pivot_usd = ?, updated_at = ? WHERE id = ?',
      cached.usd, db.now(), c.id);
    n++;
  }
  return n;
}

/* ------------------------------------------------------------------ crypto */
async function refreshCrypto() {
  const data = await fetchJson(config.rates.cryptoUrl);
  let ok = 0, bad = [];
  for (const [id, v] of Object.entries(data || {})) {
    if (await writePivot(id, v?.usd, 'coingecko')) ok++;
    else bad.push(id);
  }
  if (!ok) throw new Error('crypto feed returned no usable pivots');
  return { ok, bad };
}

/* -------------------------------------------------------------------- fiat
   The provider quotes USD -> local, so the pivot is the reciprocal.        */
async function refreshFiat() {
  const wanted = (await db.all(
    `SELECT DISTINCT feed_symbol FROM currencies
      WHERE pivot_source = 'feed' AND feed_symbol IS NOT NULL
        AND LENGTH(feed_symbol) = 3 AND feed_symbol = UPPER(feed_symbol)`
  )).map((r) => r.feed_symbol);
  if (!wanted.length) return { ok: 0, bad: [] };

  const data = await fetchJson(config.rates.fiatUrl);
  const rates = data?.rates || data?.conversion_rates;
  if (!rates) throw new Error('fiat feed returned no rates object');

  let ok = 0, bad = [];
  for (const code of wanted) {
    const perUsd = rates[code];
    if (!perUsd || !(Number(perUsd) > 0)) { bad.push(code); continue; }
    // one unit of `code` in USD
    const usd = M.div('1', String(perUsd));
    if (await writePivot(code, M.str(usd), 'er-api')) ok++;
    else bad.push(code);
  }
  return { ok, bad };
}

/* ---------------------------------------------------------------- refresh */
/**
 * Refresh both feeds. Each is independent: a crypto outage must not stop
 * fiat pivots updating, so failures are collected rather than thrown.
 */
export async function refresh() {
  const started = Date.now();
  const result = { crypto: null, fiat: null, applied: 0, errors: [] };

  try { result.crypto = await refreshCrypto(); }
  catch (err) { result.errors.push(`crypto: ${err.message}`); }

  try { result.fiat = await refreshFiat(); }
  catch (err) { result.errors.push(`fiat: ${err.message}`); }

  result.applied = await applyToCurrencies();
  result.ms = Date.now() - started;

  lastRun = db.now();
  lastError = result.errors.length ? result.errors.join('; ') : null;
  await db.setSetting('rates_last_run', lastRun);
  await db.setSetting('rates_last_error', lastError ?? '');

  if (result.errors.length) {
    await auditSystem('rates.refresh_failed', { detail: { errors: result.errors } });
  }
  return result;
}

/* ------------------------------------------------------------- staleness */
/**
 * Which feed-backed currencies have a pivot older than the cutoff, or none
 * at all. Drives the admin dashboard alert and the quote refusal.
 */
export async function staleCurrencies() {
  const cutoff = new Date(Date.now() - config.rates.maxStaleSec * 1000).toISOString();
  return db.all(
    `SELECT c.id, c.name, c.net, c.code, c.feed_symbol, r.fetched_at
       FROM currencies c
       LEFT JOIN rate_cache r ON r.symbol = c.feed_symbol
      WHERE c.enabled = 1 AND c.pivot_source = 'feed'
        AND (r.fetched_at IS NULL OR r.fetched_at <= ?)
      ORDER BY c.sort_order`,
    cutoff
  );
}

export async function status() {
  return {
    lastRun: lastRun ?? await db.setting('rates_last_run'),
    lastError: lastError ?? (await db.setting('rates_last_error') || null),
    refreshSec: config.rates.refreshSec,
    maxStaleSec: config.rates.maxStaleSec,
    cached: await db.all('SELECT symbol, usd, source, fetched_at FROM rate_cache ORDER BY symbol'),
    stale: await staleCurrencies()
  };
}

/* ---------------------------------------------------------------- poller */
let timer = null;

export function startPoller() {
  if (!config.rates.refreshSec) {
    console.log('  rates poller: disabled (RATES_REFRESH_SEC=0)');
    return;
  }
  const tick = () => {
    refresh()
      .then((r) => {
        if (r.errors.length) console.warn('  rates: %s', r.errors.join('; '));
        else console.log('  rates: %d pivots applied in %dms', r.applied, r.ms);
      })
      .catch((err) => console.error('  rates poller crashed:', err.message));
  };
  tick();                                             // once at boot
  timer = setInterval(tick, config.rates.refreshSec * 1000);
  timer.unref?.();
}

export function stopPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}
