-- Run once in the Supabase SQL editor before enabling payments.
create table if not exists public.payment_orders (
 id text primary key,
 provider text not null check (provider in ('xpag','stripe')),
 provider_id text,
 payment_method text not null check (payment_method in ('spei','card','oxxo')),
 amount_cents integer not null check (amount_cents > 0),
 currency text not null check (currency = 'MXN'),
 status text not null default 'creating',
 email text not null,
 guardian_name text not null,
 phone text not null,
 checkout_mode text not null check (checkout_mode in ('main','upsell')),
 quiz_data jsonb not null default '{}'::jsonb,
 payment_data jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 paid_at timestamptz
);
create unique index if not exists payment_orders_provider_id on public.payment_orders(provider,provider_id) where provider_id is not null;
alter table public.payment_orders enable row level security;
revoke all on public.payment_orders from anon, authenticated;
grant all on public.payment_orders to service_role;
