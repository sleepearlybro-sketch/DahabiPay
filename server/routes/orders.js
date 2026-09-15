/* ==========================================================================
   Customer-facing order endpoints.

   Guest orders are supported: creation returns an access token which is the
   only way to read that order back without a session. Orders are never
   addressable by id alone, so a sequential-id guess reveals nothing.
   ========================================================================== */

import { Router } from 'express';
import * as db from '../db.js';
import * as M from '../lib/money.js';
import * as O from '../lib/orders.js';
import * as payments from '../services/payments/index.js';
import { wrap, str, decimal, oneOf, email as emailField, audit, HttpError } from '../lib/http.js';
import { limiter, clientIp } from '../lib/auth.js';
import { sendTemplate, templates } from '../services/mail.js';
import { config } from '../config.js';

const r = Router();

/** An order is readable with a session that owns it, an access token, or operator rights. */
function authorise(req, order) {
  if (!order) throw new HttpError(404, 'Order not found');
  const token = String(req.query.t || req.body?.accessToken || '');
  const owns = req.user && order.user_id === req.user.id;
  const staff = req.user && ['operator', 'admin'].includes(req.user.role);
  const hasToken = order.access_token && token && token === order.access_token;
  if (!owns && !staff && !hasToken) throw new HttpError(403, 'Not your order');
  return order;
}

/* ---------------------------------------------------------------- create */
r.post('/',
  limiter({ name: 'order_create', limit: 12, windowSec: 600 }),
  wrap(async (req, res) => {
    if (await db.setting('maintenance', '0') === '1') {
      throw new HttpError(503, 'The exchanger is in maintenance. Try again shortly.');
    }

    const fromId = str(req.body, 'from', { max: 40, label: 'Send currency' });
    const toId = str(req.body, 'to', { max: 40, label: 'Receive currency' });
    const amount = decimal(req.body, 'amount', { label: 'Amount' });
    const side = oneOf(req.body, 'side', ['send', 'receive'], { required: false }) || 'send';
    const requisite = str(req.body, 'requisite', { max: 200, label: 'Receiving requisite' });
    const email = emailField(req.body, 'email');
    const holder = str(req.body, 'holder', { required: false, max: 120 });
    const note = str(req.body, 'note', { required: false, max: 1000 });

    // create() re-prices inside the transaction; whatever the client computed
    // is ignored entirely
    const created = await O.create({
      fromId, toId, amount, side, requisite, email, holder, note,
      user: req.user, ip: clientIp(req)
    });

    const order = await db.get('SELECT * FROM orders WHERE id = ?', created.id);
    const from = await O.currency(fromId);
    const to = await O.currency(toId);

    // ask the provider for a deposit target, then open the order for payment
    let deposit = { address: order.deposit_address, memo: order.deposit_memo };
    let depositError = null;
    try {
      deposit = await payments.createDeposit(order, from);
    } catch (err) {
      // a provider outage must not strand the customer: fall back to the
      // static address and let an operator sort it out
      depositError = err.message;
      console.error('deposit creation failed for %s: %s', order.id, err.message);
    }

    const updated = await O.transition(created.id, O.STATES.AWAITING, 'system', {
      detail: depositError
        ? `provider unavailable (${depositError}); using static address`
        : `deposit via ${deposit.provider || order.provider}`,
      patch: {
        deposit_address: deposit.address ?? order.deposit_address ?? null,
        deposit_memo: deposit.memo ?? order.deposit_memo ?? null,
        ...(deposit.provider ? { provider: deposit.provider } : {})
      }
    });

    await audit(req, 'order.create', {
      entity: 'order', entityId: order.id,
      detail: { from: fromId, to: toId, send: created.send, recv: created.recv }
    });

    const link = `${config.origin}/pages/order.html?id=${order.id}&t=${created.accessToken}`;
    await sendTemplate(email, templates.orderCreated(updated, from, to, link));

    res.status(201).json({
      ok: true,
      accessToken: created.accessToken,
      order: await O.publicView(updated),
      needsOperator: !updated.deposit_address
    });
  }));

/* ----------------------------------------------------------------- lookup
   A guest who lost their emailed link can find the order again with the id
   plus the email it was created with. Rate limited, because the pair is
   guessable in principle.                                                */
r.post('/lookup',
  limiter({ name: 'order_lookup', limit: 10, windowSec: 600 }),
  wrap(async (req, res) => {
    const id = str(req.body, 'id', { max: 40, label: 'Application ID' });
    const email = emailField(req.body, 'email');

    const order = await db.get('SELECT * FROM orders WHERE id = ?', id);
    // one message for both "no such order" and "wrong email", so this cannot
    // be used to confirm that an id exists
    if (!order || order.email.toLowerCase() !== email) {
      throw new HttpError(404, 'No application matches that ID and email address.');
    }

    await audit(req, 'order.lookup', { entity: 'order', entityId: order.id });
    res.json({ ok: true, id: order.id, accessToken: order.access_token });
  }));

/* ------------------------------------------------------------------- read */
r.get('/:id', wrap(async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
  authorise(req, order);
  res.json({ order: await O.publicView(order) });
}));

/* ------------------------------------------------- customer asserts payment
   This is a claim, not proof. It moves the order to payment_detected so an
   operator sees it; only a verified webhook or an operator advances it into
   processing and payout.                                                   */
r.post('/:id/paid',
  limiter({ name: 'order_paid', limit: 20, windowSec: 600 }),
  wrap(async (req, res) => {
    const order = await db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
    authorise(req, order);

    const txHash = str(req.body, 'txHash', { required: false, max: 200 });

    const updated = await O.transition(order.id, O.STATES.DETECTED, 'customer', {
      detail: txHash ? `customer reported tx ${txHash}` : 'customer reported payment',
      patch: txHash ? { tx_hash: txHash } : {}
    });
    await audit(req, 'order.customer_paid', { entity: 'order', entityId: order.id });

    res.json({ ok: true, order: await O.publicView(updated) });
  }));

/* ----------------------------------------------------------------- cancel */
r.post('/:id/cancel', wrap(async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
  authorise(req, order);

  if (![O.STATES.CREATED, O.STATES.AWAITING, O.STATES.EXPIRED].includes(order.status)) {
    throw new HttpError(409, 'This order can no longer be cancelled by you. Contact support.');
  }
  const updated = await O.transition(order.id, O.STATES.CANCELLED, 'customer', {
    detail: 'cancelled by customer',
    patch: { cancel_reason: 'cancelled by customer before payment' }
  });
  await audit(req, 'order.customer_cancel', { entity: 'order', entityId: order.id });

  res.json({ ok: true, order: await O.publicView(updated) });
}));

/* -------------------------------------------------------------- re-accept
   An expired quote is re-priced at today's rate; the customer chooses
   whether to take it.                                                    */
r.post('/:id/requote', wrap(async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
  authorise(req, order);

  const updated = await O.requote(order.id, 'customer');
  await audit(req, 'order.requote', { entity: 'order', entityId: order.id, detail: { rate: updated.rate } });

  res.json({ ok: true, order: await O.publicView(updated) });
}));

/* --------------------------------------------------------------- preview
   What a re-quote would cost, without committing to it.                  */
r.get('/:id/requote-preview', wrap(async (req, res) => {
  const order = await db.get('SELECT * FROM orders WHERE id = ?', req.params.id);
  authorise(req, order);

  const from = await O.currency(order.from_id);
  const to = await O.currency(order.to_id);
  const q = await O.quote({ from, to, amount: order.send_amount, side: 'send' });

  res.json({
    previous: { rate: order.rate, recv: order.recv_amount },
    current: q.errors.length ? null : { rate: q.rate, recv: q.recv },
    delta: q.errors.length ? null : M.str(M.sub(q.recv, order.recv_amount)),
    error: q.errors[0] ?? null
  });
}));

export default r;
