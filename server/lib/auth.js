/* ==========================================================================
   Passwords, sessions, access control, rate limiting.

   Hashing is scrypt from node:crypto - memory-hard, in the standard library,
   no native build step. Hashes are self-describing so parameters can be
   raised later without invalidating existing passwords.
   ========================================================================== */

import crypto from 'node:crypto';
import { config } from '../config.js';
import * as db from '../db.js';

/* ------------------------------------------------------------- password */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plain, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64'), key.toString('base64')].join('$');
}

export function verifyPassword(plain, stored) {
  if (!stored) return false;
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  let key;
  try {
    key = crypto.scryptSync(plain, Buffer.from(salt, 'base64'), Buffer.from(hash, 'base64').length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  } catch {
    return false;
  }
  const want = Buffer.from(hash, 'base64');
  // lengths must match before timingSafeEqual, which throws otherwise
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

/* -------------------------------------------------------------- tokens */
export const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function newOrderId() {
  const a = crypto.randomBytes(3).toString('hex').toUpperCase();
  const b = String(crypto.randomInt(10000, 99999));
  return `EP-${a}-${b}`;
}

export const newRefCode = () => 'EP' + crypto.randomInt(10000, 99999);

/* ------------------------------------------------------------ sessions */
export async function createSession(userId, req) {
  const token = newToken();
  await db.run(
    `INSERT INTO sessions (token, user_id, ip, ua, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    token, userId, clientIp(req), String(req.get('user-agent') || '').slice(0, 300),
    db.now(), db.inDays(config.session.days)
  );
  return token;
}

export async function destroySession(token) {
  if (token) await db.run('DELETE FROM sessions WHERE token = ?', token);
}

export async function sessionUser(token) {
  if (!token) return null;
  const row = await db.get(
    `SELECT u.*, s.token AS session_token
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?`,
    token, db.now()
  );
  return row || null;
}

export function setSessionCookie(res, token) {
  res.cookie(config.session.cookie, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.session.secure,
    maxAge: config.session.days * 86_400_000,
    path: '/'
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(config.session.cookie, { path: '/' });
}

/** Drop expired sessions and used/expired email tokens. */
export async function pruneSessions() {
  const t = db.now();
  await db.run('DELETE FROM sessions WHERE expires_at <= ?', t);
  await db.run('DELETE FROM email_tokens WHERE expires_at <= ? OR used_at IS NOT NULL', t);
}

/* ---------------------------------------------------------- middleware */
export function clientIp(req) {
  // trust proxy is enabled in index.js, so req.ip already honours X-Forwarded-For
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

/** Populates req.user from the session cookie. Never rejects. */
export async function attachUser(req, _res, next) {
  try {
    const token = req.cookies?.[config.session.cookie];
    const user = await sessionUser(token);
    if (user) {
      req.user = user;
      const stale = !user.last_seen_at || Date.now() - Date.parse(user.last_seen_at) > 60_000;
      if (stale) await db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', db.now(), user.id);
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  if (req.user.blocked) return res.status(403).json({ error: 'Account blocked' });
  next();
}

const RANK = { user: 0, operator: 1, admin: 2 };

/** requireRole('operator') also admits admin. */
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required' });
    if (req.user.blocked) return res.status(403).json({ error: 'Account blocked' });
    if ((RANK[req.user.role] ?? -1) < RANK[role]) {
      return res.status(403).json({ error: 'Insufficient privileges' });
    }
    next();
  };
}

/* --------------------------------------------------------- rate limiting
   Stored in the database, so restarting the process cannot be used to reset
   a bucket and the limit survives across workers.                        */
export async function rateLimit({ key, limit, windowSec }) {
  const nowMs = Date.now();
  const row = await db.get('SELECT hits, reset_at FROM rate_limits WHERE bucket = ?', key);

  if (!row || Date.parse(row.reset_at) <= nowMs) {
    await db.run(
      `INSERT INTO rate_limits (bucket, hits, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET hits = 1, reset_at = excluded.reset_at`,
      key, new Date(nowMs + windowSec * 1000).toISOString()
    );
    return { ok: true, remaining: limit - 1, retryAfter: 0 };
  }

  if (row.hits >= limit) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((Date.parse(row.reset_at) - nowMs) / 1000) };
  }

  await db.run('UPDATE rate_limits SET hits = hits + 1 WHERE bucket = ?', key);
  return { ok: true, remaining: limit - row.hits - 1, retryAfter: 0 };
}

/** Express middleware form. `by` derives the bucket key from the request. */
export function limiter({ name, limit, windowSec, by }) {
  return async (req, res, next) => {
    try {
      const who = by ? by(req) : clientIp(req);
      const result = await rateLimit({ key: `${name}:${who}`, limit, windowSec });
      if (!result.ok) {
        res.set('Retry-After', String(result.retryAfter));
        return res.status(429).json({ error: `Too many attempts. Try again in ${result.retryAfter}s.` });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
