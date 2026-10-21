-- ════════════════════════════════════════════════════════════════════════════
-- 0200 Commerce operations: product versioning & return eligibility, order
--      snapshots/cancellation fields, order event history (append-only),
--      anonymous cart uniqueness, and indexes for expiry sweeps & coupons.
-- Tables themselves were created in 0005/0006; this only extends them.
-- ════════════════════════════════════════════════════════════════════════════

-- Products: optimistic concurrency + return eligibility (the "product type" that
-- decides whether a return can be requested). Snapshotted onto order items.
alter table products add column version int not null default 1;
alter table products add column returnable boolean not null default true;
create index products_tenant_status_idx on products (tenant_id, status, sort);

-- Order item snapshots beyond the product name.
alter table order_items add column variant_name_ar text;
alter table order_items add column variant_name_en text;
alter table order_items add column sku text;
alter table order_items add column returnable boolean not null default true;

-- Cancellation record on the order itself (the event history has the details).
alter table orders add column cancelled_at timestamptz;
alter table orders add column cancelled_by uuid references users(id);
alter table orders add column cancel_reason text;
alter table orders add column customer_note text check (customer_note is null or length(customer_note) <= 500);
create index orders_pending_expiry_idx on orders (expires_at) where status = 'pending_payment';
create index orders_tenant_status_idx on orders (tenant_id, status, created_at desc);

-- One open anonymous cart per (tenant, browser token).
create unique index carts_open_anon_uq on carts (tenant_id, anon_token_hash) where status = 'open' and anon_token_hash is not null;

create index stock_reservations_order_idx on stock_reservations (tenant_id, order_id);
create index coupon_redemptions_customer_idx on coupon_redemptions (tenant_id, coupon_id, tenant_customer_id) where status = 'applied';
create index returns_order_idx on returns (tenant_id, order_id);

-- Order lifecycle & fulfillment history (append-only).
create table order_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  order_id uuid not null,
  kind text not null check (kind in (
    'created', 'paid', 'payment_recorded', 'status_changed', 'cancelled', 'expired',
    'return_requested', 'return_approved', 'return_rejected')),
  from_status text,
  to_status text,
  reason text,
  data jsonb not null default '{}'::jsonb,
  actor_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, order_id) references orders(tenant_id, id)
);
create index order_events_order_idx on order_events (tenant_id, order_id, created_at);

select app.apply_conventions('{{APP_ROLE}}');
select app.make_append_only('order_events', '{{APP_ROLE}}');
