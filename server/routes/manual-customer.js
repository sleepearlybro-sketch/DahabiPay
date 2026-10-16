import express from 'express';
import { config } from '../config.js';
import { supabaseAuth } from '../supabase.js';
import * as store from '../store.js';
import { normalizeEmail, sessionToken } from '../lib/manual.js';
import { clientIp, rateLimit } from '../lib/rate-limit.js';
import { clearCustomerCookie, requireCustomer, setCustomerCookie } from '../lib/customer.js';

export function createCustomerRouter(deps = {}) {
  const router = express.Router();
  const data = deps.store || store;
  const auth = deps.auth || (() => supabaseAuth());

  router.post('/auth/otp',
    rateLimit({ name: 'customer-otp-ip', limit: 8, windowMs: 60 * 60_000 }),
    rateLimit({ name: 'customer-otp-email', limit: 4, windowMs: 60 * 60_000, key: (req) => String(req.body.email || '').trim().toLowerCase() }),
    async (req, res, next) => {
      try {
        const email = normalizeEmail(req.body.email);
        const result = await auth().auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
        if (result.error) throw Object.assign(new Error('Unable to send the email code. Please try again.'), { status: 502 });
        res.json({ ok: true, email, resendAfterSeconds: 60 });
      } catch (error) { next(error); }
    });

  router.post('/auth/verify',
    rateLimit({ name: 'customer-verify-ip', limit: 20, windowMs: 60 * 60_000 }),
    async (req, res, next) => {
      try {
        const email = normalizeEmail(req.body.email);
        const otp = String(req.body.otp || '').trim();
        if (!/^\d{6,8}$/.test(otp)) return res.status(400).json({ error: 'Enter the code sent to your email', field: 'otp' });
        const verified = await auth().auth.verifyOtp({ email, token: otp, type: 'email' });
        const user = verified.data?.user;
        if (verified.error || !user?.id || user.email?.toLowerCase() !== email) {
          return res.status(400).json({ error: 'The code is incorrect or expired', field: 'otp' });
        }
        const token = sessionToken();
        const expiresAt = new Date(Date.now() + config.customerSession.days * 24 * 60 * 60_000).toISOString();
        await data.createCustomerSession({
          tokenHash: token.hash, customerAuthId: user.id, email,
          expiresAt, ip: clientIp(req), userAgent: String(req.get('user-agent') || '').slice(0, 500)
        });
        setCustomerCookie(res, token.raw, expiresAt);
        res.json({ customer: { email }, expiresAt });
      } catch (error) { next(error); }
    });

  router.post('/auth/logout', async (req, res, next) => {
    try {
      if (req.customer) await data.deleteCustomerSession(req.customer.session.token_hash);
      clearCustomerCookie(res);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  router.get('/me', requireCustomer, (req, res) => res.json({ customer: { email: req.customer.customer.email } }));
  router.get('/requests', requireCustomer, async (req, res, next) => {
    try { res.json({ requests: await data.listCustomerRequests(req.customer.customer.id) }); }
    catch (error) { next(error); }
  });

  return router;
}

export default createCustomerRouter();
