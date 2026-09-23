-- Dahabi Pay manual USDT TRC20 -> Money Go USD request workflow.
-- Additive migration: it does not inspect or modify any existing application tables.

create extension if not exists pgcrypto;

create table if not exists public.staff_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique check (email = lower(email)),
  display_name text not null check (char_length(display_name) between 2 and 120),
  role text not null check (role in ('admin', 'operator')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.staff_sessions (
  token_hash text primary key,
  staff_user_id uuid not null references public.staff_profiles(user_id) on delete cascade,
  expires_at timestamptz not null,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists staff_sessions_expiry_idx on public.staff_sessions(expires_at);

create table if not exists public.exchange_settings (
  id smallint primary key default 1 check (id = 1),
  rate numeric(28,8),
  min_usdt numeric(28,6),
  max_usdt numeric(28,6),
  accepting_requests boolean not null default false,
  operations_email text,
  whatsapp_template text not null default 'Hello {{name}}, this is Dahabi Pay regarding request {{reference}} for {{send}} USDT.',
  updated_by uuid references public.staff_profiles(user_id) on delete set null,
  updated_at timestamptz not null default now(),
  check (rate is null or rate > 0),
  check (min_usdt is null or min_usdt > 0),
  check (max_usdt is null or max_usdt > 0),
  check (min_usdt is null or max_usdt is null or min_usdt <= max_usdt)
);
insert into public.exchange_settings(id, accepting_requests) values (1, false)
on conflict (id) do nothing;

create table if not exists public.exchange_requests (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  quote_jti uuid not null unique,
  customer_auth_id uuid references auth.users(id) on delete set null,
  full_name text not null,
  email text not null,
  whatsapp text not null,
  moneygo_account text not null,
  send_usdt numeric(28,6) not null check (send_usdt > 0),
  rate numeric(28,8) not null check (rate > 0),
  receive_usd numeric(28,2) not null check (receive_usd > 0),
  status text not null default 'verified' check (status in ('verified','contacted','in_progress','completed','cancelled')),
  customer_note text,
  assigned_staff_id uuid references public.staff_profiles(user_id) on delete set null,
  source_ip text,
  user_agent text,
  verified_at timestamptz not null default now(),
  contacted_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists exchange_requests_status_created_idx on public.exchange_requests(status, created_at desc);
create index if not exists exchange_requests_email_idx on public.exchange_requests(lower(email));
create index if not exists exchange_requests_whatsapp_idx on public.exchange_requests(whatsapp);

create table if not exists public.request_notes (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.exchange_requests(id) on delete cascade,
  staff_user_id uuid not null references public.staff_profiles(user_id),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists request_notes_request_idx on public.request_notes(request_id, created_at);

create table if not exists public.request_events (
  id bigint generated always as identity primary key,
  request_id uuid references public.exchange_requests(id) on delete cascade,
  actor_staff_id uuid references public.staff_profiles(user_id) on delete set null,
  event_type text not null,
  from_status text,
  to_status text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists request_events_request_idx on public.request_events(request_id, created_at);

create table if not exists public.notification_outbox (
  id bigint generated always as identity primary key,
  request_id uuid references public.exchange_requests(id) on delete cascade,
  kind text not null default 'new_request',
  recipient text not null,
  payload jsonb not null,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notification_outbox_pending_idx
  on public.notification_outbox(next_attempt_at) where delivered_at is null;

alter table public.staff_profiles enable row level security;
alter table public.staff_sessions enable row level security;
alter table public.exchange_settings enable row level security;
alter table public.exchange_requests enable row level security;
alter table public.request_notes enable row level security;
alter table public.request_events enable row level security;
alter table public.notification_outbox enable row level security;

revoke all on public.staff_profiles, public.staff_sessions, public.exchange_settings,
  public.exchange_requests, public.request_notes, public.request_events,
  public.notification_outbox from anon, authenticated;

create or replace function public.create_exchange_request(
  p_reference text, p_quote_jti uuid, p_customer_auth_id uuid,
  p_full_name text, p_email text, p_whatsapp text, p_moneygo_account text,
  p_send_usdt numeric, p_rate numeric, p_receive_usd numeric,
  p_customer_note text, p_source_ip text, p_user_agent text
) returns public.exchange_requests
language plpgsql security definer set search_path = public
as $$
declare
  created public.exchange_requests;
  ops_email text;
begin
  insert into exchange_requests(
    reference, quote_jti, customer_auth_id, full_name, email, whatsapp,
    moneygo_account, send_usdt, rate, receive_usd, customer_note,
    source_ip, user_agent
  ) values (
    p_reference, p_quote_jti, p_customer_auth_id, p_full_name, lower(p_email),
    p_whatsapp, p_moneygo_account, p_send_usdt, p_rate, p_receive_usd,
    nullif(p_customer_note, ''), p_source_ip, p_user_agent
  ) returning * into created;

  insert into request_events(request_id, event_type, to_status, detail)
  values (created.id, 'request.verified', 'verified', jsonb_build_object('reference', created.reference));

  select operations_email into ops_email from exchange_settings where id = 1;
  if coalesce(ops_email, '') <> '' then
    insert into notification_outbox(request_id, recipient, payload)
    values (created.id, ops_email, jsonb_build_object(
      'reference', created.reference, 'fullName', created.full_name,
      'sendUsdt', created.send_usdt, 'receiveUsd', created.receive_usd
    ));
  end if;
  return created;
end;
$$;

create or replace function public.transition_exchange_request(
  p_request_id uuid, p_staff_user_id uuid, p_next_status text, p_reason text default null
) returns public.exchange_requests
language plpgsql security definer set search_path = public
as $$
declare
  current_row public.exchange_requests;
  old_status text;
  staff_role text;
  allowed boolean := false;
begin
  select role into staff_role from staff_profiles
    where user_id = p_staff_user_id and active = true;
  if staff_role is null then raise exception 'staff access denied'; end if;

  select * into current_row from exchange_requests where id = p_request_id for update;
  if not found then raise exception 'request not found'; end if;

  allowed := (current_row.status = 'verified' and p_next_status in ('contacted','cancelled'))
    or (current_row.status = 'contacted' and p_next_status in ('in_progress','cancelled'))
    or (current_row.status = 'in_progress' and p_next_status in ('completed','cancelled'));
  if not allowed and staff_role = 'admin' and current_row.status in ('completed','cancelled')
      and p_next_status = 'contacted' and char_length(trim(coalesce(p_reason,''))) >= 5 then
    allowed := true;
  end if;
  if not allowed then raise exception 'invalid status transition'; end if;

  old_status := current_row.status;

  update exchange_requests set
    status = p_next_status,
    assigned_staff_id = coalesce(assigned_staff_id, p_staff_user_id),
    contacted_at = case when p_next_status = 'contacted' then now() else contacted_at end,
    completed_at = case when p_next_status = 'completed' then now() else completed_at end,
    cancelled_at = case when p_next_status = 'cancelled' then now() else cancelled_at end,
    updated_at = now()
  where id = p_request_id returning * into current_row;

  insert into request_events(request_id, actor_staff_id, event_type, from_status, to_status, detail)
  values (p_request_id, p_staff_user_id, 'request.status_changed',
    old_status, p_next_status,
    jsonb_build_object('reason', nullif(trim(coalesce(p_reason,'')), '')));
  return current_row;
end;
$$;

create or replace function public.add_request_note(
  p_request_id uuid, p_staff_user_id uuid, p_body text
) returns public.request_notes
language plpgsql security definer set search_path = public
as $$
declare created public.request_notes;
begin
  if not exists(select 1 from staff_profiles where user_id = p_staff_user_id and active = true) then
    raise exception 'staff access denied';
  end if;
  insert into request_notes(request_id, staff_user_id, body)
  values (p_request_id, p_staff_user_id, trim(p_body)) returning * into created;
  insert into request_events(request_id, actor_staff_id, event_type)
  values (p_request_id, p_staff_user_id, 'request.note_added');
  return created;
end;
$$;

revoke all on function public.create_exchange_request(text,uuid,uuid,text,text,text,text,numeric,numeric,numeric,text,text,text) from public, anon, authenticated;
revoke all on function public.transition_exchange_request(uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.add_request_note(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.create_exchange_request(text,uuid,uuid,text,text,text,text,numeric,numeric,numeric,text,text,text) to service_role;
grant execute on function public.transition_exchange_request(uuid,uuid,text,text) to service_role;
grant execute on function public.add_request_note(uuid,uuid,text) to service_role;
