/* ==========================================================================
   Dahabi Pay server.

   Serves the static front-end and the API from one origin, so the browser
   needs no CORS and session cookies are first-party.
   ========================================================================== */

import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';

import { config, configWarnings, ROOT } from './config.js';
import * as db from './db.js';
import { attachUser, pruneSessions, requireRole, clientIp } from './lib/auth.js';
import { HttpError, auditSystem } from './lib/http.js';
import * as O from './lib/orders.js';
import * as rates from './services/rates.js';

import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import orderRoutes from './routes/orders.js';
import accountRoutes from './routes/account.js';
import adminRoutes from './routes/admin.js';
import webhookRoutes from './routes/webhooks.js';

await db.migrate();

const app = express();
app.disable('x-powered-by');
// behind a reverse proxy in production, so req.ip honours X-Forwarded-For
app.set('trust proxy', config.env === 'production' ? 1 : false);

/* ------------------------------------------------------------- middleware */
app.use((_req, res, next) => {
  res.set({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'SAMEORIGIN'
  });
  next();
});

// Webhooks need the unparsed body to verify their HMAC, so they mount before
// the JSON parser.
app.use('/api/webhooks', webhookRoutes);

app.use(express.json({ limit: config.limits.jsonBody }));
app.use(express.urlencoded({ extended: false, limit: config.limits.jsonBody }));
app.use(cookieParser());
app.use(attachUser);

/* ----------------------------------------------------------------- routes */
app.use('/api', publicRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/admin', adminRoutes);

/* -------------------------------------------------------------- cron jobs
   The in-process poller already runs these; the endpoints exist so an
   external scheduler can drive them too (or take over entirely with
   RATES_REFRESH_SEC=0).                                                   */
function cronAuth(req, res, next) {
  if (!config.cronSecret) return res.status(503).json({ error: 'CRON_SECRET is not set' });
  const sent = String(req.get('x-cron-secret') || req.query.secret || '');
  if (sent !== config.cronSecret) return res.status(401).json({ error: 'Bad cron secret' });
  next();
}

app.post('/api/cron/rates', cronAuth, async (_req, res) => {
  const out = await rates.refresh();
  res.json(out);
});

app.post('/api/cron/expire', cronAuth, async (_req, res, next) => {
  let n;
  try { n = await O.expireStale(); } catch (err) { return next(err); }
  res.json({ expired: n });
});

/* ----------------------------------------------------------- admin panel
   The shell is served to anyone: it carries no data, and every figure in it
   comes from /api/admin/* which requireRole('operator') guards. Gating the
   HTML too would only mean a browser rendering a raw 401 on direct
   navigation, so the panel renders its own sign-in card instead.          */
app.use('/admin', express.static(path.join(ROOT, 'admin')));

/* ---------------------------------------------------------- static files
   The deny list MUST be registered before express.static, or static wins the
   race and serves these anyway. That mattered: data/kyc holds uploaded
   identity documents under predictable filenames.                        */
const NEVER_SERVE = [
  /^\/data(\/|$)/,          // the database and uploaded KYC documents
  /^\/server(\/|$)/,        // source, including schema.sql
  /^\/deploy(\/|$)/,        // deployment configs
  /^\/node_modules(\/|$)/,
  /^\/backups?(\/|$)/,
  /(^|\/)\.env/,            // .env, .env.local, nested copies
  /(^|\/)\.git(\/|$)/,
  /^\/(Dockerfile|docker-compose\.ya?ml|package-lock\.json)$/i
];

app.use((req, res, next) => {
  // decode first: %2e%2e and %2F would otherwise slip past the patterns
  let path;
  try { path = decodeURIComponent(req.path); } catch { path = req.path; }
  if (NEVER_SERVE.some((re) => re.test(path))) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

app.use(express.static(ROOT, {
  index: 'index.html',
  extensions: ['html'],
  dotfiles: 'ignore',
  setHeaders(res, filePath) {
    if (/\.(css|js)$/.test(filePath)) res.set('cache-control', 'public, max-age=300');
  }
}));

/* ------------------------------------------------------------- 404 + error */
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Unknown endpoint' });
  res.status(404).type('html').send(
    `<!doctype html><meta charset="utf-8">
     <meta name="viewport" content="width=device-width,initial-scale=1">
     <title>Not found - Dahabi Pay</title>
     <link rel="stylesheet" href="/assets/css/app.css">
     <div class="shell"><div class="auth"><div class="card center">
     <h2 class="card__title">Page not found</h2>
     <p class="muted">That address does not exist.</p>
     <p style="margin-top:18px"><a class="btn" href="/">Back to the exchanger</a></p>
     </div></div></div>`
  );
});

// eslint-disable-next-line no-unused-vars -- express identifies error handlers by arity
app.use((err, req, res, _next) => {
  const status = err instanceof HttpError ? err.status : (err.status || 500);

  if (status >= 500) {
    console.error('%s %s failed:', req.method, req.originalUrl, err);
    auditSystem('server.error', {
      entity: 'request',
      detail: { method: req.method, url: req.originalUrl, message: err.message, ip: clientIp(req) }
    }).catch((auditErr) => console.error('failed to write server audit:', auditErr));
  }

  res.status(status).json({
    error: status >= 500 ? 'Something went wrong on our side.' : err.message,
    field: err.field ?? undefined
  });
});

/* ------------------------------------------------------------------- boot */
const server = app.listen(config.port, config.host, () => {
  console.log('\nDahabi Pay');
  console.log('  env:       %s', config.env);
  console.log('  listening: http://%s:%d', config.host, config.port);
  console.log('  admin:     http://%s:%d/admin/', config.host, config.port);
  console.log('  database:  %s%s', db.engine, db.engine === 'sqlite' ? ` (${config.db.file})` : '');

  const warn = configWarnings();
  if (warn.length) {
    console.log('\n  warnings:');
    for (const w of warn) console.log('    ! %s', w);
  }
  console.log('');

  rates.startPoller();

  // expire stale quote locks, and tidy dead sessions
  const sweep = setInterval(async () => {
    try {
      const n = await O.expireStale();
      if (n) console.log('  expired %d stale order(s)', n);
      await pruneSessions();
    } catch (err) {
      console.error('  sweep failed:', err.message);
    }
  }, 60_000);
  sweep.unref();
});

/* --------------------------------------------------------------- shutdown */
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    console.log('\n  %s received, shutting down', sig);
    rates.stopPoller();
    server.close(async () => { await db.close(); process.exit(0); });
    // do not hang forever on a stuck connection
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

process.on('unhandledRejection', (err) => {
  console.error('unhandled rejection:', err);
});

export default app;
