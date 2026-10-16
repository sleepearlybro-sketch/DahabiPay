const $ = (selector) => document.querySelector(selector);
let email = '';
let resendUntil = 0;
let requests = [];
const statusLabels = { verified: 'Awaiting contact', contacted: 'Contacted', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
const statusDetails = {
  verified: 'Your request is with our team. We’ll contact you on WhatsApp.',
  contacted: 'Our team has reached out. Continue the conversation on WhatsApp.',
  in_progress: 'Your exchange is being handled with our team.',
  completed: 'This exchange has been marked complete.',
  cancelled: 'This request was cancelled.'
};
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
  authError();
  if (!$('#accountEmail').checkValidity()) { authError('Enter a valid email address.'); $('#accountEmail').focus(); return; }
  const button = $('#sendCode'); busy(button, true, 'Sending…');
  try {
    email = $('#accountEmail').value.trim().toLowerCase();
    const result = await api('/api/customer/auth/otp', { method: 'POST', body: JSON.stringify({ email }) });
    $('#sentEmail').textContent = result.email;
    $('#emailStage').classList.add('hidden'); $('#codeStage').classList.remove('hidden');
    cooldown(result.resendAfterSeconds || 60); $('#accountOtp').focus();
  } catch (error) { authError(error.message); }
  finally { busy(button, false); }
}
function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
function renderRequests() {
  const list = $('#requestList'); list.replaceChildren();
  const term = $('#requestSearch').value.trim().toLowerCase();
  const filter = $('#requestFilter').value;
  const shown = requests.filter((request) => (filter === 'all' || request.status === filter) && request.reference.toLowerCase().includes(term));
  if (!shown.length) {
    const empty = element('div', 'request-empty');
    empty.append(element('h4', '', requests.length ? 'No matching requests' : 'No requests yet'), element('p', '', requests.length ? 'Try a different reference or status.' : 'When you submit an exchange request, you’ll see it here.'));
    if (!requests.length) { const link = element('a', '', 'Create your first request →'); link.href = '/'; empty.append(link); }
    list.append(empty); return;
  }
  for (const request of shown) {
    const card = element('article', 'request-card');
    const top = element('div', 'request-card__top');
    const identity = element('div', 'request-card__identity');
    identity.append(element('span', 'request-card__caption', 'REQUEST REFERENCE'), element('strong', 'request-card__reference', request.reference));
    const status = element('span', `status-badge status-badge--${request.status}`, statusLabels[request.status] || request.status.replaceAll('_', ' '));
    top.append(identity, status);
    const amounts = element('div', 'request-card__amounts');
    const send = element('div', 'request-card__amount'); send.append(element('span', '', 'YOU SEND'), element('strong', '', `${request.send_usdt} USDT`));
    const arrow = element('span', 'request-card__arrow', '→'); arrow.setAttribute('aria-hidden', 'true');
    const receive = element('div', 'request-card__amount'); receive.append(element('span', '', 'YOU RECEIVE'), element('strong', '', `${request.receive_usd} Money Go USD`));
    amounts.append(send, arrow, receive);
    const bottom = element('div', 'request-card__bottom');
    bottom.append(element('p', '', statusDetails[request.status] || 'Contact our team if you need help with this request.'), element('time', '', formatDate(request.created_at)));
    bottom.querySelector('time').dateTime = request.created_at;
    card.append(top, amounts, bottom); list.append(card);
  }
}
function renderSummary() {
  const summary = $('#requestSummary'); summary.replaceChildren();
  const items = [
    ['Total requests', requests.length],
    ['Awaiting contact', requests.filter((request) => request.status === 'verified').length],
    ['Active', requests.filter((request) => ['contacted', 'in_progress'].includes(request.status)).length],
    ['Completed', requests.filter((request) => request.status === 'completed').length]
  ];
  for (const [label, count] of items) {
    const item = element('div', 'account-summary__item'); item.append(element('span', '', label), element('strong', '', String(count))); summary.append(item);
  }
}
async function showRequests(customer) {
  $('#signedInEmail').textContent = customer.email;
  $('#signIn').classList.add('hidden'); $('#requestsStage').classList.remove('hidden');
  $('#requestError').textContent = '';
  const list = $('#requestList'); list.replaceChildren(element('p', 'request-loading', 'Loading your requests…'));
  try {
    const result = await api('/api/customer/requests'); requests = result.requests;
    renderSummary(); renderRequests();
  } catch (error) { list.replaceChildren(); $('#requestError').textContent = error.message; }
}
$('#requestSearch').addEventListener('input', renderRequests);
$('#requestFilter').addEventListener('change', renderRequests);
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
