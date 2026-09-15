/* ==========================================================================
   Registration, sign-in, email verification, password reset, PIN.

   Two behaviours worth noting because they look like bugs and are not:

     - Registration and password reset answer identically whether or not the
       address is known. Otherwise the endpoint becomes an account oracle.
     - Sign-in runs the password check even when the login does not exist,
       against a dummy hash, so response timing does not reveal membership.
   ========================================================================== */

import { Router } from 'express';
import * as db from '../db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession,
  setSessionCookie, clearSessionCookie, newToken, newRefCode,
  requireAuth, limiter, clientIp
} from '../lib/auth.js';
import { wrap, str, email as emailField, audit, HttpError } from '../lib/http.js';
import { sendTemplate, templates } from '../services/mail.js';
import * as captcha from '../lib/captcha.js';
import { config } from '../config.js';

const r = Router();

const LOGIN_RE = /^[a-zA-Z0-9_.-]{3,24}$/;

/** Cost-matched decoy so a missing login takes as long as a wrong password. */
const DUMMY_HASH = hashPassword(newToken(16));

function publicUser(u) {
  return {
    login: u.login,
    email: u.email,
    role: u.role,
    emailVerified: !!u.email_verified,
    kycStatus: u.kyc_status,
    discountBp: u.discount_bp,
    refCode: u.ref_code,
    hasPin: !!u.pin_hash,
    lang: u.lang,
    notifyStatus: !!u.notify_status
  };
}

/* ------------------------------------------------------------------ whoami */
r.get('/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

/* ---------------------------------------------------------------- register */
r.post('/register',
  limiter({ name: 'register', limit: 5, windowSec: 3600 }),
  wrap(async (req, res) => {
    await captcha.requireCaptcha(req);
    const login = str(req.body, 'login', { min: 3, max: 24, pattern: LOGIN_RE, label: 'Login' });
    const email = emailField(req.body, 'email');
    const password = str(req.body, 'password', { min: 8, max: 200, label: 'Password' });
    const confirm = str(req.body, 'password2', { required: false, max: 200 });
    const refCode = str(req.body, 'ref', { required: false, max: 20 });

    if (confirm && confirm !== password) throw new HttpError(400, 'Passwords do not match', 'password2');

    const taken = await db.get('SELECT id FROM users WHERE login = ? OR email = ?', login, email);
    if (taken) {
      // the login half is not an oracle - it is visible on any profile - but
      // the email half is, so the message names only the login
      const sameLogin = await db.get('SELECT id FROM users WHERE login = ?', login);
      if (sameLogin) throw new HttpError(409, 'That login is already taken', 'login');
      // email already registered: answer as if it succeeded, and tell the
      // real owner by email rather than telling the caller
      await sendTemplate(email, templates.reset(`${config.origin}/pages/signin.html`));
      return res.status(201).json({ ok: true, verifyRequired: true });
    }

    const referrer = refCode ? await db.get('SELECT id FROM users WHERE ref_code = ?', refCode) : null;

    const info = await db.tx(async () => {
      const ins = await db.run(
        `INSERT INTO users (login, email, pass_hash, role, email_verified, ref_code, referrer_id, created_at)
         VALUES (?, ?, ?, 'user', 0, ?, ?, ?) RETURNING id`,
        login, email, hashPassword(password), newRefCode(), referrer?.id ?? null, db.now()
      );
      const userId = Number(ins.lastInsertRowid);
      const token = newToken();
      await db.run(
        `INSERT INTO email_tokens (token, user_id, kind, expires_at, created_at)
         VALUES (?, ?, 'verify', ?, ?)`,
        token, userId, db.inDays(1), db.now()
      );
      return { userId, token };
    });

    await audit(req, 'user.register', { entity: 'user', entityId: info.userId, detail: { login } });
    await sendTemplate(email, templates.verify(`${config.origin}/api/auth/verify?token=${info.token}`));

    res.status(201).json({ ok: true, verifyRequired: true });
  }));

/* ------------------------------------------------------------------ verify */
r.get('/verify', wrap(async (req, res) => {
  const token = String(req.query.token || '');
  const row = token && await db.get(
    `SELECT * FROM email_tokens WHERE token = ? AND kind = 'verify'
       AND used_at IS NULL AND expires_at > ?`,
    token, db.now()
  );
  if (!row) {
    return res.status(400).type('html').send(page('Link expired',
      'That confirmation link is no longer valid. Sign in and request a new one.'));
  }
  await db.tx(async () => {
    await db.run('UPDATE users SET email_verified = 1 WHERE id = ?', row.user_id);
    await db.run('UPDATE email_tokens SET used_at = ? WHERE token = ?', db.now(), token);
  });
  await audit({ user: { id: row.user_id, login: 'self' } }, 'user.email_verified',
    { entity: 'user', entityId: row.user_id });

  res.type('html').send(page('Email confirmed',
    'Your address is confirmed. <a href="/pages/signin.html">Sign in</a> to continue.'));
}));

/* ------------------------------------------------------------------- login */
r.post('/login',
  limiter({ name: 'login', limit: 10, windowSec: 900 }),
  wrap(async (req, res) => {
    await captcha.requireCaptcha(req);
    const ident = str(req.body, 'login', { max: 254, label: 'Login or email' });
    const password = str(req.body, 'password', { max: 200, label: 'Password' });
    const pin = str(req.body, 'pin', { required: false, max: 12 });

    const user = await db.get(
      'SELECT * FROM users WHERE login = ? OR email = ?',
      ident, ident.toLowerCase()
    );

    // always spend the hashing cost, so timing does not leak existence
    const ok = verifyPassword(password, user ? user.pass_hash : DUMMY_HASH);
    if (!user || !ok) {
      await audit(req, 'auth.login_failed', { detail: { ident } });
      throw new HttpError(401, 'Login or password is incorrect');
    }
    if (user.blocked) throw new HttpError(403, 'This account is blocked. Contact support.');

    if (user.pin_hash && !verifyPassword(pin, user.pin_hash)) {
      await audit(req, 'auth.pin_failed', { entity: 'user', entityId: user.id });
      throw new HttpError(401, 'PIN code is incorrect', 'pin');
    }

    const token = await createSession(user.id, req);
    setSessionCookie(res, token);
    await audit({ ...req, user }, 'auth.login', { entity: 'user', entityId: user.id });

    res.json({ ok: true, user: publicUser(user) });
  }));

r.post('/logout', wrap(async (req, res) => {
  const token = req.cookies?.[config.session.cookie];
  if (req.user) await audit(req, 'auth.logout', { entity: 'user', entityId: req.user.id });
  await destroySession(token);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

/* ---------------------------------------------------------- password reset */
r.post('/forgot',
  limiter({ name: 'forgot', limit: 5, windowSec: 3600 }),
  wrap(async (req, res) => {
    await captcha.requireCaptcha(req);
    const email = emailField(req.body, 'email');
    const user = await db.get('SELECT * FROM users WHERE email = ?', email);

    if (user) {
      const token = newToken();
      await db.run(
        `INSERT INTO email_tokens (token, user_id, kind, expires_at, created_at)
         VALUES (?, ?, 'reset', ?, ?)`,
        token, user.id, new Date(Date.now() + 3600_000).toISOString(), db.now()
      );
      await sendTemplate(email,
        templates.reset(`${config.origin}/pages/reset.html?token=${token}`));
      await audit(req, 'auth.reset_requested', { entity: 'user', entityId: user.id });
    }

    // identical answer either way, so this cannot enumerate addresses
    res.json({ ok: true, message: 'If that address is registered, a reset link is on its way.' });
  }));

r.post('/reset',
  limiter({ name: 'reset', limit: 10, windowSec: 3600 }),
  wrap(async (req, res) => {
    const token = str(req.body, 'token', { max: 200, label: 'Reset token' });
    const password = str(req.body, 'password', { min: 8, max: 200, label: 'Password' });

    const row = await db.get(
      `SELECT * FROM email_tokens WHERE token = ? AND kind = 'reset'
         AND used_at IS NULL AND expires_at > ?`,
      token, db.now()
    );
    if (!row) throw new HttpError(400, 'That reset link has expired. Request a new one.');

    await db.tx(async () => {
      await db.run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(password), row.user_id);
      await db.run('UPDATE email_tokens SET used_at = ? WHERE token = ?', db.now(), token);
      // a password change invalidates every existing session
      await db.run('DELETE FROM sessions WHERE user_id = ?', row.user_id);
    });
    await audit(req, 'auth.reset_completed', { entity: 'user', entityId: row.user_id });

    res.json({ ok: true, message: 'Password changed. You can sign in now.' });
  }));

/* ---------------------------------------------------------------------- pin
   Gates requisite changes and withdrawals, so setting one requires the
   account password even though the user is already signed in.            */
r.post('/pin', requireAuth, wrap(async (req, res) => {
  const password = str(req.body, 'password', { max: 200, label: 'Current password' });
  const pin = str(req.body, 'pin', { required: false, max: 12 });

  if (!verifyPassword(password, req.user.pass_hash)) {
    throw new HttpError(401, 'Current password is incorrect', 'password');
  }
  if (pin && !/^\d{4,6}$/.test(pin)) throw new HttpError(400, 'PIN must be 4-6 digits', 'pin');

  await db.run('UPDATE users SET pin_hash = ? WHERE id = ?',
    pin ? hashPassword(pin) : null, req.user.id);
  await audit(req, pin ? 'user.pin_set' : 'user.pin_cleared', { entity: 'user', entityId: req.user.id });

  res.json({ ok: true, hasPin: !!pin });
}));

/* ----------------------------------------------------------- password change
   Distinct from the emailed reset: the user is already signed in, so the
   current password is the proof rather than a mailed token.              */
r.post('/password', requireAuth, wrap(async (req, res) => {
  const current = str(req.body, 'current', { max: 200, label: 'Current password' });
  const next = str(req.body, 'password', { min: 8, max: 200, label: 'New password' });

  if (!verifyPassword(current, req.user.pass_hash)) {
    await audit(req, 'auth.password_change_failed', { entity: 'user', entityId: req.user.id });
    throw new HttpError(401, 'Current password is incorrect', 'current');
  }
  if (current === next) throw new HttpError(400, 'The new password is the same as the old one', 'password');

  await db.tx(async () => {
    await db.run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPassword(next), req.user.id);
    // every other device is signed out; this one keeps its session
    await db.run('DELETE FROM sessions WHERE user_id = ? AND token != ?',
      req.user.id, req.user.session_token);
  });
  await audit(req, 'auth.password_changed', { entity: 'user', entityId: req.user.id });

  res.json({ ok: true, message: 'Password changed. Other devices have been signed out.' });
}));

/* ------------------------------------------------------- resend verification */
r.post('/resend-verification',
  requireAuth,
  limiter({ name: 'resend_verify', limit: 3, windowSec: 3600, by: (req) => String(req.user?.id) }),
  wrap(async (req, res) => {
    if (req.user.email_verified) {
      return res.json({ ok: true, message: 'That address is already confirmed.' });
    }
    // supersede any link already outstanding, so only the newest one works
    await db.run("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND kind = 'verify' AND used_at IS NULL",
      db.now(), req.user.id);

    const token = newToken();
    await db.run(
      `INSERT INTO email_tokens (token, user_id, kind, expires_at, created_at)
       VALUES (?, ?, 'verify', ?, ?)`,
      token, req.user.id, db.inDays(1), db.now()
    );
    await sendTemplate(req.user.email,
      templates.verify(`${config.origin}/api/auth/verify?token=${token}`));
    await audit(req, 'auth.verification_resent', { entity: 'user', entityId: req.user.id });

    res.json({ ok: true, message: 'A fresh confirmation link is on its way.' });
  }));

/* -------------------------------------------------------------- sessions */
r.get('/sessions', requireAuth, wrap(async (req, res) => {
  res.json((await db.all(
    `SELECT token, ip, ua, created_at, expires_at FROM sessions
      WHERE user_id = ? ORDER BY created_at DESC`, req.user.id
  )).map((s) => ({
    ip: s.ip, ua: s.ua, createdAt: s.created_at, expiresAt: s.expires_at,
    current: s.token === req.user.session_token
  })));
}));

r.post('/sessions/revoke-others', requireAuth, wrap(async (req, res) => {
  const info = await db.run('DELETE FROM sessions WHERE user_id = ? AND token != ?',
    req.user.id, req.user.session_token);
  await audit(req, 'auth.sessions_revoked', { entity: 'user', entityId: req.user.id, detail: { count: info.changes } });
  res.json({ ok: true, revoked: info.changes });
}));

/* ----------------------------------------------------------------- helper */
function page(title, body) {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - Dahabi Pay</title>
<link rel="stylesheet" href="/assets/css/app.css">
<div class="shell"><div class="auth"><div class="card">
<h2 class="card__title">${title}</h2><p>${body}</p>
<p style="margin-top:18px"><a class="btn" href="/">Back to the exchanger</a></p>
</div></div></div>`;
}

export default r;
