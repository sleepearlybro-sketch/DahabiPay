/* ==========================================================================
   API client for the public site.

   Replaces the bundled dataset in data.js with live catalogue data, and
   falls back to it when the server is unreachable - so the pages still open
   straight off the filesystem as a static demo.

   Every page that needs data waits on EP.ready.
   ========================================================================== */

(function () {
  'use strict';

  var EP = window.EP = window.EP || {};

  // Same-origin when served by the Node app; the fallback keeps file://
  // pages working, where relative /api paths would resolve to nothing.
  EP.apiBase = /^https?:/.test(location.protocol) ? '' : null;
  EP.live = false;

  /* ------------------------------------------------------------- request */
  EP.api = function (path, opts) {
    opts = opts || {};
    if (EP.apiBase === null) {
      return Promise.reject(new Error('Not connected to a server'));
    }
    return fetch(EP.apiBase + '/api' + path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
        if (!res.ok) {
          var err = new Error((data && data.error) || 'Request failed (' + res.status + ')');
          err.status = res.status;
          err.field = data && data.field;
          throw err;
        }
        return data;
      });
    });
  };

  /* ------------------------------------------------------------ catalogue
     The server speaks basis points and decimal strings; the widget's
     display maths wants numbers and a fraction, so normalise once here.  */
  function adoptCurrencies(list) {
    return list.map(function (c) {
      return {
        id: c.id,
        name: c.name,
        net: c.net,
        code: c.code,
        group: c.group,
        color: c.color,
        rate: Number(c.rate),
        reserve: Number(c.reserve),
        min: Number(c.min),
        max: Number(c.max),
        fee: (c.feeBp || 0) / 10000,
        field: c.field,
        manual: c.manual,
        stale: c.stale
      };
    });
  }

  function bootstrap() {
    return EP.api('/v1/bootstrap').then(function (data) {
      EP.live = true;
      EP.groups = data.groups;
      EP.currencies = adoptCurrencies(data.currencies);
      EP.directions = data.directions;
      EP.lockMinutes = data.site.lockMinutes;
      EP.maintenance = data.site.maintenance;

      if (data.reviews && data.reviews.length) {
        EP.reviews = data.reviews.map(function (r) {
          return { who: r.who, text: r.text, date: fmtDate(r.created_at) };
        });
      }
      if (data.news && data.news.length) {
        EP.news = data.news.map(function (n) {
          return { slug: n.slug, title: n.title, excerpt: n.excerpt, date: fmtDate(n.published_at) };
        });
      }
      return true;
    }).catch(function (err) {
      // Keep the bundled dataset. Worth saying out loud in the console,
      // because otherwise a stale demo looks like live data.
      console.warn('Dahabi Pay: running on the bundled demo dataset (' + err.message + ')');
      EP.live = false;
      return false;
    });
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return String(iso);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() +
      ', ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  EP.fmtDate = fmtDate;

  /* --------------------------------------------------------------- session */
  EP.me = null;

  EP.loadMe = function () {
    return EP.api('/auth/me')
      .then(function (d) { EP.me = d.user; return d.user; })
      .catch(function () { EP.me = null; return null; });
  };

  /**
   * Authoritative quote from the server. The widget's own arithmetic is for
   * instant feedback; this is the number the order will actually use.
   */
  EP.quote = function (fromId, toId, amount, side) {
    return EP.api('/v1/quote', {
      method: 'POST',
      body: { from: fromId, to: toId, amount: String(amount), side: side || 'send' }
    });
  };

  EP.createOrder = function (payload) {
    return EP.api('/orders', { method: 'POST', body: payload });
  };

  EP.getOrder = function (id, token) {
    return EP.api('/orders/' + encodeURIComponent(id) + (token ? '?t=' + encodeURIComponent(token) : ''));
  };

  /* ------------------------------------------------------------------ ready
     One promise every page can wait on, whether or not a server is there. */
  EP.ready = bootstrap().then(function (live) {
    return live ? EP.loadMe().then(function () { return live; }) : live;
  });
})();
