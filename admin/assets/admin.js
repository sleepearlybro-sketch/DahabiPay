/* ==========================================================================
   Operator panel.

   Hash-routed, no build step. Every figure comes from /api/admin/*, which is
   gated by requireRole('operator'); this file holds no authority of its own -
   hiding a button here is a convenience, not a permission.
   ========================================================================== */

const $ = (s, r = document) => r.querySelector(s);
const view = $('[data-view]');
const nav = $('[data-nav]');

let me = null;
let dash = null;

/* -------------------------------------------------------------------- api */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });

  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }

  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.field = data?.field;
    throw err;
  }
  return data;
}

/* ----------------------------------------------------------------- utils */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = (v, dp = 2) => {
  const n = Number(v);
  if (!isFinite(n)) return esc(v);
  return n.toLocaleString('en-GB', { maximumFractionDigits: dp });
};

const when = (iso) => {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
};

const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const STATUS_TAG = {
  created: 'tag--info', awaiting_payment: 'tag--wait', payment_detected: 'tag--info',
  processing: 'tag--wait', completed: 'tag--ok', expired: 'tag--err',
  cancelled: 'tag--err', on_hold: 'tag--wait', refunded: 'tag--err'
};
const tag = (status, label) =>
  `<span class="tag ${STATUS_TAG[status] || 'tag--info'}">${esc(label || status)}</span>`;

function toast(msg, kind) {
  const box = $('.toasts');
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' toast--' + kind : '');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

/* ----------------------------------------------------------------- modal
   Anything that moves money goes through here, so a reason always reaches
   the audit log and a destructive action needs the word typed out.       */
/** One row of the confirm dialog: a text input, or a select when `options` is given. */
function fieldHtml(f) {
  const control = f.options
    ? `<select class="input" data-mf="${esc(f.name)}">` +
      f.options.map((o) =>
        `<option value="${esc(o)}"${o === f.value ? ' selected' : ''}>${esc(o)}</option>`).join('') +
      `</select>`
    : `<input class="input" data-mf="${esc(f.name)}" value="${esc(f.value ?? '')}" ` +
      `placeholder="${esc(f.placeholder ?? '')}" autocomplete="off">`;

  return `<div class="form__field">
    <label>${esc(f.label)}${f.required ? ' <i>*</i>' : ''}</label>
    ${control}
    ${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}
  </div>`;
}

function confirmAction({ title, body, reason = true, confirmWord = null, fields = [] }) {
  const modal = $('[data-modal]');
  $('[data-modal-title]').textContent = title;
  $('[data-modal-body]').innerHTML = body || '';

  // Extra inputs render here, so nothing in this panel needs window.prompt -
  // which is unstyled, drops the surrounding context, and is blocked outright
  // in some embedded browsers.
  $('[data-modal-fields]').innerHTML = fields.map(fieldHtml).join('');

  $('[data-modal-reason-wrap]').hidden = !reason;
  $('[data-modal-reason]').value = '';
  $('[data-modal-confirm-wrap]').hidden = !confirmWord;
  $('[data-modal-confirm]').value = '';
  if (confirmWord) $('[data-modal-word]').textContent = confirmWord;
  modal.hidden = false;
  ($('[data-modal-fields] [data-mf]') ||
   (reason ? $('[data-modal-reason]') : $('[data-modal-ok]'))).focus();

  return new Promise((resolve) => {
    const close = (result) => {
      modal.hidden = true;
      $('[data-modal-ok]').onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      // Enter submits from any field in the dialog
      if (e.key === 'Enter' && e.target.closest('.adm__modal-box')) {
        e.preventDefault();
        $('[data-modal-ok]').click();
      }
    };

    $('[data-modal-ok]').onclick = () => {
      const r = $('[data-modal-reason]').value.trim();
      if (reason && !r) return toast('A reason is required', 'err');
      if (confirmWord && $('[data-modal-confirm]').value.trim() !== confirmWord) {
        return toast(`Type "${confirmWord}" to confirm`, 'err');
      }
      const values = {};
      for (const el of modal.querySelectorAll('[data-mf]')) values[el.dataset.mf] = el.value.trim();
      for (const f of fields) {
        if (f.required && !values[f.name]) return toast(`${f.label} is required`, 'err');
      }
      close({ reason: r, values });
    };
    modal.querySelectorAll('[data-modal-cancel]').forEach((b) => { b.onclick = () => close(null); });
    document.addEventListener('keydown', onKey);
  });
}

/** Run an API call with a spinner-ish guard and uniform error reporting. */
async function act(fn, okMsg) {
  try {
    const out = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return out;
  } catch (err) {
    toast(err.message, 'err');
    throw err;
  }
}

/* ---------------------------------------------------------------- screens */
const screens = {};

/* ------------------------------------------------------------- dashboard */
screens[''] = screens['/'] = async () => {
  dash = await api('/admin/dashboard');
  paintBadges();

  const o = dash.orders || {};
  const alerts = [];

  if (dash.maintenance) {
    alerts.push(['warn', 'Maintenance mode is on', 'Customers cannot create new orders.']);
  }
  if (dash.rates.lastError) {
    alerts.push(['err', 'Rate feed is failing', esc(dash.rates.lastError)]);
  }
  if (dash.rates.stale.length) {
    alerts.push(['err', `${dash.rates.stale.length} currencies have a stale pivot`,
      'Those directions refuse to quote rather than serving an old price: ' +
      dash.rates.stale.map((c) => esc(c.code)).join(', ')]);
  }
  for (const [kind, p] of Object.entries(dash.payments)) {
    if (!p.live) {
      alerts.push(['warn', `${kind} payouts are manual`,
        p.missing.length
          ? `Provider "${esc(p.provider)}" is missing ${p.missing.join(', ')}. Payouts queue for an operator.`
          : 'Payouts queue for an operator by configuration.']);
    }
  }
  for (const w of dash.warnings || []) alerts.push(['warn', 'Configuration', esc(w)]);
  if (dash.lowReserve.length) {
    alerts.push(['warn', `${dash.lowReserve.length} reserves are low`,
      dash.lowReserve.map((c) => `${esc(c.label)}: ${num(c.available)} ${esc(c.code)}`).join(' &middot; ')]);
  }

  view.innerHTML = `
    <div class="adm__head">
      <div><h2>Dashboard</h2><p>Rates refreshed ${ago(dash.rates.lastRun)}</p></div>
      <div class="adm__actions">
        <button class="btn btn--sm btn--ghost" data-do="refresh-rates">Refresh rates now</button>
        <a class="btn btn--sm" href="#/orders?attention=1">Needs attention (${dash.needsAttention})</a>
      </div>
    </div>

    ${alerts.map(([k, t, b]) =>
      `<div class="adm__alert adm__alert--${k}"><div><b>${t}</b>${b}</div></div>`).join('')}

    <div class="adm__cards">
      ${card('Awaiting payment', o.awaiting_payment || 0)}
      ${card('Payment detected', o.payment_detected || 0)}
      ${card('Processing', o.processing || 0)}
      ${card('On hold', o.on_hold || 0)}
      ${card('Completed 24h', dash.completed24h || 0)}
      ${card('Volume 24h', '$' + num(dash.volume24hUsd))}
      ${card('Users', dash.users || 0)}
      ${card('Pending KYC', dash.pendingKyc || 0)}
    </div>

    <div class="adm__panel">
      <h3>Queue</h3>
      <div class="table-wrap" style="box-shadow:none">
        <table class="tbl tbl--dense"><thead><tr>
          <th>Order</th><th>Direction</th><th>Send</th><th>Receive</th><th>Status</th><th>Age</th><th></th>
        </tr></thead><tbody data-queue><tr><td colspan="7" class="center muted">Loading…</td></tr></tbody></table>
      </div>
    </div>`;

  const q = await api('/admin/orders?attention=1&limit=15');
  $('[data-queue]').innerHTML = q.orders.length
    ? q.orders.map(orderRow).join('')
    : '<tr><td colspan="7" class="center muted" style="padding:22px">Nothing waiting. All clear.</td></tr>';
};

const card = (label, value) =>
  `<div class="stat"><span>${label}</span><b>${value}</b></div>`;

const orderRow = (o) => `
  <tr>
    <td><a href="#/orders/${esc(o.id)}"><b>${esc(o.id)}</b></a><br>
        <span class="small muted">${esc(o.email || '')}</span></td>
    <td class="small">${esc(o.from || '?')}<br>&#8594; ${esc(o.to || '?')}</td>
    <td class="mono">${num(o.send, 8)} ${esc(o.fromCode || '')}</td>
    <td class="mono">${num(o.recv)} ${esc(o.toCode || '')}</td>
    <td>${tag(o.status, o.statusLabel)}${o.holdReason ? `<br><span class="small muted">${esc(o.holdReason)}</span>` : ''}</td>
    <td class="small muted">${ago(o.createdAt)}</td>
    <td><a class="btn btn--sm btn--ghost" href="#/orders/${esc(o.id)}">Open</a></td>
  </tr>`;

/* ---------------------------------------------------------------- orders */
screens['/orders'] = async (params) => {
  const qs = new URLSearchParams();
  for (const k of ['status', 'q', 'attention', 'page']) if (params.get(k)) qs.set(k, params.get(k));
  qs.set('limit', '40');

  view.innerHTML = `
    <div class="adm__head"><div><h2>Orders</h2><p>Every application, newest first</p></div></div>
    <div class="adm__filters">
      <input type="search" data-f="q" placeholder="Order id, email, requisite or tx hash…" value="${esc(params.get('q') || '')}">
      <select data-f="status">
        <option value="">All statuses</option>
        ${['created', 'awaiting_payment', 'payment_detected', 'processing', 'completed', 'on_hold', 'expired', 'cancelled', 'refunded']
          .map((s) => `<option value="${s}"${params.get('status') === s ? ' selected' : ''}>${s.replace(/_/g, ' ')}</option>`).join('')}
      </select>
      <label class="check" style="font-size:13px"><input type="checkbox" data-f="attention" value="1"${params.get('attention') === '1' ? ' checked' : ''}><span>Needs attention only</span></label>
      <span class="adm__count" data-count></span>
    </div>
    <div class="table-wrap">
      <table class="tbl tbl--dense"><thead><tr>
        <th>Order</th><th>Direction</th><th>Send</th><th>Receive</th><th>Status</th><th>Age</th><th></th>
      </tr></thead><tbody data-rows><tr><td colspan="7" class="center muted">Loading…</td></tr></tbody></table>
    </div>
    <div style="margin-top:14px" data-pager></div>`;

  const data = await api('/admin/orders?' + qs);
  $('[data-count]').textContent = `${data.total} orders`;
  $('[data-rows]').innerHTML = data.orders.length
    ? data.orders.map(orderRow).join('')
    : '<tr><td colspan="7" class="center muted" style="padding:26px">No orders match that filter</td></tr>';

  const pages = Math.ceil(data.total / data.limit);
  if (pages > 1) {
    $('[data-pager]').innerHTML = Array.from({ length: Math.min(pages, 12) }, (_, i) => {
      const p = i + 1;
      const u = new URLSearchParams(qs); u.set('page', p);
      return `<a class="btn btn--sm ${p === data.page ? '' : 'btn--ghost'}" href="#/orders?${u}">${p}</a>`;
    }).join(' ');
  }

  // filters drive the hash, so a filtered view is linkable and survives reload
  const apply = () => {
    const u = new URLSearchParams();
    const q = $('[data-f="q"]').value.trim();
    const st = $('[data-f="status"]').value;
    if (q) u.set('q', q);
    if (st) u.set('status', st);
    if ($('[data-f="attention"]').checked) u.set('attention', '1');
    location.hash = '#/orders' + (u.toString() ? '?' + u : '');
  };
  $('[data-f="status"]').onchange = apply;
  $('[data-f="attention"]').onchange = apply;
  $('[data-f="q"]').onkeydown = (e) => { if (e.key === 'Enter') apply(); };
};

/* ---------------------------------------------------------- order detail */
screens['/orders/:id'] = async (_params, id) => {
  const { order: o, events, webhooks, payoutClaimed } = await api(`/admin/orders/${encodeURIComponent(id)}`);

  const can = (s) => o.allowedTransitions.includes(s);
  const buttons = [];

  if (can('payment_detected')) buttons.push(['mark_paid', 'Mark as paid', 'btn--ghost']);
  if (o.status === 'payment_detected' || o.status === 'on_hold') buttons.push(['settle', 'Pay out now', '']);
  if (o.status === 'processing') buttons.push(['complete', 'Confirm payout sent', '']);
  if (can('on_hold')) buttons.push(['hold', 'Put on hold', 'btn--ghost']);
  if (o.status === 'on_hold') buttons.push(['resume', 'Lift hold', 'btn--ghost']);
  if (can('refunded')) buttons.push(['refund', 'Refund', 'btn--danger']);
  if (can('cancelled')) buttons.push(['cancel', 'Cancel', 'btn--danger']);
  if (o.status === 'expired') buttons.push(['requote', 'Re-quote', 'btn--ghost']);

  view.innerHTML = `
    <div class="adm__head">
      <div>
        <h2>${esc(o.id)} ${tag(o.status, o.statusLabel)}</h2>
        <p>${esc(o.fromLabel)} &#8594; ${esc(o.toLabel)} &middot; created ${when(o.created_at)}</p>
      </div>
      <a class="btn btn--sm btn--ghost" href="#/orders">Back to orders</a>
    </div>

    ${o.hold_reason ? `<div class="adm__alert adm__alert--warn"><div><b>On hold</b>${esc(o.hold_reason)}</div></div>` : ''}
    ${o.cancel_reason ? `<div class="adm__alert adm__alert--err"><div><b>Closed</b>${esc(o.cancel_reason)}</div></div>` : ''}
    ${payoutClaimed ? `<div class="adm__alert adm__alert--ok"><div><b>Payout claimed</b>This order holds a payout lock, so it cannot be paid twice.</div></div>` : ''}

    <div class="adm__split">
      <div>
        <div class="adm__panel">
          <h3>Actions</h3>
          <div class="adm__actions">
            ${buttons.map(([a, label, cls]) =>
              `<button class="btn btn--sm ${cls}" data-act="${a}">${label}</button>`).join('') ||
              '<span class="muted small">This order is closed. No actions remain.</span>'}
          </div>
        </div>

        <div class="adm__panel">
          <h3>Money</h3>
          <div class="kv">
            <div><span>Customer sends</span><b>${num(o.send_amount, 8)} ${esc(o.fromLabel)}</b></div>
            <div><span>Customer receives</span><b>${num(o.recv_amount)} ${esc(o.toLabel)}</b></div>
            <div><span>Locked rate</span><b>${num(o.rate, 8)}</b></div>
            <div><span>Fee</span><b>${(o.fee_bp / 100).toFixed(2)}%</b></div>
            <div><span>Quote locked until</span><b>${when(o.lock_expires_at)}</b></div>
            ${o.rate_reaccepted_at ? `<div><span>Rate re-accepted</span><b>${when(o.rate_reaccepted_at)}</b></div>` : ''}
            ${o.paid_amount ? `<div><span>Amount actually received</span><b>${num(o.paid_amount, 8)}</b></div>` : ''}
          </div>
        </div>

        <div class="adm__panel">
          <h3>Timeline</h3>
          <ul class="timeline">
            ${events.map((e) => `<li>
              <b>${esc(e.to_status.replace(/_/g, ' '))}</b>
              <span>${when(e.created_at)} &middot; ${esc(e.actor)}</span>
              ${e.detail ? `<em>${esc(e.detail)}</em>` : ''}
            </li>`).join('')}
          </ul>
        </div>

        ${webhooks.length ? `<div class="adm__panel">
          <h3>Provider callbacks</h3>
          <div class="table-wrap" style="box-shadow:none">
            <table class="tbl tbl--dense" style="min-width:520px"><thead><tr>
              <th>When</th><th>Provider</th><th>Event</th><th>Accepted</th><th>Reason</th>
            </tr></thead><tbody>
              ${webhooks.map((w) => `<tr>
                <td class="small">${when(w.received_at)}</td>
                <td class="small">${esc(w.provider)}</td>
                <td class="small">${esc(w.event || '')}</td>
                <td>${w.accepted ? '<span class="tag tag--ok">yes</span>' : '<span class="tag tag--err">no</span>'}</td>
                <td class="small muted">${esc(w.reason || '')}</td>
              </tr>`).join('')}
            </tbody></table>
          </div>
        </div>` : ''}
      </div>

      <aside>
        <div class="adm__panel">
          <h3>Customer</h3>
          <div class="kv">
            <div><span>Email</span><b>${esc(o.email)}</b></div>
            <div><span>Receiving requisite</span><b style="word-break:break-all">${esc(o.requisite)}</b></div>
            ${o.holder ? `<div><span>Account holder</span><b>${esc(o.holder)}</b></div>` : ''}
            <div><span>Account</span><b>${o.user_id ? `<a href="#/users/${o.user_id}">#${o.user_id}</a>` : 'guest'}</b></div>
            <div><span>IP</span><b>${esc(o.ip || '-')}</b></div>
          </div>
          ${o.note ? `<p class="small muted" style="margin-top:12px"><b>Note:</b> ${esc(o.note)}</p>` : ''}
        </div>

        <div class="adm__panel">
          <h3>Payment</h3>
          <div class="kv">
            <div><span>Provider</span><b>${esc(o.provider || '-')}</b></div>
            <div><span>Deposit address</span><b style="word-break:break-all">${esc(o.deposit_address || '-')}</b></div>
            ${o.deposit_memo ? `<div><span>Memo</span><b>${esc(o.deposit_memo)}</b></div>` : ''}
            <div><span>Tx hash</span><b style="word-break:break-all">${esc(o.tx_hash || '-')}</b></div>
            <div><span>Payout ref</span><b>${esc(o.payout_ref || '-')}</b></div>
          </div>
        </div>
      </aside>
    </div>`;

  view.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = () => orderAction(id, btn.dataset.act, o);
  });
};

const NEEDS_REASON = new Set(['hold', 'cancel', 'refund']);
const NEEDS_TYPED = { refund: 'REFUND', cancel: 'CANCEL', settle: 'PAY' };

async function orderAction(id, action, order) {
  const copy = {
    mark_paid: ['Mark as paid', 'Confirms the incoming payment was received. This does not pay the customer out.'],
    settle: ['Pay out now', `Sends ${num(order.recv_amount)} ${order.toLabel} to <b>${esc(order.requisite)}</b>. A payout lock is taken first, so this cannot run twice.`],
    complete: ['Confirm payout sent', 'Marks the order complete and spends the held reserve. Use this after sending a manual transfer.'],
    hold: ['Put on hold', 'Stops automated processing until the hold is lifted.'],
    resume: ['Lift hold', 'Returns the order to its previous stage.'],
    cancel: ['Cancel order', 'Closes the order and releases its reserve hold. This cannot be undone.'],
    refund: ['Refund order', 'Marks the order refunded and releases its reserve hold. Record the outgoing transfer separately.'],
    requote: ['Re-quote', 'Re-prices the order at the current rate and takes a fresh reserve hold.']
  }[action];

  const needsReason = NEEDS_REASON.has(action);
  const typed = NEEDS_TYPED[action];

  const fields = [];
  if (action === 'mark_paid') {
    fields.push({
      name: 'txHash', label: 'Transaction hash or payment reference',
      value: order.tx_hash || '', placeholder: 'optional',
      hint: 'Recorded on the order so the payment can be traced later.'
    });
    fields.push({
      name: 'paidAmount', label: 'Amount actually received', placeholder: 'optional',
      hint: `Leave blank if the full ${order.send_amount} arrived.`
    });
  }
  if (action === 'complete') {
    fields.push({
      name: 'payoutRef', label: 'Payout reference',
      value: order.payout_ref || '', placeholder: 'optional',
      hint: 'The provider or bank reference for the transfer you sent.'
    });
  }

  const ok = await confirmAction({
    title: copy[0], body: copy[1], reason: needsReason, confirmWord: typed, fields
  });
  if (!ok) return;

  const body = { action };
  if (ok.reason) body.reason = ok.reason;
  for (const [k, v] of Object.entries(ok.values || {})) if (v) body[k] = v;

  const out = await act(() => api(`/admin/orders/${encodeURIComponent(id)}/action`, { method: 'POST', body }));

  // settle reports what the provider actually did, which is not always "paid"
  if (out?.result) {
    const a = out.result.action;
    const msg = {
      queued_for_operator: 'Queued for manual payout - confirm it once sent',
      submitted: 'Payout submitted to the provider',
      completed: 'Payout confirmed - order completed',
      already_claimed: 'A payout is already in flight for this order',
      already_completed: 'This order is already complete',
      payout_failed: `Payout failed: ${out.result.error}`,
      wrong_status: `Order is ${out.result.status}, cannot pay out from there`
    }[a] || a;
    toast(msg, a === 'payout_failed' ? 'err' : 'ok');
  } else {
    toast('Done', 'ok');
  }

  render();
}

/* ------------------------------------------------------------ currencies */
screens['/currencies'] = async () => {
  const list = await api('/admin/currencies');

  view.innerHTML = `
    <div class="adm__head">
      <div><h2>Currencies &amp; rates</h2>
      <p>Fee, limits and liquidity. Edits save on blur and are written to the audit log.</p></div>
      <button class="btn btn--sm btn--ghost" data-do="refresh-rates">Refresh feed</button>
    </div>
    <div class="table-wrap">
      <table class="tbl tbl--dense" style="min-width:1080px"><thead><tr>
        <th>Currency</th><th>Pivot USD</th><th>Fee %</th><th>Min</th><th>Max</th>
        <th>Reserve</th><th>Committed</th><th>Available</th><th>On</th><th>Manual</th><th></th>
      </tr></thead><tbody>
      ${list.map((c) => `<tr data-cur="${esc(c.id)}">
        <td><span class="cell-cur">
          <span class="field__ico" style="background:${esc(c.color)}">${esc(c.code.slice(0, 4))}</span>
          <b>${esc(c.label)}</b></span>
          ${c.stale ? '<br><span class="tag tag--err">stale pivot</span>' : ''}
          <br><span class="small muted">${esc(c.pivot_source)}</span></td>
        <td class="mono small">${num(c.pivot_usd, 8)}</td>
        <td><div class="adm__inline"><input data-edit="feeBp" value="${(c.fee_bp / 100).toFixed(2)}" style="width:62px"></div></td>
        <td><div class="adm__inline"><input data-edit="min" value="${esc(c.min_amt)}" style="width:82px"></div></td>
        <td><div class="adm__inline"><input data-edit="max" value="${esc(c.max_amt)}" style="width:92px"></div></td>
        <td class="mono small">${num(c.reserve)}</td>
        <td class="mono small ${Number(c.reserved) > 0 ? '' : 'muted'}">${num(c.reserved)}</td>
        <td class="mono small"><b>${num(c.available)}</b><br><span class="muted">$${num(c.availableUsd)}</span></td>
        <td><input type="checkbox" data-edit="enabled"${c.enabled ? ' checked' : ''}></td>
        <td><input type="checkbox" data-edit="manual"${c.manual ? ' checked' : ''}></td>
        <td><button class="btn btn--sm btn--ghost" data-reserve="${esc(c.id)}" data-current="${esc(c.reserve)}">Reserve</button></td>
      </tr>`).join('')}
      </tbody></table>
    </div>
    <p class="small muted" style="margin-top:12px">
      <b>Committed</b> is liquidity already promised to open orders. Available = reserve &minus; committed,
      and that is what the exchanger quotes against.
    </p>`;

  wireCurrencyEdits();
};

function wireCurrencyEdits() {
  view.querySelectorAll('[data-cur]').forEach((row) => {
    const id = row.dataset.cur;

    row.querySelectorAll('input[data-edit]').forEach((input) => {
      const original = input.type === 'checkbox' ? input.checked : input.value;

      const save = async () => {
        const field = input.dataset.edit;
        const value = input.type === 'checkbox' ? input.checked : input.value.trim();
        if (value === original) return;

        // the UI shows a percentage; the API speaks basis points
        const body = field === 'feeBp'
          ? { feeBp: Math.round(Number(value) * 100) }
          : { [field]: value };

        try {
          await api(`/admin/currencies/${encodeURIComponent(id)}`, { method: 'PATCH', body });
          input.classList.remove('is-dirty');
          toast('Saved', 'ok');
          if (field === 'enabled' || field === 'manual') render();
        } catch (err) {
          toast(err.message, 'err');
          if (input.type === 'checkbox') input.checked = original;
          else input.value = original;
          input.classList.remove('is-dirty');
        }
      };

      if (input.type === 'checkbox') input.onchange = save;
      else {
        input.oninput = () => input.classList.add('is-dirty');
        input.onblur = save;
        input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); };
      }
    });

    const rb = row.querySelector('[data-reserve]');
    if (rb) rb.onclick = () => adjustReserve(id, rb.dataset.current);
  });
}

async function adjustReserve(id, current) {
  const ok = await confirmAction({
    title: 'Adjust reserve',
    body: `Current reserve is <b>${num(current)}</b>. The change is written to the ledger and the audit log.`,
    reason: true,
    fields: [
      { name: 'mode', label: 'Mode', options: ['delta', 'set'], value: 'delta',
        hint: 'delta adds or subtracts; set replaces the figure outright.' },
      { name: 'amount', label: 'Amount', required: true, placeholder: 'e.g. 5000 or -2500',
        hint: 'Cannot drop below the liquidity already committed to open orders.' }
    ]
  });
  if (!ok) return;

  await act(() => api(`/admin/currencies/${encodeURIComponent(id)}/reserve`, {
    method: 'POST',
    body: { mode: ok.values.mode, amount: ok.values.amount, reason: ok.reason }
  }), 'Reserve updated');
  render();
}

/* ------------------------------------------------------------ directions */
screens['/directions'] = async () => {
  const { rules, overrides } = await api('/admin/directions');
  const groups = ['crypto', 'account', 'mobile'];
  const on = (f, t) => rules.find((r) => r.from_grp === f && r.to_grp === t)?.enabled;

  view.innerHTML = `
    <div class="adm__head"><div><h2>Directions</h2>
    <p>Which groups may trade into which. A closed cell hides every pair in it from the exchanger.</p></div></div>

    <div class="adm__panel" style="overflow-x:auto">
      <table class="adm__matrix">
        <thead><tr><th>send &#8594; receive</th>${groups.map((g) => `<th>${g}</th>`).join('')}</tr></thead>
        <tbody>${groups.map((f) => `<tr><th>${f}</th>${groups.map((t) => `
          <td><button data-dir="${f}|${t}" title="${on(f, t) ? 'Open - click to close' : 'Closed - click to open'}">
            ${on(f, t) ? '&#9989;' : '&#10060;'}</button></td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="adm__panel">
      <h3>Per-pair overrides</h3>
      <p class="small muted" style="margin-bottom:12px">
        An override beats the group rule: force a single pair open or closed, or give it its own fee.
      </p>
      ${overrides.length ? `<div class="table-wrap" style="box-shadow:none">
        <table class="tbl tbl--dense" style="min-width:520px"><thead><tr>
          <th>From</th><th>To</th><th>Enabled</th><th>Fee %</th><th></th>
        </tr></thead><tbody>
        ${overrides.map((o) => `<tr>
          <td>${esc(o.from_id)}</td><td>${esc(o.to_id)}</td>
          <td>${o.enabled === null ? '<span class="muted small">inherit</span>' : (o.enabled ? 'open' : 'closed')}</td>
          <td>${o.fee_bp === null ? '<span class="muted small">inherit</span>' : (o.fee_bp / 100).toFixed(2)}</td>
          <td><button class="btn btn--sm btn--ghost" data-rm-pair="${esc(o.from_id)}|${esc(o.to_id)}">Remove</button></td>
        </tr>`).join('')}
        </tbody></table></div>` : '<p class="muted small">No overrides. Every pair follows its group rule.</p>'}
    </div>`;

  view.querySelectorAll('[data-dir]').forEach((b) => {
    b.onclick = async () => {
      const [f, t] = b.dataset.dir.split('|');
      await act(() => api('/admin/directions', {
        method: 'PUT', body: { from: f, to: t, enabled: !on(f, t) }
      }), 'Direction updated');
      render();
    };
  });

  view.querySelectorAll('[data-rm-pair]').forEach((b) => {
    b.onclick = async () => {
      const [f, t] = b.dataset.rmPair.split('|');
      await act(() => api('/admin/pairs', {
        method: 'PUT', body: { from: f, to: t, enabled: null, feeBp: null }
      }), 'Override removed');
      render();
    };
  });
};

/* ----------------------------------------------------------------- users */
screens['/users'] = async (params) => {
  const q = params.get('q') || '';
  const data = await api('/admin/users?limit=50' + (q ? `&q=${encodeURIComponent(q)}` : ''));

  view.innerHTML = `
    <div class="adm__head"><div><h2>Users</h2><p>${data.total} accounts</p></div></div>
    <div class="adm__filters">
      <input type="search" data-f="q" placeholder="Login or email…" value="${esc(q)}">
    </div>
    <div class="table-wrap">
      <table class="tbl tbl--dense"><thead><tr>
        <th>Login</th><th>Email</th><th>Role</th><th>KYC</th><th>Discount</th><th>Joined</th><th>Seen</th><th></th>
      </tr></thead><tbody>
      ${data.users.map((u) => `<tr>
        <td><a href="#/users/${u.id}"><b>${esc(u.login)}</b></a>
            ${u.blocked ? ' <span class="tag tag--err">blocked</span>' : ''}</td>
        <td class="small">${esc(u.email)}${u.email_verified ? '' : ' <span class="tag tag--wait">unverified</span>'}</td>
        <td><span class="tag ${u.role === 'user' ? 'tag--info' : 'tag--ok'}">${esc(u.role)}</span></td>
        <td class="small">${esc(u.kyc_status)}</td>
        <td class="small">${u.discount_bp ? (u.discount_bp / 100).toFixed(2) + '%' : '-'}</td>
        <td class="small muted">${when(u.created_at)}</td>
        <td class="small muted">${ago(u.last_seen_at)}</td>
        <td><a class="btn btn--sm btn--ghost" href="#/users/${u.id}">Open</a></td>
      </tr>`).join('') || '<tr><td colspan="8" class="center muted" style="padding:24px">No users match</td></tr>'}
      </tbody></table>
    </div>`;

  $('[data-f="q"]').onkeydown = (e) => {
    if (e.key === 'Enter') location.hash = '#/users' + (e.target.value.trim() ? `?q=${encodeURIComponent(e.target.value.trim())}` : '');
  };
};

screens['/users/:id'] = async (_p, id) => {
  const { user: u, orders, balances, kyc, sessions, affiliate } = await api(`/admin/users/${encodeURIComponent(id)}`);
  const isAdmin = me.role === 'admin';

  view.innerHTML = `
    <div class="adm__head">
      <div><h2>${esc(u.login)} ${u.blocked ? '<span class="tag tag--err">blocked</span>' : ''}</h2>
      <p>${esc(u.email)} &middot; joined ${when(u.created_at)} &middot; ${sessions} active session(s)</p></div>
      <a class="btn btn--sm btn--ghost" href="#/users">Back to users</a>
    </div>

    ${u.blocked ? `<div class="adm__alert adm__alert--err"><div><b>Blocked</b>${esc(u.block_reason || 'No reason recorded')}</div></div>` : ''}

    <div class="adm__split">
      <div>
        <div class="adm__panel">
          <h3>Controls</h3>
          <div class="adm__actions">
            <button class="btn btn--sm ${u.blocked ? '' : 'btn--danger'}" data-do="toggle-block">
              ${u.blocked ? 'Unblock account' : 'Block account'}</button>
            <button class="btn btn--sm btn--ghost" data-do="revoke">Revoke sessions (${sessions})</button>
            <button class="btn btn--sm btn--ghost" data-do="discount">Set fee discount</button>
            ${isAdmin ? '<button class="btn btn--sm btn--ghost" data-do="role">Change role</button>' : ''}
          </div>
          ${isAdmin ? '' : '<p class="small muted" style="margin-top:10px">Role changes need administrator rights.</p>'}
        </div>

        <div class="adm__panel">
          <h3>Orders (${orders.length})</h3>
          <div class="table-wrap" style="box-shadow:none">
            <table class="tbl tbl--dense" style="min-width:560px"><thead><tr>
              <th>Order</th><th>Direction</th><th>Send</th><th>Status</th><th>When</th>
            </tr></thead><tbody>
            ${orders.map((o) => `<tr>
              <td><a href="#/orders/${esc(o.id)}">${esc(o.id)}</a></td>
              <td class="small">${esc(o.from_id)} &#8594; ${esc(o.to_id)}</td>
              <td class="mono small">${num(o.send_amount, 8)}</td>
              <td>${tag(o.status)}</td>
              <td class="small muted">${when(o.created_at)}</td>
            </tr>`).join('') || '<tr><td colspan="5" class="center muted">No orders</td></tr>'}
            </tbody></table>
          </div>
        </div>
      </div>

      <aside>
        <div class="adm__panel">
          <h3>Account</h3>
          <div class="kv">
            <div><span>Role</span><b>${esc(u.role)}</b></div>
            <div><span>Email verified</span><b>${u.email_verified ? 'yes' : 'no'}</b></div>
            <div><span>KYC</span><b>${esc(u.kyc_status)} (${kyc.length} docs)</b></div>
            <div><span>Fee discount</span><b>${(u.discount_bp / 100).toFixed(2)}%</b></div>
            <div><span>Referral code</span><b>${esc(u.ref_code || '-')}</b></div>
            <div><span>Referred by</span><b>${u.referrer_id ? `<a href="#/users/${u.referrer_id}">#${u.referrer_id}</a>` : '-'}</b></div>
            <div><span>Last seen</span><b>${ago(u.last_seen_at)}</b></div>
          </div>
        </div>

        <div class="adm__panel">
          <h3>Balances</h3>
          ${balances.length ? `<div class="kv">${balances.map((b) =>
            `<div><span>${esc(b.currency_id)}</span><b>${num(b.amount, 8)}</b></div>`).join('')}</div>`
            : '<p class="muted small">No balances</p>'}
        </div>

        <div class="adm__panel">
          <h3>Affiliate</h3>
          <div class="kv">
            <div><span>Referrals</span><b>${affiliate.referrals}</b></div>
            <div><span>Earned</span><b>$${num(affiliate.earned)}</b></div>
          </div>
        </div>
      </aside>
    </div>`;

  $('[data-do="toggle-block"]').onclick = async () => {
    if (u.blocked) {
      await act(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { blocked: false } }), 'Unblocked');
    } else {
      const ok = await confirmAction({
        title: 'Block account',
        body: 'Signs the user out everywhere and refuses new sign-ins.',
        reason: true, confirmWord: 'BLOCK'
      });
      if (!ok) return;
      await act(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { blocked: true, reason: ok.reason } }), 'Blocked');
    }
    render();
  };

  $('[data-do="revoke"]').onclick = async () => {
    await act(() => api(`/admin/users/${u.id}/revoke-sessions`, { method: 'POST' }), 'Sessions revoked');
    render();
  };

  $('[data-do="discount"]').onclick = async () => {
    const ok = await confirmAction({
      title: 'Set fee discount',
      body: 'Reduces the service fee on every order this customer creates.',
      reason: false,
      fields: [{
        name: 'pct', label: 'Discount in percent', required: true,
        value: (u.discount_bp / 100).toFixed(2), hint: 'Between 0 and 5.'
      }]
    });
    if (!ok) return;
    await act(() => api(`/admin/users/${u.id}`, {
      method: 'PATCH', body: { discountBp: Math.round(Number(ok.values.pct) * 100) }
    }), 'Discount updated');
    render();
  };

  const roleBtn = $('[data-do="role"]');
  if (roleBtn) roleBtn.onclick = async () => {
    const ok = await confirmAction({
      title: 'Change role',
      body: 'Operators can act on orders. Administrators can also change reserves, roles and settings.',
      reason: true,
      fields: [{ name: 'role', label: 'Role', options: ['user', 'operator', 'admin'], value: u.role }]
    });
    if (!ok) return;
    await act(() => api(`/admin/users/${u.id}`, {
      method: 'PATCH', body: { role: ok.values.role, reason: ok.reason }
    }), 'Role changed');
    render();
  };
};

/* ------------------------------------------------------------------- kyc */
screens['/kyc'] = async () => {
  const docs = await api('/admin/kyc?status=pending');

  view.innerHTML = `
    <div class="adm__head"><div><h2>KYC queue</h2><p>${docs.length} documents awaiting review</p></div></div>
    ${docs.length ? `<div class="table-wrap"><table class="tbl tbl--dense"><thead><tr>
      <th>User</th><th>Type</th><th>File</th><th>Size</th><th>Uploaded</th><th></th>
    </tr></thead><tbody>
    ${docs.map((d) => `<tr>
      <td><a href="#/users/${d.user_id}"><b>${esc(d.login)}</b></a><br><span class="small muted">${esc(d.email)}</span></td>
      <td class="small">${esc(d.kind.replace(/_/g, ' '))}</td>
      <td class="small mono">${esc(d.filename)}</td>
      <td class="small muted">${num(d.bytes / 1024, 0)} KB</td>
      <td class="small muted">${when(d.created_at)}</td>
      <td><div class="adm__actions">
        <button class="btn btn--sm" data-kyc="${d.id}|approved">Approve</button>
        <button class="btn btn--sm btn--danger" data-kyc="${d.id}|rejected">Reject</button>
      </div></td>
    </tr>`).join('')}
    </tbody></table></div>
    <p class="small muted" style="margin-top:12px">
      Documents are stored outside the web root and are not served over HTTP. Open them from
      <code>data/kyc/</code> on the server.
    </p>` : '<div class="adm__panel"><p class="muted">Nothing pending.</p></div>'}`;

  view.querySelectorAll('[data-kyc]').forEach((b) => {
    b.onclick = async () => {
      const [id, decision] = b.dataset.kyc.split('|');
      const ok = await confirmAction({
        title: decision === 'approved' ? 'Approve document' : 'Reject document',
        body: decision === 'approved'
          ? 'The account is marked approved once nothing else is pending.'
          : 'The reason is shown to the customer.',
        reason: decision === 'rejected'
      });
      if (!ok) return;
      await act(() => api(`/admin/kyc/${id}/review`, {
        method: 'POST', body: { decision, reason: ok.reason }
      }), 'Reviewed');
      render();
    };
  });
};

/* ----------------------------------------------------------- withdrawals */
screens['/withdrawals'] = async () => {
  const rows = await api('/admin/withdrawals?status=pending');

  view.innerHTML = `
    <div class="adm__head"><div><h2>Withdrawals</h2><p>${rows.length} pending</p></div></div>
    ${rows.length ? `<div class="table-wrap"><table class="tbl tbl--dense"><thead><tr>
      <th>User</th><th>Currency</th><th>Amount</th><th>Requisite</th><th>Kind</th><th>Requested</th><th></th>
    </tr></thead><tbody>
    ${rows.map((w) => `<tr>
      <td><a href="#/users/${w.user_id}"><b>${esc(w.login)}</b></a></td>
      <td class="small">${esc(w.currency_id)}</td>
      <td class="mono"><b>${num(w.amount, 8)}</b></td>
      <td class="small" style="word-break:break-all">${esc(w.requisite)}</td>
      <td class="small">${esc(w.kind)}</td>
      <td class="small muted">${when(w.created_at)}</td>
      <td><div class="adm__actions">
        <button class="btn btn--sm" data-wd="${w.id}|paid">Mark paid</button>
        <button class="btn btn--sm btn--danger" data-wd="${w.id}|rejected">Reject</button>
      </div></td>
    </tr>`).join('')}
    </tbody></table></div>
    <p class="small muted" style="margin-top:12px">
      Rejecting returns the amount to the customer's balance. Marking paid does not
      move funds - send the transfer first, then record it here.
    </p>` : '<div class="adm__panel"><p class="muted">Nothing pending.</p></div>'}`;

  view.querySelectorAll('[data-wd]').forEach((b) => {
    b.onclick = async () => {
      const [id, decision] = b.dataset.wd.split('|');
      const ok = await confirmAction({
        title: decision === 'paid' ? 'Mark as paid' : 'Reject withdrawal',
        body: decision === 'paid'
          ? 'Confirms you have already sent the transfer.'
          : 'The amount is returned to the customer balance.',
        reason: decision === 'rejected',
        confirmWord: decision === 'paid' ? 'PAID' : null
      });
      if (!ok) return;
      await act(() => api(`/admin/withdrawals/${id}/review`, {
        method: 'POST', body: { decision, reason: ok.reason }
      }), 'Recorded');
      render();
    };
  });
};

/* --------------------------------------------------------------- reviews */
screens['/reviews'] = async () => {
  const pending = await api('/admin/reviews?approved=0');

  view.innerHTML = `
    <div class="adm__head"><div><h2>Reviews</h2><p>${pending.length} awaiting moderation</p></div></div>
    ${pending.length ? pending.map((r) => `
      <div class="adm__panel">
        <div class="adm__head" style="margin-bottom:10px">
          <div><h3 style="margin:0">${esc(r.who)}</h3>
          <p class="small muted">${when(r.created_at)}${r.order_id ? ` &middot; order <a href="#/orders/${esc(r.order_id)}">${esc(r.order_id)}</a> <span class="tag tag--ok">verified</span>` : ' &middot; no order attached'}</p></div>
          <div class="adm__actions">
            <button class="btn btn--sm" data-rev="${r.id}|approve">Publish</button>
            <button class="btn btn--sm btn--danger" data-rev="${r.id}|delete">Delete</button>
          </div>
        </div>
        <p>${esc(r.body)}</p>
      </div>`).join('')
      : '<div class="adm__panel"><p class="muted">Nothing awaiting moderation.</p></div>'}`;

  view.querySelectorAll('[data-rev]').forEach((b) => {
    b.onclick = async () => {
      const [id, decision] = b.dataset.rev.split('|');
      if (decision === 'delete') {
        const ok = await confirmAction({ title: 'Delete review', body: 'Permanent.', reason: false });
        if (!ok) return;
      }
      await act(() => api(`/admin/reviews/${id}/moderate`, { method: 'POST', body: { decision } }),
        decision === 'approve' ? 'Published' : 'Deleted');
      render();
    };
  });
};

/* ------------------------------------------------------------- rate feed */
screens['/rates'] = async () => {
  const st = await api('/admin/rates');

  view.innerHTML = `
    <div class="adm__head">
      <div><h2>Rate feed</h2><p>Refreshed ${ago(st.lastRun)} &middot; every ${st.refreshSec}s
      &middot; refuses to quote after ${Math.round(st.maxStaleSec / 60)} min stale</p></div>
      <button class="btn btn--sm" data-do="refresh-rates">Refresh now</button>
    </div>

    ${st.lastError ? `<div class="adm__alert adm__alert--err"><div><b>Last refresh reported errors</b>${esc(st.lastError)}</div></div>` : ''}
    ${st.stale.length ? `<div class="adm__alert adm__alert--warn"><div>
      <b>${st.stale.length} stale pivot(s)</b>
      These directions return "temporarily unavailable" instead of a stale price:
      ${st.stale.map((c) => esc(c.code)).join(', ')}</div></div>` : ''}

    <div class="adm__panel">
      <h3>Cached pivots</h3>
      <div class="table-wrap" style="box-shadow:none">
        <table class="tbl tbl--dense" style="min-width:520px"><thead><tr>
          <th>Symbol</th><th>USD value</th><th>Source</th><th>Fetched</th>
        </tr></thead><tbody>
        ${st.cached.map((c) => `<tr>
          <td><b>${esc(c.symbol)}</b></td>
          <td class="mono">${num(c.usd, 8)}</td>
          <td class="small muted">${esc(c.source)}</td>
          <td class="small muted">${ago(c.fetched_at)}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="center muted">Nothing cached yet</td></tr>'}
        </tbody></table>
      </div>
    </div>

    <div class="adm__panel">
      <h3>Published feed</h3>
      <p class="small muted">What the monitors see right now.</p>
      <div class="adm__actions" style="margin-top:10px">
        <a class="btn btn--sm btn--ghost" href="/api/v1/rates.xml" target="_blank" rel="noopener">Open XML</a>
        <a class="btn btn--sm btn--ghost" href="/api/v1/rates.json" target="_blank" rel="noopener">Open JSON</a>
      </div>
    </div>`;
};

/* ------------------------------------------------------------- audit log */
screens['/audit'] = async (params) => {
  const qs = new URLSearchParams({ limit: '80' });
  for (const k of ['actor', 'action', 'entity', 'page']) if (params.get(k)) qs.set(k, params.get(k));
  const data = await api('/admin/audit?' + qs);

  view.innerHTML = `
    <div class="adm__head"><div><h2>Audit log</h2><p>${data.total} entries</p></div></div>
    <div class="adm__filters">
      <input type="search" data-f="action" placeholder="Action contains…" value="${esc(params.get('action') || '')}">
      <input type="search" data-f="actor" placeholder="Actor login…" value="${esc(params.get('actor') || '')}">
    </div>
    <div class="table-wrap">
      <table class="tbl tbl--dense"><thead><tr>
        <th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Detail</th><th>IP</th>
      </tr></thead><tbody>
      ${data.entries.map((e) => `<tr>
        <td class="small muted nowrap">${when(e.created_at)}</td>
        <td class="small"><b>${esc(e.actor_login)}</b></td>
        <td class="small"><code>${esc(e.action)}</code></td>
        <td class="small">${esc(e.entity || '')}${e.entity_id ? ` <span class="muted">${esc(e.entity_id)}</span>` : ''}</td>
        <td class="small muted" style="max-width:380px;word-break:break-word">${esc(e.detail || '')}</td>
        <td class="small muted">${esc(e.ip || '')}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="center muted" style="padding:24px">Nothing logged</td></tr>'}
      </tbody></table>
    </div>`;

  const apply = () => {
    const u = new URLSearchParams();
    const a = $('[data-f="action"]').value.trim();
    const w = $('[data-f="actor"]').value.trim();
    if (a) u.set('action', a);
    if (w) u.set('actor', w);
    location.hash = '#/audit' + (u.toString() ? '?' + u : '');
  };
  ['action', 'actor'].forEach((f) => {
    $(`[data-f="${f}"]`).onkeydown = (e) => { if (e.key === 'Enter') apply(); };
  });
};

/* -------------------------------------------------------------- settings */
screens['/settings'] = async () => {
  const { settings, config } = await api('/admin/settings');
  const val = (k) => settings.find((s) => s.key === k)?.value ?? '';
  const isAdmin = me.role === 'admin';

  view.innerHTML = `
    <div class="adm__head"><div><h2>Settings</h2>
    <p>Runtime switches. Anything not listed here lives in <code>.env</code> and needs a restart.</p></div></div>

    ${isAdmin ? '' : '<div class="adm__alert adm__alert--warn"><div><b>Read only</b>Changing settings needs administrator rights.</div></div>'}

    <div class="adm__panel">
      <h3>Trading</h3>
      <div class="form" style="max-width:460px">
        <label class="check">
          <input type="checkbox" data-set="maintenance"${val('maintenance') === '1' ? ' checked' : ''}${isAdmin ? '' : ' disabled'}>
          <span><b>Maintenance mode</b><br><span class="small muted">Refuses new orders. Orders already open still settle.</span></span>
        </label>
        <div class="form__field">
          <label>KYC threshold, USD</label>
          <input class="input" data-set="kyc_threshold_usd" value="${esc(val('kyc_threshold_usd'))}"${isAdmin ? '' : ' disabled'}>
          <span class="hint">Cumulative 30-day volume above which verification is requested.</span>
        </div>
      </div>
    </div>

    <div class="adm__panel">
      <h3>Affiliate tiers</h3>
      <div class="form" style="max-width:460px">
        ${[['affiliate_tier1_bp', 'Tier 1 (to $5k)'], ['affiliate_tier2_bp', 'Tier 2 ($5k-$25k)'],
           ['affiliate_tier3_bp', 'Tier 3 (above $25k)'], ['affiliate_min_payout_usd', 'Minimum payout, USD']]
          .map(([k, label]) => `<div class="form__field">
            <label>${label}${k.endsWith('_bp') ? ' — basis points' : ''}</label>
            <input class="input" data-set="${k}" value="${esc(val(k))}"${isAdmin ? '' : ' disabled'}>
          </div>`).join('')}
      </div>
    </div>

    <div class="adm__panel">
      <h3>From the environment</h3>
      <p class="small muted" style="margin-bottom:12px">Read-only here. Change these in <code>.env</code> and restart.</p>
      <div class="kv" style="max-width:460px">
        <div><span>Environment</span><b>${esc(config.env)}</b></div>
        <div><span>Quote lock</span><b>${config.lockMinutes} min</b></div>
        <div><span>Payout confirmations</span><b>${config.confirmations}</b></div>
        <div><span>Rate refresh</span><b>${config.ratesRefreshSec}s</b></div>
        <div><span>Max pivot staleness</span><b>${Math.round(config.maxStaleSec / 60)} min</b></div>
      </div>
    </div>`;

  if (!isAdmin) return;

  view.querySelectorAll('[data-set]').forEach((input) => {
    const key = input.dataset.set;
    const save = async () => {
      const value = input.type === 'checkbox' ? (input.checked ? '1' : '0') : input.value.trim();
      try {
        await api('/admin/settings', { method: 'PUT', body: { key, value } });
        toast('Saved', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    };
    if (input.type === 'checkbox') input.onchange = save;
    else { input.onblur = save; input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); }; }
  });
};

/* ----------------------------------------------------------------- login */
function signInScreen(message) {
  nav.hidden = true;
  view.innerHTML = `
    <div class="auth" style="margin-top:20px">
      <div class="card">
        <h2 class="card__title">Operator sign-in</h2>
        ${message ? `<p class="form__err">${esc(message)}</p>` : ''}
        <p class="muted small" style="margin-bottom:18px">This panel needs operator or administrator rights.</p>
        <form class="form" data-login>
          <div class="form__field"><label>Login or email</label>
            <input class="input" name="login" autocomplete="username" required></div>
          <div class="form__field"><label>Password</label>
            <input class="input" name="password" type="password" autocomplete="current-password" required></div>
          <div class="form__field"><label>PIN code (if set)</label>
            <input class="input" name="pin" inputmode="numeric" autocomplete="off"></div>
          <button class="btn btn--block" type="submit">Sign in</button>
        </form>
      </div>
    </div>`;

  $('[data-login]').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/auth/login', {
        method: 'POST',
        body: { login: f.login.value, password: f.password.value, pin: f.pin.value }
      });
      await boot();
    } catch (err) {
      toast(err.message, 'err');
    }
  };
}

/* ---------------------------------------------------------------- router */
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query] = raw.split('?');
  return { path, params: new URLSearchParams(query || '') };
}

/** Matches '/orders/:id' style routes, returning the captured segment. */
function resolve(path) {
  if (screens[path]) return [screens[path], null];
  for (const pattern of Object.keys(screens)) {
    if (!pattern.includes(':')) continue;
    const p = pattern.split('/');
    const a = path.split('/');
    if (p.length !== a.length) continue;
    let captured = null;
    const match = p.every((seg, i) => {
      if (seg.startsWith(':')) { captured = decodeURIComponent(a[i]); return true; }
      return seg === a[i];
    });
    if (match) return [screens[pattern], captured];
  }
  return [null, null];
}

async function render() {
  const { path, params } = parseHash();
  const [screen, captured] = resolve(path);

  nav.querySelectorAll('a').forEach((a) => {
    const target = a.getAttribute('href').replace(/^#/, '').split('?')[0];
    a.classList.toggle('is-active', target === path || (target !== '/' && path.startsWith(target)));
  });

  if (!screen) {
    view.innerHTML = `<div class="adm__panel"><h3>Not found</h3>
      <p class="muted">No such screen. <a href="#/">Back to the dashboard</a>.</p></div>`;
    return;
  }

  view.innerHTML = '<div class="adm__loading">Loading…</div>';
  try {
    await screen(params, captured);
  } catch (err) {
    if (err.status === 401 || err.status === 403) return signInScreen(err.message);
    view.innerHTML = `<div class="adm__alert adm__alert--err"><div>
      <b>Could not load this screen</b>${esc(err.message)}</div></div>
      <button class="btn btn--sm btn--ghost" onclick="location.reload()">Reload</button>`;
  }
}

function paintBadges() {
  if (!dash) return;
  const map = {
    attention: dash.needsAttention,
    kyc: dash.pendingKyc,
    withdrawals: dash.pendingWithdrawals,
    reviews: dash.pendingReviews
  };
  for (const [k, v] of Object.entries(map)) {
    const el = nav.querySelector(`[data-badge="${k}"]`);
    if (el) el.textContent = v ? String(v) : '';
  }
}

/* ------------------------------------------------------------------ boot */
async function boot() {
  try {
    const { user } = await api('/auth/me');
    me = user;
  } catch {
    me = null;
  }

  if (!me) return signInScreen();
  if (!['operator', 'admin'].includes(me.role)) {
    return signInScreen('That account does not have operator rights.');
  }

  nav.hidden = false;
  $('[data-who]').textContent = `${me.login} (${me.role})`;
  await render();

  // environment badge, so nobody mistakes production for a sandbox
  try {
    const { config } = await api('/admin/settings');
    const env = $('[data-env]');
    env.textContent = config.env;
    if (config.env === 'production') env.setAttribute('data-prod', '');
  } catch { /* non-admin operators may not read settings */ }
}

window.addEventListener('hashchange', render);

$('[data-signout]').onclick = async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  me = null;
  location.hash = '#/';
  signInScreen('Signed out.');
};

// delegated handler for the buttons that appear on more than one screen
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-do="refresh-rates"]');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    const out = await api('/admin/rates/refresh', { method: 'POST' });
    toast(out.errors?.length ? `Partial: ${out.errors.join('; ')}` : `${out.applied} pivots updated`,
      out.errors?.length ? 'err' : 'ok');
    render();
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = false;
    btn.textContent = 'Refresh now';
  }
});

boot();
