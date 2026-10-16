import { config } from '../config.js';
import * as store from '../store.js';
import { hashToken } from './manual.js';

export async function attachStaff(req, _res, next) {
  const raw = req.cookies?.[config.staffSession.cookie];
  if (!raw) return next();
  try { req.staff = await store.getStaffSession(hashToken(raw)); }
  catch (error) { return next(error); }
  next();
}

export function requireStaff(req, res, next) {
  if (!req.staff) return res.status(401).json({ error: 'Staff sign-in required' });
  if (!req.staff.staff.password_enabled) return res.status(428).json({ error: 'Set a username and password before continuing' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.staff) return res.status(401).json({ error: 'Staff sign-in required' });
  if (!req.staff.staff.password_enabled) return res.status(428).json({ error: 'Set a username and password before continuing' });
  if (req.staff.staff.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
  next();
}

export function setStaffCookie(res, raw, expiresAt) {
  res.cookie(config.staffSession.cookie, raw, {
    httpOnly: true,
    secure: config.staffSession.secure,
    sameSite: 'strict',
    path: '/api/admin',
    expires: new Date(expiresAt)
  });
}

export function clearStaffCookie(res) {
  res.clearCookie(config.staffSession.cookie, {
    httpOnly: true,
    secure: config.staffSession.secure,
    sameSite: 'strict',
    path: '/api/admin'
  });
}
