import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { config, configWarnings, assertRuntimeConfig, ROOT } from './config.js';
import { attachStaff } from './lib/staff.js';
import { attachCustomer } from './lib/customer.js';
import publicRoutes from './routes/manual-public.js';
import customerRoutes from './routes/manual-customer.js';
import adminRoutes from './routes/manual-admin.js';
import * as store from './store.js';
import { startNotifications, stopNotifications } from './services/notifications.js';

assertRuntimeConfig();
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.env === 'production' ? 1 : false);
app.use((_req, res, next) => {
  res.set({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  });
  if (_req.path.startsWith('/api/')) res.set('cache-control', 'no-store');
  next();
});
app.use(express.json({ limit: config.limits.jsonBody }));
app.use(cookieParser());
app.use(attachStaff);
app.use(attachCustomer);

app.get('/api/health', async (_req, res) => {
  try {
    const settings = await store.getSettings();
    res.json({ ok: true, database: 'supabase-postgresql', acceptingRequests: Boolean(settings.accepting_requests), time: new Date().toISOString() });
  } catch { res.status(503).json({ ok: false, database: 'unavailable' }); }
});
app.use('/api', publicRoutes);
app.use('/api/customer', customerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/admin', express.static(path.join(ROOT, 'admin'), { index: 'index.html' }));
app.use('/account', express.static(path.join(ROOT, 'account'), { index: 'index.html' }));
app.get(['/contact', '/contact/'], (_req, res) => res.redirect(302, '/#contact'));

const NEVER_SERVE = [/^\/data(\/|$)/, /^\/server(\/|$)/, /^\/supabase(\/|$)/, /^\/deploy(\/|$)/,
  /^\/node_modules(\/|$)/, /(^|\/)\.env/, /(^|\/)\.git(\/|$)/,
  /^\/(Dockerfile|docker-compose\.ya?ml|package(-lock)?\.json)$/i];
app.use((req, res, next) => {
  let value;
  try { value = decodeURIComponent(req.path); } catch { value = req.path; }
  if (NEVER_SERVE.some((re) => re.test(value))) return res.status(404).json({ error: 'Not found' });
  next();
});
app.use(express.static(ROOT, { index: 'index.html', extensions: ['html'], dotfiles: 'ignore' }));
app.use((req, res) => req.path.startsWith('/api/')
  ? res.status(404).json({ error: 'Unknown endpoint' })
  : res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Not found · Dahabi Pay</title><main><h1>Page not found</h1><a href="/">Return home</a></main>'));
app.use((err, req, res, _next) => {
  const status = Number(err.status) || 500;
  if (status >= 500) console.error(`${req.method} ${req.originalUrl}:`, err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on our side.' : err.message, field: err.field, code: err.code });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`Dahabi Pay listening on http://${config.host}:${config.port}`);
  for (const warning of configWarnings()) console.warn(`warning: ${warning}`);
  startNotifications();
});
const sweep = setInterval(() => Promise.all([store.pruneStaffSessions(), store.pruneCustomerSessions()])
  .catch((error) => console.error('session cleanup:', error.message)), 60 * 60_000);
sweep.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopNotifications(); clearInterval(sweep); server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
});

export default app;
