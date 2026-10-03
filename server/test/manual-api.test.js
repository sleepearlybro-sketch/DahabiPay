import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createPublicRouter } from '../routes/manual-public.js';
import { clearRateLimits } from '../lib/rate-limit.js';

function fixture({ otpError = null } = {}) {
  const created = [];
  const fakeStore = {
    getSettings: async () => ({ rate: '0.98', min_usdt: '10', max_usdt: '1000', accepting_requests: true }),
    createRequest: async (input) => {
      created.push(input);
      return { id: 'r1', reference: input.reference, send_usdt: input.sendUsdt, rate: input.rate, receive_usd: input.receiveUsd };
    }
  };
  const fakeAuth = { auth: {
    signInWithOtp: async () => ({ data: {}, error: null }),
    verifyOtp: async ({ email, token }) => otpError || token !== '12345678'
      ? { data: {}, error: { message: 'bad code' } }
      : { data: { user: { id: 'user-1', email } }, error: null }
  } };
  const app = express();
  app.set('trust proxy', false);
  app.use(express.json());
  app.use('/api', createPublicRouter({ store: fakeStore, auth: () => fakeAuth, processOutbox: async () => ({}) }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, field: error.field, code: error.code }));
  return { app, created };
}
async function start(app) {
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
}
async function post(origin, path, body) {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
test('request is created only after a valid OTP and signed quote', async (t) => {
  clearRateLimits(); const { app, created } = fixture(); const { server, origin } = await start(app); t.after(() => server.close());
  const quote = await post(origin, '/api/public/quote', { amount: '100' });
  const contact = { fullName: 'Ada Doe', email: 'ada@example.com', whatsapp: '+254712345678', moneygoAccount: 'MG-12345', quoteToken: quote.body.quoteToken };
  assert.equal((await post(origin, '/api/requests/otp', contact)).status, 200);
  assert.equal(created.length, 0);
  assert.equal((await post(origin, '/api/requests/verify', { ...contact, otp: '123456' })).status, 400);
  assert.equal((await post(origin, '/api/requests/verify', { ...contact, otp: '00000000' })).status, 400);
  assert.equal(created.length, 0);
  const verified = await post(origin, '/api/requests/verify', { ...contact, otp: '12345678' });
  assert.equal(verified.status, 201); assert.match(verified.body.reference, /^DP-/); assert.equal(created.length, 1);
});
test('tampered and expired-style invalid quotes never reach OTP provider', async (t) => {
  clearRateLimits(); const { app, created } = fixture(); const { server, origin } = await start(app); t.after(() => server.close());
  const result = await post(origin, '/api/requests/verify', { fullName: 'Ada Doe', email: 'ada@example.com', whatsapp: '+254712345678', moneygoAccount: 'MG-12345', quoteToken: 'bad.quote', otp: '12345678' });
  assert.equal(result.status, 409); assert.equal(created.length, 0);
});
test('customer OTP requests are rate limited by email', async (t) => {
  clearRateLimits(); const { app } = fixture(); const { server, origin } = await start(app); t.after(() => server.close());
  const quote = await post(origin, '/api/public/quote', { amount: '100' });
  const contact = { fullName: 'Ada Doe', email: 'rate@example.com', whatsapp: '+254712345678', moneygoAccount: 'MG-12345', quoteToken: quote.body.quoteToken };
  for (let i = 0; i < 4; i += 1) assert.equal((await post(origin, '/api/requests/otp', contact)).status, 200);
  assert.equal((await post(origin, '/api/requests/otp', contact)).status, 429);
});
