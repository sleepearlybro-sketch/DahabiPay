import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (value, fallback) => value === undefined || value === '' ? fallback : Number(value);
const bool = (value, fallback) => value === undefined || value === ''
  ? fallback
  : /^(1|true|yes|on)$/i.test(value);

export const ROOT = path.resolve(here, '..');

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '127.0.0.1',
  origin: process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${num(process.env.PORT, 3000)}`,
  supabase: {
    url: process.env.SUPABASE_URL || '',
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || '',
    secretKey: process.env.SUPABASE_SECRET_KEY || ''
  },
  quote: {
    secret: process.env.QUOTE_SIGNING_SECRET || 'development-only-quote-secret-change-me',
    minutes: num(process.env.QUOTE_TTL_MINUTES, 15)
  },
  staffSession: {
    cookie: 'dp_staff',
    hours: num(process.env.STAFF_SESSION_HOURS, 12),
    secure: bool(process.env.COOKIE_SECURE, false)
  },
  mail: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Dahabi Pay <no-reply@dahabipay.example>'
  },
  limits: { jsonBody: process.env.MAX_JSON_BODY || '128kb' }
};

export function configWarnings() {
  const warnings = [];
  if (!config.supabase.url) warnings.push('SUPABASE_URL is unset');
  if (!config.supabase.publishableKey) warnings.push('SUPABASE_PUBLISHABLE_KEY is unset');
  if (!config.supabase.secretKey) warnings.push('SUPABASE_SECRET_KEY is unset');
  if (!config.mail.host) warnings.push('SMTP_HOST is unset - operations notifications remain queued');
  if (config.env === 'production' && !config.staffSession.secure) warnings.push('COOKIE_SECURE is off');
  if (config.env === 'production' && config.quote.secret.startsWith('development-only')) {
    warnings.push('QUOTE_SIGNING_SECRET is using the development fallback');
  }
  return warnings;
}

export function assertRuntimeConfig() {
  const missing = [];
  if (!config.supabase.url) missing.push('SUPABASE_URL');
  if (!config.supabase.publishableKey) missing.push('SUPABASE_PUBLISHABLE_KEY');
  if (!config.supabase.secretKey) missing.push('SUPABASE_SECRET_KEY');
  if (config.env === 'production' && config.quote.secret.startsWith('development-only')) missing.push('QUOTE_SIGNING_SECRET');
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(', ')}`);
}
