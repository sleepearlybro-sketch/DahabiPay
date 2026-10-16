import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createPublicRouter } from '../routes/manual-public.js';
import { createCustomerRouter } from '../routes/manual-customer.js';
import { clearRateLimits } from '../lib/rate-limit.js';

const customer = { id: 'user-1', email: 'ada@example.com' };
function fixture({ signedIn = false, accepting = true } = {}) {
  const created = []; const sessions = []; const authCalls = []; const listedFor = [];
  const store = {
    getSettings: async () => ({ rate: '0.98', min_usdt: '10', max_usdt: '1000', accepting_requests: accepting }),
    createRequest: async (input) => {
      created.push(input);
      return { id: 'r1', reference: input.reference, send_usdt: input.sendUsdt, rate: input.rate, receive_usd: input.receiveUsd };
    },
    createCustomerSession: async (input) => { sessions.push(input); return input; },
    listCustomerRequests: async (id) => { listedFor.push(id); return [{ reference: 'DP-TEST', status: 'verified' }]; }
  };
  const auth = { auth: {
    signInWithOtp: async (input) => { authCalls.push(input); return { error: null }; },
    verifyOtp: async ({ token }) => token === '12345678'
      ? { data: { user: { id: customer.id, email: customer.email } }, error: null }
      : { data: null, error: new Error('Invalid token') }
  } };
  const app = express(); app.set('trust proxy', false); app.use(express.json());
  if (signedIn) app.use((req, _res, next) => { req.customer = { customer, session: { token_hash: 'hash' } }; next(); });
  app.use('/api', createPublicRouter({ store, processOutbox: async () => {} }));
  app.use('/api/customer', createCustomerRouter({ store, auth: () => auth }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
  return { app, created, sessions, authCalls, listedFor };
}
async function start(app) {
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
async function post(origin, path, body) {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const details = { fullName: 'Ada Doe', email: customer.email, whatsapp: '+254712345678', moneygoAccount: 'MG-12345' };

test('email OTP creates a customer session but no exchange request', async (t) => {
  clearRateLimits(); const { app, created, sessions, authCalls } = fixture(); const { server, origin } = await start(app); t.after(() => server.close());
  assert.equal((await post(origin, '/api/customer/auth/otp', { email: 'ADA@example.com' })).status, 200);
  assert.equal(authCalls[0].options.shouldCreateUser, true);
  assert.equal((await post(origin, '/api/customer/auth/verify', { email: customer.email, otp: 'wrong' })).status, 400);
  const verified = await post(origin, '/api/customer/auth/verify', { email: customer.email, otp: '12345678' });
  assert.equal(verified.status, 200); assert.equal(sessions.length, 1); assert.equal(sessions[0].customerAuthId, customer.id);
  assert.equal(created.length, 0);
});

test('only a signed-in customer can submit their own email and signed quote', async (t) => {
  clearRateLimits(); const guest = fixture(); const live = fixture({ signedIn: true });
  const guestServer = await start(guest.app); const liveServer = await start(live.app);
  t.after(() => { guestServer.server.close(); liveServer.server.close(); });
  const quote = await post(liveServer.origin, '/api/public/quote', { amount: '100' });
  const order = { ...details, quoteToken: quote.body.quoteToken };
  assert.equal((await post(guestServer.origin, '/api/requests', order)).status, 401);
  assert.equal(guest.created.length, 0);
  assert.equal((await post(liveServer.origin, '/api/requests', { ...order, email: 'other@example.com' })).status, 403);
  assert.equal((await post(liveServer.origin, '/api/requests', { ...order, quoteToken: 'bad.quote' })).status, 409);
  assert.equal(live.created.length, 0);
  const submitted = await post(liveServer.origin, '/api/requests', order);
  assert.equal(submitted.status, 201); assert.match(submitted.body.reference, /^DP-/);
  assert.equal(live.created.length, 1); assert.equal(live.created[0].customerAuthId, customer.id);
});

test('disabled requests cannot be quoted or submitted', async (t) => {
  clearRateLimits(); const { app, created } = fixture({ signedIn: true, accepting: false }); const { server, origin } = await start(app); t.after(() => server.close());
  assert.equal((await post(origin, '/api/public/quote', { amount: '100' })).status, 503);
  assert.equal(created.length, 0);
});

test('public contact exposes only configured support channels', async (t) => {
  clearRateLimits(); const { app } = fixture(); const { server, origin } = await start(app); t.after(() => server.close());
  const response = await fetch(origin + '/api/public/contact');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { email: 'support@dahabipay.com', whatsapp: null });
});

test('request history is available only to its signed-in customer', async (t) => {
  clearRateLimits(); const guest = fixture(); const live = fixture({ signedIn: true });
  const guestServer = await start(guest.app); const liveServer = await start(live.app);
  t.after(() => { guestServer.server.close(); liveServer.server.close(); });
  assert.equal((await fetch(guestServer.origin + '/api/customer/requests')).status, 401);
  const response = await fetch(liveServer.origin + '/api/customer/requests');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).requests[0].reference, 'DP-TEST');
  assert.deepEqual(live.listedFor, [customer.id]);
});
