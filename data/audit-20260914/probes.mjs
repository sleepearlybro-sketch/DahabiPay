// Audit-only probes against the isolated local database and manual payment rails.
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
const base = 'http://127.0.0.1:3107';
const db = new DatabaseSync(fileURLToPath(new URL('./audit.db', import.meta.url)));
db.prepare('DELETE FROM rate_limits').run();
const request = async (path, body, headers = {}) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const make = async (from, to, amount, requisite) => request('/api/orders', { from, to, amount, requisite, email: 'audit@example.invalid' });
const hook = (rail, payload) => request('/api/webhooks/' + rail, payload, {
  'x-signature': createHmac('sha256', rail === 'crypto' ? 'local-audit-webhook-20260914' : 'local-audit-mobile-20260914').update(JSON.stringify(payload)).digest('hex')
});
const out = {};
out.kyc300KB = await request('/api/account/kyc', { kind: 'id_front', filename: 'sample.png', mime: 'image/png', data: Buffer.alloc(300 * 1024).toString('base64') });
const internal = await make('acct_usd', 'mpesa_kes', '100', '254712345678');
out.internalGuest = { status: internal.status, orderStatus: internal.data.order?.status, error: internal.data.error, userId: internal.data.order ? db.prepare('SELECT user_id FROM orders WHERE id=?').get(internal.data.order.id).user_id : null };
const large = await make('usdt_trc20', 'mpesa_kes', '3000', '254712345678');
out.kycThreshold = { configured: db.prepare("SELECT value FROM settings WHERE key='kyc_threshold_usd'").get()?.value, status: large.status, orderStatus: large.data.order?.status, error: large.data.error };
const mobile = await make('mpesa_kes', 'moneygo', '5000', 'AUDIT123');
if (mobile.data.order) out.mobileConfirmations = await hook('mobile', { id: 'audit-mobile-confirmation', reference: mobile.data.order.id, status: 'SUCCESSFUL', amount: '5000' });
const absent = await make('usdt_trc20', 'mpesa_kes', '100', '254712345678');
if (absent.data.order) {
  out.missingPaymentAmount = await hook('crypto', { id: 'audit-missing-amount', reference: absent.data.order.id, type: 'deposit.confirmed', confirmations: 3 });
  out.payoutCompletion = await hook('crypto', { id: 'audit-payout-completed', reference: absent.data.order.id, type: 'payout.completed', confirmations: 3 });
  out.statusAfterPayoutCompletion = db.prepare('SELECT status FROM orders WHERE id=?').get(absent.data.order.id).status;
}
console.log(JSON.stringify(out, null, 2));
db.close();
