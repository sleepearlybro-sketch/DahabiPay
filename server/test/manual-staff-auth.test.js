import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { once } from 'node:events';
import { createAdminRouter } from '../routes/manual-admin.js';
import { clearRateLimits } from '../lib/rate-limit.js';

const baseStaff = { user_id: 'staff-one', email: 'staff@example.com', username: 'staffone', display_name: 'Staff One', role: 'admin', active: true, password_enabled: true };
function fixture({ role = 'admin', legacy = false, loggedIn = false } = {}) {
  const calls = { password: 0, otp: 0, verify: 0, created: 0, profile: 0, setup: 0 };
  const staff = { ...baseStaff, role, password_enabled: !legacy };
  const store = {
    findActiveStaffByIdentifier: async (id) => [staff.email, staff.username].includes(id) ? staff : null,
    createStaffSession: async () => ({}),
    listStaff: async () => [staff],
    createStaffProfile: async (profile) => { calls.profile++; return profile; },
    setStaffCredentials: async (_, username) => { calls.setup++; staff.username = username; staff.password_enabled = true; return staff; },
    auditStaff: async () => {},
    getSettings: async () => ({})
  };
  const auth = { auth: {
    signInWithPassword: async ({ password }) => { calls.password++; return password === 'CorrectPassword12' ? { data: { user: { id: staff.user_id } }, error: null } : { data: null, error: new Error('bad') }; },
    signInWithOtp: async () => { calls.otp++; return { error: null }; },
    verifyOtp: async ({ token }) => { calls.verify++; return token === '12345678' ? { data: { user: { id: staff.user_id } }, error: null } : { error: new Error('bad') }; }
  } };
  const adminAuth = { auth: { admin: {
    createUser: async () => { calls.created++; return { data: { user: { id: 'new-staff' } }, error: null }; },
    deleteUser: async () => ({ error: null }),
    updateUserById: async () => ({ error: null })
  } } };
  const app = express(); app.use(express.json()); app.use(cookieParser());
  if (loggedIn) app.use((req, _res, next) => { req.staff = { staff, session: { token_hash: 'token' } }; next(); });
  app.use('/api/admin', createAdminRouter({ store, auth: () => auth, adminAuth: () => adminAuth }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  return { app, calls };
}
async function start(app) {
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
async function post(origin, path, body, cookie) {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('password is required before a staff OTP and challenge binds verification', async (t) => {
  clearRateLimits(); const { app, calls } = fixture(); const { server, origin } = await start(app); t.after(() => server.close());
  assert.equal((await post(origin, '/api/admin/auth/otp', { identifier: 'staffone', password: 'wrong' })).status, 401);
  assert.equal(calls.otp, 0);
  const requested = await post(origin, '/api/admin/auth/otp', { identifier: 'staffone', password: 'CorrectPassword12' });
  assert.equal(requested.status, 200); assert.equal(calls.otp, 1);
  assert.equal((await post(origin, '/api/admin/auth/verify', { identifier: 'staffone', otp: '12345678' })).status, 400);
  const verified = await post(origin, '/api/admin/auth/verify', { identifier: 'staffone', otp: '12345678' }, requested.cookie);
  assert.equal(verified.status, 200); assert.equal(verified.body.staff.username, 'staffone');
});

test('legacy staff must set credentials before reaching admin routes', async (t) => {
  clearRateLimits(); const { app, calls } = fixture({ legacy: true, loggedIn: true }); const { server, origin } = await start(app); t.after(() => server.close());
  assert.equal((await fetch(origin + '/api/admin/dashboard')).status, 428);
  const setup = await post(origin, '/api/admin/auth/setup', { username: 'owner', password: 'CorrectPassword12' });
  assert.equal(setup.status, 200); assert.equal(calls.setup, 1);
  assert.equal(setup.body.staff.passwordEnabled, true);
});

test('only admin creates staff accounts', async (t) => {
  clearRateLimits(); const operator = fixture({ role: 'operator', loggedIn: true }); const admin = fixture({ loggedIn: true });
  const a = await start(operator.app); const b = await start(admin.app); t.after(() => { a.server.close(); b.server.close(); });
  const input = { username: 'secondadmin', email: 'second@example.com', displayName: 'Second Admin', role: 'admin', password: 'CorrectPassword12' };
  assert.equal((await post(a.origin, '/api/admin/staff', input)).status, 403); assert.equal(operator.calls.created, 0);
  const created = await post(b.origin, '/api/admin/staff', input);
  assert.equal(created.status, 201); assert.equal(admin.calls.created, 1); assert.equal(admin.calls.profile, 1);
  assert.equal(created.body.staff.password, undefined);
});
