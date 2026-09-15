/* ==========================================================================
   Webhook path, against a running server.

     npm start
     node --env-file=.env server/test/webhook.mjs

   Proves the three defences in one pass: signature verification, replay
   rejection on (provider, provider_ref), and a payout that can only be
   claimed once.
   ========================================================================== */

import crypto from 'node:crypto';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000';
const SECRET = process.env.CRYPTO_WEBHOOK_SECRET || '';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -- ' + extra : ''}`); }
};

if (!SECRET) {
  console.log('\n  CRYPTO_WEBHOOK_SECRET is not set - nothing to verify against.');
  console.log('  Set it in .env and restart the server.\n');
  process.exit(1);
}

async function openDb(readOnly = true) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(process.env.DB_FILE || './data/exchangepay.db', { readOnly });
}

/** Sign the exact bytes, the way a provider would. */
async function hook(payload, { signed = true, badSig = false } = {}) {
  const raw = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', badSig ? 'wrong-secret' : SECRET).update(raw).digest('hex');
  const res = await fetch(BASE + '/api/webhooks/crypto', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signed ? { 'x-signature': sig } : {})
    },
    body: raw
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

console.log(`\nDahabi Pay webhook checks  (${BASE})\n`);

/* ---------------------------------------------------- an order to act on */
const created = await fetch(BASE + '/api/orders', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    from: 'usdt_trc20', to: 'mpesa_kes', amount: '120',
    requisite: '254711000111', email: 'webhook@example.com'
  })
}).then((r) => r.json());

const orderId = created.order?.id;
ok('an order exists to act on', !!orderId, JSON.stringify(created).slice(0, 140));

/* ------------------------------------------------------- 1. verification */
{
  const unsigned = await hook({ reference: orderId, type: 'deposit.confirmed', confirmations: 3 }, { signed: false });
  ok('unsigned is rejected', unsigned.status === 401, `status ${unsigned.status}`);

  const wrong = await hook({ reference: orderId, type: 'deposit.confirmed', confirmations: 3 }, { badSig: true });
  ok('a bad signature is rejected', wrong.status === 401, `status ${wrong.status}`);

  const db = await openDb();
  const rejected = db.prepare(
    "SELECT COUNT(*) AS n FROM webhook_events WHERE accepted = 0 AND event = 'rejected'"
  ).get().n;
  db.close();
  ok('rejections are recorded for review', rejected >= 2, `${rejected} recorded`);
}

/* ------------------------------------------------- 2. underpayment holds */
{
  const short = await hook({
    id: 'evt-short-' + Date.now(), reference: orderId,
    type: 'deposit.confirmed', amount: '50', confirmations: 5
  });
  ok('a short payment is accepted but held', short.status === 200 && short.data.action === 'held',
    JSON.stringify(short.data));
  ok('the hold names underpayment', short.data.reason === 'underpayment', short.data?.reason);
}

/* ------------------------------------- 3. a full payment settles the order */
let settleResult;
{
  // a fresh order, since the previous one is now on hold
  const o2 = await fetch(BASE + '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'usdt_trc20', to: 'mpesa_kes', amount: '120',
      requisite: '254711000222', email: 'webhook2@example.com'
    })
  }).then((r) => r.json());

  const id2 = o2.order.id;
  const ref = 'evt-full-' + Date.now();

  const first = await hook({
    id: ref, reference: id2, type: 'deposit.confirmed',
    amount: '120', confirmations: 5, txHash: '0xwebhooktest'
  });
  settleResult = first.data;
  ok('a verified full payment is accepted', first.status === 200, JSON.stringify(first.data));
  // the manual rail does not move money, so it queues rather than completing
  ok('settlement runs and queues for the operator',
    first.data.action === 'queued_for_operator', JSON.stringify(first.data));

  const db = await openDb();
  const row = db.prepare('SELECT status, tx_hash FROM orders WHERE id = ?').get(id2);
  const locks = db.prepare('SELECT COUNT(*) AS n FROM payout_locks WHERE order_id = ?').get(id2).n;
  db.close();
  ok('the order moved to processing', row.status === 'processing', row.status);
  ok('the transaction hash was stored', row.tx_hash === '0xwebhooktest', row.tx_hash);
  ok('exactly one payout lock exists', locks === 1, `${locks} locks`);

  /* ------------------------------------------------- 4. replay protection */
  const replay = await hook({
    id: ref, reference: id2, type: 'deposit.confirmed',
    amount: '120', confirmations: 5, txHash: '0xwebhooktest'
  });
  ok('a replayed callback is recognised', replay.status === 200 && replay.data.duplicate === true,
    JSON.stringify(replay.data));

  // a different event id on the same order must still not pay twice
  const again = await hook({
    id: 'evt-different-' + Date.now(), reference: id2,
    type: 'deposit.confirmed', amount: '120', confirmations: 5
  });
  ok('a second settlement attempt does not pay again',
    again.data.action === 'already_claimed' || again.data.action === 'no_change',
    JSON.stringify(again.data));

  const db2 = await openDb();
  const locks2 = db2.prepare('SELECT COUNT(*) AS n FROM payout_locks WHERE order_id = ?').get(id2).n;
  const events = db2.prepare(
    'SELECT COUNT(*) AS n FROM webhook_events WHERE order_id = ? AND accepted = 1'
  ).get(id2).n;
  db2.close();
  ok('still exactly one payout lock', locks2 === 1, `${locks2} locks`);
  ok('both genuine callbacks were recorded', events === 2, `${events} recorded`);
}

/* ------------------------------------------- 5. confirmations are respected */
{
  const o3 = await fetch(BASE + '/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: 'usdt_trc20', to: 'mpesa_kes', amount: '120',
      requisite: '254711000333', email: 'webhook3@example.com'
    })
  }).then((r) => r.json());

  const r = await hook({
    id: 'evt-unconfirmed-' + Date.now(), reference: o3.order.id,
    type: 'deposit.seen', amount: '120', confirmations: 0
  });
  ok('an unconfirmed payment does not settle',
    r.data.action === 'awaiting_confirmations', JSON.stringify(r.data));
  ok('it reports what it is waiting for',
    r.data.need >= 1 && r.data.have === 0, JSON.stringify(r.data));

  const db = await openDb();
  const locks = db.prepare('SELECT COUNT(*) AS n FROM payout_locks WHERE order_id = ?').get(o3.order.id).n;
  db.close();
  ok('no payout was claimed', locks === 0, `${locks} locks`);
}

/* -------------------------------------------- 6. unknown order is ignored */
{
  const r = await hook({
    id: 'evt-orphan-' + Date.now(), reference: 'EP-DOES-NOT-EXIST',
    type: 'deposit.confirmed', amount: '10', confirmations: 5
  });
  ok('a callback for an unknown order is ignored, not an error',
    r.status === 200 && r.data.ignored === 'unknown order', JSON.stringify(r.data));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
