/* ==========================================================================
   Show what is actually stored, and where.

     node --env-file=.env server/tools/inspect.mjs
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import * as db from '../db.js';
import { config } from '../config.js';

const file = path.resolve(config.db.file);
const dir = path.dirname(file);

const size = (p) => {
  try { return fs.statSync(p).size; } catch { return 0; }
};
const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';

console.log('\n=== where ===');
console.log('  database   ', db.engine === 'postgresql' ? 'PostgreSQL (DATABASE_URL)' : file);
if (db.engine === 'sqlite') console.log('  write log  ', file + '-wal');
console.log('  kyc uploads', path.join(dir, 'kyc'));

console.log('\n=== size on disk ===');
if (db.engine === 'sqlite') {
  console.log('  main file  ', mb(size(file)));
  console.log('  write log  ', mb(size(file + '-wal')), '(folded into the main file on checkpoint)');
} else {
  console.log('  relational data is stored in PostgreSQL');
}

let kycBytes = 0, kycCount = 0;
try {
  for (const f of fs.readdirSync(path.join(dir, 'kyc'))) {
    kycBytes += size(path.join(dir, 'kyc', f));
    kycCount++;
  }
} catch { /* no directory yet */ }
console.log('  kyc files  ', mb(kycBytes), `(${kycCount} file${kycCount === 1 ? '' : 's'})`);

console.log('\n=== what is in it ===');
const tables = await db.all(db.engine === 'postgresql'
  ? `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`
  : `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%' ORDER BY name`);

const rows = await Promise.all(tables.map(async (t) => ({
  table: t.name,
  count: await db.val(`SELECT COUNT(*) FROM "${t.name}"`)
})));

const w = Math.max(...rows.map((r) => r.table.length));
for (const r of rows) {
  const bar = r.count ? '#'.repeat(Math.min(30, Math.ceil(Math.log10(r.count + 1) * 8))) : '';
  console.log(`  ${r.table.padEnd(w)}  ${String(r.count).padStart(6)}  ${bar}`);
}

console.log('\n=== the money ===');
const cur = await db.all(
  `SELECT code, SUM(CAST(reserve AS REAL)) AS reserve, SUM(CAST(reserved AS REAL)) AS held
     FROM currencies WHERE enabled = 1 GROUP BY code ORDER BY code`
);
for (const c of cur) {
  console.log(`  ${c.code.padEnd(5)} reserve ${c.reserve.toLocaleString('en-GB').padStart(14)}` +
    `   committed to open orders ${c.held.toLocaleString('en-GB')}`);
}

console.log('\n=== orders by status ===');
for (const s of await db.all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY n DESC')) {
  console.log(`  ${s.status.padEnd(18)} ${s.n}`);
}

console.log('\n=== storage summary ===');
console.log(db.engine === 'postgresql'
  ? '  relational data: PostgreSQL; KYC documents: the upload path shown above.\n'
  : '  relational data and KYC documents use the local paths shown above.\n');

await db.close();
