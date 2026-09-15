/* ==========================================================================
   Signed-in customer area: profile, balances, history, withdrawals,
   affiliate and KYC upload.
   ========================================================================== */

import { Router } from 'express';
import * as db from '../db.js';
import * as M from '../lib/money.js';
import * as O from '../lib/orders.js';
import {
  wrap, str, decimal, int, bool, oneOf, email as emailField, paging, audit, HttpError
} from '../lib/http.js';
import { requireAuth, verifyPassword, limiter } from '../lib/auth.js';
import * as captcha from '../lib/captcha.js';
import { config } from '../config.js';

const r = Router();
r.use(requireAuth);

/** Anything that moves money or changes a payout target passes through here. */
function requirePin(req) {
  if (!req.user.pin_hash) return;
  const pin = str(req.body, 'pin', { max: 12, label: 'PIN code' });
  if (!verifyPassword(pin, req.user.pin_hash)) throw new HttpError(401, 'PIN code is incorrect', 'pin');
}

/* --------------------------------------------------------------- profile */
r.get('/profile', wrap(async (req, res) => {
  const u = req.user;
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const turnover = (await db.all(
    `SELECT o.send_amount, c.pivot_usd FROM orders o JOIN currencies c ON c.id = o.from_id
      WHERE o.user_id = ? AND o.status = 'completed'`,
    u.id
  )).reduce((acc, row) => M.add(acc, M.mul(row.send_amount, row.pivot_usd)), 0n);

  const [exchanges, exchanges30d, affiliateEarned, referrals] = await Promise.all([
    db.val("SELECT COUNT(*) FROM orders WHERE user_id = ? AND status = 'completed'", u.id),
    db.val("SELECT COUNT(*) FROM orders WHERE user_id = ? AND status = 'completed' AND completed_at >= ?", u.id, since30),
    db.val('SELECT COALESCE(SUM(CAST(reward_usd AS REAL)),0) FROM affiliate_rewards WHERE user_id = ?', u.id),
    db.val('SELECT COUNT(*) FROM users WHERE referrer_id = ?', u.id)
  ]);

  res.json({
    login: u.login,
    email: u.email,
    role: u.role,
    emailVerified: !!u.email_verified,
    hasPin: !!u.pin_hash,
    kycStatus: u.kyc_status,
    discountBp: u.discount_bp,
    refCode: u.ref_code,
    refLink: `${config.origin}/?ref=${u.ref_code}`,
    lang: u.lang,
    notifyStatus: !!u.notify_status,
    createdAt: u.created_at,
    stats: {
      exchanges,
      exchanges30d,
      turnoverUsd: M.str(turnover, 2),
      affiliateEarnedUsd: String(
        affiliateEarned || 0
      ),
      referrals
    }
  });
}));

r.patch('/profile', wrap(async (req, res) => {
  const sets = [];
  const args = [];

  if ('email' in req.body) {
    const email = emailField(req.body, 'email');
    if (email !== req.user.email) {
      const taken = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', email, req.user.id);
      if (taken) throw new HttpError(409, 'That address is already in use', 'email');
      // a new address is unverified until confirmed
      sets.push('email = ?', 'email_verified = 0');
      args.push(email);
    }
  }
  if ('lang' in req.body) {
    sets.push('lang = ?');
    args.push(oneOf(req.body, 'lang', ['en', 'fr', 'ar'], { label: 'Language' }));
  }
  if ('notifyStatus' in req.body) {
    sets.push('notify_status = ?');
    args.push(bool(req.body, 'notifyStatus') ? 1 : 0);
  }

  if (!sets.length) throw new HttpError(400, 'Nothing to update');

  args.push(req.user.id);
  await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...args);
  await audit(req, 'user.profile_update', { entity: 'user', entityId: req.user.id, detail: req.body });

  res.json({ ok: true });
}));

/* -------------------------------------------------------------- balances */
r.get('/balances', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT b.currency_id, b.amount, c.name, c.net, c.code, c.color, c.pivot_usd
       FROM balances b JOIN currencies c ON c.id = b.currency_id
      WHERE b.user_id = ? ORDER BY c.sort_order`,
    req.user.id
  );
  res.json(rows.map((b) => ({
    id: b.currency_id,
    label: O.label(b),
    code: b.code,
    color: b.color,
    amount: M.str(b.amount),
    usd: M.str(M.mul(b.amount, b.pivot_usd), 2)
  })));
}));

r.get('/ledger', wrap(async (req, res) => {
  const { limit, offset } = paging(req.query);
  res.json(await db.all(
    `SELECT currency_id, delta, reason, order_id, created_at FROM ledger
      WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
    req.user.id, limit, offset
  ));
}));

/* --------------------------------------------------------------- history */
r.get('/orders', wrap(async (req, res) => {
  const { limit, offset, page } = paging(req.query);
  const where = ['user_id = ?'];
  const args = [req.user.id];
  if (req.query.status) { where.push('status = ?'); args.push(String(req.query.status)); }
  const sql = 'WHERE ' + where.join(' AND ');

  const rows = await db.all(
    `SELECT * FROM orders ${sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...args, limit, offset
  );

  const total = await db.val(`SELECT COUNT(*) FROM orders ${sql}`, ...args);
  const orders = await Promise.all(rows.map(async (o) => {
    const from = await O.currency(o.from_id);
    const to = await O.currency(o.to_id);
    return {
      id: o.id, status: o.status, statusLabel: O.LABELS[o.status] || o.status,
      from: from && O.label(from), to: to && O.label(to),
      fromId: o.from_id, toId: o.to_id,
      fromCode: from?.code, toCode: to?.code, fromColor: from?.color, toColor: to?.color,
      send: o.send_amount, recv: o.recv_amount, rate: o.rate,
      createdAt: o.created_at, completedAt: o.completed_at,
      accessToken: o.access_token
    };
  }));
  res.json({
    page, limit,
    total,
    orders
  });
}));

/* ----------------------------------------------------------- withdrawals */
r.post('/withdraw',
  limiter({ name: 'withdraw', limit: 6, windowSec: 3600, by: (req) => String(req.user?.id) }),
  wrap(async (req, res) => {
    await captcha.requireCaptcha(req);
    requirePin(req);

    const currencyId = str(req.body, 'currency', { max: 40, label: 'Payment system' });
    const amount = decimal(req.body, 'amount', { label: 'Amount' });
    const requisite = str(req.body, 'requisite', { max: 200, label: 'Account number' });
    const kind = oneOf(req.body, 'kind', ['balance', 'affiliate'], { required: false }) || 'balance';

    const cur = await O.currency(currencyId);
    if (!cur || !cur.enabled) throw new HttpError(400, 'Unknown payment system', 'currency');
    if (!M.isPos(amount)) throw new HttpError(400, 'Amount must be greater than zero', 'amount');

    if (cur.field_regex) {
      let re; try { re = new RegExp(cur.field_regex); } catch { re = null; }
      if (re && !re.test(requisite)) {
        throw new HttpError(400, `That does not look like a valid ${cur.field_label}.`, 'requisite');
      }
    }

    // debit and request in one transaction, so a balance cannot be spent twice
    await db.tx(async () => {
      const bal = await db.val(`SELECT amount FROM balances WHERE user_id = ? AND currency_id = ?${db.forUpdate}`,
        req.user.id, currencyId) || '0';
      if (M.lt(bal, amount)) {
        throw new HttpError(400, `Insufficient balance: you have ${M.str(bal)} ${cur.code}`, 'amount');
      }
      await db.run('UPDATE balances SET amount = ? WHERE user_id = ? AND currency_id = ?',
        M.str(M.sub(bal, amount)), req.user.id, currencyId);
      await db.run(
        `INSERT INTO ledger (user_id, currency_id, delta, reason, actor, created_at)
         VALUES (?, ?, ?, 'withdrawal requested', ?, ?)`,
        req.user.id, currencyId, M.str(M.sub(0n, M.dec(amount))), `customer:${req.user.login}`, db.now()
      );
      await db.run(
        `INSERT INTO withdrawals (user_id, currency_id, amount, requisite, kind, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        req.user.id, currencyId, M.str(amount), requisite, kind, db.now()
      );
    });

    await audit(req, 'withdrawal.request', {
      entity: 'user', entityId: req.user.id,
      detail: { currency: currencyId, amount: M.str(amount), kind }
    });
    res.status(201).json({ ok: true, message: 'Withdrawal requested. It settles in the next payout run.' });
  }));

r.get('/withdrawals', wrap(async (req, res) => {
  res.json(await db.all(
    `SELECT id, currency_id, amount, requisite, kind, status, reason, created_at, settled_at
       FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 100`,
    req.user.id
  ));
}));

/* ------------------------------------------------------------- affiliate */
r.get('/affiliate', wrap(async (req, res) => {
  const earned = Number(await db.val(
    'SELECT COALESCE(SUM(CAST(reward_usd AS REAL)),0) FROM affiliate_rewards WHERE user_id = ?',
    req.user.id
  ) || 0);
  const paid = Number(await db.val(
    `SELECT COALESCE(SUM(CAST(amount AS REAL)),0) FROM withdrawals
      WHERE user_id = ? AND kind = 'affiliate' AND status IN ('pending','paid')`,
    req.user.id
  ) || 0);
  const [referrals, minPayoutUsd, tier1, tier2, tier3, rewards] = await Promise.all([
    db.val('SELECT COUNT(*) FROM users WHERE referrer_id = ?', req.user.id),
    db.setting('affiliate_min_payout_usd', '10'),
    db.setting('affiliate_tier1_bp', '40'),
    db.setting('affiliate_tier2_bp', '55'),
    db.setting('affiliate_tier3_bp', '70'),
    db.all(`SELECT a.order_id, a.volume_usd, a.share_bp, a.reward_usd, a.created_at, u.login AS referral
              FROM affiliate_rewards a
              LEFT JOIN orders o ON o.id = a.order_id
              LEFT JOIN users u ON u.id = o.user_id
             WHERE a.user_id = ? ORDER BY a.id DESC LIMIT 100`, req.user.id)
  ]);

  res.json({
    refCode: req.user.ref_code,
    refLink: `${config.origin}/?ref=${req.user.ref_code}`,
    referrals,
    earnedUsd: earned.toFixed(2),
    availableUsd: Math.max(0, earned - paid).toFixed(2),
    minPayoutUsd,
    tiers: {
      tier1,
      tier2,
      tier3
    },
    rewards
  });
}));

/* ------------------------------------------------------------------- kyc
   Documents arrive as base64 in JSON rather than multipart: it keeps the
   dependency list at zero and the size cap is enforced before decoding. */
r.post('/kyc', wrap(async (req, res) => {
  const kind = oneOf(req.body, 'kind', ['id_front', 'id_back', 'selfie', 'address', 'sof'], { label: 'Document type' });
  const filename = str(req.body, 'filename', { max: 200, label: 'File name' });
  const mime = oneOf(req.body, 'mime', ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], { label: 'File type' });
  const data = str(req.body, 'data', { max: 12_000_000, label: 'File' });

  const base64 = data.replace(/^data:[^;]+;base64,/, '');
  const bytes = Math.floor(base64.length * 3 / 4);
  const capBytes = config.limits.kycFileMb * 1024 * 1024;
  if (bytes > capBytes) {
    throw new HttpError(413, `File is larger than ${config.limits.kycFileMb} MB`, 'data');
  }

  const dir = `${config.db.file.replace(/[^/\\]+$/, '')}kyc`;
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(dir, { recursive: true });

  const safe = `${req.user.id}-${kind}-${Date.now()}${path.extname(filename) || ''}`;
  fs.writeFileSync(path.join(dir, safe), Buffer.from(base64, 'base64'));

  await db.tx(async () => {
    await db.run(
      `INSERT INTO kyc_docs (user_id, kind, filename, mime, bytes, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      req.user.id, kind, safe, mime, bytes, db.now()
    );
    await db.run("UPDATE users SET kyc_status = 'pending' WHERE id = ? AND kyc_status != 'approved'", req.user.id);
  });

  await audit(req, 'kyc.upload', { entity: 'user', entityId: req.user.id, detail: { kind, bytes } });
  res.status(201).json({ ok: true, message: 'Document uploaded and queued for review.' });
}));

r.get('/kyc', wrap(async (req, res) => {
  res.json(await db.all(
    'SELECT id, kind, status, reason, bytes, created_at FROM kyc_docs WHERE user_id = ? ORDER BY id DESC',
    req.user.id
  ));
}));

export default r;
