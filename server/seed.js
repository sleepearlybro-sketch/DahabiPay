/* ==========================================================================
   Seeder. Idempotent: currencies are upserted on id and operational columns
   (reserve, reserved, fee) are left alone once a row exists, so re-running
   this never clobbers live liquidity. Pass --reset to wipe and start over.

     npm run seed      refresh the catalogue, keep balances and orders
     npm run reset     drop everything and re-seed
   ========================================================================== */

import * as db from './db.js';
import { config } from './config.js';
import { hashPassword, newRefCode } from './lib/auth.js';
import { auditSystem } from './lib/http.js';

const reset = process.argv.includes('--reset');

/* ------------------------------------------------------------ catalogue
   pivot_usd is the USD value of one unit. `feed` currencies have it
   overwritten by services/rates.js; `manual` ones keep what is set here.
   field_regex validates the receiving requisite server-side.            */
const CURRENCIES = [
  // --- crypto -----------------------------------------------------------
  { id:'btc', name:'Bitcoin', net:'', code:'BTC', grp:'crypto', color:'#f7931a',
    pivot_usd:'63500', pivot_source:'feed', feed_symbol:'bitcoin',
    reserve:'4.85', min_amt:'0.0004', max_amt:'2.5', fee_bp:120,
    field_label:'BTC wallet address', field_regex:'^(bc1[a-z0-9]{20,}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$' },
  { id:'eth', name:'Ethereum', net:'', code:'ETH', grp:'crypto', color:'#627eea',
    pivot_usd:'2480', pivot_source:'feed', feed_symbol:'ethereum',
    reserve:'52.4', min_amt:'0.01', max_amt:'60', fee_bp:120,
    field_label:'ETH wallet address', field_regex:'^0x[a-fA-F0-9]{40}$' },
  { id:'ton', name:'Toncoin', net:'', code:'TON', grp:'crypto', color:'#0098ea',
    pivot_usd:'5.42', pivot_source:'feed', feed_symbol:'the-open-network',
    reserve:'18400', min_amt:'5', max_amt:'25000', fee_bp:140,
    field_label:'TON wallet address', field_regex:'^[A-Za-z0-9_-]{48}$' },
  { id:'usdt_trc20', name:'Tether', net:'TRC20', code:'USDT', grp:'crypto', color:'#26a17b',
    pivot_usd:'1', pivot_source:'feed', feed_symbol:'tether',
    reserve:'248000', min_amt:'10', max_amt:'120000', fee_bp:100,
    field_label:'USDT TRC20 address', field_regex:'^T[1-9A-HJ-NP-Za-km-z]{33}$' },
  { id:'usdt_erc20', name:'Tether', net:'ERC20', code:'USDT', grp:'crypto', color:'#26a17b',
    pivot_usd:'1', pivot_source:'feed', feed_symbol:'tether',
    reserve:'96500', min_amt:'50', max_amt:'90000', fee_bp:120,
    field_label:'USDT ERC20 address', field_regex:'^0x[a-fA-F0-9]{40}$' },
  { id:'usdt_bep20', name:'Tether', net:'BEP20', code:'USDT', grp:'crypto', color:'#26a17b',
    pivot_usd:'1', pivot_source:'feed', feed_symbol:'tether',
    reserve:'141200', min_amt:'20', max_amt:'90000', fee_bp:100,
    field_label:'USDT BEP20 address', field_regex:'^0x[a-fA-F0-9]{40}$' },
  { id:'usdt_ton', name:'Tether', net:'TON', code:'USDT', grp:'crypto', color:'#26a17b',
    pivot_usd:'1', pivot_source:'feed', feed_symbol:'tether',
    reserve:'37800', min_amt:'20', max_amt:'40000', fee_bp:110,
    field_label:'USDT TON address', field_regex:'^[A-Za-z0-9_-]{48}$' },
  { id:'usdc_erc20', name:'USD Coin', net:'ERC20', code:'USDC', grp:'crypto', color:'#2775ca',
    pivot_usd:'1', pivot_source:'feed', feed_symbol:'usd-coin',
    reserve:'74300', min_amt:'50', max_amt:'70000', fee_bp:120,
    field_label:'USDC ERC20 address', field_regex:'^0x[a-fA-F0-9]{40}$' },
  { id:'usdc_bep20', name:'USD Coin', net:'BEP20', code:'USDC', grp:'crypto', color:'#2775ca',
    pivot_usd:'1', pivot_source:'feed', feed_symbol:'usd-coin',
    reserve:'45900', min_amt:'20', max_amt:'50000', fee_bp:110,
    field_label:'USDC BEP20 address', field_regex:'^0x[a-fA-F0-9]{40}$' },

  // --- electronic accounts ---------------------------------------------
  { id:'acct_usd', name:'My Account', net:'', code:'USD', grp:'account', color:'#025081',
    pivot_usd:'1', pivot_source:'manual', feed_symbol:null,
    reserve:'500000', min_amt:'1', max_amt:'100000', fee_bp:0,
    field_label:'Internal account ID', field_regex:'^\\d{1,10}$' },
  { id:'optimoney', name:'OptiMoney', net:'', code:'USD', grp:'account', color:'#7b5cf0',
    pivot_usd:'1', pivot_source:'manual', feed_symbol:null,
    reserve:'21400', min_amt:'5', max_amt:'15000', fee_bp:150,
    field_label:'OptiMoney account number', field_regex:'^[A-Za-z0-9-]{5,24}$' },
  { id:'moneygo', name:'Money Go', net:'', code:'USD', grp:'account', color:'#e0338b',
    pivot_usd:'1', pivot_source:'manual', feed_symbol:null,
    reserve:'18600', min_amt:'5', max_amt:'12000', fee_bp:150,
    field_label:'Money Go account number', field_regex:'^[A-Za-z0-9-]{5,24}$' },

  // --- mobile money & local banking ------------------------------------
  { id:'mpesa_kes', name:'M-Pesa', net:'Kenya', code:'KES', grp:'mobile', color:'#4caf27',
    pivot_usd:'0.00775', pivot_source:'feed', feed_symbol:'KES',
    reserve:'4200000', min_amt:'500', max_amt:'900000', fee_bp:180,
    field_label:'Safaricom number (2547...)', field_regex:'^254[17]\\d{8}$' },
  { id:'kcb_kes', name:'KCB Bank', net:'Kenya', code:'KES', grp:'mobile', color:'#0a6b3d',
    pivot_usd:'0.00775', pivot_source:'feed', feed_symbol:'KES',
    reserve:'2650000', min_amt:'1000', max_amt:'700000', fee_bp:200,
    field_label:'KCB account number', field_regex:'^\\d{10,16}$' },
  { id:'airtel_ugx', name:'Airtel Money', net:'Uganda', code:'UGX', grp:'mobile', color:'#e4002b',
    pivot_usd:'0.000268', pivot_source:'feed', feed_symbol:'UGX',
    reserve:'96000000', min_amt:'20000', max_amt:'18000000', fee_bp:200,
    field_label:'Airtel number (2567...)', field_regex:'^256[347]\\d{8}$' },
  { id:'ebirr_etb', name:'E-Birr', net:'Ethiopia', code:'ETB', grp:'mobile', color:'#0f8a4c',
    pivot_usd:'0.00795', pivot_source:'feed', feed_symbol:'ETB',
    reserve:'3100000', min_amt:'500', max_amt:'600000', fee_bp:220,
    field_label:'E-Birr wallet number', field_regex:'^251\\d{9}$' },
  { id:'mtn_ghs', name:'MTN MoMo', net:'Ghana', code:'GHS', grp:'mobile', color:'#ffcc00',
    pivot_usd:'0.0645', pivot_source:'feed', feed_symbol:'GHS',
    reserve:'420000', min_amt:'50', max_amt:'90000', fee_bp:200,
    field_label:'MTN number (2335...)', field_regex:'^233[2345]\\d{8}$' },
  { id:'vodafone_egp', name:'Vodafone Cash', net:'Egypt', code:'EGP', grp:'mobile', color:'#e60000',
    pivot_usd:'0.0206', pivot_source:'feed', feed_symbol:'EGP',
    reserve:'1450000', min_amt:'200', max_amt:'250000', fee_bp:210,
    field_label:'Vodafone Cash number', field_regex:'^201\\d{9}$' },
  { id:'instapay_egp', name:'InstaPay', net:'Egypt', code:'EGP', grp:'mobile', color:'#1a3c8f',
    pivot_usd:'0.0206', pivot_source:'feed', feed_symbol:'EGP',
    reserve:'1980000', min_amt:'200', max_amt:'300000', fee_bp:190,
    field_label:'InstaPay address / IPA', field_regex:'^[A-Za-z0-9._@-]{4,40}$' },
  { id:'cashplus_mad', name:'Cash Plus', net:'Morocco', code:'MAD', grp:'mobile', color:'#f4791f',
    pivot_usd:'0.101', pivot_source:'feed', feed_symbol:'MAD',
    reserve:'380000', min_amt:'100', max_amt:'70000', fee_bp:220, manual:1,
    field_label:'Beneficiary full name + CIN', field_regex:'^.{6,80}$' },
  { id:'wafacash_mad', name:'WafaCash', net:'Morocco', code:'MAD', grp:'mobile', color:'#c8102e',
    pivot_usd:'0.101', pivot_source:'feed', feed_symbol:'MAD',
    reserve:'295000', min_amt:'100', max_amt:'60000', fee_bp:230, manual:1,
    field_label:'Beneficiary full name + CIN', field_regex:'^.{6,80}$' },
  { id:'postepay_dzd', name:'Postepay', net:'Algeria', code:'DZD', grp:'mobile', color:'#0b7a3b',
    pivot_usd:'0.00743', pivot_source:'feed', feed_symbol:'DZD',
    reserve:'5400000', min_amt:'2000', max_amt:'900000', fee_bp:240, manual:1,
    field_label:'CCP / Baridi card number', field_regex:'^\\d{10,20}$' },
  { id:'baridi_dzd', name:'BaridiMob CCP', net:'Algeria', code:'DZD', grp:'mobile', color:'#d4a017',
    pivot_usd:'0.00743', pivot_source:'feed', feed_symbol:'DZD',
    reserve:'6100000', min_amt:'2000', max_amt:'900000', fee_bp:240, manual:1,
    field_label:'CCP account number', field_regex:'^\\d{10,20}$' }
];

/* group-level allow list; per-pair exceptions go in pair_overrides */
const DIRECTIONS = [
  ['crypto', 'mobile'], ['crypto', 'account'], ['crypto', 'crypto'],
  ['mobile', 'crypto'], ['mobile', 'account'],
  ['account', 'crypto'], ['account', 'mobile']
];

const NEWS = [
  { slug:'stablecoins-global-payments',
    title:'Stablecoins Drive the Next Wave of Global Payments Innovation',
    excerpt:'The rapid adoption of stablecoins across remittance corridors is reshaping how value moves between mobile money and crypto rails.',
    published_at:'2026-05-30T11:05:00Z' },
  { slug:'listed-on-exchange-monitor',
    title:'Official Announcement: Listed on a Leading Exchange Monitor',
    excerpt:'We are pleased to announce that our rates are now published on one of the largest independent exchanger monitors.',
    published_at:'2026-05-30T10:05:00Z' },
  { slug:'custody-lessons',
    title:'Security Notice: What Large Exchange Hacks Teach Us About Custody',
    excerpt:'A look at how cold storage policy, withdrawal allow-lists and operator separation keep customer reserves safe.',
    published_at:'2026-03-31T02:03:00Z' }
];

const REVIEWS = [
  ['Murtaza', 'This is a great exchange site, I recommend everyone to use it.', '2026-01-07T08:28:00Z'],
  ['Joseph', 'Very smooth crypto exchange process. The interface is simple and beginner-friendly.', '2025-12-28T01:51:00Z'],
  ['Chris Thompson', 'Great option for people who need quick crypto conversions.', '2025-12-28T01:49:00Z'],
  ['Yuusuf', 'Dahabi Pay is becoming my go-to exchange platform.', '2025-12-28T01:49:00Z'],
  ['Karemis', 'Simple steps and clear instructions make it easy to use.', '2025-12-28T01:48:00Z'],
  ['Mwangi', 'Transactions are confirmed quickly, which I really appreciate.', '2025-12-28T01:48:00Z']
];

const SETTINGS = {
  // New production databases can launch with order intake closed while live
  // provider credentials and reserves are being verified.
  maintenance: /^(1|true|yes|on)$/i.test(process.env.START_IN_MAINTENANCE || '') ? '1' : '0',
  kyc_threshold_usd: '2000',
  affiliate_tier1_bp: '40',
  affiliate_tier2_bp: '55',
  affiliate_tier3_bp: '70',
  affiliate_min_payout_usd: '10'
};

/* ------------------------------------------------------------------- run */
async function wipe() {
  const tables = [
    'order_events', 'payout_locks', 'webhook_events', 'orders', 'ledger',
    'balances', 'withdrawals', 'affiliate_rewards', 'kyc_docs', 'reviews',
    'news', 'email_tokens', 'sessions', 'rate_limits', 'audit_log',
    'pair_overrides', 'direction_rules', 'rate_cache', 'currencies',
    'settings', 'users'
  ];
  if (db.engine === 'sqlite') await db.exec('PRAGMA foreign_keys = OFF');
  for (const t of tables) await db.run(`DELETE FROM ${t}`);
  if (db.engine === 'sqlite') await db.exec('PRAGMA foreign_keys = ON');
  console.log('  wiped %d tables', tables.length);
}

async function seedCurrencies() {
  let added = 0, refreshed = 0;
  for (const c of CURRENCIES) {
    const existing = await db.get('SELECT id FROM currencies WHERE id = ?', c.id);
    if (existing) {
      // catalogue metadata only - never touch reserve/reserved/fee on a live row
      await db.run(
        `UPDATE currencies SET name=?, net=?, code=?, grp=?, color=?,
                pivot_source=?, feed_symbol=?, field_label=?, field_regex=?,
                updated_at=? WHERE id=?`,
        c.name, c.net, c.code, c.grp, c.color, c.pivot_source, c.feed_symbol ?? null,
        c.field_label, c.field_regex ?? null, db.now(), c.id
      );
      refreshed++;
    } else {
      await db.run(
        `INSERT INTO currencies (
           id, name, net, code, grp, color, pivot_usd, pivot_source, feed_symbol,
           reserve, reserved, deposit_addr, min_amt, max_amt, fee_bp,
           field_label, field_regex, enabled, manual, sort_order, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,'0',?,?,?,?,?,?,1,?,?,?)`,
        c.id, c.name, c.net, c.code, c.grp, c.color, c.pivot_usd, c.pivot_source,
        c.feed_symbol ?? null, c.reserve,
        // the manual provider shows this as the pay-to address
        c.grp === 'crypto' ? `DEMO-${c.id.toUpperCase()}-SET-A-REAL-ADDRESS` : null,
        c.min_amt, c.max_amt, c.fee_bp, c.field_label, c.field_regex ?? null,
        c.manual ?? 0, CURRENCIES.indexOf(c), db.now()
      );
      added++;
    }
  }
  console.log('  currencies: %d added, %d metadata refreshed', added, refreshed);
}

async function seedDirections() {
  for (const [f, t] of DIRECTIONS) {
    await db.run(
      `INSERT INTO direction_rules (from_grp, to_grp, enabled) VALUES (?, ?, 1)
       ON CONFLICT(from_grp, to_grp) DO NOTHING`,
      f, t
    );
  }
  console.log('  direction rules: %d', DIRECTIONS.length);
}

async function seedEditorial() {
  for (const n of NEWS) {
    await db.run(
      `INSERT INTO news (slug, title, excerpt, body, published, published_at)
       VALUES (?, ?, ?, '', 1, ?) ON CONFLICT(slug) DO NOTHING`,
      n.slug, n.title, n.excerpt, n.published_at
    );
  }
  const haveReviews = await db.val('SELECT COUNT(*) FROM reviews');
  if (!haveReviews) {
    for (const [who, body, at] of REVIEWS) {
      await db.run(
        `INSERT INTO reviews (who, body, rating, approved, created_at) VALUES (?, ?, 5, 1, ?)`,
        who, body, at
      );
    }
  }
  for (const [k, v] of Object.entries(SETTINGS)) {
    await db.run(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`, k, v);
  }
  console.log('  news: %d, reviews: %d, settings: %d',
    NEWS.length, haveReviews ? 0 : REVIEWS.length, Object.keys(SETTINGS).length);
}

/**
 * The admin account. Refuses to invent a password: an exchanger shipping with
 * a default administrator credential is how these get taken over.
 */
async function seedAdmin() {
  const existing = await db.get('SELECT id FROM users WHERE role = ?', 'admin');
  if (existing) {
    console.log('  admin: already present, untouched');
    return;
  }
  if (!config.admin.password) {
    console.log('\n  ! No admin account created: ADMIN_PASSWORD is not set.');
    console.log('    Add it to .env and re-run `npm run seed`.');
    console.log('    Nothing is created with a default password on purpose.\n');
    return;
  }
  if (config.admin.password.length < 12) {
    console.log('\n  ! ADMIN_PASSWORD is shorter than 12 characters - refusing.');
    console.log('    This account can move money. Use a long random value.\n');
    return;
  }
  await db.run(
    `INSERT INTO users (login, email, pass_hash, role, email_verified, ref_code, created_at)
     VALUES (?, ?, ?, 'admin', 1, ?, ?)`,
    config.admin.login, config.admin.email.toLowerCase(),
    hashPassword(config.admin.password), newRefCode(), db.now()
  );
  await auditSystem('admin.seeded', { entity: 'user', detail: { login: config.admin.login } });
  console.log('  admin: created "%s"', config.admin.login);
}

console.log('\nDahabi Pay seeder');
console.log('  database: %s%s', db.engine, db.engine === 'sqlite' ? ` (${config.db.file})` : '');

await db.migrate();
if (reset) await wipe();

await db.tx(async () => {
  await seedCurrencies();
  await seedDirections();
  await seedEditorial();
  await seedAdmin();
});

const counts = {
  currencies: await db.val('SELECT COUNT(*) FROM currencies'),
  directions: await db.val('SELECT COUNT(*) FROM direction_rules'),
  users: await db.val('SELECT COUNT(*) FROM users'),
  orders: await db.val('SELECT COUNT(*) FROM orders')
};
console.log('\n  totals: %o\n', counts);
await db.close();
