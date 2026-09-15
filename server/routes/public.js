/* ==========================================================================
   Public API: catalogue, quotes and the monitor feed. No authentication.
   ========================================================================== */

import { Router } from 'express';
import * as db from '../db.js';
import * as M from '../lib/money.js';
import * as O from '../lib/orders.js';
import * as xml from '../lib/xml.js';
import * as rates from '../services/rates.js';
import * as captcha from '../lib/captcha.js';
import { wrap, str, decimal, oneOf } from '../lib/http.js';
import { limiter } from '../lib/auth.js';
import { config } from '../config.js';

const r = Router();

/** Catalogue shape the front-end consumes, mirroring its bundled dataset. */
async function currencyView(c) {
  return {
    id: c.id,
    name: c.name,
    net: c.net,
    code: c.code,
    group: c.grp,
    color: c.color,
    rate: c.pivot_usd,
    reserve: M.str(M.sub(c.reserve, c.reserved)),
    min: M.str(c.min_amt),
    max: M.str(c.max_amt),
    feeBp: c.fee_bp,
    field: c.field_label,
    manual: !!c.manual,
    stale: await O.pivotStale(c)
  };
}

r.get('/v1/currencies', wrap(async (_req, res) => {
  const rows = await db.all('SELECT * FROM currencies WHERE enabled = 1 ORDER BY sort_order');
  res.json({
    groups: { crypto: 'Cryptocurrencies', account: 'Electronic accounts', mobile: 'Mobile money & local banking' },
    currencies: await Promise.all(rows.map(currencyView))
  });
}));

r.get('/v1/directions', wrap(async (_req, res) => {
  res.json({
    rules: await db.all('SELECT from_grp AS "from", to_grp AS "to", enabled FROM direction_rules WHERE enabled = 1'),
    overrides: await db.all('SELECT from_id, to_id, enabled, fee_bp FROM pair_overrides')
  });
}));

/** Everything the front-end needs to boot, in one request. */
r.get('/v1/bootstrap', wrap(async (_req, res) => {
  const rows = await db.all('SELECT * FROM currencies WHERE enabled = 1 ORDER BY sort_order');
  res.json({
    site: {
      lockMinutes: config.order.lockMinutes,
      maintenance: await db.setting('maintenance', '0') === '1'
    },
    groups: { crypto: 'Cryptocurrencies', account: 'Electronic accounts', mobile: 'Mobile money & local banking' },
    currencies: await Promise.all(rows.map(currencyView)),
    directions: await db.all('SELECT from_grp AS "from", to_grp AS "to" FROM direction_rules WHERE enabled = 1'),
    reviews: await db.all('SELECT who, body AS text, created_at FROM reviews WHERE approved = 1 ORDER BY created_at DESC LIMIT 24'),
    news: await db.all('SELECT slug, title, excerpt, published_at FROM news WHERE published = 1 ORDER BY published_at DESC LIMIT 12')
  });
}));

/**
 * Price a direction. Read-only - no order is created and no reserve held,
 * so this is safe to call on every keystroke.
 */
r.post('/v1/quote',
  limiter({ name: 'quote', limit: 240, windowSec: 60 }),
  wrap(async (req, res) => {
    const fromId = str(req.body, 'from', { max: 40, label: 'Send currency' });
    const toId = str(req.body, 'to', { max: 40, label: 'Receive currency' });
    const amount = decimal(req.body, 'amount', { label: 'Amount' });
    const side = oneOf(req.body, 'side', ['send', 'receive'], { required: false }) || 'send';

    const from = await O.currency(fromId);
    const to = await O.currency(toId);
    if (!from || !to) return res.status(400).json({ error: 'Unknown currency' });

    const q = await O.quote({ from, to, amount, side, user: req.user });
    res.json({
      ...q,
      ok: q.errors.length === 0,
      error: q.errors[0] ?? null,
      lockMinutes: config.order.lockMinutes,
      receiveField: to.field_label
    });
  }));

/* --------------------------------------------------------------- captcha */
r.get('/v1/captcha',
  limiter({ name: 'captcha', limit: 60, windowSec: 300 }),
  wrap(async (_req, res) => {
    const c = await captcha.issue();
    res.set('cache-control', 'no-store').json(c);
  }));

/* ------------------------------------------------------------- monitor feed */
r.get('/v1/rates.xml', wrap(async (_req, res) => {
  res.type('application/xml; charset=utf-8')
    .set('cache-control', 'public, max-age=60')
    .send(await xml.buildFeed());
}));

r.get('/v1/rates.json', wrap(async (_req, res) => {
  res.set('cache-control', 'public, max-age=60').json(await xml.buildJson());
}));

/* -------------------------------------------------------------- editorial */
r.get('/v1/news', wrap(async (_req, res) => {
  res.json(await db.all(
    'SELECT slug, title, excerpt, body, published_at FROM news WHERE published = 1 ORDER BY published_at DESC'
  ));
}));

r.get('/v1/reviews', wrap(async (_req, res) => {
  res.json(await db.all(
    'SELECT who, body AS text, rating, created_at FROM reviews WHERE approved = 1 ORDER BY created_at DESC'
  ));
}));

/** Customer-submitted review. Held unapproved until an operator moderates it. */
r.post('/v1/reviews',
  limiter({ name: 'review', limit: 3, windowSec: 3600 }),
  wrap(async (req, res) => {
    await captcha.requireCaptcha(req);
    const who = str(req.body, 'who', { max: 60, label: 'Name' });
    const body = str(req.body, 'text', { min: 10, max: 1200, label: 'Review' });
    const orderId = str(req.body, 'orderId', { required: false, max: 40 });

    // only attach an order that exists, so a made-up id cannot fake a verified badge
    const order = orderId ? await db.get('SELECT id FROM orders WHERE id = ?', orderId) : null;

    await db.run(
      `INSERT INTO reviews (user_id, who, body, order_id, rating, approved, created_at)
       VALUES (?, ?, ?, ?, 5, 0, ?)`,
      req.user?.id ?? null, who, body, order?.id ?? null, db.now()
    );
    res.status(201).json({ ok: true, message: 'Thank you - your review is awaiting moderation.' });
  }));

/* ------------------------------------------------------------------ health */
r.get('/health', wrap(async (_req, res) => {
  const st = await rates.status();
  res.json({
    ok: true,
    now: db.now(),
    database: db.engine,
    currencies: await db.val('SELECT COUNT(*) FROM currencies WHERE enabled = 1'),
    openOrders: await db.val("SELECT COUNT(*) FROM orders WHERE status NOT IN ('completed','cancelled','refunded')"),
    rates: { lastRun: st.lastRun, lastError: st.lastError, stale: st.stale.length }
  });
}));

export default r;
