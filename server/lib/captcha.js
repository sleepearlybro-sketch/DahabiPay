/* ==========================================================================
   Captcha.

   The answer never leaves the server: the client gets an id and an SVG, and
   sends back the id plus what the user typed. A challenge is single-use and
   short-lived, so a solved image cannot be replayed.

   This is a speed bump, not a bot defence - the real controls are the
   database-backed rate limits in lib/auth.js. It exists so a scripted client
   has to do a round trip per attempt.
   ========================================================================== */

import crypto from 'node:crypto';
import * as db from '../db.js';
import { HttpError } from './http.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1
const TTL_MS = 10 * 60 * 1000;
const LEN = 5;

function code() {
  let s = '';
  for (let i = 0; i < LEN; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

/** Deterministic jitter from the code, so the same challenge renders alike. */
function render(text) {
  const W = 150, H = 50;
  const rand = (min, max) => min + crypto.randomInt(Math.max(1, Math.round((max - min) * 100))) / 100;

  const glyphs = [...text].map((ch, i) => {
    const x = 14 + i * 26 + rand(-3, 3);
    const y = 34 + rand(-4, 4);
    const rot = rand(-22, 22);
    const size = rand(24, 30);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size.toFixed(0)}"
      font-family="Verdana,DejaVu Sans,sans-serif" font-weight="700" fill="#025081"
      transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${ch}</text>`;
  }).join('');

  // a few strokes and dots, enough to break naive template matching
  let noise = '';
  for (let i = 0; i < 5; i++) {
    noise += `<path d="M${rand(0, 40).toFixed(0)},${rand(0, H).toFixed(0)}
      Q${rand(40, 110).toFixed(0)},${rand(0, H).toFixed(0)}
      ${rand(110, W).toFixed(0)},${rand(0, H).toFixed(0)}"
      stroke="rgba(2,80,129,.28)" stroke-width="1.4" fill="none"/>`;
  }
  for (let i = 0; i < 26; i++) {
    noise += `<circle cx="${rand(0, W).toFixed(0)}" cy="${rand(0, H).toFixed(0)}"
      r="${rand(0.6, 1.6).toFixed(1)}" fill="rgba(2,80,129,.22)"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="captcha">
    <rect width="${W}" height="${H}" fill="#eef4ff"/>${noise}${glyphs}</svg>`.replace(/\s+/g, ' ');
}

/** Mint a challenge. Returns what is safe to send to the browser. */
export async function issue() {
  const id = crypto.randomBytes(16).toString('base64url');
  const answer = code();
  await db.run(
    `INSERT INTO captchas (id, answer, expires_at, created_at) VALUES (?, ?, ?, ?)`,
    id, answer, new Date(Date.now() + TTL_MS).toISOString(), db.now()
  );

  // opportunistic tidy-up; cheap and keeps the table from growing forever
  if (crypto.randomInt(20) === 0) {
    await db.run('DELETE FROM captchas WHERE expires_at <= ? OR used_at IS NOT NULL', db.now());
  }

  return { id, svg: render(answer), ttlSec: Math.floor(TTL_MS / 1000) };
}

/**
 * Check an answer and burn the challenge either way, so a wrong guess costs
 * a fresh round trip rather than allowing unlimited tries at one image.
 */
export async function verify(id, answer) {
  if (!id || !answer) return { ok: false, reason: 'Captcha is required' };

  const row = await db.get('SELECT * FROM captchas WHERE id = ?', String(id));
  if (!row) return { ok: false, reason: 'Captcha expired - reload the image' };

  await db.run('UPDATE captchas SET used_at = ? WHERE id = ?', db.now(), row.id);

  if (row.used_at) return { ok: false, reason: 'That captcha was already used' };
  if (Date.parse(row.expires_at) <= Date.now()) {
    return { ok: false, reason: 'Captcha expired - reload the image' };
  }

  const given = String(answer).trim().toUpperCase();
  // both are short fixed-length tokens, so a length mismatch is not a leak
  if (given.length !== row.answer.length) return { ok: false, reason: 'Captcha does not match' };
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(row.answer, 'utf8');
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'Captcha does not match' };

  return { ok: true };
}

/** Throwing form for use inside a route. */
export async function requireCaptcha(req) {
  const { captchaId, captcha } = req.body || {};
  const r = await verify(captchaId, captcha);
  if (!r.ok) throw new HttpError(400, r.reason, 'captcha');
}
