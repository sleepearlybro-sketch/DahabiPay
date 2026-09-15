# Dahabi Pay: production launch plan

Updated 15 September 2026. This replaces the earlier deployment advice.

## Current status

The public site, operator panel, email templates and package metadata now use
Dahabi Pay. Existing database filenames, service identifiers, cookies and stored
records remain compatible; a brand rename does not migrate customer data.
The `.example` email addresses and domains are placeholders, not registrations.

The project is a working prototype, not ready for real customer funds. During
the preceding audit, all 171 existing checks passed (28 unit, 74 exchange, 50
account, 19 webhook). Additional probes exposed important failures not covered
by those tests. Passing that suite is not a production approval.

The full findings and reproduction evidence are in
[data/audit-20260914/PROJECT_AUDIT.md](data/audit-20260914/PROJECT_AUDIT.md).
That document retains the historical ExchangePay name from the audit.

A maintenance-mode deployment now runs in Railway's `production` environment at
<https://dahabi-pay-production.up.railway.app>. The application and PostgreSQL
services communicate over Railway's private network. The live health endpoint
reports PostgreSQL, 23 currencies and fresh rates. This is a production-hosted
staging deployment; maintenance mode must remain enabled until the launch gates
below are complete.

## Where to deploy

Recommended starting architecture after the launch gates below are complete:

```text
Customer -> Railway HTTPS -> Dahabi Pay Node application
                                |-> Railway PostgreSQL via private network
                                |-> private KYC storage
                                |-> selected payment provider APIs
                                |-> HTTPS email service

KYC volume backups -> private offsite object storage
External monitoring -> operator alerts
```

| Option | Fit for this repository | Cost and responsibility |
| --- | --- | --- |
| Railway Pro with PostgreSQL and a persistent KYC volume | Selected deployment target. Deploy the Node/Docker service, reference Postgres `DATABASE_URL`, and mount `/data` for private KYC documents | $20/month minimum including $20 resource usage; excess compute, database, storage and traffic are billed |
| DigitalOcean Basic Droplet, regular CPU, 4 GiB / 2 vCPU / 80 GiB | Alternative for the Docker Compose stack; full responsibility for PostgreSQL or the SQLite fallback, system security and recovery | $24/month for the VM; operating-system updates, security, backups and recovery are your responsibility |
| Render paid web service with a persistent disk | Managed alternative; mount `/data` and keep a single instance; initialize the database at runtime | Paid compute plus disk; attached disks prevent multiple instances and zero-downtime deployment |

Prices and constraints were checked against [DigitalOcean pricing](https://www.digitalocean.com/pricing/droplets),
[Railway plans](https://docs.railway.com/pricing/plans) and
[Render persistent disks](https://render.com/docs/disks). Recheck the selected
region, tax and final quote before purchasing.

My planning allowance is **USD 35-70/month** for a small single-server deployment:
$24 VM, $7.20 daily VM backup under DigitalOcean's percentage-based plan, plus
variable object storage, email and domain costs. This is an estimate, not a
provider bundle or availability guarantee. A separate staging server, larger
traffic, paid monitoring or support may increase it. It excludes liquidity,
transaction fees, KYC screening, legal work, licenses and staff.

Choose the hosting region after checking customer latency, provider connectivity
and applicable data-location requirements. The user's timezone does not establish
the business's legal jurisdiction. Confirm the host and payment providers accept
the intended business model before paying for services.

DigitalOcean blocks outbound SMTP ports 25, 465 and 587 by default. The current
SMTP-only mailer therefore needs an HTTPS email integration, such as the
[Resend send-email API](https://resend.com/docs/api-reference/emails/send-email),
with a verified sender domain. Merely entering SMTP credentials will not solve
this. See [DigitalOcean's SMTP policy](https://docs.digitalocean.com/support/why-is-smtp-blocked/).

The present backend needs a persistent process and durable writable storage.
Static hosting or a typical serverless deployment on Vercel, Netlify or
Cloudflare Pages is not a drop-in target for this architecture. A redesigned
backend could use those platforms, but that is separate implementation work.

## Database decision

Railway production is configured for PostgreSQL through `DATABASE_URL`. The
application performs schema creation and idempotent seeding in Railway's
pre-deploy phase. Local development continues to use SQLite when the URL is
absent, keeping tests isolated from production.

The database layer and all production routes now use asynchronous queries and
PostgreSQL transactions. Reserve and order mutations use row locks where
concurrency can affect balances. Railway currently holds a 500 MB PostgreSQL
volume, and the app has a separate 500 MB `/data` volume for private KYC files.

SQLite is a reasonable initial choice for one instance with bounded concurrent
writes, durable local storage and demonstrated backup recovery. It does not
provide high availability simply because Litestream is installed. A single
server remains an availability risk and needs a tested recovery plan.

Do not attach the same SQLite file to multiple app servers or put it on a shared
network filesystem. PostgreSQL is now the selected production database; SQLite
remains a local/test fallback. See
[SQLite's deployment guidance](https://www.sqlite.org/whentouse.html).

## Code work required before live funds

| Priority | Current gap | Completion criterion |
| --- | --- | --- |
| P0 | Crypto/mobile adapters use generic endpoints, not verified provider contracts; e-money integrations are missing | Choose providers and supported launch pairs. Implement their actual auth, identifiers, amounts, currencies, network rules, errors and sandbox flows. Disable unsupported pairs. |
| P0 | Mobile callbacks supply one confirmation while the default requires two; deposits missing an amount can advance; payout-completed callbacks do not complete orders | Provider-specific settlement rules; validated amount/currency/order/network; confirmed payouts reach a reconciled terminal state. Test underpayment, overpayment, wrong currency, replay and out-of-order events. |
| P0 | Callback records can consume retries before business handling succeeds; payout locks can strand failed/uncertain payouts | Durable event processing and reconciliation, safe retries, provider idempotency and explicit recovery of unknown outcomes without double payment. |
| P0 | Internal-account exchange directions can accept guest orders without a funded internal ledger debit | Authenticate and atomically debit/credit the appropriate ledger, or disable internal-account directions for launch. Test insufficient funds and concurrent debits. |
| P0 | KYC upload promises 6 MB but global JSON limit is 256 KB; stored threshold is not enforced | Route-specific upload handling with safe size/type validation; enforce the agreed verification policy before relevant orders or payouts; authenticated document viewing and access audit for reviewers. |
| P0 | Moderated review text can enter unescaped HTML | Escape untrusted text or use safe DOM rendering; audit all customer/operator renderers and add a regression test for stored XSS. |
| P1 | Affiliate capture is absent on homepage; cookie lifetime, fee basis, withdrawal currency and minimum rules are inconsistent | Correct referral attribution and expiry, accrue on the intended fee basis, reconcile ledger conversion and enforce minimum payouts; otherwise disable the program. |
| P1 | Email currently logs when unset; custom SMTP client lacks STARTTLS on port 587 | Implement a supported secure transport/HTTPS API, retry failed deliveries, verify domain DNS and demonstrate signup/reset delivery. Redact tokens and personal data from production logs. |
| P1 | Demo fallbacks, support links, public claims and seed data can look live | Explicit unavailable states for production failures; real contacts, verified reserves, real receiving addresses and supported currency pairs. Remove demo reviews, partner claims and invented operational statistics. |
| P1 | Deployment and recovery templates are incomplete | Pin tested container versions; configure the replication bucket; implement volume-aware backup and restoration for both DB and KYC. Demonstrate recovery on a separate host. |

An independent security review should cover authorization, sessions, account
recovery, CSRF, upload access, dependency vulnerabilities, secrets, rate limits,
provider callbacks and all money-changing operations. Add strong administrator
authentication (MFA or an enforced identity gateway), least-privilege roles and
operator approval controls appropriate to the value at risk. These are launch
acceptance checks, not claims that each listed area has a proven vulnerability.

## Hosting configuration and operational work

1. Put the source in a private version-controlled repository. Keep `.env`, live
   databases, uploads and audit test artifacts out of source control and images.
   Add CI with the existing suites and regression tests for the audit findings.
2. Build a pinned, reproducible Node/Docker image. Use one app replica. On the VPS
   run Caddy in front; expose public ports 80/443 only, restrict SSH by key and
   network, and keep port 3000 private. Review proxy trust before adding a CDN.
3. Configure the owned domain's DNS and automatic TLS. Create a separate staging
   hostname, credentials and database. Verify that backups, `.env`, database
   files and KYC documents cannot be fetched as public static assets.
4. Use a new production volume. Initialize the administrator once with a unique
   password. Review the seeded currencies, addresses, content and balances;
   do not clone the development/audit database into production. Never run
   `npm run reset` against a database containing customer records.
5. Configure and test offsite storage, encryption, access controls, retention,
   recovery keys and alerts. Include private KYC documents, not only SQLite.
   Define the acceptable data-loss window and recovery time; measure both.
6. Add external availability checks, stale-rate alerts, failed callback/settlement
   alerts, queue age, reserve thresholds, disk usage and backup-age monitoring.
   `/api/health` currently reports success even when feed freshness is a problem;
   process liveness must not be treated as full exchange readiness.
7. Create deployment, rollback, incident, refund and daily reconciliation runbooks.
   Retain the previous image and compatible database recovery point. Do not
   restore an old money database without reconciling transactions already sent
   through external providers.

Existing template limitations to fix:

- `deploy/litestream.yml` still contains a `CHANGE-ME` bucket, and Compose uses
  an unpinned Litestream image. Validate configuration against the pinned version.
- `deploy/backup.sh` creates a KYC archive but its S3 upload covers only the DB.
  Host-oriented scripts need adaptation to the Docker named volume. The restore
  path also needs to recover KYC files and permissions.
- The `.claude/launch.json` preview uses Python's static server. Use `npm start`
  for the full local application; never expose the project directory through
  that static server as a production deployment.
- Docker health status alone does not restart an unhealthy but still-running
  application. Add alerting and recovery behavior; the restart policy covers
  process exits, not every unhealthy response.

Production configuration checklist (names already supported unless noted):

| Setting | Required value or action |
| --- | --- |
| `NODE_ENV`, `COOKIE_SECURE` | `production`, `1` |
| `PUBLIC_ORIGIN`, `DOMAIN`, `ACME_EMAIL` | Owned HTTPS origin, actual hostname and monitored email; replace every `.example` value |
| `HOST`, `PORT` | Container listens on `0.0.0.0:3000`; managed host must route to the selected port |
| `DATABASE_URL` | On the app service, reference `${{Postgres.DATABASE_URL}}`; do not copy the literal password |
| `DB_FILE` | SQLite fallback and KYC directory base; Docker defaults to `/data/exchangepay.db` |
| `DB_POOL_MAX`, `DB_SSL` | Start with `10` and `0` on Railway private networking |
| `ADMIN_LOGIN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Unique initial admin; guard the seed secret and enable the agreed MFA/access control |
| `CRYPTO_*`, `MOBILE_*` | Approved providers, sandbox/live separation, keys, URLs and distinct webhook secrets after adapter completion |
| `PAYOUT_CONFIRMATIONS` | Network/provider-specific policy must be implemented; the current single number is insufficient for all rails |
| `MAIL_FROM` | Verified Dahabi Pay sender; HTTPS email credential/config support still needs implementation |
| `CRON_SECRET` | Strong random secret if external cron endpoints are used |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `BACKUP_S3_URI` | Least-privilege private backup destination; configure Litestream's endpoint/region/bucket separately |
| Rate settings | Confirm upstream availability, usage terms and freshness limits; alert when quotes are disabled |
| Upload settings | Configure only after fixing upload parsing and validating the actual enforced limits |

## Information and accounts the owner must supply

- Legal entity, operating country, intended customer countries, supported assets
  and whether Dahabi Pay holds customer funds. Have qualified local counsel
  determine applicable exchange/payment, AML/KYC, privacy and reporting duties.
  This document cannot determine authorization without that business scope.
- Approved provider/merchant accounts and live credentials for each launch rail;
  banking/mobile-money arrangements, limits, settlement schedules and fees.
- Domain ownership and DNS access; hosting account; verified transactional email
  account; private backup account and chosen retention policy.
- Real support email/chat/Telegram details and response hours; approved terms,
  privacy policy, fees, cancellation/refund rules and legal-entity contact block.
- Funded reserves and liquidity limits; custody/key-management plan, daily
  reconciliation, authorized operators and escalation contact.

Supply credentials through the deployment's secret store, not through public
repository files. None of these accounts or registrations is provided merely by
renaming the product.

## Release acceptance and order

1. Finish the P0 fixes, select a narrow set of supported directions, and disable
   features whose accounting or provider support is unfinished.
2. Deploy private staging with sandbox providers. Run all existing tests against
   its disposable database, plus regressions for every audit finding.
3. Demonstrate signup, verification, reset, KYC approval, quote, deposit,
   confirmation, payout, refund, expiry and reconciliation. Exercise duplicate,
   delayed, failed and reordered callbacks, concurrent requests and restarts.
4. Complete security review, load testing appropriate to expected volume, and a
   full offsite DB-plus-KYC restore drill. Fix failures and repeat affected tests.
5. Complete business/provider approvals, production configuration, policies,
   monitoring and operator training. Verify that public claims are accurate.
6. Deploy production with exchange intake disabled, verify TLS, restricted admin
   access, mail, backups and provider connectivity, then perform approved small
   controlled transactions. Open only the tested directions and monitor closely.

The TouchPay visual match is a separate unfinished workstream: hero artwork,
logos/icons, header and calculator proportions, sliders, partner section,
inner-page sidebars, real language support, route details and matched mobile
layouts. Use Dahabi Pay branding and truthful business content. Visual matching
alone does not complete the payment or operational launch gates above.
