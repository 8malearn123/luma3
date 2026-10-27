-- ════════════════════════════════════════════════════════════════════════════
-- 0600 Physical stock counts (الجرد الفعلي).
-- A count is a draft while staff enter shelf quantities, then it is applied
-- once: the system quantity is captured at that moment, and each difference
-- becomes an 'adjustment' movement (ref_type 'stock_count'). Applied counts and
-- their lines are kept as the variance record; they are never edited.
-- ════════════════════════════════════════════════════════════════════════════

create table stock_counts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  branch_id uuid not null,
  number text not null,
  status text not null default 'draft' check (status in ('draft', 'applied', 'cancelled')),
  note text check (note is null or length(note) <= 500),
  -- Differences above this share of the system quantity are flagged (0 = any difference).
  tolerance_pct numeric(5, 2) not null default 0 check (tolerance_pct >= 0 and tolerance_pct <= 100),
  version int not null default 1,
  created_by uuid references users(id),
  applied_by uuid references users(id),
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number),
  check ((status = 'applied') = (applied_at is not null)),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id)
);
create index stock_counts_tenant_idx on stock_counts (tenant_id, created_at desc);
-- One open count per branch, so two people do not count the same shelf twice.
create unique index stock_counts_one_draft on stock_counts (tenant_id, branch_id) where status = 'draft';

create table stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  count_id uuid not null,
  inventory_item_id uuid not null,
  counted_quantity numeric(14, 3) check (counted_quantity is null or counted_quantity >= 0),
  -- Captured when the count is applied.
  system_quantity numeric(14, 3),
  variance numeric(14, 3),
  variance_cost_minor bigint,
  counted_by uuid references users(id),
  counted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (count_id, inventory_item_id),
  foreign key (tenant_id, count_id) references stock_counts(tenant_id, id),
  foreign key (tenant_id, inventory_item_id) references inventory_items(tenant_id, id)
);
create index stock_count_lines_count_idx on stock_count_lines (tenant_id, count_id);

select app.apply_conventions('{{APP_ROLE}}');
