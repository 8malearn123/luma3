-- ════════════════════════════════════════════════════════════════════════════
-- 0800 Multi-location inventory, purchasing and the inventory ↔ accounting link.
-- Binding decisions: docs/HOSTING_INVENTORY_DECISIONS.md (D4, D5, D15).
--
--  • stock_locations: where stock physically is (main warehouse, branch store,
--    chair station, staff custody, quarantine). A chair (resources row) is a
--    bookable thing; its stock lives in a station location linked through
--    stock_location_resources. Stock belongs to the location, never to a person.
--  • inventory_items stays the item card (one row per branch, ids unchanged);
--    on_hand/reserved remain the branch total cache, stock_balances hold the
--    per-location split. Both are written in the same transaction (moveStock).
--  • D15 weighted average cost: inventory_items.stock_value_minor is the value
--    of everything the item holds; avg = value ÷ quantity. Every movement
--    stores its unit and total cost at that moment and is never edited.
--  • Purchasing: receipts (goods), supplier invoices (money) and payments are
--    separate documents; linking an invoice to a receipt never moves stock.
--
-- This is an operational ledger for a salon, not a full accounting system:
-- there is no inventory period close, no landed-cost allocation and no
-- multi-currency purchasing.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Settings ────────────────────────────────────────────────────────────────
create table inventory_settings (
  tenant_id uuid primary key references tenants(id),
  -- D4: immediate (default) or confirm_receipt (quantity is "in transit" and
  -- available in neither location until the destination confirms).
  transfer_confirmation text not null default 'immediate' check (transfer_confirmation in ('immediate', 'confirm_receipt')),
  -- Days before expiry that a tracked batch is reported as near expiry.
  expiry_warning_days int not null default 30 check (expiry_warning_days between 1 and 365),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Locations ───────────────────────────────────────────────────────────────
create table stock_locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  branch_id uuid not null,
  kind text not null check (kind in ('main', 'branch', 'station', 'custody', 'quarantine')),
  name text not null check (length(name) between 1 and 120),
  code text check (code is null or code ~ '^[A-Za-z0-9_-]{1,32}$'),
  -- custody: the staff member holding the stock (the location still owns it).
  staff_id uuid,
  -- The branch's default location: reservations, sales and legacy callers use it.
  is_default boolean not null default false,
  is_active boolean not null default true,
  sort int not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (kind <> 'custody' or staff_id is not null),
  check (not is_default or kind in ('main', 'branch')),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);
create unique index stock_locations_default_uq on stock_locations (tenant_id, branch_id) where is_default;
create unique index stock_locations_main_uq on stock_locations (tenant_id) where kind = 'main';
create unique index stock_locations_code_uq on stock_locations (tenant_id, lower(code)) where code is not null;
create index stock_locations_branch_idx on stock_locations (tenant_id, branch_id, sort);

-- A station serves one or more chairs; a chair is served by at most one station.
create table stock_location_resources (
  tenant_id uuid not null,
  resource_id uuid not null,
  location_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, resource_id),
  foreign key (tenant_id, resource_id) references resources(tenant_id, id),
  foreign key (tenant_id, location_id) references stock_locations(tenant_id, id)
);
create index stock_location_resources_loc_idx on stock_location_resources (tenant_id, location_id);

-- Default location per branch: the first branch of a business is its main
-- warehouse, later branches get a branch store. Runs for existing branches
-- below and for every new branch (whatever code path creates it).
create or replace function app.ensure_default_stock_location(p_tenant uuid, p_branch uuid, p_branch_name text) returns uuid
language plpgsql as $$
declare
  loc uuid;
  has_main boolean;
begin
  select id into loc from stock_locations where tenant_id = p_tenant and branch_id = p_branch and is_default;
  if loc is not null then return loc; end if;
  select exists (select 1 from stock_locations where tenant_id = p_tenant and kind = 'main') into has_main;
  insert into stock_locations (tenant_id, branch_id, kind, name, code, is_default, sort)
  values (p_tenant, p_branch, case when has_main then 'branch' else 'main' end,
          case when has_main then 'مخزن ' || p_branch_name else 'المستودع الرئيسي' end,
          case when has_main then null else 'MAIN' end, true, 0)
  returning id into loc;
  return loc;
end $$;

create or replace function app.branch_default_stock_location() returns trigger
language plpgsql as $$
begin
  perform app.ensure_default_stock_location(new.tenant_id, new.id, new.name);
  return new;
end $$;
create trigger branch_default_stock_location after insert on branches
  for each row execute function app.branch_default_stock_location();

select app.ensure_default_stock_location(b.tenant_id, b.id, b.name)
from (select tenant_id, id, name from branches order by tenant_id, is_primary desc, created_at, id) b;

-- ── Suppliers (referenced by the item card) ─────────────────────────────────
create table suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (length(name) between 1 and 160),
  contact_name text check (contact_name is null or length(contact_name) <= 120),
  phone text check (phone is null or length(phone) <= 40),
  email text check (email is null or length(email) <= 200),
  tax_number text check (tax_number is null or length(tax_number) <= 40),
  payment_terms_days int check (payment_terms_days is null or payment_terms_days between 0 and 365),
  notes text check (notes is null or length(notes) <= 1000),
  is_active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create unique index suppliers_name_uq on suppliers (tenant_id, lower(name));

-- ── Item card ───────────────────────────────────────────────────────────────
-- `unit` stays the base (usage) unit in which every quantity is stored.
-- storage_unit/conversion_factor: e.g. 1 bottle = 500 ml (approved by a manager).
alter table inventory_items
  add column code text check (code is null or length(code) between 1 and 40),
  add column barcode text check (barcode is null or length(barcode) between 1 and 64),
  add column category text check (category is null or length(category) <= 80),
  add column description text check (description is null or length(description) <= 1000),
  add column image_asset_id uuid references assets(id),
  add column storage_unit text check (storage_unit is null or length(storage_unit) between 1 and 24),
  add column conversion_factor numeric(14, 3) check (conversion_factor is null or conversion_factor > 0),
  add column conversion_approved_by uuid references users(id),
  add column conversion_approved_at timestamptz,
  -- Reusable tool (dryer, brush): counted, never consumed by services.
  add column is_tool boolean not null default false,
  -- D15: weighted average cost per base unit (NULL = not known yet) and the
  -- value of the quantity the item holds (on_hand, all locations).
  add column avg_cost_minor numeric(18, 4) check (avg_cost_minor is null or avg_cost_minor >= 0),
  add column stock_value_minor bigint not null default 0 check (stock_value_minor >= 0),
  -- Optional charge price to hosted freelancers (D5b uses store price + listing discount).
  add column freelancer_price_minor bigint check (freelancer_price_minor is null or freelancer_price_minor >= 0),
  add column supplier_id uuid,
  add column track_batches boolean not null default false,
  add column track_expiry boolean not null default false,
  add column archived_at timestamptz,
  -- The same item card across branches (inter-branch transfers map onto it).
  add column master_id uuid,
  add constraint inventory_items_supplier_fk foreign key (tenant_id, supplier_id) references suppliers(tenant_id, id),
  add constraint inventory_items_tool_check check (not is_tool or kind = 'material'),
  add constraint inventory_items_expiry_check check (not track_expiry or track_batches);
update inventory_items set master_id = id,
  avg_cost_minor = cost_per_unit_minor,
  stock_value_minor = case when cost_per_unit_minor is null then 0 else round(on_hand * cost_per_unit_minor)::bigint end;
-- Stock already on hand with a known manual cost becomes the opening inventory
-- value in the journal (Dr inventory / Cr owner_equity), so the ledger and the
-- item values agree from day one.
with v as (
  select tenant_id, id, name, stock_value_minor, gen_random_uuid() as g from inventory_items where stock_value_minor > 0
)
insert into financial_entries (tenant_id, entry_group_id, account, debit_minor, credit_minor, ref_type, ref_id, memo)
select tenant_id, g, 'inventory', stock_value_minor, 0, 'inventory_valuation', id, 'opening valuation: ' || name from v
union all
select tenant_id, g, 'owner_equity', 0, stock_value_minor, 'inventory_valuation', id, 'opening valuation: ' || name from v;
-- Check the deferred balance constraint now (financial_entries is altered below).
set constraints all immediate;
-- Filled on insert (NULL → the item's own id), so it is never NULL in practice.
create or replace function app.inventory_item_master() returns trigger
language plpgsql as $$
begin
  new.master_id := coalesce(new.master_id, new.id);
  return new;
end $$;
create trigger inventory_item_master before insert on inventory_items
  for each row execute function app.inventory_item_master();
create index inventory_items_master_idx on inventory_items (tenant_id, master_id);
create unique index inventory_items_code_uq on inventory_items (tenant_id, branch_id, lower(code)) where code is not null;

-- ── Per-location balances ───────────────────────────────────────────────────
create table stock_balances (
  tenant_id uuid not null,
  inventory_item_id uuid not null,
  location_id uuid not null,
  on_hand numeric(14, 3) not null default 0,
  reserved numeric(14, 3) not null default 0,
  -- Confirm-receipt transfers on their way TO this location (not available).
  in_transit numeric(14, 3) not null default 0,
  reorder_level numeric(14, 3) check (reorder_level is null or reorder_level >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, inventory_item_id, location_id),
  check (on_hand >= 0),
  check (reserved >= 0),
  check (in_transit >= 0),
  check (reserved <= on_hand),
  foreign key (tenant_id, inventory_item_id) references inventory_items(tenant_id, id),
  foreign key (tenant_id, location_id) references stock_locations(tenant_id, id)
);
create index stock_balances_location_idx on stock_balances (tenant_id, location_id);

-- A balance's location must be in the item's branch (inter-branch stock is a
-- transfer to the counterpart item card of the other branch).
create or replace function app.stock_balance_same_branch() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from inventory_items i join stock_locations l on l.tenant_id = i.tenant_id and l.branch_id = i.branch_id
    where i.id = new.inventory_item_id and l.id = new.location_id and i.tenant_id = new.tenant_id
  ) then
    raise exception 'stock location is not in the item''s branch' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger stock_balance_same_branch before insert on stock_balances
  for each row execute function app.stock_balance_same_branch();

insert into stock_balances (tenant_id, inventory_item_id, location_id, on_hand, reserved, reorder_level)
select i.tenant_id, i.id, l.id, i.on_hand, i.reserved, i.low_stock_threshold
from inventory_items i join stock_locations l on l.tenant_id = i.tenant_id and l.branch_id = i.branch_id and l.is_default;

-- ── Batches (only when the item tracks them) ────────────────────────────────
create table stock_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  inventory_item_id uuid not null,
  batch_no text not null check (length(batch_no) between 1 and 60),
  expiry_date date,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, inventory_item_id, batch_no),
  foreign key (tenant_id, inventory_item_id) references inventory_items(tenant_id, id)
);
create table stock_batch_balances (
  tenant_id uuid not null,
  batch_id uuid not null,
  location_id uuid not null,
  quantity numeric(14, 3) not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, batch_id, location_id),
  foreign key (tenant_id, batch_id) references stock_batches(tenant_id, id),
  foreign key (tenant_id, location_id) references stock_locations(tenant_id, id)
);

-- ── Movements: location, unit, frozen cost, document, reversal ──────────────
alter table stock_movements drop constraint stock_movements_kind_check;
alter table stock_movements add constraint stock_movements_kind_check check (kind in (
  'receipt', 'reservation', 'sale', 'release', 'return', 'adjustment', 'consumption',
  'opening', 'transfer_out', 'transfer_in', 'transfer_dispatch', 'transfer_receive',
  'return_from_use', 'return_to_supplier', 'waste', 'count_adjustment', 'correction'));
alter table stock_movements
  add column location_id uuid,
  add column counter_location_id uuid,
  add column location_on_hand_after numeric(14, 3),
  add column unit text check (unit is null or unit in ('piece', 'ml', 'l', 'g', 'kg')),
  -- Cost per base unit at the moment of the movement (NULL = cost unknown).
  add column unit_cost_minor numeric(18, 4) check (unit_cost_minor is null or unit_cost_minor >= 0),
  -- Signed like quantity: positive adds value, negative removes it.
  add column total_cost_minor bigint,
  add column batch_id uuid,
  add column document_type text,
  add column document_id uuid,
  add column reversal_of uuid references stock_movements(id),
  add column performer_staff_id uuid,
  add constraint stock_movements_location_fk foreign key (tenant_id, location_id) references stock_locations(tenant_id, id),
  add constraint stock_movements_counter_location_fk foreign key (tenant_id, counter_location_id) references stock_locations(tenant_id, id),
  add constraint stock_movements_batch_fk foreign key (tenant_id, batch_id) references stock_batches(tenant_id, id),
  add constraint stock_movements_performer_fk foreign key (tenant_id, performer_staff_id) references staff_profiles(tenant_id, id),
  add constraint stock_movements_waste_reason check (kind <> 'waste' or (reason is not null and length(reason) >= 3));
-- History before locations existed happened in the branch's default location.
alter table stock_movements disable trigger append_only;
update stock_movements m set location_id = l.id, unit = i.unit
from inventory_items i join stock_locations l on l.tenant_id = i.tenant_id and l.branch_id = i.branch_id and l.is_default
where i.id = m.inventory_item_id;
alter table stock_movements enable trigger append_only;
create index stock_movements_location_idx on stock_movements (tenant_id, location_id, created_at desc);
create index stock_movements_document_idx on stock_movements (tenant_id, document_type, document_id);
-- A movement is reversed at most once.
create unique index stock_movements_reversal_uq on stock_movements (reversal_of) where reversal_of is not null;
-- Exactly-once for every movement tied to a business event (manual adjustments excepted).
drop index stock_movements_once;
create unique index stock_movements_once on stock_movements (inventory_item_id, kind, ref_type, ref_id)
  where ref_id is not null and kind <> 'adjustment';

-- Batch split of a movement (FEFO issues can draw on several batches).
create table stock_movement_batches (
  tenant_id uuid not null,
  movement_id uuid not null references stock_movements(id),
  batch_id uuid not null,
  quantity numeric(14, 3) not null check (quantity <> 0),
  primary key (movement_id, batch_id),
  foreign key (tenant_id, batch_id) references stock_batches(tenant_id, id)
);

-- ── Counts are per location ─────────────────────────────────────────────────
alter table stock_counts add column location_id uuid;
update stock_counts c set location_id = l.id from stock_locations l where l.tenant_id = c.tenant_id and l.branch_id = c.branch_id and l.is_default;
alter table stock_counts alter column location_id set not null;
alter table stock_counts add constraint stock_counts_location_fk foreign key (tenant_id, location_id) references stock_locations(tenant_id, id);
drop index stock_counts_one_draft;
create unique index stock_counts_one_draft on stock_counts (tenant_id, location_id) where status = 'draft';

-- ── Transfers ───────────────────────────────────────────────────────────────
create table stock_transfers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  number text not null,
  from_location_id uuid not null,
  to_location_id uuid not null,
  -- draft → completed (immediate), or draft → in_transit → completed (confirm_receipt).
  status text not null default 'draft' check (status in ('draft', 'in_transit', 'completed', 'cancelled')),
  mode text not null check (mode in ('immediate', 'confirm_receipt')),
  note text check (note is null or length(note) <= 500),
  version int not null default 1,
  created_by uuid references users(id),
  dispatched_by uuid references users(id),
  dispatched_at timestamptz,
  received_by uuid references users(id),
  received_at timestamptz,
  cancelled_by uuid references users(id),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number),
  check (from_location_id <> to_location_id),
  check (status <> 'in_transit' or dispatched_at is not null),
  check (status <> 'completed' or received_at is not null),
  foreign key (tenant_id, from_location_id) references stock_locations(tenant_id, id),
  foreign key (tenant_id, to_location_id) references stock_locations(tenant_id, id)
);
create index stock_transfers_tenant_idx on stock_transfers (tenant_id, created_at desc);

create table stock_transfer_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  transfer_id uuid not null,
  inventory_item_id uuid not null,
  -- The item card that receives (the same row unless the transfer crosses branches).
  to_inventory_item_id uuid,
  quantity numeric(14, 3) not null check (quantity > 0),
  -- Frozen at dispatch: what the moved quantity cost (weighted average then).
  unit_cost_minor numeric(18, 4),
  total_cost_minor bigint,
  -- Batches moved: [{"batch_id": "…", "quantity": 2}]
  batches jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (transfer_id, inventory_item_id),
  foreign key (tenant_id, transfer_id) references stock_transfers(tenant_id, id),
  foreign key (tenant_id, inventory_item_id) references inventory_items(tenant_id, id),
  foreign key (tenant_id, to_inventory_item_id) references inventory_items(tenant_id, id)
);

-- ── Material consumption (expected vs actual, one posting) ──────────────────
create table material_consumptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  source text not null check (source in ('service', 'manual')),
  booking_id uuid,
  booking_item_id uuid,
  service_id uuid,
  inventory_item_id uuid not null,
  location_id uuid not null,
  resource_id uuid,
  unit text not null check (unit in ('piece', 'ml', 'l', 'g', 'kg')),
  -- From the approved recipe (0 for manual issues and extra materials).
  expected_qty numeric(14, 3) not null default 0 check (expected_qty >= 0),
  -- What was really used; NULL while pending = use the recipe quantity.
  actual_qty numeric(14, 3) check (actual_qty is null or actual_qty >= 0),
  posted_qty numeric(14, 3) not null default 0 check (posted_qty >= 0),
  shortage_qty numeric(14, 3) not null default 0 check (shortage_qty >= 0),
  waste_qty numeric(14, 3) not null default 0 check (waste_qty >= 0),
  total_cost_minor bigint not null default 0,
  performer_staff_id uuid,
  performer_user_id uuid references users(id),
  status text not null default 'pending' check (status in ('pending', 'posted', 'shortage', 'cancelled')),
  reason text check (reason is null or length(reason) <= 500),
  movement_ids uuid[] not null default '{}',
  version int not null default 1,
  posted_at timestamptz,
  posted_by uuid references users(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (source <> 'service' or booking_item_id is not null),
  check (source <> 'manual' or reason is not null),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id),
  foreign key (tenant_id, booking_item_id) references booking_items(tenant_id, id),
  foreign key (tenant_id, service_id) references services(tenant_id, id),
  foreign key (tenant_id, inventory_item_id) references inventory_items(tenant_id, id),
  foreign key (tenant_id, location_id) references stock_locations(tenant_id, id),
  foreign key (tenant_id, resource_id) references resources(tenant_id, id),
  foreign key (tenant_id, performer_staff_id) references staff_profiles(tenant_id, id)
);
create unique index material_consumptions_line_uq on material_consumptions (tenant_id, booking_item_id, inventory_item_id) where booking_item_id is not null;
create index material_consumptions_tenant_idx on material_consumptions (tenant_id, created_at desc);

-- ── Inventory tasks (shortage, expiry, reorder) ─────────────────────────────
create table inventory_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('shortage', 'expiry', 'reorder')),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  inventory_item_id uuid,
  location_id uuid,
  ref_type text,
  ref_id uuid,
  dedupe_key text not null,
  payload jsonb not null default '{}'::jsonb,
  resolution text check (resolution is null or length(resolution) <= 500),
  resolved_by uuid references users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, inventory_item_id) references inventory_items(tenant_id, id),
  foreign key (tenant_id, location_id) references stock_locations(tenant_id, id)
);
create unique index inventory_tasks_open_uq on inventory_tasks (tenant_id, dedupe_key) where status = 'open';
create index inventory_tasks_tenant_idx on inventory_tasks (tenant_id, status, created_at desc);

-- ── Purchasing: receipts, supplier invoices, links, payments ────────────────
create table purchase_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  number text not null,
  supplier_id uuid,
  location_id uuid not null,
  status text not null default 'draft' check (status in ('draft', 'posted', 'void')),
  received_on date not null,
  reference text check (reference is null or length(reference) <= 80),
  note text check (note is null or length(note) <= 500),
  version int not null default 1,
  created_by uuid references users(id),
  posted_by uuid references users(id),
  posted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number),
  check ((status = 'posted') = (posted_at is not null)),
  foreign key (tenant_id, supplier_id) references suppliers(tenant_id, id),
  foreign key (tenant_id, location_id) references stock_locations(tenant_id, id)
);
create index purchase_receipts_tenant_idx on purchase_receipts (tenant_id, received_on desc);

create table purchase_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  receipt_id uuid not null,
  inventory_item_id uuid not null,
  -- Base (usage) unit; entered_* keeps what was typed (e.g. 2 bottles).
  quantity numeric(14, 3) not null check (quantity > 0),
  entered_quantity numeric(14, 3) not null check (entered_quantity > 0),
  entered_uom text not null default 'usage' check (entered_uom in ('usage', 'storage')),
  -- Per base unit; NULL = not known at receipt (the current average is used).
  unit_cost_minor numeric(18, 4) check (unit_cost_minor is null or unit_cost_minor >= 0),
  batch_no text check (batch_no is null or length(batch_no) between 1 and 60),
  expiry_date date,
  movement_id uuid references stock_movements(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, receipt_id) references purchase_receipts(tenant_id, id),
  foreign key (tenant_id, inventory_item_id) references inventory_items(tenant_id, id)
);
create index purchase_receipt_lines_receipt_idx on purchase_receipt_lines (tenant_id, receipt_id);

create table supplier_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  supplier_id uuid not null,
  invoice_number text not null check (length(invoice_number) between 1 and 60),
  invoice_date date not null,
  due_date date,
  status text not null default 'draft' check (status in ('draft', 'posted', 'void')),
  subtotal_minor bigint not null default 0,
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  total_minor bigint not null default 0 check (total_minor >= 0),
  attachment_asset_id uuid references assets(id),
  note text check (note is null or length(note) <= 500),
  version int not null default 1,
  created_by uuid references users(id),
  posted_by uuid references users(id),
  posted_at timestamptz,
  voided_by uuid references users(id),
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (status <> 'void' or (voided_at is not null and void_reason is not null)),
  foreign key (tenant_id, supplier_id) references suppliers(tenant_id, id)
);
create unique index supplier_invoices_number_uq on supplier_invoices (tenant_id, supplier_id, lower(invoice_number));
create index supplier_invoices_tenant_idx on supplier_invoices (tenant_id, invoice_date desc);

create table supplier_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  invoice_id uuid not null,
  -- NULL for non-stock lines (delivery fee, service).
  inventory_item_id uuid,
  description text check (description is null or length(description) <= 200),
  quantity numeric(14, 3) not null check (quantity > 0),
  unit_cost_minor numeric(18, 4) not null check (unit_cost_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  -- quantity × unit cost − discount (before tax).
  net_minor bigint not null check (net_minor >= 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, invoice_id) references supplier_invoices(tenant_id, id),
  foreign key (tenant_id, inventory_item_id) references inventory_items(tenant_id, id)
);
create index supplier_invoice_lines_invoice_idx on supplier_invoice_lines (tenant_id, invoice_id);

-- Matching invoice lines to received lines (partial allowed). Never moves stock.
create table supplier_invoice_receipt_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  invoice_line_id uuid not null,
  receipt_line_id uuid not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (invoice_line_id, receipt_line_id),
  foreign key (tenant_id, invoice_line_id) references supplier_invoice_lines(tenant_id, id),
  foreign key (tenant_id, receipt_line_id) references purchase_receipt_lines(tenant_id, id)
);
create index supplier_invoice_receipt_links_receipt_idx on supplier_invoice_receipt_links (tenant_id, receipt_line_id);

create table supplier_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  supplier_id uuid not null,
  invoice_id uuid,
  amount_minor bigint not null check (amount_minor > 0),
  method text not null check (method in ('cash', 'bank')),
  paid_on date not null,
  reference text check (reference is null or length(reference) <= 80),
  note text check (note is null or length(note) <= 500),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, supplier_id) references suppliers(tenant_id, id),
  foreign key (tenant_id, invoice_id) references supplier_invoices(tenant_id, id)
);
create index supplier_payments_tenant_idx on supplier_payments (tenant_id, paid_on desc);

-- ── Journal accounts ────────────────────────────────────────────────────────
--   Opening stock        Dr inventory                   Cr owner_equity
--   Goods received       Dr inventory                   Cr goods_received_not_invoiced
--   Supplier invoice     Dr goods_received_not_invoiced (matched, at receipt cost)
--                        Dr inventory | cogs | material_costs (price difference)
--                        Dr operating_expenses (non-stock lines)  Dr input_tax
--                        Cr accounts_payable
--   Supplier payment     Dr accounts_payable            Cr cash_on_hand | bank
--   Service consumption  Dr material_costs              Cr inventory
--   Product sale         Dr cogs                        Cr inventory
--   Waste / count loss   Dr inventory_shrinkage         Cr inventory   (gain: reverse)
--   Return to supplier   Dr accounts_payable | goods_received_not_invoiced  Cr inventory
--   Transfers            no entry (inventory stays inventory)
alter table financial_entries drop constraint financial_entries_account_check;
alter table financial_entries add constraint financial_entries_account_check check (account in (
  'cash_on_hand', 'bank', 'provider_clearing', 'customer_deposits', 'accounts_receivable',
  'service_revenue', 'product_revenue', 'gift_card_liability', 'membership_liability',
  'discounts', 'refunds', 'provider_fees', 'tax_payable', 'cogs', 'inventory', 'material_costs',
  'commissions_expense', 'commissions_payable', 'operating_expenses', 'owner_equity',
  'salaries_expense', 'payroll_payable', 'staff_advances', 'tips_payable',
  'accounts_payable', 'goods_received_not_invoiced', 'input_tax', 'inventory_shrinkage'));

-- ── Roles: warehouse keeper (مسؤول مستودع) ──────────────────────────────────
alter table tenant_memberships drop constraint tenant_memberships_role_check;
alter table tenant_memberships add constraint tenant_memberships_role_check check (role in ('owner', 'manager', 'receptionist', 'specialist', 'finance', 'warehouse'));
alter table invitations drop constraint invitations_role_check;
alter table invitations add constraint invitations_role_check check (role in ('manager', 'receptionist', 'specialist', 'finance', 'warehouse'));

-- ── Loom export (read-only views; existing columns unchanged) ───────────────
create or replace view loom_export.inventory_items with (security_invoker = true) as
  select i.id, i.name, case i.kind when 'retail' then 'sellable' when 'material' then 'consumable' else 'both' end as usage,
         i.on_hand::float8 as on_hand, i.reserved::float8 as reserved, i.unit, i.cost_per_unit_minor as unit_cost_minor,
         i.low_stock_threshold::float8 as reorder_level, i.variant_id as offering_id, i.branch_id as location_id, i.is_active,
         coalesce((select sum(-m.quantity) from stock_movements m where m.inventory_item_id = i.id and m.tenant_id = i.tenant_id
                    and m.kind = 'consumption' and m.created_at > now() - interval '90 days'), 0)::float8 as consumed_90d,
         coalesce((select sum(-m.quantity) from stock_movements m where m.inventory_item_id = i.id and m.tenant_id = i.tenant_id
                    and m.kind = 'sale' and m.created_at > now() - interval '90 days'), 0)::float8 as sold_90d,
         i.updated_at,
         i.avg_cost_minor::float8 as avg_cost_minor, i.stock_value_minor, i.is_tool
  from inventory_items i where i.tenant_id = app.current_tenant();

create view loom_export.stock_balances with (security_invoker = true) as
  select b.inventory_item_id as item_id, b.location_id as stock_location_id, l.kind as stock_location_kind, l.branch_id as location_id,
         b.on_hand::float8 as on_hand, b.reserved::float8 as reserved, b.in_transit::float8 as in_transit,
         b.reorder_level::float8 as reorder_level, (b.on_hand * coalesce(i.avg_cost_minor, 0))::float8 as value_minor, b.updated_at
  from stock_balances b join stock_locations l on l.id = b.location_id and l.tenant_id = b.tenant_id
  join inventory_items i on i.id = b.inventory_item_id and i.tenant_id = b.tenant_id
  where b.tenant_id = app.current_tenant();

create view loom_export.material_consumption with (security_invoker = true) as
  select c.id, c.source, c.service_id as offering_id, c.inventory_item_id as item_id, c.location_id as stock_location_id,
         c.resource_id, c.expected_qty::float8 as expected_qty, coalesce(c.actual_qty, c.expected_qty)::float8 as actual_qty,
         c.posted_qty::float8 as posted_qty, c.waste_qty::float8 as waste_qty, c.total_cost_minor, c.status, c.posted_at
  from material_consumptions c where c.tenant_id = app.current_tenant();

grant select on loom_export.stock_balances to {{APP_ROLE}};
grant select on loom_export.material_consumption to {{APP_ROLE}};

select app.make_append_only('stock_movement_batches', '{{APP_ROLE}}');
select app.apply_conventions('{{APP_ROLE}}');
