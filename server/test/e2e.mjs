/* ==========================================================================
   End-to-end walk against a running server.
     npm start        (in one shell)
     node server/test/e2e.mjs
   Exercises the real HTTP surface: quote -> order -> operator payout, plus
   the authorisation and idempotency guarantees.
   ========================================================================== */

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -- ' + extra : ''}`); }
};

let cookie = '';

async function call(path, { method = 'GET', body, auth = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(auth && cookie ? { cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  for (const c of setCookie) if (c.startsWith('ep_sid=')) cookie = c.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

/* The captcha answer never leaves the server, so a test client cannot solve
   the image. It reads the answer straight from the database instead, which is
   exactly the access a real client does not have. */
/** Open the database directly - the harness is allowed to, a client is not. */
async function openDb(readOnly = true) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(process.env.DB_FILE || './data/exchangepay.db', { readOnly });
}

/* The limiter windows are an hour wide and stored in the database, so without
   this a second run inside the hour inherits the first run's budget and fails
   on the limiter rather than on the thing being tested. */
async function resetLimits() {
  const db = await openDb(false);
  const n = db.prepare('DELETE FROM rate_limits').run().changes;
  db.close();
  return n;
}

async function solveCaptcha() {
  const { data } = await call('/api/v1/captcha');
  const db = await openDb();
  const row = db.prepare('SELECT answer FROM captchas WHERE id = ?').get(data.id);
  db.close();
  return { captchaId: data.id, captcha: row.answer };
}

console.log(`\nDahabi Pay end-to-end  (${BASE})\n`);

const cleared = await resetLimits();
console.log(`  (cleared ${cleared} rate-limit bucket(s) so the run starts fresh)\n`);

/* ------------------------------------------------------------- 1. health */
{
  const { status, data } = await call('/api/health');
  ok('health responds', status === 200 && data.ok);
  ok('currencies are seeded', data.currencies === 23, `got ${data.currencies}`);
  ok('rate feed has run', !!data.rates.lastRun);
  ok('no stale pivots', data.rates.stale === 0, `${data.rates.stale} stale`);
}

/* ------------------------------------------------------------ 1b. captcha */
{
  const { status, data } = await call('/api/v1/captcha');
  ok('captcha issues a challenge', status === 200 && !!data.id);
  ok('captcha returns an SVG', /^<svg/.test(data.svg || ''));
  // The SVG necessarily contains the glyphs - that is the mechanism. What must
  // never appear is the answer as a readable field a script could just read off.
  ok('no answer field is returned',
    !('answer' in (data || {})) && !('code' in (data || {})),
    Object.keys(data || {}).join(','));

  const guess = await call('/api/auth/forgot', {
    method: 'POST',
    body: { email: 'nobody@example.com', captchaId: data.id, captcha: 'ZZZZZ' }
  });
  ok('a wrong answer is rejected',
    guess.status === 400 && /captcha/i.test(guess.data.error || ''), guess.data?.error);

  // single use: solving the same challenge twice must fail the second time
  const solved = await solveCaptcha();
  const first = await call('/api/auth/forgot', {
    method: 'POST', body: { email: 'nobody@example.com', ...solved }
  });
  ok('a solved captcha is accepted once', first.status === 200, first.data?.error);
  const replay = await call('/api/auth/forgot', {
    method: 'POST', body: { email: 'nobody@example.com', ...solved }
  });
  ok('replaying a captcha is refused', replay.status === 400 && /captcha/i.test(replay.data.error || ''),
    replay.data?.error);
  ok('forgot-password does not reveal whether the address exists',
    first.data.message && !/not found|unknown/i.test(first.data.message));
}

/* -------------------------------------------------------------- 2. quote */
let quoted;
{
  const { status, data } = await call('/api/v1/quote', {
    method: 'POST', body: { from: 'usdt_trc20', to: 'mpesa_kes', amount: '100' }
  });
  quoted = data;
  ok('quote succeeds', status === 200 && data.ok === true);
  ok('quote returns a rate', Number(data.rate) > 100, `rate ${data.rate}`);
  ok('quote names the receiving field', data.receiveField?.includes('Safaricom'));

  const under = await call('/api/v1/quote', {
    method: 'POST', body: { from: 'usdt_trc20', to: 'mpesa_kes', amount: '1' }
  });
  ok('below minimum is refused', under.data.ok === false && /Minimum/.test(under.data.error));

  const closed = await call('/api/v1/quote', {
    method: 'POST', body: { from: 'mpesa_kes', to: 'mtn_ghs', amount: '5000' }
  });
  ok('closed direction is refused', closed.data.ok === false && /closed/.test(closed.data.error));
}

/* -------------------------------------------------- 3. create as a guest */
let orderId, accessToken, orderRecv;
{
  const { status, data } = await call('/api/orders', {
    method: 'POST',
    body: {
      from: 'usdt_trc20', to: 'mpesa_kes', amount: '100',
      requisite: '254712345678', email: 'e2e@example.com'
    }
  });
  ok('guest order is created', status === 201 && !!data.order?.id, JSON.stringify(data).slice(0, 160));
  orderId = data.order?.id;
  accessToken = data.accessToken;
  orderRecv = Number(data.order?.recv);
  ok('order opens awaiting payment', data.order?.status === 'awaiting_payment', data.order?.status);
  ok('an access token is issued', !!accessToken);
  ok('server recomputed the amount', data.order?.recv === quoted.recv,
    `${data.order?.recv} vs ${quoted.recv}`);
  ok('a deposit address is present', !!data.order?.depositAddress);
}

/* --------------------------------------------------- 4. bad requisite is rejected */
{
  const { status, data } = await call('/api/orders', {
    method: 'POST',
    body: {
      from: 'usdt_trc20', to: 'mpesa_kes', amount: '100',
      requisite: 'definitely-not-a-phone-number', email: 'e2e@example.com'
    }
  });
  ok('a malformed requisite is rejected', status === 400 && /valid/.test(data.error), data.error);
}

/* ------------------------------------------------------- 5. authorisation */
{
  const noToken = await call(`/api/orders/${orderId}`);
  ok('an order is not readable without its token', noToken.status === 403, `status ${noToken.status}`);

  const wrong = await call(`/api/orders/${orderId}?t=wrong-token`);
  ok('a wrong token is refused', wrong.status === 403);

  const right = await call(`/api/orders/${orderId}?t=${accessToken}`);
  ok('the right token reads the order', right.status === 200 && right.data.order.id === orderId);
}

/* --------------------------------------------------- 6. reserve committed */
let availableWithOrderOpen;
{
  const { data } = await call('/api/v1/currencies');
  const kes = data.currencies.find((c) => c.id === 'mpesa_kes');
  availableWithOrderOpen = Number(kes.reserve);
  // the published reserve figure is availability, so it must have dropped
  ok('open order reduces published availability', availableWithOrderOpen < 4200000,
    `available ${kes.reserve}`);
}

/* ---------------------------------------------- 7. customer claims payment */
{
  const { status, data } = await call(`/api/orders/${orderId}/paid`, {
    method: 'POST', body: { accessToken, txHash: 'e2e-tx-hash-0001' }
  });
  ok('customer can report payment', status === 200 && data.order.status === 'payment_detected',
    data.order?.status || data.error);
}

/* ------------------------------------------------------ 8. admin sign-in */
if (!ADMIN_PASSWORD) {
  console.log('\n  ! ADMIN_PASSWORD not in the environment, skipping operator checks.');
  console.log('    Run with: node --env-file=.env server/test/e2e.mjs\n');
} else {
  {
    const noCap = await call('/api/auth/login', {
      method: 'POST', body: { login: ADMIN_LOGIN, password: ADMIN_PASSWORD }
    });
    ok('sign-in without a captcha is refused',
      noCap.status === 400 && /captcha/i.test(noCap.data.error || ''), noCap.data?.error);

    const bad = await call('/api/auth/login', {
      method: 'POST',
      body: { login: ADMIN_LOGIN, password: 'wrong-password', ...(await solveCaptcha()) }
    });
    ok('a wrong password is refused', bad.status === 401, bad.data?.error);

    const { status, data } = await call('/api/auth/login', {
      method: 'POST',
      body: { login: ADMIN_LOGIN, password: ADMIN_PASSWORD, ...(await solveCaptcha()) }
    });
    ok('admin signs in', status === 200 && data.user?.role === 'admin', data.error);
    ok('a session cookie is set', cookie.startsWith('ep_sid='));
  }

  /* --------------------------------------------------- 9. admin endpoints */
  {
    const { status, data } = await call('/api/admin/dashboard', { auth: true });
    ok('dashboard loads', status === 200 && typeof data.orders === 'object');
    ok('the order shows as needing attention', data.needsAttention >= 1);
    ok('payments report as manual', data.payments.crypto.live === false);

    const det = await call(`/api/admin/orders/${orderId}`, { auth: true });
    ok('order detail loads', det.status === 200 && det.data.order.id === orderId);
    ok('the timeline has every step', det.data.events.length >= 3,
      `${det.data.events.length} events`);
    ok('payout is not yet claimed', det.data.payoutClaimed === false);
  }

  /* ------------------------------------------------------- 10. settlement */
  {
    const { status, data } = await call(`/api/admin/orders/${orderId}/action`, {
      auth: true, method: 'POST', body: { action: 'settle' }
    });
    ok('settle is accepted', status === 200, data.error);
    // the manual provider does not move money; it queues for a human
    ok('manual rail queues for the operator', data.result?.action === 'queued_for_operator',
      JSON.stringify(data.result));

    const det = await call(`/api/admin/orders/${orderId}`, { auth: true });
    ok('order is processing', det.data.order.status === 'processing', det.data.order.status);
    ok('payout is now claimed', det.data.payoutClaimed === true);

    // req. 5: a second settle must not pay again
    const again = await call(`/api/admin/orders/${orderId}/action`, {
      auth: true, method: 'POST', body: { action: 'settle' }
    });
    ok('a second settle is refused as already claimed',
      again.data.result?.action === 'already_claimed', JSON.stringify(again.data.result));
  }

  /* ------------------------------------------------------ 11. completion */
  {
    const pre = await call('/api/admin/currencies', { auth: true });
    const beforeRow = pre.data.find((c) => c.id === 'mpesa_kes');
    const committedBeforeCompletion = Number(beforeRow.reserved);

    const { status, data } = await call(`/api/admin/orders/${orderId}/action`, {
      auth: true, method: 'POST', body: { action: 'complete', payoutRef: 'e2e-payout-ref' }
    });
    ok('operator completes the order', status === 200 && data.result?.action === 'completed',
      JSON.stringify(data.result).slice(0, 200));

    const det = await call(`/api/admin/orders/${orderId}`, { auth: true });
    ok('order is completed', det.data.order.status === 'completed');
    ok('completion is timestamped', !!det.data.order.completed_at);

    const post = await call('/api/admin/currencies', { auth: true });
    const afterRow = post.data.find((c) => c.id === 'mpesa_kes');
    const heldAfter = det.data.order.reserve_held;

    /* Completion converts a hold into a spend: `reserved` falls by the payout
       and `reserve` falls by the same amount, so availability is unchanged.
       Absolute totals are not safe to assert on - other suites hold reserve on
       this currency too - so this measures the change. */
    const cur = await call('/api/v1/currencies');
    const kes = cur.data.currencies.find((c) => c.id === 'mpesa_kes');
    ok('availability is unchanged by completion',
      Math.abs(Number(kes.reserve) - availableWithOrderOpen) < 0.01,
      `${kes.reserve} vs ${availableWithOrderOpen}`);

    ok('committed liquidity fell by exactly this order',
      Math.abs((committedBeforeCompletion - Number(afterRow.reserved)) - orderRecv) < 0.01,
      `${committedBeforeCompletion} -> ${afterRow.reserved}, order was ${orderRecv}`);

    ok('reserve fell by exactly this order',
      Math.abs((Number(beforeRow.reserve) - Number(afterRow.reserve)) - orderRecv) < 0.01,
      `${beforeRow.reserve} -> ${afterRow.reserve}, order was ${orderRecv}`);

    ok('the order is flagged as no longer holding reserve', heldAfter === 0,
      `reserve_held ${heldAfter}`);

    ok('committed liquidity never exceeds the reserve',
      Number(afterRow.reserved) <= Number(afterRow.reserve),
      `${afterRow.reserved} committed vs ${afterRow.reserve} reserve`);
  }

  /* --------------------------------------------- 12. terminal is terminal */
  {
    const { data } = await call(`/api/admin/orders/${orderId}/action`, {
      auth: true, method: 'POST', body: { action: 'cancel', reason: 'e2e attempt to reopen' }
    });
    ok('a completed order cannot be cancelled', /Cannot move/.test(data.error || ''), data.error);
  }

  /* ------------------------------------------------------- 13. audit trail */
  {
    const { data } = await call('/api/admin/audit?limit=50', { auth: true });
    const actions = data.entries.map((e) => e.action);
    ok('order creation is audited', actions.includes('order.create'));
    ok('settlement is audited', actions.includes('order.settle'));
    ok('completion is audited', actions.includes('order.complete_manual'));
    ok('the failed login is audited', actions.includes('auth.login_failed'));
    ok('the actor is recorded', data.entries.some((e) => e.actor_login === ADMIN_LOGIN));
  }

  /* --------------------------------------------------- 14. privilege gate */
  {
    await call('/api/auth/logout', { auth: true, method: 'POST' });
    const { status } = await call('/api/admin/dashboard', { auth: true });
    ok('admin API closes after sign-out', status === 401, `status ${status}`);
  }
}

/* ------------------------------------------------------- 14b. registration */
{
  const login = 'e2e' + Date.now().toString().slice(-6);
  const emailAddr = login + '@example.com';

  const weak = await call('/api/auth/register', {
    method: 'POST',
    body: { login, email: emailAddr, password: 'short', ...(await solveCaptcha()) }
  });
  ok('a short password is refused', weak.status === 400 && /8 characters/.test(weak.data.error || ''),
    weak.data?.error);

  const { status, data } = await call('/api/auth/register', {
    method: 'POST',
    body: {
      login, email: emailAddr, password: 'a-long-enough-password',
      password2: 'a-long-enough-password', ...(await solveCaptcha())
    }
  });
  ok('registration succeeds', status === 201 && data.ok, data?.error);
  ok('email verification is required', data.verifyRequired === true);

  // an unverified account can still sign in, but the flag reflects reality
  const signin = await call('/api/auth/login', {
    method: 'POST',
    body: { login, password: 'a-long-enough-password', ...(await solveCaptcha()) }
  });
  ok('the new account can sign in', signin.status === 200, signin.data?.error);
  ok('the account starts unverified', signin.data.user?.emailVerified === false);
  ok('the account starts as a plain user', signin.data.user?.role === 'user');
  ok('a referral code is issued', !!signin.data.user?.refCode);

  const dash = await call('/api/admin/dashboard', { auth: true });
  ok('a plain user cannot reach the admin API', dash.status === 403, 'status ' + dash.status);

  const prof = await call('/api/account/profile', { auth: true });
  ok('the account area is reachable', prof.status === 200, prof.data?.error);
  ok('turnover starts at zero', prof.data?.stats?.exchanges === 0);

  const dup = await call('/api/auth/register', {
    method: 'POST',
    body: { login, email: 'other@example.com', password: 'a-long-enough-password', ...(await solveCaptcha()) }
  });
  ok('a duplicate login is refused', dup.status === 409, dup.data?.error);

  await call('/api/auth/logout', { auth: true, method: 'POST' });
}

/* ------------------------------------------------------- 14c. rate limiting
   Deliberately last: it exhausts the registration budget for the hour.   */
{
  let trippedAt = null;
  for (let i = 0; i < 8 && trippedAt === null; i++) {
    const r = await call('/api/auth/register', {
      method: 'POST',
      body: {
        login: 'rl' + Date.now().toString().slice(-5) + i,
        email: 'rl' + Date.now() + i + '@example.com',
        password: 'a-long-enough-password',
        ...(await solveCaptcha())
      }
    });
    if (r.status === 429) trippedAt = i;
  }
  ok('registration is rate limited', trippedAt !== null, 'never tripped in 8 attempts');
  ok('the limiter allows a few attempts first', trippedAt === null || trippedAt >= 1,
    `tripped immediately at attempt ${trippedAt}`);

  const after = await call('/api/auth/register', {
    method: 'POST',
    body: {
      login: 'rl-blocked', email: 'rl-blocked@example.com',
      password: 'a-long-enough-password', ...(await solveCaptcha())
    }
  });
  ok('the limiter keeps refusing once tripped', after.status === 429, `status ${after.status}`);
  ok('the refusal says when to retry', /Try again in \d+s/.test(after.data?.error || ''),
    after.data?.error);

  await resetLimits();
}

/* --------------------------------------------------------- 15. webhooks */
{
  const { status, data } = await call('/api/webhooks/crypto', {
    method: 'POST', body: { reference: orderId, type: 'deposit.confirmed', amount: '100' }
  });
  ok('an unsigned webhook is rejected', status === 401 && /Signature/.test(data.error || ''), data.error);

  const unknown = await call('/api/webhooks/nonsense', { method: 'POST', body: {} });
  ok('an unknown rail is rejected', unknown.status === 404);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
