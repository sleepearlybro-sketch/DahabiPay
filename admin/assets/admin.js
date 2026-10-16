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
const date = (v) => v ? new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
const money = (v, dp = 2) => Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const label = (v) => ({ verified: 'Verified', contacted: 'Contacted', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' })[v] || v;
function badge(status) { return '<span class="badge" data-status="' + esc(status) + '">' + esc(label(status)) + '</span>'; }
const initials = (value) => String(value || 'D').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

$$('[data-password-toggle]').forEach((button) => button.addEventListener('click', () => {
  const input = $('#' + button.dataset.passwordToggle);
  const showing = input.type === 'password';
  input.type = showing ? 'text' : 'password';
  button.textContent = showing ? 'Hide' : 'Show';
  button.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
  button.setAttribute('aria-pressed', String(showing));
  input.focus();
}));

async function bootstrap() {
  try {
    const result = await api('/auth/setup-state'); state.staff = result.staff;
    if (!state.staff.passwordEnabled) showSetup(); else enterApp();
  } catch { $('#login').classList.remove('hidden'); }
}
function showSetup() { $('#login').classList.remove('hidden'); $('#loginForm').classList.add('hidden'); $('#setupForm').classList.remove('hidden'); }
$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = $('#loginButton'); button.disabled = true; $('#loginError').textContent = '';
  try {
    const identifier = $('#loginEmail').value;
    if (state.loginStep === 'email') {
      await api('/auth/otp', { method: 'POST', body: JSON.stringify({ identifier, password: $('#loginPassword').value }) });
      state.loginStep = 'code'; $('#codeField').classList.remove('hidden'); $('#passwordField').classList.add('hidden'); $('#loginEmail').readOnly = true; button.textContent = 'Verify and sign in'; $('#loginCode').focus();
    } else {
      const result = await api('/auth/verify', { method: 'POST', body: JSON.stringify({ identifier, otp: $('#loginCode').value }) });
      state.staff = result.staff; if (!state.staff.passwordEnabled) showSetup(); else enterApp();
    }
  } catch (error) { $('#loginError').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#setupForm').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#setupError').textContent = ''; const button = event.submitter; button.disabled = true;
  try {
    const result = await api('/auth/setup', { method: 'POST', body: JSON.stringify({ username: $('#setupUsername').value, password: $('#setupPassword').value }) });
    state.staff = result.staff; $('#setupForm').classList.add('hidden'); enterApp();
  } catch (error) { $('#setupError').textContent = error.message; }
  finally { button.disabled = false; }
});
async function enterApp() {
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#staffName').textContent = state.staff.displayName; $('#staffRole').textContent = state.staff.role;
  $('#staffAvatar').textContent = $('#topAvatar').textContent = initials(state.staff.displayName);
  $('#todayLabel').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (state.staff.role !== 'admin') {
    $('[data-view="settings"]').classList.add('hidden');
    $('[data-view="staff"]').classList.add('hidden');
    $$('#noticeSettings, #offerManage, [data-open-settings]').forEach((button) => button.classList.add('hidden'));
    $('.settings-lock').classList.add('hidden');
  }
  await Promise.all([loadDashboard(), loadRequests(), loadSettings()]);
  startLive();
}
$('#logout').addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); location.reload(); });
$$('aside nav button').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$$('[data-open-requests]').forEach((button) => button.addEventListener('click', () => setView('requests')));
$$('[data-open-settings]').forEach((button) => button.addEventListener('click', () => setView('settings')));
$('#mobileMenu').addEventListener('click', () => $('#sidebar').classList.toggle('is-open'));
function setView(view) {
  $$('aside nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  ['dashboard', 'requests', 'settings', 'staff'].forEach((name) => $('#' + name + 'View').classList.toggle('hidden', name !== view));
  $('#crumbTitle').textContent = ({ dashboard: 'Overview', requests: 'Exchange requests', settings: 'Settings', staff: 'Staff accounts' })[view];
  $('#sidebar').classList.remove('is-open');
  if (view === 'requests') loadRequests();
  if (view === 'staff') loadStaff();
}
async function loadStaff() {
  const data = await api('/staff');
  $('#staffList').innerHTML = '<table class="table"><thead><tr><th>NAME</th><th>USERNAME</th><th>EMAIL</th><th>ROLE</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>' + data.staff.map((s) => '<tr><td>' + esc(s.displayName) + '</td><td>' + esc(s.username || '—') + '</td><td>' + esc(s.email) + '</td><td>' + esc(s.role) + '</td><td>' + (s.active ? 'Active' : 'Disabled') + '</td><td>' + (s.id === state.staff.id ? 'Your account' : '<button class="button button--light" data-staff-id="' + esc(s.id) + '" data-staff-active="' + s.active + '">' + (s.active ? 'Disable' : 'Activate') + '</button>') + '</td></tr>').join('') + '</tbody></table>';
  $$('[data-staff-id]', $('#staffList')).forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await api('/staff/' + button.dataset.staffId, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.staffActive !== 'true' }) }); await loadStaff(); }
    catch (error) { alert(error.message); button.disabled = false; }
  }));
}
$('#staffForm').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#staffError').textContent = ''; const button = event.submitter; button.disabled = true;
  try {
    await api('/staff', { method: 'POST', body: JSON.stringify({ displayName: $('#staffDisplayName').value, username: $('#staffUsername').value, email: $('#staffEmail').value, role: $('#staffRoleSelect').value, password: $('#staffPassword').value }) });
    $('#staffForm').reset(); $('#staffError').style.color = '#16834b'; $('#staffError').textContent = 'Staff account created.'; await loadStaff();
  } catch (error) { $('#staffError').style.color = ''; $('#staffError').textContent = error.message; }
  finally { button.disabled = false; }
});
async function loadDashboard() {
  const data = await api('/dashboard');
  $('#verifiedCount').textContent = data.counts.verified || 0; $('#contactedCount').textContent = data.counts.contacted || 0;
  $('#activeCount').textContent = data.counts.in_progress || 0; $('#completedCount').textContent = data.counts.completed || 0;
  $('#navRequestCount').textContent = (data.counts.verified || 0) + (data.counts.contacted || 0) + (data.counts.in_progress || 0);
  renderTable($('#recent'), data.recent);
}
async function loadRequests() {
  const params = new URLSearchParams({ q: $('#search').value, status: $('#statusFilter').value, from: $('#fromDate').value, to: $('#toDate').value });
  const data = await api('/requests?' + params); $('#requestTotal').textContent = data.total; renderTable($('#requestList'), data.requests);
}
function renderTable(target, rows) {
  if (!rows?.length) { target.innerHTML = '<div class="empty"><strong>No requests yet</strong><span>Verified customer requests will appear here after submission.</span></div>'; return; }
  target.innerHTML = '<table class="table"><thead><tr><th>REFERENCE</th><th>CUSTOMER</th><th>YOU SEND</th><th>THEY RECEIVE</th><th>STATUS</th><th>RECEIVED</th></tr></thead><tbody>' +
    rows.map((r) => '<tr data-id="' + esc(r.id) + '"><td class="table__ref">' + esc(r.reference) + '</td><td><div class="table__customer"><span class="table__customer-avatar">' + esc(initials(r.full_name)) + '</span><span><strong>' + esc(r.full_name) + '</strong><small>' + esc(r.email) + '</small></span></div></td><td class="table__amount"><strong>' + money(r.send_usdt, 2) + ' USDT</strong><small>TRC20</small></td><td class="table__amount"><strong>' + money(r.receive_usd) + ' USD</strong><small>Money Go</small></td><td>' + badge(r.status) + '</td><td>' + esc(date(r.created_at)) + '</td></tr>').join('') +
    '</tbody></table>';
  $$('tr[data-id]', target).forEach((row) => row.addEventListener('click', () => openDetail(row.dataset.id)));
}
$('#filterBtn').addEventListener('click', loadRequests);
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRequests(); });
$('#globalSearch').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.currentTarget.value.trim()) {
    $('#search').value = event.currentTarget.value.trim(); event.currentTarget.value = ''; setView('requests');
  }
});
$('.global-search').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 560px)').matches) {
    $('.global-search').classList.add('is-open'); $('#globalSearch').focus();
  }
});
async function loadSettings() {
  const data = await api('/settings'); state.settings = data.settings;
  $('#settingRate').value = data.settings.rate || ''; $('#settingMin').value = data.settings.min_usdt || ''; $('#settingMax').value = data.settings.max_usdt || '';
  $('#settingEmail').value = data.settings.operations_email || ''; $('#settingMessage').value = data.settings.whatsapp_template || ''; $('#settingEnabled').checked = data.settings.accepting_requests;
  renderOffer(); renderServiceStatus();
}
function renderOffer() {
  const settings = state.settings || {};
  $('#offerRate').textContent = Number(settings.rate) > 0 ? money(settings.rate, 4) : 'Not set';
  $('#offerMin').textContent = Number(settings.min_usdt) > 0 ? money(settings.min_usdt, 2) + ' USDT' : '—';
  $('#offerMax').textContent = Number(settings.max_usdt) > 0 ? money(settings.max_usdt, 2) + ' USDT' : '—';
}
function renderServiceStatus() {
  const settings = state.settings || {};
  const configured = Number(settings.rate) > 0 && Number(settings.min_usdt) > 0 && Number(settings.max_usdt) >= Number(settings.min_usdt);
  const enabled = Boolean(settings.accepting_requests && configured);
  $('#dashboardAvailability').textContent = !configured ? 'Setup needed' : enabled ? 'Accepting requests' : 'Paused';
  $('#dashboardAvailability').classList.toggle('offer-state--on', enabled);
  $('#sidebarServiceState').textContent = !configured ? 'Setup required' : enabled ? 'Accepting requests' : 'Requests paused';
  $('#sidebarStatusHint').textContent = !configured ? 'Set a valid rate and amount range' : enabled ? 'Customers can submit requests' : 'Customers cannot submit requests';
  $('#sidebarStatusDot').classList.toggle('is-on', enabled);
  $('#serviceNotice').classList.toggle('hidden', enabled);
  if (!configured) $('#serviceNoticeText').textContent = 'Set a customer rate and valid amount limits before enabling the service.';
  else $('#serviceNoticeText').textContent = 'Customers can’t submit an exchange until the service is enabled.';
}
$('#settingsForm').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#settingsError').textContent = '';
  const button = event.submitter; button.disabled = true;
  try {
    const result = await api('/settings', { method: 'PATCH', body: JSON.stringify({ rate: $('#settingRate').value, minUsdt: $('#settingMin').value, maxUsdt: $('#settingMax').value, operationsEmail: $('#settingEmail').value, whatsappTemplate: $('#settingMessage').value, acceptingRequests: $('#settingEnabled').checked }) });
    state.settings = result.settings; $('#settingsError').style.color = '#16834b'; $('#settingsError').textContent = 'Settings saved.'; renderOffer(); renderServiceStatus();
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
  events.addEventListener('settings.updated', () => { loadSettings(); loadDashboard(); });
  state.poller = setInterval(refreshAll, 30000);
}
bootstrap();
