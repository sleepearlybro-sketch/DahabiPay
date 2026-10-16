import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const cookie = 'dp_staff_challenge';
const path = '/api/admin/auth';
const ttlMs = 10 * 60_000;
function signature(payload) {
  return createHmac('sha256', config.quote.secret).update('staff-login-v1:').update(payload).digest('base64url');
}

export function setStaffChallenge(res, staff) {
  const payload = Buffer.from(JSON.stringify({ id: staff.user_id, exp: Date.now() + ttlMs })).toString('base64url');
  res.cookie(cookie, `${payload}.${signature(payload)}`, { httpOnly: true, secure: config.staffSession.secure, sameSite: 'strict', path, maxAge: ttlMs });
}

export function getStaffChallenge(req) {
  const raw = req.cookies?.[cookie];
  if (!raw || raw.length > 1024) return null;
  const [payload, mac, extra] = raw.split('.');
  if (!payload || !mac || extra) return null;
  const expected = Buffer.from(signature(payload));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Number.isFinite(value.exp) && value.exp > Date.now() && typeof value.id === 'string' ? value.id : null;
  } catch { return null; }
}

export function clearStaffChallenge(res) {
  res.clearCookie(cookie, { httpOnly: true, secure: config.staffSession.secure, sameSite: 'strict', path });
}
