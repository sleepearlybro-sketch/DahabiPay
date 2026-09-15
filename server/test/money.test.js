import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../lib/money.js';

test('parses and round-trips decimal strings', () => {
  for (const s of ['0', '1', '1.5', '0.00000001', '63500', '4200000', '0.000268', '123456789.123456789']) {
    assert.equal(M.str(s), s, `round-trip ${s}`);
  }
});

test('accepts the shapes that actually arrive from the database and the wire', () => {
  assert.equal(M.str('1 000.5'), '1000.5');      // thousands space from a form
  assert.equal(M.str('1,5'), '1.5');             // comma decimal separator
  assert.equal(M.str(''), '0');
  assert.equal(M.str('.'), '0');
  assert.equal(M.str('.5'), '0.5');
  assert.equal(M.str('5.'), '5');
  assert.equal(M.str(2480), '2480');             // number, not string
  assert.equal(M.str(M.dec('7')), '7');          // already-scaled BigInt
});

test('rejects anything that is not a decimal', () => {
  for (const bad of ['abc', '1e5', '1.2.3', '--1', '0x10']) {
    assert.throws(() => M.dec(bad), /not a decimal/, `should reject ${bad}`);
  }
});

test('does not drift the way floats do', () => {
  // 0.1 + 0.2 === 0.30000000000000004 in binary floating point
  assert.equal(M.str(M.add('0.1', '0.2')), '0.3');
  let acc = M.dec('0');
  for (let i = 0; i < 1000; i++) acc = M.add(acc, '0.001');
  assert.equal(M.str(acc), '1');
});

test('arithmetic', () => {
  assert.equal(M.str(M.sub('10', '3.5')), '6.5');
  assert.equal(M.str(M.mul('1.5', '4')), '6');
  assert.equal(M.str(M.div('1', '8')), '0.125');
  assert.equal(M.str(M.sub('3', '5')), '-2');
  assert.throws(() => M.div('1', '0'), /division by zero/);
});

test('comparisons', () => {
  assert.equal(M.cmp('1.10', '1.1'), 0);
  assert.ok(M.gt('2', '1.999999'));
  assert.ok(M.lt('0.0000001', '0.000001'));
  assert.ok(M.gte('5', '5'));
  assert.ok(M.isZero('0.000000000000000000'));
  assert.ok(!M.isPos('0'));
  assert.ok(M.isPos('0.00000000000000001'));
});

test('basis points', () => {
  assert.equal(M.str(M.bpOf('100', 120)), '1.2');        // 1.2%
  assert.equal(M.str(M.lessBp('100', 120)), '98.8');
  assert.equal(M.str(M.lessBp('100', 0)), '100');
  assert.equal(M.str(M.bpOf('1000', 10000)), '1000');    // 100%
});

test('rounds half-up at the requested precision', () => {
  assert.equal(M.str('1.005', 2), '1.01');
  assert.equal(M.str('1.004', 2), '1');                  // trailing zeros trimmed
  assert.equal(M.str('2.675', 2), '2.68');               // the classic float failure
  assert.equal(M.str('0.5', 0), '1');
  assert.equal(M.str('0.4', 0), '0');
  assert.equal(M.str('-1.005', 2), '-1.01');
  assert.equal(M.str('12345.6789', 2), '12345.68');
});

test('cross rate puts the fee on the sending leg', () => {
  // 1 USDT at $1, 1 KES at $0.00775, 1.8% fee
  const r = M.crossRate('1', '0.00775', 180);
  // (1 * 0.982) / 0.00775
  assert.equal(M.str(r, 6), '126.709677');

  // with no fee the rate is the plain pivot ratio
  assert.equal(M.str(M.crossRate('1', '0.00775', 0), 6), '129.032258');

  // a fee always reduces what the customer receives
  assert.ok(M.lt(M.crossRate('1', '0.00775', 180), M.crossRate('1', '0.00775', 0)));
});

test('cross rate is consistent in both directions', () => {
  // with zero fee, converting out and back must return the original amount
  const fwd = M.crossRate('63500', '1', 0);
  const back = M.crossRate('1', '63500', 0);
  const amount = '0.05';
  const there = M.mul(amount, fwd);
  const andBack = M.mul(there, back);
  assert.equal(M.str(andBack, 8), M.str(amount, 8));
});

test('a realistic order prices exactly', () => {
  // 0.05 BTC -> KES at BTC $63500, KES $0.00775, 1.2% fee
  const rate = M.crossRate('63500', '0.00775', 120);
  const recv = M.mul('0.05', rate);
  // 63500 * 0.988 = 62738; / 0.00775 = 8095225.806451612903...
  assert.equal(M.str(rate, 6), '8095225.806452');
  assert.equal(M.str(recv, 2), '404761.29');
});
