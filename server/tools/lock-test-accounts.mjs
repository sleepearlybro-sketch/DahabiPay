/* ==========================================================================
   Neutralise the local test accounts left behind by the browser checks.

     node --env-file=.env server/tools/lock-test-accounts.mjs

   They are blocked rather than deleted on purpose: audit_log.actor_id and
   orders.operator_id both reference users(id), so deleting an account that
   has acted on anything would either fail or tear a hole in the audit trail.
   Blocking removes the access while leaving the history intact.
   ========================================================================== */

import crypto from 'node:crypto';
import * as db from '../db.js';
import { hashPassword } from '../lib/auth.js';

const TARGETS = ['uitest', 'uidemo'];

for (const login of TARGETS) {
  const u = await db.get('SELECT id, blocked FROM users WHERE login = ?', login);
  if (!u) { console.log(`${login}: absent`); continue; }

  const refs = {
    auditEntries: await db.val('SELECT COUNT(*) FROM audit_log WHERE actor_id = ?', u.id),
    ownOrders: await db.val('SELECT COUNT(*) FROM orders WHERE user_id = ?', u.id),
    operatedOn: await db.val('SELECT COUNT(*) FROM orders WHERE operator_id = ?', u.id)
  };

  await db.tx(async () => {
    await db.run('DELETE FROM ledger WHERE user_id = ?', u.id);
    await db.run('DELETE FROM balances WHERE user_id = ?', u.id);
    await db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    await db.run(
      `UPDATE users SET blocked = 1, role = 'user',
         block_reason = 'local test account - no longer usable',
         pin_hash = NULL, pass_hash = ?
       WHERE id = ?`,
      hashPassword(crypto.randomBytes(32).toString('hex')), u.id
    );
  });

  console.log(`${login}: blocked, password randomised. Referenced by ${JSON.stringify(refs)}`);
}

console.log('\nadmins:', await db.val("SELECT COUNT(*) FROM users WHERE role = 'admin'"));
console.log('active (unblocked) users:', await db.val('SELECT COUNT(*) FROM users WHERE blocked = 0'));
await db.close();
