/* ==========================================================================
   Configuration - every value comes from the environment with a safe default.
   Copy .env.example to .env and fill it in. Secrets never live in this file.
   ========================================================================== */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export const ROOT = path.resolve(here, '..');

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '127.0.0.1',

  /* public origin, used in emailed links */
  origin: process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${num(process.env.PORT, 3000)}`,

  db: {
    url: process.env.DATABASE_URL || '',
    file: process.env.DB_FILE || path.join(ROOT, 'data', 'exchangepay.db'),
    poolMax: num(process.env.DB_POOL_MAX, 10),
    ssl: bool(process.env.DB_SSL, false),
    sslRejectUnauthorized: bool(process.env.DB_SSL_REJECT_UNAUTHORIZED, true)
  },

  session: {
    cookie: 'ep_sid',
    /* days a session stays valid */
    days: num(process.env.SESSION_DAYS, 14),
    secure: bool(process.env.COOKIE_SECURE, false)
  },

  order: {
    /* minutes the quoted rate is held */
    lockMinutes: num(process.env.QUOTE_LOCK_MINUTES, 20),
    /* confirmations before an automated payout fires */
    confirmations: num(process.env.PAYOUT_CONFIRMATIONS, 2)
  },

  rates: {
    /* how often the pivot cache refreshes, seconds. 0 disables the poller. */
    refreshSec: num(process.env.RATES_REFRESH_SEC, 300),
    cryptoUrl: process.env.RATES_CRYPTO_URL ||
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,the-open-network,tether,usd-coin&vs_currencies=usd',
    fiatUrl: process.env.RATES_FIAT_URL || 'https://open.er-api.com/v6/latest/USD',
    /* refuse to quote from a pivot older than this, seconds */
    maxStaleSec: num(process.env.RATES_MAX_STALE_SEC, 3600)
  },

  payments: {
    /* Each provider stays disabled until its key is present, and any direction
       without a live provider falls through to the operator queue. */
    crypto: {
      provider: process.env.CRYPTO_PROVIDER || 'manual',
      apiKey: process.env.CRYPTO_API_KEY || '',
      apiUrl: process.env.CRYPTO_API_URL || '',
      webhookSecret: process.env.CRYPTO_WEBHOOK_SECRET || ''
    },
    mobile: {
      provider: process.env.MOBILE_PROVIDER || 'manual',
      apiKey: process.env.MOBILE_API_KEY || '',
      apiSecret: process.env.MOBILE_API_SECRET || '',
      apiUrl: process.env.MOBILE_API_URL || '',
      webhookSecret: process.env.MOBILE_WEBHOOK_SECRET || ''
    }
  },

  mail: {
    /* no SMTP host => emails are written to the log instead of sent */
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Dahabi Pay <no-reply@dahabipay.example>'
  },

  admin: {
    /* only used by the seeder, on first run */
    login: process.env.ADMIN_LOGIN || 'admin',
    email: process.env.ADMIN_EMAIL || 'admin@dahabipay.example',
    password: process.env.ADMIN_PASSWORD || ''
  },

  limits: {
    jsonBody: process.env.MAX_JSON_BODY || '256kb',
    kycFileMb: num(process.env.MAX_KYC_FILE_MB, 6)
  },

  /* shared secret for /api/cron/*; without it those endpoints stay closed */
  cronSecret: process.env.CRON_SECRET || ''
};

/* Warn loudly about anything unset that matters in production. */
export function configWarnings() {
  const w = [];
  if (config.env === 'production') {
    if (!config.db.url) w.push('DATABASE_URL unset - using single-host SQLite storage');
    if (!config.session.secure) w.push('COOKIE_SECURE is off - sessions will ride over plain HTTP');
    if (!config.mail.host) w.push('SMTP_HOST unset - verification and reset emails will only be logged');
    if (config.payments.crypto.provider === 'manual') w.push('CRYPTO_PROVIDER is manual - crypto payouts queue for an operator');
    if (config.payments.mobile.provider === 'manual') w.push('MOBILE_PROVIDER is manual - mobile money payouts queue for an operator');
  }
  return w;
}
