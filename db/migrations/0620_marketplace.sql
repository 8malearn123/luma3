-- 0620 سوق لوما (LUMA marketplace): listing by request + admin approval,
-- business verification by type, customer favourites, marketplace attribution
-- of bookings and the LUMA commission ledger (marketplace bookings only).
--
-- Rules (docs/MARKETPLACE.md):
--  * A business appears at /discover only when its listing is approved, not
--    hidden by the business, the business is active with a published
--    storefront and, when the platform requires it, verified.
--  * Public reads go through app.marketplace_directory() (security definer,
--    allowlisted columns). Nothing private (contacts, IBAN, documents, owner,
--    commission rate, revenue) is ever returned by it.
--  * Commission applies ONLY to bookings tagged channel = 'marketplace'; the
--    rate (basis points) is snapshotted on the booking at attribution time from
--    the business's own rate or the platform default.

-- ── Platform settings (singleton) ───────────────────────────────────────────
create table marketplace_settings (
  id boolean primary key default true check (id),
  require_verification boolean not null default true,
  default_commission_bp int not null default 1000 check (default_commission_bp between 0 and 10000),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
insert into marketplace_settings (id) values (true);
-- Readable from any scope; writable only in system scope (platform code paths).
alter table marketplace_settings enable row level security;
create policy marketplace_settings_read on marketplace_settings for select using (true);
create policy marketplace_settings_write on marketplace_settings for all using (app.is_system()) with check (app.is_system());

-- ── Listing (one row per business) ──────────────────────────────────────────
create table marketplace_listings (
  tenant_id uuid primary key references tenants(id),
  status text not null default 'draft' check (status in ('draft', 'pending', 'approved', 'rejected')),
  -- The business can hide itself at any time without losing its approval.
  hidden boolean not null default false,
  tagline_ar text check (tagline_ar is null or length(tagline_ar) <= 160),
  tagline_en text check (tagline_en is null or length(tagline_en) <= 160),
  cover_asset_id uuid,
  -- Per-business LUMA commission (basis points). NULL = platform default.
  commission_bp int check (commission_bp is null or commission_bp between 0 and 10000),
  requested_at timestamptz,
  requested_by uuid references users(id),
  reviewed_at timestamptz,
  reviewed_by uuid references users(id),
  rejection_reason text check (rejection_reason is null or length(rejection_reason) between 3 and 500),
  approved_at timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'rejected' or rejection_reason is not null),
  foreign key (tenant_id, cover_asset_id) references assets(tenant_id, id)
);
create index marketplace_listings_status_idx on marketplace_listings (status, requested_at);

-- ── Verification ────────────────────────────────────────────────────────────
create table tenant_verifications (
  tenant_id uuid primary key references tenants(id),
  status text not null default 'draft' check (status in ('draft', 'pending', 'verified', 'rejected')),
  submitted_at timestamptz,
  submitted_by uuid references users(id),
  reviewed_at timestamptz,
  reviewed_by uuid references users(id),
  rejection_reason text check (rejection_reason is null or length(rejection_reason) between 3 and 500),
  verified_at timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'rejected' or rejection_reason is not null)
);
create index tenant_verifications_status_idx on tenant_verifications (status, submitted_at);

-- Private documents. Files live in object storage under a tenant key and are
-- served only to the business owner and LUMA reviewers (never public).
create table verification_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('commercial_register', 'freelance_document', 'owner_id', 'iban')),
  storage_key text not null unique,
  mime text not null check (mime in ('application/pdf', 'image/webp')),
  bytes int not null check (bytes > 0 and bytes <= 8388608),
  sha256 text not null,
  file_name text check (file_name is null or length(file_name) <= 160),
  -- The IBAN number itself (kind = 'iban' only), validated in code (ISO 13616 mod-97).
  iban text check (iban is null or iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$'),
  uploaded_by uuid references users(id),
  -- A newer upload of the same kind supersedes the previous one.
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check ((kind = 'iban') = (iban is not null))
);
create unique index verification_documents_current on verification_documents (tenant_id, kind) where superseded_at is null;

-- Defence in depth: decisions (approval, verification, commission rate) are
-- only ever written by platform code paths running in system scope.
create or replace function app.guard_marketplace_decisions() returns trigger
language plpgsql as $$
begin
  if app.is_system() then return new; end if;
  if tg_table_name = 'marketplace_listings' then
    if tg_op = 'INSERT' then
      if new.status not in ('draft', 'pending') or new.commission_bp is not null then
        raise exception 'marketplace decisions are platform-only' using errcode = '42501';
      end if;
    elsif new.commission_bp is distinct from old.commission_bp
       or (new.status is distinct from old.status and new.status not in ('draft', 'pending'))
       or new.approved_at is distinct from old.approved_at or new.reviewed_by is distinct from old.reviewed_by then
      raise exception 'marketplace decisions are platform-only' using errcode = '42501';
    end if;
  else
    if tg_op = 'INSERT' then
      if new.status not in ('draft', 'pending') then
        raise exception 'verification decisions are platform-only' using errcode = '42501';
      end if;
    elsif (new.status is distinct from old.status and new.status not in ('draft', 'pending'))
       or new.verified_at is distinct from old.verified_at or new.reviewed_by is distinct from old.reviewed_by then
      raise exception 'verification decisions are platform-only' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger guard_decisions before insert or update on marketplace_listings for each row execute function app.guard_marketplace_decisions();
create trigger guard_decisions before insert or update on tenant_verifications for each row execute function app.guard_marketplace_decisions();

-- ── Customer favourites (central, per person) ───────────────────────────────
-- Column is business_id (not tenant_id) on purpose: this is the customer's own
-- central data, read with the user id from the session, not tenant data.
create table customer_favorites (
  user_id uuid not null references users(id) on delete cascade,
  business_id uuid not null references tenants(id),
  created_at timestamptz not null default now(),
  primary key (user_id, business_id)
);

-- ── Marketplace attribution ─────────────────────────────────────────────────
-- A storefront visit that arrived from /discover, keyed by the pseudonymous
-- analytics session (sessionStorage, see ui/analytics/track.ts).
create table marketplace_visits (
  tenant_id uuid not null references tenants(id),
  session_id text not null check (session_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  created_at timestamptz not null default now(),
  primary key (tenant_id, session_id)
);

alter table bookings add column channel text not null default 'direct' check (channel in ('direct', 'marketplace'));
alter table bookings add column marketplace_fee_bp int check (marketplace_fee_bp is null or marketplace_fee_bp between 0 and 10000);
alter table bookings add constraint bookings_marketplace_fee_check check ((channel = 'marketplace') = (marketplace_fee_bp is not null));
create index bookings_marketplace_idx on bookings (tenant_id, created_at) where channel = 'marketplace';

-- Platform fee as data on each payment so a split-capable provider can route
-- fee_minor to LUMA and provider_net_minor to the business. With the sandbox no
-- money moves; the commission ledger marks lines as simulated.
alter table payments add column platform_fee_minor bigint not null default 0 check (platform_fee_minor >= 0);
alter table payments add column provider_net_minor bigint generated always as (amount_minor - platform_fee_minor) stored;
alter table payments add constraint payments_platform_fee_le_amount check (platform_fee_minor <= amount_minor);

create or replace function app.payment_platform_fee() returns trigger
language plpgsql as $$
declare
  v_bp int;
begin
  if new.booking_id is null or new.method in ('cash', 'pos_terminal', 'gift_card') then
    return new;
  end if;
  select b.marketplace_fee_bp into v_bp from bookings b
   where b.id = new.booking_id and b.tenant_id = new.tenant_id and b.channel = 'marketplace';
  if v_bp is not null then
    new.platform_fee_minor := least(new.amount_minor, (new.amount_minor * v_bp + 5000) / 10000);
  end if;
  return new;
end $$;
create trigger payment_platform_fee before insert on payments for each row execute function app.payment_platform_fee();

-- ── Commission ledger (platform side; the business reads its own rows) ──────
create table marketplace_commissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  booking_id uuid not null,
  booking_number text not null,
  base_minor bigint not null check (base_minor >= 0),
  rate_bp int not null check (rate_bp between 0 and 10000),
  fee_minor bigint not null check (fee_minor >= 0 and fee_minor <= base_minor),
  currency char(3) not null,
  -- simulated: no split-capable provider moved money (sandbox / on-site payment).
  settlement text not null default 'simulated' check (settlement in ('simulated', 'pending')),
  created_at timestamptz not null default now(),
  unique (tenant_id, booking_id),
  foreign key (tenant_id, booking_id) references bookings(tenant_id, id)
);
create index marketplace_commissions_period_idx on marketplace_commissions (tenant_id, created_at);
create index marketplace_commissions_created_idx on marketplace_commissions (created_at);

-- ── Public directory (narrow, allowlisted) ──────────────────────────────────
create or replace function app.safe_uuid(p text) returns uuid
language sql immutable as $$
  select case when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end
$$;

create or replace function app.marketplace_directory()
returns table (
  id uuid, slug text, name text, business_type text, city text, currency char(3),
  tagline_ar text, tagline_en text, logo_asset_id uuid, cover_asset_id uuid, verified boolean,
  rating_avg numeric, rating_count int, min_price_minor bigint, specialties jsonb, search_text text,
  latitude numeric, longitude numeric, completed_90d int, listed_at timestamptz
)
language sql stable security definer set search_path = public as $$
  -- Defaults apply when the settings row is missing (e.g. a truncated test database).
  with s as (select coalesce((select require_verification from marketplace_settings limit 1), true) as require_verification),
  listed as (
    select t.id, t.slug, t.name, t.business_type, t.city, t.currency, t.published_version_id, l.tagline_ar, l.tagline_en,
           l.cover_asset_id, l.approved_at, coalesce(v.status = 'verified', false) as verified
    from tenants t
    join marketplace_listings l on l.tenant_id = t.id
    left join tenant_verifications v on v.tenant_id = t.id
    cross join s
    where l.status = 'approved' and not l.hidden and t.status = 'active' and t.published_version_id is not null
      and (not s.require_verification or v.status = 'verified')
  )
  select x.id, x.slug::text, x.name, x.business_type,
    coalesce(pb.city, x.city),
    x.currency, x.tagline_ar, x.tagline_en,
    (select a.id from assets a where a.tenant_id = x.id and a.status = 'ready' and a.visibility = 'public'
       and a.id = app.safe_uuid(sv.snapshot #>> '{brand,logo_asset_id}')),
    (select a.id from assets a where a.tenant_id = x.id and a.status = 'ready' and a.visibility = 'public'
       and a.id = coalesce(x.cover_asset_id, app.safe_uuid(jsonb_path_query_first(sv.snapshot,
         '$.pages[*].blocks[*] ? (@.type == "hero" && @.props.image_asset_id != null).props.image_asset_id') #>> '{}'))),
    x.verified,
    r.avg_rating, coalesce(r.n, 0),
    pr.min_price,
    coalesce(cat.items, '[]'::jsonb),
    lower(concat_ws(' ', x.name, coalesce(pb.city, x.city), x.tagline_ar, x.tagline_en, cat.names, svc.names)),
    pb.latitude, pb.longitude,
    coalesce(bk.n, 0),
    x.approved_at
  from listed x
  left join site_versions sv on sv.tenant_id = x.id and sv.id = x.published_version_id
  left join lateral (
    select b.city, b.latitude, b.longitude from branches b
    where b.tenant_id = x.id and b.status = 'active' order by b.is_primary desc, b.created_at limit 1
  ) pb on true
  left join lateral (
    select round(avg(rv.rating)::numeric, 2) as avg_rating, count(*)::int as n from reviews rv
    where rv.tenant_id = x.id and rv.status = 'published'
  ) r on true
  left join lateral (
    select min(sx.price_minor) as min_price from services sx
    where sx.tenant_id = x.id and sx.is_active and sx.is_visible and sx.archived_at is null
  ) pr on true
  left join lateral (
    select jsonb_agg(jsonb_build_object('slug', c.slug, 'name_ar', c.name_ar, 'name_en', c.name_en) order by c.sort, c.slug) as items,
           string_agg(concat_ws(' ', c.name_ar, c.name_en), ' ') as names
    from categories c
    where c.tenant_id = x.id and c.kind = 'service' and c.is_visible and c.archived_at is null
      and exists (select 1 from services sx where sx.tenant_id = x.id and sx.category_id = c.id and sx.is_active and sx.is_visible and sx.archived_at is null)
  ) cat on true
  left join lateral (
    select string_agg(concat_ws(' ', sx.name_ar, sx.name_en), ' ') as names from services sx
    where sx.tenant_id = x.id and sx.is_active and sx.is_visible and sx.archived_at is null
  ) svc on true
  left join lateral (
    select count(*)::int as n from bookings bx
    where bx.tenant_id = x.id and bx.status = 'completed' and bx.starts_at > now() - interval '90 days'
  ) bk on true
$$;

select app.apply_conventions('{{APP_ROLE}}');
select app.make_append_only('marketplace_commissions', '{{APP_ROLE}}');
grant execute on function app.marketplace_directory() to {{APP_ROLE}};
