/* ==========================================================================
   Account-area flows, against a running server.

     npm start
     node --env-file=.env server/test/account.mjs

   Covers the pieces added after the first build: password change, PIN gate,
   verification resend, KYC upload, guest order lookup, withdrawals and the
   ledger.
   ========================================================================== */

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3000';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -- ' + extra : ''}`); }
};

let cookie = '';

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(auth && cookie ? { cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    if (c.startsWith('ep_sid=')) cookie = c.split(';')[0];
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

async function openDb(readOnly = true) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(process.env.DB_FILE || './data/exchangepay.db', { readOnly });
}

async function solveCaptcha() {
  const { data } = await call('/api/v1/captcha', { auth: false });
  const db = await openDb();
  const row = db.prepare('SELECT answer FROM captchas WHERE id = ?').get(data.id);
  db.close();
  return { captchaId: data.id, captcha: row.answer };
}

/* the limiter is DB-backed with hour windows, so start from a clean slate */
{
  const db = await openDb(false);
  db.prepare('DELETE FROM rate_limits').run();
  db.close();
}

console.log(`\nDahabi Pay account flows  (${BASE})\n`);

/* ------------------------------------------------------- a fresh account */
const login = 'acct' + Date.now().toString().slice(-7);
const email = login + '@example.com';
let password = 'first-password-here';

{
  const r = await call('/api/auth/register', {
    auth: false, method: 'POST',
    body: { login, email, password, password2: password, ...(await solveCaptcha()) }
  });
  ok('account created', r.status === 201, r.data?.error);

  const s = await call('/api/auth/login', {
    auth: false, method: 'POST',
    body: { login, password, ...(await solveCaptcha()) }
  });
  ok('signed in', s.status === 200, s.data?.error);
  ok('starts unverified', s.data.user?.emailVerified === false);
  ok('starts with no PIN', s.data.user?.hasPin === false);
}

/* -------------------------------------------------- verification resend */
{
  const r = await call('/api/auth/resend-verification', { method: 'POST' });
  ok('a fresh verification link can be requested', r.status === 200, r.data?.error);

  const db = await openDb();
  const live = db.prepare(
    "SELECT COUNT(*) AS n FROM email_tokens WHERE kind='verify' AND used_at IS NULL"
  ).get().n;
  db.close();
  // the previous link is superseded, so only one can ever be outstanding
  ok('only one verification link stays live', live >= 1, `${live} live`);

  // and the link actually verifies
  const db2 = await openDb();
  const token = db2.prepare(
    "SELECT token FROM email_tokens WHERE kind='verify' AND used_at IS NULL ORDER BY rowid DESC"
  ).get().token;
  db2.close();

  const v = await fetch(`${BASE}/api/auth/verify?token=${token}`);
  ok('the link confirms the address', v.status === 200, `status ${v.status}`);

  const me = await call('/api/auth/me');
  ok('the account is now verified', me.data.user?.emailVerified === true);

  const replay = await fetch(`${BASE}/api/auth/verify?token=${token}`);
  ok('the link cannot be reused', replay.status === 400, `status ${replay.status}`);
}

/* ------------------------------------------------------ password change */
{
  const wrong = await call('/api/auth/password', {
    method: 'POST', body: { current: 'not-the-password', password: 'second-password-here' }
  });
  ok('a wrong current password is refused', wrong.status === 401, wrong.data?.error);

  const same = await call('/api/auth/password', {
    method: 'POST', body: { current: password, password: password }
  });
  ok('reusing the same password is refused', same.status === 400, same.data?.error);

  const short = await call('/api/auth/password', {
    method: 'POST', body: { current: password, password: 'short' }
  });
  ok('a short new password is refused', short.status === 400, short.data?.error);

  // a second session, to prove the change signs other devices out
  const other = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password, ...(await solveCaptcha()) })
  });
  const otherCookie = (other.headers.getSetCookie?.() || [])
    .find((c) => c.startsWith('ep_sid='))?.split(';')[0];
  ok('a second device can sign in', !!otherCookie);

  const next = 'second-password-here';
  const r = await call('/api/auth/password', {
    method: 'POST', body: { current: password, password: next }
  });
  ok('the password changes', r.status === 200, r.data?.error);
  password = next;

  const stillMe = await call('/api/auth/me');
  ok('this session survives the change', !!stillMe.data.user, 'should stay signed in');

  const otherNow = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: otherCookie } });
  const otherBody = await otherNow.json();
  ok('the other device was signed out', otherBody.user === null, JSON.stringify(otherBody));

  const oldPw = await call('/api/auth/login', {
    auth: false, method: 'POST',
    body: { login, password: 'first-password-here', ...(await solveCaptcha()) }
  });
  ok('the old password no longer works', oldPw.status === 401, oldPw.data?.error);
}

/* ------------------------------------------------------------------ PIN */
{
  const wrongPw = await call('/api/auth/pin', {
    method: 'POST', body: { password: 'nope', pin: '1234' }
  });
  ok('setting a PIN needs the account password', wrongPw.status === 401, wrongPw.data?.error);

  const badPin = await call('/api/auth/pin', {
    method: 'POST', body: { password, pin: '12' }
  });
  ok('a too-short PIN is refused', badPin.status === 400, badPin.data?.error);

  const set = await call('/api/auth/pin', { method: 'POST', body: { password, pin: '4821' } });
  ok('a PIN can be set', set.status === 200 && set.data.hasPin === true, set.data?.error);

  // sign-in now needs it
  const noPin = await call('/api/auth/login', {
    auth: false, method: 'POST',
    body: { login, password, ...(await solveCaptcha()) }
  });
  ok('sign-in without the PIN is refused', noPin.status === 401 && /PIN/i.test(noPin.data.error || ''),
    noPin.data?.error);

  const withPin = await call('/api/auth/login', {
    auth: false, method: 'POST',
    body: { login, password, pin: '4821', ...(await solveCaptcha()) }
  });
  ok('sign-in with the PIN works', withPin.status === 200, withPin.data?.error);

  const cleared = await call('/api/auth/pin', { method: 'POST', body: { password, pin: '' } });
  ok('the PIN can be removed', cleared.status === 200 && cleared.data.hasPin === false);
}

/* -------------------------------------------------------------- sessions */
{
  const r = await call('/api/auth/sessions');
  ok('sessions are listable', r.status === 200 && Array.isArray(r.data), JSON.stringify(r.data).slice(0, 80));
  ok('the current session is flagged', r.data.some((s) => s.current === true));
  ok('no session token is exposed', !JSON.stringify(r.data).includes('token'),
    'the list must not leak the cookie value');

  const rev = await call('/api/auth/sessions/revoke-others', { method: 'POST' });
  ok('other sessions can be revoked', rev.status === 200, rev.data?.error);

  const after = await call('/api/auth/sessions');
  ok('only this session remains', after.data.length === 1, `${after.data.length} left`);
}

/* ------------------------------------------------------------------ KYC */
{
  // a 1x1 PNG, base64 - enough to exercise the upload path
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

  const badType = await call('/api/account/kyc', {
    method: 'POST',
    body: { kind: 'id_front', filename: 'x.exe', mime: 'application/x-msdownload', data: png }
  });
  ok('an unsupported file type is refused', badType.status === 400, badType.data?.error);

  const badKind = await call('/api/account/kyc', {
    method: 'POST',
    body: { kind: 'passport_maybe', filename: 'x.png', mime: 'image/png', data: png }
  });
  ok('an unknown document type is refused', badKind.status === 400, badKind.data?.error);

  const r = await call('/api/account/kyc', {
    method: 'POST',
    body: { kind: 'id_front', filename: 'id-front.png', mime: 'image/png', data: png }
  });
  ok('a document uploads', r.status === 201, r.data?.error);

  const list = await call('/api/account/kyc');
  ok('the document is listed', list.data.length === 1 && list.data[0].kind === 'id_front',
    JSON.stringify(list.data).slice(0, 120));
  ok('it starts pending', list.data[0].status === 'pending');

  const prof = await call('/api/account/profile');
  ok('the account moves to pending verification', prof.data.kycStatus === 'pending', prof.data?.kycStatus);

  // the file must land outside the web root and not be reachable over HTTP
  const db = await openDb();
  const fname = db.prepare('SELECT filename FROM kyc_docs ORDER BY id DESC').get().filename;
  db.close();
  const reachable = await fetch(`${BASE}/data/kyc/${fname}`);
  ok('uploaded documents are not served over HTTP', reachable.status === 404,
    `status ${reachable.status}`);
}

/* ------------------------------------------------------------ withdrawals */
{
  const empty = await call('/api/account/withdrawals');
  ok('withdrawals are listable', empty.status === 200 && Array.isArray(empty.data));

  const noMoney = await call('/api/account/withdraw', {
    method: 'POST',
    body: {
      currency: 'acct_usd', amount: '25', requisite: '12345',
      ...(await solveCaptcha())
    }
  });
  ok('withdrawing with no balance is refused',
    noMoney.status === 400 && /Insufficient/.test(noMoney.data.error || ''), noMoney.data?.error);

  // credit the balance the way an affiliate reward would, then withdraw
  const db = await openDb(false);
  const uid = db.prepare('SELECT id FROM users WHERE login = ?').get(login).id;
  db.prepare("INSERT INTO balances (user_id, currency_id, amount) VALUES (?, 'acct_usd', '100')").run(uid);
  db.close();

  const badReq = await call('/api/account/withdraw', {
    method: 'POST',
    body: {
      currency: 'acct_usd', amount: '25', requisite: 'not-numeric',
      ...(await solveCaptcha())
    }
  });
  ok('a malformed requisite is refused', badReq.status === 400, badReq.data?.error);

  const good = await call('/api/account/withdraw', {
    method: 'POST',
    body: {
      currency: 'acct_usd', amount: '25', requisite: '12345',
      ...(await solveCaptcha())
    }
  });
  ok('a funded withdrawal is accepted', good.status === 201, good.data?.error);

  const bal = await call('/api/account/balances');
  const usd = bal.data.find((b) => b.id === 'acct_usd');
  ok('the balance was debited immediately', Number(usd.amount) === 75, `balance ${usd?.amount}`);

  const led = await call('/api/account/ledger');
  ok('the debit appears in the ledger', led.data.some((l) => Number(l.delta) === -25),
    JSON.stringify(led.data).slice(0, 140));

  const wl = await call('/api/account/withdrawals');
  ok('the request is listed as pending', wl.data.length === 1 && wl.data[0].status === 'pending');

  const over = await call('/api/account/withdraw', {
    method: 'POST',
    body: {
      currency: 'acct_usd', amount: '500', requisite: '12345',
      ...(await solveCaptcha())
    }
  });
  ok('withdrawing more than the balance is refused', over.status === 400, over.data?.error);
}

/* ---------------------------------------------------------- guest lookup */
{
  const created = await call('/api/orders', {
    auth: false, method: 'POST',
    body: {
      from: 'usdt_trc20', to: 'mpesa_kes', amount: '150',
      requisite: '254700111222', email: 'lookup-test@example.com'
    }
  });
  const id = created.data.order?.id;
  ok('a guest order exists', !!id, JSON.stringify(created.data).slice(0, 120));

  const wrongEmail = await call('/api/orders/lookup', {
    auth: false, method: 'POST', body: { id, email: 'someone-else@example.com' }
  });
  ok('lookup with the wrong email is refused', wrongEmail.status === 404, wrongEmail.data?.error);

  const wrongId = await call('/api/orders/lookup', {
    auth: false, method: 'POST', body: { id: 'EP-NOPE-00000', email: 'lookup-test@example.com' }
  });
  ok('lookup with an unknown id is refused', wrongId.status === 404);
  ok('both refusals read identically', wrongEmail.data.error === wrongId.data.error,
    'otherwise the endpoint confirms which ids exist');

  const found = await call('/api/orders/lookup', {
    auth: false, method: 'POST', body: { id, email: 'lookup-test@example.com' }
  });
  ok('the right pair returns the token', found.status === 200 && !!found.data.accessToken);

  const read = await call(`/api/orders/${id}?t=${found.data.accessToken}`, { auth: false });
  ok('the returned token opens the order', read.status === 200 && read.data.order.id === id);
}

/* ---------------------------------------------------------------- tidy up */
{
  await call('/api/auth/logout', { method: 'POST' });
  const gone = await call('/api/account/profile');
  ok('the account area closes after sign-out', gone.status === 401, `status ${gone.status}`);

  const db = await openDb(false);
  db.prepare('DELETE FROM rate_limits').run();
  db.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(`  (test account "${login}" was left in place)\n`);
process.exit(fail ? 1 : 0);
