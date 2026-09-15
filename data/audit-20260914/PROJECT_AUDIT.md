# ExchangePay project audit

Completed 15 September 2026. Reference: [TouchPay](https://touchpay.exchange/).

**Verdict: a substantial working prototype exists, but this is not a 100% copy of TouchPay and is not a finished automated exchange.** The existing claim of 171 passing checks is reproducible; those checks do not cover several important unfinished flows.

No application source was changed for this audit. Tests used a separate database under `data/audit-20260914`, with manual payment providers and test accounts. The original application database and configuration were not modified.

## What already exists

| Area | Confirmed implementation |
|---|---|
| Public site | Homepage plus 25 pages: exchange/order tracking, rates, news/articles, reviews, FAQ, policies, authentication and customer account pages |
| Customer accounts | Registration, password hashing, cookie sessions, verification/reset links, password change, personal PIN, session revocation, profile and transaction history |
| Exchange engine | Server-side pricing, fixed-point money arithmetic, limits, direction rules, rate expiry, reserve holds, order transitions and event history |
| Rates | Crypto and fiat price feeds, cached prices, stale-price refusal, XML/JSON exports |
| Operator panel | Orders, manual settlement, currencies/reserves, directions, users, KYC review, withdrawal review, review moderation, rate feeds, audit log and settings |
| Account features | Balance/ledger display, withdrawal requests, referral identifiers, reward accrual and document upload |
| Deployment files | Docker, Caddy, systemd, backup/restore scripts and a Litestream template |

## Remaining work to match TouchPay

This comparison uses the live homepage and one public exchange direction, plus public FAQ/About content and local source inspection. Reference account interiors, paid-order screens and the private operator panel were not accessible for comparison.

| Area | Difference and required work |
|---|---|
| Branding and artwork | ExchangePay uses a generated text/letter mark. TouchPay has a different wordmark, a large trading illustration, currency logos and illustrated advantage icons. `assets/img` is empty. Add the actual visual assets or approved equivalents. Keeping ExchangePay branding would be an intentional deviation from an exact copy. |
| Header/navigation | Local site has a persistent second navigation row, an extra Rates link, different button treatment and header proportions. Match the reference's visible menu behavior, spacing and typography. |
| Hero | The reference illustration has been replaced with a paragraph and three statistics. Local headline, exchange-card proportions and overall height differ considerably. Rebuild this section around the reference composition. |
| Calculator | Default local pair is USDT to M-Pesa with amount 100; the reference observed was USDT to Money Go with amount 1. Icons, dropdown order, field proportions, limits presentation and swap control differ. Match the interaction and per-direction fields. Live prices/reserves naturally change; they should not be frozen merely to match a screenshot. |
| Currency catalogue | Local seed has 23 currencies. The observed reference send selector listed 22 entries and used different labels/order. Verify send and receive catalogues separately, including which directions are actually available. |
| Steps and advantages | Similar wording exists, but type sizing, spacing and illustrations differ. Local advantages are checkmark rows. |
| Reviews/news | Reference uses slider controls; local uses static grids. Some news titles and article text were rewritten. Seeded timestamps render three hours later locally in the observed browser. Align card styling, navigation, content and time-zone handling. |
| Partners | Reference shows 14 linked partner/monitor logos; local renders 11 generic text labels without equivalent links. |
| Public inner pages | Reference FAQ/About/exchange pages include authorization and reviews in a sidebar. Local uses different page layouts. FAQ and policy content also differ. |
| Exchange form | The reference direction page includes a three-step indicator, direction-specific limits, wallet/email fields, arithmetic CAPTCHA, remember-data control, explanatory content and sidebars. Local form and CAPTCHA differ; the order-creation API has no CAPTCHA gate. |
| Language | Reference offers English/Russian. Local offers English/French/Arabic but only changes the button label and displays a demo notice. Implement real locale content and navigation. |
| Support | Reference has a live-chat widget and real Telegram/email links. Local Telegram links are `#`, email uses `.example`, chat shows a placeholder toast, and the online indicator is unconditional. |
| Footer/routes | Footer grouping differs. Reference uses separate affiliate withdrawal/exchange URLs; local combines these as anchors on one page. Local routes use `/pages/*.html` instead of reference paths. Add matching routes if URL fidelity is part of “100%.” |
| Mobile | Local layout stacks responsively at 390 px, but the extra hero text/statistics push the calculator far down the page. A complete matched-width mobile comparison remains necessary: the browser override applied to the local tab but did not produce a verified 390 px reference screenshot. |

Key local files: `index.html`, `assets/css/app.css`, `assets/js/app.js`, `assets/js/data.js`, `assets/js/exchanger.js`, and `pages/`.

## Functional gaps, in priority order

### 1. Finish actual payment-provider integrations

`server/services/payments/crypto.js` and `mobile.js` implement generic example request shapes such as `/addresses`, `/withdrawals`, `/collections` and `/disbursements`. Selecting a provider name does not implement that provider's authentication, required fields, event mapping or reconciliation. Electronic-account rails also lack dedicated adapters; the registry maps every non-crypto currency to the mobile/manual path.

Remaining: implement the selected providers against their actual API contracts; validate deposits, network/currency, amounts and destination; reconcile asynchronous results; handle failures and uncertain payouts safely; verify in provider sandboxes. No real payment-provider API was exercised in this audit.

Current `.env` inspection found crypto/mobile set to `manual`, with no API keys or API URLs. Seeded deposit addresses and reserves are demo values. Withdrawals and refunds currently depend on an operator performing the real transfer separately.

### 2. Fix settlement callbacks

Runtime probes in the isolated environment confirmed:

| Probe | Actual result | Required correction |
|---|---|---|
| Successful mobile deposit | `awaiting_confirmations`, `have: 1`, `need: 2` | Mobile adapter always returns one confirmation, while the global default requires two. Use rail-specific settlement rules. |
| Signed crypto deposit without `amount` | Advanced to the manual payout queue | Require valid payment evidence, including amount and matching asset/network/order, before automated settlement. |
| `payout.completed` callback | Returned `noted`; order stayed `processing` | Add a provider-specific outgoing-payout completion handler and reconciliation path. |

Evidence: `server/routes/webhooks.js:110`, `:123`, `:126`, `:146`; `server/services/payments/mobile.js:107`; `server/config.js:39`; `server/lib/settle.js`.

Also review callback recovery: events are recorded as handled before business processing, so an exception can cause a retry to be dismissed as a duplicate. Failed/uncertain payouts retain their lock, which prevents duplicate sends but needs an explicit reconciliation/recovery workflow.

### 3. Complete KYC enforcement and review

- **Upload limit is inconsistent.** The page advertises 6 MB, but the global JSON parser defaults to 256 KB. A 300 KB synthetic file encoded in JSON returned HTTP 413 before reaching the upload handler.
- **The threshold is unused.** With `kyc_threshold_usd = 2000`, a guest order sending 3000 USDT was accepted into `awaiting_payment`. The threshold is stored/editable but not enforced in the order flow.
- **Document viewing is unfinished.** The admin queue shows filenames and approval buttons, then tells staff to open files on the server. Add an authenticated document viewer/download endpoint with access logging.
- **Automated AML screening is absent.** Policy text describes screening, but no screening-service integration was found in the order path.

Evidence: `server/config.js:87`, `server/routes/account.js:254`, `server/lib/orders.js:235`, `server/seed.js:154`, `admin/assets/admin.js:818`.

### 4. Complete internal-account money movement

“My Account USD” exists in the catalogue, but there is no dedicated internal-ledger exchange adapter. A guest could create an order sending `acct_usd` without an authenticated account or available balance. It waited for external/manual payment rather than debiting an internal wallet. This probe did not transfer funds.

Implement ownership checks, atomic debits/credits, sufficient-balance validation and corresponding ledger entries for both directions, or disable the rail until those operations exist.

Evidence: `server/services/payments/index.js`, `server/lib/orders.js:235`, `server/routes/account.js:99`.

### 5. Repair referral attribution and reward/withdrawal rules

- Generated referral links land at `/?ref=...`, but capture code is in `forms.js`, which the homepage does not load. Following the normal homepage Sign up link drops the query parameter, so the referral is not reliably preserved.
- Captured referrals use local storage without the advertised 90-day expiry.
- Terms describe a percentage of the service fee; `accrueAffiliate()` calculates a percentage of total USD exchange volume. Decide the intended rule and make code/content agree.
- Rewards accrue in `acct_usd`, while withdrawal requests debit the selected destination currency's balance. There is no conversion path from the affiliate USD reward balance to arbitrary supported payout rails.
- The displayed minimum affiliate payout is not enforced in the withdrawal route; requests marked `affiliate` use the general balance logic.

Evidence: `index.html` script list; `assets/js/forms.js:1036`; `server/lib/settle.js:130`; `server/routes/account.js:158`; `pages/affiliate-terms.html:20`.

### 6. Finish email delivery

SMTP is currently unset, so messages are logged instead of sent. The custom SMTP client uses implicit TLS on port 465, but opens a plain socket on the default port 587 and has no STARTTLS negotiation. Use a complete SMTP transport and verify delivery, failure handling and retries.

Evidence: `server/services/mail.js:60`, `server/config.js:73`.

### 7. Escape customer content when rendering

The public review renderer concatenates review names/body into `innerHTML`, while the submission endpoint only performs length/string checks. Moderation does not make arbitrary HTML safe. Escape these fields or render them through `textContent`, and audit other customer-derived HTML rendering paths. This is a source-confirmed unsafe rendering path; no script payload was executed during this audit.

Evidence: `assets/js/exchanger.js:298`, `server/routes/public.js` review submission, `server/lib/http.js:29`.

### 8. Remove demo behavior and reconcile content

Support addresses, legal entity details, policy templates, partner labels and automated-service claims need completion. The history page still claims orders only live in browser storage although the live backend stores them in SQLite. The footer always describes sample data, even with live rates. Offline authentication/order demo behavior should be explicitly separated from production operation.

The reference's [FAQ](https://touchpay.exchange/faq/) says KYC is required for most services, while local FAQ/KYC copy says routine exchanges need no documents. Choose and implement the intended behavior; matching wording alone is insufficient.

### 9. Finish deployment and recovery

- `.claude/launch.json` still launches `python -m http.server 5173`. This cannot provide the API and bypasses the Node server's protections against serving source/database files. Use the actual Node app for preview.
- Current configuration is development mode with secure cookies disabled. Production compose overrides some values, but deployment was not performed or verified.
- Litestream still contains `CHANGE-ME-your-bucket` and uses an unpinned `latest` image. Its deployment and restore behavior need verification.
- `backup.sh` creates a KYC archive but uploads only the database archive to S3. Add offsite KYC backup and a corresponding restore procedure.
- The documented host backup command does not automatically operate on Docker's named volume; supply an explicit volume-aware procedure and required tools.
- Health always returns `ok: true` even when rate feeds are stale. Add a readiness/degraded signal if monitoring is intended to detect inability to trade.
- README, `.env.example` and DEPLOY disagree about SQLite/Postgres readiness. Reconcile documentation with the chosen deployment.
- The workspace is not currently a Git repository. Add version control and CI for repeatable releases if this is the canonical project copy.

## Verification results

| Check | Result |
|---|---|
| Unit tests | 28 passed |
| HTTP end-to-end suite | 74 passed |
| Account suite | 50 passed |
| Webhook suite | 19 passed |
| Total existing checks | **171 passed, 0 failed** |
| HTML availability | Homepage + 25 pages + admin: **27 returned HTTP 200** |
| Live price refresh after network access enabled | 5 crypto symbols and 7 fiat symbols; 20 currency rows updated; no refresh errors |
| Additional diagnostic probes | Reproduced upload-size, KYC-threshold, internal-account, mobile-confirmation, missing-amount and payout-completion gaps described above |

Initial integration runs failed because outgoing rate requests failed in the restricted environment. Fixed test prices were used to isolate the application checks; after network access was enabled, live prices refreshed successfully and all three HTTP suites passed again. The earlier connection failure is not listed as an unresolved product defect.

Passing these tests proves the covered local/manual flows, not real payments, complete security, visual equivalence or deployment readiness. No third-party account was created, live exchange submitted, real money moved or production deployment changed.

## Recommended completion order

1. Establish reference screenshots and a page/state checklist; rebuild shared header/footer, hero, assets, calculator, sliders and inner-page layouts.
2. Implement Russian translation, correct routes/navigation and working support contacts/chat.
3. Fix the confirmed backend gaps: KYC limits/enforcement, settlement callbacks, internal balances, affiliate rules and unsafe HTML rendering.
4. Complete and sandbox-test the chosen payment providers and email transport; replace demo operational data.
5. Add regression tests for the newly found gaps, browser coverage for major flows, matched mobile screenshots, and deployment/restore verification.

An exact overall completion percentage would be misleading without the reference's authenticated screens and a defined weighting of visual, functional and operational requirements. The project has broad page coverage; substantial fidelity and integration work remains.
