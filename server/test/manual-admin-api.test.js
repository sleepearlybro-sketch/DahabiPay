import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createAdminRouter } from '../routes/manual-admin.js';
import { clearRateLimits } from '../lib/rate-limit.js';

const requestRow = { id: 'request-1', status: 'completed' };
function appFor(role) {
  const calls = [];
  const store = {
    getRequest: async () => ({ request: requestRow, notes: [], events: [] }),
    transitionRequest: async (input) => { calls.push(input); return { ...requestRow, status: input.status }; },
    getSettings: async () => ({ rate: '1', min_usdt: '10', max_usdt: '100', accepting_requests: false, whatsapp_template: 'Hello {{name}}' }),
    updateSettings: async (values) => { calls.push(values); return values; }
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.staff = { staff: { user_id: 'staff-1', role, email: 'staff@example.com', display_name: 'Staff' }, session: {} }; next(); });
  app.use('/api/admin', createAdminRouter({ store }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  return { app, calls };
}
async function start(app) {
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
}
async function patch(origin, path, body) {
  const response = await fetch(origin + path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
test('operator cannot change settings or reopen a terminal request', async (t) => {
  clearRateLimits(); const { app, calls } = appFor('operator'); const { server, origin } = await start(app); t.after(() => server.close());
  assert.equal((await patch(origin, '/api/admin/settings', { rate: '1', minUsdt: '10', maxUsdt: '100', whatsappTemplate: 'Hello {{name}}' })).status, 403);
  assert.equal((await patch(origin, '/api/admin/requests/request-1/status', { status: 'contacted', reason: 'Customer requested reopen' })).status, 409);
  assert.equal(calls.length, 0);
});
test('admin can reopen a terminal request only with an audited reason', async (t) => {
  clearRateLimits(); const { app, calls } = appFor('admin'); const { server, origin } = await start(app); t.after(() => server.close());
  assert.equal((await patch(origin, '/api/admin/requests/request-1/status', { status: 'contacted', reason: 'no' })).status, 409);
  assert.equal((await patch(origin, '/api/admin/requests/request-1/status', { status: 'contacted', reason: 'Customer requested reopen' })).status, 200);
  assert.equal(calls[0].reason, 'Customer requested reopen');
});
