# Dahabi Pay

Dahabi Pay is a mobile-first manual exchange-request service for one pair: **Tether USDT on TRC20 → Money Go USD**.

Customers receive a server-signed quote, provide contact and Money Go details, and create a passwordless account by verifying their email. They then review and explicitly submit the request. Returning customers sign in by email OTP at `/account/` to see their own requests. Staff use an OTP-protected operations panel to contact the customer on WhatsApp, add internal notes, and move the request through an audited workflow.

The application does not receive cryptocurrency, expose wallets or balances, or automate settlement.

## Stack

- Node.js 22 and Express on Railway
- Supabase PostgreSQL and Supabase Auth
- Custom SMTP for Supabase OTP and Nodemailer operations alerts
- Static responsive HTML, CSS, and JavaScript

## Local setup

1. Copy `.env.example` to `.env` and enter development Supabase credentials.
2. Run the migrations in `supabase/migrations/202609230001_manual_exchange.sql` and `supabase/migrations/202610160001_customer_sessions.sql` in order.
3. Create a Supabase Auth user and add the same user ID and lowercase email to `staff_profiles` with role `admin`.
4. Run `npm install`, then `npm run dev`.
5. Sign in at `/admin/`, set a positive rate and limits, and enable requests only after testing.

## Security model

The browser communicates only with Express. The Supabase secret key remains on the server and RLS is enabled on every business table. Anonymous and authenticated Supabase roles receive no table access. Quote amounts and rates are HMAC-signed for 15 minutes. Customer and staff sessions use separate hashed opaque tokens in HTTP-only, Secure, SameSite cookies. Email verification does not create an exchange request; submission is a separate customer action.

See [DEPLOY.md](DEPLOY.md) for production rollout.
