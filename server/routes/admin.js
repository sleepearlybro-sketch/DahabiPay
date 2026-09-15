/* ==========================================================================
   Operator / administrator API.

   Everything here sits behind requireRole('operator'); the few genuinely
   dangerous levers (roles, settings, reserve edits) require 'admin'. Every
   mutation writes audit_log with the actor, their IP and the before/after
   values, because "who moved this money" has to be answerable later.
   ========================================================================== */

import { Router } from 'express';
import * as db from '../db.js';
import * as M from '../lib/money.js';
import * as O from '../lib/orders.js';
import * as rates from '../services/rates.js';
import * as payments from '../services/payments/index.js';
import { settleOrder, complete } from '../lib/settle.js';
import {
  wrap, str, decimal, int, bool, oneOf, paging, audit, HttpError
} from '../lib/http.js';
import { requireRole } from '../lib/auth.js';
import { config } from '../config.js';

const r = Router();

r.use(requireRole('operator'));
const adminOnly = requireRole('admin');

/** Destructive actions must carry a reason; it lands in the audit trail. */
function reasonOf(req, { required = true } = {}) {
  return str(req.body, 'reason', { required, max: 400, label: 'Reason' });
}

/* ------------------------------------------------------------- dashboard */
r.get('/dashboard', wrap(async (_req, res) => {
  const byStatus = await db.all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
  const since24 = new Date(Date.now() - 86_400_000).toISOString();

  // volume in USD via the sending currency's pivot
  const vol = (await db.all(
    `SELECT o.send_amount, c.pivot_usd FROM orders o
       JOIN currencies c ON c.id = o.from_id
      WHERE o.status = 'completed' AND o.completed_at >= ?`,
    since24
  )).reduce((acc, row) => M.add(acc, M.mul(row.send_amount, row.pivot_usd)), 0n);

  const reserveRows = await db.all(
    `SELECT id, name, net, code, reserve, reserved FROM currencies WHERE enabled = 1`
  );
  const lowReserve = (await Promise.all(reserveRows.map(async (c) => {
    const avail = M.sub(c.reserve, c.reserved);
    const usd = M.mul(avail, await db.val('SELECT pivot_usd FROM currencies WHERE id = ?', c.id));
    return M.lt(usd, '2000') ? {
      id: c.id, label: O.label(c), available: M.str(avail), code: c.code
    } : null;
  }))).filter(Boolean);

  const st = await rates.status();

  res.json({
    orders: byStatus.reduce((o, x) => ({ ...o, [x.status]: x.n }), {}),
    needsAttention: await db.val(
      `SELECT COUNT(*) FROM orders WHERE status IN ('payment_detected','processing','on_hold')`
    ),
    volume24hUsd: M.str(vol, 2),
    completed24h: await db.val("SELECT COUNT(*) FROM orders WHERE status='completed' AND completed_at >= ?", since24),
    users: await db.val('SELECT COUNT(*) FROM users'),
    pendingKyc: await db.val("SELECT COUNT(*) FROM kyc_docs WHERE status='pending'"),
    pendingWithdrawals: await db.val("SELECT COUNT(*) FROM withdrawals WHERE status='pending'"),
    pendingReviews: await db.val('SELECT COUNT(*) FROM reviews WHERE approved = 0'),
    lowReserve,
    rates: { lastRun: st.lastRun, lastError: st.lastError, stale: st.stale },
    payments: payments.health(),
    maintenance: await db.setting('maintenance', '0') === '1',
    warnings: (await import('../config.js')).configWarnings()
  });
}));

/* ---------------------------------------------------------------- orders */
r.get('/orders', wrap(async (req, res) => {
  const { limit, offset, page } = paging(req.query);
  const where = [];
  const args = [];

  if (req.query.status) { where.push('o.status = ?'); args.push(String(req.query.status)); }
  if (req.query.from) { where.push('o.from_id = ?'); args.push(String(req.query.from)); }
  if (req.query.to) { where.push('o.to_id = ?'); args.push(String(req.query.to)); }
  if (req.query.q) {
    where.push('(o.id LIKE ? OR o.email LIKE ? OR o.requisite LIKE ? OR o.tx_hash LIKE ?)');
    const like = `%${String(req.query.q)}%`;
    args.push(like, like, like, like);
  }
  if (req.query.attention === '1') {
    where.push("o.status IN ('payment_detected','processing','on_hold')");
  }
  const sql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = await db.all(
    `SELECT o.*, u.login AS user_login FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       ${sql} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
    ...args, limit, offset
  );
  const total = await db.val(`SELECT COUNT(*) FROM orders o ${sql}`, ...args);
  const orders = await Promise.all(rows.map(async (o) => {
    const from = await O.currency(o.from_id);
    const to = await O.currency(o.to_id);
    return {
      id: o.id, status: o.status, statusLabel: O.LABELS[o.status] || o.status,
      from: from && O.label(from), to: to && O.label(to),
      fromCode: from?.code, toCode: to?.code,
      send: o.send_amount, recv: o.recv_amount, rate: o.rate, feeBp: o.fee_bp,
      email: o.email, user: o.user_login, requisite: o.requisite,
      provider: o.provider, txHash: o.tx_hash, paidAmount: o.paid_amount,
      holdReason: o.hold_reason, cancelReason: o.cancel_reason,
      lockExpiresAt: o.lock_expires_at, createdAt: o.created_at,
      completedAt: o.completed_at
    };
  }));

  res.json({
    page, limit, total,
    orders
  });
}));

r.get('/orders/:id', wrap(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!o) throw new HttpError(404, 'Order not found');
  const from = await O.currency(o.from_id);
  const to = await O.currency(o.to_id);

  res.json({
    order: {
      ...o,
      fromLabel: from && O.label(from),
      toLabel: to && O.label(to),
      statusLabel: O.LABELS[o.status] || o.status,
      allowedTransitions: (O.canTransition, Object.keys(O.STATES)
        .map((k) => O.STATES[k])
        .filter((s) => O.canTransition(o.status, s)))
    },
    events: await O.events(o.id),
    webhooks: await db.all(
      'SELECT provider, provider_ref, event, accepted, reason, received_at FROM webhook_events WHERE order_id = ? ORDER BY id DESC',
      o.id
    ),
    payoutClaimed: await O.payoutClaimed(o.id)
  });
}));

/**
 * One endpoint for every operator action on an order, so the allowed-action
 * logic and the audit trail live in one place.
 */
r.post('/orders/:id/action', wrap(async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
  if (!order) throw new HttpError(404, 'Order not found');

  const action = oneOf(req.body, 'action', [
    'mark_paid', 'settle', 'complete', 'hold', 'resume', 'cancel', 'refund', 'requote'
  ], { label: 'Action' });

  const actor = `operator:${req.user.login}`;
  let out;

  switch (action) {
    case 'mark_paid': {
      const txHash = str(req.body, 'txHash', { required: false, max: 200 });
      const paid = decimal(req.body, 'paidAmount', { required: false });
      out = await O.transition(order.id, O.STATES.DETECTED, actor, {
        detail: `payment confirmed by operator${txHash ? ` (${txHash})` : ''}`,
        patch: {
          operator_id: req.user.id,
          ...(txHash ? { tx_hash: txHash } : {}),
          ...(paid ? { paid_amount: paid } : {})
        }
      });
      break;
    }

    case 'settle': {
      // runs the same path a verified webhook takes, including the payout claim
      const result = await settleOrder(order, actor, { force: order.status === O.STATES.ON_HOLD });
      await audit(req, 'order.settle', { entity: 'order', entityId: order.id, detail: result });
      return res.json({ ok: true, result, order: await db.get('SELECT * FROM orders WHERE id = ?', order.id) });
    }

    case 'complete': {
      // for manual rails: the operator has sent the funds by hand
      const ref = str(req.body, 'payoutRef', { required: false, max: 200 });
      if (!await O.payoutClaimed(order.id)) await O.claimPayout(order.id, order.provider, ref);
      const result = await complete(order.id, actor, { ref });
      await audit(req, 'order.complete_manual', { entity: 'order', entityId: order.id, detail: { ref } });
      return res.json({ ok: true, result });
    }

    case 'hold': {
      const reason = reasonOf(req);
      out = await O.transition(order.id, O.STATES.ON_HOLD, actor, {
        detail: reason, patch: { hold_reason: reason, operator_id: req.user.id }
      });
      break;
    }

    case 'resume': {
      const to = order.paid_at ? O.STATES.DETECTED : O.STATES.AWAITING;
      out = await O.transition(order.id, to, actor, {
        detail: str(req.body, 'reason', { required: false, max: 400 }) || 'hold lifted',
        patch: { hold_reason: null }
      });
      break;
    }

    case 'cancel': {
      const reason = reasonOf(req);
      out = await O.transition(order.id, O.STATES.CANCELLED, actor, {
        detail: reason, patch: { cancel_reason: reason, operator_id: req.user.id }
      });
      break;
    }

    case 'refund': {
      const reason = reasonOf(req);
      out = await O.transition(order.id, O.STATES.REFUNDED, actor, {
        detail: reason, patch: { cancel_reason: reason, operator_id: req.user.id }
      });
      break;
    }

    case 'requote': {
      out = await O.requote(order.id, actor);
      break;
    }
  }

  await audit(req, `order.${action}`, {
    entity: 'order', entityId: order.id,
    detail: { before: order.status, after: out.status, reason: req.body?.reason ?? null }
  });
  res.json({ ok: true, order: out });
}));

/* ------------------------------------------------------------ currencies */
r.get('/currencies', wrap(async (_req, res) => {
  const rows = await db.all('SELECT * FROM currencies ORDER BY sort_order');
  res.json(await Promise.all(rows.map(async (c) => ({
    ...c,
    label: O.label(c),
    available: M.str(M.sub(c.reserve, c.reserved)),
    availableUsd: M.str(M.mul(M.sub(c.reserve, c.reserved), c.pivot_usd), 2),
    stale: await O.pivotStale(c)
  }))));
}));

r.patch('/currencies/:id', wrap(async (req, res) => {
  const cur = await O.currency(req.params.id);
  if (!cur) throw new HttpError(404, 'Currency not found');

  const before = {
    fee_bp: cur.fee_bp, min_amt: cur.min_amt, max_amt: cur.max_amt,
    enabled: cur.enabled, manual: cur.manual,
    pivot_source: cur.pivot_source, pivot_usd: cur.pivot_usd
  };

  const sets = [];
  const args = [];
  const put = (col, v) => { sets.push(`${col} = ?`); args.push(v); };

  if ('feeBp' in req.body) put('fee_bp', int(req.body, 'feeBp', { min: 0, max: 5000, label: 'Fee' }));
  if ('min' in req.body) put('min_amt', decimal(req.body, 'min', { label: 'Minimum' }));
  if ('max' in req.body) put('max_amt', decimal(req.body, 'max', { label: 'Maximum' }));
  if ('enabled' in req.body) put('enabled', bool(req.body, 'enabled') ? 1 : 0);
  if ('manual' in req.body) put('manual', bool(req.body, 'manual') ? 1 : 0);
  if ('depositAddr' in req.body) put('deposit_addr', str(req.body, 'depositAddr', { required: false, max: 200 }) || null);
  if ('depositMemo' in req.body) put('deposit_memo', str(req.body, 'depositMemo', { required: false, max: 120 }) || null);
  if ('fieldLabel' in req.body) put('field_label', str(req.body, 'fieldLabel', { max: 120, label: 'Requisite label' }));
  if ('pivotSource' in req.body) {
    put('pivot_source', oneOf(req.body, 'pivotSource', ['feed', 'manual'], { label: 'Pivot source' }));
  }
  if ('pivotUsd' in req.body) {
    const v = decimal(req.body, 'pivotUsd', { label: 'Pivot' });
    if (!M.isPos(v)) throw new HttpError(400, 'Pivot must be greater than zero', 'pivotUsd');
    put('pivot_usd', v);
  }

  if (!sets.length) throw new HttpError(400, 'Nothing to update');

  // Guard: a manual pivot with no value, or a feed pivot with no symbol,
  // would silently break every direction using this currency.
  const nextSource = req.body.pivotSource ?? cur.pivot_source;
  if (nextSource === 'feed' && !cur.feed_symbol) {
    throw new HttpError(400, 'This currency has no feed symbol, so it cannot follow the feed');
  }

  put('updated_at', db.now());
  args.push(cur.id);
  await db.run(`UPDATE currencies SET ${sets.join(', ')} WHERE id = ?`, ...args);

  const after = await O.currency(cur.id);
  await audit(req, 'currency.update', { entity: 'currency', entityId: cur.id, detail: { before, after: {
    fee_bp: after.fee_bp, min_amt: after.min_amt, max_amt: after.max_amt,
    enabled: after.enabled, manual: after.manual,
    pivot_source: after.pivot_source, pivot_usd: after.pivot_usd
  } } });

  res.json({ ok: true, currency: after });
}));

/**
 * Reserve adjustment. Admin-only, reason mandatory, and written to the
 * ledger so a reserve can be reconciled against its history.
 */
r.post('/currencies/:id/reserve', adminOnly, wrap(async (req, res) => {
  const cur = await O.currency(req.params.id);
  if (!cur) throw new HttpError(404, 'Currency not found');

  const mode = oneOf(req.body, 'mode', ['set', 'delta'], { label: 'Mode' });
  const amount = decimal(req.body, 'amount', { label: 'Amount' });
  const reason = reasonOf(req);

  const next = mode === 'set' ? M.dec(amount) : M.add(cur.reserve, amount);
  if (M.lt(next, 0)) throw new HttpError(400, 'Reserve cannot go negative');
  if (M.lt(next, cur.reserved)) {
    throw new HttpError(409,
      `${M.str(cur.reserved)} ${cur.code} is committed to open orders - reserve cannot go below that`);
  }

  await db.tx(async () => {
    await db.run('UPDATE currencies SET reserve = ?, updated_at = ? WHERE id = ?',
      M.str(next), db.now(), cur.id);
    await db.run(
      `INSERT INTO ledger (user_id, currency_id, delta, reason, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      req.user.id, cur.id, M.str(M.sub(next, cur.reserve)),
      `reserve ${mode}: ${reason}`, `operator:${req.user.login}`, db.now()
    );
  });

  await audit(req, 'currency.reserve', {
    entity: 'currency', entityId: cur.id,
    detail: { before: cur.reserve, after: M.str(next), mode, reason }
  });
  res.json({ ok: true, reserve: M.str(next) });
}));

/* ------------------------------------------------------------ directions */
r.get('/directions', wrap(async (_req, res) => {
  res.json({
    rules: await db.all('SELECT from_grp, to_grp, enabled FROM direction_rules ORDER BY from_grp, to_grp'),
    overrides: await db.all('SELECT * FROM pair_overrides ORDER BY from_id, to_id')
  });
}));

r.put('/directions', wrap(async (req, res) => {
  const fromGrp = oneOf(req.body, 'from', ['crypto', 'account', 'mobile'], { label: 'From group' });
  const toGrp = oneOf(req.body, 'to', ['crypto', 'account', 'mobile'], { label: 'To group' });
  const enabled = bool(req.body, 'enabled') ? 1 : 0;

  await db.run(
    `INSERT INTO direction_rules (from_grp, to_grp, enabled) VALUES (?, ?, ?)
     ON CONFLICT(from_grp, to_grp) DO UPDATE SET enabled = excluded.enabled`,
    fromGrp, toGrp, enabled
  );
  await audit(req, 'direction.update', { entity: 'direction', entityId: `${fromGrp}>${toGrp}`, detail: { enabled } });
  res.json({ ok: true });
}));

r.put('/pairs', wrap(async (req, res) => {
  const fromId = str(req.body, 'from', { max: 40 });
  const toId = str(req.body, 'to', { max: 40 });
  if (!await O.currency(fromId) || !await O.currency(toId)) throw new HttpError(400, 'Unknown currency');

  const enabled = req.body.enabled === null || req.body.enabled === undefined
    ? null : (bool(req.body, 'enabled') ? 1 : 0);
  const feeBp = req.body.feeBp === null || req.body.feeBp === undefined || req.body.feeBp === ''
    ? null : int(req.body, 'feeBp', { min: 0, max: 5000, label: 'Fee' });

  if (enabled === null && feeBp === null) {
    await db.run('DELETE FROM pair_overrides WHERE from_id = ? AND to_id = ?', fromId, toId);
  } else {
    await db.run(
      `INSERT INTO pair_overrides (from_id, to_id, enabled, fee_bp) VALUES (?, ?, ?, ?)
       ON CONFLICT(from_id, to_id) DO UPDATE SET enabled = excluded.enabled, fee_bp = excluded.fee_bp`,
      fromId, toId, enabled, feeBp
    );
  }
  await audit(req, 'pair.override', { entity: 'pair', entityId: `${fromId}>${toId}`, detail: { enabled, feeBp } });
  res.json({ ok: true });
}));

/* ----------------------------------------------------------------- users */
r.get('/users', wrap(async (req, res) => {
  const { limit, offset, page } = paging(req.query);
  const q = req.query.q ? `%${String(req.query.q)}%` : null;
  const where = q ? 'WHERE login LIKE ? OR email LIKE ?' : '';
  const args = q ? [q, q] : [];

  res.json({
    page, limit,
    total: await db.val(`SELECT COUNT(*) FROM users ${where}`, ...args),
    users: await db.all(
      `SELECT id, login, email, role, email_verified, blocked, block_reason, kyc_status,
              discount_bp, ref_code, created_at, last_seen_at
         FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...args, limit, offset
    )
  });
}));

r.get('/users/:id', wrap(async (req, res) => {
  const u = await db.get(
    `SELECT id, login, email, role, email_verified, blocked, block_reason, kyc_status,
            discount_bp, ref_code, referrer_id, created_at, last_seen_at
       FROM users WHERE id = ?`, req.params.id
  );
  if (!u) throw new HttpError(404, 'User not found');

  res.json({
    user: u,
    orders: await db.all(
      'SELECT id, status, from_id, to_id, send_amount, recv_amount, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      u.id
    ),
    balances: await db.all('SELECT currency_id, amount FROM balances WHERE user_id = ?', u.id),
    kyc: await db.all('SELECT id, kind, filename, mime, bytes, status, reason, created_at FROM kyc_docs WHERE user_id = ?', u.id),
    sessions: await db.val('SELECT COUNT(*) FROM sessions WHERE user_id = ?', u.id),
    affiliate: {
      referrals: await db.val('SELECT COUNT(*) FROM users WHERE referrer_id = ?', u.id),
      earned: await db.val('SELECT COALESCE(SUM(CAST(reward_usd AS REAL)),0) FROM affiliate_rewards WHERE user_id = ?', u.id)
    }
  });
}));

r.patch('/users/:id', wrap(async (req, res) => {
  const u = await db.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!u) throw new HttpError(404, 'User not found');

  const sets = [];
  const args = [];

  if ('blocked' in req.body) {
    const blocked = bool(req.body, 'blocked');
    const reason = blocked ? reasonOf(req) : null;
    sets.push('blocked = ?', 'block_reason = ?');
    args.push(blocked ? 1 : 0, reason);
    // blocking must take effect now, not when the session happens to expire
    if (blocked) await db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  }

  if ('role' in req.body) {
    // only an admin may change roles, and nobody may demote themselves out
    // of the last admin seat
    adminGuard(req);
    const role = oneOf(req.body, 'role', ['user', 'operator', 'admin'], { label: 'Role' });
    if (u.role === 'admin' && role !== 'admin') {
      const admins = await db.val("SELECT COUNT(*) FROM users WHERE role = 'admin'");
      if (admins <= 1) throw new HttpError(409, 'This is the only administrator - promote someone else first');
    }
    sets.push('role = ?');
    args.push(role);
  }

  if ('discountBp' in req.body) {
    sets.push('discount_bp = ?');
    args.push(int(req.body, 'discountBp', { min: 0, max: 500, label: 'Discount' }));
  }

  if ('kycStatus' in req.body) {
    sets.push('kyc_status = ?');
    args.push(oneOf(req.body, 'kycStatus', ['none', 'pending', 'approved', 'rejected'], { label: 'KYC status' }));
  }

  if (!sets.length) throw new HttpError(400, 'Nothing to update');

  args.push(u.id);
  await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...args);

  await audit(req, 'user.update', {
    entity: 'user', entityId: u.id,
    detail: { before: { role: u.role, blocked: u.blocked, discount_bp: u.discount_bp }, patch: req.body }
  });
  res.json({ ok: true });
}));

r.post('/users/:id/revoke-sessions', wrap(async (req, res) => {
  const info = await db.run('DELETE FROM sessions WHERE user_id = ?', req.params.id);
  await audit(req, 'user.revoke_sessions', { entity: 'user', entityId: req.params.id, detail: { count: info.changes } });
  res.json({ ok: true, revoked: info.changes });
}));

function adminGuard(req) {
  if (req.user.role !== 'admin') throw new HttpError(403, 'Administrator rights required');
}

/* ------------------------------------------------------------------- kyc */
r.get('/kyc', wrap(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : 'pending';
  res.json(await db.all(
    `SELECT k.*, u.login, u.email FROM kyc_docs k JOIN users u ON u.id = k.user_id
      WHERE k.status = ? ORDER BY k.created_at DESC LIMIT 200`,
    status
  ));
}));

r.post('/kyc/:id/review', wrap(async (req, res) => {
  const doc = await db.get('SELECT * FROM kyc_docs WHERE id = ?', req.params.id);
  if (!doc) throw new HttpError(404, 'Document not found');

  const decision = oneOf(req.body, 'decision', ['approved', 'rejected'], { label: 'Decision' });
  const reason = decision === 'rejected' ? reasonOf(req) : str(req.body, 'reason', { required: false, max: 400 });

  await db.tx(async () => {
    await db.run('UPDATE kyc_docs SET status = ?, reviewed_by = ?, reason = ? WHERE id = ?',
      decision, req.user.id, reason || null, doc.id);

    // the user's overall status follows: approved once nothing is pending or
    // rejected, rejected the moment any document is
    const pending = await db.val("SELECT COUNT(*) FROM kyc_docs WHERE user_id = ? AND status = 'pending'", doc.user_id);
    const rejected = await db.val("SELECT COUNT(*) FROM kyc_docs WHERE user_id = ? AND status = 'rejected'", doc.user_id);
    const next = rejected ? 'rejected' : (pending ? 'pending' : 'approved');
    await db.run('UPDATE users SET kyc_status = ? WHERE id = ?', next, doc.user_id);
  });

  await audit(req, 'kyc.review', { entity: 'kyc', entityId: doc.id, detail: { decision, reason, user: doc.user_id } });
  res.json({ ok: true });
}));

/* ----------------------------------------------------------- withdrawals */
r.get('/withdrawals', wrap(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : 'pending';
  res.json(await db.all(
    `SELECT w.*, u.login, u.email FROM withdrawals w JOIN users u ON u.id = w.user_id
      WHERE w.status = ? ORDER BY w.created_at DESC LIMIT 200`,
    status
  ));
}));

r.post('/withdrawals/:id/review', wrap(async (req, res) => {
  const w = await db.get('SELECT * FROM withdrawals WHERE id = ?', req.params.id);
  if (!w) throw new HttpError(404, 'Withdrawal not found');
  if (w.status !== 'pending') throw new HttpError(409, `Already ${w.status}`);

  const decision = oneOf(req.body, 'decision', ['paid', 'rejected'], { label: 'Decision' });
  const reason = decision === 'rejected' ? reasonOf(req) : str(req.body, 'reason', { required: false, max: 400 });

  await db.tx(async () => {
    await db.run('UPDATE withdrawals SET status = ?, operator_id = ?, reason = ?, settled_at = ? WHERE id = ?',
      decision, req.user.id, reason || null, db.now(), w.id);

    // a rejection returns the funds that were held when the request was made
    if (decision === 'rejected') {
      const bal = await db.val(`SELECT amount FROM balances WHERE user_id = ? AND currency_id = ?${db.forUpdate}`,
        w.user_id, w.currency_id) || '0';
      await db.run(
        `INSERT INTO balances (user_id, currency_id, amount) VALUES (?, ?, ?)
         ON CONFLICT(user_id, currency_id) DO UPDATE SET amount = excluded.amount`,
        w.user_id, w.currency_id, M.str(M.add(bal, w.amount))
      );
      await db.run(
        `INSERT INTO ledger (user_id, currency_id, delta, reason, actor, created_at)
         VALUES (?, ?, ?, 'withdrawal rejected', ?, ?)`,
        w.user_id, w.currency_id, M.str(w.amount), `operator:${req.user.login}`, db.now()
      );
    }
  });

  await audit(req, 'withdrawal.review', { entity: 'withdrawal', entityId: w.id, detail: { decision, reason } });
  res.json({ ok: true });
}));

/* --------------------------------------------------------------- reviews */
r.get('/reviews', wrap(async (req, res) => {
  const approved = req.query.approved === '1' ? 1 : 0;
  res.json(await db.all(
    'SELECT * FROM reviews WHERE approved = ? ORDER BY created_at DESC LIMIT 200', approved
  ));
}));

r.post('/reviews/:id/moderate', wrap(async (req, res) => {
  const decision = oneOf(req.body, 'decision', ['approve', 'delete'], { label: 'Decision' });
  if (decision === 'approve') await db.run('UPDATE reviews SET approved = 1 WHERE id = ?', req.params.id);
  else await db.run('DELETE FROM reviews WHERE id = ?', req.params.id);
  await audit(req, 'review.moderate', { entity: 'review', entityId: req.params.id, detail: { decision } });
  res.json({ ok: true });
}));

/* ----------------------------------------------------------------- rates */
r.get('/rates', wrap(async (_req, res) => res.json(await rates.status())));

r.post('/rates/refresh', wrap(async (req, res) => {
  const out = await rates.refresh();
  await audit(req, 'rates.manual_refresh', { detail: { applied: out.applied, errors: out.errors } });
  res.json(out);
}));

/* -------------------------------------------------------------- settings */
r.get('/settings', wrap(async (_req, res) => {
  res.json({
    settings: await db.all('SELECT key, value FROM settings ORDER BY key'),
    config: {
      lockMinutes: config.order.lockMinutes,
      confirmations: config.order.confirmations,
      ratesRefreshSec: config.rates.refreshSec,
      maxStaleSec: config.rates.maxStaleSec,
      env: config.env
    }
  });
}));

r.put('/settings', adminOnly, wrap(async (req, res) => {
  const key = oneOf(req.body, 'key', [
    'maintenance', 'kyc_threshold_usd',
    'affiliate_tier1_bp', 'affiliate_tier2_bp', 'affiliate_tier3_bp',
    'affiliate_min_payout_usd'
  ], { label: 'Setting' });
  const value = str(req.body, 'value', { max: 200, label: 'Value' });

  const before = await db.setting(key);
  await db.setSetting(key, value);
  await audit(req, 'settings.update', { entity: 'setting', entityId: key, detail: { before, after: value } });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------- audit log */
r.get('/audit', wrap(async (req, res) => {
  const { limit, offset, page } = paging(req.query, { max: 200, def: 50 });
  const where = [];
  const args = [];
  if (req.query.actor) { where.push('actor_login = ?'); args.push(String(req.query.actor)); }
  if (req.query.action) { where.push('action LIKE ?'); args.push(`%${String(req.query.action)}%`); }
  if (req.query.entity) { where.push('entity = ?'); args.push(String(req.query.entity)); }
  const sql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  res.json({
    page, limit,
    total: await db.val(`SELECT COUNT(*) FROM audit_log ${sql}`, ...args),
    entries: await db.all(
      `SELECT * FROM audit_log ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      ...args, limit, offset
    )
  });
}));

export default r;
