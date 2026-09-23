import crypto from 'node:crypto';
import * as M from './money.js';

export const REQUEST_STATUSES = ['verified', 'contacted', 'in_progress', 'completed', 'cancelled'];
export const ACTIVE_STATUSES = ['verified', 'contacted', 'in_progress'];
const transitions = {
  verified: ['contacted', 'cancelled'],
  contacted: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
};

export function canTransition(from, to, role = 'operator', reopenReason = '') {
  if (transitions[from]?.includes(to)) return true;
  return role === 'admin' && ['completed', 'cancelled'].includes(from) &&
    to === 'contacted' && String(reopenReason).trim().length >= 5;
}

export function normalizeAmount(value) {
  const raw = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw fieldError('amount', 'Enter a valid USDT amount with up to 6 decimals');
  const out = M.str(raw, 6);
  if (!M.isPos(out)) throw fieldError('amount', 'Amount must be greater than zero');
  return out;
}

export function calculateReceive(amount, rate) {
  return M.str(M.mul(normalizeAmount(amount), rate), 2);
}

export function normalizeWhatsapp(value) {
  let phone = String(value ?? '').trim().replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) phone = '+' + phone.slice(2);
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw fieldError('whatsapp', 'Enter WhatsApp with country code, for example +254712345678');
  }
  return phone;
}

export function normalizeEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
    throw fieldError('email', 'Enter a valid email address');
  }
  return email;
}

export function cleanText(value, field, { min = 0, max = 500, required = true } = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) throw fieldError(field, `${label(field)} is required`);
  if (text.length < min) throw fieldError(field, `${label(field)} must be at least ${min} characters`);
  if (text.length > max) throw fieldError(field, `${label(field)} must be at most ${max} characters`);
  return text;
}

export function validateContact(input) {
  return {
    fullName: cleanText(input.fullName, 'fullName', { min: 2, max: 120 }),
    email: normalizeEmail(input.email),
    whatsapp: normalizeWhatsapp(input.whatsapp),
    moneygoAccount: cleanText(input.moneygoAccount, 'moneygoAccount', { min: 5, max: 64 }),
    note: cleanText(input.note, 'note', { max: 1000, required: false })
  };
}

export function createQuote({ amount, rate, minAmount, maxAmount, secret, ttlMinutes = 15, now = Date.now() }) {
  const send = normalizeAmount(amount);
  if (!M.isPos(rate)) throw new Error('The exchange rate is not configured');
  if (M.lt(send, minAmount)) throw fieldError('amount', `Minimum exchange is ${M.str(minAmount, 6)} USDT`);
  if (M.gt(send, maxAmount)) throw fieldError('amount', `Maximum exchange is ${M.str(maxAmount, 6)} USDT`);
  const payload = {
    v: 1, jti: crypto.randomUUID(), send,
    rate: M.str(rate, 8), receive: calculateReceive(send, rate),
    exp: now + ttlMinutes * 60_000
  };
  return { ...payload, token: signPayload(payload, secret) };
}

export function verifyQuote(token, secret, now = Date.now()) {
  const [encoded, signature, extra] = String(token || '').split('.');
  if (!encoded || !signature || extra) throw quoteError('Quote is invalid. Request a new quote.');
  const sent = Buffer.from(signature);
  const wanted = Buffer.from(hmac(encoded, secret));
  if (sent.length !== wanted.length || !crypto.timingSafeEqual(sent, wanted)) {
    throw quoteError('Quote is invalid. Request a new quote.');
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw quoteError('Quote is invalid. Request a new quote.'); }
  if (payload.v !== 1 || !payload.jti || !payload.send || !payload.rate || !payload.receive) {
    throw quoteError('Quote is invalid. Request a new quote.');
  }
  if (!Number.isFinite(payload.exp) || payload.exp <= now) {
    throw quoteError('This quote has expired. Review the latest rate and try again.', 'QUOTE_EXPIRED');
  }
  if (calculateReceive(payload.send, payload.rate) !== payload.receive) {
    throw quoteError('Quote is invalid. Request a new quote.');
  }
  return payload;
}

export function requestReference(date = new Date()) {
  const d = date.toISOString().slice(2, 10).replaceAll('-', '');
  return `DP-${d}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

export function sessionToken() {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function signPayload(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${hmac(encoded, secret)}`;
}
function hmac(value, secret) { return crypto.createHmac('sha256', secret).update(value).digest('base64url'); }
function label(field) { return ({ fullName: 'Full name', moneygoAccount: 'Money Go account', note: 'Note' })[field] || field; }
function fieldError(field, message) { const error = new Error(message); error.status = 400; error.field = field; return error; }
function quoteError(message, code = 'QUOTE_INVALID') { const error = new Error(message); error.status = 409; error.code = code; return error; }
