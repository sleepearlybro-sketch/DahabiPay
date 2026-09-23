# Production rollout

## 1. Configure Supabase

1. Open the intended Supabase production project.
2. Run `supabase/migrations/202609230001_manual_exchange.sql` in the SQL editor.
3. In Auth email templates, change the magic-link template to show the six-digit `{{ .Token }}`.
4. Configure a production custom SMTP provider in Supabase Auth.
5. Create the first staff user in Supabase Auth.
6. Insert its Auth UUID, lowercase email, display name, `admin` role, and `active = true` into `staff_profiles`.

Example:

```sql
insert into public.staff_profiles(user_id,email,display_name,role,active)
values ('AUTH-USER-UUID','admin@example.com','Administrator','admin',true);
```

## 2. Configure Railway

Set these variables on the **Dahabi Pay application service**, not on the Supabase project:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`
- `QUOTE_SIGNING_SECRET` (32 or more random bytes)
- `PUBLIC_ORIGIN` (the final HTTPS origin)
- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `COOKIE_SECURE=1`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`

Do not reuse or expose the old Railway PostgreSQL password. The new application has no `DATABASE_URL` dependency.

## 3. Controlled acceptance

1. Leave `exchange_settings.accepting_requests=false`.
2. Deploy the GitHub `main` branch and confirm `/api/health` reports Supabase PostgreSQL.
3. Sign in to `/admin/`, set the final rate, minimum, maximum, operations email, and WhatsApp template.
4. Keep requests disabled while testing both customer OTP and staff OTP with team-controlled addresses.
5. Temporarily enable requests and submit one controlled request.
6. Confirm the admin email, dashboard record, WhatsApp link, internal note, status history, completion, and SSE/polling refresh.
7. Enable public requests after acceptance.

Keep the old Railway PostgreSQL service and `/data` volume read-only for seven days. Export them, verify no new application dependency exists, then remove both.
