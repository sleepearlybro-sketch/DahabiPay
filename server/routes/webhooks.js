/* ==========================================================================
   Provider callbacks.

   Three defences, all mandatory:
     1. HMAC signature verified with a timing-safe compare. An unsigned or
        mismatched callback is recorded and dropped, never acted on.
     2. Recorded by (provider, provider_ref) with a UNIQUE constraint, so a
        replay is recognised and ignored.
     3. Payout is claimed through payout_locks, so even a replay that slipped
        past (2) cannot pay twice.

   The body must stay raw for step 1, so express.raw() is mounted here rather
   than express.json().
   ========================================================================== */

import { Router } from 'express';
import express from 'express';
import * as db from '../db.js';
import * as M from '../lib/money.js';
import * as O from '../lib/orders.js';
import * as cryptoRail from '../services/payments/crypto.js';
import * as mobileRail from '../services/payments/mobile.js';
import { auditSystem } from '../lib/http.js';
import { config } from '../config.js';
import { settleOrder } from '../lib/settle.js';

const r = Router();

const RAILS = {
  crypto: { impl: cryptoRail, secret: () => config.payments.crypto.webhookSecret },
  mobile: { impl: mobileRail, secret: () => config.payments.mobile.webhookSecret }
};

async function record({ provider, ref, orderId, event, payload, accepted, reason }) {
  try {
    await db.run(
      `INSERT INTO webhook_events (provider, provider_ref, order_id, event, payload, accepted, reason, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      provider, ref, orderId ?? null, event ?? null,
      String(payload).slice(0, 8000), accepted ? 1 : 0, reason ?? null, db.now()
    );
    return true;
  } catch (err) {
    // UNIQUE(provider, provider_ref) - this exact callback was already handled
    if (/UNIQUE|constraint/i.test(String(err.message))) return false;
    throw err;
  }
}

/**
 * POST /api/webhooks/:rail  (rail = crypto | mobile)
 *
 * Always answers 200 once the signature checks out, even when we decide to
 * do nothing: providers retry on non-2xx, and a retry storm over a business
 * decision we have already recorded is pointless.
 */
r.post('/:rail',
  express.raw({ type: '*/*', limit: '256kb' }),
  async (req, res) => {
    const railName = String(req.params.rail || '');
    const rail = RAILS[railName];
    if (!rail) return res.status(404).json({ error: 'Unknown rail' });

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''));
    const secret = rail.secret();

    const v = rail.impl.verifyWebhook(raw, req.headers, secret);
    if (!v.ok) {
      // Not authenticated, so nothing in the body is trustworthy - log the
      // rejection with a synthetic ref and stop.
      await record({
        provider: railName,
        ref: `rejected:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        event: 'rejected', payload: raw.toString('utf8'),
        accepted: false, reason: v.reason
      });
      await auditSystem('webhook.rejected', { entity: 'webhook', detail: { rail: railName, reason: v.reason } });
      console.warn('webhook rejected (%s): %s', railName, v.reason);
      return res.status(401).json({ error: 'Signature verification failed' });
    }

    const ref = v.providerRef || `${v.orderId || 'unknown'}:${v.event}`;
    const fresh = await record({
      provider: railName, ref, orderId: v.orderId, event: v.event,
      payload: raw.toString('utf8'), accepted: true
    });
    if (!fresh) {
      return res.json({ ok: true, duplicate: true });
    }

    const order = v.orderId ? await db.get('SELECT * FROM orders WHERE id = ?', v.orderId) : null;
    if (!order) {
      await auditSystem('webhook.unknown_order', { entity: 'webhook', detail: { rail: railName, orderId: v.orderId } });
      return res.json({ ok: true, ignored: 'unknown order' });
    }

    try {
      const outcome = await handle(order, v, railName);
      return res.json({ ok: true, ...outcome });
    } catch (err) {
      console.error('webhook handling failed for %s: %s', order.id, err.message);
      await auditSystem('webhook.error', { entity: 'order', entityId: order.id, detail: { error: err.message } });
      // the callback was genuine and is recorded; a retry would just replay it
      return res.json({ ok: true, error: err.message });
    }
  });

/** Decide what a verified event means for the order. */
async function handle(order, v, railName) {
  const isPayment = /deposit|payment|received|charge|success/i.test(v.event || '');
  const isFailure = /fail|revers|reject|charge?back/i.test(v.event || '');

  if (isFailure) {
    if (!O.isTerminal(order.status) && O.canTransition(order.status, O.STATES.ON_HOLD)) {
      await O.transition(order.id, O.STATES.ON_HOLD, 'system', {
        detail: `provider reported ${v.event}`,
        patch: { hold_reason: `provider reported ${v.event}` }
      });
    }
    return { action: 'held' };
  }

  if (!isPayment) return { action: 'noted' };

  // A short payment is a business decision, not an automatic payout.
  if (v.amount != null) {
    const paid = M.dec(v.amount);
    if (M.lt(paid, order.send_amount)) {
      await O.transition(order.id, O.STATES.ON_HOLD, 'system', {
        detail: `underpaid: received ${M.str(paid)} of ${order.send_amount}`,
        patch: { hold_reason: 'underpayment', paid_amount: M.str(paid) }
      });
      return { action: 'held', reason: 'underpayment' };
    }
    await db.run('UPDATE orders SET paid_amount = ? WHERE id = ?', M.str(paid), order.id);
  }

  if (order.status === O.STATES.AWAITING || order.status === O.STATES.CREATED) {
    await O.transition(order.id, O.STATES.DETECTED, 'system', {
      detail: `payment seen via ${railName}${v.txHash ? ` (${v.txHash})` : ''}`,
      patch: v.txHash ? { tx_hash: v.txHash } : {}
    });
  }

  // hold off until the chain has settled enough
  if (v.confirmations < config.order.confirmations) {
    return { action: 'awaiting_confirmations', have: v.confirmations, need: config.order.confirmations };
  }

  const current = await db.get('SELECT * FROM orders WHERE id = ?', order.id);
  if (current.status !== O.STATES.DETECTED) return { action: 'no_change', status: current.status };

  return await settleOrder(current, 'system');
}

export default r;
