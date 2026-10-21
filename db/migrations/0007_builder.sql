-- ════════════════════════════════════════════════════════════════════════════
-- 0007 Storefront builder: brand settings, pages, drafts, immutable published
--      versions, preview tokens, platform templates, domain mappings.
--
-- Single source of truth (no duplicated colours):
--   brand_settings  → theme tokens (colours, fonts, radius, button/card style,
--                     density, logo). Draft state; versioned for concurrency.
--   site_drafts     → layout settings (navigation style, header/footer options).
--   page_drafts     → block trees per page; blocks reference catalog IDs, never
--                     copy prices.
--   site_versions   → immutable snapshot {brand, layout, pages} written on
--                     publish; tenants.published_version_id points at the live one.
-- ════════════════════════════════════════════════════════════════════════════

create table brand_settings (
  tenant_id uuid primary key references tenants(id),
  logo_asset_id uuid,
  wordmark_text text,
  tagline_ar text,
  tagline_en text,
  -- {primary, onPrimary, secondary, accent, background, surface, text, muted, border}
  colors jsonb not null,
  -- {heading, body} keys from the supported font allowlist
  fonts jsonb not null,
  radius text not null default 'md' check (radius in ('none', 'sm', 'md', 'lg', 'pill')),
  button_style text not null default 'solid' check (button_style in ('solid', 'outline', 'soft')),
  card_style text not null default 'elevated' check (card_style in ('flat', 'bordered', 'elevated')),
  density text not null default 'comfortable' check (density in ('compact', 'comfortable', 'spacious')),
  spacing_scale numeric(3, 2) not null default 1.00 check (spacing_scale between 0.75 and 1.50),
  excluded_colors text[] not null default '{}',
  -- Onboarding answers kept for regeneration/explanations.
  brand_character jsonb not null default '{}'::jsonb,
  -- Palette suggestions awaiting owner acceptance (never auto-applied).
  pending_palette jsonb,
  schema_version int not null default 1,
  version int not null default 1,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, logo_asset_id) references assets(tenant_id, id)
);

create table store_pages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('home', 'about', 'services', 'products', 'team', 'contact', 'faq', 'privacy', 'returns', 'booking_policy', 'custom')),
  slug text not null check (slug ~ '^[a-z0-9-]{1,60}$'),
  title_ar text,
  title_en text,
  show_in_nav boolean not null default false,
  show_in_footer boolean not null default false,
  sort int not null default 0,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, slug)
);
create unique index store_pages_one_kind on store_pages (tenant_id, kind) where kind <> 'custom' and status = 'active';

create table site_drafts (
  tenant_id uuid primary key references tenants(id),
  layout jsonb not null,
  schema_version int not null default 1,
  version int not null default 1,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table page_drafts (
  tenant_id uuid not null,
  page_id uuid not null,
  blocks jsonb not null default '[]'::jsonb,
  schema_version int not null default 1,
  version int not null default 1,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, page_id),
  foreign key (tenant_id, page_id) references store_pages(tenant_id, id)
);

create table site_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  version_number int not null,
  snapshot jsonb not null,
  schema_version int not null,
  note text,
  restored_from_version_id uuid references site_versions(id),
  published_by uuid not null references users(id),
  published_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, version_number)
);

alter table tenants add constraint tenants_published_version_fk foreign key (id, published_version_id) references site_versions(tenant_id, id);

create table preview_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  token_hash bytea not null unique,
  created_by uuid not null references users(id),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at <= created_at + interval '7 days')
);

-- Preview token → tenant (before tenant scope exists).
create or replace function app.preview_token_tenant(p_hash bytea)
returns uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from preview_tokens where token_hash = p_hash and revoked_at is null and expires_at > now()
$$;

-- Platform-approved templates (LUMA-managed starting layouts and components).
create table templates (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9_-]{2,40}$'),
  name_ar text not null,
  name_en text not null,
  description_ar text,
  description_en text,
  business_types text[] not null default array['salon', 'expert', 'beauty_center', 'spa'],
  document jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Builder component availability managed by the platform.
create table builder_components (
  type text primary key,
  is_enabled boolean not null default true,
  min_plan_feature text,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table domain_mappings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  domain citext not null unique,
  status text not null default 'pending' check (status in ('pending', 'verified', 'disabled')),
  verification_token text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

-- Onboarding progress (save/resume each of the seven steps).
create table onboarding_progress (
  tenant_id uuid primary key references tenants(id),
  answers jsonb not null default '{}'::jsonb,
  completed_steps int[] not null default '{}',
  current_step int not null default 1 check (current_step between 1 and 8),
  draft_generated_at timestamptz,
  version int not null default 1,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

-- AI customization proposals (structured patches awaiting accept/reject).
create table customization_proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  request_text text not null check (length(request_text) <= 1000),
  patch jsonb,
  explanation text,
  rejected_operations jsonb not null default '[]'::jsonb,
  status text not null check (status in ('proposed', 'accepted', 'rejected', 'failed', 'invalid')),
  base_brand_version int,
  base_draft_versions jsonb,
  ai_run_id uuid,
  error text,
  created_by uuid references users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

select app.apply_conventions('{{APP_ROLE}}');
select app.make_append_only('site_versions', '{{APP_ROLE}}');
grant execute on function app.preview_token_tenant(bytea) to {{APP_ROLE}};
