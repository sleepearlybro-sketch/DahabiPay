/* ==========================================================================
   Dahabi Pay - forms, order flow and account screens.

   Talks to the API when a server is there (EP.live), and degrades to the
   bundled demo behaviour when the pages are opened straight off disk. Every
   check here is for fast feedback only: the server validates again, and the
   server is the one that decides.
   ========================================================================== */

(function () {
  'use strict';

  var q = function (s, r) { return (r || document).querySelector(s); };
  var qa = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* --------------------------------------------------------------- captcha
     The answer lives on the server; we only carry its id.                */
  function initCaptcha(box) {
    var img = q('.captcha__img', box);
    var reload = q('.captcha__reload', box);

    function draw() {
      if (!EP.live) {
        // offline demo: a local code, checked locally. Says so, so nobody
        // mistakes it for a real control.
        var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
        for (var i = 0; i < 5; i++) s += a.charAt(Math.floor(Math.random() * a.length));
        img.textContent = s;
        box.dataset.code = s;
        box.dataset.captchaId = '';
        return;
      }
      img.textContent = '…';
      EP.api('/v1/captcha').then(function (c) {
        img.innerHTML = c.svg;
        box.dataset.captchaId = c.id;
        box.dataset.code = '';
      }).catch(function () {
        img.textContent = 'error';
        box.dataset.captchaId = '';
      });
    }

    if (reload) reload.addEventListener('click', function (e) { e.preventDefault(); draw(); });
    box.__redraw = draw;
    draw();
  }

  /** Pull the captcha pair out of a form, for the request body. */
  function captchaFields(form) {
    var box = q('.captcha', form);
    if (!box) return {};
    var input = q('[data-captcha-input]', form);
    return { captchaId: box.dataset.captchaId || '', captcha: (input && input.value.trim()) || '' };
  }

  function redrawCaptcha(form) {
    var box = q('.captcha', form);
    if (box && box.__redraw) box.__redraw();
    var input = q('[data-captcha-input]', form);
    if (input) input.value = '';
  }

  /* ------------------------------------------------------------ validation */
  var V = {
    required: function (v) { return v.trim() ? '' : 'This field is required'; },
    email: function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? '' : 'Enter a valid email'; },
    login: function (v) { return /^[a-zA-Z0-9_.-]{3,24}$/.test(v.trim()) ? '' : '3-24 letters, digits, . _ -'; },
    pass: function (v) { return v.length >= 8 ? '' : 'At least 8 characters'; },
    pin: function (v) { return !v || /^\d{4,6}$/.test(v) ? '' : 'PIN is 4-6 digits'; }
  };

  function showErr(input, msg) {
    var wrap = input.closest('.form__field') || input.parentElement;
    var slot = q('.form__err', wrap);
    if (!slot) {
      slot = document.createElement('div');
      slot.className = 'form__err';
      wrap.appendChild(slot);
    }
    slot.textContent = msg || '';
    input.classList.toggle('input--err', !!msg);
    return !msg;
  }

  function clearErrors(form) {
    qa('.form__err', form).forEach(function (e) { e.textContent = ''; });
    qa('.input--err', form).forEach(function (e) { e.classList.remove('input--err'); });
  }

  function runRules(form) {
    var ok = true;
    qa('[data-rule]', form).forEach(function (inp) {
      var msg = '';
      inp.getAttribute('data-rule').split(/\s+/).forEach(function (r) {
        if (!msg && V[r]) msg = V[r](inp.value);
      });
      if (!msg && inp.hasAttribute('data-match')) {
        var other = q(inp.getAttribute('data-match'), form);
        if (other && other.value !== inp.value) msg = 'Passwords do not match';
      }
      if (!showErr(inp, msg)) ok = false;
    });

    // offline only - when live, the server owns the captcha check
    var box = q('.captcha', form);
    if (box && !EP.live) {
      var inp = q('[data-captcha-input]', form);
      var bad = inp.value.trim().toUpperCase() !== box.dataset.code;
      if (!showErr(inp, bad ? 'Captcha does not match' : '')) { ok = false; redrawCaptcha(form); }
    }

    var agree = q('[data-agree]', form);
    if (agree && !agree.checked) { EP.toast('Please accept the terms to continue', 'err'); ok = false; }

    return ok;
  }

  /** Put a server-side field error on the right input. */
  function applyServerError(form, err) {
    if (err.field) {
      var input = q('[name="' + err.field + '"]', form) ||
        (err.field === 'captcha' ? q('[data-captcha-input]', form) : null);
      if (input) { showErr(input, err.message); return; }
    }
    EP.toast(err.message, 'err');
  }

  function busy(form, on, label) {
    var btn = q('button[type=submit]', form) || q('.btn', form);
    if (!btn) return;
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.disabled = true;
      btn.textContent = label || 'Working…';
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
    }
  }

  /* ------------------------------------------------------------- sessions */
  EP.session = {
    get: function () { return EP.me || EP.store.get('session', null); },
    login: function (login) { EP.store.set('session', { login: login }); },
    logout: function () { EP.store.del('session'); EP.me = null; }
  };

  /* ---------------------------------------------------------------- orders
     Offline fallback only; when live, history comes from the API.        */
  EP.orders = {
    all: function () {
      var seeded = EP.store.get('orders', null);
      if (seeded) return seeded;
      var seed = [
        { id: 'EP-7KQ2M-40318', from: 'usdt_trc20', to: 'mpesa_kes', send: 250, recv: 31935.48, status: 'completed', date: '11.09.2026 14:22' },
        { id: 'EP-A3XR9-38902', from: 'btc', to: 'moneygo', send: 0.015, recv: 941.22, status: 'completed', date: '09.09.2026 09:05' },
        { id: 'EP-Q59ZT-36120', from: 'usdc_erc20', to: 'instapay_egp', send: 500, recv: 23980.58, status: 'awaiting_payment', date: '13.09.2026 08:12' }
      ];
      EP.store.set('orders', seed);
      return seed;
    },
    add: function (o) {
      var list = EP.orders.all();
      list.unshift(o);
      EP.store.set('orders', list);
    }
  };

  var STATUS_TAG = {
    created: 'tag--info', awaiting_payment: 'tag--wait', payment_detected: 'tag--info',
    processing: 'tag--wait', completed: 'tag--ok', expired: 'tag--err',
    cancelled: 'tag--err', on_hold: 'tag--wait', refunded: 'tag--err'
  };
  var STATUS_LABEL = {
    created: 'Created', awaiting_payment: 'Awaiting payment', payment_detected: 'Payment detected',
    processing: 'Processing', completed: 'Completed', expired: 'Quote expired',
    cancelled: 'Cancelled', on_hold: 'On hold', refunded: 'Refunded'
  };
  EP.statusTag = function (s, label) {
    return '<span class="tag ' + (STATUS_TAG[s] || 'tag--info') + '">' +
      (label || STATUS_LABEL[s] || s) + '</span>';
  };
  var TERMINAL = ['completed', 'cancelled', 'refunded'];

  /* ------------------------------------------------------------ order page */
  function initOrder(root) {
    var p = new URLSearchParams(location.search);
    var existingId = p.get('id');
    var accessToken = p.get('t') || '';

    var formStage = q('[data-stage="form"]', root);
    var payStage = q('[data-stage="pay"]', root);
    var form = q('form', root);
    var steps = qa('.progress__i', root);

    function advance(i) {
      steps.forEach(function (s, n) {
        s.classList.toggle('is-done', n < i);
        s.classList.toggle('is-now', n === i);
      });
    }

    /* ---- an order we already have: jump straight to tracking ---- */
    if (existingId && EP.live) {
      formStage.hidden = true;
      payStage.hidden = false;
      EP.getOrder(existingId, accessToken).then(function (d) {
        paintOrder(d.order);
        poll(d.order);
      }).catch(function (err) {
        payStage.innerHTML = '<div class="card"><h2 class="card__title">Order not found</h2>' +
          '<p class="muted">' + err.message + '</p>' +
          '<p style="margin-top:16px"><a class="btn" href="../index.html">Start a new exchange</a></p></div>';
      });
      return;
    }

    /* ---- a new order: price it, then collect requisites ---- */
    var fromId = p.get('from') || 'usdt_trc20';
    var toId = p.get('to') || 'mpesa_kes';
    var amount = p.get('send') || '100';
    var pricing = null;

    function renderSummary(data, from, to) {
      q('[data-sum]', root).innerHTML =
        '<div><span>You send</span><b>' + EP.fmt(Number(data.send)) + ' ' + from.code + '</b></div>' +
        '<div><span>Direction</span><b>' + EP.label(from) + ' &#8594; ' + EP.label(to) + '</b></div>' +
        '<div><span>Rate</span><b>1 ' + from.code + ' = ' + EP.fmt(Number(data.rate)) + ' ' + to.code + '</b></div>' +
        '<div><span>Service fee</span><b>' + ((data.feeBp || 0) / 100).toFixed(2) + '%</b></div>' +
        '<div><span>You receive</span><b>' + EP.fmt(Number(data.recv)) + ' ' + to.code + '</b></div>';
    }

    var from = EP.byId(fromId);
    var to = EP.byId(toId);
    if (!from || !to) {
      root.innerHTML = '<div class="card"><h2 class="card__title">Unknown direction</h2>' +
        '<p class="muted">That currency pair is not available.</p>' +
        '<p style="margin-top:16px"><a class="btn" href="../index.html">Back to the exchanger</a></p></div>';
      return;
    }

    var reqLabel = q('[data-req-label]', root);
    if (reqLabel) reqLabel.textContent = to.field;
    var reqInput = q('[name="requisite"]', root);
    if (reqInput) reqInput.placeholder = to.field;

    if (EP.live) {
      EP.quote(fromId, toId, amount, 'send').then(function (res) {
        if (!res.ok) {
          EP.toast(res.error, 'err');
          q('[data-sum]', root).innerHTML = '<div><span>Unavailable</span><b>' + res.error + '</b></div>';
          busy(form, true, 'Unavailable');
          return;
        }
        pricing = res;
        renderSummary(res, from, to);
      }).catch(function () {
        pricing = localQuote();
        renderSummary(pricing, from, to);
      });
    } else {
      pricing = localQuote();
      renderSummary(pricing, from, to);
    }

    function localQuote() {
      var rate = EP.rate(from, to);
      var send = Number(amount);
      return { send: send, recv: send * rate, rate: rate, feeBp: Math.round(from.fee * 10000) };
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      clearErrors(form);
      if (!runRules(form)) return;

      if (!EP.live) {
        var demo = {
          id: EP.orderId(), from: fromId, to: toId,
          send: pricing.send, recv: pricing.recv, status: 'awaiting_payment',
          date: new Date().toLocaleString('en-GB'),
          requisite: form.requisite.value.trim(), email: form.email.value.trim(),
          depositAddress: 'DEMO-' + fromId.toUpperCase() + '-OFFLINE',
          lockExpiresAt: new Date(Date.now() + 20 * 60000).toISOString(),
          statusLabel: 'Awaiting payment', events: []
        };
        EP.orders.add(demo);
        formStage.hidden = true;
        payStage.hidden = false;
        advance(1);
        paintOrder(demo);
        wireDemoPaid(demo);
        return;
      }

      busy(form, true, 'Creating…');
      EP.createOrder({
        from: fromId, to: toId, amount: String(amount), side: 'send',
        requisite: form.requisite.value.trim(),
        email: form.email.value.trim(),
        holder: form.holder ? form.holder.value.trim() : '',
        note: form.note ? form.note.value.trim() : ''
      }).then(function (d) {
        // keep the token in the URL so a reload still reads the order
        var url = new URL(location.href);
        url.searchParams.set('id', d.order.id);
        url.searchParams.set('t', d.accessToken);
        history.replaceState(null, '', url);

        formStage.hidden = true;
        payStage.hidden = false;
        accessToken = d.accessToken;
        advance(1);
        paintOrder(d.order);
        poll(d.order);
        if (d.needsOperator) {
          EP.toast('No deposit address is configured - an operator will contact you', 'err');
        }
      }).catch(function (err) {
        busy(form, false);
        applyServerError(form, err);
        redrawCaptcha(form);
      });
    });

    /* --------------------------------------------------- render + polling */
    var timer = null;

    function paintOrder(o) {
      var f = EP.byId(o.from && o.from.id ? o.from.id : o.from) || from;
      var t = EP.byId(o.to && o.to.id ? o.to.id : o.to) || to;

      q('[data-oid]', root).textContent = o.id;
      q('[data-pay-amt]', root).textContent = EP.fmt(Number(o.send)) + ' ' + f.code;
      q('[data-pay-to]', root).textContent = EP.label(t) + ' - ' + (o.requisite || '');
      q('[data-statusbox]', root).innerHTML = EP.statusTag(o.status, o.statusLabel);

      var addr = o.depositAddress || '';
      q('[data-addr]', root).textContent = addr || 'awaiting an operator';
      q('[data-copybtn]', root).setAttribute('data-copy', addr);

      renderSummary({
        send: o.send, recv: o.recv, rate: o.rate, feeBp: o.feeBp
      }, f, t);

      var done = TERMINAL.indexOf(o.status) > -1;
      q('[data-done-note]', root).hidden = o.status !== 'completed';
      if (o.status === 'completed') advance(3);
      else if (o.status === 'processing' || o.status === 'payment_detected') advance(2);

      var paidBtn = q('[data-paid]', root);
      if (paidBtn) {
        paidBtn.disabled = o.status !== 'awaiting_payment' && o.status !== 'created';
      }

      // the customer may withdraw the application only while nothing has been paid
      var cancelBtn = q('[data-cancel]', root);
      if (cancelBtn) {
        cancelBtn.hidden = ['awaiting_payment', 'created', 'expired'].indexOf(o.status) === -1;
      }

      countdown(o);
      renderTimeline(o);

      if (done && timer) { clearInterval(timer); timer = null; }
      if (o.status === 'expired') offerRequote(o);
    }

    function renderTimeline(o) {
      var host = q('[data-timeline]', root);
      if (!host || !o.events || !o.events.length) return;
      host.innerHTML = '<h3 style="font-size:16px;margin-bottom:12px">Progress</h3><ul class="timeline">' +
        o.events.map(function (e) {
          return '<li><b>' + (e.label || e.status) + '</b><span>' +
            EP.fmtDate(e.at) + '</span>' + (e.detail ? '<em>' + e.detail + '</em>' : '') + '</li>';
        }).join('') + '</ul>';
    }

    var tick = null;
    function countdown(o) {
      var el = q('[data-timer]', root);
      if (!el) return;
      if (tick) { clearInterval(tick); tick = null; }

      if (TERMINAL.indexOf(o.status) > -1) {
        el.textContent = o.status === 'completed' ? 'Settled' : STATUS_LABEL[o.status];
        return;
      }
      if (o.status !== 'awaiting_payment' && o.status !== 'created') {
        el.textContent = STATUS_LABEL[o.status] || o.status;
        return;
      }

      var ends = Date.parse(o.lockExpiresAt);
      if (isNaN(ends)) { el.textContent = ''; return; }

      var paint = function () {
        var left = Math.floor((ends - Date.now()) / 1000);
        if (left <= 0) {
          el.textContent = 'Quote expired';
          clearInterval(tick); tick = null;
          if (EP.live) refresh();
          return;
        }
        el.textContent = String(Math.floor(left / 60)).padStart(2, '0') + ':' +
          String(left % 60).padStart(2, '0') + ' left to pay';
      };
      paint();
      tick = setInterval(paint, 1000);
    }

    function refresh() {
      if (!EP.live) return;
      EP.getOrder(existingId || q('[data-oid]', root).textContent, accessToken)
        .then(function (d) { paintOrder(d.order); })
        .catch(function () { /* transient; the next tick tries again */ });
    }

    function poll(o) {
      if (!EP.live || TERMINAL.indexOf(o.status) > -1) return;
      existingId = existingId || o.id;
      if (timer) clearInterval(timer);
      timer = setInterval(refresh, 6000);
    }

    /* customer asserts payment */
    var paidBtn = q('[data-paid]', root);
    if (paidBtn) {
      paidBtn.addEventListener('click', function () {
        if (!EP.live) return;
        paidBtn.disabled = true;
        var id = existingId || q('[data-oid]', root).textContent;
        EP.api('/orders/' + encodeURIComponent(id) + '/paid', {
          method: 'POST', body: { accessToken: accessToken }
        }).then(function (d) {
          EP.toast('Thank you - we are checking for your payment', 'ok');
          paintOrder(d.order);
          poll(d.order);
        }).catch(function (err) {
          paidBtn.disabled = false;
          EP.toast(err.message, 'err');
        });
      });
    }

    var cancelBtn = q('[data-cancel]', root);
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        if (!EP.live) return EP.toast('Offline demo', 'err');
        if (!confirmCancel()) return;
        cancelBtn.disabled = true;
        var id = existingId || q('[data-oid]', root).textContent;
        EP.api('/orders/' + encodeURIComponent(id) + '/cancel', {
          method: 'POST', body: { accessToken: accessToken }
        }).then(function (d) {
          EP.toast('Application cancelled', 'ok');
          paintOrder(d.order);
        }).catch(function (err) {
          cancelBtn.disabled = false;
          EP.toast(err.message, 'err');
        });
      });
    }

    /* A cancellation cannot be undone and releases the held rate, so it asks
       first. Kept as a native confirm here: it is one yes/no on a customer
       page, not an operator action that needs a reason recorded. */
    function confirmCancel() {
      return window.confirm(
        'Cancel this application?\n\n' +
        'The quoted rate is released and cannot be recovered. ' +
        'Do not cancel if you have already sent the payment - contact an operator instead.'
      );
    }

    function wireDemoPaid(o) {
      if (!paidBtn) return;
      paidBtn.addEventListener('click', function () {
        paidBtn.disabled = true;
        o.status = 'processing';
        paintOrder(o);
        EP.toast('Offline demo - no payment is actually checked');
        setTimeout(function () {
          o.status = 'completed';
          paintOrder(o);
        }, 3000);
      });
    }

    /** An expired quote can be re-priced; the customer decides. */
    function offerRequote(o) {
      if (!EP.live || q('[data-requote]', root)) return;
      EP.api('/orders/' + encodeURIComponent(o.id) + '/requote-preview?t=' + encodeURIComponent(accessToken))
        .then(function (pv) {
          if (!pv.current) return;
          var box = document.createElement('p');
          box.className = 'small';
          box.style.cssText = 'margin-top:16px;padding:14px;border-radius:10px;background:rgba(224,147,15,.14);color:#7a4f03;font-weight:700';
          box.innerHTML = 'The quote expired. At the current rate you would receive ' +
            '<b>' + EP.fmt(Number(pv.current.recv)) + '</b> instead of ' +
            '<b>' + EP.fmt(Number(pv.previous.recv)) + '</b>. ' +
            '<button class="btn btn--sm" data-requote style="margin-left:8px">Accept new rate</button>';
          q('[data-statusbox]', root).closest('.card').appendChild(box);

          q('[data-requote]', box).addEventListener('click', function () {
            EP.api('/orders/' + encodeURIComponent(o.id) + '/requote', {
              method: 'POST', body: { accessToken: accessToken }
            }).then(function (d) {
              box.remove();
              EP.toast('Re-quoted at the current rate', 'ok');
              paintOrder(d.order);
              poll(d.order);
            }).catch(function (err) { EP.toast(err.message, 'err'); });
          });
        }).catch(function () { /* nothing to offer */ });
    }
  }

  /* --------------------------------------------------------- account views */
  function initHistory(el) {
    var tb = q('tbody', el);
    var filter = q('[data-hstatus]');

    function rowsFromApi(orders) {
      return orders.map(function (o) {
        var f = EP.byId(o.fromId), t = EP.byId(o.toId);
        return '<tr>' +
          '<td><b>' + o.id + '</b><br><span class="small muted">' + EP.fmtDate(o.createdAt) + '</span></td>' +
          '<td><span class="cell-cur">' + (f ? EP.ico(f) : '') + '<b>' + EP.fmt(Number(o.send)) + ' ' + (o.fromCode || '') + '</b></span></td>' +
          '<td><span class="cell-cur">' + (t ? EP.ico(t) : '') + '<b>' + EP.fmt(Number(o.recv)) + ' ' + (o.toCode || '') + '</b></span></td>' +
          '<td>' + EP.statusTag(o.status, o.statusLabel) + '</td>' +
          '<td><a class="btn btn--sm btn--ghost" href="order.html?id=' + encodeURIComponent(o.id) +
            (o.accessToken ? '&t=' + encodeURIComponent(o.accessToken) : '') + '">View</a></td>' +
        '</tr>';
      }).join('');
    }

    function paintLive() {
      var status = filter && filter.value ? '?status=' + encodeURIComponent(filter.value) : '';
      tb.innerHTML = '<tr><td colspan="5" class="center muted" style="padding:22px">Loading…</td></tr>';
      EP.api('/account/orders' + status).then(function (d) {
        tb.innerHTML = d.orders.length ? rowsFromApi(d.orders)
          : '<tr><td colspan="5" class="center muted" style="padding:28px">No transactions yet</td></tr>';
      }).catch(function (err) {
        tb.innerHTML = '<tr><td colspan="5" class="center muted" style="padding:28px">' +
          (err.status === 401
            ? 'Please <a href="signin.html">sign in</a> to see your history.'
            : err.message) + '</td></tr>';
      });
    }

    function paintDemo() {
      var f = filter && filter.value || '';
      var list = EP.orders.all().filter(function (o) { return !f || o.status === f; });
      tb.innerHTML = list.length ? list.map(function (o) {
        var fc = EP.byId(o.from), tc = EP.byId(o.to);
        if (!fc || !tc) return '';
        return '<tr>' +
          '<td><b>' + o.id + '</b><br><span class="small muted">' + o.date + '</span></td>' +
          '<td><span class="cell-cur">' + EP.ico(fc) + '<b>' + EP.money(o.send, fc.code) + '</b></span></td>' +
          '<td><span class="cell-cur">' + EP.ico(tc) + '<b>' + EP.money(o.recv, tc.code) + '</b></span></td>' +
          '<td>' + EP.statusTag(o.status) + '</td>' +
          '<td><span class="small muted">offline</span></td>' +
        '</tr>';
      }).join('') : '<tr><td colspan="5" class="center muted" style="padding:28px">No transactions yet</td></tr>';
    }

    var paint = function () { EP.live ? paintLive() : paintDemo(); };
    if (filter) filter.addEventListener('change', paint);
    paint();
  }

  function initBalances(el) {
    if (!EP.live) {
      el.innerHTML = '<div class="stat"><span>Offline</span><b>-</b>' +
        '<em>start the server to see balances</em></div>';
      return;
    }
    el.innerHTML = '<div class="stat"><span>Loading</span><b>…</b></div>';
    EP.api('/account/balances').then(function (list) {
      el.innerHTML = list.length ? list.map(function (b) {
        return '<div class="stat"><span>' + b.label + '</span>' +
          '<b>' + EP.fmt(Number(b.amount)) + '</b>' +
          '<em>' + (Number(b.usd) ? '$' + b.usd : 'empty') + '</em></div>';
      }).join('') : '<div class="stat"><span>No balances</span><b>0</b><em>exchange into My Account to fund one</em></div>';
    }).catch(function (err) {
      el.innerHTML = '<div class="stat"><span>Unavailable</span><b>-</b><em>' +
        (err.status === 401 ? 'sign in required' : err.message) + '</em></div>';
    });
  }

  function initProfile(root) {
    if (!EP.live) return;
    EP.api('/account/profile').then(function (p) {
      qa('[data-user-value]').forEach(function (i) { i.value = p.login; });
      var email = q('[name="email"]', root);
      if (email) email.value = p.email;

      var stats = q('[data-profile-stats]');
      if (stats) {
        stats.innerHTML =
          '<div class="stat"><span>Exchanges</span><b>' + p.stats.exchanges + '</b>' +
            '<em>+' + p.stats.exchanges30d + ' this month</em></div>' +
          '<div class="stat"><span>Turnover</span><b>$' + EP.fmt(Number(p.stats.turnoverUsd)) + '</b>' +
            '<em>lifetime</em></div>' +
          '<div class="stat"><span>Fee discount</span><b>' + (p.discountBp / 100).toFixed(2) + '%</b>' +
            '<em>' + (p.discountBp ? 'applied to every order' : 'none yet') + '</em></div>' +
          '<div class="stat"><span>Affiliate earned</span><b>$' + EP.fmt(Number(p.stats.affiliateEarnedUsd)) + '</b>' +
            '<em>' + p.stats.referrals + ' referral(s)</em></div>';
      }

      var ver = q('[data-verification]');
      if (ver) {
        ver.innerHTML =
          '<div><span>Email</span><b>' + (p.emailVerified
            ? '<span class="tag tag--ok">Confirmed</span>'
            : '<span class="tag tag--wait">Unconfirmed</span>') + '</b></div>' +
          '<div><span>Identity (KYC)</span><b><span class="tag ' +
            (p.kycStatus === 'approved' ? 'tag--ok' : p.kycStatus === 'rejected' ? 'tag--err' : 'tag--info') +
            '">' + p.kycStatus + '</span></b></div>' +
          '<div><span>PIN code</span><b>' + (p.hasPin
            ? '<span class="tag tag--ok">Set</span>'
            : '<span class="tag tag--wait">Not set</span>') + '</b></div>';
      }
    }).catch(function (err) {
      if (err.status === 401) {
        root.innerHTML = '<div class="card center"><h2 class="card__title">Sign in required</h2>' +
          '<p class="muted">Your profile needs an account.</p>' +
          '<p style="margin-top:16px"><a class="btn" href="signin.html">Sign in</a></p></div>';
      }
    });
  }

  function initAffiliate(root) {
    if (!EP.live) return;
    EP.api('/account/affiliate').then(function (a) {
      var stats = q('[data-aff-stats]', root);
      if (stats) {
        stats.innerHTML =
          '<div class="stat"><span>Referrals</span><b>' + a.referrals + '</b><em>lifetime</em></div>' +
          '<div class="stat"><span>Earned</span><b>$' + a.earnedUsd + '</b><em>all time</em></div>' +
          '<div class="stat"><span>Available</span><b>$' + a.availableUsd + '</b>' +
            '<em>min $' + a.minPayoutUsd + '</em></div>' +
          '<div class="stat"><span>Current tier</span><b>' + (a.tiers.tier1 / 100).toFixed(2) + '%</b>' +
            '<em>of the service fee</em></div>';
      }
      var link = q('[data-reflink]', root);
      if (link) {
        link.textContent = a.refLink;
        var btn = q('[data-refcopy]', root);
        if (btn) btn.setAttribute('data-copy', a.refLink);
      }
      var tb = q('[data-aff-rows]', root);
      if (tb) {
        tb.innerHTML = a.rewards.length ? a.rewards.map(function (r) {
          return '<tr><td>' + EP.fmtDate(r.created_at) + '</td>' +
            '<td>' + (r.referral || 'guest') + '</td>' +
            '<td class="mono">$' + EP.fmt(Number(r.volume_usd)) + '</td>' +
            '<td class="mono">' + (r.share_bp / 100).toFixed(2) + '%</td>' +
            '<td class="mono"><b>$' + EP.fmt(Number(r.reward_usd)) + '</b></td></tr>';
        }).join('') : '<tr><td colspan="5" class="center muted" style="padding:24px">No affiliate exchanges yet</td></tr>';
      }
    }).catch(function (err) {
      if (err.status === 401) {
        root.innerHTML = '<div class="card center"><h2 class="card__title">Sign in required</h2>' +
          '<p style="margin-top:16px"><a class="btn" href="signin.html">Sign in</a></p></div>';
      }
    });
  }

  /* ------------------------------------------------------------ security */
  function initSecurity(root) {
    if (!EP.live) {
      root.innerHTML = '<div class="card center"><h2 class="card__title">Server required</h2>' +
        '<p class="muted">Security settings need the server running.</p></div>';
      return;
    }

    EP.api('/account/profile').then(function (p) {
      q('[data-email-state]', root).innerHTML =
        '<div><span>Address</span><b>' + p.email + '</b></div>' +
        '<div><span>Confirmed</span><b>' + (p.emailVerified
          ? '<span class="tag tag--ok">Yes</span>'
          : '<span class="tag tag--wait">Not yet</span>') + '</b></div>';

      var wrap = q('[data-resend-wrap]', root);
      if (wrap) wrap.hidden = !!p.emailVerified;

      var st = q('[data-pin-state]', root);
      if (st) st.textContent = p.hasPin ? 'A PIN is set.' : 'No PIN is set.';
    }).catch(function (err) {
      if (err.status === 401) signInWall(root, 'Security settings');
    });

    var resend = q('[data-resend]', root);
    if (resend) {
      resend.addEventListener('click', function () {
        resend.disabled = true;
        EP.api('/auth/resend-verification', { method: 'POST' })
          .then(function (d) { EP.toast(d.message, 'ok'); })
          .catch(function (err) { EP.toast(err.message, 'err'); resend.disabled = false; });
      });
    }

    function loadSessions() {
      var tb = q('[data-sessions]', root);
      if (!tb) return;
      EP.api('/auth/sessions').then(function (list) {
        tb.innerHTML = list.map(function (x) {
          return '<tr>' +
            '<td class="small">' + (x.ua || 'unknown').slice(0, 60) +
              (x.current ? ' <span class="tag tag--ok">this device</span>' : '') + '</td>' +
            '<td class="small muted">' + (x.ip || '-') + '</td>' +
            '<td class="small muted">' + EP.fmtDate(x.createdAt) + '</td>' +
            '<td class="small muted">' + EP.fmtDate(x.expiresAt) + '</td>' +
          '</tr>';
        }).join('') || '<tr><td colspan="4" class="center muted">No sessions</td></tr>';
      }).catch(function () {
        tb.innerHTML = '<tr><td colspan="4" class="center muted">Unavailable</td></tr>';
      });
    }
    loadSessions();

    var revoke = q('[data-revoke-others]', root);
    if (revoke) {
      revoke.addEventListener('click', function () {
        EP.api('/auth/sessions/revoke-others', { method: 'POST' })
          .then(function (d) {
            EP.toast('Signed out ' + d.revoked + ' other session(s)', 'ok');
            loadSessions();
          })
          .catch(function (err) { EP.toast(err.message, 'err'); });
      });
    }
  }

  /* ----------------------------------------------------------------- kyc */
  function loadKyc() {
    var tb = q('[data-kyc-docs]');
    if (!tb || !EP.live) return;
    EP.api('/account/kyc').then(function (list) {
      tb.innerHTML = list.length ? list.map(function (d) {
        var tone = d.status === 'approved' ? 'tag--ok'
          : d.status === 'rejected' ? 'tag--err' : 'tag--wait';
        return '<tr>' +
          '<td class="small">' + d.kind.replace(/_/g, ' ') + '</td>' +
          '<td class="small muted">' + Math.round(d.bytes / 1024) + ' KB</td>' +
          '<td class="small muted">' + EP.fmtDate(d.created_at) + '</td>' +
          '<td><span class="tag ' + tone + '">' + d.status + '</span>' +
            (d.reason ? '<br><span class="small muted">' + d.reason + '</span>' : '') + '</td>' +
        '</tr>';
      }).join('') : '<tr><td colspan="4" class="center muted" style="padding:22px">Nothing uploaded</td></tr>';
    }).catch(function (err) {
      tb.innerHTML = '<tr><td colspan="4" class="center muted" style="padding:22px">' +
        (err.status === 401 ? 'Sign in to see your documents.' : err.message) + '</td></tr>';
    });
  }

  function initKyc(root) {
    if (!EP.live) {
      root.innerHTML = '<div class="card center"><h2 class="card__title">Server required</h2>' +
        '<p class="muted">Verification needs the server running.</p></div>';
      return;
    }

    EP.api('/account/profile').then(function (p) {
      var tone = p.kycStatus === 'approved' ? 'tag--ok'
        : p.kycStatus === 'rejected' ? 'tag--err'
        : p.kycStatus === 'pending' ? 'tag--wait' : 'tag--info';
      q('[data-kyc-state]', root).innerHTML =
        '<div><span>Account status</span><b><span class="tag ' + tone + '">' +
          p.kycStatus + '</span></b></div>' +
        '<div><span>Email</span><b>' + (p.emailVerified ? 'confirmed' : 'unconfirmed') + '</b></div>';
    }).catch(function (err) {
      if (err.status === 401) signInWall(root, 'Verification');
    });

    // show what was picked, since a bare file input says very little
    var input = q('[name="file"]', root);
    var hint = q('[data-file-hint]', root);
    if (input && hint) {
      input.addEventListener('change', function () {
        var f = input.files && input.files[0];
        hint.textContent = f
          ? f.name + ' - ' + Math.round(f.size / 1024) + ' KB'
          : 'Nothing selected.';
      });
    }

    loadKyc();
  }

  function signInWall(root, what) {
    root.innerHTML = '<div class="card center"><h2 class="card__title">Sign in required</h2>' +
      '<p class="muted">' + what + ' needs an account.</p>' +
      '<p style="margin-top:16px"><a class="btn" href="signin.html">Sign in</a></p></div>';
  }

  /* ------------------------------------------------- withdrawals + ledger */
  function initWithdrawals(el) {
    if (!EP.live) return;
    EP.api('/account/withdrawals').then(function (list) {
      el.innerHTML = list.length ? list.map(function (w) {
        var tone = w.status === 'paid' ? 'tag--ok' : w.status === 'rejected' ? 'tag--err' : 'tag--wait';
        var cur = EP.byId(w.currency_id);
        return '<tr>' +
          '<td class="small muted">' + EP.fmtDate(w.created_at) + '</td>' +
          '<td class="small">' + (cur ? EP.label(cur) : w.currency_id) + '</td>' +
          '<td class="mono">' + EP.fmt(Number(w.amount)) + '</td>' +
          '<td class="small" style="word-break:break-all">' + w.requisite + '</td>' +
          '<td><span class="tag ' + tone + '">' + w.status + '</span>' +
            (w.reason ? '<br><span class="small muted">' + w.reason + '</span>' : '') + '</td>' +
        '</tr>';
      }).join('') : '<tr><td colspan="5" class="center muted" style="padding:22px">No withdrawals yet</td></tr>';
    }).catch(function (err) {
      el.innerHTML = '<tr><td colspan="5" class="center muted" style="padding:22px">' +
        (err.status === 401 ? 'Sign in to see your withdrawals.' : err.message) + '</td></tr>';
    });
  }

  function initLedger(el) {
    if (!EP.live) return;
    EP.api('/account/ledger?limit=40').then(function (list) {
      el.innerHTML = list.length ? list.map(function (l) {
        var neg = String(l.delta).trim().charAt(0) === '-';
        return '<tr>' +
          '<td class="small muted">' + EP.fmtDate(l.created_at) + '</td>' +
          '<td class="small">' + l.currency_id + '</td>' +
          '<td class="mono" style="color:' + (neg ? 'var(--danger)' : 'var(--green)') + '"><b>' +
            (neg ? '' : '+') + EP.fmt(Number(l.delta)) + '</b></td>' +
          '<td class="small muted">' + l.reason +
            (l.order_id ? ' (' + l.order_id + ')' : '') + '</td>' +
        '</tr>';
      }).join('') : '<tr><td colspan="4" class="center muted" style="padding:22px">No movements yet</td></tr>';
    }).catch(function (err) {
      el.innerHTML = '<tr><td colspan="4" class="center muted" style="padding:22px">' +
        (err.status === 401 ? 'Sign in to see your ledger.' : err.message) + '</td></tr>';
    });
  }

  /* ------------------------------------------------------------------ boot */
  function boot() {
    qa('.captcha').forEach(initCaptcha);

    /* ---- auth + generic forms ---- */
    qa('[data-form]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        clearErrors(form);
        if (!runRules(form)) return;

        var kind = form.getAttribute('data-form');

        if (!EP.live) {
          if (kind === 'signin' || kind === 'signup') {
            EP.session.login((form.login && form.login.value.trim()) || 'user');
            EP.toast('Offline demo - signed in locally', 'ok');
            setTimeout(function () { location.href = EP.url('pages/profile.html'); }, 600);
          } else {
            EP.toast('Offline demo - nothing was submitted');
            form.reset();
            redrawCaptcha(form);
          }
          return;
        }

        var cap = captchaFields(form);
        var done = function (msg, go) {
          EP.toast(msg, 'ok');
          if (go) setTimeout(function () { location.href = go; }, 700);
          else { form.reset(); redrawCaptcha(form); busy(form, false); }
        };
        var failed = function (err) {
          busy(form, false);
          applyServerError(form, err);
          redrawCaptcha(form);
        };

        busy(form, true);

        if (kind === 'signin') {
          EP.api('/auth/login', {
            method: 'POST',
            body: {
              login: form.login.value.trim(),
              password: form.password.value,
              pin: form.pin ? form.pin.value.trim() : '',
              captchaId: cap.captchaId, captcha: cap.captcha
            }
          }).then(function (d) {
            EP.me = d.user;
            var next = (d.user.role === 'operator' || d.user.role === 'admin')
              ? EP.base + 'admin/' : EP.url('pages/profile.html');
            done('Signed in', next);
          }).catch(failed);

        } else if (kind === 'signup') {
          var ref = new URLSearchParams(location.search).get('ref') ||
            EP.store.get('ref', '') || '';
          EP.api('/auth/register', {
            method: 'POST',
            body: {
              login: form.login.value.trim(),
              email: form.email.value.trim(),
              password: form.password.value,
              password2: form.password2 ? form.password2.value : '',
              ref: ref,
              captchaId: cap.captchaId, captcha: cap.captcha
            }
          }).then(function () {
            busy(form, false);
            form.closest('.card').innerHTML =
              '<h2 class="card__title">Check your email</h2>' +
              '<p class="muted">We have sent a confirmation link to <b>' +
              form.email.value.trim() + '</b>. Open it to activate your account.</p>' +
              '<p class="small muted" style="margin-top:14px">No SMTP configured in development? ' +
              'The link is printed in the server log.</p>' +
              '<p style="margin-top:18px"><a class="btn" href="signin.html">Go to sign-in</a></p>';
          }).catch(failed);

        } else if (kind === 'forgot') {
          EP.api('/auth/forgot', {
            method: 'POST',
            body: { email: form.email.value.trim(), captchaId: cap.captchaId, captcha: cap.captcha }
          }).then(function (d) { done(d.message); }).catch(failed);

        } else if (kind === 'reset') {
          EP.api('/auth/reset', {
            method: 'POST',
            body: {
              token: new URLSearchParams(location.search).get('token') || '',
              password: form.password.value
            }
          }).then(function () { done('Password changed', EP.url('pages/signin.html')); }).catch(failed);

        } else if (kind === 'withdraw' || kind === 'affwithdraw') {
          EP.api('/account/withdraw', {
            method: 'POST',
            body: {
              currency: form.system.value,
              amount: form.amount.value.trim(),
              requisite: form.account.value.trim(),
              kind: kind === 'affwithdraw' ? 'affiliate' : 'balance',
              pin: form.pin ? form.pin.value.trim() : '',
              captchaId: cap.captchaId, captcha: cap.captcha
            }
          }).then(function (d) { done(d.message); }).catch(failed);

        } else if (kind === 'review') {
          EP.api('/v1/reviews', {
            method: 'POST',
            body: {
              who: form.who.value.trim(),
              text: form.text.value.trim(),
              orderId: form.oid ? form.oid.value.trim() : '',
              captchaId: cap.captchaId, captcha: cap.captcha
            }
          }).then(function (d) { done(d.message); }).catch(failed);

        } else if (kind === 'lookup') {
          EP.api('/orders/lookup', {
            method: 'POST',
            body: { id: form.id.value.trim(), email: form.email.value.trim() }
          }).then(function (d) {
            location.href = 'order.html?id=' + encodeURIComponent(d.id) +
              '&t=' + encodeURIComponent(d.accessToken);
          }).catch(failed);

        } else if (kind === 'password') {
          EP.api('/auth/password', {
            method: 'POST',
            body: { current: form.current.value, password: form.password.value }
          }).then(function (d) {
            done(d.message);
          }).catch(failed);

        } else if (kind === 'pin') {
          EP.api('/auth/pin', {
            method: 'POST',
            body: { password: form.password.value, pin: form.pin.value.trim() }
          }).then(function (d) {
            done(d.hasPin ? 'PIN saved' : 'PIN removed');
            var st = q('[data-pin-state]');
            if (st) st.textContent = d.hasPin ? 'A PIN is set.' : 'No PIN is set.';
          }).catch(failed);

        } else if (kind === 'kyc') {
          var file = form.file.files && form.file.files[0];
          if (!file) { busy(form, false); return EP.toast('Choose a file first', 'err'); }

          var capMb = 6;
          if (file.size > capMb * 1024 * 1024) {
            busy(form, false);
            return EP.toast('That file is larger than ' + capMb + ' MB', 'err');
          }

          var reader = new FileReader();
          reader.onload = function () {
            EP.api('/account/kyc', {
              method: 'POST',
              body: {
                kind: form.kind.value,
                filename: file.name,
                mime: file.type,
                data: String(reader.result)
              }
            }).then(function (d) {
              EP.toast(d.message, 'ok');
              busy(form, false);
              form.reset();
              var hint = q('[data-file-hint]');
              if (hint) hint.textContent = 'Nothing selected.';
              loadKyc();
            }).catch(failed);
          };
          reader.onerror = function () { busy(form, false); EP.toast('Could not read that file', 'err'); };
          reader.readAsDataURL(file);

        } else if (kind === 'profile') {
          EP.api('/account/profile', {
            method: 'PATCH',
            body: {
              email: form.email.value.trim(),
              lang: form.lang ? form.lang.value.slice(0, 2).toLowerCase() : 'en'
            }
          }).then(function () { done('Saved'); }).catch(failed);

        } else {
          busy(form, false);
          EP.toast('Submitted', 'ok');
        }
      });
    });

    /* ---- referral capture: hold it for the eventual sign-up ---- */
    var ref = new URLSearchParams(location.search).get('ref');
    if (ref) EP.store.set('ref', ref);

    /* ---- page pieces ---- */
    var ord = q('[data-order]');
    if (ord) initOrder(ord);

    qa('[data-render="history"]').forEach(initHistory);
    qa('[data-render="balances"]').forEach(initBalances);

    var prof = q('[data-profile]');
    if (prof) initProfile(prof);

    var aff = q('[data-affiliate]');
    if (aff) initAffiliate(aff);

    var sec = q('[data-security]');
    if (sec) initSecurity(sec);

    var kyc = q('[data-kyc]');
    if (kyc) initKyc(kyc);

    qa('[data-render="withdrawals"]').forEach(initWithdrawals);
    qa('[data-render="ledger"]').forEach(initLedger);

    /* ---- identity in the sidebar ---- */
    var s = EP.session.get();
    qa('[data-user]').forEach(function (el) { el.textContent = s ? s.login : 'guest'; });

    qa('[data-logout]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        var finish = function () {
          EP.session.logout();
          EP.toast('Signed out');
          setTimeout(function () { location.href = EP.url('index.html'); }, 500);
        };
        if (EP.live) EP.api('/auth/logout', { method: 'POST' }).then(finish, finish);
        else finish();
      });
    });

    /* ---- payment-system dropdowns ---- */
    qa('[data-cur-options]').forEach(function (sel) {
      sel.innerHTML = '<option value="">-- select payment system --</option>' +
        EP.currencies.map(function (c) {
          return '<option value="' + c.id + '">' + EP.label(c) + '</option>';
        }).join('');
    });
  }

  function start() {
    if (window.EP && EP.ready && typeof EP.ready.then === 'function') EP.ready.then(boot, boot);
    else boot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
