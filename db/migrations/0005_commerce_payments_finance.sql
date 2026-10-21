-- ════════════════════════════════════════════════════════════════════════════
-- 0005 Products, inventory ledger, carts, orders, payments, refunds, provider
--      events, finance journal, commissions, expenses, invoices.
--
-- Money: bigint minor units (halalas for SAR). Inventory quantities: numeric(14,3)
-- so service materials (ml, g) are exact.
-- ════════════════════════════════════════════════════════════════════════════

create table products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  category_id uuid,
  name_ar text,
  name_en text,
  description_ar text,
  description_en text,
  status text not null default 'active' check (status in ('draft', 'active', 'archived')),
  is_visible boolean not null default true,
  hide_when_out_of_stock boolean not null default false,
  max_per_order int not null default 10 check (max_per_order between 1 and 999),
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (coalesce(name_ar, name_en) is not null),
  foreign key (tenant_id, category_id) references categories(tenant_id, id)
);

create table product_images (
  tenant_id uuid not null,
  product_id uuid not null,
  asset_id uuid not null,
  sort int not null default 0,
  primary key (tenant_id, product_id, asset_id),
  foreign key (tenant_id, product_id) references products(tenant_id, id) on delete cascade,
  foreign key (tenant_id, asset_id) references assets(tenant_id, id)
);

-- Every sellable product has at least one variant (the default variant).
create table product_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  product_id uuid not null,
  name_ar text,
  name_en text,
  sku text,
  barcode text,
  price_minor bigint not null check (price_minor >= 0),
  -- Confidential cost; NULL = unknown (reports then say "costs incomplete").
  cost_minor bigint check (cost_minor is null or cost_minor >= 0),
  is_default boolean not null default false,
  is_active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, product_id) references products(tenant_id, id)
);
create unique index product_variants_sku_uq on product_variants (tenant_id, sku) where sku is not null;
create unique index product_variants_default_uq on product_variants (tenant_id, product_id) where is_default;

-- Stock-keeping items. Retail items link to a product variant; service
-- materials have no variant. "both" items are sold and consumed.
create table inventory_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  branch_id uuid not null,
  variant_id uuid,
  name text not null,
  kind text not null check (kind in ('retail', 'material', 'both')),
  unit text not null check (unit in ('piece', 'ml', 'l', 'g', 'kg')),
  on_hand numeric(14, 3) not null default 0,
  reserved numeric(14, 3) not null default 0,
  low_stock_threshold numeric(14, 3),
  cost_per_unit_minor bigint check (cost_per_unit_minor is null or cost_per_unit_minor >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  -- Database-enforced invariants: stock never negative, never over-reserved.
  check (on_hand >= 0),
  check (reserved >= 0),
  check (reserved <= on_hand),
  check (kind = 'material' or variant_id is not null),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id),
  foreign key (tenant_id, variant_id) references product_variants(tenant_id, id)
);
create unique index inventory_items_variant_uq on inventory_items (tenant_id, branch_id, variant_id) where variant_id is not null;

-- Stock ledger (append-only). on_hand/reserved on inventory_items are a cache
-- maintained in the same transaction as each movement.
create table stock_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  inventory_item_id uuid not null,
  kind text not null check (kind in ('receipt', 'reservation', 'sale', 'release', 'return', 'adjustment', 'consumption')),
  quantity numeric(14, 3) not null check (quantity <> 0),
  on_hand_after numeric(14, 3) not null,
  reserved_after numeric(14, 3) not null,
  reason text,
  ref_type text,
  ref_id uuid,
  actor_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, inventory_item_id) references inventory_items(tenant_id, id)
);
-- Exactly-once semantics for movements tied to a business event.
create unique index stock_movements_once on stock_movements (inventory_item_id, kind, ref_type, ref_id)
  where ref_id is not null and kind in ('reservation', 'sale', 'release', 'consumption', 'return');
create index stock_movements_item_idx on stock_movements (tenant_id, inventory_item_id, created_at desc);

create table service_material_recipes (
  tenant_id uuid not null,
  service_id uuid not null,
  inventory_item_id uuid not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit text not null check (unit in ('piece', 'ml', 'l', 'g', 'kg')),
  approved_by uuid references users(id),
  approved_at timestamptz,
  primary key (tenant_id, service_id, inventory_item_id),
  foreign key (tenant_id, service_id) references services(tenant_id, id),
  foreign key (tenant_id, inventory_item_id) references inventory_items(tenant_id, id)
);

create table carts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  customer_user_id uuid references users(id),
  anon_token_hash bytea,
  status text not null default 'open' check (status in ('open', 'converted', 'abandoned')),
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (customer_user_id is not null or anon_token_hash is not null)
);
create unique index carts_open_user_uq on carts (tenant_id, customer_user_id) where status = 'open' and customer_user_id is not null;

create table cart_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  cart_id uuid not null,
  variant_id uuid not null,
  quantity int not null check (quantity between 1 and 999),
  added_unit_price_minor bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cart_id, variant_id),
  foreign key (tenant_id, cart_id) references carts(tenant_id, id) on delete cascade,
  foreign key (tenant_id, variant_id) references product_variants(tenant_id, id)
);

create table coupons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  code citext not null check (length(code) between 3 and 40),
  kind text not null check (kind in ('percent', 'fixed')),
  value int not null check (value > 0),
  applies_to text not null default 'all' check (applies_to in ('all', 'services', 'products')),
  min_subtotal_minor bigint not null default 0,
  max_redemptions int,
  per_customer_limit int not null default 1,
  redemptions_count int not null default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  is_active boolean not null default true,
  source text not null default 'manual' check (source in ('manual', 'loyalty', 'campaign')),
  campaign_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code),
  check (kind <> 'percent' or value <= 10000),
  check (max_redemptions is null or redemptions_count <= max_redemptions)
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  branch_id uuid not null,
  number text not null,
  tenant_customer_id uuid not null,
  customer_user_id uuid references users(id),
  status text not null check (status in ('draft', 'pending_payment', 'paid', 'preparing', 'ready', 'collected', 'cancelled')),
  refund_status text not null default 'none' check (refund_status in ('none', 'pending', 'partial', 'full')),
  fulfillment_method text not null default 'pickup' check (fulfillment_method in ('pickup', 'with_visit')),
  booking_id uuid,
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  paid_minor bigint not null default 0,
  refunded_minor bigint not null default 0 check (refunded_minor <= paid_minor),
  currency char(3) not null default 'SAR',
  coupon_id uuid,
  payment_terms jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  stock_released_at timestamptz,
  campaign_id uuid,
  attribution jsonb,
  created_by uuid references users(id),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id),
  foreign key (tenant_id, tenant_customer_id) references tenant_customers(tenant_id, id),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id),
  foreign key (tenant_id, coupon_id) references coupons(tenant_id, id)
);
create index orders_tenant_idx on orders (tenant_id, created_at desc);
create index orders_customer_idx on orders (customer_user_id, created_at desc) where customer_user_id is not null;

alter table bookings add constraint bookings_coupon_fk foreign key (tenant_id, coupon_id) references coupons(tenant_id, id);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  product_id uuid not null,
  variant_id uuid not null,
  name_ar text,
  name_en text,
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  quantity int not null check (quantity between 1 and 999),
  line_total_minor bigint not null check (line_total_minor >= 0),
  unit_cost_minor bigint,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (order_id, variant_id),
  foreign key (tenant_id, order_id) references orders(tenant_id, id),
  foreign key (tenant_id, product_id) references products(tenant_id, id),
  foreign key (tenant_id, variant_id) references product_variants(tenant_id, id)
);

create table stock_reservations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  inventory_item_id uuid not null,
  order_id uuid not null,
  order_item_id uuid not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  status text not null default 'active' check (status in ('active', 'consumed', 'released')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_item_id),
  foreign key (tenant_id, inventory_item_id) references inventory_items(tenant_id, id),
  foreign key (tenant_id, order_id) references orders(tenant_id, id),
  foreign key (tenant_id, order_item_id) references order_items(tenant_id, id)
);

create table fulfillments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  method text not null default 'pickup' check (method in ('pickup', 'with_visit', 'delivery')),
  status text not null default 'pending' check (status in ('pending', 'preparing', 'ready', 'collected', 'cancelled')),
  ready_at timestamptz,
  collected_at timestamptz,
  collected_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, order_id),
  foreign key (tenant_id, order_id) references orders(tenant_id, id)
);

create table returns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'completed')),
  reason text not null,
  items jsonb not null,
  restock boolean not null default false,
  refund_id uuid,
  decided_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, order_id) references orders(tenant_id, id)
);

-- ── Payments ─────────────────────────────────────────────────────────────────
-- The business is the merchant of record for customer payments; each business
-- connects its own provider account. LUMA subscription billing is separate.
create table payment_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  provider text not null check (provider in ('sandbox', 'moyasar', 'tap', 'tabby', 'tamara')),
  mode text not null check (mode in ('test', 'live')),
  status text not null default 'pending' check (status in ('pending', 'active', 'disabled', 'disconnected')),
  -- Only methods verified as supported AND enabled for this account.
  enabled_methods text[] not null default '{}',
  merchant_ref text,
  -- Reference to a secret in the server-side secret store; never the secret itself.
  credentials_ref text,
  settlement_owner text not null default 'merchant' check (settlement_owner in ('merchant')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, provider, mode)
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  payment_account_id uuid,
  purpose text not null check (purpose in ('booking', 'order', 'gift_card', 'membership')),
  booking_id uuid,
  order_id uuid,
  gift_card_id uuid,
  customer_membership_id uuid,
  kind text not null check (kind in ('full', 'deposit', 'balance', 'on_site')),
  method text not null check (method in ('card', 'mada', 'apple_pay', 'tabby', 'tamara', 'cash', 'pos_terminal', 'gift_card', 'sandbox')),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  status text not null default 'pending' check (status in ('pending', 'requires_action', 'authorized', 'captured', 'failed', 'cancelled', 'expired')),
  provider text not null,
  provider_payment_id text,
  -- Set when captured money could not be applied (e.g. hold expired, slot taken).
  needs_reconciliation boolean not null default false,
  reconciliation_note text,
  idempotency_key text not null,
  collected_by uuid references users(id),
  cash_reference text,
  captured_at timestamptz,
  expires_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, idempotency_key),
  unique (provider, provider_payment_id),
  check (num_nonnulls(booking_id, order_id, gift_card_id, customer_membership_id) = 1),
  check (method not in ('cash', 'pos_terminal') or (collected_by is not null and cash_reference is not null)),
  foreign key (tenant_id, payment_account_id) references payment_accounts(tenant_id, id),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id),
  foreign key (tenant_id, order_id) references orders(tenant_id, id)
);
create index payments_booking_idx on payments (tenant_id, booking_id);
create index payments_order_idx on payments (tenant_id, order_id);

create table payment_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  payment_id uuid not null,
  provider text not null,
  status text not null check (status in ('created', 'redirected', 'succeeded', 'failed', 'cancelled')),
  provider_ref text,
  checkout_url text,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, payment_id) references payments(tenant_id, id)
);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  payment_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  -- refund_pending is not refunded; only 'succeeded' moves money back.
  status text not null default 'requested' check (status in ('requested', 'pending', 'succeeded', 'failed', 'cancelled')),
  reason text not null,
  basis jsonb not null default '{}'::jsonb,
  provider_refund_id text,
  idempotency_key text not null,
  requested_by uuid references users(id),
  requested_by_system boolean not null default false,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, payment_id) references payments(tenant_id, id)
);

-- Raw provider webhooks. Deduplicated by (provider, provider_event_id).
create table provider_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  signature_valid boolean not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed', 'needs_review')),
  error text,
  unique (provider, provider_event_id)
);

create table payouts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  payment_account_id uuid,
  provider_payout_id text,
  amount_minor bigint not null,
  fees_minor bigint not null default 0,
  currency char(3) not null,
  status text not null check (status in ('pending', 'paid', 'failed')),
  period_start date,
  period_end date,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, payment_account_id) references payment_accounts(tenant_id, id)
);

create table reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  provider text not null,
  period_start date not null,
  period_end date not null,
  status text not null check (status in ('running', 'balanced', 'discrepancies', 'failed')),
  summary jsonb not null default '{}'::jsonb,
  discrepancies jsonb not null default '[]'::jsonb,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

-- ── Finance ──────────────────────────────────────────────────────────────────
-- Double-entry journal (append-only). Every entry_group balances; corrections
-- are new offsetting groups that reference what they reverse.
create table financial_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  entry_group_id uuid not null,
  account text not null check (account in (
    'cash_on_hand', 'provider_clearing', 'customer_deposits', 'accounts_receivable',
    'service_revenue', 'product_revenue', 'gift_card_liability', 'membership_liability',
    'discounts', 'refunds', 'provider_fees', 'tax_payable', 'cogs', 'inventory', 'material_costs',
    'commissions_expense', 'commissions_payable', 'operating_expenses', 'owner_equity')),
  debit_minor bigint not null default 0 check (debit_minor >= 0),
  credit_minor bigint not null default 0 check (credit_minor >= 0),
  currency char(3) not null default 'SAR',
  ref_type text not null,
  ref_id uuid,
  reverses_group_id uuid,
  memo text,
  occurred_at timestamptz not null default now(),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check ((debit_minor = 0) <> (credit_minor = 0))
);
create index financial_entries_tenant_idx on financial_entries (tenant_id, occurred_at);
create index financial_entries_group_idx on financial_entries (entry_group_id);
create index financial_entries_ref_idx on financial_entries (tenant_id, ref_type, ref_id);

create or replace function app.check_journal_balanced() returns trigger
language plpgsql as $$
declare
  imbalance bigint;
begin
  select coalesce(sum(debit_minor), 0) - coalesce(sum(credit_minor), 0) into imbalance
  from financial_entries where entry_group_id = new.entry_group_id;
  if imbalance <> 0 then
    raise exception 'journal entry group % is unbalanced by %', new.entry_group_id, imbalance using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger financial_entries_balanced after insert on financial_entries
  deferrable initially deferred for each row execute function app.check_journal_balanced();

create table expenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  branch_id uuid,
  category text not null check (category in ('rent', 'salaries', 'supplies', 'marketing', 'utilities', 'equipment', 'fees', 'other')),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null default 'SAR',
  incurred_on date not null,
  description text,
  receipt_asset_id uuid,
  recorded_by uuid references users(id),
  voided_at timestamptz,
  voided_by uuid references users(id),
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (voided_at is null or void_reason is not null),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id),
  foreign key (tenant_id, receipt_asset_id) references assets(tenant_id, id)
);

create table commission_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  staff_id uuid,
  service_id uuid,
  kind text not null check (kind in ('percent', 'fixed')),
  rate_bp int check (rate_bp between 0 and 10000),
  amount_minor bigint check (amount_minor >= 0),
  effective_from date not null default current_date,
  effective_to date,
  is_active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'percent' and rate_bp is not null) or (kind = 'fixed' and amount_minor is not null)),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  foreign key (tenant_id, service_id) references services(tenant_id, id)
);

create table commission_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  staff_id uuid not null,
  booking_item_id uuid not null,
  kind text not null check (kind in ('earned', 'reversal', 'adjustment')),
  base_minor bigint not null,
  amount_minor bigint not null,
  rule_snapshot jsonb not null,
  reason text,
  reverses_entry_id uuid references commission_entries(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  foreign key (tenant_id, booking_item_id) references booking_items(tenant_id, id)
);
create unique index commission_entries_earned_once on commission_entries (booking_item_id) where kind = 'earned';

create table invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  number text not null,
  kind text not null check (kind in ('receipt', 'invoice', 'credit_note')),
  booking_id uuid,
  order_id uuid,
  payment_id uuid,
  refund_id uuid,
  seller_snapshot jsonb not null,
  buyer_snapshot jsonb not null,
  subtotal_minor bigint not null,
  discount_minor bigint not null default 0,
  tax_minor bigint not null default 0,
  total_minor bigint not null,
  currency char(3) not null,
  tax_basis jsonb not null default '{}'::jsonb,
  issued_at timestamptz not null default now(),
  created_by uuid references users(id),
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id),
  foreign key (tenant_id, order_id) references orders(tenant_id, id),
  foreign key (tenant_id, payment_id) references payments(tenant_id, id)
);

create table invoice_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  invoice_id uuid not null,
  description text not null,
  quantity numeric(14, 3) not null,
  unit_price_minor bigint not null,
  tax_minor bigint not null default 0,
  line_total_minor bigint not null,
  foreign key (tenant_id, invoice_id) references invoices(tenant_id, id)
);

-- Customer's own orders across businesses (central account view).
create or replace function app.customer_orders(p_user uuid, p_limit int)
returns table (id uuid, tenant_id uuid, tenant_slug text, tenant_name text, number text, status text, refund_status text,
               total_minor bigint, currency char(3), created_at timestamptz, items jsonb)
language sql stable security definer set search_path = public as $$
  select o.id, o.tenant_id, t.slug::text, t.name, o.number, o.status, o.refund_status, o.total_minor, o.currency, o.created_at,
         coalesce((select jsonb_agg(jsonb_build_object('name_ar', i.name_ar, 'name_en', i.name_en, 'quantity', i.quantity,
                   'line_total_minor', i.line_total_minor)) from order_items i where i.order_id = o.id), '[]'::jsonb)
  from orders o join tenants t on t.id = o.tenant_id
  where o.customer_user_id = p_user and o.status <> 'draft'
  order by o.created_at desc
  limit least(p_limit, 100)
$$;

select app.apply_conventions('{{APP_ROLE}}');
select app.make_append_only('stock_movements', '{{APP_ROLE}}');
select app.make_append_only('financial_entries', '{{APP_ROLE}}');
select app.make_append_only('commission_entries', '{{APP_ROLE}}');
select app.make_append_only('invoices', '{{APP_ROLE}}');
select app.make_append_only('invoice_items', '{{APP_ROLE}}');
grant execute on function app.customer_orders(uuid, int) to {{APP_ROLE}};
