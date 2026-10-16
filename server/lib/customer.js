import { config } from '../config.js';
import * as store from '../store.js';
import { hashToken } from './manual.js';

export async function attachCustomer(req, _res, next) {
  const raw = req.cookies?.[config.customerSession.cookie];
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return next();
  try { req.customer = await store.getCustomerSession(hashToken(raw)); }
  catch (error) { return next(error); }
  next();
}

export function requireCustomer(req, res, next) {
  if (!req.customer) return res.status(401).json({ error: 'Verify your email to continue', code: 'SIGN_IN_REQUIRED' });
  next();
}

export function setCustomerCookie(res, raw, expiresAt) {
  res.cookie(config.customerSession.cookie, raw, {
    httpOnly: true,
    secure: config.customerSession.secure,
    sameSite: 'strict',
    path: '/api',
    expires: new Date(expiresAt)
  });
}

export function clearCustomerCookie(res) {
  res.clearCookie(config.customerSession.cookie, {
    httpOnly: true,
    secure: config.customerSession.secure,
    sameSite: 'strict',
    path: '/api'
  });
}
