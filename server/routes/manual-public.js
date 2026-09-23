import express from 'express';
import { config } from '../config.js';
import { supabaseAuth } from '../supabase.js';
import * as store from '../store.js';
import { createQuote, requestReference, validateContact, verifyQuote } from '../lib/manual.js';
import { clientIp, rateLimit } from '../lib/rate-limit.js';
import { publishEvent } from '../events.js';
import { processOutbox } from '../services/notifications.js';

export function createPublicRouter(deps = {}) {
  const router = express.Router();
  const data = deps.store || store;
  const auth = deps.auth || (() => supabaseAuth());
  const notify = deps.processOutbox || processOutbox;

  router.get('/public/offer', async (_req, res, next) => {
    try {
      const s = await data.getSettings();
      const configured = Number(s.rate) > 0 && Number(s.min_usdt) > 0 && Number(s.max_usdt) >= Number(s.min_usdt);
      res.json({
        send: { asset: 'Tether USDT', network: 'TRC20', code: 'USDT' },
        receive: { asset: 'Money Go', code: 'USD' },
        available: Boolean(s.accepting_requests && configured),
        rate: configured ? String(s.rate) : null,
        minUsdt: configured ? String(s.min_usdt) : null,
        maxUsdt: configured ? String(s.max_usdt) : null,
        quoteMinutes: config.quote.minutes
      });
    } catch (error) { next(error); }
  });

  router.post('/public/quote', rateLimit({ name: 'quote', limit: 30, windowMs: 10 * 60_000 }), async (req, res, next) => {
    try {
      const s = await data.getSettings();
      if (!s.accepting_requests) return res.status(503).json({ error: 'Exchange requests are temporarily paused' });
      const quote = createQuote({
        amount: req.body.amount, rate: s.rate, minAmount: s.min_usdt,
        maxAmount: s.max_usdt, secret: config.quote.secret, ttlMinutes: config.quote.minutes
      });
      res.json({ amount: quote.send, rate: quote.rate, receiveUsd: quote.receive, expiresAt: new Date(quote.exp).toISOString(), quoteToken: quote.token });
    } catch (error) { next(error); }
  });

  router.post('/requests/otp',
    rateLimit({ name: 'otp-ip', limit: 8, windowMs: 60 * 60_000 }),
    rateLimit({ name: 'otp-email', limit: 4, windowMs: 60 * 60_000, key: (req) => String(req.body.email || '').trim().toLowerCase() }),
    async (req, res, next) => {
    try {
      const contact = validateContact(req.body);
      verifyQuote(req.body.quoteToken, config.quote.secret);
      const s = await data.getSettings();
      if (!s.accepting_requests) return res.status(503).json({ error: 'Exchange requests are temporarily paused' });
      const result = await auth().auth.signInWithOtp({ email: contact.email, options: { shouldCreateUser: true } });
      if (result.error) throw Object.assign(new Error(result.error.message), { status: 502 });
      res.json({ ok: true, email: contact.email, expiresInSeconds: 3600, resendAfterSeconds: 60 });
    } catch (error) { next(error); }
    });

  router.post('/requests/verify', rateLimit({ name: 'verify-ip', limit: 20, windowMs: 60 * 60_000 }), async (req, res, next) => {
    try {
      const contact = validateContact(req.body);
      const token = String(req.body.otp || '').trim();
      if (!/^\d{6}$/.test(token)) return res.status(400).json({ error: 'Enter the six-digit code', field: 'otp' });
      const quote = verifyQuote(req.body.quoteToken, config.quote.secret);
      const verified = await auth().auth.verifyOtp({ email: contact.email, token, type: 'email' });
      if (verified.error || !verified.data?.user) return res.status(400).json({ error: 'The code is incorrect or expired', field: 'otp' });
      if (verified.data.user.email?.toLowerCase() !== contact.email) return res.status(400).json({ error: 'Email verification did not match this request' });
      const created = await data.createRequest({
        reference: requestReference(), quoteJti: quote.jti, customerAuthId: verified.data.user.id,
        ...contact, sendUsdt: quote.send, rate: quote.rate, receiveUsd: quote.receive,
        ip: clientIp(req), userAgent: String(req.get('user-agent') || '').slice(0, 500)
      });
      publishEvent('request.created', { id: created.id, reference: created.reference });
      Promise.resolve(notify()).catch((error) => console.error('notification outbox:', error.message));
      res.status(201).json({
        reference: created.reference, amount: String(created.send_usdt), rate: String(created.rate),
        receiveUsd: String(created.receive_usd), message: 'Our team will contact you on WhatsApp shortly.'
      });
    } catch (error) { next(error); }
  });

  return router;
}

export default createPublicRouter();
