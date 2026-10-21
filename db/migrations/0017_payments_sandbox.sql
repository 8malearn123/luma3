-- 0017 LUMA Sandbox payment provider (SIMULATION — no real money).
-- This table plays the role of the external provider's own records so that
-- reconciliation compares "provider truth" with LUMA's payments, as it would
-- with a real provider. It is never used for live accounts.
create table sandbox_provider_payments (
  id text primary key,                         -- provider payment id (sbx_…)
  account_ref text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  status text not null check (status in ('initiated', 'captured', 'failed', 'cancelled')),
  refunded_minor bigint not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table sandbox_provider_refunds (
  id text primary key,
  payment_id text not null references sandbox_provider_payments(id),
  amount_minor bigint not null check (amount_minor > 0),
  status text not null check (status in ('pending', 'succeeded', 'failed')),
  created_at timestamptz not null default now()
);

-- Webhook intake resolves the tenant from the provider payment id before a
-- tenant scope exists.
create or replace function app.payment_by_provider_ref(p_provider text, p_ref text)
returns table (id uuid, tenant_id uuid)
language sql stable security definer set search_path = public as $$
  select p.id, p.tenant_id from payments p where p.provider = p_provider and p.provider_payment_id = p_ref
$$;
create or replace function app.refund_by_provider_ref(p_ref text)
returns table (id uuid, tenant_id uuid)
language sql stable security definer set search_path = public as $$
  select r.id, r.tenant_id from refunds r where r.provider_refund_id = p_ref
$$;
grant execute on function app.payment_by_provider_ref(text, text) to {{APP_ROLE}};
grant execute on function app.refund_by_provider_ref(text) to {{APP_ROLE}};

alter table payments add column checkout_url text;
alter table payments add column payer_user_id uuid references users(id);

select app.apply_conventions('{{APP_ROLE}}');
