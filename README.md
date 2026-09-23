# Dahabi Pay

Dahabi Pay is a mobile-first manual exchange-request service for one pair: **Tether USDT on TRC20 → Money Go USD**.

Customers receive a server-signed quote, submit contact and Money Go details, and verify a six-digit email OTP. Only then is the request recorded. Staff use an OTP-protected operations panel to contact the customer on WhatsApp, add internal notes, and move the request through an audited workflow.

The application does not receive cryptocurrency, expose wallets or balances, or automate settlement.

## Stack

- Node.js 22 and Express on Railway
- Supabase PostgreSQL and Supabase Auth
- Custom SMTP for Supabase OTP and Nodemailer operations alerts
- Static responsive HTML, CSS, and JavaScript

## Local setup

1. Copy `.env.example` to `.env` and enter development Supabase credentials.
2. Run the migration in `supabase/migrations/202609230001_manual_exchange.sql`.
3. Create a Supabase Auth user and add the same user ID and lowercase email to `staff_profiles` with role `admin`.
4. Run `npm install`, then `npm run dev`.
5. Sign in at `/admin/`, set a positive rate and limits, and enable requests only after testing.

## Security model

The browser communicates only with Express. The Supabase secret key remains on the server and RLS is enabled on every business table. Anonymous and authenticated Supabase roles receive no table access. Quote amounts and rates are HMAC-signed for 15 minutes. Staff sessions use hashed opaque tokens in HTTP-only, Secure, SameSite cookies.

See [DEPLOY.md](DEPLOY.md) for production rollout.
