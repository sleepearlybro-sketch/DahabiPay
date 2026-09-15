/* ==========================================================================
   Monitor XML feed.

   The layout the common exchanger monitors expect, so a listing needs no
   custom integration on their side. Directions whose pivot has gone stale
   are omitted entirely rather than published at an old price - a monitor
   advertising a rate we will not honour is worse than a missing row.
   ========================================================================== */

import * as db from '../db.js';
import * as M from './money.js';
import { directionOpen, feeBpFor, pivotStale, currency } from './orders.js';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Monitors key on code+network, e.g. USDTTRC20. */
const feedCode = (c) => `${c.code}${c.net ? c.net.toUpperCase().replace(/[^A-Z0-9]/g, '') : ''}`;

export async function buildFeed() {
  const currencies = await db.all('SELECT * FROM currencies WHERE enabled = 1 ORDER BY sort_order');
  const items = [];

  for (const from of currencies) {
    if (await pivotStale(from)) continue;
    for (const to of currencies) {
      if (!await directionOpen(from, to) || await pivotStale(to)) continue;

      const feeBp = await feeBpFor(from, to);
      const rate = M.crossRate(from.pivot_usd, to.pivot_usd, feeBp);
      if (!M.isPos(rate)) continue;

      const available = M.sub(to.reserve, to.reserved);
      if (!M.isPos(available)) continue;

      // monitors want the smaller side normalised to 1
      const flip = M.lt(rate, '1');
      const inAmt = flip ? M.str(M.div('1', rate), 8) : '1';
      const outAmt = flip ? '1' : M.str(rate, 8);

      items.push(
        '  <item>\n' +
        `    <from>${esc(feedCode(from))}</from>\n` +
        `    <to>${esc(feedCode(to))}</to>\n` +
        `    <in>${inAmt}</in>\n` +
        `    <out>${outAmt}</out>\n` +
        `    <amount>${M.str(available, 8)}</amount>\n` +
        `    <minamount>${M.str(from.min_amt)} ${esc(from.code)}</minamount>\n` +
        `    <maxamount>${M.str(from.max_amt)} ${esc(from.code)}</maxamount>\n` +
        `    <fromfee>${(feeBp / 100).toFixed(2)}%</fromfee>\n` +
        (to.manual ? '    <param>manual</param>\n' : '') +
        '  </item>'
      );
    }
  }

  return '<?xml version="1.0" encoding="UTF-8"?>\n<rates>\n' + items.join('\n') + '\n</rates>\n';
}

/** JSON mirror of the same data, for anyone who would rather not parse XML. */
export async function buildJson() {
  const currencies = await db.all('SELECT * FROM currencies WHERE enabled = 1 ORDER BY sort_order');
  const out = [];
  for (const from of currencies) {
    if (await pivotStale(from)) continue;
    for (const to of currencies) {
      if (!await directionOpen(from, to) || await pivotStale(to)) continue;
      const feeBp = await feeBpFor(from, to);
      const rate = M.crossRate(from.pivot_usd, to.pivot_usd, feeBp);
      if (!M.isPos(rate)) continue;
      out.push({
        from: from.id,
        to: to.id,
        fromCode: feedCode(from),
        toCode: feedCode(to),
        rate: M.str(rate),
        min: M.str(from.min_amt),
        max: M.str(from.max_amt),
        reserve: M.str(M.sub(to.reserve, to.reserved)),
        feeBp,
        manual: !!to.manual
      });
    }
  }
  return out;
}

export { currency };
