const $ = (selector) => document.querySelector(selector);
let email = '';
let resendUntil = 0;
async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Please try again');
  return body;
}
function busy(button, value, label) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = value;
  button.textContent = value ? label : button.dataset.label;
}
function authError(message = '') { $('#authError').textContent = message; }
function cooldown(seconds) {
  resendUntil = Date.now() + seconds * 1000;
  const tick = () => {
    const left = Math.max(0, Math.ceil((resendUntil - Date.now()) / 1000));
    $('#resendCode').disabled = left > 0;
    $('#resendCode').dataset.label = left ? `Resend in ${left}s` : 'Resend code';
    $('#resendCode').textContent = $('#resendCode').dataset.label;
    if (left) setTimeout(tick, 1000);
  };
  tick();
}
async function sendCode() {
  authError(); const button = $('#sendCode'); busy(button, true, 'Sending…');
  try {
    email = $('#accountEmail').value.trim().toLowerCase();
    const result = await api('/api/customer/auth/otp', { method: 'POST', body: JSON.stringify({ email }) });
    $('#sentEmail').textContent = result.email;
    $('#emailStage').classList.add('hidden'); $('#codeStage').classList.remove('hidden');
    cooldown(result.resendAfterSeconds || 60); $('#accountOtp').focus();
  } catch (error) { authError(error.message); }
  finally { busy(button, false); }
}
async function showRequests(customer) {
  $('#signedInEmail').textContent = customer.email;
  $('#signIn').classList.add('hidden'); $('#requestsStage').classList.remove('hidden');
  $('#requestError').textContent = '';
  const list = $('#requestList'); list.replaceChildren();
  const loading = document.createElement('p'); loading.className = 'muted'; loading.textContent = 'Loading requests…'; list.append(loading);
  try {
    const result = await api('/api/customer/requests'); list.replaceChildren();
    if (!result.requests.length) {
      const empty = document.createElement('div'); empty.className = 'account-card account-empty';
      const title = document.createElement('h3'); title.textContent = 'No requests yet';
      const detail = document.createElement('p'); detail.textContent = 'Once you submit an exchange request, it will appear here.';
      const link = document.createElement('a'); link.href = '/'; link.textContent = 'Create a request';
      empty.append(title, detail, link); list.append(empty); return;
    }
    for (const request of result.requests) {
      const card = document.createElement('article'); card.className = 'request-card';
      const top = document.createElement('div'); top.className = 'request-card__top';
      const reference = document.createElement('strong'); reference.textContent = request.reference;
      const status = document.createElement('span'); status.className = `status-badge status-badge--${request.status}`; status.textContent = request.status.replace('_', ' ');
      top.append(reference, status);
      const quote = document.createElement('p'); quote.textContent = `${request.send_usdt} USDT → ${request.receive_usd} Money Go USD`;
      const date = document.createElement('small'); date.textContent = `Submitted ${new Date(request.created_at).toLocaleString()}`;
      card.append(top, quote, date); list.append(card);
    }
  } catch (error) { list.replaceChildren(); $('#requestError').textContent = error.message; }
}
$('#sendCode').addEventListener('click', sendCode);
$('#accountEmail').addEventListener('keydown', (event) => { if (event.key === 'Enter') sendCode(); });
$('#verifyCode').addEventListener('click', async () => {
  authError(); const button = $('#verifyCode'); busy(button, true, 'Verifying…');
  try {
    const result = await api('/api/customer/auth/verify', { method: 'POST', body: JSON.stringify({ email, otp: $('#accountOtp').value }) });
    await showRequests(result.customer);
  } catch (error) { authError(error.message); }
  finally { busy(button, false); }
});
$('#accountOtp').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#verifyCode').click(); });
$('#changeEmail').addEventListener('click', () => { authError(); $('#codeStage').classList.add('hidden'); $('#emailStage').classList.remove('hidden'); $('#accountEmail').focus(); });
$('#resendCode').addEventListener('click', async () => {
  authError(); const button = $('#resendCode'); busy(button, true, 'Sending…');
  try { const result = await api('/api/customer/auth/otp', { method: 'POST', body: JSON.stringify({ email }) }); cooldown(result.resendAfterSeconds || 60); authError('A new code was sent.'); }
  catch (error) { authError(error.message); }
  finally { busy(button, false); button.disabled = Date.now() < resendUntil; }
});
$('#signOut').addEventListener('click', async () => {
  const button = $('#signOut'); busy(button, true, 'Signing out…');
  try { await api('/api/customer/auth/logout', { method: 'POST' }); location.reload(); }
  catch (error) { $('#requestError').textContent = error.message; busy(button, false); }
});
api('/api/customer/me').then((result) => showRequests(result.customer)).catch(() => {});
