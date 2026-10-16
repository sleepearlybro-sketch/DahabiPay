import express from 'express';
import { config } from '../config.js';
import * as store from '../store.js';
import { createQuote, normalizeEmail, requestReference, validateContact, verifyQuote } from '../lib/manual.js';
import { requireCustomer } from '../lib/customer.js';
import { clientIp, rateLimit } from '../lib/rate-limit.js';
import { publishEvent } from '../events.js';
import { processOutbox } from '../services/notifications.js';

export function createPublicRouter(deps = {}) {
  const router = express.Router();
  const data = deps.store || store;
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

  router.post('/requests',
    rateLimit({ name: 'request-ip', limit: 15, windowMs: 60 * 60_000 }),
    requireCustomer,
    rateLimit({ name: 'request-user', limit: 10, windowMs: 60 * 60_000, key: (req) => req.customer.customer.id }),
    async (req, res, next) => {
      try {
        const verifiedEmail = req.customer.customer.email;
        if (req.body.email && normalizeEmail(req.body.email) !== verifiedEmail) {
          return res.status(403).json({ error: 'The request email must match your verified account', field: 'email' });
        }
        const contact = validateContact({ ...req.body, email: verifiedEmail });
        const quote = verifyQuote(req.body.quoteToken, config.quote.secret);
        const s = await data.getSettings();
        if (!s.accepting_requests) return res.status(503).json({ error: 'Exchange requests are temporarily paused' });
        const created = await data.createRequest({
          reference: requestReference(), quoteJti: quote.jti,
          customerAuthId: req.customer.customer.id,
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
