-- Remediation (shop workstream): payment paths for product orders and
-- marketplace commission reversals.

-- ── Orders: how the customer will pay (owner decision R2, 2026-11-17) ───────
-- 'online'  : full online payment through the business's connected provider.
-- 'on_site' : pay at pickup (cash / terminal) — only when the business enabled
--             pay-on-site. Stock is still reserved until the order expires.
alter table orders add column if not exists payment_choice text not null default 'online'
  check (payment_choice in ('online', 'on_site'));
-- The customer can switch a pending order to pay at pickup (e.g. online payment became unavailable).
alter table order_events drop constraint if exists order_events_kind_check;
alter table order_events add constraint order_events_kind_check check (kind in (
  'created', 'paid', 'payment_recorded', 'status_changed', 'cancelled', 'expired', 'return_requested', 'return_approved', 'return_rejected',
  'payment_choice_changed'));

-- ── Marketplace commission reversals (owner decision R1, 2026-11-17) ────────
-- A refund that succeeds after a marketplace booking completed reverses the
-- LUMA commission proportionally. Append-only; one row per refund; the sum of
-- reversals never exceeds the original line's fee (enforced in code under the
-- booking row lock and re-checked here per row).
create table if not exists marketplace_commission_reversals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  commission_id uuid not null references marketplace_commissions(id),
  booking_id uuid not null,
  refund_id uuid not null,
  refund_minor bigint not null check (refund_minor > 0),
  -- Cumulative refunds after completion, including this one (the fee formula caps it at the line's base).
  cumulative_refund_minor bigint not null check (cumulative_refund_minor >= refund_minor),
  fee_reversed_minor bigint not null check (fee_reversed_minor >= 0),
  currency char(3) not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, refund_id),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id)
);
create index if not exists marketplace_commission_reversals_period_idx on marketplace_commission_reversals (tenant_id, created_at);
create index if not exists marketplace_commission_reversals_line_idx on marketplace_commission_reversals (commission_id);

select app.apply_conventions('{{APP_ROLE}}');
select app.make_append_only('marketplace_commission_reversals', '{{APP_ROLE}}');
