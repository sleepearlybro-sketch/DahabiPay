/* ==========================================================================
   Crypto rail adapter.

   Shaped for the common custodial-API pattern (BitGo, Fireblocks, Coinbase
   Commerce, NOWPayments and friends all fit): request a deposit address per
   order, POST a withdrawal, receive a signed webhook on confirmation.

   Nothing here runs until CRYPTO_API_KEY and CRYPTO_API_URL are set - until
   then providerFor() routes to the manual provider instead.
   ========================================================================== */

import crypto from 'node:crypto';

export const name = 'crypto';

/** Which env values are missing. Empty array means ready. */
export function configured(cfg) {
  const missing = [];
  if (!cfg.apiKey) missing.push('CRYPTO_API_KEY');
  if (!cfg.apiUrl) missing.push('CRYPTO_API_URL');
  if (!cfg.webhookSecret) missing.push('CRYPTO_WEBHOOK_SECRET');
  return missing;
}

async function call(cfg, path, body) {
  const res = await fetch(cfg.apiUrl.replace(/\/$/, '') + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
      accept: 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!res.ok) {
    throw new Error(`crypto provider ${res.status}: ${data?.message || text.slice(0, 200)}`);
  }
  return data;
}

/**
 * A dedicated deposit address per order is what lets the webhook attribute
 * an incoming transfer without the customer supplying a memo.
 */
export async function createDeposit(order, currency, payments) {
  const cfg = payments.crypto;
  const data = await call(cfg, '/addresses', {
    reference: order.id,
    asset: currency.code,
    network: currency.net || undefined
  });
  return { address: data?.address ?? null, memo: data?.memo ?? null };
}

export async function payout(order, currency, requisite, payments) {
  const cfg = payments.crypto;
  const data = await call(cfg, '/withdrawals', {
    // the provider must treat this as an idempotency key, so a retried
    // request cannot produce a second on-chain transfer
    idempotencyKey: `${order.id}:payout`,
    reference: order.id,
    asset: currency.code,
    network: currency.net || undefined,
    amount: order.recv_amount,
    destination: requisite
  });
  return {
    providerRef: data?.id ?? null,
    status: data?.status === 'completed' ? 'completed' : 'submitted',
    txHash: data?.txHash ?? null
  };
}

/**
 * Verify an inbound webhook. HMAC-SHA256 over the raw body, compared with a
 * timing-safe equal. An unsigned or mismatched callback is rejected and the
 * caller drops it without touching order state.
 */
export function verifyWebhook(rawBody, headers, secret) {
  if (!secret) return { ok: false, reason: 'CRYPTO_WEBHOOK_SECRET not set' };

  const sent = String(headers['x-signature'] || headers['x-webhook-signature'] || '');
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
    providerRef: body.id || body.eventId || null,
    orderId: body.reference || body.orderId || null,
    event: body.type || body.event || 'unknown',
    amount: body.amount ?? null,
    txHash: body.txHash ?? body.hash ?? null,
    confirmations: Number(body.confirmations ?? 0)
  };
}
