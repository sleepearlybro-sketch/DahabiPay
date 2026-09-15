/* ==========================================================================
   Dahabi Pay - demo dataset
   Single source of truth for currencies, rates, reserves, directions and
   editorial content. Swap this file for API calls when wiring a backend:
     GET /api/v1/currencies   -> EP.currencies
     GET /api/v1/directions   -> EP.directions
     GET /api/v1/rates.xml    -> generated from the two above
   ========================================================================== */

window.EP = window.EP || {};

/* --------------------------------------------------------------- site meta */
EP.site = {
  brand: 'Dahabi Pay',
  brandA: 'Dahabi ',
  brandB: 'Pay',
  tagline: 'your gateway to digital currencies',
  claim: '24/7 automated transactions powered by Dahabi Pay advanced Autopayments',
  email: 'support@dahabipay.example',
  tgChannel: '#',
  tgOperator: '#',
  baseCurrency: 'USD'
};

/* -------------------------------------------------------------- currencies
   rate    = value of 1 unit in USD (the pivot used for cross rates)
   reserve = available liquidity, in units of that currency
   fee     = share taken on the send side (0.01 = 1%)
   field   = requisite the customer must supply to receive funds
*/
EP.currencies = [
  /* ---- crypto ---- */
  { id:'btc',        name:'Bitcoin',      net:'',       code:'BTC',  group:'crypto', color:'#f7931a', rate:63500,  reserve:4.85,      min:0.0004, max:2.5,    fee:0.012, field:'BTC wallet address' },
  { id:'eth',        name:'Ethereum',     net:'',       code:'ETH',  group:'crypto', color:'#627eea', rate:2480,   reserve:52.4,      min:0.01,   max:60,     fee:0.012, field:'ETH wallet address' },
  { id:'ton',        name:'Toncoin',      net:'',       code:'TON',  group:'crypto', color:'#0098ea', rate:5.42,   reserve:18400,     min:5,      max:25000,  fee:0.014, field:'TON wallet address' },
  { id:'usdt_trc20', name:'Tether',       net:'TRC20',  code:'USDT', group:'crypto', color:'#26a17b', rate:1.00,   reserve:248000,    min:10,     max:120000, fee:0.010, field:'USDT TRC20 address' },
  { id:'usdt_erc20', name:'Tether',       net:'ERC20',  code:'USDT', group:'crypto', color:'#26a17b', rate:1.00,   reserve:96500,     min:50,     max:90000,  fee:0.012, field:'USDT ERC20 address' },
  { id:'usdt_bep20', name:'Tether',       net:'BEP20',  code:'USDT', group:'crypto', color:'#26a17b', rate:1.00,   reserve:141200,    min:20,     max:90000,  fee:0.010, field:'USDT BEP20 address' },
  { id:'usdt_ton',   name:'Tether',       net:'TON',    code:'USDT', group:'crypto', color:'#26a17b', rate:1.00,   reserve:37800,     min:20,     max:40000,  fee:0.011, field:'USDT TON address' },
  { id:'usdc_erc20', name:'USD Coin',     net:'ERC20',  code:'USDC', group:'crypto', color:'#2775ca', rate:1.00,   reserve:74300,     min:50,     max:70000,  fee:0.012, field:'USDC ERC20 address' },
  { id:'usdc_bep20', name:'USD Coin',     net:'BEP20',  code:'USDC', group:'crypto', color:'#2775ca', rate:1.00,   reserve:45900,     min:20,     max:50000,  fee:0.011, field:'USDC BEP20 address' },

  /* ---- account balances ---- */
  { id:'acct_usd',   name:'My Account',   net:'',       code:'USD',  group:'account',color:'#025081', rate:1.00,   reserve:500000,    min:1,      max:100000, fee:0.000, field:'Internal account ID' },
  { id:'optimoney',  name:'OptiMoney',    net:'',       code:'USD',  group:'account',color:'#7b5cf0', rate:1.00,   reserve:21400,     min:5,      max:15000,  fee:0.015, field:'OptiMoney account number' },
  { id:'moneygo',    name:'Money Go',     net:'',       code:'USD',  group:'account',color:'#e0338b', rate:1.00,   reserve:18600,     min:5,      max:12000,  fee:0.015, field:'Money Go account number' },

  /* ---- mobile money & local rails ---- */
  { id:'mpesa_kes',  name:'M-Pesa',       net:'Kenya',  code:'KES',  group:'mobile', color:'#4caf27', rate:0.00775, reserve:4200000,  min:500,    max:900000, fee:0.018, field:'Safaricom number (2547...)' },
  { id:'kcb_kes',    name:'KCB Bank',     net:'Kenya',  code:'KES',  group:'mobile', color:'#0a6b3d', rate:0.00775, reserve:2650000,  min:1000,   max:700000, fee:0.020, field:'KCB account number' },
  { id:'airtel_ugx', name:'Airtel Money', net:'Uganda', code:'UGX',  group:'mobile', color:'#e4002b', rate:0.000268,reserve:96000000, min:20000,  max:18000000,fee:0.020, field:'Airtel number (2567...)' },
  { id:'ebirr_etb',  name:'E-Birr',       net:'Ethiopia',code:'ETB', group:'mobile', color:'#0f8a4c', rate:0.00795, reserve:3100000,  min:500,    max:600000, fee:0.022, field:'E-Birr wallet number' },
  { id:'mtn_ghs',    name:'MTN MoMo',     net:'Ghana',  code:'GHS',  group:'mobile', color:'#ffcc00', rate:0.0645,  reserve:420000,   min:50,     max:90000,  fee:0.020, field:'MTN number (2335...)' },
  { id:'vodafone_egp',name:'Vodafone Cash',net:'Egypt', code:'EGP',  group:'mobile', color:'#e60000', rate:0.0206,  reserve:1450000,  min:200,    max:250000, fee:0.021, field:'Vodafone Cash number' },
  { id:'instapay_egp',name:'InstaPay',    net:'Egypt',  code:'EGP',  group:'mobile', color:'#1a3c8f', rate:0.0206,  reserve:1980000,  min:200,    max:300000, fee:0.019, field:'InstaPay address / IPA' },
  { id:'cashplus_mad',name:'Cash Plus',   net:'Morocco',code:'MAD',  group:'mobile', color:'#f4791f', rate:0.101,   reserve:380000,   min:100,    max:70000,  fee:0.022, field:'Beneficiary full name + CIN' },
  { id:'wafacash_mad',name:'WafaCash',    net:'Morocco',code:'MAD',  group:'mobile', color:'#c8102e', rate:0.101,   reserve:295000,   min:100,    max:60000,  fee:0.023, field:'Beneficiary full name + CIN' },
  { id:'postepay_dzd',name:'Postepay',    net:'Algeria',code:'DZD',  group:'mobile', color:'#0b7a3b', rate:0.00743,  reserve:5400000, min:2000,   max:900000, fee:0.024, field:'CCP / Baridi card number' },
  { id:'baridi_dzd', name:'BaridiMob CCP',net:'Algeria',code:'DZD',  group:'mobile', color:'#d4a017', rate:0.00743,  reserve:6100000, min:2000,   max:900000, fee:0.024, field:'CCP account number' }
];

EP.groups = {
  crypto:  'Cryptocurrencies',
  account: 'Electronic accounts',
  mobile:  'Mobile money & local banking'
};

/* --------------------------------------------------------------- directions
   Which pairs are actually open for trade. '*' on either side means "any".
   Cross-rate comes from the two currencies' USD pivots plus the send fee.
*/
EP.directions = [
  { from:'crypto',  to:'mobile'  },
  { from:'crypto',  to:'account' },
  { from:'mobile',  to:'crypto'  },
  { from:'account', to:'crypto'  },
  { from:'account', to:'mobile'  },
  { from:'mobile',  to:'account' },
  { from:'crypto',  to:'crypto'  }
];

/* -------------------------------------------------------------- editorial */
EP.advantages = [
  'Strong reserves across key markets',
  'Instant currency swaps and transfers',
  'Global digital payment coverage',
  'Industry-low fees and profitable rates',
  '24/7 availability and support'
];

EP.steps = [
  { n:1, t:'Select currencies',      d:'We have many currencies to exchange for your convenience' },
  { n:2, t:'Pay for the application',d:'Fill in the required data and make payment' },
  { n:3, t:'Get your coins',         d:'Get your cryptocurrency at a favorable rate' }
];

EP.reviews = [
  { who:'Murtaza',        date:'07.01.2026, 08:28', text:'This is a great exchange site, I recommend everyone to use it.' },
  { who:'Joseph',         date:'28.12.2025, 01:51', text:'Very smooth crypto exchange process. The interface is simple and beginner-friendly.' },
  { who:'Chris Thompson', date:'28.12.2025, 01:49', text:'Great option for people who need quick crypto conversions.' },
  { who:'Yuusuf',         date:'28.12.2025, 01:49', text:'Dahabi Pay is becoming my go-to exchange platform.' },
  { who:'Karemis',        date:'28.12.2025, 01:48', text:'Simple steps and clear instructions make it easy to use.' },
  { who:'Mwangi',         date:'28.12.2025, 01:48', text:'Transactions are confirmed quickly, which I really appreciate.' }
];

EP.news = [
  { date:'30.05.2026 11:05', title:'Stablecoins Drive the Next Wave of Global Payments Innovation',
    excerpt:'The rapid adoption of stablecoins across remittance corridors is reshaping how value moves between mobile money and crypto rails.' },
  { date:'30.05.2026 10:05', title:'Official Announcement: Listed on a Leading Exchange Monitor',
    excerpt:'We are pleased to announce that our rates are now published on one of the largest independent exchanger monitors.' },
  { date:'31.03.2026 02:03', title:'Security Notice: What Large Exchange Hacks Teach Us About Custody',
    excerpt:'A look at how cold storage policy, withdrawal allow-lists and operator separation keep customer reserves safe.' }
];

EP.partners = [
  'Exchange Monitor','Rate Aggregator','Trust Reviews','Exchange Sumo',
  'e-Monitor','Crypto Ads','OK Changer','Well Crypto',
  'Kurs Expert','SSL Verified','AML Screening'
];

EP.faq = [
  { q:'How long does an exchange take?',
    a:'Automated directions complete within 5-15 minutes once your payment reaches the required number of network confirmations. Manual directions handled by an operator are processed within 30 minutes during working hours.' },
  { q:'Do I need an account to exchange?',
    a:'No. Guest exchanges are supported - you only need a valid receiving requisite and an email for status notifications. Registering gives you transaction history, saved requisites, the affiliate program and better rates on repeat volume.' },
  { q:'Why did my rate change before I paid?',
    a:'Floating directions are re-quoted from the live market. Each order locks the quote for 20 minutes; if payment arrives after the lock expires, the order is recalculated at the rate in force at the moment funds are credited.' },
  { q:'What are the limits?',
    a:'Minimum and maximum amounts are shown per currency in the rates table and are enforced by the exchange form. Amounts above the published maximum can be arranged with an operator, subject to reserve.' },
  { q:'Which verification do you require?',
    a:'Routine exchanges within published limits need no documents. Verification may be requested where our AML/KYC policy requires it - for example on high amounts, flagged source of funds, or refund processing.' },
  { q:'How do I get a refund?',
    a:'Submit a request from the order page or by email within 24 hours, quoting the order ID. Refunds are returned to the originating requisite less network costs, per the Returns Policy.' },
  { q:'Is there an API?',
    a:'Yes. Rates, reserves and direction limits are published as an XML feed compatible with common exchanger monitors. See the Rates API page.' }
];
