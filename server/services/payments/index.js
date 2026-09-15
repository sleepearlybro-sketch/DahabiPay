/* ==========================================================================
   Payment provider registry.

   One interface, three implementations. Order logic never knows which
   provider it is talking to:

     createDeposit(order, currency)          -> { address, memo? }
     payout(order, currency, requisite)      -> { providerRef, status }
     verifyWebhook(rawBody, headers, secret) -> { ok, orderId, event, ... }

   `manual` is the default and needs no keys, so the system is fully
   operable before any credential exists - payouts simply queue for an
   operator. A provider that is named but not configured degrades to manual
   rather than failing later at payout time, which would strand a paid order.
   ========================================================================== */

import { config } from '../../config.js';
import * as manual from './manual.js';
import * as crypto from './crypto.js';
import * as mobile from './mobile.js';

const IMPLS = { manual, crypto, mobile };

/**
 * Which provider handles this currency, and is it actually usable?
 * Returns the manual provider plus a reason whenever it is not.
 */
export function providerFor(currency) {
  if (currency.manual) {
    return { name: 'manual', impl: manual, reason: 'currency is flagged manual' };
  }

  const kind = currency.grp === 'crypto' ? 'crypto' : 'mobile';
  const cfg = config.payments[kind];
  const wanted = cfg.provider || 'manual';

  if (wanted === 'manual') {
    return { name: 'manual', impl: manual, reason: `${kind.toUpperCase()}_PROVIDER is manual` };
  }

  const impl = IMPLS[kind];
  const missing = impl.configured ? impl.configured(cfg) : [];
  if (missing.length) {
    return {
      name: 'manual',
      impl: manual,
      reason: `${wanted} is not configured (missing ${missing.join(', ')})`
    };
  }

  return { name: wanted, impl, reason: null };
}

export async function createDeposit(order, currency) {
  const { name, impl, reason } = providerFor(currency);
  const out = await impl.createDeposit(order, currency, config.payments);
  return { ...out, provider: name, degraded: reason };
}

export async function payout(order, currency, requisite) {
  const { name, impl, reason } = providerFor(currency);
  const out = await impl.payout(order, currency, requisite, config.payments);
  return { ...out, provider: name, degraded: reason };
}

/** Report which rails are live, for the admin dashboard. */
export function health() {
  const out = {};
  for (const kind of ['crypto', 'mobile']) {
    const cfg = config.payments[kind];
    const impl = IMPLS[kind];
    const missing = cfg.provider === 'manual' ? [] : (impl.configured?.(cfg) ?? []);
    out[kind] = {
      provider: cfg.provider,
      live: cfg.provider !== 'manual' && missing.length === 0,
      missing,
      webhookSecretSet: !!cfg.webhookSecret
    };
  }
  return out;
}
