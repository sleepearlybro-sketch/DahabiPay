/* ==========================================================================
   Dahabi Pay - shell + shared helpers
   Injects the header / nav / drawer / footer on every page so the chrome
   lives in one place, and exposes formatting + storage utilities.
   ========================================================================== */

(function () {
  'use strict';

  var S = EP.site;

  /* ---------------------------------------------------------------- paths */
  // Pages live either at the root or under /pages/, so links are rewritten
  // against a base prefix instead of hard-coding depth in every file.
  var BASE = /[\\/]pages[\\/]/.test(location.pathname) ? '../' : '';
  EP.base = BASE;
  EP.url = function (p) { return BASE + p; };

  /* ------------------------------------------------------------ utilities */
  EP.fmt = function (n, dp) {
    if (!isFinite(n)) return '0';
    if (dp === undefined) dp = n >= 1000 ? 2 : (n >= 1 ? 4 : 8);
    var s = Number(n).toFixed(dp);
    if (s.indexOf('.') > -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    var p = s.split('.');
    p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return p.join('.');
  };

  EP.money = function (n, code) { return EP.fmt(n) + ' ' + code; };

  EP.byId = function (id) {
    for (var i = 0; i < EP.currencies.length; i++) {
      if (EP.currencies[i].id === id) return EP.currencies[i];
    }
    return null;
  };

  EP.label = function (c) {
    return c.name + (c.net ? ' ' + c.net : '') + ' ' + c.code;
  };

  EP.initials = function (c) {
    return (c.code || '?').slice(0, 4);
  };

  // Cross rate: how many units of `to` for one unit of `from`, fee applied.
  EP.rate = function (from, to) {
    if (!from || !to) return 0;
    return (from.rate * (1 - from.fee)) / to.rate;
  };

  EP.allowed = function (from, to) {
    if (!from || !to || from.id === to.id) return false;
    for (var i = 0; i < EP.directions.length; i++) {
      var d = EP.directions[i];
      if ((d.from === '*' || d.from === from.group) &&
          (d.to === '*' || d.to === to.group)) return true;
    }
    return false;
  };

  EP.store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('ep:' + k); return v ? JSON.parse(v) : d; }
      catch (e) { return d; }
    },
    set: function (k, v) {
      try { localStorage.setItem('ep:' + k, JSON.stringify(v)); } catch (e) {}
    },
    del: function (k) { try { localStorage.removeItem('ep:' + k); } catch (e) {} }
  };

  EP.orderId = function () {
    return 'EP-' + Math.random().toString(36).slice(2, 7).toUpperCase() +
           '-' + String(Date.now()).slice(-5);
  };

  EP.toast = function (msg, kind) {
    var box = document.querySelector('.toasts');
    if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
    var t = document.createElement('div');
    t.className = 'toast' + (kind ? ' toast--' + kind : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  };

  EP.copy = function (text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        function () { EP.toast('Copied', 'ok'); },
        function () { EP.toast('Copy failed', 'err'); }
      );
    } else {
      EP.toast('Copy not supported here', 'err');
    }
  };

  /* ------------------------------------------------------------ site tree */
  var NAV = [
    { t: 'Exchange', h: 'index.html' },
    { t: 'Rates', h: 'pages/rates.html' },
    { t: 'User Agreement', h: 'pages/agreement.html', sub: [
        { t: 'AML / KYC Policy',  h: 'pages/aml-kyc.html' },
        { t: 'Privacy Policy',    h: 'pages/privacy.html' },
        { t: 'Returns Policy',    h: 'pages/returns.html' },
        { t: 'Fixing rates',      h: 'pages/fixing-rates.html' },
        { t: 'About us',          h: 'pages/about.html' }
      ] },
    { t: 'News', h: 'pages/news.html' },
    { t: 'FAQ',  h: 'pages/faq.html' }
  ];

  var FOOT = [
    { h: 'Exchange', items: [
        { t: 'Exchange',        h: 'index.html' },
        { t: 'Rates & reserves',h: 'pages/rates.html' },
        { t: 'Rates API (XML)', h: 'pages/api.html' },
        { t: 'Contacts',        h: 'pages/about.html' }
      ] },
    { h: 'Account', items: [
        { t: 'Personal Profile',    h: 'pages/profile.html' },
        { t: 'My Account',          h: 'pages/account.html' },
        { t: 'Transactions history',h: 'pages/history.html' },
        { t: 'Track an application',h: 'pages/track.html' },
        { t: 'Security',            h: 'pages/security.html' },
        { t: 'Sign in',             h: 'pages/signin.html' }
      ] },
    { h: 'Affiliate program', items: [
        { t: 'Affiliate account',            h: 'pages/affiliate.html' },
        { t: 'Terms of the affiliate program',h: 'pages/affiliate-terms.html' },
        { t: 'Affiliate money withdrawal',   h: 'pages/affiliate.html#withdraw' },
        { t: 'Affiliate exchanges',          h: 'pages/affiliate.html#exchanges' }
      ] }
  ];

  /* --------------------------------------------------------------- render */
  function logo(sub) {
    return '<a class="logo" href="' + EP.url('index.html') + '">' +
      '<span class="logo__mark">' + S.brand.charAt(0) + '</span>' +
      '<span><span class="logo__text">' + S.brandA + '<em>' + S.brandB + '</em></span>' +
      (sub ? '<span class="logo__sub">' + S.tagline + '</span>' : '') + '</span></a>';
  }

  function here(h) {
    var file = location.pathname.split('/').pop() || 'index.html';
    return h.split('/').pop().split('#')[0] === file;
  }

  function navItem(n) {
    var cls = here(n.h) ? ' class="is-active"' : '';
    if (!n.sub) return '<a' + cls + ' href="' + EP.url(n.h) + '">' + n.t + '</a>';
    var s = '<div class="nav__item"><a' + cls + ' href="' + EP.url(n.h) + '">' + n.t +
            ' <span class="nav__caret">&#9662;</span></a><div class="nav__sub">';
    n.sub.forEach(function (i) { s += '<a href="' + EP.url(i.h) + '">' + i.t + '</a>'; });
    return s + '</div></div>';
  }

  function header() {
    var h = '<header class="header"><div class="shell"><div class="header__row">' +
      logo(true) +
      '<div class="header__mid">' +
        '<div class="header__contacts">' +
          '<a href="' + S.tgChannel + '">&#9992; TG-channel</a>' +
          '<a href="' + S.tgOperator + '">&#9992; TG-operator</a>' +
          '<a href="mailto:' + S.email + '">&#9993; ' + S.email + '</a>' +
        '</div>' +
        '<div class="header__claim">' + S.claim + '</div>' +
      '</div>' +
      '<div class="header__actions">' +
        '<div class="lang"><button class="lang__btn" data-lang>EN <span class="nav__caret">&#9662;</span></button>' +
          '<div class="lang__menu" hidden><a href="#" data-setlang="en">English</a>' +
          '<a href="#" data-setlang="fr">Fran&ccedil;ais</a><a href="#" data-setlang="ar">&#1575;&#1604;&#1593;&#1585;&#1576;&#1610;&#1577;</a></div>' +
        '</div>' +
        '<span class="header__auth">' +
          '<a class="btn btn--light btn--sm" href="' + EP.url('pages/signup.html') + '">Sign up</a>' +
          '<a class="btn btn--ghost btn--sm" style="--btn-bd:rgba(255,255,255,.5);--btn-fg:#fff" href="' + EP.url('pages/signin.html') + '">Sign in</a>' +
        '</span>' +
        '<button class="burger" data-burger aria-label="Menu"><span></span></button>' +
      '</div>' +
      '</div></div>' +
      '<div class="nav"><div class="shell"><div class="nav__row">';
    NAV.forEach(function (n) { h += navItem(n); });
    return h + '</div></div></div></header>';
  }

  function drawer() {
    var d = '<div class="drawer" data-drawer><div class="drawer__veil" data-close></div>' +
      '<div class="drawer__panel"><button class="drawer__close" data-close>&times;</button>' +
      '<div style="display:flex;gap:8px;margin:38px 0 4px">' +
        '<a class="btn btn--sm" style="flex:1" href="' + EP.url('pages/signup.html') + '">Sign up</a>' +
        '<a class="btn btn--sm btn--ghost" style="flex:1" href="' + EP.url('pages/signin.html') + '">Sign in</a>' +
      '</div>' +
      '<h4>Menu</h4>';
    NAV.forEach(function (n) {
      d += '<a href="' + EP.url(n.h) + '">' + n.t + '</a>';
      if (n.sub) n.sub.forEach(function (i) {
        d += '<a style="padding-left:16px;font-weight:600;color:var(--muted)" href="' + EP.url(i.h) + '">' + i.t + '</a>';
      });
    });
    FOOT.forEach(function (g) {
      d += '<h4>' + g.h + '</h4>';
      g.items.forEach(function (i) { d += '<a href="' + EP.url(i.h) + '">' + i.t + '</a>'; });
    });
    d += '<h4>Contacts</h4>' +
      '<a href="' + S.tgChannel + '">Telegram channel</a>' +
      '<a href="' + S.tgOperator + '">Telegram operator</a>' +
      '<a href="mailto:' + S.email + '">' + S.email + '</a>';
    return d + '</div></div>';
  }

  function footer() {
    var f = '<footer class="footer"><div class="shell"><div class="footer__grid"><div>' +
      logo(true) + '<div class="footer__claim">' + S.claim + '</div></div>';
    FOOT.forEach(function (g) {
      f += '<div><h4>' + g.h + '</h4><ul>';
      g.items.forEach(function (i) { f += '<li><a href="' + EP.url(i.h) + '">' + i.t + '</a></li>'; });
      f += '</ul></div>';
    });
    f += '</div><div class="footer__bar"><span>&copy; ' + new Date().getFullYear() + ' ' + S.brand +
      '. Demo build - rates and reserves are sample data.</span>' +
      '<span><a href="' + EP.url('pages/agreement.html') + '">User Agreement</a> &middot; ' +
      '<a href="' + EP.url('pages/privacy.html') + '">Privacy</a> &middot; ' +
      '<a href="' + EP.url('pages/aml-kyc.html') + '">AML/KYC</a></span>' +
      '</div></div></footer>';
    return f;
  }

  // Account sidebar, shared by every dashboard page.
  var SIDE = [
    { t: 'Personal Profile',     h: 'pages/profile.html' },
    { t: 'My Account',           h: 'pages/account.html' },
    { t: 'Transactions history', h: 'pages/history.html' },
    { t: 'Affiliate account',    h: 'pages/affiliate.html' },
    { t: 'Security',             h: 'pages/security.html' },
    { t: 'Verification',         h: 'pages/kyc.html' }
  ];

  function sidebar() {
    var s = EP.store.get('session', null);
    var who = s ? s.login : 'guest';
    var h = '<aside class="side"><div class="side__user">' +
      '<span class="side__av" data-avatar>' + who.charAt(0).toUpperCase() + '</span>' +
      '<span><b data-user>' + who + '</b>' +
      '<span data-user-state>' + (s ? 'signed in' : 'checking…') + '</span></span></div><nav>';
    SIDE.forEach(function (i) {
      h += '<a' + (here(i.h) ? ' class="is-active"' : '') + ' href="' + EP.url(i.h) + '">' + i.t + '</a>';
    });
    h += '<a href="#" data-logout>Sign out</a></nav></aside>';
    return h;
  }

  function widgets() {
    var now = new Date();
    var stamp = String(now.getDate()).padStart(2, '0') + '.' +
                String(now.getMonth() + 1).padStart(2, '0') + '.' + now.getFullYear();
    return '<button class="operator" data-support>Operator online ' + stamp + '</button>' +
           '<button class="chatbtn" data-support aria-label="Chat">&#128172;</button>' +
           '<div class="toasts"></div>';
  }

  /* ----------------------------------------------------------------- boot */
  function mount() {
    var top = document.querySelector('[data-shell-header]');
    if (top) top.outerHTML = header();
    // swap the auth buttons for the signed-in account once the session is known
    if (window.EP && EP.ready && typeof EP.ready.then === 'function') {
      EP.ready.then(reflectSession, function () {});
    }
    var side = document.querySelector('[data-shell-side]');
    if (side) side.outerHTML = sidebar();
    var bot = document.querySelector('[data-shell-footer]');
    if (bot) bot.outerHTML = footer();
    document.body.insertAdjacentHTML('beforeend', drawer() + widgets());

    // burger
    var dr = document.querySelector('[data-drawer]');
    document.addEventListener('click', function (e) {
      if (e.target.closest('[data-burger]')) { dr.classList.add('is-open'); }
      else if (e.target.closest('[data-close]')) { dr.classList.remove('is-open'); }
      else if (e.target.closest('[data-support]')) {
        e.preventDefault();
        EP.toast('Support chat is not wired in this demo - use ' + S.email);
      }
      // language menu
      var lb = e.target.closest('[data-lang]');
      var menu = document.querySelector('.lang__menu');
      if (menu) {
        if (lb) { menu.hidden = !menu.hidden; }
        else if (!e.target.closest('.lang__menu')) { menu.hidden = true; }
      }
      var sl = e.target.closest('[data-setlang]');
      if (sl) {
        e.preventDefault();
        document.querySelector('[data-lang]').innerHTML =
          sl.getAttribute('data-setlang').toUpperCase() + ' <span class="nav__caret">&#9662;</span>';
        EP.toast('Only the English locale ships in this demo');
      }
      // copy buttons
      var cp = e.target.closest('[data-copy]');
      if (cp) { e.preventDefault(); EP.copy(cp.getAttribute('data-copy')); }
      // accordion
      var aq = e.target.closest('.acc__q');
      if (aq) aq.parentElement.classList.toggle('is-open');
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && dr) dr.classList.remove('is-open');
    });
  }

  /** Replace Sign up / Sign in with the account link for a signed-in user. */
  function reflectSession() {
    var user = EP.me || EP.store.get('session', null);

    /* The sidebar is rendered at mount, before the session cookie has been
       checked, so it has to be corrected here rather than guessed earlier. */
    var state = document.querySelector('[data-user-state]');
    if (state) state.textContent = user ? 'signed in' : 'not signed in';
    if (user) {
      var nameEl = document.querySelector('.side [data-user]');
      var avatar = document.querySelector('[data-avatar]');
      if (nameEl) nameEl.textContent = user.login;
      if (avatar) avatar.textContent = (user.login || '?').charAt(0).toUpperCase();
    }

    var auth = document.querySelector('.header__auth');
    if (!auth || !user) return;

    var name = user.login || 'account';
    auth.innerHTML =
      '<a class="btn btn--light btn--sm" href="' + EP.url('pages/profile.html') + '">' + name + '</a>' +
      '<button class="btn btn--ghost btn--sm" style="--btn-bd:rgba(255,255,255,.5);--btn-fg:#fff" data-logout>Sign out</button>';

    if (user.role === 'operator' || user.role === 'admin') {
      auth.insertAdjacentHTML('afterbegin',
        '<a class="btn btn--ghost btn--sm" style="--btn-bd:var(--green-300);--btn-fg:var(--green-300)" href="' +
        EP.base + 'admin/">Operator panel</a>');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else { mount(); }
})();
