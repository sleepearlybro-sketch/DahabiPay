import express from 'express';
import { config } from '../config.js';
import { supabaseAdmin, supabaseAuth } from '../supabase.js';
import * as store from '../store.js';
import { canTransition, cleanText, normalizeAmount, normalizeEmail, normalizeWhatsapp, sessionToken } from '../lib/manual.js';
import { clientIp, rateLimit } from '../lib/rate-limit.js';
import { clearStaffCookie, requireAdmin, requireStaff, setStaffCookie } from '../lib/staff.js';
import { connectEvents, publishEvent } from '../events.js';
import { clearStaffChallenge, getStaffChallenge, setStaffChallenge } from '../lib/staff-challenge.js';

export function createAdminRouter(deps = {}) {
  const router = express.Router();
  const data = deps.store || store;
  const auth = deps.auth || (() => supabaseAuth());
  const adminAuth = deps.adminAuth || (() => supabaseAdmin());

  router.post('/auth/otp', rateLimit({ name: 'staff-otp', limit: 6, windowMs: 60 * 60_000 }), async (req, res, next) => {
    try {
      const identifier = normalizeIdentifier(req.body.identifier ?? req.body.email);
      const staff = await data.findActiveStaffByIdentifier(identifier);
      if (staff) {
        if (staff.password_enabled) {
          const password = String(req.body.password || '');
          if (!password || password.length > 200) return res.status(401).json({ error: 'Invalid username/email or password' });
          const login = await auth().auth.signInWithPassword({ email: staff.email, password });
          if (login.error || login.data?.user?.id !== staff.user_id) return res.status(401).json({ error: 'Invalid username/email or password' });
        }
        const result = await auth().auth.signInWithOtp({ email: staff.email, options: { shouldCreateUser: false } });
        if (result.error) throw Object.assign(new Error('Unable to send the sign-in code'), { status: 502 });
        setStaffChallenge(res, staff);
      }
      res.json({ ok: true, message: 'If this is an active staff account, a sign-in code has been sent.', resendAfterSeconds: 60 });
    } catch (error) { next(error); }
  });

  router.post('/auth/verify', rateLimit({ name: 'staff-verify', limit: 12, windowMs: 60 * 60_000 }), async (req, res, next) => {
    try {
      const identifier = normalizeIdentifier(req.body.identifier ?? req.body.email);
      const otp = String(req.body.otp || '').trim();
      if (!/^\d{8}$/.test(otp)) return res.status(400).json({ error: 'Enter the eight-digit code', field: 'otp' });
      const staff = await data.findActiveStaffByIdentifier(identifier);
      if (!staff || getStaffChallenge(req) !== staff.user_id) return res.status(400).json({ error: 'Start sign-in again to get a new code' });
      const verified = await auth().auth.verifyOtp({ email: staff.email, token: otp, type: 'email' });
      if (verified.error || verified.data?.user?.id !== staff.user_id) return res.status(400).json({ error: 'The code is incorrect or expired', field: 'otp' });
      clearStaffChallenge(res);
      const token = sessionToken();
      const expiresAt = new Date(Date.now() + config.staffSession.hours * 60 * 60_000).toISOString();
      await data.createStaffSession({ tokenHash: token.hash, staffUserId: staff.user_id, expiresAt, ip: clientIp(req), userAgent: String(req.get('user-agent') || '').slice(0, 500) });
      setStaffCookie(res, token.raw, expiresAt);
      res.json({ staff: publicStaff(staff) });
    } catch (error) { next(error); }
  });

  router.post('/auth/logout', async (req, res, next) => {
    try {
      if (req.staff) await data.deleteStaffSession(req.staff.session.token_hash);
      clearStaffCookie(res);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
  router.get('/me', requireStaff, (req, res) => res.json({ staff: publicStaff(req.staff.staff) }));
  router.get('/auth/setup-state', (req, res) => {
    if (!req.staff) return res.status(401).json({ error: 'Staff sign-in required' });
    res.json({ staff: publicStaff(req.staff.staff) });
  });
  router.post('/auth/setup', async (req, res, next) => {
    try {
      if (!req.staff) return res.status(401).json({ error: 'Staff sign-in required' });
      if (req.staff.staff.password_enabled) return res.status(409).json({ error: 'Credentials are already configured' });
      const username = normalizeUsername(req.body.username);
      const password = validPassword(req.body.password);
      const changed = await adminAuth().auth.admin.updateUserById(req.staff.staff.user_id, { password });
      if (changed.error) throw Object.assign(new Error('Unable to set password'), { status: 502 });
      const staff = await data.setStaffCredentials(req.staff.staff.user_id, username);
      await data.auditStaff(staff.user_id, 'staff.credentials_enabled', staff.user_id);
      res.json({ staff: publicStaff(staff) });
    } catch (error) { next(error); }
  });
  router.get('/staff', requireAdmin, async (_req, res, next) => {
    try { res.json({ staff: (await data.listStaff()).map(publicStaff) }); } catch (error) { next(error); }
  });
  router.post('/staff', requireAdmin, async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body.email);
      const username = normalizeUsername(req.body.username);
      const displayName = cleanText(req.body.displayName, 'displayName', { min: 2, max: 120 });
      const role = req.body.role;
      if (!['admin', 'operator'].includes(role)) return res.status(400).json({ error: 'Choose an administrator or operator role' });
      const password = validPassword(req.body.password);
      const created = await adminAuth().auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error || !created.data?.user?.id) return res.status(409).json({ error: 'Unable to create account. Check whether the email already exists.' });
      let staff;
      try {
        staff = await data.createStaffProfile({ user_id: created.data.user.id, email, username, display_name: displayName, role, active: true, password_enabled: true });
      } catch (error) {
        await adminAuth().auth.admin.deleteUser(created.data.user.id).catch(() => {});
        throw error;
      }
      await data.auditStaff(req.staff.staff.user_id, 'staff.created', staff.user_id);
      res.status(201).json({ staff: publicStaff(staff) });
    } catch (error) { next(error); }
  });
  router.patch('/staff/:id', requireAdmin, async (req, res, next) => {
    try {
      if (req.params.id === req.staff.staff.user_id) return res.status(400).json({ error: 'You cannot change your own access here' });
      if (typeof req.body.active !== 'boolean') return res.status(400).json({ error: 'Active must be true or false' });
      const target = (await data.listStaff()).find((person) => person.user_id === req.params.id);
      if (!target) return res.status(404).json({ error: 'Staff account not found' });
      if (!req.body.active && target.role === 'admin' && target.active && (await data.listStaff()).filter((person) => person.role === 'admin' && person.active).length <= 1) return res.status(409).json({ error: 'At least one active administrator is required' });
      const staff = await data.setStaffActive(req.params.id, req.body.active);
      if (!staff.active) await data.revokeStaffSessions(staff.user_id);
      await data.auditStaff(req.staff.staff.user_id, staff.active ? 'staff.activated' : 'staff.deactivated', staff.user_id);
      res.json({ staff: publicStaff(staff) });
    } catch (error) { next(error); }
  });
  router.get('/dashboard', requireStaff, async (_req, res, next) => {
    try { res.json(await data.dashboard()); } catch (error) { next(error); }
  });
  router.get('/requests', requireStaff, async (req, res, next) => {
    try {
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
      const status = String(req.query.status || '');
      if (status && !['verified', 'contacted', 'in_progress', 'completed', 'cancelled'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status filter' });
      }
      const isoDate = /^\d{4}-\d{2}-\d{2}$/;
      if ((req.query.from && !isoDate.test(req.query.from)) || (req.query.to && !isoDate.test(req.query.to))) {
        return res.status(400).json({ error: 'Invalid date filter' });
      }
      res.json(await data.listRequests({ status, query: req.query.q, from: req.query.from, to: req.query.to, page, limit }));
    } catch (error) { next(error); }
  });
  router.get('/requests/:id', requireStaff, async (req, res, next) => {
    try {
      const detail = await data.getRequest(req.params.id);
      if (!detail) return res.status(404).json({ error: 'Request not found' });
      res.json(detail);
    } catch (error) { next(error); }
  });
  router.patch('/requests/:id/status', requireStaff, async (req, res, next) => {
    try {
      const detail = await data.getRequest(req.params.id);
      if (!detail) return res.status(404).json({ error: 'Request not found' });
      const status = String(req.body.status || '');
      const reason = String(req.body.reason || '').trim();
      if (!canTransition(detail.request.status, status, req.staff.staff.role, reason)) return res.status(409).json({ error: 'That status change is not allowed' });
      const updated = await data.transitionRequest({ requestId: req.params.id, staffUserId: req.staff.staff.user_id, status, reason });
      publishEvent('request.updated', { id: req.params.id, status });
      res.json({ request: updated });
    } catch (error) { next(error); }
  });
  router.post('/requests/:id/notes', requireStaff, async (req, res, next) => {
    try {
      const body = cleanText(req.body.body, 'note', { min: 1, max: 2000 });
      const note = await data.addNote({ requestId: req.params.id, staffUserId: req.staff.staff.user_id, body });
      publishEvent('request.updated', { id: req.params.id, note: true });
      res.status(201).json({ note });
    } catch (error) { next(error); }
  });
  router.get('/settings', requireStaff, async (_req, res, next) => {
    try { res.json({ settings: await data.getSettings() }); } catch (error) { next(error); }
  });
  router.patch('/settings', requireAdmin, async (req, res, next) => {
    try {
      const rate = normalizePositive(req.body.rate, 'rate', 8);
      const minUsdt = normalizeAmount(req.body.minUsdt);
      const maxUsdt = normalizeAmount(req.body.maxUsdt);
      if (Number(maxUsdt) < Number(minUsdt)) return res.status(400).json({ error: 'Maximum must be greater than or equal to minimum', field: 'maxUsdt' });
      const operationsEmail = req.body.operationsEmail ? normalizeEmail(req.body.operationsEmail) : '';
      const supportEmail = normalizeEmail(req.body.supportEmail);
      const supportWhatsapp = req.body.supportWhatsapp ? normalizeWhatsapp(req.body.supportWhatsapp) : null;
      const whatsappTemplate = cleanText(req.body.whatsappTemplate, 'whatsappTemplate', { min: 5, max: 1000 });
      const settings = await data.updateSettings({ rate, minUsdt, maxUsdt, acceptingRequests: Boolean(req.body.acceptingRequests), operationsEmail, supportEmail, supportWhatsapp, whatsappTemplate }, req.staff.staff);
      publishEvent('settings.updated', { acceptingRequests: settings.accepting_requests });
      res.json({ settings });
    } catch (error) { next(error); }
  });
  router.get('/events', requireStaff, connectEvents);
  return router;
}

function publicStaff(staff) {
  return { id: staff.user_id, email: staff.email, username: staff.username, displayName: staff.display_name, role: staff.role, active: staff.active, passwordEnabled: staff.password_enabled };
}
function normalizeIdentifier(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw.includes('@') ? normalizeEmail(raw) : normalizeUsername(raw);
}
function normalizeUsername(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,31}$/.test(raw)) throw Object.assign(new Error('Username must be 3–32 letters, digits or underscores and start with a letter'), { status: 400 });
  return raw;
}
function validPassword(value) {
  const password = String(value || '');
  if (password.length < 12 || password.length > 128 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) throw Object.assign(new Error('Password must be 12–128 characters with uppercase, lowercase and a number'), { status: 400 });
  return password;
}
function normalizePositive(value, field, decimals) {
  const raw = String(value ?? '').trim();
  const re = new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`);
  if (!re.test(raw) || Number(raw) <= 0) throw Object.assign(new Error(`${field} must be a positive number`), { status: 400, field });
  return raw;
}

export default createAdminRouter();
