/* ==========================================================================
   Manual provider - the default, and the one that needs no credentials.

   Deposits show the static address held on the currency row; payouts are
   not attempted at all, they are handed to the operator queue. This keeps
   the whole pipeline exercisable end to end with nothing configured, and is
   also the correct fallback for rails that have no payout API (cash pickup,
   counter transfers).
   ========================================================================== */

export const name = 'manual';

export function configured() {
  return [];                                  // nothing to configure
}

export async function createDeposit(_order, currency) {
  return {
    address: currency.deposit_addr || null,
    memo: currency.deposit_memo || null,
    // no address on file is an operator problem, not a customer error
    needsOperator: !currency.deposit_addr
  };
}

export async function payout(order, _currency, _requisite) {
  // Deliberately does not mark itself paid. The order stays in `processing`
  // until an operator confirms the transfer in the admin panel, which is
  // what makes the money movement a human decision.
  return {
    providerRef: null,
    status: 'queued',
    queuedForOperator: true,
    detail: `awaiting manual payout of ${order.recv_amount}`
  };
}

export function verifyWebhook() {
  // There is no upstream to call us, so nothing can be verified.
  return { ok: false, reason: 'manual provider accepts no webhooks' };
}
