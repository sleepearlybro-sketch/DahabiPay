/* ==========================================================================
   Dahabi Pay - exchange widget + content renderers
   The widget is self-mounting: drop <div data-exchanger></div> on a page.
   Optional attributes: data-from="usdt_trc20" data-to="mpesa_kes"
   ========================================================================== */

(function () {
  'use strict';

  /* ----------------------------------------------------------- ui pieces */
  function ico(c) {
    return '<span class="field__ico" style="background:' + c.color + '">' + EP.initials(c) + '</span>';
  }

  function pickerHtml(side, selId, exclude) {
    var h = '<div class="picker" data-picker="' + side + '">' +
            '<input class="picker__search" type="search" placeholder="Search currency..." data-search>' +
            '<div data-opts></div></div>';
    return h;
  }

  function optionsHtml(side, selId, otherCur, q) {
    var out = '', shown = 0;
    Object.keys(EP.groups).forEach(function (g) {
      var rows = EP.currencies.filter(function (c) {
        if (c.group !== g) return false;
        if (q && EP.label(c).toLowerCase().indexOf(q) === -1) return false;
        if (otherCur) {
          // hide pairs the direction table does not open
          var ok = side === 'from' ? EP.allowed(c, otherCur) : EP.allowed(otherCur, c);
          if (!ok) return false;
        }
        return true;
      });
      if (!rows.length) return;
      out += '<div class="picker__group">' + EP.groups[g] + '</div>';
      rows.forEach(function (c) {
        shown++;
        out += '<button type="button" class="picker__opt' + (c.id === selId ? ' is-sel' : '') +
               '" data-pick="' + c.id + '">' + ico(c) +
               '<b>' + EP.label(c) + '</b><span>' + EP.fmt(c.reserve) + ' ' + c.code + '</span></button>';
      });
    });
    return shown ? out : '<div class="picker__empty">Nothing matches that search</div>';
  }

  function fieldHtml(side, cur, amount) {
    return '<div class="xchg__row">' +
      '<div class="field" data-open="' + side + '" tabindex="0">' + ico(cur) +
        '<span class="field__txt" data-cur="' + side + '">' + EP.label(cur) + '</span>' +
        '<span class="field__caret">&#9662;</span>' +
        pickerHtml(side) +
      '</div>' +
      '<div class="field field--amount">' +
        '<input type="text" inputmode="decimal" data-amt="' + side + '" value="' + amount + '" aria-label="Amount ' + side + '">' +
      '</div>' +
    '</div>';
  }

  /* -------------------------------------------------------------- widget */
  function Exchanger(root) {
    var st = {
      from: EP.byId(root.getAttribute('data-from') || '') || EP.byId('usdt_trc20'),
      to:   EP.byId(root.getAttribute('data-to') || '')   || EP.byId('mpesa_kes'),
      amount: 100,
      side: 'from'
    };

    // restore the customer's last pair so the widget feels stateful
    var last = EP.store.get('lastPair', null);
    if (last && !root.hasAttribute('data-from')) {
      var f = EP.byId(last.from), t = EP.byId(last.to);
      if (f && t && EP.allowed(f, t)) { st.from = f; st.to = t; }
    }

    root.innerHTML =
      '<div class="xchg">' +
        '<div class="xchg__label">You send</div>' +
        fieldHtml('from', st.from, EP.fmt(st.amount)) +
        '<div class="xchg__swap"><button class="xchg__swapbtn" data-swap aria-label="Swap">&#8645;</button></div>' +
        '<div class="xchg__label">You receive</div>' +
        fieldHtml('to', st.to, '0') +
        '<div class="xchg__meta" data-meta></div>' +
        '<div class="xchg__err" data-err></div>' +
        '<div style="margin-top:16px"><button class="btn btn--lg btn--block" data-go>Exchange</button></div>' +
        '<div class="xchg__note" data-note></div>' +
      '</div>';

    var q = function (s) { return root.querySelector(s); };

    function calc() {
      var r = EP.rate(st.from, st.to);
      var send, recv;
      if (st.side === 'from') { send = st.amount; recv = send * r; }
      else { recv = st.amount; send = r ? recv / r : 0; }
      return { r: r, send: send, recv: recv };
    }

    function validate(c) {
      if (!EP.allowed(st.from, st.to))
        return 'This direction is closed. Pick another pair.';
      if (!(c.send > 0))
        return 'Enter an amount to exchange.';
      if (c.send < st.from.min)
        return 'Minimum is ' + EP.money(st.from.min, st.from.code) + '.';
      if (c.send > st.from.max)
        return 'Maximum is ' + EP.money(st.from.max, st.from.code) + '. Contact an operator for larger amounts.';
      if (c.recv > st.to.reserve)
        return 'Reserve is only ' + EP.money(st.to.reserve, st.to.code) + '. Reduce the amount.';
      return '';
    }

    function paint() {
      var c = calc();

      q('[data-cur="from"]').textContent = EP.label(st.from);
      q('[data-cur="to"]').textContent = EP.label(st.to);
      q('[data-open="from"] .field__ico').outerHTML = ico(st.from);
      q('[data-open="to"] .field__ico').outerHTML = ico(st.to);

      if (st.side === 'from') q('[data-amt="to"]').value = EP.fmt(c.recv);
      else q('[data-amt="from"]').value = EP.fmt(c.send);

      q('[data-meta]').innerHTML =
        'Exchange rate: 1 ' + st.from.code + ' = ' + EP.fmt(c.r) + ' ' + st.to.code +
        '<span class="muted">Reserve: ' + EP.money(st.to.reserve, st.to.code) + '</span>';

      q('[data-note]').textContent =
        'Limits ' + EP.fmt(st.from.min) + ' - ' + EP.fmt(st.from.max) + ' ' + st.from.code +
        ' | service fee ' + (st.from.fee * 100).toFixed(1) + '% | quote locked 20 min';

      var err = validate(c);
      var box = q('[data-err]');
      box.textContent = err;
      box.classList.toggle('is-on', !!err);
      q('[data-go]').disabled = !!err;

      EP.store.set('lastPair', { from: st.from.id, to: st.to.id });

      if (!err) confirmWithServer();
    }

    /* The figures above are computed in the browser for instant feedback, but
       the server prices the order. Re-quote against it (debounced) so what the
       customer sees is what they will actually get, and surface a server-side
       refusal - a closed direction, a stale pivot - that the local copy of the
       catalogue cannot know about. */
    var quoteTimer = null;
    var quoteSeq = 0;

    function confirmWithServer() {
      if (!EP.live || !EP.quote) return;
      clearTimeout(quoteTimer);
      var seq = ++quoteSeq;
      var amount = st.amount;
      var side = st.side;
      var fromId = st.from.id;
      var toId = st.to.id;

      quoteTimer = setTimeout(function () {
        EP.quote(fromId, toId, amount, side === 'from' ? 'send' : 'receive')
          .then(function (res) {
            // a later keystroke already superseded this answer
            if (seq !== quoteSeq) return;
            if (fromId !== st.from.id || toId !== st.to.id) return;

            var box = q('[data-err]');
            if (!res.ok) {
              box.textContent = res.error || 'This direction is unavailable.';
              box.classList.add('is-on');
              q('[data-go]').disabled = true;
              return;
            }

            if (side === 'from') q('[data-amt="to"]').value = EP.fmt(Number(res.recv));
            else q('[data-amt="from"]').value = EP.fmt(Number(res.send));

            q('[data-meta]').innerHTML =
              'Exchange rate: 1 ' + st.from.code + ' = ' + EP.fmt(Number(res.rate)) + ' ' + st.to.code +
              '<span class="muted">Reserve: ' + EP.money(Number(res.available), st.to.code) + '</span>';

            box.textContent = '';
            box.classList.remove('is-on');
            q('[data-go]').disabled = false;
          })
          .catch(function () { /* keep the local figure; the order still re-prices */ });
      }, 260);
    }

    function openPicker(side) {
      root.querySelectorAll('.picker').forEach(function (p) { p.classList.remove('is-open'); });
      var p = root.querySelector('[data-picker="' + side + '"]');
      if (!p) return;
      p.querySelector('[data-opts]').innerHTML =
        optionsHtml(side, st[side].id, side === 'from' ? st.to : st.from, '');
      p.querySelector('[data-search]').value = '';
      p.classList.add('is-open');
      p.querySelector('[data-search]').focus();
    }

    /* ------------------------------------------------------------ events */
    root.addEventListener('click', function (e) {
      var open = e.target.closest('[data-open]');
      if (open && !e.target.closest('.picker')) {
        var side = open.getAttribute('data-open');
        var p = root.querySelector('[data-picker="' + side + '"]');
        if (p.classList.contains('is-open')) p.classList.remove('is-open');
        else openPicker(side);
        return;
      }

      var pick = e.target.closest('[data-pick]');
      if (pick) {
        var pside = pick.closest('[data-picker]').getAttribute('data-picker');
        var cur = EP.byId(pick.getAttribute('data-pick'));
        st[pside_fix(pside)] = cur;
        // if the new pick closes the direction, move the other leg to something legal
        if (!EP.allowed(st.from, st.to)) {
          var other = pside_fix(pside) === 'from' ? 'to' : 'from';
          var repl = EP.currencies.filter(function (c) {
            return other === 'to' ? EP.allowed(st.from, c) : EP.allowed(c, st.to);
          })[0];
          if (repl) st[other] = repl;
        }
        root.querySelectorAll('.picker').forEach(function (p) { p.classList.remove('is-open'); });
        paint();
        return;
      }

      if (e.target.closest('[data-swap]')) {
        var f = st.from; st.from = st.to; st.to = f;
        if (!EP.allowed(st.from, st.to)) { st.to = st.from; st.from = f; EP.toast('Reverse direction is closed', 'err'); }
        st.side = 'from';
        paint();
        return;
      }

      if (e.target.closest('[data-go]')) {
        var c = calc();
        if (validate(c)) return;
        // Amounts travel as a hint only: order.html re-quotes, and the server
        // re-prices again when the order is actually created.
        var params = new URLSearchParams({
          from: st.from.id, to: st.to.id,
          send: c.send.toFixed(8), recv: c.recv.toFixed(8)
        });
        location.href = EP.url('pages/order.html') + '?' + params.toString();
      }
    });

    function pside_fix(s) { return s === 'from' ? 'from' : 'to'; }

    root.addEventListener('input', function (e) {
      var amt = e.target.closest('[data-amt]');
      if (amt) {
        st.side = amt.getAttribute('data-amt');
        st.amount = parseFloat(String(amt.value).replace(/\s/g, '').replace(',', '.')) || 0;
        paint();
        return;
      }
      var s = e.target.closest('[data-search]');
      if (s) {
        var side = s.closest('[data-picker]').getAttribute('data-picker');
        s.closest('.picker').querySelector('[data-opts]').innerHTML =
          optionsHtml(side, st[side].id, side === 'from' ? st.to : st.from, s.value.trim().toLowerCase());
      }
    });

    document.addEventListener('click', function (e) {
      if (!e.target.closest('[data-exchanger]')) {
        root.querySelectorAll('.picker').forEach(function (p) { p.classList.remove('is-open'); });
      }
    });

    paint();
  }

  /* -------------------------------------------------------- content bits */
  var render = {
    steps: function (el) {
      var h = '';
      EP.steps.forEach(function (s, i) {
        if (i) h += '<div class="steps__arrow">&#10230;</div>';
        h += '<div class="step"><div class="step__n">' + s.n + '</div>' +
             '<h3>' + s.t + '</h3><p>' + s.d + '</p></div>';
      });
      el.innerHTML = h;
    },

    advantages: function (el) {
      var h = '';
      EP.advantages.forEach(function (a) { h += '<li><i>&#10003;</i>' + a + '</li>'; });
      el.innerHTML = h;
    },

    reviews: function (el) {
      var n = parseInt(el.getAttribute('data-limit') || '6', 10);
      el.innerHTML = EP.reviews.slice(0, n).map(function (r) {
        return '<div class="review"><div class="stars">&#9733;&#9733;&#9733;&#9733;&#9733;</div>' +
          '<div class="review__body">' + r.text + '</div>' +
          '<div class="review__who"><span class="review__av">' + r.who.charAt(0) + '</span>' +
          '<span><b>' + r.who + '</b><span>' + r.date + '</span></span></div></div>';
      }).join('');
    },

    news: function (el) {
      var n = parseInt(el.getAttribute('data-limit') || '3', 10);
      el.innerHTML = EP.news.slice(0, n).map(function (p) {
        return '<div class="post"><div class="post__date">' + p.date + '</div>' +
          '<h3>' + p.title + '</h3><p>' + p.excerpt + '</p>' +
          '<a href="' + EP.url('pages/article.html') +
            (p.slug ? '?slug=' + encodeURIComponent(p.slug) : '') +
            '">Read more &#8594;</a></div>';
      }).join('');
    },

    partners: function (el) {
      el.innerHTML = EP.partners.map(function (p) {
        return '<div class="partner">' + p + '</div>';
      }).join('');
    },

    faq: function (el) {
      el.innerHTML = EP.faq.map(function (f) {
        return '<div class="acc"><button class="acc__q">' + f.q + ' <i>+</i></button>' +
               '<div class="acc__a">' + f.a + '</div></div>';
      }).join('');
    },

    rates: function (el) {
      var tb = el.querySelector('tbody');
      // filters live outside the table wrapper on the full rates page
      var scope = el.closest('[data-rates-scope]') || document;
      var search = scope.querySelector('[data-rsearch]');
      var grp = scope.querySelector('[data-rgroup]');
      var cap = parseInt(el.getAttribute('data-limit') || '300', 10);

      function rows() {
        var q = (search && search.value || '').trim().toLowerCase();
        var g = grp && grp.value || '';
        var out = [];
        EP.currencies.forEach(function (from) {
          EP.currencies.forEach(function (to) {
            if (!EP.allowed(from, to)) return;
            if (g && from.group !== g) return;
            var lab = (EP.label(from) + ' ' + EP.label(to)).toLowerCase();
            if (q && lab.indexOf(q) === -1) return;
            out.push({ f: from, t: to, r: EP.rate(from, to) });
          });
        });
        return out;
      }

      function paint() {
        var all = rows();
        var list = all.slice(0, cap);
        tb.innerHTML = list.length ? list.map(function (d) {
          return '<tr>' +
            '<td><span class="cell-cur">' + ico(d.f) + '<b>' + EP.label(d.f) + '</b></span></td>' +
            '<td><span class="cell-cur">' + ico(d.t) + '<b>' + EP.label(d.t) + '</b></span></td>' +
            '<td class="mono">1 ' + d.f.code + ' = ' + EP.fmt(d.r) + ' ' + d.t.code + '</td>' +
            '<td class="mono">' + EP.fmt(d.f.min) + ' - ' + EP.fmt(d.f.max) + ' ' + d.f.code + '</td>' +
            '<td class="mono">' + EP.money(d.t.reserve, d.t.code) + '</td>' +
            '<td><a class="btn btn--sm" href="' + EP.url('index.html') +
              '?from=' + d.f.id + '&to=' + d.t.id + '">Exchange</a></td>' +
          '</tr>';
        }).join('') : '<tr><td colspan="6" class="center muted" style="padding:28px">No directions match your filter</td></tr>';
        var cnt = scope.querySelector('[data-rcount]');
        if (cnt) cnt.textContent = all.length + ' open directions' +
          (all.length > list.length ? ' (showing ' + list.length + ')' : '');
      }

      if (search) search.addEventListener('input', paint);
      if (grp) grp.addEventListener('change', paint);
      paint();
    },

    reserves: function (el) {
      var tb = el.querySelector('tbody');
      tb.innerHTML = EP.currencies.map(function (c) {
        var pct = Math.min(100, Math.round((c.reserve * c.rate) / 5000));
        return '<tr>' +
          '<td><span class="cell-cur">' + ico(c) + '<b>' + EP.label(c) + '</b></span></td>' +
          '<td>' + EP.groups[c.group] + '</td>' +
          '<td class="mono">' + EP.money(c.reserve, c.code) + '</td>' +
          '<td class="mono">$' + EP.fmt(c.reserve * c.rate, 0) + '</td>' +
          '<td><span class="tag ' + (pct > 40 ? 'tag--ok' : pct > 12 ? 'tag--wait' : 'tag--err') + '">' +
            (pct > 40 ? 'High' : pct > 12 ? 'Medium' : 'Low') + '</span></td>' +
        '</tr>';
      }).join('');
    }
  };

  EP.render = render;
  EP.ico = ico;

  /* ---------------------------------------------------------------- boot */
  function boot() {
    // deep link: index.html?from=..&to=..
    var p = new URLSearchParams(location.search);
    document.querySelectorAll('[data-exchanger]').forEach(function (el) {
      if (p.get('from') && EP.byId(p.get('from'))) el.setAttribute('data-from', p.get('from'));
      if (p.get('to') && EP.byId(p.get('to'))) el.setAttribute('data-to', p.get('to'));
      Exchanger(el);
    });

    Object.keys(render).forEach(function (k) {
      document.querySelectorAll('[data-render="' + k + '"]').forEach(function (el) {
        render[k](el);
      });
    });
  }

  /* The catalogue may still be loading, so hold rendering until api.js has
     either adopted live data or fallen back to the bundled dataset. */
  function start() {
    if (window.EP && EP.ready && typeof EP.ready.then === 'function') EP.ready.then(boot, boot);
    else boot();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
