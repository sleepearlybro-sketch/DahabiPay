import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateReceive, canTransition, createQuote, normalizeAmount, normalizeWhatsapp, validateContact, verifyQuote } from '../lib/manual.js';

test('USDT accepts at most six decimal places and must be positive', () => {
  assert.equal(normalizeAmount('12.340000'), '12.34');
  assert.throws(() => normalizeAmount('1.1234567'), /up to 6 decimals/);
  assert.throws(() => normalizeAmount('0'), /greater than zero/);
});
test('Money Go USD is rounded half-up to two decimals', () => {
  assert.equal(calculateReceive('10.123456', '0.98765432'), '10');
  assert.equal(calculateReceive('1', '1.005'), '1.01');
});
test('WhatsApp is normalized to E.164', () => {
  assert.equal(normalizeWhatsapp('00 254 712 345 678'), '+254712345678');
  assert.throws(() => normalizeWhatsapp('0712345678'), /country code/);
});
test('contact fields are normalized and constrained', () => {
  const value = validateContact({ fullName: ' Ada Doe ', email: 'ADA@EXAMPLE.COM ', whatsapp: '+254 712 345 678', moneygoAccount: '  MG-12345 ', note: ' hi ' });
  assert.deepEqual(value, { fullName: 'Ada Doe', email: 'ada@example.com', whatsapp: '+254712345678', moneygoAccount: 'MG-12345', note: 'hi' });
});
test('signed quotes preserve rate and expire', () => {
  const secret = 'a-long-test-secret';
  const quote = createQuote({ amount: '100', rate: '0.98', minAmount: '10', maxAmount: '500', secret, now: 1_000, ttlMinutes: 15 });
  assert.equal(verifyQuote(quote.token, secret, 2_000).receive, '98');
  assert.throws(() => verifyQuote(quote.token + 'x', secret, 2_000), /invalid/);
  assert.throws(() => verifyQuote(quote.token, secret, 901_001), /expired/);
});
test('quotes enforce configured limits', () => {
  const args = { rate: '1', minAmount: '10', maxAmount: '100', secret: 'secret' };
  assert.throws(() => createQuote({ ...args, amount: '9.99' }), /Minimum/);
  assert.throws(() => createQuote({ ...args, amount: '100.01' }), /Maximum/);
});
test('request status transitions enforce role and audited reopen reason', () => {
  assert.equal(canTransition('verified', 'contacted', 'operator'), true);
  assert.equal(canTransition('in_progress', 'completed', 'operator'), true);
  assert.equal(canTransition('completed', 'contacted', 'operator', 'correction'), false);
  assert.equal(canTransition('completed', 'contacted', 'admin', 'no'), false);
  assert.equal(canTransition('completed', 'contacted', 'admin', 'Customer asked to reopen'), true);
});
