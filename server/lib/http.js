/* ==========================================================================
   Request plumbing: async error capture, input validation, audit logging.
   ========================================================================== */

import * as db from '../db.js';
import { clientIp } from './auth.js';

/** Wrap an async handler so a rejection reaches the error middleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Thrown by validators and handlers; index.js turns it into a JSON response. */
export class HttpError extends Error {
  constructor(status, message, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

export const bad = (msg, field) => new HttpError(400, msg, field);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);

/* ------------------------------------------------------------ validation
   Small, explicit, and it returns the cleaned value rather than mutating
   the request - so a handler can never accidentally use the raw input.   */

export function str(body, field, { required = true, min = 0, max = 500, pattern, label } = {}) {
  const raw = body?.[field];
  const v = raw === undefined || raw === null ? '' : String(raw).trim();
  const name = label || field;
  if (!v) {
    if (required) throw bad(`${name} is required`, field);
    return '';
  }
  if (v.length < min) throw bad(`${name} must be at least ${min} characters`, field);
  if (v.length > max) throw bad(`${name} must be at most ${max} characters`, field);
  if (pattern && !pattern.test(v)) throw bad(`${name} is not in the expected format`, field);
  return v;
}

export function email(body, field = 'email', opts = {}) {
  const v = str(body, field, { max: 254, label: 'Email', ...opts });
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) throw bad('Enter a valid email', field);
  return v.toLowerCase();
}

export function decimal(body, field, { required = true, label } = {}) {
  const raw = body?.[field];
  const name = label || field;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    if (required) throw bad(`${name} is required`, field);
    return '';
  }
  const v = String(raw).trim().replace(/[\s_]/g, '').replace(',', '.');
  if (!/^\d*(\.\d*)?$/.test(v) || v === '.' || v === '') {
    throw bad(`${name} must be a number`, field);
  }
  return v;
}

export function oneOf(body, field, allowed, { required = true, label } = {}) {
  const v = str(body, field, { required, label });
  if (v && !allowed.includes(v)) throw bad(`${label || field} must be one of: ${allowed.join(', ')}`, field);
  return v;
}

export function int(body, field, { required = true, min, max, label } = {}) {
  const raw = body?.[field];
  const name = label || field;
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw bad(`${name} is required`, field);
    return null;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) throw bad(`${name} must be a whole number`, field);
  if (min !== undefined && n < min) throw bad(`${name} must be at least ${min}`, field);
  if (max !== undefined && n > max) throw bad(`${name} must be at most ${max}`, field);
  return n;
}

export function bool(body, field) {
  const v = body?.[field];
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

/** Paging that can never be used to pull the whole table. */
export function paging(query, { max = 100, def = 25 } = {}) {
  const limit = Math.min(max, Math.max(1, Number(query.limit) || def));
  const page = Math.max(1, Number(query.page) || 1);
  return { limit, offset: (page - 1) * limit, page };
}

/* --------------------------------------------------------------- audit */
export async function audit(req, action, { entity, entityId, detail } = {}) {
  await db.run(
    `INSERT INTO audit_log (actor_id, actor_login, action, entity, entity_id, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    req?.user?.id ?? null,
    req?.user?.login ?? 'system',
    action,
    entity ?? null,
    entityId != null ? String(entityId) : null,
    detail ? JSON.stringify(detail) : null,
    req ? clientIp(req) : null,
    db.now()
  );
}

/** Audit entry with no request behind it (pollers, webhooks, seeding). */
export async function auditSystem(action, { entity, entityId, detail } = {}) {
  await db.run(
    `INSERT INTO audit_log (actor_id, actor_login, action, entity, entity_id, detail, ip, created_at)
     VALUES (NULL, 'system', ?, ?, ?, ?, NULL, ?)`,
    action, entity ?? null, entityId != null ? String(entityId) : null,
    detail ? JSON.stringify(detail) : null, db.now()
  );
}
