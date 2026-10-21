-- 0020 One receipt per payment and one invoice per booking/order (documents are
-- immutable; corrections use credit notes).
create unique index invoices_receipt_per_payment on invoices (tenant_id, payment_id) where kind = 'receipt';
create unique index invoices_invoice_per_booking on invoices (tenant_id, booking_id) where kind = 'invoice' and booking_id is not null;
create unique index invoices_invoice_per_order on invoices (tenant_id, order_id) where kind = 'invoice' and order_id is not null;

create table finance_exports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('bookings', 'payments', 'journal', 'expenses')),
  period_start date not null,
  period_end date not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  asset_id uuid,
  row_count int,
  requested_by uuid references users(id),
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (tenant_id, asset_id) references assets(tenant_id, id)
);
select app.apply_conventions('{{APP_ROLE}}');
