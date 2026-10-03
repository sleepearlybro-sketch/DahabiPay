import express from 'express';
import { config } from '../config.js';
import { supabaseAuth } from '../supabase.js';
import * as store from '../store.js';
import { canTransition, cleanText, normalizeAmount, normalizeEmail, sessionToken } from '../lib/manual.js';
import { clientIp, rateLimit } from '../lib/rate-limit.js';
import { clearStaffCookie, requireAdmin, requireStaff, setStaffCookie } from '../lib/staff.js';
import { connectEvents, publishEvent } from '../events.js';

export function createAdminRouter(deps = {}) {
  const router = express.Router();
  const data = deps.store || store;
  const auth = deps.auth || (() => supabaseAuth());

  router.post('/auth/otp', rateLimit({ name: 'staff-otp', limit: 6, windowMs: 60 * 60_000 }), async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body.email);
      const staff = await data.findActiveStaffByEmail(email);
      if (staff) {
        const result = await auth().auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
        if (result.error) throw Object.assign(new Error('Unable to send the sign-in code'), { status: 502 });
      }
      res.json({ ok: true, message: 'If this is an active staff account, a sign-in code has been sent.', resendAfterSeconds: 60 });
    } catch (error) { next(error); }
  });

  router.post('/auth/verify', rateLimit({ name: 'staff-verify', limit: 12, windowMs: 60 * 60_000 }), async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body.email);
      const otp = String(req.body.otp || '').trim();
      if (!/^\d{8}$/.test(otp)) return res.status(400).json({ error: 'Enter the eight-digit code', field: 'otp' });
      const staff = await data.findActiveStaffByEmail(email);
      if (!staff) return res.status(403).json({ error: 'This email is not authorized for staff access' });
      const verified = await auth().auth.verifyOtp({ email, token: otp, type: 'email' });
      if (verified.error || verified.data?.user?.id !== staff.user_id) return res.status(400).json({ error: 'The code is incorrect or expired', field: 'otp' });
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
      const whatsappTemplate = cleanText(req.body.whatsappTemplate, 'whatsappTemplate', { min: 5, max: 1000 });
      const settings = await data.updateSettings({ rate, minUsdt, maxUsdt, acceptingRequests: Boolean(req.body.acceptingRequests), operationsEmail, whatsappTemplate }, req.staff.staff);
      publishEvent('settings.updated', { acceptingRequests: settings.accepting_requests });
      res.json({ settings });
    } catch (error) { next(error); }
  });
  router.get('/events', requireStaff, connectEvents);
  return router;
}

function publicStaff(staff) {
  return { id: staff.user_id, email: staff.email, displayName: staff.display_name, role: staff.role };
}
function normalizePositive(value, field, decimals) {
  const raw = String(value ?? '').trim();
  const re = new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`);
  if (!re.test(raw) || Number(raw) <= 0) throw Object.assign(new Error(`${field} must be a positive number`), { status: 400, field });
  return raw;
}

export default createAdminRouter();
