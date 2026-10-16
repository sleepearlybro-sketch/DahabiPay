-- Existing staff set their own username/password after an OTP-only bootstrap login.
alter table public.staff_profiles
  add column if not exists username text,
  add column if not exists password_enabled boolean not null default false;

alter table public.staff_profiles
  add constraint staff_username_format check (username is null or username ~ '^[a-z][a-z0-9_]{2,31}$');
create unique index if not exists staff_profiles_username_unique on public.staff_profiles (lower(username));
