/* ==========================================================================
   Order pricing, reserve accounting and the status state machine.

   This is the file that decides what a customer is owed, so it is also the
   file where a bug costs money. Three rules it enforces without exception:

     1. Amounts and rates are computed here from our own pivots. A client-sent
        figure is a display hint, never an input to a payout.
     2. Receiving liquidity is committed (currencies.reserved) inside the same
        transaction that creates the order, so concurrent orders cannot both
        pass one reserve check.
     3. Status only ever moves along TRANSITIONS, and every move is appended to
        order_events.
   ========================================================================== */

import * as db from '../db.js';
import * as M from './money.js';
import { config } from '../config.js';
import { HttpError } from './http.js';
import { newOrderId, newToken } from './auth.js';

/* --------------------------------------------------------------- statuses */
export const STATES = {
  CREATED: 'created',
  AWAITING: 'awaiting_payment',
  DETECTED: 'payment_detected',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
  ON_HOLD: 'on_hold',
  REFUNDED: 'refunded'
};

const S = STATES;

/** Anything not listed here is rejected, including same-state writes. */
const TRANSITIONS = {
  [S.CREATED]:    [S.AWAITING, S.CANCELLED, S.ON_HOLD],
  [S.AWAITING]:   [S.DETECTED, S.EXPIRED, S.CANCELLED, S.ON_HOLD],
  [S.DETECTED]:   [S.PROCESSING, S.ON_HOLD, S.CANCELLED],
  [S.PROCESSING]: [S.COMPLETED, S.ON_HOLD],
  [S.ON_HOLD]:    [S.AWAITING, S.DETECTED, S.PROCESSING, S.REFUNDED, S.CANCELLED],
  [S.COMPLETED]:  [],
  [S.EXPIRED]:    [S.AWAITING, S.REFUNDED, S.CANCELLED],
  [S.CANCELLED]:  [],
  [S.REFUNDED]:   []
};

export const TERMINAL = [S.COMPLETED, S.CANCELLED, S.REFUNDED];

/**
 * States in which we are still holding receiving liquidity for the order.
 *
 * EXPIRED is deliberately absent. An expired quote returns its liquidity to
 * the pool immediately - otherwise abandoned orders accumulate holds and
 * starve the reserve, which is the oversell problem arriving slowly instead
 * of all at once. requote() takes a fresh hold, re-checking availability at
 * the new price, which is the correct behaviour anyway: time has passed.
 */
const HOLDS_RESERVE = [S.CREATED, S.AWAITING, S.DETECTED, S.PROCESSING, S.ON_HOLD];

export const isTerminal = (s) => TERMINAL.includes(s);
export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

/** Customer-facing label, shared with the front-end. */
export const LABELS = {
  [S.CREATED]: 'Created',
  [S.AWAITING]: 'Awaiting payment',
  [S.DETECTED]: 'Payment detected',
  [S.PROCESSING]: 'Processing',
  [S.COMPLETED]: 'Completed',
  [S.EXPIRED]: 'Quote expired',
  [S.CANCELLED]: 'Cancelled',
  [S.ON_HOLD]: 'On hold',
  [S.REFUNDED]: 'Refunded'
};

/* ------------------------------------------------------------- currencies */
export async function currency(id, { lock = false } = {}) {
  return db.get(`SELECT * FROM currencies WHERE id = ?${lock ? db.forUpdate : ''}`, id);
}

export function available(cur) {
  return M.sub(cur.reserve, cur.reserved);
}

/**
 * Is this pair open? Group rule, then any per-pair override on top.
 * Mirrors the client-side EP.allowed so the UI and the server agree.
 */
export async function directionOpen(from, to) {
  if (!from || !to || from.id === to.id) return false;
  if (!from.enabled || !to.enabled) return false;

  const override = await db.get(
    'SELECT enabled FROM pair_overrides WHERE from_id = ? AND to_id = ?',
    from.id, to.id
  );
  if (override && override.enabled !== null) return !!override.enabled;

  const rule = await db.get(
    'SELECT enabled FROM direction_rules WHERE from_grp = ? AND to_grp = ?',
    from.grp, to.grp
  );
  return !!(rule && rule.enabled);
}

/** Effective fee in basis points: pair override, else the sending currency. */
export async function feeBpFor(from, to, user) {
  const override = await db.get(
    'SELECT fee_bp FROM pair_overrides WHERE from_id = ? AND to_id = ?',
    from.id, to.id
  );
  let bp = override && override.fee_bp !== null ? override.fee_bp : from.fee_bp;
  // a registered customer's negotiated discount, floored at zero
  if (user?.discount_bp) bp = Math.max(0, bp - user.discount_bp);
  return bp;
}

/* ------------------------------------------------------------- staleness
   Quoting from a dead feed is worse than refusing to quote, so a pivot that
   is sourced from the feed and older than the cutoff blocks the direction. */
export async function pivotStale(cur) {
  if (cur.pivot_source !== 'feed' || !cur.feed_symbol) return false;
  const row = await db.get('SELECT fetched_at FROM rate_cache WHERE symbol = ?', cur.feed_symbol);
  if (!row) return true;
  return Date.now() - Date.parse(row.fetched_at) > config.rates.maxStaleSec * 1000;
}

/* ----------------------------------------------------------------- quote */
/**
 * Price a direction. Pure: touches no order state, so the public quote
 * endpoint and order creation can share it.
 *
 * @param side 'send' when `amount` is what the customer pays, else 'receive'
 * @returns { rate, send, recv, feeBp, min, max, available, errors[] }
 */
export async function quote({ from, to, amount, side = 'send', user }) {
  const errors = [];

  if (!await directionOpen(from, to)) {
    errors.push('This direction is closed.');
    return { errors };
  }
  if (await pivotStale(from) || await pivotStale(to)) {
    errors.push('Rates for this direction are temporarily unavailable. Try again shortly.');
    return { errors };
  }

  const feeBp = await feeBpFor(from, to, user);
  const rate = M.crossRate(from.pivot_usd, to.pivot_usd, feeBp);

  let send, recv;
  if (side === 'receive') {
    recv = M.dec(amount);
    send = M.isZero(rate) ? 0n : M.div(recv, rate);
  } else {
    send = M.dec(amount);
    recv = M.mul(send, rate);
  }

  const avail = available(to);

  if (!M.isPos(send)) errors.push('Enter an amount to exchange.');
  else if (M.lt(send, from.min_amt)) {
    errors.push(`Minimum is ${M.str(from.min_amt)} ${from.code}.`);
  } else if (M.gt(send, from.max_amt)) {
    errors.push(`Maximum is ${M.str(from.max_amt)} ${from.code}. Contact an operator for larger amounts.`);
  } else if (M.gt(recv, avail)) {
    errors.push(`Reserve is only ${M.str(avail, 2)} ${to.code}. Reduce the amount.`);
  }

  return {
    rate: M.str(rate),
    send: M.str(send),
    recv: M.str(recv),
    feeBp,
    min: M.str(from.min_amt),
    max: M.str(from.max_amt),
    available: M.str(avail),
    errors
  };
}

/* ---------------------------------------------------------------- events */
export async function addEvent(orderId, fromStatus, toStatus, actor, detail) {
  await db.run(
    `INSERT INTO order_events (order_id, from_status, to_status, actor, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    orderId, fromStatus, toStatus, actor, detail ?? null, db.now()
  );
}

export const events = async (orderId) =>
  db.all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', orderId);

/* -------------------------------------------------------- reserve ledger */
async function holdReserve(toId, amount) {
  await db.run('UPDATE currencies SET reserved = ?, updated_at = ? WHERE id = ?',
    M.str(M.add(await db.val('SELECT reserved FROM currencies WHERE id = ?', toId), amount)),
    db.now(), toId);
}

/**
 * Stop counting an order against `reserved`. When the payout actually
 * happened the same amount also leaves `reserve`; when it did not (expiry,
 * cancellation, refund) only the hold is released.
 */
async function releaseReserve(order, alsoSpend) {
  if (!order.reserve_held) return;
  const cur = await db.get(`SELECT reserve, reserved FROM currencies WHERE id = ?${db.forUpdate}`, order.to_id);
  if (!cur) return;

  const reserved = M.sub(cur.reserved, order.recv_amount);
  const reserve = alsoSpend ? M.sub(cur.reserve, order.recv_amount) : M.dec(cur.reserve);

  await db.run('UPDATE currencies SET reserve = ?, reserved = ?, updated_at = ? WHERE id = ?',
    // clamp at zero: a manual reserve edit mid-order must not push these negative
    M.str(M.lt(reserve, 0) ? 0n : reserve),
    M.str(M.lt(reserved, 0) ? 0n : reserved),
    db.now(), order.to_id);

  await db.run('UPDATE orders SET reserve_held = 0 WHERE id = ?', order.id);
}

/* ---------------------------------------------------------------- create */
/**
 * Create an order. The whole thing - re-pricing, the reserve check and the
 * insert - happens in one transaction, which is what makes the reserve check
 * meaningful under concurrency.
 */
export async function create({ fromId, toId, amount, side = 'send', requisite, email, holder, note, user, ip }) {
  return db.tx(async () => {
    // re-read inside the transaction; a cached row from before BEGIN is not
    // a safe basis for the reserve decision
    const from = await currency(fromId);
    const to = await currency(toId, { lock: true });
    if (!from || !to) throw new HttpError(400, 'Unknown currency');

    const q = await quote({ from, to, amount, side, user });
    if (q.errors.length) throw new HttpError(400, q.errors[0]);

    if (to.field_regex) {
      let re;
      try { re = new RegExp(to.field_regex); } catch { re = null; }
      if (re && !re.test(requisite)) {
        throw new HttpError(400, `That does not look like a valid ${to.field_label}.`, 'requisite');
      }
    }

    const id = newOrderId();
    const accessToken = newToken(18);
    const provider = to.manual ? 'manual' : (to.grp === 'crypto' ? 'crypto' : 'mobile');
    const t = db.now();

    await db.run(
      `INSERT INTO orders (
         id, user_id, from_id, to_id, send_amount, recv_amount, rate, fee_bp,
         status, requisite, holder, email, note, deposit_address, deposit_memo,
         provider, ip, lock_expires_at, access_token, reserve_held,
         created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      id, user?.id ?? null, from.id, to.id, q.send, q.recv, q.rate, q.feeBp,
      S.CREATED, requisite, holder ?? null, email, note ?? null,
      from.deposit_addr ?? null, from.deposit_memo ?? null,
      provider, ip ?? null, db.inMinutes(config.order.lockMinutes), accessToken,
      t, t
    );

    await holdReserve(to.id, q.recv);
    await addEvent(id, null, S.CREATED, user ? `customer:${user.login}` : 'customer',
      `quote ${q.send} ${from.code} -> ${q.recv} ${to.code} @ ${q.rate}`);

    return { id, accessToken, ...q };
  });
}

/* ------------------------------------------------------------ transition */
/**
 * Move an order's status, enforcing TRANSITIONS and keeping the reserve
 * ledger in step. `actor` is 'system', 'customer' or 'operator:<login>'.
 */
export async function transition(orderId, to, actor, { detail, patch } = {}) {
  return db.tx(async () => {
    const order = await db.get(`SELECT * FROM orders WHERE id = ?${db.forUpdate}`, orderId);
    if (!order) throw new HttpError(404, 'Order not found');

    const from = order.status;
    if (from === to) throw new HttpError(409, `Order is already ${LABELS[to] || to}`);
    if (!canTransition(from, to)) {
      throw new HttpError(409, `Cannot move an order from ${LABELS[from] || from} to ${LABELS[to] || to}`);
    }

    const t = db.now();
    const sets = ['status = ?', 'updated_at = ?'];
    const args = [to, t];

    if (to === S.DETECTED) { sets.push('paid_at = ?'); args.push(t); }
    if (to === S.COMPLETED) { sets.push('completed_at = ?'); args.push(t); }

    for (const [k, v] of Object.entries(patch || {})) {
      // column allow-list: `patch` carries operator input, so it must never
      // be able to name an arbitrary column
      if (!PATCHABLE.has(k)) throw new HttpError(400, `Field not writable: ${k}`);
      sets.push(`${k} = ?`);
      args.push(v);
    }

    args.push(orderId);
    await db.run(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, ...args);

    // completion spends the held liquidity; the other exits just release it
    if (to === S.COMPLETED) await releaseReserve(order, true);
    else if (!HOLDS_RESERVE.includes(to)) await releaseReserve(order, false);

    await addEvent(orderId, from, to, actor, detail);
    return db.get('SELECT * FROM orders WHERE id = ?', orderId);
  });
}

const PATCHABLE = new Set([
  'tx_hash', 'paid_amount', 'payout_ref', 'provider', 'operator_id',
  'hold_reason', 'cancel_reason', 'deposit_address', 'deposit_memo',
  'rate', 'recv_amount', 'lock_expires_at', 'rate_reaccepted_at'
]);

/* ------------------------------------------------------- payout locking */
/**
 * Claim the right to pay an order out. Returns false if it was already
 * claimed, which is how a webhook replay or a double-clicked button is
 * stopped from paying twice. Call inside the same transaction as the
 * status write.
 */
export async function claimPayout(orderId, provider, ref) {
  try {
    await db.run(
      `INSERT INTO payout_locks (key, order_id, provider, ref, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      `${orderId}:payout`, orderId, provider ?? null, ref ?? null, db.now()
    );
    return true;
  } catch (err) {
    // UNIQUE violation means someone else already holds the claim
    if (/UNIQUE|constraint/i.test(String(err.message))) return false;
    throw err;
  }
}

export const payoutClaimed = async (orderId) =>
  !!(await db.get('SELECT 1 AS x FROM payout_locks WHERE key = ?', `${orderId}:payout`));

/* ------------------------------------------------------------- lock sweep */
/**
 * Expire orders whose quote lock ran out before payment arrived, releasing
 * their reserve holds. Driven by the poller and by /api/cron/expire.
 */
export async function expireStale() {
  const due = await db.all(
    `SELECT id FROM orders
      WHERE status IN (?, ?) AND lock_expires_at <= ?`,
    S.CREATED, S.AWAITING, db.now()
  );
  let n = 0;
  for (const { id } of due) {
    try {
      await transition(id, S.EXPIRED, 'system', { detail: 'quote lock elapsed before payment' });
      n++;
    } catch {
      // a concurrent update already moved it on; nothing to do
    }
  }
  return n;
}

/**
 * Re-price an expired order at the current rate so the customer can accept
 * it. Re-checks the reserve, because time has passed.
 */
export async function requote(orderId, actor) {
  return db.tx(async () => {
    const order = await db.get(`SELECT * FROM orders WHERE id = ?${db.forUpdate}`, orderId);
    if (!order) throw new HttpError(404, 'Order not found');
    if (order.status !== S.EXPIRED) throw new HttpError(409, 'Only an expired order can be re-quoted');

    const from = await currency(order.from_id);
    const to = await currency(order.to_id, { lock: true });
    const q = await quote({ from, to, amount: order.send_amount, side: 'send' });
    if (q.errors.length) throw new HttpError(400, q.errors[0]);

    // the old hold was released on expiry, so take a fresh one
    await holdReserve(to.id, q.recv);
    await db.run(
      `UPDATE orders SET rate = ?, recv_amount = ?, fee_bp = ?, lock_expires_at = ?,
              rate_reaccepted_at = ?, reserve_held = 1, updated_at = ?
         WHERE id = ?`,
      q.rate, q.recv, q.feeBp, db.inMinutes(config.order.lockMinutes),
      db.now(), db.now(), orderId
    );
    await addEvent(orderId, S.EXPIRED, S.AWAITING, actor, `re-quoted at ${q.rate}`);
    await db.run('UPDATE orders SET status = ? WHERE id = ?', S.AWAITING, orderId);

    return db.get('SELECT * FROM orders WHERE id = ?', orderId);
  });
}

/* ----------------------------------------------------------- serialising */
/** Shape an order for a customer. Deliberately omits internal columns. */
export async function publicView(order) {
  const from = await currency(order.from_id);
  const to = await currency(order.to_id);
  const history = await events(order.id);
  return {
    id: order.id,
    status: order.status,
    statusLabel: LABELS[order.status] || order.status,
    terminal: isTerminal(order.status),
    from: from && { id: from.id, label: label(from), code: from.code, color: from.color },
    to: to && { id: to.id, label: label(to), code: to.code, color: to.color },
    send: order.send_amount,
    recv: order.recv_amount,
    rate: order.rate,
    feeBp: order.fee_bp,
    requisite: order.requisite,
    depositAddress: order.deposit_address,
    depositMemo: order.deposit_memo,
    txHash: order.tx_hash,
    lockExpiresAt: order.lock_expires_at,
    createdAt: order.created_at,
    completedAt: order.completed_at,
    events: history.map((e) => ({
      at: e.created_at,
      status: e.to_status,
      label: LABELS[e.to_status] || e.to_status,
      detail: e.detail
    }))
  };
}

export const label = (c) => `${c.name}${c.net ? ' ' + c.net : ''} ${c.code}`;
