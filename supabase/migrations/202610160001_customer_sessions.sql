-- Passwordless customer accounts are Supabase Auth users. Only the Express
-- server can issue and read these opaque, revocable browser sessions.
create table if not exists public.customer_sessions (
  token_hash text primary key,
  customer_auth_id uuid not null references auth.users(id) on delete cascade,
  email text not null check (email = lower(email)),
  expires_at timestamptz not null,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists customer_sessions_expiry_idx
  on public.customer_sessions(expires_at);
create index if not exists customer_sessions_user_idx
  on public.customer_sessions(customer_auth_id);
create index if not exists exchange_requests_customer_created_idx
  on public.exchange_requests(customer_auth_id, created_at desc);

alter table public.customer_sessions enable row level security;
revoke all on public.customer_sessions from anon, authenticated;
