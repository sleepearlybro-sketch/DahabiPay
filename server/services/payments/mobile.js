/* ==========================================================================
   Mobile money rail adapter.

   Shaped for the aggregator pattern used across African mobile money
   (M-Pesa Daraja, MTN MoMo, Airtel Money, and aggregators like Flutterwave
   or Paystack that front several of them): OAuth-ish key+secret, a
   collection request for deposits, a disbursement for payouts, and a signed
   callback on settlement.

   Inert until MOBILE_API_KEY, MOBILE_API_SECRET and MOBILE_API_URL are set.
   ========================================================================== */

import crypto from 'node:crypto';

export const name = 'mobile';

export function configured(cfg) {
  const missing = [];
  if (!cfg.apiKey) missing.push('MOBILE_API_KEY');
  if (!cfg.apiSecret) missing.push('MOBILE_API_SECRET');
  if (!cfg.apiUrl) missing.push('MOBILE_API_URL');
  if (!cfg.webhookSecret) missing.push('MOBILE_WEBHOOK_SECRET');
  return missing;
}

async function call(cfg, path, body) {
  const res = await fetch(cfg.apiUrl.replace(/\/$/, '') + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: 'Basic ' + Buffer.from(`${cfg.apiKey}:${cfg.apiSecret}`).toString('base64')
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25_000)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    throw new Error(`mobile provider ${res.status}: ${data?.message || text.slice(0, 200)}`);
  }
  return data;
}

/**
 * Mobile money has no "deposit address". Collection is a push: the customer
 * is prompted on their handset, so what we hand back is a paybill/till plus
 * the order id as the reference the operator reconciles on.
 */
export async function createDeposit(order, currency, payments) {
  const cfg = payments.mobile;
  const data = await call(cfg, '/collections', {
    reference: order.id,
    currency: currency.code,
    amount: order.send_amount,
    channel: currency.id
  });
  return {
    address: data?.paybill ?? data?.shortcode ?? null,
    memo: data?.reference ?? order.id,
    pushPrompt: !!data?.prompted
  };
}

export async function payout(order, currency, requisite, payments) {
  const cfg = payments.mobile;
  const data = await call(cfg, '/disbursements', {
    idempotencyKey: `${order.id}:payout`,
    reference: order.id,
    currency: currency.code,
    amount: order.recv_amount,
    channel: currency.id,
    msisdn: requisite,
    narration: `Dahabi Pay ${order.id}`
  });
  return {
    providerRef: data?.id ?? data?.transactionId ?? null,
    status: data?.status === 'SUCCESSFUL' ? 'completed' : 'submitted'
  };
}

export function verifyWebhook(rawBody, headers, secret) {
  if (!secret) return { ok: false, reason: 'MOBILE_WEBHOOK_SECRET not set' };

  const sent = String(headers['verif-hash'] || headers['x-signature'] || '');
  if (!sent) return { ok: false, reason: 'signature header missing' };

  const want = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(sent.replace(/^sha256=/, ''), 'utf8');
  const b = Buffer.from(want, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }

  let body;
  try { body = JSON.parse(rawBody.toString('utf8')); }
  catch { return { ok: false, reason: 'body is not JSON' }; }

  return {
    ok: true,
    providerRef: body.id || body.transactionId || null,
    orderId: body.reference || body.orderId || null,
    event: body.status || body.event || 'unknown',
    amount: body.amount ?? null,
    txHash: null,
    confirmations: 1                            // mobile money settles atomically
  };
}
