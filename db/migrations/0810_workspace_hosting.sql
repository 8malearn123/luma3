-- 0810 Workspace hosting («المساحات والاستضافة» / «احجزي مساحة عمل»)
--
-- A salon (host tenant) lists chairs / stations / rooms that independent
-- experts (guest tenants, business_type 'expert') book for a time window.
-- Binding decisions: docs/HOSTING_INVENTORY_DECISIONS.md (D1–D14).
--
-- Model
--   resource_staff_links        a chair is linked to one or more staff (D1b): the
--                               internal booking engine then allocates the linked
--                               chair whenever a linked staff member is booked.
--   workspace_listings          one rentable space per resource (opt-in, D1b),
--                               with weekly windows, fixed pricing (D2), add-ons
--                               (D5/D5b/D6), structured terms, booking mode (D1).
--   workspace_bookings          cross-tenant entity (host_tenant_id + guest_tenant_id,
--                               no plain tenant_id). Readable by either party, written
--                               only by the hosting service under system scope.
--   workspace_booking_lines     frozen money lines (rent, product, equipment,
--                               late_fee [proposed → approved|rejected], discount,
--                               tax, correction).
--   workspace_settlements       approved statements, append-only (corrections are
--                               new lines + a new settlement version).
--
-- Time is reserved through the SAME booking_allocations table and exclusion
-- constraints as every other booking:
--   host tenant   chair resource (+ equipment resources) owned by workspace_booking_id
--   guest tenant  the expert's own provider staff profile owned by workspace_booking_id
-- Guest staff overlap rules (booking_allocations.space_key):
--   * two space bookings of the same expert never overlap (different space keys);
--   * a space booking never overlaps one of her own appointments that is NOT
--     linked to it (sentinel key ≠ space key);
--   * her client appointments linked to the space booking (within_workspace_booking_id)
--     may sit inside its window (same space key), and still never overlap each
--     other (the original per-staff constraint, now limited to non-space rows).
--
-- Journal (accounts added additively below):
--   Host, payment captured     Dr provider_clearing   Cr hosting_revenue (rent/equipment/fees, net)
--                                                     Cr product_revenue (product add-ons, net) Cr tax_payable
--   Host, product handed over  Dr cogs                Cr inventory (when the unit cost is known)
--   Host, extra charge         Dr hosting_receivable  Cr hosting_revenue|product_revenue + tax_payable
--   Host, extra charge paid    Dr provider_clearing   Cr hosting_receivable
--   Host, refund               Dr refunds             Cr provider_clearing
--   Guest, paid                Dr hosting_expense     Cr bank
--   Guest, extra charge        Dr hosting_expense     Cr hosting_payable;  paid: Dr hosting_payable Cr bank
--   Guest, refund              Dr bank                Cr hosting_expense
-- The expert's client service revenue is never recorded for the salon (D3).

-- ── Helpers ─────────────────────────────────────────────────────────────────
-- Visibility of a cross-tenant hosting row: either party, or system scope.
create or replace function app.workspace_party(host uuid, guest uuid) returns boolean
language sql stable as $$
  select app.is_system() or (app.current_tenant() is not null and app.current_tenant() in (host, guest))
$$;

-- ── 1. Chair ↔ staff links (D1b) ────────────────────────────────────────────
create table resource_staff_links (
  tenant_id uuid not null references tenants(id),
  resource_id uuid not null,
  staff_id uuid not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (tenant_id, resource_id, staff_id),
  foreign key (tenant_id, resource_id) references resources(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);
create index resource_staff_links_staff_idx on resource_staff_links (tenant_id, staff_id);

-- ── 2. Listings ─────────────────────────────────────────────────────────────
create table workspace_listings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  branch_id uuid not null,
  resource_id uuid not null,
  code text not null check (char_length(code) between 1 and 20),
  title_ar text check (char_length(title_ar) <= 120),
  title_en text check (char_length(title_en) <= 120),
  space_type text not null default 'chair' check (space_type in ('chair', 'station', 'room', 'other')),
  description_ar text check (char_length(description_ar) <= 2000),
  description_en text check (char_length(description_en) <= 2000),
  photo_asset_ids uuid[] not null default '{}' check (cardinality(photo_asset_ids) <= 10),
  -- Allowed services / specialties (free tags such as 'hair', 'makeup', 'nails').
  specialties text[] not null default '{}' check (cardinality(specialties) <= 20),
  min_duration_min int not null default 60 check (min_duration_min between 15 and 1440),
  max_duration_min int not null default 480 check (max_duration_min between 15 and 1440),
  setup_buffer_min int not null default 0 check (setup_buffer_min between 0 and 120),
  cleanup_buffer_min int not null default 0 check (cleanup_buffer_min between 0 and 120),
  -- D2: fixed price only at launch. The percentage models and their basis are
  -- stored for later but rejected by the constraint below while disabled.
  price_model text not null default 'fixed_hour' check (price_model in ('fixed_hour', 'fixed_period', 'fixed_day', 'percent', 'fixed_plus_percent')),
  price_minor bigint not null default 0 check (price_minor >= 0),
  period_min int check (period_min is null or period_min between 30 and 1440),
  percent_bp int check (percent_bp is null or percent_bp between 0 and 10000),
  percent_basis text check (percent_basis is null or percent_basis in ('service_net', 'service_gross')),
  currency char(3) not null default 'SAR',
  -- Equipment included in the base price (shared resources reserved with the booking).
  included_resource_ids uuid[] not null default '{}' check (cardinality(included_resource_ids) <= 10),
  -- D5b: listing-wide discount on add-ons (products at store price, equipment rental).
  addons_discount_bp int not null default 0 check (addons_discount_bp between 0 and 10000),
  own_materials_policy_ar text check (char_length(own_materials_policy_ar) <= 1000),
  own_materials_policy_en text check (char_length(own_materials_policy_en) <= 1000),
  -- {"free_until_hours": 24, "fee_bp": 5000}  (fee applies to the rent only)
  cancellation_terms jsonb not null default '{"free_until_hours": 24, "fee_bp": 5000}'::jsonb,
  -- {"grace_min": 10, "mode": "per_15min" | "flat", "amount_minor": 0}  (D8: declared, proposed on check-out)
  late_terms jsonb not null default '{"grace_min": 10, "mode": "per_15min", "amount_minor": 0}'::jsonb,
  access_instructions_ar text check (char_length(access_instructions_ar) <= 2000),
  access_instructions_en text check (char_length(access_instructions_en) <= 2000),
  usage_rules_ar text check (char_length(usage_rules_ar) <= 2000),
  usage_rules_en text check (char_length(usage_rules_en) <= 2000),
  booking_mode text not null default 'approval' check (booking_mode in ('instant', 'approval')),
  status text not null default 'draft' check (status in ('draft', 'published', 'paused', 'archived')),
  -- Bumped on every change that affects a booking's terms; captured in terms_snapshot.
  terms_version int not null default 1,
  version int not null default 1,
  published_at timestamptz,
  created_by uuid references users(id),
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code),
  check (max_duration_min >= min_duration_min),
  constraint workspace_listings_fixed_price_only check (price_model in ('fixed_hour', 'fixed_period', 'fixed_day') and percent_bp is null and percent_basis is null),
  check (price_model <> 'fixed_period' or period_min is not null),
  check (status <> 'published' or price_minor > 0),
  foreign key (tenant_id, branch_id) references branches(tenant_id, id),
  foreign key (tenant_id, resource_id) references resources(tenant_id, id)
);
create unique index workspace_listings_resource_uq on workspace_listings (tenant_id, resource_id) where status <> 'archived';
create index workspace_listings_status_idx on workspace_listings (status, tenant_id);

-- Weekly windows in which the space is offered (branch-local wall-clock time).
create table workspace_listing_windows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  listing_id uuid not null,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  check (end_time > start_time),
  foreign key (tenant_id, listing_id) references workspace_listings(tenant_id, id) on delete cascade
);
create index workspace_listing_windows_idx on workspace_listing_windows (tenant_id, listing_id, weekday);

-- Per-booking add-ons (D5/D6): whole products from the salon store at store
-- price, or a rented shared device (a resource reserved with the booking).
create table workspace_listing_addons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  listing_id uuid not null,
  kind text not null check (kind in ('product', 'equipment')),
  product_variant_id uuid,
  resource_id uuid,
  name_ar text check (char_length(name_ar) <= 120),
  name_en text check (char_length(name_en) <= 120),
  rental_price_minor bigint check (rental_price_minor is null or rental_price_minor >= 0),
  rental_unit text check (rental_unit is null or rental_unit in ('booking', 'hour')),
  max_quantity int not null default 5 check (max_quantity between 1 and 50),
  is_active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check ((kind = 'product' and product_variant_id is not null and resource_id is null and rental_price_minor is null and rental_unit is null)
      or (kind = 'equipment' and resource_id is not null and product_variant_id is null and rental_price_minor is not null and rental_unit is not null)),
  foreign key (tenant_id, listing_id) references workspace_listings(tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_variant_id) references product_variants(tenant_id, id),
  foreign key (tenant_id, resource_id) references resources(tenant_id, id)
);
create index workspace_listing_addons_idx on workspace_listing_addons (tenant_id, listing_id);

-- ── 3. Workspace bookings (cross-tenant) ────────────────────────────────────
create table workspace_bookings (
  id uuid primary key default gen_random_uuid(),
  host_tenant_id uuid not null references tenants(id),
  guest_tenant_id uuid not null references tenants(id),
  number text not null,
  listing_id uuid not null,
  resource_id uuid not null,
  branch_id uuid not null,
  guest_staff_id uuid not null,
  guest_user_id uuid not null references users(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null,
  -- Chair occupation including setup/cleanup buffers.
  occupied tstzrange not null check (not isempty(occupied)),
  status text not null check (status in ('draft', 'requested', 'pending_approval', 'held', 'pending_payment', 'confirmed', 'checked_in', 'in_use', 'completed', 'cancelled', 'expired', 'no_show')),
  booking_mode text not null check (booking_mode in ('instant', 'approval')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'pending', 'paid', 'refunded', 'partially_refunded')),
  settlement_status text not null default 'open' check (settlement_status in ('open', 'approved', 'settled', 'corrected')),
  -- Frozen at request/confirmation: price model, prices, add-ons, discount, tax rule, terms, listing version.
  terms_snapshot jsonb not null,
  listing_terms_version int not null,
  currency char(3) not null default 'SAR',
  rent_minor bigint not null default 0 check (rent_minor >= 0),
  addons_minor bigint not null default 0 check (addons_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  total_minor bigint not null default 0 check (total_minor >= 0),
  paid_minor bigint not null default 0 check (paid_minor >= 0),
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  hold_expires_at timestamptz,
  approval_deadline timestamptz,
  check_in_code text not null check (check_in_code ~ '^[0-9]{6}$'),
  qr_token text not null unique check (char_length(qr_token) between 20 and 80),
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  checked_in_by uuid references users(id),
  checked_out_by uuid references users(id),
  -- Notes about the space only; never client data (D14).
  guest_note text check (char_length(guest_note) <= 500),
  host_note text check (char_length(host_note) <= 500),
  guest_snapshot jsonb not null default '{}'::jsonb,
  host_snapshot jsonb not null default '{}'::jsonb,
  approved_at timestamptz,
  approved_by uuid references users(id),
  confirmed_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_source text check (cancel_source in ('guest', 'host', 'system')),
  cancel_reason text check (char_length(cancel_reason) <= 500),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (host_tenant_id, number),
  unique (id, host_tenant_id, guest_tenant_id),
  check (host_tenant_id <> guest_tenant_id),
  check (ends_at > starts_at),
  check (status not in ('held', 'pending_payment', 'pending_approval') or hold_expires_at is not null),
  foreign key (host_tenant_id, listing_id) references workspace_listings(tenant_id, id),
  foreign key (host_tenant_id, resource_id) references resources(tenant_id, id),
  foreign key (host_tenant_id, branch_id) references branches(tenant_id, id),
  foreign key (guest_tenant_id, guest_staff_id) references staff_profiles(tenant_id, id)
);
create index workspace_bookings_host_idx on workspace_bookings (host_tenant_id, status, starts_at);
create index workspace_bookings_guest_idx on workspace_bookings (guest_tenant_id, status, starts_at);
create index workspace_bookings_listing_idx on workspace_bookings (host_tenant_id, listing_id, starts_at);
create index workspace_bookings_hold_idx on workspace_bookings (hold_expires_at) where status in ('pending_approval', 'held', 'pending_payment');

-- Transition log (who did what, from → to).
create table workspace_booking_events (
  id uuid primary key default gen_random_uuid(),
  workspace_booking_id uuid not null,
  host_tenant_id uuid not null,
  guest_tenant_id uuid not null,
  from_status text,
  to_status text,
  kind text not null default 'transition',
  actor_kind text not null check (actor_kind in ('guest', 'host', 'system')),
  actor_user_id uuid references users(id),
  reason text check (char_length(reason) <= 500),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (workspace_booking_id, host_tenant_id, guest_tenant_id) references workspace_bookings(id, host_tenant_id, guest_tenant_id)
);
create index workspace_booking_events_idx on workspace_booking_events (workspace_booking_id, created_at);

-- Material / equipment requests during a booking (approved → add-on line).
create table workspace_material_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_booking_id uuid not null,
  host_tenant_id uuid not null,
  guest_tenant_id uuid not null,
  addon_id uuid not null,
  quantity int not null check (quantity between 1 and 50),
  note text check (char_length(note) <= 500),
  status text not null default 'requested' check (status in ('requested', 'approved', 'rejected', 'cancelled')),
  requested_by uuid references users(id),
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_note text check (char_length(decision_note) <= 500),
  created_at timestamptz not null default now(),
  foreign key (workspace_booking_id, host_tenant_id, guest_tenant_id) references workspace_bookings(id, host_tenant_id, guest_tenant_id),
  foreign key (host_tenant_id, addon_id) references workspace_listing_addons(tenant_id, id)
);
create index workspace_material_requests_idx on workspace_material_requests (workspace_booking_id, created_at);

create table workspace_booking_lines (
  id uuid primary key default gen_random_uuid(),
  workspace_booking_id uuid not null,
  host_tenant_id uuid not null,
  guest_tenant_id uuid not null,
  kind text not null check (kind in ('rent', 'product', 'equipment', 'late_fee', 'discount', 'tax', 'correction')),
  -- late_fee lines start 'proposed' and enter settlement only once approved (D8).
  status text not null default 'approved' check (status in ('proposed', 'approved', 'rejected', 'void')),
  -- 'booking' lines are paid at checkout; 'extra' lines are due afterwards.
  charge_group text not null default 'booking' check (charge_group in ('booking', 'extra')),
  description text not null check (char_length(description) <= 300),
  addon_id uuid,
  product_variant_id uuid,
  inventory_item_id uuid,
  resource_id uuid,
  material_request_id uuid references workspace_material_requests(id),
  quantity numeric(14, 3) not null default 1,
  unit_price_minor bigint not null default 0,
  -- Signed: discounts and negative corrections are negative. Tax lines: tax_included says whether it is part of the other lines.
  amount_minor bigint not null,
  tax_included boolean not null default false,
  -- Products: cost captured when the stock movement happens (never recomputed).
  unit_cost_minor bigint check (unit_cost_minor is null or unit_cost_minor >= 0),
  stock_moved_at timestamptz,
  stock_returned_at timestamptz,
  payment_id uuid,
  invoice_id uuid,
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_note text check (char_length(decision_note) <= 500),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (kind in ('discount', 'correction') or amount_minor >= 0),
  check (kind <> 'discount' or amount_minor <= 0),
  check (kind = 'late_fee' or status <> 'proposed'),
  foreign key (workspace_booking_id, host_tenant_id, guest_tenant_id) references workspace_bookings(id, host_tenant_id, guest_tenant_id),
  foreign key (host_tenant_id, product_variant_id) references product_variants(tenant_id, id),
  foreign key (host_tenant_id, resource_id) references resources(tenant_id, id)
);
create index workspace_booking_lines_idx on workspace_booking_lines (workspace_booking_id, created_at);

-- Approved settlement statements (immutable). Corrections → new lines + version.
create table workspace_settlements (
  id uuid primary key default gen_random_uuid(),
  workspace_booking_id uuid not null,
  host_tenant_id uuid not null,
  guest_tenant_id uuid not null,
  version int not null check (version >= 1),
  statement jsonb not null,
  approved_by uuid references users(id),
  approved_at timestamptz not null default now(),
  unique (workspace_booking_id, version),
  foreign key (workspace_booking_id, host_tenant_id, guest_tenant_id) references workspace_bookings(id, host_tenant_id, guest_tenant_id)
);

-- D9: the expert rates the space after a completed booking (separate from client reviews).
create table workspace_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_booking_id uuid not null unique,
  host_tenant_id uuid not null,
  guest_tenant_id uuid not null,
  listing_id uuid not null,
  rating smallint not null check (rating between 1 and 5),
  body text check (char_length(body) <= 1000),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  foreign key (workspace_booking_id, host_tenant_id, guest_tenant_id) references workspace_bookings(id, host_tenant_id, guest_tenant_id),
  foreign key (host_tenant_id, listing_id) references workspace_listings(tenant_id, id)
);
create index workspace_reviews_listing_idx on workspace_reviews (listing_id, created_at desc);

-- Explicit RLS for the cross-tenant tables: either party may read; only the
-- hosting service (system scope, audited) writes.
do $$
declare t text;
begin
  foreach t in array array['workspace_bookings', 'workspace_booking_events', 'workspace_material_requests', 'workspace_booking_lines', 'workspace_settlements', 'workspace_reviews'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy workspace_party_read on %I for select using (app.workspace_party(host_tenant_id, guest_tenant_id))', t);
    execute format('create policy workspace_system_write on %I for all using (app.is_system()) with check (app.is_system())', t);
  end loop;
end $$;

-- ── 4. Unified allocation ───────────────────────────────────────────────────
alter table booking_allocations add column workspace_booking_id uuid references workspace_bookings(id);
-- A guest appointment placed inside her confirmed space window (see header).
alter table booking_allocations add column within_workspace_booking_id uuid references workspace_bookings(id);
alter table booking_allocations add column space_key uuid generated always as
  (coalesce(workspace_booking_id, within_workspace_booking_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored;
alter table booking_allocations drop constraint booking_allocations_owner_chk;
alter table booking_allocations add constraint booking_allocations_owner_chk
  check (booking_id is not null or group_session_id is not null or event_booking_id is not null or workspace_booking_id is not null);
alter table booking_allocations drop constraint booking_allocations_staff_no_overlap;
alter table booking_allocations add constraint booking_allocations_staff_no_overlap exclude using gist (
  tenant_id with =, staff_id with =, during with &&
) where (state in ('held', 'confirmed') and staff_id is not null and workspace_booking_id is null);
alter table booking_allocations add constraint booking_allocations_staff_space_no_overlap exclude using gist (
  tenant_id with =, staff_id with =, during with &&, space_key with <>
) where (state in ('held', 'confirmed') and staff_id is not null);
create index booking_allocations_workspace_idx on booking_allocations (workspace_booking_id) where workspace_booking_id is not null;
create index booking_allocations_within_ws_idx on booking_allocations (within_workspace_booking_id) where within_workspace_booking_id is not null;

-- ── 5. Client appointments linked to a space booking (guest tenant only) ────
alter table bookings add column workspace_booking_id uuid references workspace_bookings(id);
create index bookings_workspace_idx on bookings (tenant_id, workspace_booking_id) where workspace_booking_id is not null;

-- ── 6. Payments, invoices, journal accounts (additive, merge-safe) ──────────
alter table payments add column workspace_booking_id uuid references workspace_bookings(id);
-- The business that pays (D3b: the expert pays the salon; the salon is the merchant).
alter table payments add column payer_tenant_id uuid references tenants(id);
create index payments_workspace_idx on payments (tenant_id, workspace_booking_id) where workspace_booking_id is not null;

alter table invoices add column workspace_booking_id uuid references workspace_bookings(id);
alter table invoices add column buyer_tenant_id uuid references tenants(id);
create index invoices_workspace_idx on invoices (tenant_id, workspace_booking_id) where workspace_booking_id is not null;

-- Constraints are extended from their CURRENT definition (not re-listed) so this
-- migration composes with other migrations that also extend them.
do $$
declare def text;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint where conrelid = 'public.financial_entries'::regclass and conname = 'financial_entries_account_check';
  if def is not null and position('hosting_revenue' in def) = 0 then
    execute 'alter table financial_entries drop constraint financial_entries_account_check';
    execute 'alter table financial_entries add constraint financial_entries_account_check '
      || regexp_replace(def, '\]\)\)\)$', ', ''hosting_revenue''::text, ''hosting_receivable''::text, ''hosting_expense''::text, ''hosting_payable''::text])))');
  end if;

  select pg_get_constraintdef(oid) into def from pg_constraint where conrelid = 'public.payments'::regclass and conname = 'payments_purpose_check';
  if def is not null and position('''workspace''' in def) = 0 then
    execute 'alter table payments drop constraint payments_purpose_check';
    execute 'alter table payments add constraint payments_purpose_check ' || regexp_replace(def, '\]\)\)\)$', ', ''workspace''::text])))');
  end if;

  select pg_get_constraintdef(oid) into def from pg_constraint where conrelid = 'public.payments'::regclass and conname = 'payments_check';
  if def is not null and position('workspace_booking_id' in def) = 0 then
    execute 'alter table payments drop constraint payments_check';
    execute 'alter table payments add constraint payments_check ' || replace(def, 'num_nonnulls(', 'num_nonnulls(workspace_booking_id, ');
  end if;
end $$;

-- ── 7. Public directory for experts (allowlisted fields of published listings) ──
-- A listing is searchable only while published, its business is active and the
-- business has an active payment account (D3c). Access instructions are NOT
-- public: they are shown to the guest after confirmation.
create or replace function app.workspace_directory(p_city text, p_space_type text, p_listing uuid)
returns table (
  id uuid, host_tenant_id uuid, host_name text, host_slug text, branch_id uuid, branch_name text, city text, address text,
  latitude numeric, longitude numeric, timezone text, code text, title_ar text, title_en text, space_type text,
  description_ar text, description_en text, photo_asset_ids uuid[], specialties text[], price_model text, price_minor bigint,
  period_min int, currency char(3), min_duration_min int, max_duration_min int, setup_buffer_min int, cleanup_buffer_min int,
  booking_mode text, addons_discount_bp int, own_materials_policy_ar text, own_materials_policy_en text,
  cancellation_terms jsonb, late_terms jsonb, usage_rules_ar text, usage_rules_en text, terms_version int,
  windows jsonb, addons jsonb, included_equipment jsonb, rating_avg numeric, rating_count int, tax jsonb
)
language sql stable security definer set search_path = public as $$
  select l.id, l.tenant_id, t.name, t.slug::text, b.id, b.name, coalesce(b.city, t.city), b.address, b.latitude, b.longitude, b.timezone,
         l.code, l.title_ar, l.title_en, l.space_type, l.description_ar, l.description_en, l.photo_asset_ids, l.specialties,
         l.price_model, l.price_minor, l.period_min, l.currency, l.min_duration_min, l.max_duration_min, l.setup_buffer_min, l.cleanup_buffer_min,
         l.booking_mode, l.addons_discount_bp, l.own_materials_policy_ar, l.own_materials_policy_en, l.cancellation_terms, l.late_terms,
         l.usage_rules_ar, l.usage_rules_en, l.terms_version,
         coalesce((select jsonb_agg(jsonb_build_object('weekday', w.weekday, 'start', to_char(w.start_time, 'HH24:MI'), 'end', to_char(w.end_time, 'HH24:MI')) order by w.weekday, w.start_time)
                   from workspace_listing_windows w where w.listing_id = l.id and w.tenant_id = l.tenant_id), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'id', a.id, 'kind', a.kind,
                     'name_ar', coalesce(a.name_ar, case when a.kind = 'product' then nullif(concat_ws(' · ', p.name_ar, v.name_ar), '') end),
                     'name_en', coalesce(a.name_en, case when a.kind = 'product' then nullif(concat_ws(' · ', p.name_en, v.name_en), '') end),
                     'unit_price_minor', case when a.kind = 'product' then v.price_minor else a.rental_price_minor end,
                     'rental_unit', a.rental_unit, 'max_quantity', a.max_quantity) order by a.sort, a.created_at)
                   from workspace_listing_addons a
                   left join product_variants v on v.id = a.product_variant_id and v.tenant_id = a.tenant_id
                   left join products p on p.id = v.product_id and p.tenant_id = v.tenant_id
                   where a.listing_id = l.id and a.tenant_id = l.tenant_id and a.is_active
                     and (a.kind = 'equipment' or (v.is_active and p.status = 'active'))), '[]'::jsonb),
         coalesce((select jsonb_agg(r.name order by r.name) from resources r where r.tenant_id = l.tenant_id and r.id = any(l.included_resource_ids)), '[]'::jsonb),
         (select round(avg(rv.rating)::numeric, 2) from workspace_reviews rv where rv.listing_id = l.id),
         (select count(*)::int from workspace_reviews rv where rv.listing_id = l.id),
         (select jsonb_build_object('rate_bp', s.tax_rate_bp, 'prices_include_tax', s.prices_include_tax, 'label', s.tax_label, 'vat_registered', coalesce(nullif(trim(s.tax_number), ''), null) is not null)
            from tenant_settings s where s.tenant_id = l.tenant_id)
  from workspace_listings l
  join tenants t on t.id = l.tenant_id
  join branches b on b.id = l.branch_id and b.tenant_id = l.tenant_id
  where l.status = 'published' and t.status = 'active' and b.status = 'active'
    and exists (select 1 from payment_accounts pa where pa.tenant_id = l.tenant_id and pa.status = 'active')
    and (p_listing is null or l.id = p_listing)
    and (p_city is null or coalesce(b.city, t.city) ilike p_city)
    and (p_space_type is null or l.space_type = p_space_type)
  order by l.created_at
  limit 200
$$;

-- Recent reviews of one listing (rating, text, date only — no reviewer identity).
create or replace function app.workspace_listing_reviews(p_listing uuid, p_limit int)
returns table (rating smallint, body text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select rv.rating, rv.body, rv.created_at from workspace_reviews rv
  join workspace_listings l on l.id = rv.listing_id and l.status = 'published'
  where rv.listing_id = p_listing order by rv.created_at desc limit least(greatest(p_limit, 1), 50)
$$;

-- ── 8. Plans — مقترح — غير معتمد (D12 proposed distribution, for review) ──────
-- The basic plan can search and book spaces (workspace.book); publishing spaces
-- for rent is a Wahaj/Fareed feature. Editable from platform plan management.
-- Downgrades never delete listings, bookings or settlements; confirmed bookings
-- are honoured and only creating/publishing beyond the plan is blocked.
with matrix(code, feature_key, enabled, limit_value) as (values
  ('sanaa', 'hosting.publish', false, null::int), ('sanaa', 'limit.hosting_spaces', false, 0), ('sanaa', 'hosting.reports', false, null), ('sanaa', 'workspace.book', true, null),
  ('wahaj', 'hosting.publish', true, null), ('wahaj', 'limit.hosting_spaces', true, 3), ('wahaj', 'hosting.reports', true, null), ('wahaj', 'workspace.book', true, null),
  ('fareed', 'hosting.publish', true, null), ('fareed', 'limit.hosting_spaces', true, null), ('fareed', 'hosting.reports', true, null), ('fareed', 'workspace.book', true, null)
)
insert into plan_features (plan_id, feature_key, enabled, limit_value)
select p.id, m.feature_key, m.enabled, m.limit_value from matrix m join plans p on p.code = m.code
on conflict (plan_id, feature_key) do nothing;

-- D11: LUMA hosting fee structure — exists, value 0, disabled (platform setting).
insert into platform_settings (key, value) values ('hosting_platform_fee_enabled', 'false'), ('hosting_platform_fee_bp', '0')
on conflict (key) do nothing;

-- ── 9. Loom export (tenant-scoped, no cross-party private details) ──────────
-- Host: chair occupation, internal vs freelancer.
create view loom_export.hosting_occupancy with (security_invoker = true) as
  select a.resource_id, l.id as listing_id, lower(a.during) as starts_at, upper(a.during) as ends_at,
         case when a.workspace_booking_id is not null then 'freelancer' else 'internal' end as usage
  from booking_allocations a
  join workspace_listings l on l.resource_id = a.resource_id and l.tenant_id = a.tenant_id and l.status <> 'archived'
  where a.tenant_id = app.current_tenant() and a.state = 'confirmed' and a.resource_id is not null
    and a.during && tstzrange(now() - interval '120 days', now() + interval '60 days');

-- Host: hosting revenue per space booking (guest is pseudonymous).
create view loom_export.hosting_revenue with (security_invoker = true) as
  select w.id, w.listing_id, w.status, w.starts_at, w.ends_at, loom_export.pseudo(w.guest_tenant_id) as guest_ref,
         w.rent_minor, w.addons_minor, w.discount_minor, w.tax_minor, w.total_minor, w.paid_minor, w.refunded_minor,
         coalesce((select sum(x.amount_minor) from workspace_booking_lines x where x.workspace_booking_id = w.id and x.kind = 'late_fee' and x.status = 'approved'), 0)::bigint as late_fees_minor,
         w.payment_status, w.settlement_status
  from workspace_bookings w where w.host_tenant_id = app.current_tenant();

-- Host: listed vs freelancer-booked minutes per listing per local day (idle = listed − booked).
create view loom_export.hosting_idle with (security_invoker = true) as
  with days as (
    select l.id as listing_id, l.tenant_id, b.timezone, d::date as day
    from workspace_listings l join branches b on b.id = l.branch_id and b.tenant_id = l.tenant_id
    cross join generate_series(current_date - 60, current_date + 30, interval '1 day') d
    where l.tenant_id = app.current_tenant() and l.status = 'published'
  ), win as (
    select d.listing_id, d.day, tstzrange((d.day + w.start_time) at time zone d.timezone, (d.day + w.end_time) at time zone d.timezone) as r
    from days d join workspace_listing_windows w on w.listing_id = d.listing_id and w.tenant_id = d.tenant_id and w.weekday = extract(dow from d.day)
  )
  select win.listing_id, win.day,
         sum(extract(epoch from upper(win.r) - lower(win.r)) / 60)::int as listed_min,
         coalesce(sum((select sum(extract(epoch from upper(win.r * tstzrange(wb.starts_at, wb.ends_at)) - lower(win.r * tstzrange(wb.starts_at, wb.ends_at))) / 60)
                       from workspace_bookings wb where wb.listing_id = win.listing_id and wb.host_tenant_id = app.current_tenant()
                         and wb.status in ('confirmed', 'checked_in', 'in_use', 'completed') and tstzrange(wb.starts_at, wb.ends_at) && win.r)), 0)::int as booked_min
  from win group by win.listing_id, win.day;

-- Guest: space cost per host and over time (host business name is public; no host internals).
create view loom_export.workspace_costs with (security_invoker = true) as
  select w.id, loom_export.pseudo(w.host_tenant_id) as host_ref, w.host_snapshot ->> 'name' as host_name, w.starts_at, w.ends_at,
         (extract(epoch from w.ends_at - w.starts_at) / 60)::int as duration_min, w.status,
         w.total_minor, w.paid_minor, w.refunded_minor,
         coalesce((select sum(x.amount_minor) from workspace_booking_lines x where x.workspace_booking_id = w.id and x.kind not in ('tax') and x.status = 'approved'), 0)::bigint as charges_minor
  from workspace_bookings w where w.guest_tenant_id = app.current_tenant();

grant select on all tables in schema loom_export to {{APP_ROLE}};

select app.apply_conventions('{{APP_ROLE}}');
select app.make_append_only('workspace_settlements', '{{APP_ROLE}}');
select app.make_append_only('workspace_booking_events', '{{APP_ROLE}}');
