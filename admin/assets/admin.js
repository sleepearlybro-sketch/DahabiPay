const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const state = { staff: null, settings: null, loginStep: 'email', currentId: null, poller: null };
async function api(path, options = {}) {
  const response = await fetch('/api/admin' + path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || 'Request failed'), body);
  return body;
}
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = (v) => v ? new Date(v).toLocaleString() : '—';
const money = (v, dp = 2) => Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const label = (v) => ({ verified: 'Verified', contacted: 'Contacted', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' })[v] || v;
function badge(status) { return '<span class="badge" data-status="' + esc(status) + '">' + esc(label(status)) + '</span>'; }

async function bootstrap() {
  try {
    const result = await api('/me'); state.staff = result.staff; enterApp();
  } catch { $('#login').classList.remove('hidden'); }
}
$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#loginButton'); button.disabled = true; $('#loginError').textContent = '';
  try {
    const email = $('#loginEmail').value;
    if (state.loginStep === 'email') {
      await api('/auth/otp', { method: 'POST', body: JSON.stringify({ email }) });
      state.loginStep = 'code'; $('#codeField').classList.remove('hidden'); $('#loginEmail').readOnly = true; button.textContent = 'Verify and sign in'; $('#loginCode').focus();
    } else {
      const result = await api('/auth/verify', { method: 'POST', body: JSON.stringify({ email, otp: $('#loginCode').value }) });
      state.staff = result.staff; enterApp();
    }
  } catch (error) { $('#loginError').textContent = error.message; }
  finally { button.disabled = false; }
});
async function enterApp() {
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#staffName').textContent = state.staff.displayName; $('#staffRole').textContent = state.staff.role;
  if (state.staff.role !== 'admin') $('[data-view="settings"]').classList.add('hidden');
  await Promise.all([loadDashboard(), loadRequests(), loadSettings()]);
  startLive();
}
$('#logout').addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); location.reload(); });
$$('aside nav button').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
function setView(view) {
  $$('aside nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  ['dashboard', 'requests', 'settings'].forEach((name) => $('#' + name + 'View').classList.toggle('hidden', name !== view));
  $('#pageTitle').textContent = ({ dashboard: 'Overview', requests: 'Exchange requests', settings: 'Settings' })[view];
}
async function loadDashboard() {
  const data = await api('/dashboard');
  $('#verifiedCount').textContent = data.counts.verified || 0; $('#contactedCount').textContent = data.counts.contacted || 0;
  $('#activeCount').textContent = data.counts.in_progress || 0; $('#completedCount').textContent = data.counts.completed || 0;
  renderTable($('#recent'), data.recent);
}
async function loadRequests() {
  const params = new URLSearchParams({ q: $('#search').value, status: $('#statusFilter').value, from: $('#fromDate').value, to: $('#toDate').value });
  const data = await api('/requests?' + params); renderTable($('#requestList'), data.requests);
}
function renderTable(target, rows) {
  if (!rows?.length) { target.innerHTML = '<div class="empty">No requests found.</div>'; return; }
  target.innerHTML = '<div style="overflow:auto"><table class="table"><thead><tr><th>Reference</th><th>Customer</th><th>Amount</th><th>Status</th><th>Received</th></tr></thead><tbody>' +
    rows.map((r) => '<tr data-id="' + esc(r.id) + '"><td><strong>' + esc(r.reference) + '</strong></td><td>' + esc(r.full_name) + '<br><small>' + esc(r.whatsapp) + '</small></td><td>' + money(r.send_usdt, 2) + ' USDT<br><small>' + money(r.receive_usd) + ' USD</small></td><td>' + badge(r.status) + '</td><td>' + esc(date(r.created_at)) + '</td></tr>').join('') +
    '</tbody></table></div>';
  $$('tr[data-id]', target).forEach((row) => row.addEventListener('click', () => openDetail(row.dataset.id)));
}
$('#filterBtn').addEventListener('click', loadRequests);
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRequests(); });
async function loadSettings() {
  const data = await api('/settings'); state.settings = data.settings;
  $('#settingRate').value = data.settings.rate || ''; $('#settingMin').value = data.settings.min_usdt || ''; $('#settingMax').value = data.settings.max_usdt || '';
  $('#settingEmail').value = data.settings.operations_email || ''; $('#settingMessage').value = data.settings.whatsapp_template || ''; $('#settingEnabled').checked = data.settings.accepting_requests;
}
$('#settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#settingsError').textContent = '';
  const button = event.submitter; button.disabled = true;
  try {
    const result = await api('/settings', { method: 'PATCH', body: JSON.stringify({ rate: $('#settingRate').value, minUsdt: $('#settingMin').value, maxUsdt: $('#settingMax').value, operationsEmail: $('#settingEmail').value, whatsappTemplate: $('#settingMessage').value, acceptingRequests: $('#settingEnabled').checked }) });
    state.settings = result.settings; $('#settingsError').style.color = '#3d7b00'; $('#settingsError').textContent = 'Settings saved.';
  } catch (e) { $('#settingsError').style.color = ''; $('#settingsError').textContent = e.message; }
  finally { button.disabled = false; }
});
async function openDetail(id) {
  state.currentId = id; const data = await api('/requests/' + id); const r = data.request;
  $('#detailRef').textContent = r.reference; $('#detailStatus').textContent = label(r.status); $('#detailStatus').dataset.status = r.status;
  const template = state.settings?.whatsapp_template || 'Hello {{name}}, this is Dahabi Pay regarding request {{reference}} for {{send}} USDT.';
  const message = template.replaceAll('{{name}}', r.full_name).replaceAll('{{reference}}', r.reference).replaceAll('{{send}}', r.send_usdt).replaceAll('{{receive}}', r.receive_usd);
  const next = { verified: ['contacted', 'cancelled'], contacted: ['in_progress', 'cancelled'], in_progress: ['completed', 'cancelled'] }[r.status] || [];
  const reopen = state.staff.role === 'admin' && ['completed', 'cancelled'].includes(r.status);
  $('#detailBody').innerHTML =
    '<div class="details"><div><small>Customer</small><strong>' + esc(r.full_name) + '</strong></div><div><small>Email</small>' + esc(r.email) + '</div><div><small>WhatsApp</small>' + esc(r.whatsapp) + '</div><div><small>Money Go account</small><strong>' + esc(r.moneygo_account) + '</strong></div><div><small>Immutable quote</small>' + money(r.send_usdt, 6) + ' USDT × ' + money(r.rate, 8) + '</div><div><small>Customer receives</small><strong>' + money(r.receive_usd) + ' USD</strong></div></div>' +
    (r.customer_note ? '<h3>Customer note</h3><p>' + esc(r.customer_note) + '</p>' : '') +
    '<div class="detail-actions"><a target="_blank" rel="noopener" href="https://wa.me/' + esc(r.whatsapp.replace('+', '')) + '?text=' + encodeURIComponent(message) + '">Open WhatsApp</a>' +
    next.map((s) => '<button data-status-action="' + s + '">' + (s === 'cancelled' ? 'Cancel' : 'Mark ' + label(s)) + '</button>').join('') +
    (reopen ? '<button data-status-action="contacted">Reopen request</button>' : '') + '</div>' +
    '<h3>Internal notes</h3><div>' + (data.notes.length ? data.notes.map((n) => '<p><strong>' + esc(n.staff_profiles?.display_name || 'Staff') + '</strong> · ' + esc(date(n.created_at)) + '<br>' + esc(n.body) + '</p>').join('') : '<p class="muted">No internal notes.</p>') + '</div>' +
    '<form class="note-form" id="noteForm"><input id="noteBody" maxlength="2000" placeholder="Add an internal note"><button>Add</button></form>' +
    '<h3>Activity</h3><div class="timeline">' + data.events.map((e) => '<p><strong>' + esc(e.event_type.replaceAll('.', ' ')) + '</strong><br><small>' + esc(date(e.created_at)) + (e.from_status ? ' · ' + esc(label(e.from_status)) + ' → ' + esc(label(e.to_status)) : '') + '</small></p>').join('') + '</div>';
  $$('[data-status-action]', $('#detailBody')).forEach((button) => button.addEventListener('click', () => changeStatus(button.dataset.statusAction, r.status)));
  $('#noteForm').addEventListener('submit', addNote);
  if (!$('#detailDialog').open) $('#detailDialog').showModal();
}
async function changeStatus(status, current) {
  let reason = '';
  if (['completed', 'cancelled'].includes(current)) {
    reason = prompt('Enter the required reason for reopening this request:') || '';
    if (!reason) return;
  } else if (status === 'cancelled') reason = prompt('Cancellation reason (optional):') || '';
  try { await api('/requests/' + state.currentId + '/status', { method: 'PATCH', body: JSON.stringify({ status, reason }) }); await refreshAll(); await openDetail(state.currentId); }
  catch (e) { alert(e.message); }
}
async function addNote(event) {
  event.preventDefault(); const body = $('#noteBody').value;
  try { await api('/requests/' + state.currentId + '/notes', { method: 'POST', body: JSON.stringify({ body }) }); await openDetail(state.currentId); }
  catch (e) { alert(e.message); }
}
$('#closeDetail').addEventListener('click', () => $('#detailDialog').close());
async function refreshAll() { await Promise.all([loadDashboard(), loadRequests()]); }
function startLive() {
  const events = new EventSource('/api/admin/events');
  events.addEventListener('request.created', refreshAll); events.addEventListener('request.updated', refreshAll);
  events.addEventListener('settings.updated', loadSettings);
  state.poller = setInterval(refreshAll, 30000);
}
bootstrap();
