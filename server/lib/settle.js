/* ==========================================================================
   Settlement - the one path that moves money out.

   Shared by the webhook handler and the admin panel so there is exactly one
   implementation of "pay this order". The payout claim is taken before the
   provider is called, which is what makes a replayed webhook and a
   double-clicked operator button both harmless.
   ========================================================================== */

import * as db from '../db.js';
import * as M from './money.js';
import * as O from './orders.js';
import * as payments from '../services/payments/index.js';
import { auditSystem } from './http.js';
import { sendTemplate, templates } from '../services/mail.js';
import { config } from '../config.js';

/**
 * Take an order from payment_detected through to payout.
 *
 * @param actor 'system' for webhook-driven, 'operator:<login>' when a human
 *              pressed the button.
 * @param force operator override: settle even from on_hold.
 */
export async function settleOrder(order, actor, { force = false } = {}) {
  if (order.status === O.STATES.COMPLETED) {
    return { action: 'already_completed' };
  }

  // Claim first. If someone else holds it, another settlement is already in
  // flight or finished, and calling the provider again could pay twice.
  if (await O.payoutClaimed(order.id)) {
    return { action: 'already_claimed' };
  }

  const from = await O.currency(order.from_id);
  const to = await O.currency(order.to_id);

  if (order.status !== O.STATES.PROCESSING) {
    const allowed = order.status === O.STATES.DETECTED ||
      (force && order.status === O.STATES.ON_HOLD);
    if (!allowed) {
      return { action: 'wrong_status', status: order.status };
    }
    await O.transition(order.id, O.STATES.PROCESSING, actor, { detail: 'payout started' });
  }

  if (!await O.claimPayout(order.id, order.provider, null)) {
    return { action: 'already_claimed' };
  }

  let result;
  try {
    result = await payments.payout(order, to, order.requisite);
  } catch (err) {
    // The claim stays in place deliberately: a failed payout must be looked
    // at by a human, not retried automatically into a possible double send.
    await O.transition(order.id, O.STATES.ON_HOLD, actor, {
      detail: `payout failed: ${err.message}`,
      patch: { hold_reason: `payout failed: ${err.message}` }
    });
    await auditSystem('order.payout_failed', { entity: 'order', entityId: order.id, detail: { error: err.message } });
    return { action: 'payout_failed', error: err.message };
  }

  await db.run('UPDATE orders SET payout_ref = ?, provider = ? WHERE id = ?',
    result.providerRef ?? null, result.provider ?? order.provider, order.id);
  await db.run('UPDATE payout_locks SET ref = ?, provider = ? WHERE key = ?',
    result.providerRef ?? null, result.provider ?? null, `${order.id}:payout`);

  // The manual provider does not move money; it hands the order to a human,
  // so the order stays in processing until that human confirms.
  if (result.queuedForOperator) {
    await O.addEvent(order.id, O.STATES.PROCESSING, O.STATES.PROCESSING, actor,
      `queued for manual payout${result.degraded ? ` (${result.degraded})` : ''}`);
    return { action: 'queued_for_operator', reason: result.degraded };
  }

  if (result.status !== 'completed') {
    await O.addEvent(order.id, O.STATES.PROCESSING, O.STATES.PROCESSING, actor,
      `payout submitted, ref ${result.providerRef ?? 'none'}`);
    return { action: 'submitted', providerRef: result.providerRef };
  }

  return await complete(order.id, actor, { txHash: result.txHash, ref: result.providerRef });
}

/**
 * Mark an order completed. Spends the held reserve, accrues any affiliate
 * reward and notifies the customer.
 */
export async function complete(orderId, actor, { txHash, ref } = {}) {
  const updated = await O.transition(orderId, O.STATES.COMPLETED, actor, {
    detail: `payout confirmed${ref ? ` (ref ${ref})` : ''}`,
    patch: {
      ...(txHash ? { tx_hash: txHash } : {}),
      ...(ref ? { payout_ref: ref } : {})
    }
  });

  try { await accrueAffiliate(updated); }
  catch (err) { console.error('affiliate accrual failed for %s: %s', orderId, err.message); }

  const link = `${config.origin}/pages/order.html?id=${updated.id}` +
    (updated.access_token ? `&t=${updated.access_token}` : '');
  await sendTemplate(updated.email, templates.orderStatus(updated, 'Completed', link));

  await auditSystem('order.completed', {
    entity: 'order', entityId: orderId,
    detail: { send: updated.send_amount, recv: updated.recv_amount, actor }
  });

  return { action: 'completed', order: updated };
}

/* ------------------------------------------------------------- affiliate */
/** Tiered share of the fee, based on the referrer's rolling 30-day volume. */
async function tierBp(referrerId) {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const volume = await db.val(
    `SELECT COALESCE(SUM(CAST(volume_usd AS REAL)), 0) FROM affiliate_rewards
      WHERE user_id = ? AND created_at >= ?`,
    referrerId, since
  ) || 0;

  if (volume >= 100000) return Number(await db.setting('affiliate_tier3_bp', '70'));
  if (volume >= 25000) return Number(await db.setting('affiliate_tier3_bp', '70'));
  if (volume >= 5000) return Number(await db.setting('affiliate_tier2_bp', '55'));
  return Number(await db.setting('affiliate_tier1_bp', '40'));
}

async function accrueAffiliate(order) {
  if (!order.user_id) return;
  const user = await db.get('SELECT referrer_id FROM users WHERE id = ?', order.user_id);
  if (!user?.referrer_id) return;

  const from = await O.currency(order.from_id);
  const volumeUsd = M.mul(order.send_amount, from.pivot_usd);
  const shareBp = await tierBp(user.referrer_id);
  const reward = M.bpOf(volumeUsd, shareBp);
  if (!M.isPos(reward)) return;

  await db.tx(async () => {
    await db.run(
      `INSERT INTO affiliate_rewards (user_id, order_id, volume_usd, share_bp, reward_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      user.referrer_id, order.id, M.str(volumeUsd), shareBp, M.str(reward), db.now()
    );
    await db.run(
      `INSERT INTO ledger (user_id, currency_id, delta, reason, order_id, actor, created_at)
       VALUES (?, 'acct_usd', ?, 'affiliate reward', ?, 'system', ?)`,
      user.referrer_id, M.str(reward), order.id, db.now()
    );
    const previous = await db.val("SELECT amount FROM balances WHERE user_id = ? AND currency_id = 'acct_usd'", user.referrer_id) || '0';
    await db.run(
      `INSERT INTO balances (user_id, currency_id, amount) VALUES (?, 'acct_usd', ?)
       ON CONFLICT(user_id, currency_id) DO UPDATE SET amount = ?`,
      user.referrer_id, M.str(reward),
      M.str(M.add(previous, reward))
    );
  });
}
