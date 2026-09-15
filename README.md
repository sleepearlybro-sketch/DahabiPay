# Dahabi Pay

A prototype exchanger for crypto, electronic accounts and African mobile money,
with live rates, a server-enforced order pipeline and an operator back office.

The design system and page inventory follow the modern-exchanger pattern
(navy/lime, `Unbounded` + `Nunito`, exchanger card, steps, advantages, reviews,
news, partners, policy pages). Layout and system design were modelled on that
pattern. The current product name is Dahabi Pay. Demo content and claims still
need replacement with verified business information before publication.

**Not ready to accept real customer money.** The audit reproduced 171 passing
checks but found payment, KYC, internal-balance, affiliate and security gaps
outside that coverage. See [DEPLOY.md](DEPLOY.md) for the launch gates and
[the detailed audit](data/audit-20260914/PROJECT_AUDIT.md) for evidence.

Maintenance-mode Railway deployment:
<https://dahabi-pay-production.up.railway.app>

## Run it

```bash
npm install
cp .env.example .env     # then fill in ADMIN_PASSWORD at least
npm run seed
npm start
```

- Site: <http://127.0.0.1:3000/>
- Operator panel: <http://127.0.0.1:3000/admin/>

The seeder refuses to create an administrator unless `ADMIN_PASSWORD` is set and
at least 12 characters, so no default credential can ship by accident.

Live rates need no API key: crypto pivots come from CoinGecko and fiat from
open.er-api.com, both keyless.

Opened straight off the filesystem with no server, the pages fall back to a
bundled dataset and run as a static demo.

## Tests

171 checks. The three integration suites need the server running.

```bash
npm test              # 28  unit: decimals, state machine, reserve accounting
npm run test:e2e      # 74  quote -> order -> operator payout, auth, limits
npm run test:account  # 50  password, PIN, sessions, KYC, withdrawals, lookup
npm run test:webhook  # 19  signatures, replay, idempotency (needs CRYPTO_WEBHOOK_SECRET)
```

## Deployment

See **[DEPLOY.md](DEPLOY.md)** for hosting, database, payment providers,
compliance and the go-live checklist.

```bash
docker compose up -d          # only after configuring and testing the templates
```

## Layout

```
index.html  pages/            25 pages: exchanger, rates, order flow, auth,
                              account area, security, KYC, affiliate, tracking,
                              FAQ, news + articles, policies
assets/
  css/app.css                 the whole design system (tokens -> components)
  js/api.js                   API client; falls back to the bundled dataset
  js/data.js                  offline dataset + seed source
  js/app.js                   page shell (header/nav/drawer/sidebar/footer)
  js/exchanger.js             exchange widget + table/content renderers
  js/forms.js                 forms, order flow, account screens
admin/                        operator panel, hash-routed, no build step
server/
  index.js                    express bootstrap, static mount, pollers
  config.js  db.js  schema.sql  seed.js  PostgreSQL/SQLite database layer
  lib/
    money.js                  fixed-point decimals (BigInt)
    auth.js                   scrypt, sessions, roles, rate limits
    captcha.js                server-side challenge, single use
    orders.js                 pricing, reserve accounting, state machine
    settle.js                 the one path that pays money out
    http.js  xml.js
  routes/                     public, auth, orders, account, admin, webhooks
  services/
    rates.js                  live pivot feed + staleness guard
    payments/                 provider interface: manual, crypto, mobile
    mail.js                   SMTP, or log-only when SMTP_HOST is unset
  test/                       unit + integration suites
  tools/                      one-off maintenance scripts
deploy/
  Caddyfile                   reverse proxy + automatic TLS
  litestream.yml              continuous SQLite replication to S3
  exchangepay.service         hardened systemd unit (non-Docker path)
  backup.sh  restore.sh       verified snapshots
Dockerfile  docker-compose.yml
DEPLOY.md                     hosting, providers, compliance, go-live
```

## How the money logic works

Every currency carries a USD pivot and a send-side fee in basis points. A cross
rate is:

```
rate = (pivot_send × (1 − fee_send)) ÷ pivot_receive
```

All of it is fixed-point `BigInt` arithmetic in `server/lib/money.js` — never
floats. The test suite includes the cases that catch float drift (`0.1 + 0.2`,
a thousand additions of `0.001`, half-up rounding of `2.675`).

`EP.directions` is a group-to-group allow list with optional per-pair
overrides. The widget hides pairs it does not open, and the server checks again.

## Existing money-handling safeguards

These safeguards have tests, but they do not prove the entire payment flow is
safe. Callback recovery and settlement gaps remain; see DEPLOY.md.

**1. Reserve oversell.** `currencies.reserved` tracks liquidity committed to
open orders. Order creation re-reads the row, checks `reserve - reserved`, and
increments `reserved` — all inside one transaction. Concurrency test: fire five
orders at a reserve that fits two; exactly two are accepted.

**2. Client-supplied amounts.** `create()` takes no rate or receive argument at
all. Whatever the browser computed is a display hint; the server prices the
order from its own pivots.

**3. Rate lock.** `rate` and `lock_expires_at` are written server-side and never
accepted from a client. An expired quote releases its reserve hold and can be
re-quoted, which the customer must explicitly accept.

**4. Stale pivots.** A feed-backed pivot older than `RATES_MAX_STALE_SEC` stops
its directions quoting and drops them from the XML feed, rather than publishing
a price that will not be honoured.

**5. Double payout.** `payout_locks` has the primary key `<order>:payout`,
claimed before the provider is called. A webhook replay and a double-clicked
operator button both hit the key and pay nothing twice.

**6. Webhook authenticity.** HMAC-SHA256 over the raw body with a timing-safe
compare, then recorded against a `UNIQUE (provider, provider_ref)`. Unsigned or
mismatched callbacks are logged and dropped, never acted on.

**7. Server-side captcha and limits.** The captcha answer never leaves the
server; challenges are single-use. Rate limits are database-backed, so
restarting the process cannot reset a bucket.

## Order lifecycle

```
created → awaiting_payment → payment_detected → processing → completed
                           ↘ expired
                           ↘ cancelled
      any non-terminal     → on_hold → resumed | refunded
```

One `transition()` holds the allowed-transitions map; anything else throws.
Every change appends to `order_events`, which is what both the customer's
progress list and the operator's timeline render.

## Operator panel

| Screen | What it does |
|---|---|
| Dashboard | counts by status, 24h volume, low reserves, stale feed, provider health |
| Orders | filter and search; detail with full timeline and provider callbacks |
| Order actions | mark paid, pay out, confirm sent, hold, resume, cancel, refund, re-quote |
| Currencies | fee, limits, enable, manual flag, pivot source, deposit address |
| Reserves | adjust with a mandatory reason, written to the ledger |
| Directions | group matrix plus per-pair overrides |
| Users | search, block, roles, fee discount, session revoke |
| KYC | review queue, approve or reject with a reason |
| Withdrawals | approve or reject; rejection returns the balance |
| Reviews | moderate customer reviews before they publish |
| Rate feed | cached pivots, staleness, manual refresh |
| Audit log | every mutation with actor, IP and before/after |
| Settings | maintenance mode, KYC threshold, affiliate tiers |

Payout, refund and block need a typed confirmation and a reason. Every mutation
writes `audit_log`.

## Payments

One interface, three implementations:

```
createDeposit(order, currency)          → { address, memo? }
payout(order, currency, requisite)      → { providerRef, status }
verifyWebhook(rawBody, headers, secret) → { ok, orderId, event, amount, … }
```

`manual` is the default and needs no keys: deposits show the static address on
the currency row and payouts queue for an operator. `crypto.js` and `mobile.js`
activate only when their env keys are present — and a provider that is named but
unconfigured **degrades to manual** rather than failing at payout time, which
would strand a paid order.

## Database

Production uses PostgreSQL when `DATABASE_URL` is set. Railway should inject it
as a reference to `${{Postgres.DATABASE_URL}}`; never hard-code the password.
The schema is created by `npm run seed`, and money-changing transactions use
PostgreSQL row locks. With no `DATABASE_URL`, local development and tests use
SQLite via `node:sqlite`.

## Deployment notes

- Set `COOKIE_SECURE=1` and `NODE_ENV=production`. The server prints a warning
  on boot for each unsafe setting it finds.
- Put it behind a TLS-terminating proxy; `trust proxy` is enabled in production
  so `req.ip` honours `X-Forwarded-For`.
- `/api/cron/rates` and `/api/cron/expire` exist for an external scheduler
  (`CRON_SECRET`). The in-process poller runs both anyway.
- KYC uploads land in `data/kyc/`, outside the web root and never served over
  HTTP. Back that directory up separately, or move it to object storage.

## Test data

The development database contains accounts and orders left by the test suites,
plus two blocked local test accounts (`uitest`, `uidemo`). For a disposable test
database only, the destructive reset command is:

```bash
npm run reset
```

Never reset an existing customer database. Use a separate empty volume for a
new environment, then review all seeded currencies, addresses and demo content.

Test accounts are blocked rather than deleted because `audit_log.actor_id` and
`orders.operator_id` both reference `users(id)` — deleting an account that has
acted on anything would tear a hole in the audit trail. `server/tools/lock-test-accounts.mjs`
does the blocking.

## Still to do before taking real customers

- **Policy pages are placeholder text.** `agreement`, `aml-kyc`, `privacy` and
  `returns` have the right structure but need counsel review per jurisdiction,
  and the legal-entity block in `pages/about.html` must be filled in before any
  monitor listing.
- **Custody is out of scope.** Hot-wallet caps, key separation and cold storage
  are operational decisions, not code in this repo.
- **Deposit addresses are placeholders.** The seeder writes
  `DEMO-<CURRENCY>-SET-A-REAL-ADDRESS`; replace them in the admin panel or
  connect a real crypto provider.
- **Email is log-only** until configured. The custom SMTP client also needs
  replacement or repair; adding credentials alone is insufficient on port 587.
  On DigitalOcean use an HTTPS email API because SMTP ports are blocked.
- **Further launch blockers:** payment callback recovery, KYC enforcement,
  internal-balance settlement, affiliate accounting and unsafe HTML rendering.
  [DEPLOY.md](DEPLOY.md) is the full current checklist.
