alter table public.exchange_settings
  add column if not exists support_email text not null default 'support@dahabipay.com',
  add column if not exists support_whatsapp text;

alter table public.exchange_settings
  add constraint support_whatsapp_e164 check (support_whatsapp is null or support_whatsapp ~ '^\+[1-9][0-9]{7,14}$');
