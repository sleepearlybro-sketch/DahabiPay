/* ==========================================================================
   Throughput check on the real order-creation path.

     node server/tools/bench.mjs

   Uses a throwaway database so nothing touches your live data. Measures the
   full transaction: re-price, reserve check, reserve hold, insert, event row.
   ========================================================================== */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `ep-bench-${process.pid}.db`);
process.env.DB_FILE = tmp;

const db = await import('../db.js');
const O = await import('../lib/orders.js');

await db.migrate();
console.log('\njournal mode:', await db.val('PRAGMA journal_mode'));

await db.run(
  `INSERT INTO currencies (id,name,net,code,grp,color,pivot_usd,pivot_source,reserve,reserved,
     deposit_addr,min_amt,max_amt,fee_bp,field_label,enabled,manual,sort_order,updated_at)
   VALUES ('src','Source','','SRC','crypto','#000','1','manual','100000000','0','ADDR','1','1000',100,'addr',1,0,1,?)`,
  db.now()
);
await db.run(
  `INSERT INTO currencies (id,name,net,code,grp,color,pivot_usd,pivot_source,reserve,reserved,
     min_amt,max_amt,fee_bp,field_label,enabled,manual,sort_order,updated_at)
   VALUES ('dst','Dest','','DST','mobile','#111','1','manual','100000000','0','1','1000000',0,'phone',1,0,2,?)`,
  db.now()
);
await db.run("INSERT INTO direction_rules (from_grp,to_grp,enabled) VALUES ('crypto','mobile',1)");

const N = 2000;
console.log(`creating ${N} orders through the full transaction...\n`);

const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  await O.create({
    fromId: 'src', toId: 'dst', amount: '10', side: 'send',
    requisite: '254712345678', email: 'bench@example.com'
  });
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

const perOrder = ms / N;
const perSec = 1000 / perOrder;

console.log(`  ${N} orders in ${ms.toFixed(0)} ms`);
console.log(`  ${perOrder.toFixed(3)} ms per order`);
console.log(`  ~${Math.round(perSec).toLocaleString('en-GB')} orders/second sustained\n`);

// what that means against realistic volume
for (const daily of [100, 1000, 10000, 100000]) {
  const load = (daily / 86400) / perSec * 100;
  console.log(`  ${daily.toLocaleString('en-GB').padStart(7)} orders/day  ->  ${load.toFixed(4)}% of capacity`);
}

console.log(`\n  rows written: ${await db.val('SELECT COUNT(*) FROM orders')} orders, ` +
  `${await db.val('SELECT COUNT(*) FROM order_events')} events`);
console.log(`  database size: ${(fs.statSync(tmp).size / 1024 / 1024).toFixed(1)} MB\n`);

await db.close();
for (const f of [tmp, tmp + '-wal', tmp + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* windows handle */ }
}
