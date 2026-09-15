/* Isolated database per test file: node:test runs each file in its own
   process, so setting DB_FILE before importing db.js is enough. */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `ep-test-orders-${process.pid}.db`);
process.env.DB_FILE = tmp;
process.env.QUOTE_LOCK_MINUTES = '20';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('../db.js');
const M = await import('../lib/money.js');
const O = await import('../lib/orders.js');

before(async () => {
  await db.migrate();
  await db.run(
    `INSERT INTO currencies (id,name,net,code,grp,color,pivot_usd,pivot_source,reserve,reserved,
       deposit_addr,min_amt,max_amt,fee_bp,field_label,enabled,manual,sort_order,updated_at)
     VALUES ('src','Source','','SRC','crypto','#000','100','manual','1000','0','ADDR','1','500',120,'addr',1,0,1,?)`,
    db.now()
  );
  await db.run(
    `INSERT INTO currencies (id,name,net,code,grp,color,pivot_usd,pivot_source,reserve,reserved,
       min_amt,max_amt,fee_bp,field_label,enabled,manual,sort_order,updated_at)
     VALUES ('dst','Dest','','DST','mobile','#111','1','manual','10000','0','1','100000',0,'phone',1,0,2,?)`,
    db.now()
  );
  await db.run("INSERT INTO direction_rules (from_grp,to_grp,enabled) VALUES ('crypto','mobile',1)");
});

after(async () => {
  await db.close();
  try { fs.rmSync(tmp, { force: true }); fs.rmSync(tmp + '-wal', { force: true }); fs.rmSync(tmp + '-shm', { force: true }); }
  catch { /* windows may still hold a handle */ }
});

const mkOrder = (amount = '1') => O.create({
  fromId: 'src', toId: 'dst', amount, side: 'send',
  requisite: '254712345678', email: 'x@example.com'
});

/* ------------------------------------------------------------ transitions */
test('the transition map rejects every illegal move', () => {
  const all = Object.values(O.STATES);
  const legal = new Set([
    'created>awaiting_payment', 'created>cancelled', 'created>on_hold',
    'awaiting_payment>payment_detected', 'awaiting_payment>expired',
    'awaiting_payment>cancelled', 'awaiting_payment>on_hold',
    'payment_detected>processing', 'payment_detected>on_hold', 'payment_detected>cancelled',
    'processing>completed', 'processing>on_hold',
    'on_hold>awaiting_payment', 'on_hold>payment_detected', 'on_hold>processing',
    'on_hold>refunded', 'on_hold>cancelled',
    'expired>awaiting_payment', 'expired>refunded', 'expired>cancelled'
  ]);

  for (const from of all) {
    for (const to of all) {
      const key = `${from}>${to}`;
      assert.equal(O.canTransition(from, to), legal.has(key), `${key} should be ${legal.has(key)}`);
    }
  }
});

test('terminal states admit nothing', () => {
  for (const s of ['completed', 'cancelled', 'refunded']) {
    assert.ok(O.isTerminal(s));
    for (const to of Object.values(O.STATES)) {
      assert.equal(O.canTransition(s, to), false, `${s} must not move to ${to}`);
    }
  }
});

test('an illegal transition throws rather than writing', async () => {
  const { id } = await mkOrder();
  await assert.rejects(O.transition(id, O.STATES.COMPLETED, 'test'), /Cannot move an order/);
  assert.equal((await db.get('SELECT status FROM orders WHERE id = ?', id)).status, O.STATES.CREATED);
});

test('a same-state write is refused', async () => {
  const { id } = await mkOrder();
  await assert.rejects(O.transition(id, O.STATES.CREATED, 'test'), /already/);
});

/* --------------------------------------------------------------- pricing */
test('the order stores the rate it was quoted at, not the client figure', async () => {
  const created = await O.create({
    fromId: 'src', toId: 'dst', amount: '2', side: 'send',
    requisite: '254700000000', email: 'x@example.com',
    // a client trying to claim a better rate has no field to do it with -
    // create() takes no rate argument at all
    recv: '999999'
  });
  const row = await db.get('SELECT * FROM orders WHERE id = ?', created.id);
  // 2 SRC at $100 less 1.2% = $197.6, dst pivot $1
  assert.equal(M.str(row.recv_amount), '197.6');
  assert.equal(M.str(row.rate), '98.8');
});

test('quote refuses a closed direction and a stale pivot', async () => {
  const src = await O.currency('src');
  const dst = await O.currency('dst');

  assert.match((await O.quote({ from: src, to: src, amount: '1' })).errors[0], /closed/);

  await db.run("UPDATE currencies SET pivot_source='feed', feed_symbol='NOPE' WHERE id='src'");
  assert.match((await O.quote({ from: await O.currency('src'), to: dst, amount: '1' })).errors[0], /temporarily unavailable/);
  await db.run("UPDATE currencies SET pivot_source='manual', feed_symbol=NULL WHERE id='src'");
});

/* ------------------------------------------------------- reserve holding */
test('creating an order commits receiving liquidity', async () => {
  const before = await O.currency('dst');
  const { id, recv } = await mkOrder('1');
  const after = await O.currency('dst');

  assert.equal(M.str(after.reserved), M.str(M.add(before.reserved, recv)));
  assert.equal(M.str(after.reserve), M.str(before.reserve), 'reserve itself must not move yet');
  assert.equal((await db.get('SELECT reserve_held FROM orders WHERE id = ?', id)).reserve_held, 1);
});

test('completion spends the hold; cancellation only releases it', async () => {
  const start = await O.currency('dst');

  const a = await mkOrder('1');
  await O.transition(a.id, O.STATES.AWAITING, 'test');
  await O.transition(a.id, O.STATES.DETECTED, 'test');
  await O.transition(a.id, O.STATES.PROCESSING, 'test');
  await O.transition(a.id, O.STATES.COMPLETED, 'test');

  const afterComplete = await O.currency('dst');
  assert.equal(M.str(afterComplete.reserved), M.str(start.reserved), 'hold released');
  assert.equal(M.str(afterComplete.reserve), M.str(M.sub(start.reserve, a.recv)), 'reserve spent');

  const b = await mkOrder('1');
  await O.transition(b.id, O.STATES.CANCELLED, 'test');
  const afterCancel = await O.currency('dst');
  assert.equal(M.str(afterCancel.reserved), M.str(afterComplete.reserved), 'hold released');
  assert.equal(M.str(afterCancel.reserve), M.str(afterComplete.reserve), 'reserve untouched');
});

test('the hold is released exactly once, even on a second exit', async () => {
  const c = await mkOrder('1');
  const before = await O.currency('dst');
  await O.transition(c.id, O.STATES.CANCELLED, 'test');
  const once = await O.currency('dst');
  assert.equal(M.str(once.reserved), M.str(M.sub(before.reserved, c.recv)));

  // cancelled is terminal, so a repeat is refused and cannot double-release
  await assert.rejects(O.transition(c.id, O.STATES.REFUNDED, 'test'), /Cannot move/);
  assert.equal(M.str((await O.currency('dst')).reserved), M.str(once.reserved));
});

/* -------------------------------------------------- reserve oversell (req 1)
   The check that matters: liquidity for two orders, five attempts.        */
test('concurrent orders cannot oversell the reserve', async () => {
  await db.run("UPDATE currencies SET reserve='200', reserved='0' WHERE id='dst'");
  // each order of 1 SRC receives 98.8 DST, so 200 fits exactly two
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => mkOrder('1')));
  const results = attempts.map((result) => result.status === 'fulfilled'
    ? { ok: true, order: result.value }
    : { ok: false, error: result.reason.message });

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  assert.equal(ok.length, 2, 'exactly two orders should be accepted');
  assert.equal(failed.length, 3);
  for (const f of failed) assert.match(f.error, /Reserve is only/);

  const dst = await O.currency('dst');
  assert.equal(M.str(dst.reserved), '197.6', 'reserved equals the two accepted orders');
  assert.ok(M.lte(dst.reserved, dst.reserve), 'committed liquidity never exceeds the reserve');
});

/* --------------------------------------------------------- lock expiry */
test('an elapsed lock expires the order and frees its hold', async () => {
  await db.run("UPDATE currencies SET reserve='10000', reserved='0' WHERE id='dst'");
  const { id, recv } = await mkOrder('1');
  await O.transition(id, O.STATES.AWAITING, 'test');

  const held = await O.currency('dst');
  assert.equal(M.str(held.reserved), M.str(recv));

  await db.run('UPDATE orders SET lock_expires_at = ? WHERE id = ?',
    new Date(Date.now() - 1000).toISOString(), id);

  assert.equal(await O.expireStale(), 1);
  assert.equal((await db.get('SELECT status FROM orders WHERE id = ?', id)).status, O.STATES.EXPIRED);
  assert.equal(M.str((await O.currency('dst')).reserved), '0', 'hold released on expiry');
});

test('a live lock is left alone by the sweep', async () => {
  await db.run("UPDATE currencies SET reserve='10000', reserved='0' WHERE id='dst'");
  const { id } = await mkOrder('1');
  await O.transition(id, O.STATES.AWAITING, 'test');
  assert.equal(await O.expireStale(), 0);
  assert.equal((await db.get('SELECT status FROM orders WHERE id = ?', id)).status, O.STATES.AWAITING);
});

test('re-quoting an expired order re-prices it and takes a fresh hold', async () => {
  await db.run("UPDATE currencies SET reserve='10000', reserved='0' WHERE id='dst'");
  const { id } = await mkOrder('1');
  await O.transition(id, O.STATES.AWAITING, 'test');
  await db.run('UPDATE orders SET lock_expires_at = ? WHERE id = ?',
    new Date(Date.now() - 1000).toISOString(), id);
  await O.expireStale();
  assert.equal(M.str((await O.currency('dst')).reserved), '0');

  // move the market, then re-quote
  await db.run("UPDATE currencies SET pivot_usd='50' WHERE id='src'");
  const re = await O.requote(id, 'test');

  assert.equal(re.status, O.STATES.AWAITING);
  assert.equal(M.str(re.recv_amount), '49.4', 'repriced at the new pivot');
  assert.ok(re.rate_reaccepted_at, 'records that the customer accepted a new rate');
  assert.equal(M.str((await O.currency('dst')).reserved), '49.4', 'fresh hold taken');

  await db.run("UPDATE currencies SET pivot_usd='100' WHERE id='src'");
});

/* ------------------------------------------------- payout idempotency (req 5) */
test('a payout can only be claimed once', async () => {
  await db.run("UPDATE currencies SET reserve='10000', reserved='0' WHERE id='dst'");
  const { id } = await mkOrder('1');

  assert.equal(await O.payoutClaimed(id), false);
  assert.equal(await O.claimPayout(id, 'manual', 'ref-1'), true, 'first claim wins');
  assert.equal(await O.claimPayout(id, 'manual', 'ref-2'), false, 'second claim is refused');
  assert.equal(await O.claimPayout(id, 'manual', 'ref-3'), false, 'and stays refused');
  assert.equal(await O.payoutClaimed(id), true);

  assert.equal(await db.val('SELECT COUNT(*) FROM payout_locks WHERE order_id = ?', id), 1);
  assert.equal((await db.get('SELECT ref FROM payout_locks WHERE order_id = ?', id)).ref, 'ref-1');
});

/* ----------------------------------------------------------- audit trail */
test('every status change is recorded in order_events', async () => {
  await db.run("UPDATE currencies SET reserve='10000', reserved='0' WHERE id='dst'");
  const { id } = await mkOrder('1');
  await O.transition(id, O.STATES.AWAITING, 'system');
  await O.transition(id, O.STATES.DETECTED, 'customer');
  await O.transition(id, O.STATES.ON_HOLD, 'operator:alice', { detail: 'checking source of funds' });

  const ev = await O.events(id);
  assert.deepEqual(ev.map((e) => e.to_status),
    ['created', 'awaiting_payment', 'payment_detected', 'on_hold']);
  assert.equal(ev.at(-1).actor, 'operator:alice');
  assert.equal(ev.at(-1).detail, 'checking source of funds');
  assert.equal(ev.at(-1).from_status, 'payment_detected');
});

test('patch cannot write an arbitrary column', async () => {
  const { id } = await mkOrder('1');
  await assert.rejects(
    O.transition(id, O.STATES.AWAITING, 'test', { patch: { send_amount: '999999' } }),
    /Field not writable/
  );
  assert.equal(M.str((await db.get('SELECT send_amount FROM orders WHERE id = ?', id)).send_amount), '1');
});

test('a bad requisite is rejected against the currency pattern', async () => {
  await db.run("UPDATE currencies SET field_regex='^254[17]\\d{8}$' WHERE id='dst'");
  await assert.rejects(
    O.create({ fromId: 'src', toId: 'dst', amount: '1', requisite: 'not-a-phone', email: 'x@example.com' }),
    /does not look like a valid/
  );
  await db.run("UPDATE currencies SET field_regex=NULL WHERE id='dst'");
});
